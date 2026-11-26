// Payments bound to one gate (0.4.0).
import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak256 as viemKeccak, encodeAbiParameters, toHex } from "viem";
import { createX402Gate } from "../src/index.mjs";
import { BINDING_DOMAIN, boundNonce, gateIdOf, keccak256 } from "../src/gate-binding.mjs";
import { createMemoryStore } from "../src/store.mjs";
import { A, fakeRpc } from "./fixtures/gates.mjs";

const USDC = "0x5425890298aed601595a70ab815c96711a31bc65";
const FROM = A("4");
const OWNER = { "hub-idempotency-key": "k".repeat(32) };
const random32 = () => toHex(crypto.getRandomValues(new Uint8Array(32)));

/** A gate with its own store, and a facilitator that verifies and settles once per authorization, as a real one does. */
function gateOf({ gateId, resource = "https://api.example/echo", monthly, network = "eip155:43113", ...extra } = {}, chain = { used: new Set(), settles: 0 }) {
  const gate = createX402Gate({
    network, asset: USDC, payTo: A("2"), seller: A("3"), priceAtomic: "10000", facilitatorUrl: "https://f.example", resource, store: createMemoryStore(), settlementRpcUrl: "https://rpc.example",
    ...(gateId ? { gateId } : {}), ...(monthly ? { monthly: { priceAtomic: "50000", quota: 3, subscriptionSecret: "s".repeat(32) } } : {}), ...extra,
    fetch: async (url, init) => {
      const rpc = fakeRpc(url.replace("rpc.example", "avax-test"), init);
      if (rpc) return rpc;
      const body = JSON.parse(init.body);
      assert.equal(body.paymentPayload.binding, undefined, "the facilitator gets the standard payload");
      const nonce = body.paymentPayload.payload.authorization.nonce;
      if (url.endsWith("/verify")) return Response.json({ isValid: !chain.used.has(nonce) });
      chain.settles++;
      if (chain.used.has(nonce)) return Response.json({ success: true, transaction: "0xtx", extensions: { "hub-settlement": { replayed: true } } });
      chain.used.add(nonce);
      return Response.json({ success: true, transaction: "0xtx" });
    },
  });
  gate.chain = chain;
  return gate;
}
const quoteOf = async (gate) => (await (await gate(new Request("https://api.example/echo"), null)).json()).accepts[0];
/** What a binding-aware buyer sends for a quote. */
async function paymentFor(gate, { monthly = false, r = random32(), nonce } = {}) {
  const q = await quoteOf(gate);
  const b = q.extra.gateBinding;
  const n = nonce ?? boundNonce({ chainId: 43113, asset: q.asset, payTo: q.payTo, gateId: b.gateId, r });
  return Buffer.from(JSON.stringify({ x402Version: 2, accepted: monthly ? { extra: { plan: "monthly" } } : q, payload: { signature: "0x11", authorization: { from: FROM, nonce: n } }, binding: { v: 1, r } })).toString("base64");
}
const pay = (gate, payment, headers = OWNER) => gate(new Request("https://api.example/echo", { headers: { "payment-signature": payment, ...headers } }), async () => Response.json({ echo: 1 }));
const told = async (res) => {
  const body = await res.clone().json().catch(() => ({}));
  assert.notEqual(body.safeToPayAgain, true, "a refusal never says safe to pay again");
  return [res.status, res.headers.get("hub-payment-status"), body.error];
};

test("keccak256 and the nonce agree with viem's abi.encode", () => {
  for (const text of ["", "a", "hub-gate-v1", "x".repeat(135), "x".repeat(136), "x".repeat(300)]) assert.equal(keccak256(new TextEncoder().encode(text)), viemKeccak(new TextEncoder().encode(text)));
  const gateId = gateIdOf({ gateId: "my-api" });
  const r = random32();
  const expected = viemKeccak(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" }], [viemKeccak(new TextEncoder().encode("hub-gate-v1")), 43113n, USDC, A("2"), gateId, r]));
  assert.equal(BINDING_DOMAIN, viemKeccak(new TextEncoder().encode("hub-gate-v1")));
  assert.equal(boundNonce({ chainId: 43113, asset: USDC, payTo: A("2"), gateId, r }), expected);
  assert.equal(gateIdOf({ gateId: `0x${"AB".repeat(32)}` }), `0x${"ab".repeat(32)}`);
});

test("the quote carries the gate's id; a bound payment is served once", async () => {
  const gate = gateOf({ gateId: "api-one" });
  const q = await quoteOf(gate);
  assert.deepEqual(q.extra.gateBinding, { v: 1, gateId: gateIdOf({ gateId: "api-one" }), required: false });
  const p = await paymentFor(gate);
  assert.deepEqual(await told(await pay(gate, p)), [200, "settled", undefined]);
  assert.equal((await pay(gate, p)).status, 409);
});

test("the same bound payment at a second gate with its own store is refused, before anything is settled", async () => {
  for (const second of [{ gateId: "api-two" }, { gateId: undefined, resource: "https://api.example/other" }, { gateId: "api-one", network: "eip155:84532", asset: undefined }]) {
    const chain = { used: new Set(), settles: 0 };
    const one = gateOf({ gateId: "api-one" }, chain);
    const two = gateOf(second.network ? { gateId: "api-one", network: "eip155:84532", allowedNetworks: ["eip155:84532"] } : second, chain);
    const p = await paymentFor(one);
    for (const [a, b] of [[one, two], [two, one]]) void a, void b;
    // the second gate first, while the first one has not used it yet, and afterwards
    assert.deepEqual(await told(await pay(two, p)), [402, "refused", "payment_for_another_gate"]);
    assert.equal(chain.settles, 0);
    assert.deepEqual(await told(await pay(one, p)), [200, "settled", undefined]);
    for (const h of [OWNER, {}]) assert.deepEqual(await told(await pay(two, p, h)), [402, "refused", "payment_for_another_gate"]);
    assert.equal(chain.settles, 1);
  }
});

test("a binding that does not fit is refused: a wrong r, another nonce, malformed fields", async () => {
  const gate = gateOf({ gateId: "api-one" });
  const bad = [
    await paymentFor(gate, { nonce: `0x${"1".repeat(64)}` }),
    await paymentFor(gate, { r: `0x${"2".repeat(64)}`, nonce: boundNonce({ chainId: 43113, asset: USDC, payTo: A("2"), gateId: gateIdOf({ gateId: "api-one" }), r: `0x${"3".repeat(64)}` }) }),
  ];
  for (const binding of [null, {}, { v: 2, r: random32() }, { v: 1, r: "0x12" }, { v: 1 }, "x", 5]) {
    bad.push(Buffer.from(JSON.stringify({ payload: { authorization: { from: FROM, nonce: `0x${"1".repeat(64)}` } }, binding })).toString("base64"));
  }
  for (const p of bad) assert.deepEqual(await told(await pay(gate, p)), [402, "refused", "payment_for_another_gate"]);
  assert.equal(gate.chain.settles, 0);
});

test("unbound payments: still served where allowed, refused where binding is required", async () => {
  const old = Buffer.from(JSON.stringify({ payload: { signature: "0x11", authorization: { from: FROM, nonce: `0x${"5".repeat(64)}` } } })).toString("base64");
  assert.deepEqual(await told(await pay(gateOf({ gateId: "api-one" }), old)), [200, "settled", undefined]);
  const strict = gateOf({ gateId: "api-one", requireGateBinding: true });
  assert.equal((await quoteOf(strict)).extra.gateBinding.required, true);
  assert.deepEqual(await told(await pay(strict, old)), [402, "refused", "payment_not_bound"]);
  assert.equal(strict.chain.settles, 0);
  assert.deepEqual(await told(await pay(strict, await paymentFor(strict))), [200, "settled", undefined]);
});

test("monthly: the token is bought only at the gate the payment was made for", async () => {
  const chain = { used: new Set(), settles: 0 };
  const one = gateOf({ gateId: "api-one", monthly: true }, chain);
  const two = gateOf({ gateId: "api-two", monthly: true }, chain);
  const p = await paymentFor(one, { monthly: true });
  const refused = await pay(two, p);
  assert.deepEqual([...(await told(refused)), refused.headers.get("hub-subscription")], [402, "refused", "payment_for_another_gate", null]);
  const bought = await pay(one, p);
  assert.equal(bought.status, 200);
  assert.ok(bought.headers.get("hub-subscription"));
  assert.equal((await pay(two, p)).headers.get("hub-subscription"), null);
});

test("binding settings", () => {
  const base = { asset: USDC, payTo: A("2"), seller: A("3"), priceAtomic: "1", facilitatorUrl: "https://f.example", store: createMemoryStore() };
  assert.throws(() => createX402Gate({ ...base, network: "eip155:43113", gateId: "" }), /gateId/);
  assert.throws(() => createX402Gate({ ...base, network: "eip155:43113", requireGateBinding: "yes", gateId: "a" }), /requireGateBinding/);
  // the mainnet cases: test/gate-binding-mainnet.test.mjs
});
