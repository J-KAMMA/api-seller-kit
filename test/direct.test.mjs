// hub-direct (0.5.0): the buyer sends the payment to the chain itself and pays its gas; the gate reads it from the chain and asks no facilitator.
import assert from "node:assert/strict";
import { test } from "node:test";
import { toHex } from "viem";
import { createX402Gate } from "../src/index.mjs";
import { boundNonce, gateIdOf } from "../src/gate-binding.mjs";
import { createMemoryStore } from "../src/store.mjs";
import { A } from "./fixtures/gates.mjs";

const USDC = "0x5425890298aed601595a70ab815c96711a31bc65";
const PAY_TO = A("2");
const FROM = A("4");
const AUTHORIZATION_USED = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const word = (a) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;
const hex = (n) => `0x${BigInt(n).toString(16)}`;
const random32 = () => toHex(crypto.getRandomValues(new Uint8Array(32)));
const nowS = () => Math.floor(Date.now() / 1000);

/** A chain: transactions by hash, a head, blocks with hashes; every request counted by method. */
function chainOf({ chainId = 43113 } = {}) {
  const c = { chainId, head: 100n, txs: new Map(), blocks: new Map(), used: new Set(), calls: [], facilitator: 0 };
  c.block = (n) => c.blocks.get(n) ?? { number: hex(n), hash: `0x${n.toString(16).padStart(64, "b")}`, timestamp: hex(nowS() - 10) };
  /** A transaction in block `at` that pays `amount` from `from` to `to` with this nonce, through the `token` contract. */
  c.pay = ({ nonce, amount = 10000n, from = FROM, to = PAY_TO, token = USDC, at = 99n, status = "0x1", authorization = true }) => {
    const hash = random32();
    const logs = [];
    if (authorization) logs.push({ address: token, topics: [AUTHORIZATION_USED, word(from), nonce], data: "0x", logIndex: hex(logs.length) });
    logs.push({ address: token, topics: [TRANSFER, word(from), word(to)], data: hex(amount), logIndex: hex(logs.length) });
    c.txs.set(hash, { transactionHash: hash, status, blockNumber: hex(at), blockHash: c.block(at).hash, logs });
    if (status === "0x1" && authorization) c.used.add(`${from.toLowerCase()}|${nonce}`);
    return hash;
  };
  c.fetch = async (url, init) => {
    if (!url.startsWith("https://rpc.example") && !url.startsWith("https://api.avax-test.network")) {
      c.facilitator++;
      throw new Error("no facilitator on this path");
    }
    const { method, params } = JSON.parse(init.body);
    c.calls.push(method);
    const result = (() => {
      switch (method) {
        case "eth_chainId": return hex(c.chainId);
        case "eth_blockNumber": return hex(c.head);
        case "eth_getTransactionReceipt": return c.txs.get(params[0]) ?? null;
        case "eth_getBlockByNumber": return c.block(BigInt(params[0]));
        case "eth_call": {
          const from = `0x${params[0].data.slice(10 + 24, 10 + 64)}`;
          const nonce = `0x${params[0].data.slice(10 + 64)}`;
          return word(c.used.has(`${from}|${nonce}`) ? "0x1" : "0x0");
        }
        default: throw new Error(method);
      }
    })();
    return Response.json({ jsonrpc: "2.0", id: 1, result });
  };
  return c;
}

function gateOf(chain, { gateId = "api-one", network = "eip155:43113", store = createMemoryStore(), ...extra } = {}) {
  return createX402Gate({ network, asset: USDC, payTo: PAY_TO, seller: A("3"), priceAtomic: "10000", direct: true, gateId, resource: "https://api.example/echo", settlementRpcUrl: "https://rpc.example", store, fetch: chain.fetch, ...extra });
}
const quoteOf = async (gate) => (await (await gate(new Request("https://api.example/echo"), null)).json()).accepts;
/** What the buyer sends after its transaction. */
const headerOf = (fields) => Buffer.from(JSON.stringify({ v: 1, network: "eip155:43113", from: FROM, ...fields })).toString("base64");
let served = 0;
const api = async () => (served++, Response.json({ echo: 1 }));
const call = (gate, header, { body, next = api } = {}) =>
  gate(new Request("https://api.example/echo", { method: body ? "POST" : "GET", body, headers: { "hub-direct-payment": header } }), next);
const told = async (res) => {
  const b = await res.clone().json().catch(() => ({}));
  assert.notEqual(b.safeToPayAgain, true, "never told to pay again: the money may have moved");
  if (res.status !== 200 && res.headers.get("hub-payment-status") !== "not_taken" && b.error !== "pay_with_hub_direct") {
    // after paying: nothing a plain x402 client would take for a price
    assert.equal(res.headers.get("payment-required"), null, b.error);
    assert.equal(b.accepts, undefined, b.error);
  }
  return [res.status, res.headers.get("hub-payment-status"), b.error];
};
/** A bound payment for this gate, sent and mined. */
async function paid(chain, gate, opts = {}) {
  const r = random32();
  const gateId = (await quoteOf(gate)).find((a) => a.scheme === "hub-direct").extra.gateBinding.gateId;
  const nonce = boundNonce({ chainId: chain.chainId, asset: USDC, payTo: PAY_TO, gateId, r });
  const txHash = chain.pay({ nonce, ...opts });
  return { r, nonce, txHash, header: headerOf({ txHash, nonce, r }) };
}

test("the quote offers hub-direct with the gate's id, the depth and the header; no exact entry without a facilitator", async () => {
  const chain = chainOf();
  const accepts = await quoteOf(gateOf(chain, { monthly: { priceAtomic: "50000", quota: 2, subscriptionSecret: "s".repeat(32) } }));
  assert.deepEqual(accepts.map((a) => [a.scheme, a.amount, a.extra.plan ?? null]), [["hub-direct", "10000", null], ["hub-direct", "50000", "monthly"]]);
  const [d] = accepts;
  assert.equal(d.payTo, PAY_TO.toLowerCase());
  assert.equal(d.asset, USDC);
  assert.deepEqual(d.extra.gateBinding, { v: 1, gateId: gateIdOf({ gateId: "api-one" }), required: true });
  assert.equal(d.extra.minConfirmations, 1);
  assert.equal(d.extra.header, "hub-direct-payment");
  const both = await quoteOf(gateOf(chain, { facilitatorUrl: "https://f.example" }));
  assert.deepEqual(both.map((a) => a.scheme), ["exact", "hub-direct"]);
  assert.throws(() => createX402Gate({ network: "eip155:43113", asset: USDC, payTo: PAY_TO, seller: A("3"), priceAtomic: "1", store: createMemoryStore() }), /facilitatorUrl/); // not direct: a facilitator is needed
  assert.throws(() => createX402Gate({ network: "eip155:43113", asset: USDC, payTo: PAY_TO, seller: A("3"), priceAtomic: "1", direct: true, store: createMemoryStore() }), /gateId or resource/);
  assert.throws(() => gateOf(chain, { direct: "yes" }), /direct/);
  // an x402 payment at a gate that asks no facilitator: nothing happened
  const res = await gateOf(chain)(new Request("https://api.example/echo", { headers: { "payment-signature": "e30=" } }), api);
  assert.deepEqual(await told(res), [402, "refused", "pay_with_hub_direct"]);
  assert.equal(chain.facilitator, 0);
});

test("a paid transaction is served once, without a facilitator; the API never sees the header", async () => {
  const chain = chainOf();
  const gate = gateOf(chain);
  const p = await paid(chain, gate);
  let seen;
  const res = await call(gate, p.header, { next: async (req) => ((seen = req.headers.get("hub-direct-payment")), Response.json({ echo: 1 })) });
  assert.deepEqual(await told(res), [200, "settled", undefined]);
  assert.equal(seen, null);
  assert.equal(JSON.parse(Buffer.from(res.headers.get("payment-response"), "base64")).transaction, p.txHash);
  assert.equal(chain.facilitator, 0);
  // the same header again, by anyone: not served again
  assert.deepEqual(await told(await call(gate, p.header)), [409, "settled", "already_served"]);
  // the same transaction with another r (somebody who saw the nonce on chain): not this gate's payment
  assert.deepEqual(await told(await call(gate, headerOf({ txHash: p.txHash, nonce: p.nonce, r: random32() }))), [422, "refused", "payment_for_another_gate"]);
});

test("a second gate on the same payTo, with its own store, refuses it; so does a gate on another network", async () => {
  const chain = chainOf();
  const one = gateOf(chain);
  const p = await paid(chain, one);
  assert.deepEqual(await told(await call(gateOf(chain, { gateId: "api-two" }), p.header)), [422, "refused", "payment_for_another_gate"]);
  const other = headerOf({ txHash: p.txHash, nonce: p.nonce, r: p.r, network: "eip155:84532" });
  assert.deepEqual(await told(await call(one, other)), [422, "refused", "payment_wrong_network"]);
  assert.deepEqual(await told(await call(one, p.header)), [200, "settled", undefined]); // still unused at its own gate
});

test("a transaction that does not pay this gate is refused: amount, payTo, token, no AuthorizationUsed, reverted", async () => {
  const chain = chainOf();
  const gate = gateOf(chain);
  for (const opts of [{ amount: 9999n }, { to: A("9") }, { token: A("8") }, { authorization: false }]) {
    const p = await paid(chain, gate, opts);
    assert.deepEqual(await told(await call(gate, p.header)), [422, "refused", "payment_not_in_transaction"], JSON.stringify(opts, (k, v) => (typeof v === "bigint" ? String(v) : v)));
  }
  const more = await paid(chain, gate, { amount: 20000n }); // more than the price is a payment
  assert.equal((await call(gate, more.header)).status, 200);
  const reverted = await paid(chain, gate, { status: "0x0" });
  assert.deepEqual(await told(await call(gate, reverted.header)), [422, "refused", "payment_reverted"]);
  // reverted because somebody else sent the same signed authorization first: the buyer is told to name that transaction
  const first = await paid(chain, gate);
  const late = chain.pay({ nonce: first.nonce, status: "0x0" });
  assert.deepEqual(await told(await call(gate, headerOf({ txHash: late, nonce: first.nonce, r: first.r }))), [422, "refused", "payment_in_another_transaction"]);
  assert.equal((await call(gate, first.header)).status, 200);
  assert.equal(served >= 2, true);
});

test("not found, not deep enough or replaced: pending, never pay again; the same header later is served", async () => {
  const chain = chainOf({ chainId: 84532 });
  const gate = gateOf(chain, { network: "eip155:84532" }); // 30 blocks deep there
  const r = random32();
  const nonce = boundNonce({ chainId: 84532, asset: USDC, payTo: PAY_TO, gateId: gateIdOf({ gateId: "api-one" }), r });
  const header = (txHash) => headerOf({ txHash, nonce, r, network: "eip155:84532" });
  const pending = async (h) => {
    const res = await call(gate, h);
    assert.deepEqual(await told(res), [402, "unclear", "payment_pending"]);
    assert.equal(res.headers.get("payment-required"), null); // not a quote: nothing to pay
    assert.ok(res.headers.get("retry-after"));
  };
  await pending(header(random32())); // not found yet
  const tx = chain.pay({ nonce, at: 90n });
  await pending(header(tx)); // 11 blocks deep
  chain.head = 130n;
  chain.blocks.set(90n, { number: hex(90n), hash: `0x${"c".repeat(64)}`, timestamp: hex(nowS() - 10) }); // the block at 90 was replaced
  await pending(header(tx));
  chain.blocks.delete(90n);
  assert.deepEqual(await told(await call(gate, header(tx))), [200, "settled", undefined]);
});

test("too old to tell from a payment that was served and forgotten: refused; an RPC on another chain: unclear", async () => {
  const chain = chainOf();
  const gate = gateOf(chain);
  chain.blocks.set(50n, { number: hex(50n), hash: `0x${"d".repeat(64)}`, timestamp: hex(nowS() - 73 * 3600) });
  const old = await paid(chain, gate, { at: 50n });
  assert.deepEqual(await told(await call(gate, old.header)), [422, "refused", "payment_too_old"]);
  const wrong = chainOf({ chainId: 1 });
  const g2 = gateOf(wrong);
  const p = await paid({ ...wrong, chainId: 43113, pay: wrong.pay }, g2);
  assert.deepEqual(await told(await call(g2, p.header)), [503, "unclear", "chain_unavailable"]);
});

test("a call the API refused or failed does not use the payment up: another call is served with it, once", async () => {
  const chain = chainOf();
  const gate = gateOf(chain);
  const p = await paid(chain, gate);
  const failing = await call(gate, p.header, { body: "a", next: async () => { throw new Error("down"); } });
  assert.deepEqual(await told(failing), [502, "settled", "upstream_failed"]);
  const bad = await call(gate, p.header, { body: "b", next: async () => Response.json({ error: "bad request" }, { status: 400 }) });
  assert.deepEqual(await told(bad), [400, "settled", "bad request"]);
  assert.deepEqual(await told(await call(gate, p.header, { body: "c" })), [200, "settled", undefined]);
  assert.deepEqual(await told(await call(gate, p.header, { body: "c" })), [409, "settled", "already_served"]);
  assert.deepEqual(await told(await call(gate, p.header, { body: "d" })), [409, "settled", "already_served"]);
});

test("monthly: a store failure or a crash between taking the payment and recording the token still ends with the token", async () => {
  const chain = chainOf();
  const inner = createMemoryStore();
  let failOwed = 1;
  const store = {
    get: (k) => inner.get(k),
    set: (k, v) => inner.set(k, v),
    compareAndSet: async (k, expected, next) => {
      if (next?.state === "owed" && failOwed > 0) {
        failOwed--;
        throw new Error("store down");
      }
      return inner.compareAndSet(k, expected, next);
    },
  };
  const monthly = { priceAtomic: "50000", quota: 2, subscriptionSecret: "s".repeat(32) };
  const gate = gateOf(chain, { store, monthly });
  const p = await paid(chain, gate, { amount: 50000n });
  const header = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p.header, "base64")), plan: "monthly" })).toString("base64");
  assert.deepEqual(await told(await call(gate, header)), [502, "settled", "store_unavailable"]);
  // the record was taken and is half done: another process may be finishing it, so it waits for the lease
  assert.deepEqual(await told(await call(gate, header)), [409, "settled", "payment_in_progress"]);
  const k0 = `payment:${["eip155:43113", USDC, FROM, p.nonce].join("|").toLowerCase()}`;
  const half = await inner.get(k0);
  assert.equal(half.state, "settling");
  await inner.compareAndSet(k0, half, { ...half, at: Date.now() - 10 * 60_000 });
  const again = await call(gate, header);
  assert.equal(again.status, 200);
  const token = again.headers.get("hub-subscription");
  assert.ok(token, "the month is not lost");
  // a second process with the same store, after a crash right after taking it (left "settling"): the same token
  assert.equal((await gate(new Request("https://api.example/echo", { headers: { "hub-subscription": token } }), api)).status, 200);

  const crashed = createMemoryStore();
  const g1 = gateOf(chain, { store: crashed, monthly });
  const q = await paid(chain, g1, { amount: 50000n });
  const h = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(q.header, "base64")), plan: "monthly" })).toString("base64");
  // what a process leaves when it dies after "settling": the record as the claim wrote it
  const k = `payment:${["eip155:43113", USDC, FROM, q.nonce].join("|").toLowerCase()}`;
  const { createPayments, sha256Hex } = await import("../src/payments.mjs");
  const owner = await sha256Hex(JSON.stringify([k, "hub-direct", q.r.toLowerCase()]));
  const ps = createPayments(crashed, 1);
  const { rec } = await ps.claim({ key: k, expiresAt: nowS() + 9999 }, owner, null, nowS(), { direct: { plan: "monthly", from: FROM.toLowerCase(), transaction: q.txHash } });
  await ps.settling(k, rec.id, null);
  const cur = await crashed.get(k);
  await crashed.compareAndSet(k, cur, { ...cur, at: Date.now() - 10 * 60_000 }); // its lease ran out
  const taken = await call(g1, h);
  assert.equal(taken.status, 200);
  assert.ok(taken.headers.get("hub-subscription"));
});

test("made-up headers cannot use up the gate's RPC: a few lookups a minute, then 503 and retry later, never pay again", async () => {
  const chain = chainOf();
  const gate = createX402Gate({ network: "eip155:43113", asset: USDC, payTo: PAY_TO, seller: A("3"), priceAtomic: "10000", direct: true, gateId: "api-one", store: createMemoryStore(), fetch: chain.fetch }); // the public RPC
  const gateId = gateIdOf({ gateId: "api-one" });
  const junk = () => {
    const r = random32();
    return headerOf({ from: `0x${random32().slice(26)}`, txHash: random32(), r, nonce: boundNonce({ chainId: 43113, asset: USDC, payTo: PAY_TO, gateId, r }) });
  };
  const answers = [];
  for (let i = 0; i < 40; i++) answers.push((await told(await call(gate, junk())))[2]);
  assert.ok(answers.filter((a) => a === "chain_busy").length >= 15, answers.join(","));
  assert.ok(chain.calls.filter((m) => m === "eth_getTransactionReceipt").length <= 20, String(chain.calls.length));
  const busy = await call(gate, junk());
  assert.equal(busy.status, 503);
  assert.ok(busy.headers.get("retry-after"));
  // one payer cannot take them all either
  const own = gateOf(chainOf());
  const one = [];
  for (let i = 0; i < 200; i++) {
    const r = random32();
    one.push((await told(await call(own, headerOf({ txHash: random32(), r, nonce: boundNonce({ chainId: 43113, asset: USDC, payTo: PAY_TO, gateId, r }) }))))[2]);
  }
  assert.ok(one.includes("chain_busy"), "per payer");
});

test("malformed fields are refused, not a server error", async () => {
  const chain = chainOf();
  const gate = gateOf(chain);
  const p = await paid(chain, gate);
  const fields = JSON.parse(Buffer.from(p.header, "base64"));
  for (const change of [{ txHash: [fields.txHash] }, { from: [FROM] }, { nonce: [fields.nonce] }, { r: [fields.r] }, { r: 1 }, { plan: ["monthly"] }, { v: "1" }]) {
    const res = await call(gate, Buffer.from(JSON.stringify({ ...fields, ...change })).toString("base64"));
    assert.equal(res.status, 422, JSON.stringify(change));
  }
  for (const raw of ["[]", "null", "1", '"x"']) assert.equal((await call(gate, Buffer.from(raw).toString("base64"))).status, 422, raw);
});

test("monthly: a direct payment of the monthly price gives the token, which then serves calls", async () => {
  const chain = chainOf();
  const gate = gateOf(chain, { monthly: { priceAtomic: "50000", quota: 2, subscriptionSecret: "s".repeat(32) } });
  const short = await paid(chain, gate, { amount: 10000n });
  const asMonthly = (p) => Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p.header, "base64")), plan: "monthly" })).toString("base64");
  assert.deepEqual(await told(await call(gate, asMonthly(short))), [422, "refused", "payment_not_in_transaction"]); // the per-call price is not a month
  const p = await paid(chain, gate, { amount: 50000n });
  const bought = await call(gate, asMonthly(p));
  assert.equal(bought.status, 200);
  const token = bought.headers.get("hub-subscription");
  assert.ok(token);
  const use = await gate(new Request("https://api.example/echo", { headers: { "hub-subscription": token } }), api);
  assert.equal(use.status, 200);
  const none = await gateOf(chain, { gateId: "api-two" })(new Request("https://api.example/echo", { headers: { "hub-subscription": token } }), api);
  assert.notEqual(none.status, 200);
});

test("an x402 payment settled through a facilitator is remembered long enough that its transaction cannot be served again as hub-direct", async () => {
  const { createPayments } = await import("../src/payments.mjs");
  const store = createMemoryStore();
  const payments = createPayments(store, 1000);
  const { rec } = await payments.claim({ key: "payment:x", expiresAt: nowS() + 60 }, "o", "q", nowS());
  await payments.settling("payment:x", rec.id, "1");
  await payments.settled("payment:x", rec.id, { transaction: "0xtx" });
  assert.ok((await store.get("payment:x")).expiresAt > nowS() + 24 * 3600);
});
