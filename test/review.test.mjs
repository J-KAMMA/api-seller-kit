// Findings of the independent review of 0.2.1.
import assert from "node:assert/strict";
import { test } from "node:test";
import { closeChannels } from "../src/close.mjs";
import { createX402Gate } from "../src/index.mjs";
import { createFileStore, createMemoryStore } from "../src/store.mjs";
import { signToken } from "../src/subscription.mjs";
import { A, BUYER, CHANNEL_ID, channelGate, useVoucher, voucher } from "./fixtures/gates.mjs";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SECRET = "test-subscription-secret-0123456789";
const USDC = "0x5425890298aed601595a70AB815c96711a31Bc65";
const KEY = `channel:43113:${A("c")}:${CHANNEL_ID}`;
const INDEX = `channels:43113:${A("c")}`;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const open = { buyer: BUYER, seller: A("3"), status: 1, deposit: 1_000_000n, closeRequestedAt: 0n };
const nonce = (n) => `0x${n.toString(16).padStart(64, "0")}`;
const pay = (n, { plan, from = A("4"), extra = {} } = {}) => b64({ ...(plan ? { accepted: { extra: { plan } } } : {}), payload: { signature: "0x11", authorization: { from, nonce: nonce(n), ...extra } } });
const OWNER = { "hub-idempotency-key": "k".repeat(32) };
const req = (payment, headers = {}, url = "https://api.example/echo") => new Request(url, { headers: { ...(payment ? { "payment-signature": payment } : {}), ...headers } });
const okay = async () => Response.json({ echo: "hi" });

/** A facilitator whose /settle answers come from `settle(n)`; counts calls. */
function setup({ settle = async () => ({ success: true, transaction: "0xabc" }), monthly, store = createMemoryStore(), ...extra } = {}) {
  const count = { verify: 0, settle: 0 };
  const gate = createX402Gate({
    network: "eip155:43113", asset: USDC, payTo: A("2"), seller: A("3"), priceAtomic: "10000", facilitatorUrl: "https://facilitator.example", resource: "https://api.example/echo", store,
    ...(monthly ? { monthly: { priceAtomic: "50000", quota: 5, subscriptionSecret: SECRET, ...monthly } } : {}),
    fetch: async (url) => {
      if (url.endsWith("/verify")) return (count.verify++, await sleep(2), Response.json({ isValid: true }));
      const r = await settle(++count.settle);
      return r instanceof Response ? r : Response.json(r);
    },
    ...extra,
  });
  return { gate, count, store };
}
const upstream = () => {
  const f = async () => (f.calls++, await sleep(10), Response.json({ echo: f.calls }));
  f.calls = 0;
  return f;
};

test("one payment: one body and one token, whatever the header looks like, across instances and plans", async () => {
  for (const monthly of [undefined, {}]) {
    const store = createMemoryStore();
    const gates = [setup({ monthly, store }).gate, setup({ monthly, store }).gate];
    const api = upstream();
    const plan = monthly ? "monthly" : undefined;
    const spelled = [pay(1, { plan }), b64({ z: 1, ...JSON.parse(Buffer.from(pay(1, { plan }), "base64")) }), pay(1, { plan, from: A("4").toUpperCase().replace("0X", "0x"), extra: { junk: 1 } })];
    if (monthly) spelled.push(pay(1)); // the same authorization as a plain call
    const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => gates[i % 2](req(spelled[i % spelled.length]), api)));
    assert.equal(rs.filter((r) => r.status === 200).length, 1);
    assert.equal(api.calls, 1);
    assert.ok(rs.map((r) => r.headers.get("hub-subscription")).filter(Boolean).length <= 1);
    assert.equal((await gates[0](req(spelled[0]), api)).status, 409); // later, too: not a 402, nobody should pay again
    assert.equal((await gates[0](req(pay(2, { plan })), api)).status, 200); // another payment
  }
});

test("per call without a store: still once per process", async () => {
  const warn = console.warn;
  const said = [];
  console.warn = (m) => said.push(m);
  try {
    const { gate } = setup({ store: null });
    const api = upstream();
    const rs = await Promise.all(Array.from({ length: 6 }, () => gate(req(pay(1)), api)));
    assert.equal(rs.filter((r) => r.status === 200).length, 1);
    assert.equal(said.length, 1);
    setup({ store: null, singleInstance: true });
    assert.equal(said.length, 1);
  } finally {
    console.warn = warn;
  }
});

test("released only when the API failed and nothing was settled", async () => {
  const { gate, count } = setup();
  assert.equal((await gate(req(pay(1)), async () => new Response("x", { status: 500 }))).status, 500);
  assert.equal((await gate(req(pay(1)), async () => Promise.reject(new Error("x")))).status, 502);
  assert.equal(count.settle, 0);
  assert.equal((await gate(req(pay(1)), okay)).status, 200);
  for (const answer of [{ success: false, errorReason: "duplicate_settlement" }, new Response("x", { status: 503 }), new Response("not json"), { success: true, extensions: { "hub-settlement": { replayed: true } } }]) {
    const s = setup({ settle: async () => (answer instanceof Response ? answer.clone() : answer) });
    const api = upstream();
    const first = await s.gate(req(pay(1)), api);
    assert.equal(first.status, 409);
    assert.equal((await first.text()).includes("echo"), false);
    for (let i = 0; i < 3; i++) assert.equal((await s.gate(req(pay(1)), api)).status, 409);
    assert.equal(api.calls, 1);
  }
});

test("payments without a usable authorization are refused, and records are forgotten only after the authorization ran out", async () => {
  const now = Math.floor(Date.now() / 1000);
  const { gate, store } = setup();
  for (const payment of [b64({ payload: {} }), pay(1, { from: "0x1" }), b64({ payload: { authorization: { from: A("4"), nonce: "0x1" } } }), pay(1, { extra: { validBefore: "x" } }), pay(1, { extra: { validBefore: String(now + 100 * 86400) } })]) {
    assert.equal((await gate(req(payment), async () => assert.fail("must not be called"))).status, 402);
  }
  assert.equal((await gate(req(pay(5, { extra: { validBefore: String(now + 300) } })), okay)).status, 200);
  const key = `payment:eip155:43113|${USDC}|${A("4")}|${nonce(5)}`.toLowerCase();
  assert.ok((await store.get(key)).expiresAt > now + 300);
  const path = join(mkdtempSync(join(tmpdir(), "seller-kit-")), "s.json");
  const file = createFileStore(path);
  await file.set("payment:old", { expiresAt: now - 10 });
  await file.set("quota:old", { expiresAt: now - 10 });
  await file.set("payment:new", { expiresAt: now + 10 });
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, "utf8"))).sort(), ["payment:new", "quota:old"]);
});

test("monthly tokens hold for their path and price; the request's Host decides nothing; older tokens need the same quota", async () => {
  const buy = async (o) => (await setup(o).gate(req(pay(1, { plan: "monthly" })), okay)).headers.get("hub-subscription");
  const use = async (o, token, url) => (await setup(o).gate(req(null, { "hub-subscription": token }, url), okay)).status;
  const cheap = { resource: "https://api.example/cheap", monthly: { priceAtomic: "1", quota: 2 } };
  const dear = { resource: "https://api.example/dear", monthly: { priceAtomic: "9000000", quota: null } };
  assert.equal(await use(dear, await buy(cheap)), 402);
  assert.equal(await use({ ...cheap, monthly: { priceAtomic: "9000000", quota: 2 } }, await buy(cheap)), 402);
  assert.equal(await use({ ...cheap, monthly: { priceAtomic: "9000000", quota: 2, acceptPrices: ["1"] } }, await buy(cheap)), 200); // after a price change
  assert.equal(await use(cheap, await buy(cheap), "https://evil.example/cheap"), 200); // same API, whatever Host says
  assert.throws(() => setup({ monthly: {}, resource: undefined }), /resource/);
  const old = (quota) => signToken(SECRET, { v: 1, seller: A("3"), buyer: A("4"), resource: "https://api.example", network: "eip155:43113", expiresAt: Math.floor(Date.now() / 1000) + 999, quota });
  assert.equal(await use(cheap, await old(2)), 200);
  assert.equal(await use(dear, await old(2)), 402);
});

test("prepaid: not on mainnet; small deposits refused; a refused voucher says where the channel stands, to its buyer only", async () => {
  assert.throws(() => createX402Gate({ network: "eip155:43114", allowMainnet: true, asset: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e", payTo: A("2"), seller: A("3"), priceAtomic: "1", facilitatorUrl: "https://f.example", prepaid: { pricePerCallAtomic: "1", channelContract: A("c"), readChannel: async () => open } }));
  const small = channelGate(createMemoryStore(), { prepaid: { readChannel: async () => ({ ...open, token: USDC, deposit: 99_999n }) } });
  assert.equal((await (await useVoucher(small, await voucher(10000))).json()).error, "deposit_too_small");
  const gate = channelGate(createMemoryStore());
  await useVoucher(gate, await voucher(10000));
  assert.deepEqual((await (await useVoucher(gate, await voucher(10000))).json()).channel, { channelId: CHANNEL_ID, usedAtomic: "10000", nextAtomic: "20000" });
  const forged = JSON.parse(Buffer.from(await voucher(10000), "base64"));
  forged.cumulativeAmount = "20000";
  assert.equal((await (await useVoucher(gate, b64(forged))).json()).channel, undefined);
});

test("a write whose answer is lost does not charge a refused call", async () => {
  const inner = createMemoryStore();
  let lose = true;
  const store = {
    ...inner,
    compareAndSet: async (key, ...rest) => {
      const r = await inner.compareAndSet(key, ...rest);
      if (lose && key === KEY) {
        lose = false;
        throw new Error("net");
      }
      return r;
    },
  };
  assert.equal((await useVoucher(channelGate(store), await voucher(10000))).status, 200);
  assert.equal((await inner.get(KEY)).used, "10000");
});

test("the API sees no payment headers, has a time limit, and is not read beyond the cap", async () => {
  const { gate } = setup({ upstreamTimeoutMs: 100 });
  let seen;
  await gate(new Request("https://api.example/echo", { method: "POST", body: "hello", headers: { "payment-signature": pay(1), "x-keep": "1", ...OWNER } }), async (r) => ((seen = [...r.headers.keys()]), assert.equal(await r.text(), "hello"), okay()));
  assert.ok(seen.includes("x-keep"));
  for (const h of ["payment-signature", "x-payment", "hub-channel-voucher", "hub-subscription", "hub-idempotency-key"]) assert.equal(seen.includes(h), false);
  let aborted = false;
  assert.equal((await gate(req(pay(2)), (r) => new Promise(() => r.signal.addEventListener("abort", () => (aborted = true))))).status, 502);
  assert.equal(aborted, true);
  assert.equal((await gate(req(pay(3)), async () => new Response(new ReadableStream({ start: (c) => c.enqueue(new Uint8Array(1)) })))).status, 502); // a body that never ends
  let pulled = 0;
  const endless = () => new Response(new ReadableStream({ pull: (c) => (pulled++, c.enqueue(new Uint8Array(1024 * 1024))) }));
  const r = await setup().gate(req(pay(4)), async () => endless());
  assert.deepEqual([r.status, await r.json()], [502, { error: "upstream_too_large", payment: "not_taken", safeToPayAgain: true }]);
  assert.ok(pulled < 15);
});

test("an RPC on another chain is refused; the check is made once", async () => {
  const { encodeFunctionResult } = await import("viem");
  const { CHANNEL_ABI } = await import("../src/channel.mjs");
  const result = encodeFunctionResult({ abi: CHANNEL_ABI, functionName: "getChannel", result: { ...open, token: USDC } });
  for (const [id, status] of [["0xa869", 200], ["0x1", 502]]) {
    let asked = 0;
    const fetch = async (u, init) => {
      const { method } = JSON.parse(init.body);
      if (method === "eth_chainId") asked++;
      return Response.json({ jsonrpc: "2.0", id: 1, result: method === "eth_chainId" ? id : result });
    };
    const gate = channelGate(createMemoryStore(), { fetch, prepaid: { readChannel: undefined, rpcUrl: "https://rpc.example" } });
    assert.equal((await useVoucher(gate, await voucher(10000))).status, status);
    assert.equal((await useVoucher(gate, await voucher(20000))).status, status);
    assert.equal(asked, status === 200 ? 1 : 2);
  }
});

const close = (store, o) => closeChannels({ store, chainId: 43113, channelContract: A("c"), seller: A("3"), readChannel: async () => open, sendClose: async () => "0x", ...o });
async function used(n = 1) {
  const store = createMemoryStore();
  for (let i = 1; i <= n; i++) await useVoucher(channelGate(store), await voucher(i * 10000));
  return store;
}

test("only status 2 on chain is closed: not a sender's word, not an unknown channel", async () => {
  let store = await used();
  let out = await close(store, { sendClose: async () => "0xcancel" }); // a replaced transaction
  assert.deepEqual([out.closed, out.failed.map((f) => f.reason), (await store.get(KEY)).closed], [[], ["close_unconfirmed"], undefined]);
  for (const when of [1, 2, 3]) {
    store = await used();
    let reads = 0;
    out = await close(store, { readChannel: async () => ({ ...open, status: ++reads >= when ? 0 : 1 }), sendClose: async () => Promise.reject(new Error("x")) });
    assert.deepEqual([out.closed, (await store.get(KEY)).closed, out.failed.length], [[], undefined, 1], `status 0 from read ${when}`);
  }
});

test("a record marked closed is checked again: still open -> closed again; really closed -> off the list, and gates keep refusing", async () => {
  const store = await used();
  await store.set(KEY, { ...(await store.get(KEY)), closed: true });
  let status = 1;
  const sent = [];
  const chain = { readChannel: async () => ({ ...open, status }), sendClose: async (id, amount) => (sent.push(amount), (status = 2), "0x") };
  assert.deepEqual([(await close(store, chain)).closed, sent], [[CHANNEL_ID], [10000n]]);
  assert.deepEqual((await close(store, chain)).skipped.map((s) => s.reason), ["already_closed"]);
  assert.deepEqual(await store.get(INDEX), []);
  assert.deepEqual((await close(store, chain)).skipped, []);
  assert.equal((await useVoucher(channelGate(store), await voucher(20000))).status, 402);
});

test("a deposit below the voucher: the highest kept voucher it covers", async () => {
  const store = createMemoryStore();
  const gate = channelGate(store);
  const calls = [];
  let begun = 0;
  for (const n of [1, 2, 3]) {
    const v = await voucher(n * 10000);
    let finish;
    const p = useVoucher(gate, v, () => new Promise((r) => ((finish = r), begun++)));
    while (begun < n) await sleep(1);
    calls.push(() => (finish(200), p));
  }
  for (const c of calls) await c(); // also after they ended
  let status = 1;
  let sent;
  const out = await close(store, { readChannel: async () => ({ ...open, status, deposit: 25_000n }), sendClose: async (id, amount) => ((sent = amount), (status = 2), "0x") });
  assert.deepEqual([out.closed, sent], [[CHANNEL_ID], 20000n]);
});

test("one unreadable record does not stop the others; only-requested and the minimum", async () => {
  const store = await used();
  await store.set(INDEX, [`0x${"01".repeat(32)}`, CHANNEL_ID]);
  let status = 1;
  const bad = { ...store, get: async (k) => (k.includes("0101") ? Promise.reject(new Error("down")) : store.get(k)) };
  const out = await close(bad, { readChannel: async () => ({ ...open, status }), sendClose: async () => ((status = 2), "0x") });
  assert.deepEqual([out.closed, out.failed.length], [[CHANNEL_ID], 1]);

  const now = 1_000_000;
  const at = (closeRequestedAt) => ({ challengeSeconds: 1000, chainTime: async () => now, onlyRequested: true, readChannel: async () => ({ ...open, closeRequestedAt }), sendClose: async () => Promise.reject(Object.assign(new Error("x"), { closeNotSent: true })) });
  const reason = async (o) => {
    const r = await close(await used(), o);
    return [...r.skipped, ...r.failed].map((x) => x.reason).join();
  };
  assert.equal(await reason(at(0n)), "close_not_requested");
  assert.equal(await reason(at(BigInt(now - 10))), "close_failed"); // tried
  assert.equal(await reason(at(BigInt(now - 1000))), "challenge_period_over");
  assert.equal(await reason({ minAmountAtomic: 10001n }), "below_minimum");
  assert.equal(await reason({ ...at(BigInt(now - 10)), minAmountAtomic: 10001n }), "close_failed"); // asked for: never left behind
});

test("vouchers out of order: the smaller one is kept for the close, and pays for no call", async () => {
  const store = createMemoryStore();
  const gate = channelGate(store);
  const [v1, v2] = [await voucher(10000), await voucher(20000)];
  assert.equal((await useVoucher(gate, v2)).status, 200);
  for (let i = 0; i < 3; i++) assert.equal((await useVoucher(gate, v1)).status, 402);
  let rec = await store.get(KEY);
  assert.deepEqual([rec.used, rec.cumulativeAmount, rec.held.map((h) => h[0]), rec.calls], ["10000", "10000", ["10000", "20000"], {}]);
  assert.equal(rec.signature, JSON.parse(Buffer.from(v1, "base64")).signature.toLowerCase());
  let status = 1;
  let sent;
  const other = createMemoryStore({ [KEY]: rec, [INDEX]: [CHANNEL_ID] });
  await close(other, { readChannel: async () => ({ ...open, status }), sendClose: async (id, amount) => ((sent = amount), (status = 2), "0x") });
  assert.equal(sent, 10000n);
  assert.equal((await useVoucher(gate, v2)).status, 200); // what v2 still covers, once
  assert.equal((await useVoucher(gate, v2)).status, 402);
  assert.equal((await useVoucher(gate, v1)).status, 402);
  rec = await store.get(KEY);
  assert.deepEqual([rec.used, rec.cumulativeAmount, rec.held.map((h) => h[0])], ["20000", "20000", ["10000", "20000"]]);
  await useVoucher(gate, await voucher(15000)); // below what is used: not kept
  assert.deepEqual((await store.get(KEY)).held.map((h) => h[0]), ["10000", "20000"]);
  // a forged one, and one that arrives while the channel is being closed, change nothing
  await useVoucher(gate, await voucher(40000));
  const before = await store.get(KEY);
  await useVoucher(gate, b64({ ...JSON.parse(Buffer.from(await voucher(35000), "base64")), cumulativeAmount: "34000" }));
  await store.set(KEY, { ...before, closing: { v: 2, at: Date.now(), id: "x", phase: "claimed" } });
  const claimed = await store.get(KEY);
  await useVoucher(gate, await voucher(35000));
  assert.deepEqual(await store.get(KEY), claimed);
});

test("a channel that starts above the price without a record is pointed out", async () => {
  const warn = console.warn;
  const said = [];
  console.warn = (m) => said.push(m);
  try {
    const gate = channelGate(createMemoryStore());
    await useVoucher(gate, await voucher(10000));
    assert.equal(said.length, 0);
    await useVoucher(channelGate(createMemoryStore()), await voucher(50000));
    assert.equal(said.length, 1);
  } finally {
    console.warn = warn;
  }
});
