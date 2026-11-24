// Closing while calls run, with a faked chain.
import assert from "node:assert/strict";
import { test } from "node:test";
import { closeChannels } from "../src/close.mjs";
import { createMemoryStore } from "../src/store.mjs";
import { A, BUYER, CHANNEL_ID, channelGate, useVoucher, voucher } from "./fixtures/gates.mjs";

const KEY = `channel:43113:${A("c")}:${CHANNEL_ID}`;
const HOUR = 3_600_000;
const DAY = 86_400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const open = { buyer: BUYER, seller: A("3"), status: 1, deposit: 1_000_000n, closeRequestedAt: 0n };
async function pending(gate, v) {
  let finish;
  let begun;
  const started = new Promise((r) => (begun = r));
  const res = useVoucher(gate, v, () => new Promise((r) => ((finish = r), begun())));
  await started;
  return async (status) => (finish(status), (await res).status);
}
async function close(store, extra = {}) {
  const sent = [];
  const done = new Set();
  const { readChannel = async () => open, sendClose = async (id, amount) => (sent.push(amount), "0xtx"), ...rest } = extra;
  const out = await closeChannels({
    store, chainId: 43113, channelContract: A("c"), seller: A("3"), challengeSeconds: DAY, drainMs: 5_000,
    readChannel: async (id) => ({ ...(await readChannel(id)), ...(done.has(id) ? { status: 2 } : {}) }),
    sendClose: async (id, ...args) => {
      const tx = await sendClose(id, ...args);
      done.add(id);
      return tx;
    },
    ...rest,
  });
  return { ...out, sent };
}
const claimed = async (store) => {
  while (!(await store.get(KEY))?.closing) await sleep(5);
};

test("a running call that fails after the claim is not charged; one that succeeds is", async () => {
  for (const [first, second, amount] of [[500, 200, 10000n], [200, 500, 10000n], [500, 500, null], [200, 200, 20000n]]) {
    const store = createMemoryStore();
    const gate = channelGate(store);
    const a = await pending(gate, await voucher(10000));
    const b = await pending(gate, await voucher(20000));
    const run = close(store);
    await claimed(store);
    assert.equal((await useVoucher(gate, await voucher(30000))).status, 402); // new ones are refused meanwhile
    await a(first);
    await b(second);
    const out = await run;
    assert.deepEqual(out.sent, amount === null ? [] : [amount]);
    assert.deepEqual(out.drainTimedOut, []);
    if (amount === null) assert.equal((await store.get(KEY)).closing, undefined);
  }
});

test("a call that does not end is waited for only so long, and reported", async () => {
  const store = createMemoryStore();
  const gate = channelGate(store);
  const a = await pending(gate, await voucher(10000));
  const b = await pending(gate, await voucher(20000));
  const started = Date.now();
  const run = close(store, { drainMs: 400 });
  await claimed(store);
  await a(500);
  const out = await run;
  assert.ok(Date.now() - started < 4_000);
  assert.deepEqual(out.drainTimedOut, [{ channelId: CHANNEL_ID, calls: 1 }]);
  assert.deepEqual(out.sent, [10000n]); // b counts as served, a was given back
  await b(200);
});

test("the waiting time is for the whole run, not per channel", async () => {
  const store = createMemoryStore();
  const gate = channelGate(store);
  const ids = [1, 2, 3, 4].map((n) => `0x${String(n).repeat(64)}`);
  const calls = [];
  for (const id of ids) calls.push(await pending(gate, await voucher(10000, id)));
  const started = Date.now();
  const out = await close(store, { drainMs: 500 });
  assert.ok(Date.now() - started < 1_500, String(Date.now() - started));
  assert.equal(out.drainTimedOut.length, 4);
  assert.equal(out.sent.length, 4);
  for (const c of calls) await c(200);
});

test("the challenge period is never put at risk: at most a tenth of what is left, requested channels first", async () => {
  const time = async (extra) => {
    const store = createMemoryStore();
    const call = await pending(channelGate(store), await voucher(10000));
    const started = Date.now();
    const out = await close(store, { drainMs: 3_000, ...extra });
    assert.equal(out.sent.length, 1);
    const took = Date.now() - started;
    await call(200);
    return took;
  };
  const now = 1_000_000;
  const requested = (ago) => ({ readChannel: async () => ({ ...open, closeRequestedAt: BigInt(now - ago) }), chainTime: async () => now });
  assert.ok((await time(requested(DAY - 2))) < 1_000); // 2 s left: 0.2 s
  assert.ok((await time({ challengeSeconds: 3 })) < 1_200); // a tenth of 3 s, whenever the request comes
  assert.ok((await time({ challengeSeconds: undefined })) < 500); // unknown: no waiting

  const store = createMemoryStore();
  const gate = channelGate(store);
  const ids = [1, 2, 3].map((n) => `0x${String(n).repeat(64)}`);
  for (const id of ids) await useVoucher(gate, await voucher(10000, id));
  const order = [];
  await close(store, {
    chainTime: async () => now,
    readChannel: async (id) => ({ ...open, closeRequestedAt: { [ids[0]]: 0n, [ids[1]]: BigInt(now - 100), [ids[2]]: BigInt(now - 900) }[id] }),
    sendClose: async (id) => (order.push(id), "0xtx"),
  });
  assert.deepEqual(order, [ids[2], ids[1], ids[0]]);
});

test("a gate that died in a call does not hold up closing after the call's expiry, and its call counts as served", async () => {
  const store = createMemoryStore();
  const dying = channelGate(store, { prepaid: { callTimeoutMs: 300 } });
  const call = await pending(dying, await voucher(10000));
  const started = Date.now();
  const out = await close(store, { drainMs: 60_000 });
  assert.ok(Date.now() - started < 5_000);
  assert.deepEqual([out.sent, out.drainTimedOut], [[10000n], []]);
  await call(200);
  assert.throws(() => channelGate(store, { prepaid: { callTimeoutMs: 0 } }));
});

test("a failure after the expiry still gives its price back; ended calls leave nothing behind", async () => {
  const store = createMemoryStore();
  const gate = channelGate(store, { prepaid: { callTimeoutMs: 20 } });
  const late = await pending(gate, await voucher(10000));
  await sleep(40);
  assert.equal((await useVoucher(gate, await voucher(20000))).status, 200);
  await late(500);
  const rec = await store.get(KEY);
  assert.deepEqual([rec.used, rec.calls], ["10000", {}]);
  assert.ok(BigInt(rec.cumulativeAmount) >= 10000n);
});

test("in serial use a handful of vouchers is kept", async () => {
  const store = createMemoryStore();
  const gate = channelGate(store);
  for (let i = 1; i <= 20; i++) await useVoucher(gate, await voucher(i * 10000));
  const rec = await store.get(KEY);
  assert.deepEqual([rec.held.map((h) => h[0]), rec.calls], [["160000", "170000", "180000", "190000", "200000"], {}]);
});

test("the store failing when a call ends does not fail the call, and does not hold up closing for good", async () => {
  const inner = createMemoryStore();
  let down = false;
  const store = { ...inner, compareAndSet: async (...a) => (down ? Promise.reject(new Error("down")) : inner.compareAndSet(...a)) };
  const gate = channelGate(store, { prepaid: { callTimeoutMs: 200 } });
  assert.equal((await useVoucher(gate, await voucher(10000), () => ((down = true), 200))).status, 200);
  down = false;
  assert.deepEqual((await close(store)).sent, [10000n]);
});

test("a claim stored with a transaction never ends by time, also one of 0.2.1 that may have sent one", async () => {
  const store = createMemoryStore();
  const gate = channelGate(store);
  await useVoucher(gate, await voucher(10000));
  const rec = await store.get(KEY);
  const at = Date.now() - 1000 * HOUR;
  const tx = { hash: "0x1", nonce: 5, from: A("3"), gas: "1", maxFeePerGas: "1", maxPriorityFeePerGas: "1" };
  for (const closing of [{ v: 2, at, id: "x", phase: "sent", tx, amount: "10000", signature: rec.signature }, { v: 2, at, id: "x", phase: "unknown" }, { v: 2, at, id: "x", phase: "claimed", mayBeOut: true }, { at, id: "x" }]) {
    await store.set(KEY, { ...rec, closing });
    assert.equal((await useVoucher(gate, await voucher(20000))).status, 402, JSON.stringify(closing));
  }
  // and a run that cannot send does not release what may be out, however often it runs
  for (let i = 0; i < 3; i++) {
    await close(store, { sendClose: async () => Promise.reject(Object.assign(new Error("x"), { closeNotSent: true })) });
    assert.equal((await useVoucher(gate, await voucher(20000))).status, 402);
  }
});

test("an earlier transaction: still possible -> its voucher and nonce again; unreadable -> untouched; proven dead -> a new one", async () => {
  const store = createMemoryStore();
  const gate = channelGate(store);
  await useVoucher(gate, await voucher(10000));
  const rec = await store.get(KEY);
  const tx = { hash: "0x1", nonce: 5, from: A("3") };
  const closing = { v: 2, at: 1, id: "x", phase: "sent", tx, amount: "10000", signature: rec.signature };
  await store.set(KEY, { ...rec, closing });
  const before = await store.get(KEY);
  let out = await close(store, { snapshot: async () => Promise.reject(new Error("rpc")), sendClose: async () => assert.fail("must not send") });
  assert.deepEqual([out.failed[0].reason, await store.get(KEY)], ["close_unconfirmed", before]);
  const calls = [];
  const sendClose = async (id, amount, signature, { replace }) => (calls.push([amount, replace?.nonce]), Promise.reject(new Error("unconfirmed")));
  await close(store, { snapshot: async () => ({ status: 1, nonce: 5 }), sendClose });
  assert.equal((await store.get(KEY)).closing.phase, "sent");
  await close(store, { snapshot: async () => ({ status: 1, nonce: 6 }), sendClose });
  assert.deepEqual(calls, [[10000n, 5], [10000n, undefined]]);
  out = await close(createStoreWith(before), { snapshot: async () => ({ status: 2, nonce: 6 }), sendClose: async () => assert.fail("must not send") });
  assert.deepEqual(out.skipped.map((s) => s.reason), ["not_open_on_chain"]);
});
const createStoreWith = (rec) => createMemoryStore({ [KEY]: rec, [`channels:43113:${A("c")}`]: [CHANNEL_ID] });

test("a claim that is there is followed up whatever the filters say", async () => {
  const tx = { hash: "0x1", nonce: 5, from: A("3") };
  for (const closing of [{ v: 2, at: 1, id: "x", phase: "sent", tx, amount: "10000" }, { v: 2, at: Date.now(), id: "x", phase: "claimed" }]) {
    for (const filter of [{ onlyRequested: true }, { minAmountAtomic: 999_999n }]) {
      const store = createMemoryStore();
      await useVoucher(channelGate(store), await voucher(10000));
      const rec = await store.get(KEY);
      await store.set(KEY, { ...rec, closing: { ...closing, signature: rec.signature } });
      const out = await close(store, { ...filter, snapshot: async () => ({ status: 1, nonce: 6 }) });
      assert.deepEqual([out.sent, out.skipped], [[10000n], []]);
      assert.equal((await store.get(KEY)).closed, true);
    }
  }
});

test("a channel is claimed right before it is closed, the urgent one first; the others go on taking calls meanwhile", async () => {
  const store = createMemoryStore();
  const gate = channelGate(store);
  const ids = [1, 2, 3].map((n) => `0x${String(n).repeat(64)}`);
  for (const id of ids) await useVoucher(gate, await voucher(10000, id));
  const now = Math.floor(Date.now() / 1000);
  const order = [];
  await close(store, {
    chainTime: async () => now,
    readChannel: async (id) => ({ ...open, closeRequestedAt: id === ids[2] ? BigInt(now - 900) : 0n }),
    sendClose: async (id) => {
      order.push(id);
      if (order.length === 1) for (const other of ids.slice(0, 2)) assert.equal((await useVoucher(gate, await voucher(20000, other))).status, 200);
      return "0xtx";
    },
  });
  assert.equal(order[0], ids[2]);
  assert.equal(order.length, 3);
});

test("a carried over transaction is not released because the deposit looks too small", async () => {
  const store = createMemoryStore();
  await useVoucher(channelGate(store), await voucher(10000));
  const rec = await store.get(KEY);
  const closing = { v: 2, at: 1, id: "x", phase: "sent", tx: { hash: "0x1", nonce: 5, from: A("3") }, amount: "10000", signature: rec.signature };
  await store.set(KEY, { ...rec, closing });
  const out = await close(store, { readChannel: async () => ({ ...open, deposit: 5_000n }), snapshot: async () => ({ status: 1, nonce: 5 }), sendClose: async () => assert.fail("must not send") });
  assert.deepEqual(out.failed.map((f) => f.reason), ["close_unconfirmed"]);
  assert.equal((await store.get(KEY)).closing.phase, "sent");
  assert.equal((await useVoucher(channelGate(store), await voucher(20000))).status, 402);
});

test("closed at the head only: nothing is marked or forgotten yet", async () => {
  const store = createMemoryStore();
  await useVoucher(channelGate(store), await voucher(10000));
  const index = `channels:43113:${A("c")}`;
  let settled = 1;
  const o = { readChannel: async () => ({ ...open, status: 2 }), settledChannel: async () => ({ status: settled }) };
  await close(store, o);
  assert.deepEqual([(await store.get(KEY)).closed, await store.get(index)], [undefined, [CHANNEL_ID]]);
  // and a close that is mined, but not deep enough, is not reported as done
  let status = 1;
  const out = await close(store, { readChannel: async () => ({ ...open, status }), settledChannel: async () => ({ status: 1 }), sendClose: async (i, a, g, { record }) => (await record({ hash: "0x1", nonce: 1, from: A("3") }), (status = 2), "0x1") });
  assert.deepEqual([out.closed, out.failed.map((f) => f.reason), (await store.get(KEY)).closed], [[], ["close_unconfirmed"], undefined]);
  settled = 2;
  await close(store, o);
  assert.deepEqual([(await store.get(KEY)).closed, await store.get(index)], [true, []]);
});
