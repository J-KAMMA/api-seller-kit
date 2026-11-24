// The route a Worker offers to the close command.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ADMIN_PATH, createRemoteStore, createStoreAdmin } from "../src/admin-store.mjs";
import { closeChannels } from "../src/close.mjs";
import { createMemoryStore } from "../src/store.mjs";
import { A, BUYER, CHANNEL_ID, channelGate, useVoucher, voucher } from "./fixtures/gates.mjs";

const SECRET = "test-store-secret-0123456789-0123456789";
const URL_ = `https://worker.example${ADMIN_PATH}`;
const KEY = `channel:43113:${A("c")}:${CHANNEL_ID}`;
const post = (body, headers = {}, method = "POST", url = URL_) =>
  new Request(url, { method, headers: { "x-seller-admin": SECRET, ...headers }, ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) });
const untouchable = () => {
  const no = async () => assert.fail("the store must not be touched");
  return { get: no, set: no, compareAndSet: no };
};

test("off without a secret of 32 characters; every refusal is the same 404 before the store is touched", async () => {
  const get = { op: "get", key: KEY };
  for (const secret of [undefined, "", "x".repeat(31), 12345678901234567890123456789012, null]) {
    const res = await createStoreAdmin({ store: untouchable(), secret })(post(get, { "x-seller-admin": String(secret ?? "") }));
    assert.equal(res.status, 404);
  }
  const admin = createStoreAdmin({ store: untouchable(), secret: SECRET });
  const bodies = new Set();
  for (const request of [
    post(get, { "x-seller-admin": "" }),
    post(get, { "x-seller-admin": SECRET.slice(0, -1) }),
    post(get, { "x-seller-admin": `${SECRET}x` }),
    post(get, { "x-seller-admin": SECRET.toUpperCase() }),
    post(get, { origin: "https://evil.example" }),
    post(null, {}, "GET"),
    post(null, {}, "OPTIONS"),
  ]) {
    const res = await admin(request);
    assert.equal(res.status, 404);
    assert.equal([...res.headers.keys()].some((h) => h.startsWith("access-control")), false);
    bodies.add(await res.text());
  }
  assert.equal(bodies.size, 1);
  assert.equal(await admin(post(get, {}, "POST", "https://worker.example/echo")), null); // other paths go on to the API
});

test("only channel records, only get and compareAndSet, no oversized bodies", async () => {
  const admin = createStoreAdmin({ store: untouchable(), secret: SECRET });
  for (const body of [
    "{", "[]", "null", {}, { op: "get" }, { op: "get", key: "quota:abc" }, { op: "get", key: "__proto__" }, { op: "get", key: `${KEY}x` }, { op: "get", key: 1 },
    { op: "set", key: KEY, next: {} }, { op: "delete", key: KEY }, { op: "compareAndSet", key: KEY, expected: null }, { op: "compareAndSet", key: KEY, expected: null, next: null },
  ]) assert.equal((await admin(post(body))).status, 400, JSON.stringify(body));
  assert.equal((await admin(post(" ".repeat(1024 * 1024 + 1)))).status, 413);
  const broken = createStoreAdmin({ store: { get: async () => Promise.reject(new Error("secret detail")) }, secret: SECRET });
  const res = await broken(post({ op: "get", key: KEY }));
  assert.deepEqual([res.status, await res.json()], [502, { error: "store_unavailable" }]);
});

test("the remote store works like a local one, and closes a channel", async () => {
  const inner = createMemoryStore();
  const admin = createStoreAdmin({ store: inner, secret: SECRET });
  const fetch = async (url, init) => admin(new Request(url, init));
  const remote = createRemoteStore(URL_, SECRET, { fetch });
  assert.equal(await remote.get(KEY), null);
  const gate = channelGate(inner);
  await useVoucher(gate, await voucher(10000));
  assert.deepEqual(await remote.get(KEY), await inner.get(KEY));
  assert.equal(await remote.compareAndSet(KEY, { x: 1 }, { y: 1 }), false);
  let status = 1;
  const out = await closeChannels({
    store: remote, chainId: 43113, channelContract: A("c"), seller: A("3"),
    readChannel: async () => ({ buyer: BUYER, seller: A("3"), status, deposit: 1_000_000n }),
    sendClose: async (id, amount) => (assert.equal(amount, 10000n), (status = 2), "0xtx"),
  });
  assert.deepEqual(out.closed, [CHANNEL_ID]);
  assert.equal((await inner.get(KEY)).closed, true);
  assert.equal((await useVoucher(gate, await voucher(20000))).status, 402);
  await assert.rejects(createRemoteStore(URL_, `${SECRET}x`, { fetch }).get(KEY), /404/);
});

test("the secret goes to https or this machine only, and follows no redirect", async () => {
  assert.throws(() => createRemoteStore("http://worker.example/x", SECRET), /https/);
  assert.throws(() => createRemoteStore(URL_, "short"), /32/);
  assert.doesNotThrow(() => createRemoteStore("http://127.0.0.1:8787/x", SECRET));
  let init;
  const remote = createRemoteStore(URL_, SECRET, { fetch: async (u, i) => ((init = i), new Response(null, { status: 302, headers: { location: "https://evil.example" } })) });
  await assert.rejects(remote.get(KEY));
  assert.equal(init.redirect, "manual");
  assert.equal(String(URL_).includes(SECRET), false);
});

test("a long index can be changed: the old value travels as a digest, and the store still compares the value", async () => {
  const inner = createMemoryStore();
  const key = `channels:43113:${A("c")}`;
  const index = Array.from({ length: 5_000 }, (_, i) => `0x${i.toString(16).padStart(64, "0")}`);
  await inner.set(key, index);
  let sent = 0;
  let before = async () => {};
  const admin = createStoreAdmin({ store: { ...inner, compareAndSet: async (...a) => (await before(), inner.compareAndSet(...a)) }, secret: SECRET });
  const remote = createRemoteStore(URL_, SECRET, { fetch: async (u, init) => ((sent = Math.max(sent, init.body.length)), admin(new Request(u, init))) });
  assert.equal(await remote.compareAndSet(key, index, index.slice(1)), true);
  assert.ok(sent < JSON.stringify(index).length * 1.1);
  assert.equal(await remote.compareAndSet(key, index, []), false); // not what is stored any more
  before = () => inner.set(key, ["raced"]);
  assert.equal(await remote.compareAndSet(key, index.slice(1), []), false);
  assert.deepEqual(await inner.get(key), ["raced"]);
});
