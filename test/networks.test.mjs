// Which networks a gate can be created for.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createX402Gate } from "../src/index.mjs";

const A = (c) => `0x${c.repeat(40)}`;
const gate = (network, extra = {}) =>
  createX402Gate({ network, asset: A("5"), payTo: A("2"), seller: A("3"), priceAtomic: "1", facilitatorUrl: "https://f.example", ...extra });
const FOREIGN = ["eip155:1", "eip155:8453", "eip155:10", "eip155:137", "eip155:42161", "eip155:56", "eip155:43114", "eip155:31337", "eip155:043113"];

test("allowedNetworks never opens a network: only testnets without the explicit options", () => {
  for (const n of FOREIGN) {
    assert.throws(() => gate(n), n);
    assert.throws(() => gate(n, { allowedNetworks: [n] }), n);
    assert.throws(() => gate(n, { allowedNetworks: ["eip155:43113", n] }), n);
    assert.throws(() => gate(n, { allowedNetworks: n }), n);
    assert.throws(() => gate(n, { allowedNetworks: { includes: () => true, filter: () => [n] } }), n);
  }
});

test("no option opens a mainnet, and allowLocalDevNetwork opens only its own network", () => {
  for (const n of FOREIGN) {
    assert.throws(() => gate(n, { allowMainnet: true }), n);
    assert.throws(() => gate(n, { allowMainnet: true, allowedNetworks: [n] }), n);
    if (n !== "eip155:31337") assert.throws(() => gate(n, { allowLocalDevNetwork: true, facilitatorUrl: "http://127.0.0.1:1", allowedNetworks: [n] }), n);
  }
  const usdc = "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E";
  assert.throws(() => gate("eip155:43114", { allowMainnet: true, asset: usdc, allowedNetworks: ["eip155:43114"] }));
  assert.throws(() => gate("eip155:31337", { allowLocalDevNetwork: true })); // needs a loopback facilitator
  assert.doesNotThrow(() => gate("eip155:31337", { allowLocalDevNetwork: true, facilitatorUrl: "http://127.0.0.1:1" }));
});

test("allowedNetworks narrows", () => {
  for (const n of ["eip155:43113", "eip155:84532"]) {
    assert.doesNotThrow(() => gate(n));
    assert.doesNotThrow(() => gate(n, { allowedNetworks: [n] }));
    assert.throws(() => gate(n, { allowedNetworks: [] }));
  }
  assert.throws(() => gate("eip155:84532", { allowedNetworks: ["eip155:43113"] }));
});
