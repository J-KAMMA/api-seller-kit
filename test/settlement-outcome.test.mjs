// What a buyer is told about a payment, and how an unclear one is cleared up.
import assert from "node:assert/strict";
import { test } from "node:test";
import { toEventSelector, toFunctionSelector } from "viem";
import { createX402Gate } from "../src/index.mjs";
import { settledDepth } from "../src/networks.mjs";
import { ATTEMPT_MS } from "../src/payments.mjs";
import { classify } from "../src/settlement-table.mjs";
import { createSettlementProof } from "../src/settlement-proof.mjs";
import { createMemoryStore } from "../src/store.mjs";
import { A, BUYER, CHANNEL_ID, channelGate, useVoucher, voucher } from "./fixtures/gates.mjs";

const USDC = "0x5425890298aed601595a70AB815c96711a31Bc65".toLowerCase();
const OWNER = { "hub-idempotency-key": "k".repeat(32) };
const FROM = A("4");
const NONCE = `0x${"1".repeat(64)}`;
const word = (a) => `0x${a.slice(2).padStart(64, "0")}`;
const USED = toEventSelector("AuthorizationUsed(address,bytes32)");
const TRANSFER = toEventSelector("Transfer(address,address,uint256)");
const T0 = Math.floor(Date.now() / 1000);

/** A chain with the token's logs, and a facilitator that behaves like the Hub facilitator (or, with `stored`, as proposed for it). */
function world({ mode = "lost", stored = false, logs, status = "0x1", reads = true, proof = true, monthly, invalid = false } = {}) {
  const w = { used: false, stored: null, calls: 0, settles: 0, time: T0, head: 100n, reads };
  const make = logs ?? (({ from, payTo, amount }) => [
    { address: USDC, topics: [USED, word(from), NONCE], data: "0x" },
    { address: USDC, topics: [TRANSFER, word(from), word(payTo)], data: word(`0x${BigInt(amount).toString(16)}`) },
  ]);
  const receipt = () => ({ status, transactionHash: "0xtx", logs: make({ from: FROM, payTo: A("2"), amount: monthly ? "50000" : "10000" }).map((l, i) => ({ logIndex: `0x${(i + 3).toString(16)}`, ...l })) });
  const settle = () => {
    w.settles++;
    if (w.answer) return w.answer();
    if (stored && w.stored) return Response.json({ ...w.stored, extensions: { "hub-settlement": { replayed: true } } });
    if (w.used) return Response.json({ success: false, errorReason: "invalid_exact_evm_nonce_already_used", transaction: "", network: "eip155:43113" });
    if (mode === "never") return Response.json({ success: false, errorReason: "settlement_unavailable" }, { status: 503 });
    w.used = true;
    w.stored = { success: true, transaction: "0xtx", network: "eip155:43113" };
    if (mode === "lost") throw new Error("connection reset after the money moved");
    return Response.json(w.stored);
  };
  const rpc = ({ method, params }) => {
    if (!w.reads) throw new Error("rpc down");
    switch (method) {
      case "eth_chainId": return "0xa869";
      case "eth_blockNumber": return `0x${w.head.toString(16)}`;
      case "eth_getBlockByNumber": return { number: params[0], timestamp: `0x${w.time.toString(16)}` };
      case "eth_call":
        assert.equal(params[0].data, toFunctionSelector("authorizationState(address,bytes32)") + word(FROM).slice(2) + NONCE.slice(2));
        return word(w.used ? "0x1" : "0x0");
      case "eth_getLogs": return w.used ? [{ transactionHash: "0xtx" }] : [];
      case "eth_getTransactionReceipt": return receipt();
      default: throw new Error(method);
    }
  };
  const inner = createMemoryStore();
  const seen = {};
  w.keys = () => seen;
  w.store = {
    ...inner,
    compareAndSet: async (key, expected, next) => {
      if (w.refuseWrites?.(next?.state)) throw new Error("store down");
      seen[key] = true;
      return inner.compareAndSet(key, expected, next);
    },
  };
  w.gate = createX402Gate({
    network: "eip155:43113", asset: USDC, payTo: A("2"), seller: A("3"), priceAtomic: "10000", facilitatorUrl: "https://f.example", resource: "https://api.example/echo", store: w.store,
    ...(proof ? { settlementRpcUrl: "https://rpc.example" } : {}),
    ...(monthly ? { monthly: { priceAtomic: "50000", quota: 3, subscriptionSecret: "s".repeat(32) } } : {}),
    fetch: async (url, init) => {
      if (url.startsWith("https://rpc.example")) return Response.json({ jsonrpc: "2.0", id: 1, result: rpc(JSON.parse(init.body)) });
      if (url.endsWith("/verify")) return Response.json(w.used || invalid ? { isValid: false, invalidReason: "nonce_used" } : { isValid: true });
      return settle();
    },
  });
  w.api = async () => Response.json({ echo: ++w.calls });
  w.go = (headers = OWNER, next = w.api) =>
    w.gate(new Request("https://api.example/echo", { headers: { "payment-signature": Buffer.from(JSON.stringify({ ...(monthly ? { accepted: { extra: { plan: "monthly" } } } : {}), payload: { authorization: { from: FROM, nonce: NONCE, validBefore: String(T0 + 300) } } })).toString("base64"), ...headers } }), next);
  return w;
}
const told = async (res) => {
  const body = await res.clone().json().catch(() => ({}));
  if (body.payment) assert.equal(body.payment, res.headers.get("hub-payment-status"));
  if (body.payment) assert.equal(body.safeToPayAgain, body.payment === "not_taken");
  return [res.status, res.headers.get("hub-payment-status")];
};

test("this facilitator answers a settled payment with a failure: with an RPC the call is served once, without it stays unclear", async () => {
  for (const monthly of [false, true]) {
    let w = world({ monthly });
    const first = await w.go();
    assert.deepEqual(await told(first), [200, "settled"]);
    assert.equal(Boolean(first.headers.get("hub-subscription")), monthly);
    const again = await w.go();
    assert.deepEqual([...(await told(again)), (await again.json()).error, again.headers.get("hub-subscription")], [409, "settled", "already_served", first.headers.get("hub-subscription")]);
    assert.deepEqual([w.calls, w.settles], [1, 1]);

    if (monthly) continue; // monthly always has an RPC
    w = world({ proof: false });
    for (let i = 0; i < 3; i++) assert.deepEqual(await told(await w.go()), [409, "unclear"]);
    assert.equal(w.calls, 1);
    assert.deepEqual(await told(await w.go({})), [409, "unclear"]);
    assert.deepEqual(await told(await w.go({ "hub-idempotency-key": "x".repeat(32) })), [409, "unclear"]);
  }
});

test("a replayed success is never taken for one: without an RPC it stays unclear, with one the chain decides", async () => {
  let w = world({ proof: false, stored: true });
  for (let i = 0; i < 3; i++) assert.deepEqual(await told(await w.go()), [409, "unclear"]);
  assert.equal(w.calls, 1);
  w = world({ stored: true, reads: false });
  for (let i = 0; i < 2; i++) assert.deepEqual(await told(await w.go()), [409, "unclear"]);
  w.reads = true;
  assert.deepEqual(await told(await w.go()), [200, "settled"]);
});

test("the RPC was down at first: the same request later is served", async () => {
  const w = world({ reads: false });
  for (let i = 0; i < 2; i++) assert.deepEqual(await told(await w.go()), [409, "unclear"]);
  w.reads = true;
  assert.deepEqual(await (await w.go()).json(), { echo: 2 });
  assert.deepEqual(await told(await w.go()), [409, "settled"]);
  assert.equal(w.calls, 2);
});

test("two instances without a shared store: the one whose settlement is a duplicate serves nothing, now or later", async () => {
  for (const answer of [{ success: false, errorReason: "duplicate_settlement" }, { success: false, errorReason: "invalid_exact_evm_transaction_simulation_failed" }, { success: true, transaction: "0xtx", extensions: { "hub-settlement": { replayed: true } } }]) {
    const w = world({ mode: "ok" });
    w.answer = () => ((w.used = true), Response.json(answer)); // the other one settled between our verify and our settle
    assert.deepEqual(await told(await w.go()), [409, "unclear"]);
    const again = await w.go();
    assert.deepEqual(await told(again), [409, "settled"]);
    assert.equal((await again.json()).error, "payment_settled_elsewhere");
    assert.equal(w.calls, 1);
  }
});

test("a used nonce is no proof: paid to another, another amount, another token, reverted, or not next to its own transfer", async () => {
  const used = { address: USDC, topics: [USED, word(FROM), NONCE], data: "0x" };
  const transfer = (o = {}) => ({ address: USDC, topics: [TRANSFER, word(FROM), word(A("2"))], data: word("0x2710"), ...o });
  for (const [logs, status] of [
    [[used, transfer({ topics: [TRANSFER, word(FROM), word(FROM)] })]],
    [[used, transfer({ topics: [TRANSFER, word(A("9")), word(A("2"))] })]],
    [[used, transfer({ data: word("0x270f") })]],
    [[used, transfer({ address: A("9") })]],
    [[transfer(), used]],
    [[used]],
    [[used, transfer({ topics: [TRANSFER, word(FROM), word(FROM)] }), transfer()]], // the transfer belongs to another authorization
    [[{ ...used, topics: [USED, word(FROM), `0x${"2".repeat(64)}`] }, transfer()]],
    [[used, transfer({ logIndex: "0x9" })]],
    [[used, transfer()], "0x0"],
  ]) {
    const w = world({ logs: () => logs, status });
    assert.deepEqual(await told(await w.go()), [409, "unclear"]);
    assert.deepEqual(await told(await w.go()), [409, "unclear"]);
  }
  assert.deepEqual(await told(await world({ logs: () => [used, transfer()] }).go()), [200, "settled"]); // the control
});

test("an authorization that ran out unused was not taken; before that it stays unclear", async () => {
  const w = world({ mode: "never" });
  assert.deepEqual(await told(await w.go()), [409, "unclear"]);
  assert.deepEqual(await told(await w.go()), [409, "unclear"]);
  w.time = T0 + 300;
  const res = await w.go();
  assert.deepEqual(await told(res), [402, "not_taken"]);
  assert.equal((await res.json()).accepts.length, 1); // a quote to pay anew
  assert.deepEqual(await told(await w.go({})), [402, "not_taken"]);
  assert.equal(w.calls, 1);
});

test("not taken: nothing was asked to settle", async () => {
  const w = world({ mode: "ok" });
  assert.deepEqual(await told(await w.go(OWNER, async () => Promise.reject(new Error("x")))), [502, "not_taken"]);
  assert.deepEqual(await told(await w.go(OWNER, async () => new Response("own error", { status: 418 }))), [418, "not_taken"]);
  assert.deepEqual(await told(await w.go(OWNER, async () => new Response(new Uint8Array(9 * 1024 * 1024)))), [502, "not_taken"]);
  assert.equal(w.settles, 0);
  assert.deepEqual(await told(await w.go()), [200, "settled"]);
  const refused = world({ mode: "ok" });
  refused.used = true;
  assert.deepEqual(await told(await refused.go()), [409, "unclear"]); // the chain says it was used before
  const blind = world({ mode: "ok", proof: false });
  blind.used = true;
  assert.deepEqual(await told(await blind.go()), [402, "refused"]);
});

test("a reply that is owed: retries in parallel get one reply and one token, the same for ever; a failed call leaves it owed", async () => {
  for (const monthly of [false, true]) {
    const w = world({ monthly, reads: false });
    assert.deepEqual(await told(await w.go()), [409, "unclear"]);
    w.reads = true;
    assert.deepEqual(await told(await w.go(OWNER, async () => new Response("x", { status: 500 }))), [502, "settled"]);
    const slow = async () => (await new Promise((r) => setTimeout(r, 20)), w.api());
    const rs = await Promise.all(Array.from({ length: 8 }, () => w.go(OWNER, slow)));
    assert.equal(rs.filter((r) => r.status === 200).length, 1);
    assert.deepEqual([...new Set(rs.map((r) => r.status))].sort(), [200, 409]);
    const later = await w.go();
    assert.deepEqual(await told(later), [409, "settled"]);
    const tokens = new Set([...rs, later].map((r) => r.headers.get("hub-subscription")).filter(Boolean));
    assert.equal(tokens.size, monthly ? 1 : 0);
    if (monthly) {
      const [token] = tokens;
      const uses = [];
      for (let i = 0; i < 4; i++) uses.push((await w.gate(new Request("https://api.example/echo", { headers: { "hub-subscription": token } }), w.api)).status);
      assert.deepEqual(uses, [200, 200, 402, 402]); // quota 3, the purchase was the first
    }
    for (const h of [{}, { "hub-idempotency-key": "x".repeat(32) }]) assert.equal((await w.go(h)).headers.get("hub-subscription"), null);
  }
});

test("parallel retries of an unclear payment make one attempt at a time", async () => {
  const w = world({ mode: "never", monthly: true });
  assert.deepEqual(await told(await w.go()), [409, "unclear"]);
  w.answer = () => ((w.used = true), Response.json({ success: true, transaction: "0xtx" }));
  const rs = await Promise.all(Array.from({ length: 8 }, () => w.go()));
  assert.equal(rs.filter((r) => r.status === 200).length, 1);
  assert.equal(new Set(rs.map((r) => r.headers.get("hub-subscription")).filter(Boolean)).size, 1);
  assert.equal(w.settles, 2);
});

/** Moves the clock. */
async function later(ms, fn) {
  const real = Date.now;
  Date.now = () => real() + ms;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

test("a process that died: before settling the payment can be used again, after it stays unclear until it is proven", async () => {
  const ends = [];
  const hang = () => new Promise((_, no) => ends.push(() => no(new Error("died"))));
  let w = world({ mode: "ok" });
  const dead = w.go(OWNER, hang); // never answers; its own time limit is not over yet
  while (Object.keys(w.keys()).length === 0) await new Promise((r) => setTimeout(r, 2));
  assert.deepEqual(await told(await w.go()), [409, "unclear"]);
  assert.deepEqual(await later(400_000, async () => told(await w.go({}))), [200, "settled"]); // nothing was settled: anybody with the payment
  assert.equal(w.settles, 1);

  w = world({ mode: "ok" });
  w.answer = hang; // dies while /settle runs; the money moved
  const second = w.go();
  while (w.settles === 0) await new Promise((r) => setTimeout(r, 2));
  w.used = true;
  w.answer = null;
  assert.deepEqual(await told(await w.go()), [409, "unclear"]);
  assert.deepEqual(await later(400_000, async () => told(await w.go({}))), [409, "unclear"]);
  assert.deepEqual(await later(400_000, async () => told(await w.go())), [200, "settled"]);
  assert.equal(w.settles, 1);
  for (const end of ends) end(); // they come back to life too late: nothing is handed out
  for (const late of [dead, second]) assert.notEqual((await late).status, 200);
  assert.deepEqual(await told(await w.go()), [409, "settled"]);
});

test("the record cannot be written after the settlement: nothing is handed out that a retry would hand out again", async () => {
  const w = world({ mode: "ok" });
  w.refuseWrites = (state) => state === "settled";
  assert.deepEqual(await told(await w.go()), [409, "unclear"]);
  w.refuseWrites = null;
  assert.deepEqual(await later(400_000, async () => told(await w.go())), [200, "settled"]);
  assert.deepEqual(await told(await w.go()), [409, "settled"]);
});

test("requests without a valid signature write nothing", async () => {
  let writes = 0;
  const inner = createMemoryStore();
  const store = { ...inner, set: async () => void writes++, compareAndSet: async (...a) => (writes++, inner.compareAndSet(...a)) };
  const gate = channelGate(store, { monthly: { priceAtomic: "5", quota: 3, subscriptionSecret: "s".repeat(32) }, fetch: async () => Response.json({ isValid: false }) });
  const forged = JSON.parse(Buffer.from(await voucher(10000), "base64"));
  forged.cumulativeAmount = "20000";
  for (let i = 0; i < 20; i++) {
    const key = { "hub-idempotency-key": String(i).padStart(40, "0") };
    for (const h of [{ "hub-channel-voucher": "junk" }, { "hub-channel-voucher": Buffer.from(JSON.stringify(forged)).toString("base64") }, { "hub-subscription": "a.b" }, { "payment-signature": Buffer.from(JSON.stringify({ payload: { authorization: { from: FROM, nonce: NONCE } } })).toString("base64") }]) {
      assert.equal((await gate(new Request("https://api.example/echo", { headers: { ...h, ...key } }), async () => assert.fail("must not be called"))).status, 402);
    }
  }
  assert.equal(writes, 0);
});

test("on Workers a store that all isolates share is required", async () => {
  const real = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Cloudflare-Workers" }, configurable: true });
  const make = (extra) => createX402Gate({ network: "eip155:43113", asset: USDC, payTo: A("2"), seller: A("3"), priceAtomic: "1", facilitatorUrl: "https://f.example", ...extra });
  try {
    const { get, set, compareAndSet } = createMemoryStore();
    for (const extra of [{}, { store: createMemoryStore() }, { singleInstance: true }, { store: { get, set } }]) assert.throws(() => make(extra), /Workers/);
    assert.doesNotThrow(() => make({ store: { get, set, compareAndSet } }));
  } finally {
    if (real) Object.defineProperty(globalThis, "navigator", real);
    else delete globalThis.navigator;
  }
});

test("conditional request headers do not reach the API; a redirect or an error costs nothing", async () => {
  let seen;
  const gate = channelGate(createMemoryStore());
  const v = await voucher(10000);
  for (const status of [302, 307, 404]) assert.equal((await useVoucher(gate, v, status)).status, status);
  const res = await gate(new Request("https://api.example/echo", { headers: { "hub-channel-voucher": v, "if-none-match": "x", "if-modified-since": "y", "x-keep": "1" } }), async (r) => ((seen = [...r.headers.keys()]), Response.json({})));
  assert.deepEqual([res.status, seen], [200, ["x-keep"]]);
});

test("the smallest deposit in the quote is the one enforced", async () => {
  for (const prepaid of [{}, { minDepositAtomic: "12345" }, { minDepositAtomic: 70000n }, { pricePerCallAtomic: "777" }]) {
    const quoted = BigInt((await (await channelGate(createMemoryStore(), { prepaid })(new Request("https://api.example/echo"), null)).json()).accepts[1].extra.minDepositAtomic);
    for (const [deposit, error] of [[quoted, undefined], [quoted - 1n, "deposit_too_small"]]) {
      const gate = channelGate(createMemoryStore(), { prepaid: { ...prepaid, readChannel: async () => ({ buyer: BUYER, seller: A("3"), token: USDC, deposit, closeRequestedAt: 0n, status: 1 }) } });
      const res = await useVoucher(gate, await voucher(deposit < 10000n ? 777 : 10000, CHANNEL_ID));
      assert.equal(res.status === 200 ? undefined : (await res.json()).error, error);
    }
  }
});

/** A chain with one block a second, the payment in one of them, and an RPC that limits log searches like the public Fuji one. */
function chain({ limit = 100n, now = 100_000n, start = 1_000_000n, paidAt, depth = 0n, validBefore, refuseAll = false, slow = 0 } = {}) {
  const c = { now, calls: [], widest: 0n, searched: [] };
  const used = (block) => paidAt !== undefined && paidAt <= block;
  const answer = ({ method, params }) => {
    c.calls.push(method);
    const block = (p) => BigInt(p);
    switch (method) {
      case "eth_chainId": return "0xa869";
      case "eth_blockNumber": return `0x${c.now.toString(16)}`;
      case "eth_getBlockByNumber": return block(params[0]) > c.now ? null : { timestamp: `0x${(start + block(params[0])).toString(16)}` };
      case "eth_call": return word(used(block(params[1])) ? "0x1" : "0x0");
      case "eth_getLogs": {
        const [from, to] = [block(params[0].fromBlock), block(params[0].toBlock)];
        if (refuseAll || to - from + 1n > limit) return { refused: true };
        if (to - from + 1n > c.widest) c.widest = to - from + 1n;
        c.searched.push([from, to]);
        return paidAt !== undefined && from <= paidAt && paidAt <= to ? [{ transactionHash: "0xtx" }] : [];
      }
      case "eth_getTransactionReceipt":
        return { status: "0x1", transactionHash: "0xtx", logs: [
          { address: USDC, logIndex: "0x1", topics: [USED, word(FROM), NONCE], data: "0x" },
          { address: USDC, logIndex: "0x2", topics: [TRANSFER, word(FROM), word(A("2"))], data: word("0x2710") },
        ] };
    }
  };
  c.proof = createSettlementProof({
    rpcUrl: "https://rpc.example", chainId: 43113, asset: USDC, payTo: A("2"), depth, ...(slow ? { budgetMs: slow } : {}),
    doFetch: async (url, init) => {
      if (slow) await new Promise((r) => setTimeout(r, 5));
      const result = answer(JSON.parse(init.body));
      return result?.refused ? Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "maximum of 100 blocks" } }, { status: 400 }) : Response.json({ jsonrpc: "2.0", id: 1, result });
    },
  });
  c.look = (o = {}) => c.proof.look({ from: FROM, nonce: NONCE, amount: "10000", validBefore: String(validBefore ?? start + now + 600n), ...o });
  return c;
}

test("an RPC that searches at most 100 blocks: every block from the start is covered, without a gap", async () => {
  for (const limit of [100n, 63n, 1n, 2_000n, 10n ** 9n]) {
    const now = 100_000n;
    const start = now - (limit === 1n ? 150n : 1_500n);
    for (const paidAt of [start, start + 99n, start + 100n, now - 1n, now]) {
      const c = chain({ limit, paidAt });
      assert.deepEqual(await c.look({ startBlock: String(start) }), { state: "paid", transaction: "0xtx" }, `limit ${limit} block ${paidAt}`);
      let expect = start;
      for (const [from, to] of c.searched) {
        assert.equal(from, expect);
        expect = to + 1n;
      }
      assert.ok(c.widest <= limit && c.widest <= 2_000n);
    }
  }
});

test("a search that refuses everything, or a start that is unknown", async () => {
  assert.equal((await chain({ refuseAll: true, paidAt: 99_990n }).look({ startBlock: "99900" })).state, "unclear");
  // no block was recorded: from the time of the claim
  const c = chain({ paidAt: 99_500n });
  assert.equal((await c.look({ startBlock: null, claimedAt: 1_000_000 + 99_400 })).state, "paid");
  assert.ok(c.searched[0][0] <= 99_400n && c.searched[0][0] >= 99_300n);
  assert.ok(c.calls.filter((m) => m === "eth_getBlockByNumber").length < 40);
});

test("the search ends with the authorization's validity, however far the chain went on", async () => {
  const c = chain({ now: 5_000_000n, paidAt: 900n, validBefore: 1_000_000n + 1_300n }); // used before the search starts: to be found nowhere
  const out = await c.look({ startBlock: "1000" });
  assert.equal(out.state, "unclear");
  assert.ok(c.searched.at(-1)[1] >= 1_300n && c.searched.at(-1)[1] < 1_600n);
});

test("a long search goes on where it stopped", async () => {
  const c = chain({ slow: 60, paidAt: 99_900n });
  let at = "97000";
  let looks = 0;
  for (;;) {
    const out = await c.look({ startBlock: at });
    looks++;
    if (out.state === "paid") break;
    assert.ok(BigInt(out.scannedTo) > BigInt(at), "progress");
    at = out.scannedTo;
    assert.ok(looks < 60);
  }
  assert.ok(looks > 1);
});

test("the proof is read below the depth: neither a payment nor an expiry counts before", async () => {
  const c = chain({ depth: 30n, paidAt: 99_980n });
  assert.equal(await c.proof.startBlock(), "99970");
  assert.equal((await c.look({ startBlock: "99900" })).state, "unused");
  c.now += 10n;
  assert.equal((await c.look({ startBlock: "99900" })).state, "paid");
  const v = chain({ depth: 30n, validBefore: 1_000_000n + 99_990n });
  assert.equal((await v.look({ startBlock: "99900" })).state, "unused");
  v.now += 20n;
  assert.equal((await v.look({ startBlock: "99900" })).state, "void");
  assert.deepEqual([settledDepth("eip155:84532"), settledDepth("eip155:43113")], [30n, 0n]);
});

test("the gate keeps where the search stopped", async () => {
  const w = world({ logs: () => [], reads: true });
  assert.deepEqual(await told(await w.go()), [409, "unclear"]);
  const [key] = Object.keys(w.keys()).filter((k) => k.startsWith("payment:"));
  assert.equal((await w.store.get(key)).startBlock, "100");
  assert.ok((await w.store.get(key)).claimedAt > 0);
});

const A_ = (o, status = 200) => ({ ok: status >= 200 && status < 300, status, data: o });
test("the table: every first answer", () => {
  const classes = {
    ok: [A_({ success: true }), A_({ success: true, transaction: "0x1" })],
    contested: [
      A_({ success: true, extensions: { "hub-settlement": { replayed: true } } }), A_({ success: false, extensions: { "hub-settlement": { replayed: true } } }),
      A_({ success: false, errorReason: "duplicate_settlement", transaction: "", network: "eip155:43113" }), A_({ success: false, errorReason: "duplicate_settlement" }), A_({ success: false, errorReason: "duplicate_settlement" }, 409),
      A_({ success: false, errorReason: "invalid_exact_evm_nonce_already_used" }), A_({ success: false, errorReason: "nonce_already_used" }, 400),
    ],
    refused: [A_({ success: false, errorReason: "rate_limited" }, 429), A_({ success: false, errorReason: "settlement_unavailable", transaction: "" }, 424), A_({ success: false, errorReason: "facilitator_gas_low" }, 424), A_(null, 401), A_({}, 403), A_({}, 400), A_({ success: true }, 403), A_({ success: false, errorReason: "invalid_exact_evm_transaction_simulation_failed", transaction: "" }), A_({ success: false, errorReason: "invalid_exact_evm_insufficient_balance" })],
    ambiguous: [
      A_(null, 408), A_({}, 409), A_(null, 425), A_(null, 499), A_(null, 0), A_(null, 302), A_({}, 503), A_({ success: true }, 500), A_(null), A_([]), A_("x"), A_({}), A_({ success: "true" }), A_({ success: false }), A_({ success: false, errorReason: "settlement_pending" }), A_({ success: false, errorReason: "settlement_unavailable", transaction: "" }, 503),
      A_({ success: false, errorReason: "invalid_exact_evm_transaction_failed" }), A_({ success: false, errorReason: "something_new" }), A_({ success: false, errorReason: "invalid_x", transaction: "0x1" }), A_({ success: false, transaction: "0x1" }, 429),
    ],
  };
  for (const [name, answers] of Object.entries(classes)) for (const a of answers) assert.equal(classify(a), name, JSON.stringify(a));
});

test("the table: every class with every evidence, in the gate", async () => {
  const FIRST = {
    ambiguous: () => Response.json({ success: false, errorReason: "settlement_pending" }),
    refused: () => Response.json({ success: false, errorReason: "rate_limited" }, { status: 429 }),
    contested: () => Response.json({ success: false, errorReason: "duplicate_settlement" }),
  };
  const none = () => Response.json({}, { status: 503 });
  const ok = () => Response.json({ success: true, transaction: "0xtx" });
  const replay = () => Response.json({ success: true, transaction: "0xtx", extensions: { "hub-settlement": { replayed: true } } });
  const paidBy = (answer) => (w) => ((w.used = true), answer());
  // [evidence, what changes before the retry, the answer to the retry's /settle, outcome per class]
  const rows = [
    ["paid on chain", (w) => (w.used = true), none, { ambiguous: [200, "settled"], refused: [409, "settled"], contested: [409, "settled"] }],
    ["ran out unused", (w) => (w.time = T0 + 300), none, { ambiguous: [402, "not_taken"], refused: [402, "not_taken"], contested: [402, "not_taken"] }],
    ["unused, no answer", () => {}, none, { ambiguous: [409, "unclear"], refused: [409, "unclear"], contested: [409, "unclear"] }],
    ["unused, settled now", () => {}, paidBy(ok), { ambiguous: [200, "settled"], refused: [200, "settled"], contested: [409, "unclear"] }],
    ["unused, replayed", () => {}, paidBy(replay), { ambiguous: [200, "settled"], refused: [409, "settled"], contested: [409, "unclear"] }],
    ["unused, duplicate", () => {}, paidBy(FIRST.contested), { ambiguous: [200, "settled"], refused: [409, "settled"], contested: [409, "unclear"] }],
    ["unused, refused", () => {}, paidBy(FIRST.refused), { ambiguous: [200, "settled"], refused: [409, "settled"], contested: [409, "unclear"] }],
    ["unused, then paid without an answer", () => {}, paidBy(none), { ambiguous: [200, "settled"], refused: [200, "settled"], contested: [409, "unclear"] }],
    ["unreadable, no answer", (w) => (w.reads = false), none, { ambiguous: [409, "unclear"], refused: [409, "unclear"], contested: [409, "unclear"] }],
    ["unreadable, settled now", (w) => (w.reads = false), paidBy(ok), { ambiguous: [200, "settled"], refused: [200, "settled"], contested: [409, "unclear"] }],
    ["unreadable, replayed", (w) => (w.reads = false), paidBy(replay), { ambiguous: [409, "unclear"], refused: [409, "unclear"], contested: [409, "unclear"] }],
    ["unreadable before, paid without an answer after", (w) => (w.reads = false), (w) => ((w.used = true), (w.reads = true), none()), { ambiguous: [200, "settled"], refused: [409, "settled"], contested: [409, "unclear"] }],
  ];
  for (const [evidence, change, answer, outcome] of rows) {
    for (const [first, reply] of Object.entries(FIRST)) {
      const w = world();
      w.answer = reply;
      assert.deepEqual(await told(await w.go()), [409, "unclear"]);
      w.answer = () => answer(w);
      change(w);
      assert.deepEqual(await told(await w.go()), outcome[first], `${first}, ${evidence}`);
      // and it stays so: nobody is served twice
      w.answer = none;
      w.reads = true;
      const calls = w.calls;
      const after = await told(await w.go());
      if (outcome[first][0] === 200) assert.deepEqual([after, w.calls], [[409, "settled"], calls]);
      if (first === "contested") assert.equal(w.calls, 1);
    }
  }
});

test("two gates with separate stores for one payTo: served once wherever the answers tell", async () => {
  for (const second of [
    () => Response.json({ success: true, extensions: { "hub-settlement": { replayed: true } } }),
    () => Response.json({ success: false, errorReason: "duplicate_settlement" }),
    () => Response.json({ success: false, errorReason: "invalid_exact_evm_nonce_already_used" }),
    () => Response.json({ success: false, errorReason: "invalid_exact_evm_transaction_simulation_failed", transaction: "" }),
    () => Response.json({ success: false, errorReason: "rate_limited" }, { status: 429 }),
    () => Response.json({}, { status: 403 }),
  ]) {
    const a = world({ mode: "ok" });
    assert.deepEqual(await told(await a.go()), [200, "settled"]);
    const b = world();
    b.answer = () => ((b.used = true), second()); // verified before, settled by the other gate meanwhile
    assert.notEqual((await b.go()).status, 200);
    b.answer = () => Response.json({ success: true, transaction: "0xtx", extensions: { "hub-settlement": { replayed: true } } });
    for (let i = 0; i < 3; i++) assert.deepEqual(await told(await b.go()), [409, "settled"]);
    assert.equal(b.calls, 1);
  }
});

test("records live as long as somebody may need them, and a forgotten one is not called safe to pay", async () => {
  const days = async (w) => {
    const [key] = Object.keys(w.keys()).filter((k) => k.startsWith("payment:"));
    const rec = await w.store.get(key);
    return [rec.state, (rec.expiresAt - Date.now() / 1000) / 86400];
  };
  let w = world({ mode: "ok", monthly: true });
  await w.go();
  let [state, left] = await days(w);
  assert.ok(state === "settled" && left > 30);
  w = world({ mode: "never" });
  await w.go();
  [state, left] = await days(w);
  assert.ok(state === "unclear" && left > 30);
  w = world({ reads: false });
  await w.go();
  w.reads = true;
  await w.go(OWNER, async () => new Response("x", { status: 500 }));
  [state, left] = await days(w);
  assert.ok(state === "owed" && left > 30);
  w = world({ mode: "ok" });
  await w.go();
  assert.ok((await days(w))[1] < 1); // paid and answered: nothing is owed

  // no record any more
  const fresh = (o) => {
    const f = world(o);
    f.used = o.used ?? false;
    return f;
  };
  assert.deepEqual(await told(await fresh({ used: true }).go()), [409, "unclear"]);
  assert.deepEqual(await told(await fresh({ used: true, reads: false }).go()), [402, "refused"]);
  assert.deepEqual(await told(await fresh({ used: true, proof: false }).go()), [402, "refused"]);
  const ended = fresh({ invalid: true });
  ended.time = T0 + 300;
  assert.deepEqual(await told(await ended.go()), [402, "not_taken"]);
});

test("the second call is the first one: another address, method or body is refused", async () => {
  const w = world({ reads: false });
  const payload = Buffer.from(JSON.stringify({ payload: { authorization: { from: FROM, nonce: NONCE, validBefore: String(T0 + 300) } } })).toString("base64");
  const go = (url, body, method = "POST") => w.gate(new Request(url, { method, ...(method === "POST" ? { body } : {}), headers: { "payment-signature": payload, ...OWNER } }), async (r) => Response.json({ got: method === "POST" ? await r.text() : "" }));
  assert.equal((await go("https://api.example/echo?a=1", "one")).status, 409);
  w.reads = true;
  for (const [url, body, method] of [["https://api.example/echo?a=2", "one"], ["https://api.example/echo?a=1", "two"], ["https://api.example/echo?a=1", "", "GET"]]) {
    const res = await go(url, body, method);
    assert.deepEqual([res.status, (await res.json()).error], [409, "not_the_same_request"]);
  }
  assert.deepEqual(await told(await go("https://api.example/echo?a=1", "x".repeat(1024 * 1024 + 1))), [413, "refused"]);
  const res = await go("https://api.example/echo?a=1", "one");
  assert.deepEqual([res.status, await res.json()], [200, { got: "one" }]);
});

test("one attempt ends before its lease, whatever hangs", async () => {
  const real = Date.now;
  let skew = 0;
  Date.now = () => real() + skew;
  try {
    const asked = [];
    const p = createSettlementProof({
      rpcUrl: "https://rpc.example", chainId: 43113, asset: USDC, payTo: A("2"),
      doFetch: async (u, init) => {
        const { method } = JSON.parse(init.body);
        asked.push(method);
        skew += 9_000; // every answer takes nine seconds
        return Response.json({ result: { eth_chainId: "0xa869", eth_blockNumber: "0xffffff", eth_call: word("0x1"), eth_getBlockByNumber: { timestamp: "0x1" }, eth_getLogs: [] }[method] });
      },
    });
    const from = Date.now();
    assert.equal((await p.look({ from: FROM, nonce: NONCE, amount: "1", validBefore: null, startBlock: null, claimedAt: 5, until: from + ATTEMPT_MS })).state, "unclear");
    assert.ok(Date.now() - from < ATTEMPT_MS);
    assert.ok(asked.length < 12);
    assert.equal((await p.look({ from: FROM, nonce: NONCE, amount: "1", validBefore: null, startBlock: "1", claimedAt: 5, until: Date.now() })).state, "unclear");
  } finally {
    Date.now = real;
  }
});

test("the facilitator refuses before it reserved anything (424), or knows of an attempt with an unknown outcome (duplicate)", async () => {
  let w = world();
  w.answer = () => Response.json({ success: false, errorReason: "facilitator_gas_low", transaction: "", network: "eip155:43113" }, { status: 424 });
  assert.deepEqual(await told(await w.go()), [409, "unclear"]);
  w.answer = () => ((w.used = true), Response.json({ success: true, transaction: "0xtx" })); // later it works: settled by this very request
  assert.deepEqual(await told(await w.go()), [200, "settled"]);
  // our own first attempt timed out, the facilitator does not know its outcome: the chain does
  w = world({ mode: "lost", reads: false });
  assert.deepEqual(await told(await w.go()), [409, "unclear"]);
  w.answer = () => Response.json({ success: false, errorReason: "duplicate_settlement", transaction: "", network: "eip155:43113" });
  assert.deepEqual(await told(await w.go()), [409, "unclear"]);
  w.reads = true;
  assert.deepEqual(await told(await w.go()), [200, "settled"]);
});

/** Monthly with the kit's defaults: no RPC named. */
function plainMonthly({ network = "eip155:43113", settle, rpcUrls }) {
  const asked = [];
  const gate = createX402Gate({
    network, asset: USDC, payTo: A("2"), seller: A("3"), priceAtomic: "10000", facilitatorUrl: "https://f.example", resource: "https://api.example/echo", store: createMemoryStore(),
    monthly: { priceAtomic: "50000", quota: 3, subscriptionSecret: "s".repeat(32) },
    fetch: async (url, init) => {
      if (url.endsWith("/verify")) return Response.json({ isValid: true });
      if (url.endsWith("/settle")) return settle();
      asked.push(url);
      return rpcUrls(url, JSON.parse(init.body));
    },
  });
  const go = () => gate(new Request("https://api.example/echo", { headers: { "payment-signature": Buffer.from(JSON.stringify({ accepted: { extra: { plan: "monthly" } }, payload: { authorization: { from: FROM, nonce: NONCE, validBefore: String(T0 + 300) } } })).toString("base64"), ...OWNER } }), async () => Response.json({}));
  return { go, asked };
}

test("monthly without a named RPC: an own settlement that timed out is collected although the facilitator says replayed", async () => {
  for (const [network, id] of [["eip155:43113", "0xa869"], ["eip155:84532", "0x14a34"]]) {
    let n = 0;
    let up = false;
    const rpc = (url, { method, params }) => {
      if (!up) throw new Error("rpc down");
      const at = (b) => T0 - 200 + Number(b); // one block a second
      const result = {
        eth_chainId: () => id,
        eth_blockNumber: () => "0xfa",
        eth_getBlockByNumber: () => ({ timestamp: `0x${at(params[0]).toString(16)}` }),
        eth_call: () => word("0x1"),
        eth_getLogs: () => (BigInt(params[0].fromBlock) <= 205n && 205n <= BigInt(params[0].toBlock) ? [{ transactionHash: "0xtx" }] : []),
        eth_getTransactionReceipt: () => ({ status: "0x1", transactionHash: "0xtx", logs: [
          { address: USDC, logIndex: "0x1", topics: [USED, word(FROM), NONCE], data: "0x" },
          { address: USDC, logIndex: "0x2", topics: [TRANSFER, word(FROM), word(A("2"))], data: word("0xc350") },
        ] }),
      }[method]();
      return Response.json({ jsonrpc: "2.0", id: 1, result });
    };
    const { go, asked } = plainMonthly({
      network,
      rpcUrls: rpc,
      settle: () => {
        if (n++ === 0) throw new Error("timed out, but the money moved");
        return Response.json({ success: true, transaction: "0xtx", extensions: { "hub-settlement": { replayed: true } } });
      },
    });
    assert.deepEqual(await told(await go()), [409, "unclear"]);
    assert.deepEqual(await told(await go()), [409, "unclear"]); // ambiguous, not contested
    up = true;
    const res = await go();
    assert.deepEqual(await told(res), [200, "settled"]);
    assert.ok(res.headers.get("hub-subscription"));
    assert.ok(asked.length > 0);
  }
});

test("the default RPC is not asked on the way of a normal payment; other networks need one named for monthly", async () => {
  const { go, asked } = plainMonthly({ settle: () => Response.json({ success: true, transaction: "0xtx" }), rpcUrls: () => assert.fail("must not be asked") });
  assert.deepEqual(await told(await go()), [200, "settled"]);
  assert.deepEqual(asked, []);
  const base = { asset: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e", payTo: A("2"), seller: A("3"), priceAtomic: "1", facilitatorUrl: "http://127.0.0.1:1", resource: "https://api.example/echo", store: createMemoryStore(), monthly: { priceAtomic: "1", quota: null, subscriptionSecret: "s".repeat(32) } };
  for (const o of [{ network: "eip155:31337", allowLocalDevNetwork: true }]) {
    assert.throws(() => createX402Gate({ ...base, ...o }), /settlementRpcUrl/);
    assert.doesNotThrow(() => createX402Gate({ ...base, ...o, settlementRpcUrl: "https://rpc.example" }));
  }
});

test("the same buyer's two requests overlap: neither is told that the payment is settled or used; a stranger learns no more than before", async () => {
  for (const [headers, error, state] of [[OWNER, "payment_in_progress", "unclear"], [{}, "payment_already_used", "settled"], [{ "hub-idempotency-key": "x".repeat(32) }, "payment_already_used", "settled"]]) {
    const w = world({ mode: "ok" });
    let first;
    const cas = w.store.compareAndSet;
    let hooked = false;
    // the second request is verified, then the first one runs to its end, then the second one tries to claim
    w.store.compareAndSet = async (key, expected, next) => {
      if (!hooked && next?.state === "running") {
        hooked = true;
        first = await w.go(OWNER);
      }
      return cas(key, expected, next);
    };
    const res = await w.go(headers);
    assert.equal(first.status, 200);
    assert.deepEqual([res.status, res.headers.get("hub-payment-status"), (await res.json()).error], [409, state, error]);
    assert.equal(w.calls, 1);
  }
});
