// Several gate instances on one store: one voucher is served once, a quota is never exceeded.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { closeChannels } from "../src/close.mjs";
import { createFileStore, createMemoryStore } from "../src/store.mjs";
import { A, CHANNEL_ID, channelGate, monthlyGate, purchase, quotaKey, quotaToken, useToken, useVoucher, voucher } from "./fixtures/gates.mjs";

const CHILD = fileURLToPath(new URL("./fixtures/race-child.mjs", import.meta.url));
const tmpPath = () => join(mkdtempSync(join(tmpdir(), "seller-kit-race-")), "s.json");
const served = (rs) => rs.filter((r) => r.status === 200).length;
const pause = () => new Promise((r) => setTimeout(r, 2 + Math.random() * 12));

/** A shared store across a network: every operation takes time, compareAndSet is one step at the far end. */
function slowStore(inner = createMemoryStore()) {
  const slow = (fn) => async (...args) => {
    await pause();
    const r = await fn(...args);
    await pause();
    return r;
  };
  return { inner, get: slow(inner.get), set: slow(inner.set), ...(inner.compareAndSet ? { compareAndSet: slow(inner.compareAndSet) } : {}) };
}

/** Starts `count` processes, releases them together once all are ready, and returns their reports. */
async function race(count, config) {
  const children = Array.from({ length: count }, () => spawn(process.execPath, [CHILD, JSON.stringify(config)], { stdio: ["pipe", "pipe", "inherit"] }));
  const lines = children.map((child) => {
    let buffer = "";
    const queue = [];
    const waiting = [];
    child.stdout.on("data", (d) => {
      buffer += d;
      for (let i; (i = buffer.indexOf("\n")) >= 0; buffer = buffer.slice(i + 1)) {
        const line = buffer.slice(0, i);
        waiting.length ? waiting.shift()(line) : queue.push(line);
      }
    });
    // a process that dies must fail the test, not hang it
    child.on("close", () => { for (const w of waiting.splice(0)) w(JSON.stringify({ served: -1000, errors: ["process died"] })); });
    return () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiting.push(r)));
  });
  for (const next of lines) assert.equal(await next(), "ready");
  for (const child of children) child.stdin.end("go\n");
  return Promise.all(lines.map(async (next) => JSON.parse(await next())));
}
const total = (reports) => reports.reduce((sum, r) => sum + r.served, 0);

test("memory store, two gates: one voucher is served once", async () => {
  const store = slowStore();
  const gates = [channelGate(store), channelGate(store)];
  const v = await voucher(10000);
  const rs = await Promise.all(Array.from({ length: 16 }, (_, i) => useVoucher(gates[i % 2], v)));
  assert.equal(served(rs), 1);
  assert.equal((await store.inner.get(`channel:43113:${A("c")}:${CHANNEL_ID}`)).cumulativeAmount, "10000");
});

test("memory store, two gates: the monthly quota holds, and the count is exact", async () => {
  const store = slowStore();
  const gates = [monthlyGate(store, 5), monthlyGate(store, 5)];
  const token = await quotaToken(5);
  const rs = await Promise.all(Array.from({ length: 24 }, (_, i) => useToken(gates[i % 2], token)));
  assert.equal(served(rs), 5);
  assert.deepEqual(await store.inner.get(quotaKey(token)), { count: 5 });
});

test("memory store, two gates: failed calls give back exactly their own uses", async () => {
  const store = slowStore();
  const gates = [monthlyGate(store, 100), monthlyGate(store, 100)];
  const token = await quotaToken(100);
  const rs = await Promise.all(Array.from({ length: 16 }, (_, i) => useToken(gates[i % 2], token, i % 4 === 0 ? 500 : 200)));
  assert.equal(served(rs), 12);
  assert.deepEqual(await store.inner.get(quotaKey(token)), { count: 12 });
});

test("memory store, two gates: the channel index keeps every channel", async () => {
  const store = slowStore();
  const gates = [channelGate(store), channelGate(store)];
  const ids = Array.from({ length: 10 }, (_, i) => `0x${String(i).repeat(64)}`);
  const rs = await Promise.all(ids.map(async (id, i) => useVoucher(gates[i % 2], await voucher(10000, id))));
  assert.equal(served(rs), 10);
  assert.deepEqual([...(await store.inner.get(`channels:43113:${A("c")}`))].sort(), ids);
});

test("two gates: a rollback never lowers a value the other gate raised", async () => {
  const inner = createMemoryStore();
  let afterRead = null; // runs between the read and the write of the next operation
  const store = {
    ...inner,
    async get(key) {
      const value = await inner.get(key);
      const hook = afterRead;
      afterRead = null;
      if (hook) await hook();
      return value;
    },
  };
  const [one, two] = [channelGate(store), channelGate(inner)];
  const higher = await voucher(20000);
  let raised;
  const res = await useVoucher(one, await voucher(10000), () => {
    afterRead = async () => {
      raised = (await useVoucher(two, higher)).status;
    };
    return 500;
  });
  assert.equal(res.status, 500);
  assert.equal(raised, 200);
  // one call was served: the other gate's. Its use stays counted, its voucher stays held, and only the failed call was given back.
  const rec = await inner.get(`channel:43113:${A("c")}:${CHANNEL_ID}`);
  assert.equal(rec.used, "10000");
  assert.deepEqual(rec.held.map((h) => h[0]), ["10000", "20000"]);
});

test("a rollback that finds the store unavailable keeps the upstream reply and the count", async () => {
  const inner = createMemoryStore();
  let down = false;
  const guard = (fn) => async (...args) => {
    if (down) throw new Error("down");
    return fn(...args);
  };
  const store = { get: guard(inner.get), set: guard(inner.set), compareAndSet: guard(inner.compareAndSet) };
  const token = await quotaToken(5);
  const res = await useToken(monthlyGate(store, 5), token, () => ((down = true), 500));
  assert.equal(res.status, 500);
  assert.deepEqual(await inner.get(quotaKey(token)), { count: 1 });
});

test("two purchases in one second get separate tokens and counters; a used counter is never reset", async () => {
  const store = slowStore();
  const gates = [monthlyGate(store, 2), monthlyGate(store, 2)];
  const tokens = (await Promise.all([purchase(gates[0]), purchase(gates[1])])).map((r) => r.headers.get("hub-subscription"));
  assert.ok(tokens[0] && tokens[1]);
  assert.notEqual(tokens[0], tokens[1]);
  for (const t of tokens) {
    assert.equal((await useToken(gates[0], t)).status, 200);
    assert.equal((await useToken(gates[1], t)).status, 402);
  }
  const third = (await purchase(gates[0])).headers.get("hub-subscription"); // same second again
  assert.equal(tokens.includes(third), false);
  for (const t of tokens) assert.equal((await useToken(gates[0], t)).status, 402);
});

test("malformed stored values fail closed", async () => {
  const token = await quotaToken(5);
  assert.equal((await useToken(monthlyGate(createMemoryStore({ [quotaKey(token)]: { count: "x" } }), 5), token)).status, 502);
  const bad = createMemoryStore({ [`channel:43113:${A("c")}:${CHANNEL_ID}`]: { cumulativeAmount: "oops" } });
  assert.equal((await useVoucher(channelGate(bad), await voucher(10000))).status, 502);
});

test("a store without compareAndSet is refused for prepaid and metered monthly, unless singleInstance: true", async () => {
  const legacy = () => {
    const { get, set } = createMemoryStore();
    return { get, set };
  };
  assert.throws(() => channelGate(legacy()), /compareAndSet/);
  assert.throws(() => monthlyGate(legacy(), 5), /compareAndSet/);
  assert.throws(() => channelGate(legacy(), { singleInstance: "yes" }), /compareAndSet/);
  assert.doesNotThrow(() => monthlyGate(legacy(), null)); // unlimited: nothing depends on the count
  const store = legacy();
  const gate = channelGate(store, { singleInstance: true });
  const v = await voucher(10000);
  assert.equal(served(await Promise.all(Array.from({ length: 8 }, () => useVoucher(gate, v)))), 1);
  const token = await quotaToken(3);
  const monthly = monthlyGate(store, 3, { singleInstance: true });
  assert.equal(served(await Promise.all(Array.from({ length: 8 }, () => useToken(monthly, token)))), 3);
});

test("a store that always reports a conflict ends in 502, never in a served call", async () => {
  const inner = createMemoryStore();
  const gate = monthlyGate({ ...inner, compareAndSet: async () => false }, 5);
  const realNow = Date.now;
  let t = realNow();
  Date.now = () => (t += 500);
  try {
    assert.equal((await useToken(gate, await quotaToken(5))).status, 502);
  } finally {
    Date.now = realNow;
  }
});

test("close refuses vouchers while its transaction is in flight, keeps the stored one, and a closed channel takes no more calls", async () => {
  const store = createMemoryStore();
  const gate = channelGate(store);
  await useVoucher(gate, await voucher(10000));
  const v2 = await voucher(20000);
  const out = await closeChannels({
    store,
    chainId: 43113,
    channelContract: A("c"),
    seller: A("3"),
    readChannel: async () => ({ seller: A("3"), status: 1, deposit: 1_000_000n }),
    sendClose: async () => {
      const res = await useVoucher(gate, v2);
      assert.equal(res.status, 402);
      assert.equal((await res.json()).error, "channel_closing");
      return "0xtx";
    },
  });
  assert.deepEqual(out.closed, [CHANNEL_ID]);
  const rec = await store.get(`channel:43113:${A("c")}:${CHANNEL_ID}`);
  assert.equal(rec.cumulativeAmount, "10000");
  assert.equal(rec.closed, true);
  assert.equal((await useVoucher(gate, v2)).status, 402);
});

test("file store, separate processes: one voucher is served once and every channel is indexed", async () => {
  const path = tmpPath();
  const own = Array.from({ length: 4 }, (_, i) => `0x${String(i + 1).repeat(64)}`);
  const config = { mode: "voucher", path, calls: 6, vouchers: [await voucher(10000)], own: await Promise.all(own.map((id) => voucher(10000, id))) };
  const reports = await race(4, config);
  assert.equal(total(reports), 1);
  assert.deepEqual(reports.flatMap((r) => r.errors), []);
  const data = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(data[`channel:43113:${A("c")}:${CHANNEL_ID}`].cumulativeAmount, "10000");
  assert.deepEqual([...data[`channels:43113:${A("c")}`]].sort(), [...own, CHANNEL_ID].sort());
  assert.equal(existsSync(`${path}.lock`), false);
  assert.equal(readdirSync(join(path, "..")).length, 1); // no temp or lock file is left
});

test("file store, separate processes: the monthly quota holds and the count is exact", async () => {
  const path = tmpPath();
  const token = await quotaToken(7);
  const reports = await race(4, { mode: "quota", path, calls: 6, quota: 7, token });
  assert.equal(total(reports), 7);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8"))[quotaKey(token)], { count: 7 });
});

test("file store, separate processes: plain set from many processes loses nothing", async () => {
  const path = tmpPath();
  assert.deepEqual((await race(4, { mode: "set", path, calls: 10 })).flatMap((r) => r.errors), []);
  assert.equal(Object.keys(JSON.parse(readFileSync(path, "utf8"))).length, 40);
});

test("file store: compareAndSet writes only on a match", async () => {
  const s = createFileStore(tmpPath());
  assert.equal(await s.compareAndSet("a", { n: 1 }, { n: 2 }), false);
  assert.equal(await s.compareAndSet("a", null, { n: 1, m: [1] }), true);
  assert.equal(await s.compareAndSet("a", null, { n: 9 }), false);
  assert.equal(await s.compareAndSet("a", { m: [1], n: 1 }, { n: 2 }), true); // key order does not matter
  assert.deepEqual(await s.get("a"), { n: 2 });
});

test("file store: a held lock times out without writing, and the gate answers 502", async () => {
  const path = tmpPath();
  const lock = JSON.stringify({ pid: process.ppid, host: hostname(), at: 1, token: "other" }); // old, but its process still runs
  writeFileSync(`${path}.lock`, lock);
  const s = createFileStore(path, { lockTimeoutMs: 200, staleMs: 50 });
  await assert.rejects(() => s.set("a", 1), /is held/);
  await assert.rejects(() => s.compareAndSet("a", null, 1), /is held/);
  assert.equal(existsSync(path), false);
  assert.equal(readFileSync(`${path}.lock`, "utf8"), lock);
  assert.equal((await useVoucher(channelGate(s), await voucher(10000))).status, 502);
});

test("file store: locks from another machine, unreadable locks and fresh locks are respected", async () => {
  const dead = await deadPid();
  for (const body of [JSON.stringify({ pid: dead, host: "another-machine", at: 1, token: "x" }), "", JSON.stringify({ pid: dead, host: hostname(), at: Date.now() + 5000, token: "x" })]) {
    const path = tmpPath();
    writeFileSync(`${path}.lock`, body);
    await assert.rejects(() => createFileStore(path, { lockTimeoutMs: 200, staleMs: 100 }).set("a", 1), /is held/);
    assert.equal(readFileSync(`${path}.lock`, "utf8"), body);
  }
});

test("file store: a lock left by a process that no longer runs is removed once, even with many waiting processes", async () => {
  const path = tmpPath();
  writeFileSync(`${path}.lock`, JSON.stringify({ pid: await deadPid(), host: hostname(), at: 1, token: "gone" }));
  const token = await quotaToken(7);
  const reports = await race(4, { mode: "quota", path, calls: 6, quota: 7, token });
  assert.equal(total(reports), 7);
  assert.equal(existsSync(`${path}.lock`), false);
  assert.equal(existsSync(`${path}.lock.steal`), false);
  // an earlier process that had our own pid
  writeFileSync(`${path}.lock`, JSON.stringify({ pid: process.pid, host: hostname(), at: 1, token: "gone" }));
  await createFileStore(path, { lockTimeoutMs: 500 }).set("a", 1);
});

async function deadPid() {
  const child = spawn(process.execPath, ["-e", "0"]);
  await new Promise((r) => child.on("exit", r));
  return child.pid;
}

