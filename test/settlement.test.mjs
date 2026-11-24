// What a channel is closed with: overlapping calls, closing while calls arrive, broken upstream bodies.
import assert from "node:assert/strict";
import { test } from "node:test";
import { closeChannels } from "../src/close.mjs";
import { createMemoryStore } from "../src/store.mjs";
import { A, BUYER, CHANNEL_ID, channelGate, monthlyGate, purchase, quotaKey, quotaToken, useToken, useVoucher, voucher } from "./fixtures/gates.mjs";

const KEY = `channel:43113:${A("c")}:${CHANNEL_ID}`;
const LEGACY = `channel:${CHANNEL_ID}`;
const HOUR = 60 * 60 * 1000;
const sigOf = (v) => JSON.parse(Buffer.from(v, "base64").toString()).signature.toLowerCase();
const open = { buyer: BUYER, seller: A("3"), status: 1, deposit: 1_000_000n };
/** The fake chain: a close that returns is mined, per store and channel. */
const mined = new WeakMap();
const isMined = (store, id) => mined.get(store)?.has(id);
const mine = (store, id) => void (mined.get(store) ?? mined.set(store, new Set()).get(store)).add(id);
const close = (store, sendClose, readChannel = async () => open) =>
  closeChannels({
    store, chainId: 43113, channelContract: A("c"), seller: A("3"),
    readChannel: async (id) => (isMined(store, id) ? { ...open, status: 2 } : readChannel(id)),
    sendClose: async (id, ...rest) => {
      const tx = await sendClose(id, ...rest);
      mine(store, id);
      return tx;
    },
  });
const notSent = () => Object.assign(new Error("x"), { closeNotSent: true });

/** A call whose upstream answers when told to. */
async function pending(gate, v) {
  let finish;
  let begun;
  const started = new Promise((r) => (begun = r));
  const res = useVoucher(gate, v, () => new Promise((r) => ((finish = r), begun())));
  await started;
  return async (status) => (finish(status), (await res).status);
}
async function settleWith(store) {
  const sent = [];
  await close(store, async (id, amount, signature) => (sent.push([amount, signature]), "0xtx"));
  return sent;
}

test("overlapping calls: in every order of ends, the close pays exactly the served calls with a voucher the buyer signed for it", async () => {
  for (const order of [[0, 1], [1, 0]]) {
    for (const ends of [[200, 200], [500, 200], [200, 500], [500, 500]]) {
      const store = createMemoryStore();
      const gates = [channelGate(store), channelGate(store)];
      const vs = [await voucher(10000), await voucher(20000)];
      const calls = [await pending(gates[0], vs[0]), await pending(gates[1], vs[1])];
      for (const i of order) assert.equal(await calls[i](ends[i]), ends[i]);
      const served = ends.filter((e) => e === 200).length;
      const label = JSON.stringify({ order, ends });
      assert.equal((await store.get(KEY)).cumulativeAmount, String(served * 10000), label);
      assert.deepEqual(await settleWith(store), served ? [[BigInt(served) * 10000n, sigOf(vs[served - 1])]] : [], label);
    }
  }
});

test("the unused part is usable, exactly once, and the buyer who raises by the price is then charged exactly", async () => {
  const store = createMemoryStore();
  const gates = [channelGate(store), channelGate(store)];
  const [v1, v2, v3] = [await voucher(10000), await voucher(20000), await voucher(30000)];
  const a = await pending(gates[0], v1);
  const b = await pending(gates[1], v2);
  await a(500);
  await b(200); // used 10000, signed 20000
  const replies = await Promise.all(Array.from({ length: 8 }, (_, i) => useVoucher(gates[i % 2], v2)));
  assert.equal(replies.filter((r) => r.status === 200).length, 1);
  assert.equal((await useVoucher(gates[0], v1)).status, 402);
  assert.equal((await useVoucher(gates[0], v3)).status, 200);
  assert.deepEqual(await settleWith(store), [[30000n, sigOf(v3)]]);
});

test("random overlaps: never unpaid, never above the served calls, whatever fails", async () => {
  let seed = 7;
  const rand = (n) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
  const vs = await Promise.all(Array.from({ length: 12 }, (_, i) => voucher((i + 1) * 10000)));
  for (let round = 0; round < 40; round++) {
    const store = createMemoryStore();
    const gate = channelGate(store);
    let served = 0;
    let next = 0;
    let flight = [];
    while (next < vs.length || flight.length) {
      if (next < vs.length && (flight.length === 0 || rand(2))) flight.push(await pending(gate, vs[next++]));
      else {
        const [call] = flight.splice(rand(flight.length), 1);
        const status = rand(3) ? 200 : 500;
        if ((await call(status)) === 200) served++;
      }
    }
    const rec = await store.get(KEY);
    assert.equal(rec.cumulativeAmount, String(served * 10000));
    assert.equal(rec.signature, served ? sigOf(vs[served - 1]) : null);
  }
});

test("two gates, random overlaps and failures, closing in the middle: counts, uses given back and the settlement agree", async () => {
  let seed = 11;
  const rand = (n) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
  const vs = await Promise.all(Array.from({ length: 12 }, (_, i) => voucher((i + 1) * 10000)));
  let failedWhileClosing = 0;
  for (let round = 0; round < 40; round++) {
    const store = createMemoryStore();
    const gates = [channelGate(store), channelGate(store)];
    const closeAt = 2 + rand(8);
    let flight = [];
    let served = 0;
    let failed = 0;
    let closing = null;
    let sent;
    const used = async () => BigInt((await store.get(KEY)).used);
    const end = async () => {
      const [call] = flight.splice(rand(flight.length), 1);
      const status = rand(3) ? 200 : 500;
      assert.equal(await call(status), status);
      if (status === 200) served++;
      else {
        failed++;
        if (closing) failedWhileClosing++;
      }
      const inFlight = flight.length;
      assert.equal(await used(), BigInt(served + inFlight) * 10000n, `round ${round}`);
    };
    for (let next = 0; next < closeAt; ) {
      if (flight.length === 0 || rand(2)) flight.push(await pending(gates[rand(2)], vs[next++]));
      else await end();
    }
    closing = closeChannels({
      store, chainId: 43113, channelContract: A("c"), seller: A("3"), drainMs: 10_000, challengeSeconds: 86_400,
      readChannel: async (id) => ({ ...open, status: isMined(store, id) ? 2 : 1 }), sendClose: async (id, amount) => ((sent = amount), mine(store, id), "0xtx"),
    });
    if (flight.length) {
      while (!(await store.get(KEY)).closing) await new Promise((r) => setTimeout(r, 1));
      for (const gate of gates) assert.equal((await useVoucher(gate, vs[closeAt])).status, 402); // nothing is taken in that the close does not pay
    }
    while (flight.length) await end();
    const result = await closing;
    assert.deepEqual(result.drainTimedOut, []);
    assert.equal(sent, served === 0 ? undefined : BigInt(served) * 10000n); // exactly the served calls, also when calls failed after the claim
    assert.ok(served + failed === closeAt);
    if (served === 0) {
      assert.deepEqual(result.skipped.map((r) => r.reason), ["no_voucher"]);
      continue;
    }
    assert.deepEqual(result.closed, [CHANNEL_ID]);
    assert.equal((await useVoucher(gates[0], vs[11])).status, 402); // closed
  }
  assert.ok(failedWhileClosing > 0); // the case is exercised
});

test("a buyer that raises by more than the price: served calls are paid, the rest stays usable", async () => {
  const store = createMemoryStore();
  const gate = channelGate(store);
  const v = await voucher(35000);
  const rs = [];
  for (let i = 0; i < 5; i++) rs.push((await useVoucher(gate, v)).status);
  assert.deepEqual(rs, [200, 200, 200, 402, 402]); // 35000 covers three calls at 10000
  assert.deepEqual(await settleWith(store), [[35000n, sigOf(v)]]);
});

test("more failed calls than vouchers kept: never below the served calls, and the highest voucher is kept", async () => {
  const store = createMemoryStore();
  const gate = channelGate(store);
  const vs = await Promise.all(Array.from({ length: 80 }, (_, i) => voucher((i + 1) * 10000)));
  const calls = [];
  for (const v of vs) calls.push(await pending(gate, v));
  for (const [i, call] of calls.entries()) await call(i % 2 ? 200 : 500);
  const rec = await store.get(KEY);
  assert.equal(rec.used, "400000");
  assert.ok(BigInt(rec.cumulativeAmount) >= 400000n);
  assert.equal(rec.held.at(-1)[0], "800000");
  assert.ok(rec.held.length <= 64 + 4);
});

test("a record written by 0.2.0 keeps its voucher and goes on from it", async () => {
  const old = await voucher(20000);
  const store = createMemoryStore({ [LEGACY]: { cumulativeAmount: "20000", signature: sigOf(old), deposit: "1000000" }, channels: [CHANNEL_ID] });
  const gate = channelGate(store);
  assert.equal((await useVoucher(gate, old)).status, 402);
  assert.equal((await useVoucher(gate, await voucher(30000), 500)).status, 500);
  assert.deepEqual(await settleWith(store), [[20000n, sigOf(old)]]);
});

test("close: nothing sent -> released, the channel goes on and the next run closes with the newest voucher", async () => {
  const store = createMemoryStore();
  const gate = channelGate(store);
  await useVoucher(gate, await voucher(10000));
  const before = await store.get(KEY);
  const out = await close(store, async () => {
    throw notSent();
  });
  assert.deepEqual(out.failed, [{ channelId: CHANNEL_ID, reason: "close_failed" }]);
  assert.deepEqual(await store.get(KEY), before);
  const v2 = await voucher(20000);
  assert.equal((await useVoucher(gate, v2)).status, 200);
  assert.deepEqual(await settleWith(store), [[20000n, sigOf(v2)]]);
});

test("close: outcome unknown -> vouchers stay refused; the next run finishes with the same voucher", async () => {
  const store = createMemoryStore();
  const gate = channelGate(store);
  const v1 = await voucher(10000);
  await useVoucher(gate, v1);
  const out = await close(store, async () => {
    throw new Error("timeout waiting for the receipt");
  });
  assert.deepEqual(out.failed, [{ channelId: CHANNEL_ID, reason: "close_unconfirmed" }]);
  const refused = await useVoucher(gate, await voucher(20000));
  assert.equal((await refused.json()).error, "channel_closing");
  // a second run that cannot send either must not reopen it: the first transaction may still be mined
  await close(store, async () => {
    throw notSent();
  });
  assert.equal((await useVoucher(gate, await voucher(20000))).status, 402);
  assert.deepEqual(await settleWith(store), [[10000n, sigOf(v1)]]);
  assert.equal((await store.get(KEY)).closed, true);
});

test("close: the chain decides after an error, also when the store or the run died", async () => {
  // the transaction went through although the sender saw an error
  let store = createMemoryStore();
  await useVoucher(channelGate(store), await voucher(10000));
  let status = 1;
  let out = await close(
    store,
    async () => {
      status = 2;
      throw new Error("connection lost");
    },
    async () => ({ ...open, status }),
  );
  assert.deepEqual([out.closed, (await store.get(KEY)).closed], [[CHANNEL_ID], true]);

  // the process died after sending: the record is still claimed, the chain says closed
  store = createMemoryStore();
  await useVoucher(channelGate(store), await voucher(10000));
  await store.set(KEY, { ...(await store.get(KEY)), closing: { at: Date.now(), id: "dead" } });
  out = await close(store, async () => assert.fail("must not send"), async () => ({ ...open, status: 2 }));
  assert.equal((await store.get(KEY)).closed, true);

  // the store failed after the transaction was mined: reported as closed, marked by the next run
  const inner = createMemoryStore();
  await useVoucher(channelGate(inner), await voucher(10000));
  let down = false;
  const flaky = { ...inner, compareAndSet: async (...a) => (down ? Promise.reject(new Error("down")) : inner.compareAndSet(...a)) };
  out = await close(flaky, async () => ((down = true), "0xtx"));
  assert.deepEqual([out.closed, out.failed], [[CHANNEL_ID], []]);
  assert.equal((await useVoucher(channelGate(inner), await voucher(20000))).status, 402);
  down = false;
  await close(flaky, async () => assert.fail("must not send"), async () => ({ ...open, status: 2 }));
  assert.equal((await inner.get(KEY)).closed, true);
});

test("close: a claim of a process that died stops blocking after an hour, with the highest voucher intact", async () => {
  const store = createMemoryStore();
  const gate = channelGate(store);
  await useVoucher(gate, await voucher(10000));
  const rec = await store.get(KEY);
  const v2 = await voucher(20000);
  await store.set(KEY, { ...rec, closing: { v: 2, phase: "claimed", at: Date.now() - HOUR + 5000, id: "dead" } });
  assert.equal((await useVoucher(gate, v2)).status, 402);
  await store.set(KEY, { ...rec, closing: { v: 2, phase: "claimed", at: Date.now() - HOUR, id: "dead" } });
  assert.equal((await useVoucher(gate, v2)).status, 200);
  assert.deepEqual(await settleWith(store), [[20000n, sigOf(v2)]]);
});

test("close: a run whose claim was taken over does not release the other run's claim", async () => {
  const store = createMemoryStore();
  const gate = channelGate(store);
  await useVoucher(gate, await voucher(10000));
  await close(store, async () => {
    // a second run starts and its transaction is left unconfirmed
    await close(store, async () => {
      throw new Error("timeout");
    });
    throw notSent();
  });
  assert.equal((await useVoucher(gate, await voucher(20000))).status, 402);
});

test("close: the voucher is the one stored when the claim was made, and a failing call keeps the claim", async () => {
  const store = createMemoryStore();
  const gate = channelGate(store);
  await useVoucher(gate, await voucher(10000));
  const v2 = await voucher(20000);
  let reads = 0;
  const sent = [];
  await close(
    store,
    async (id, amount) => (sent.push(amount), "0xtx"),
    async () => (reads++ === 0 && assert.equal((await useVoucher(gate, v2)).status, 200), open),
  );
  assert.deepEqual(sent, [20000n]);

  const other = createMemoryStore();
  const g = channelGate(other);
  const call = await pending(g, await voucher(10000));
  await close(other, async () => {
    assert.equal(await call(500), 500);
    assert.equal((await useVoucher(g, v2)).status, 402); // still claimed
    return "0xtx";
  });
  assert.equal((await other.get(KEY)).closed, true);
});

const breaking = () =>
  new Response(
    new ReadableStream({
      pull(c) {
        if (this.sent) c.error(new Error("upstream broke off"));
        else {
          this.sent = true;
          c.enqueue(new TextEncoder().encode("partial"));
        }
      },
    }),
  );
const call = (gate, headers, upstream) => gate(new Request("https://api.example/echo", { headers }), upstream);

test("upstream body breaks off: 502, nothing delivered, the use is given back (voucher, monthly, per call)", async () => {
  const store = createMemoryStore();
  const gate = channelGate(store);
  const v = await voucher(10000);
  let res = await call(gate, { "hub-channel-voucher": v }, async () => breaking());
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "upstream_failed" });
  assert.equal(res.headers.get("hub-channel-receipt"), null);
  assert.equal((await store.get(KEY)).cumulativeAmount, "0");
  assert.equal((await useVoucher(gate, v)).status, 200);

  const monthly = createMemoryStore();
  const token = await quotaToken(5);
  res = await call(monthlyGate(monthly, 5), { "hub-subscription": token }, async () => breaking());
  assert.equal(res.status, 502);
  assert.deepEqual(await monthly.get(quotaKey(token)), { count: 0 });

  const paths = [];
  const exact = monthlyGate(createMemoryStore(), 5, {
    fetch: async (url) => (paths.push(new URL(url).pathname), new Response(JSON.stringify({ isValid: true, success: true }))),
  });
  const pay = { payload: { authorization: { from: A("4"), nonce: `0x${"1".repeat(64)}` } } };
  res = await call(exact, { "payment-signature": Buffer.from(JSON.stringify(pay)).toString("base64") }, async () => breaking());
  assert.equal(res.status, 502);
  assert.deepEqual(paths, ["/verify"]); // not settled
});

test("a 204 reply is served and counted once", async () => {
  const store = createMemoryStore();
  const res = await call(channelGate(store), { "hub-channel-voucher": await voucher(10000) }, async () => new Response(null, { status: 204 }));
  assert.equal(res.status, 204);
  assert.equal((await store.get(KEY)).cumulativeAmount, "10000");
  const token = (await purchase(monthlyGate(createMemoryStore(), 5))).headers.get("hub-subscription");
  assert.ok(token);
  assert.equal((await useToken(monthlyGate(createMemoryStore(), 5), token)).status, 200);
});

test("out of order under many running calls: the close is exact", async () => {
  const store = createMemoryStore();
  const gate = channelGate(store);
  const vs = await Promise.all(Array.from({ length: 40 }, (_, i) => voucher((i + 1) * 10000)));
  const calls = [];
  for (let i = 1; i < 40; i += 2) calls.push(await pending(gate, vs[i])); // every second one, 20 running
  for (let i = 0; i < 40; i += 2) await useVoucher(gate, vs[i], 402); // the others come late and are not served
  for (const [i, call] of calls.entries()) await call(i % 3 ? 200 : 500);
  const rec = await store.get(KEY);
  assert.equal(rec.cumulativeAmount, rec.used);
});
