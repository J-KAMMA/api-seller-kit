// What makes one gate's id its own (0.4.1): no id from payTo alone where binding is required, and monthly tokens tied to their gate.
import assert from "node:assert/strict";
import { test } from "node:test";
import { toHex } from "viem";
import { createX402Gate } from "../src/index.mjs";
import { boundNonce } from "../src/gate-binding.mjs";
import { createMemoryStore } from "../src/store.mjs";
import { signToken } from "../src/subscription.mjs";
import { A, fakeRpc } from "./fixtures/gates.mjs";

const USDC = "0x5425890298aed601595a70ab815c96711a31bc65";
const SECRET = "s".repeat(32);
const OWNER = { "hub-idempotency-key": "k".repeat(32) };
const base = { network: "eip155:43113", asset: USDC, payTo: A("2"), seller: A("3"), priceAtomic: "10000", facilitatorUrl: "https://f.example", store: createMemoryStore() };

function quietly(fn) {
  const warned = [];
  const warn = console.warn;
  console.warn = (...a) => warned.push(a.join(" "));
  try {
    fn();
  } finally {
    console.warn = warn;
  }
  return warned;
}

test("where binding is required a gate needs gateId or resource; elsewhere it is told", () => {
  assert.throws(() => createX402Gate({ ...base, requireGateBinding: true }), /gateId or resource/);
  assert.doesNotThrow(() => quietly(() => createX402Gate({ ...base, requireGateBinding: true, gateId: "api-one" })));
  assert.doesNotThrow(() => quietly(() => createX402Gate({ ...base, requireGateBinding: true, resource: "https://api.example/echo" })));
  const warned = quietly(() => createX402Gate(base));
  assert.ok(warned.some((w) => /no gateId and no resource/.test(w)), warned.join("\n"));
  assert.ok(!quietly(() => createX402Gate({ ...base, gateId: "api-one" })).some((w) => /no gateId/.test(w)));
});

/** A monthly gate with its own store; the facilitator settles each authorization once. */
function monthlyGate(gateId, extra = {}, chain = { used: new Set() }) {
  return createX402Gate({
    ...base, store: createMemoryStore(), gateId, resource: "https://api.example/echo", settlementRpcUrl: "https://rpc.example",
    monthly: { priceAtomic: "50000", quota: 2, subscriptionSecret: SECRET }, ...extra,
    fetch: async (url, init) => {
      const rpc = fakeRpc(url.replace("rpc.example", "avax-test"), init);
      if (rpc) return rpc;
      const nonce = JSON.parse(init.body).paymentPayload.payload.authorization.nonce;
      if (url.endsWith("/verify")) return Response.json({ isValid: !chain.used.has(nonce) });
      chain.used.add(nonce);
      return Response.json({ success: true, transaction: "0xtx" });
    },
  });
}
const call = (gate, headers) => gate(new Request("https://api.example/echo", { headers: { ...OWNER, ...headers } }), async () => Response.json({ echo: 1 }));
const errorOf = async (res) => (await res.clone().json().catch(() => ({}))).error;

async function buy(gate) {
  const q = (await (await gate(new Request("https://api.example/echo"), null)).json()).accepts[0];
  const r = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const nonce = boundNonce({ chainId: 43113, asset: q.asset, payTo: q.payTo, gateId: q.extra.gateBinding.gateId, r });
  const payment = Buffer.from(JSON.stringify({ x402Version: 2, accepted: { extra: { plan: "monthly" } }, payload: { signature: "0x11", authorization: { from: A("4"), nonce } }, binding: { v: 1, r } })).toString("base64");
  const res = await call(gate, { "payment-signature": payment });
  assert.equal(res.status, 200);
  return res.headers.get("hub-subscription");
}

test("monthly: a token works only at the gate it was bought at, so its quota is counted once", async () => {
  const one = monthlyGate("api-one");
  const two = monthlyGate("api-two"); // same secret, same address, its own store
  const token = await buy(one);
  assert.ok(token);
  const there = await call(two, { "hub-subscription": token });
  assert.notEqual(there.status, 200);
  assert.equal(await errorOf(there), "subscription_wrong_gate");
  assert.equal((await call(one, { "hub-subscription": token })).status, 200); // its second use of 2
  assert.notEqual((await call(one, { "hub-subscription": token })).status, 200);
});

test("monthly: a token from before 0.4.1 (no gate in it) still works where binding is not required, and only there", async () => {
  const old = await signToken(SECRET, { v: 2, seller: A("3").toLowerCase(), buyer: A("4").toLowerCase(), resource: "https://api.example", path: "/echo", price: "50000", network: "eip155:43113", expiresAt: Math.floor(Date.now() / 1000) + 86400, quota: 2, payment: "p".repeat(32) });
  assert.equal((await call(monthlyGate("api-one"), { "hub-subscription": old })).status, 200);
  const strict = await call(monthlyGate("api-one", { requireGateBinding: true }), { "hub-subscription": old });
  assert.notEqual(strict.status, 200);
  assert.equal(await errorOf(strict), "subscription_wrong_gate");
});
