// The closing Worker example, with a faked chain and the seller Worker's admin route in this process.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createStoreAdmin, createRemoteStore } from "../src/admin-store.mjs";
import { createMemoryStore } from "../src/store.mjs";
import { runCloser, settings } from "../examples/worker-closer/closer.mjs";
import worker from "../examples/worker-closer/worker.mjs";
import { A, BUYER, channelGate, useVoucher, voucher } from "./fixtures/gates.mjs";

const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // a public test key
const SECRET = "test-store-secret-0123456789-0123456789";
const ENV = { NETWORK: "eip155:43113", RPC_URL: "https://rpc.example", CHANNEL_CONTRACT: A("c"), STORE_URL: "https://seller.example/__seller-store", STORE_SECRET: SECRET, SELLER_PRIVATE_KEY: KEY, MIN_AMOUNT: "30000" };
const SELLER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ids = [1, 2, 3, 4].map((n) => `0x${String(n).repeat(64)}`);
const NOW = 2_000_000;

/** The seller's Worker (its store behind the admin route) with vouchers, and a chain on which the closes land. */
async function world({ requested = {}, amounts = { [ids[0]]: 1, [ids[1]]: 3, [ids[2]]: 1, [ids[3]]: 5 } } = {}) {
  const inner = createMemoryStore();
  const gate = channelGate(inner, { seller: SELLER, prepaid: { readChannel: async () => ({ buyer: BUYER, seller: SELLER, token: "0x5425890298aed601595a70AB815c96711a31Bc65", deposit: 1_000_000n, closeRequestedAt: 0n, status: 1 }) } });
  for (const [id, n] of Object.entries(amounts)) for (let i = 1; i <= n; i++) assert.equal((await useVoucher(gate, await voucher(i * 10000, id))).status, 200);
  const admin = createStoreAdmin({ store: inner, secret: SECRET });
  const w = { inner, sent: [], status: {}, nonce: 0, requests: 0 };
  w.fetch = async (url, init) => (w.requests++, (await admin(new Request(url, init))) ?? new Response("?", { status: 404 }));
  w.store = createRemoteStore(ENV.STORE_URL, SECRET, { fetch: w.fetch });
  const st = (id) => w.status[id] ?? 1;
  w.chain = {
    challengeSeconds: async () => 86_400,
    chainTime: async () => NOW,
    readChannel: async (id) => ({ buyer: BUYER, seller: SELLER, status: st(id), deposit: 1_000_000n, closeRequestedAt: BigInt(requested[id] ?? 0) }),
    settledChannel: async (id) => ({ status: st(id) }),
    snapshot: async (id) => ({ status: st(id), nonce: w.nonce }),
    sendClose: async (id, amount, signature, { replace, record }) => {
      if (w.die?.(id, "before")) throw new Error("cut off before the record");
      await record({ hash: `0x${id.slice(2, 6)}`, nonce: replace?.nonce ?? w.nonce, from: SELLER.toLowerCase() });
      if (w.die?.(id, "after")) throw Object.assign(new Error("cut off after the record"), { cutAfterRecord: true });
      w.sent.push([id, amount]);
      w.status[id] = 2;
      w.nonce++;
      return `0x${id.slice(2, 6)}`;
    },
  };
  w.run = (env = {}) => runCloser({ ...ENV, ...env }, { chain: w.chain, fetch: w.fetch });
  return w;
}

test("closes what was asked for, the most urgent first, and what reached the minimum; nothing else", async () => {
  const w = await world({ requested: { [ids[2]]: NOW - 100, [ids[0]]: NOW - 5000 } });
  const out = await w.run({ MAX_SUBREQUESTS: "1000" });
  assert.equal(w.sent.length, 4);
  assert.deepEqual(w.sent.slice(0, 2).map(([id]) => id), [ids[0], ids[2]]); // asked for, the older request first
  assert.deepEqual(new Set(w.sent.slice(2).map(([id]) => id)), new Set([ids[1], ids[3]])); // 30000 and 50000 reached the minimum
  assert.deepEqual(w.sent.find(([id]) => id === ids[3])[1], 50000n);
  assert.equal(out.skipped.length, 0);
  const again = await w.run({ MAX_SUBREQUESTS: "1000" });
  assert.equal(again.closed.length, 0);

  const small = await world();
  const r = await small.run({ MAX_SUBREQUESTS: "1000" });
  assert.deepEqual(new Set(small.sent.map(([id]) => id)), new Set([ids[1], ids[3]]));
  assert.deepEqual(r.skipped.map((x) => x.reason), ["close_not_requested", "close_not_requested"]);
});

test("a run within its budget leaves the rest to the next one; a run cut off anywhere is finished by the next", async () => {
  const w = await world({ requested: { [ids[0]]: NOW - 10, [ids[1]]: NOW - 20, [ids[2]]: NOW - 30, [ids[3]]: NOW - 40 } });
  let runs = 0;
  while (w.sent.length < 4) {
    const before = w.requests;
    const out = await w.run({ MAX_SUBREQUESTS: "46", WAIT_SECONDS: "5" });
    assert.ok(w.requests - before <= 45, String(w.requests - before));
    assert.ok(out.closed.length >= 1);
    assert.ok(++runs < 6);
  }
  assert.ok(runs > 1);

  for (const when of ["before", "after"]) {
    const v = await world({ requested: { [ids[0]]: NOW - 10 } });
    v.die = (id, at) => id === ids[0] && at === when;
    const cut = await v.run({ MAX_SUBREQUESTS: "1000" });
    assert.equal(cut.closed.length, 2); // the other two reached the minimum
    const held = await v.inner.get(`channel:43113:${A("c").toLowerCase()}:${ids[0]}`);
    assert.ok(held.closing, when);
    if (when === "after") {
      v.nonce++; // the transaction got through although the Worker died
      v.status[ids[0]] = 2;
    }
    v.die = null;
    const next = await v.run({ MAX_SUBREQUESTS: "1000" });
    assert.equal((await v.inner.get(`channel:43113:${A("c").toLowerCase()}:${ids[0]}`)).closed, true, when);
    assert.equal(v.sent.filter(([id]) => id === ids[0]).length, when === "after" ? 0 : 1);
    void next;
  }
});

test("settings are checked, testnet only, and no message or result carries a secret", async () => {
  for (const [k, v] of [["NETWORK", "eip155:43114"], ["NETWORK", "eip155:1"], ["NETWORK", "eip155:31337"], ["RPC_URL", "http://rpc.example"], ["RPC_URL", ""], ["CHANNEL_CONTRACT", "0x1"], ["STORE_URL", "https://seller.example/other"], ["STORE_URL", "http://seller.example/__seller-store"], ["STORE_SECRET", "short"], ["SELLER_PRIVATE_KEY", "0x12"], ["WAIT_SECONDS", "999"], ["MIN_AMOUNT", "-1"], ["MAX_SUBREQUESTS", "x"]]) {
    let message = "";
    try {
      settings({ ...ENV, [k]: v });
    } catch (e) {
      message = e.message;
    }
    assert.match(message, new RegExp(k), `${k}=${v}`);
    for (const secret of [KEY, SECRET, KEY.slice(2, 20)]) assert.equal(message.includes(secret), false);
  }
  assert.doesNotThrow(() => settings({ ...ENV, NETWORK: "eip155:84532" }));
  const w = await world({ requested: { [ids[0]]: NOW - 10 } });
  const printed = [];
  const log = console.log;
  console.log = (...a) => printed.push(a.join(" "));
  let done;
  try {
    await worker.scheduled({}, { ...ENV, MAX_SUBREQUESTS: "1000" }, { waitUntil: (p) => (done = p) });
    await done; // no deps: a real RPC is asked and fails; the message names no secret
    await worker.scheduled({}, { ...ENV, SELLER_PRIVATE_KEY: `${KEY}0` }, { waitUntil: (p) => (done = p) });
    await done;
  } finally {
    console.log = log;
  }
  const out = JSON.stringify(await w.run({ MAX_SUBREQUESTS: "1000" })) + printed.join("\n");
  for (const secret of [KEY, KEY.slice(2), SECRET]) assert.equal(out.includes(secret), false);
  assert.equal((await worker.fetch(new Request("https://closer.example/"))).status, 404);
});

test("a bound seller Worker is reached through the binding, not the public address", async () => {
  const { runCloser } = await import("../examples/worker-closer/closer.mjs");
  const asked = [];
  const env = {
    NETWORK: "eip155:43113", RPC_URL: "https://rpc.example", CHANNEL_CONTRACT: "0x" + "c".repeat(40), STORE_URL: "https://seller.example/__seller-store",
    STORE_SECRET: "s".repeat(32), SELLER_PRIVATE_KEY: "0x" + "1".repeat(64),
    SELLER_WORKER: { fetch: async (input) => (asked.push(String(input?.url ?? input)), Response.json({ value: [] })) },
  };
  const chain = { challengeSeconds: async () => 86400, chainTime: async () => 0, readChannel: async () => { throw new Error("none"); }, settledChannel: async () => ({ status: 1 }), snapshot: async () => ({ status: 1, nonce: 0 }), sendClose: async () => { throw new Error("none"); } };
  const r = await runCloser(env, { chain, fetch: async () => { throw new Error("public address must not be used"); } });
  assert.ok(asked.length > 0 && asked.every((u) => u.startsWith("https://seller.example/__seller-store")));
  assert.equal(r.closed.length, 0);
});
