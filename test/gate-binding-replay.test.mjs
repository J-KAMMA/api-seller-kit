// One bound payment, two gates with separate stores for the same payTo: served once. Needs nothing but the public gate API and viem.
import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeAbiParameters, keccak256, toHex } from "viem";
import { createX402Gate } from "../src/index.mjs";
import { createMemoryStore } from "../src/store.mjs";
import { A, fakeRpc } from "./fixtures/gates.mjs";

const USDC = "0x5425890298aed601595a70ab815c96711a31bc65";

test("a payment made for one gate is served by that gate only, although the other one keeps its own store", async () => {
  const chain = { used: new Set(), bodies: 0 };
  const make = (gateId) =>
    createX402Gate({
      network: "eip155:43113", asset: USDC, payTo: A("2"), seller: A("3"), priceAtomic: "10000", facilitatorUrl: "https://f.example", resource: "https://api.example/echo",
      store: createMemoryStore(), settlementRpcUrl: "https://rpc.example", gateId,
      fetch: async (url, init) => {
        const rpc = fakeRpc(url.replace("rpc.example", "avax-test"), init);
        if (rpc) return rpc;
        const nonce = JSON.parse(init.body).paymentPayload.payload.authorization.nonce;
        if (url.endsWith("/verify")) return Response.json({ isValid: true }); // both verify before either settles
        if (chain.used.has(nonce)) return Response.json({ success: true, transaction: "0xtx" }); // a facilitator that answers a repeat with success
        chain.used.add(nonce);
        return Response.json({ success: true, transaction: "0xtx" });
      },
    });
  const [one, two] = [make("api-one"), make("api-two")];
  const quote = (await (await one(new Request("https://api.example/echo"), null)).json()).accepts[0];
  const gateId = quote.extra?.gateBinding?.gateId ?? keccak256(new TextEncoder().encode("gate:api-one"));
  const r = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const nonce = keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" }],
    [keccak256(new TextEncoder().encode("hub-gate-v1")), 43113n, USDC, A("2"), gateId, r],
  ));
  const payment = Buffer.from(JSON.stringify({ x402Version: 2, accepted: quote, payload: { signature: "0x11", authorization: { from: A("4"), nonce } }, binding: { v: 1, r } })).toString("base64");
  const api = async () => (chain.bodies++, Response.json({}));
  const results = await Promise.all([one, two].map((gate) => gate(new Request("https://api.example/echo", { headers: { "payment-signature": payment } }), api)));
  assert.deepEqual(results.map((res) => res.status), [200, 402]);
  assert.equal(chain.bodies, 1);
  assert.notEqual((await results[1].json()).safeToPayAgain, true);
});
