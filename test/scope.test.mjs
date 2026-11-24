// One store, several contracts or chains: channel ids repeat, records must not mix. Records of 0.2.0 and older stay usable.
import assert from "node:assert/strict";
import { test } from "node:test";
import { closeChannels } from "../src/close.mjs";
import { createMemoryStore } from "../src/store.mjs";
import { A, BUYER, CHANNEL_ID, channelGate, useVoucher, voucher } from "./fixtures/gates.mjs";

const V1 = "0xd896c44acdfdff4d4dd1298b19c6a668c9e01c11";
const V2 = "0xa5e4707344b624a7217b7814da1b3611bf4b4559";
const sigOf = (v) => JSON.parse(Buffer.from(v, "base64").toString()).signature.toLowerCase();
const LEGACY = `channel:${CHANNEL_ID}`;
const at = (contract, chainId = 43113) => `channel:${chainId}:${contract}:${CHANNEL_ID}`;
const v = (amount, contract, chainId = 43113) => voucher(amount, CHANNEL_ID, { contract, chainId });
const closedOn = new WeakMap();
async function close(store, contract, extra = {}) {
  const sent = [];
  const done = closedOn.get(store) ?? closedOn.set(store, new Set()).get(store);
  const out = await closeChannels({
    store, chainId: 43113, channelContract: contract, seller: A("3"),
    readChannel: async () => ({ buyer: BUYER, seller: A("3"), status: done.has(contract) ? 2 : 1, deposit: 1_000_000n }),
    sendClose: async (id, amount, signature) => (sent.push([amount, signature]), done.add(contract), "0xtx"), ...extra,
  });
  return { ...out, sent };
}
/** A store as 0.2.0 left it. */
const legacyStore = async (amount, contract, extra = {}) => {
  const signature = sigOf(await v(amount, contract));
  return createMemoryStore({ [LEGACY]: { cumulativeAmount: String(amount), signature, deposit: "1000000", ...extra }, channels: [CHANNEL_ID] });
};
const code = async (res) => (res.status === 200 ? 200 : (await res.json()).error);

test("V1 and V2 with the same channel id on one store: separate amounts, closes and closed marks", async () => {
  const store = createMemoryStore();
  const [one, two] = [channelGate(store, { contract: V1 }), channelGate(store, { contract: V2 })];
  for (const n of [1, 2, 3]) assert.equal(await code(await useVoucher(one, await v(n * 10000, V1))), 200);
  assert.equal(await code(await useVoucher(two, await v(10000, V2))), 200); // starts at its own zero
  let r = await close(store, V1);
  assert.deepEqual(r.sent, [[30000n, sigOf(await v(30000, V1))]]);
  assert.equal(await code(await useVoucher(one, await v(40000, V1))), "channel_not_open");
  assert.equal(await code(await useVoucher(two, await v(20000, V2))), 200); // V1's closed mark does not reach V2
  r = await close(store, V2);
  assert.deepEqual(r.sent, [[20000n, sigOf(await v(20000, V2))]]);
});

test("the same contract address on two chains is kept apart", async () => {
  const store = createMemoryStore();
  const [fuji, base] = [channelGate(store), channelGate(store, { network: "eip155:84532" })];
  assert.equal(await code(await useVoucher(fuji, await v(10000, A("c")))), 200);
  assert.equal(await code(await useVoucher(base, await v(10000, A("c"), 84532))), 200);
  assert.ok(await store.get(at(A("c"))));
  assert.ok(await store.get(at(A("c"), 84532)));
});

test("a V1 record of 0.2.0: V2 starts at zero, V1 stays closable, the old record is untouched", async () => {
  for (const extra of [{}, { closed: true, closeTx: "0x1" }]) {
    const store = await legacyStore(30000, V1, extra);
    const before = await store.get(LEGACY);
    if (extra.closed) closedOn.set(store, new Set([V1])); // closed on chain, as the record says
    const two = channelGate(store, { contract: V2 });
    assert.equal(await code(await useVoucher(two, await v(10000, V2))), 200);
    assert.equal(await code(await useVoucher(two, await v(10000, V2))), "voucher_not_increasing");
    assert.deepEqual((await close(store, V2)).sent, [[10000n, sigOf(await v(10000, V2))]]);
    const r = await close(store, V1);
    if (extra.closed) assert.deepEqual(r.skipped, [{ channelId: CHANNEL_ID, reason: "already_closed" }]);
    else assert.deepEqual(r.sent, [[30000n, before.signature]]);
    assert.deepEqual(await store.get(LEGACY), before);
    assert.deepEqual((await close(store, V1)).sent, []); // once
  }
});

test("an upgraded gate goes on from the old record: an old voucher is no new credit", async () => {
  const store = await legacyStore(30000, V1);
  const one = channelGate(store, { contract: V1 });
  for (const amount of [10000, 20000, 30000]) assert.equal(await code(await useVoucher(one, await v(amount, V1))), "voucher_not_increasing");
  assert.equal((await useVoucher(one, await v(40000, V1), 500)).status, 500);
  assert.equal((await store.get(at(V1))).cumulativeAmount, "30000"); // failed call: back to the old amount, with its voucher
  assert.equal(await code(await useVoucher(one, await v(30000, V1))), "voucher_not_increasing");
  assert.equal(await code(await useVoucher(one, await v(40000, V1))), 200);
  assert.deepEqual((await close(store, V1)).sent, [[40000n, sigOf(await v(40000, V1))]]);
  // closed under the scoped key: the old record gives nothing back
  assert.equal(await code(await useVoucher(one, await v(50000, V1))), "channel_not_open");
  assert.deepEqual((await close(store, V1)).sent, []);
});

test("an old closed record of this contract stays closed", async () => {
  const store = await legacyStore(30000, V1, { closed: true });
  assert.equal(await code(await useVoucher(channelGate(store, { contract: V1 }), await v(40000, V1))), "channel_not_open");
});

test("an old record of a contract nobody named: no new credit; naming it as earlier opens the channel", async () => {
  const store = await legacyStore(30000, A("7"));
  assert.equal(await code(await useVoucher(channelGate(store, { contract: V2 }), await v(10000, V2))), "channel_record_unknown");
  // going back to V1 on a store whose record was last written for V2
  assert.equal(await code(await useVoucher(channelGate(await legacyStore(30000, V2), { contract: V1 }), await v(10000, V1))), "channel_record_mixed");
  assert.deepEqual((await close(await legacyStore(30000, V2), V1)).skipped, [{ channelId: CHANNEL_ID, reason: "mixed_record" }]);
  const named = channelGate(store, { contract: V2, prepaid: { earlierContracts: [`eip155:43113/${A("7")}`] } });
  assert.equal(await code(await useVoucher(named, await v(10000, V2))), 200);
  const r = await close(await legacyStore(30000, A("7")), V2);
  assert.deepEqual(r.skipped, [{ channelId: CHANNEL_ID, reason: "other_contract" }]);
  assert.throws(() => channelGate(createMemoryStore(), { prepaid: { earlierContracts: ["0x1"] } }));
});

test("a rolled back old record (nothing used) holds no channel up", async () => {
  const store = createMemoryStore({ [LEGACY]: { cumulativeAmount: "0", signature: null }, channels: [CHANNEL_ID] });
  assert.equal(await code(await useVoucher(channelGate(store, { contract: V2 }), await v(10000, V2))), 200);
});

test("old records are adopted once, also when two gates and a close meet", async () => {
  for (let i = 0; i < 20; i++) {
    const inner = await legacyStore(30000, V1);
    const wait = () => new Promise((r) => setTimeout(r, Math.random() * 4));
    const store = Object.fromEntries(Object.entries(inner).map(([k, fn]) => [k, async (...a) => (await wait(), fn(...a))]));
    const gates = [channelGate(store, { contract: V1 }), channelGate(store, { contract: V1 })];
    const next = await v(40000, V1);
    const [a, b, c] = await Promise.all([useVoucher(gates[0], next), useVoucher(gates[1], next), close(store, V1)]);
    const served = [a, b].filter((r) => r.status === 200).length;
    assert.ok(served <= 1);
    const total = c.sent.length ? c.sent[0][0] : 0n;
    assert.equal(total, served ? 40000n : 30000n); // nothing served is left out of the close
    assert.equal((await inner.get(at(V1))).closed, true);
  }
});

test("signature forms older kits stored are brought to the form the contract accepts", async () => {
  const good = sigOf(await v(30000, V1));
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const [r, s, vv] = [good.slice(2, 66), good.slice(66, 130), good.slice(130)];
  const odd = vv === "1b" ? "0" : "1";
  const high = (N - BigInt(`0x${s}`)).toString(16).padStart(64, "0");
  for (const signature of [`0x${r}${s}0${odd}`, `0x${r}${s}${odd}`, `0x${r}${high}${vv === "1b" ? "1c" : "1b"}`]) {
    const store = await legacyStore(30000, V1, { signature });
    assert.deepEqual((await close(store, V1)).sent, [[30000n, good]]);
  }
});

test("dry run writes nothing", async () => {
  const store = await legacyStore(30000, V1);
  const { wouldClose } = await close(store, V1, { dryRun: true });
  assert.deepEqual(wouldClose, [CHANNEL_ID]);
  assert.equal(await store.get(at(V1)), null);
});
