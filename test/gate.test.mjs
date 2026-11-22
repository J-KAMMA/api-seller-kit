import assert from "node:assert/strict";
import { test } from "node:test";
import { createX402Gate } from "../src/index.mjs";

const A = (c) => `0x${c.repeat(40)}`;
const cfg = {
  network: "eip155:43113",
  asset: "0x5425890298aed601595a70AB815c96711a31Bc65",
  payTo: A("2"),
  seller: A("3"),
  priceAtomic: "10000",
  facilitatorUrl: "https://facilitator.example",
  description: "echo",
  resource: "https://api.example/echo",
};
const payment = Buffer.from(JSON.stringify({ x402Version: 2, accepted: {}, payload: { signature: "0xsecret" } })).toString("base64");

/** Fake facilitator: records calls, answers per `plan`. */
function fake(plan = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, body: JSON.parse(init.body), headers: init.headers });
    const r = plan[path] ?? (path === "/verify" ? { isValid: true } : { success: true, transaction: "0xabc", network: cfg.network, payer: A("4") });
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r), { status: r.__status ?? 200 });
  };
  return { fetch, calls };
}

const paid = (headers = { "payment-signature": payment }) => new Request("https://api.example/echo?text=hi", { headers });
const upstreamOk = async () => new Response(JSON.stringify({ echo: "hi" }), { headers: { "content-type": "application/json" } });

test("no payment header -> 402 quote with exact shape", async () => {
  const f = fake();
  let called = false;
  const gate = createX402Gate({ ...cfg, fetch: f.fetch });
  const res = await gate(new Request("https://api.example/echo"), async () => ((called = true), upstreamOk()));
  assert.equal(res.status, 402);
  assert.equal(called, false);
  assert.equal(f.calls.length, 0);
  const body = await res.json();
  assert.equal(body.x402Version, 2);
  const a = body.accepts[0];
  assert.equal(a.scheme, "exact");
  assert.equal(a.network, "eip155:43113");
  assert.equal(a.amount, "10000");
  assert.equal(a.maxAmountRequired, "10000");
  assert.equal(a.asset, cfg.asset.toLowerCase());
  assert.equal(a.payTo, A("2"));
  assert.equal(a.resource, cfg.resource);
  assert.equal(a.mimeType, "application/json");
  assert.equal(a.maxTimeoutSeconds, 300);
  assert.deepEqual(a.extra, { name: "USD Coin", version: "2", seller: A("3") });
  const fromHeader = JSON.parse(Buffer.from(res.headers.get("payment-required"), "base64").toString());
  assert.deepEqual(fromHeader, body);
});

test("verify fails -> 402, upstream never called", async () => {
  const f = fake({ "/verify": { isValid: false, invalidReason: "bad_signature" } });
  let called = false;
  const gate = createX402Gate({ ...cfg, fetch: f.fetch });
  const res = await gate(paid(), async () => ((called = true), upstreamOk()));
  assert.equal(res.status, 402);
  assert.equal(called, false);
  assert.deepEqual(f.calls.map((c) => c.path), ["/verify"]);
});

test("facilitator unreachable at verify -> 502 fail closed", async () => {
  const f = fake({ "/verify": new Error("down") });
  const gate = createX402Gate({ ...cfg, fetch: f.fetch });
  const res = await gate(paid(), upstreamOk);
  assert.equal(res.status, 502);
});

test("upstream error -> returned as is, no settle", async () => {
  const f = fake();
  const gate = createX402Gate({ ...cfg, fetch: f.fetch });
  const res = await gate(paid(), async () => new Response("boom", { status: 500 }));
  assert.equal(res.status, 500);
  assert.deepEqual(f.calls.map((c) => c.path), ["/verify"]);
  assert.equal(res.headers.get("x-payment-response"), null);
});

test("upstream throws -> 502, no settle", async () => {
  const f = fake();
  const gate = createX402Gate({ ...cfg, fetch: f.fetch });
  const res = await gate(paid(), async () => {
    throw new Error("x");
  });
  assert.equal(res.status, 502);
  assert.deepEqual(f.calls.map((c) => c.path), ["/verify"]);
});

test("settle fails -> 502 and the body is withheld", async () => {
  for (const settle of [{ success: false, errorReason: "nonce_used" }, new Error("down")]) {
    const f = fake({ "/settle": settle });
    const gate = createX402Gate({ ...cfg, fetch: f.fetch });
    const res = await gate(paid(), upstreamOk);
    assert.equal(res.status, 502);
    const text = await res.text();
    assert.ok(!text.includes("echo"));
    assert.equal(res.headers.get("x-payment-response"), null);
  }
});

test("success -> upstream body + X-PAYMENT-RESPONSE with tx hash; facilitator gets standard shapes", async () => {
  const f = fake();
  const gate = createX402Gate({ ...cfg, fetch: f.fetch, facilitatorHeaders: { authorization: "Bearer t" } });
  const res = await gate(paid({ "x-payment": payment }), upstreamOk);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { echo: "hi" });
  const receipt = JSON.parse(Buffer.from(res.headers.get("x-payment-response"), "base64").toString());
  assert.equal(receipt.success, true);
  assert.equal(receipt.transaction, "0xabc");
  assert.deepEqual(f.calls.map((c) => c.path), ["/verify", "/settle"]);
  for (const c of f.calls) {
    assert.deepEqual(Object.keys(c.body).sort(), ["paymentPayload", "paymentRequirements", "x402Version"]);
    assert.equal(c.body.paymentRequirements.extra.seller, A("3"));
    assert.equal(c.body.paymentRequirements.amount, "10000");
    assert.equal(c.headers.authorization, "Bearer t");
  }
});

test("requirements come from config, never from the buyer's payload", async () => {
  const f = fake();
  const evil = Buffer.from(JSON.stringify({ accepted: { amount: "1", payTo: A("9") } })).toString("base64");
  const gate = createX402Gate({ ...cfg, fetch: f.fetch });
  await gate(paid({ "payment-signature": evil }), upstreamOk);
  assert.equal(f.calls[0].body.paymentRequirements.amount, "10000");
  assert.equal(f.calls[0].body.paymentRequirements.payTo, A("2"));
});

test("garbage payment header -> 402, no facilitator call", async () => {
  const f = fake();
  const gate = createX402Gate({ ...cfg, fetch: f.fetch });
  const res = await gate(paid({ "payment-signature": "!!!not-base64!!!" }), upstreamOk);
  assert.equal(res.status, 402);
  assert.equal(f.calls.length, 0);
});

test("config refuses mainnet, bad addresses and http facilitators", () => {
  assert.throws(() => createX402Gate({ ...cfg, network: "eip155:43114" }));
  assert.throws(() => createX402Gate({ ...cfg, payTo: "0x12" }));
  assert.throws(() => createX402Gate({ ...cfg, priceAtomic: "0" }));
  assert.throws(() => createX402Gate({ ...cfg, facilitatorUrl: "http://evil.example" }));
});

test("local dev network 31337 is refused by default and needs the option plus a loopback facilitator", () => {
  const local = { ...cfg, network: "eip155:31337", facilitatorUrl: "http://127.0.0.1:8790" };
  assert.throws(() => createX402Gate(local));
  assert.doesNotThrow(() => createX402Gate({ ...local, allowLocalDevNetwork: true }));
  assert.throws(() => createX402Gate({ ...local, allowLocalDevNetwork: true, facilitatorUrl: "https://facilitator.example" }));
  assert.throws(() => createX402Gate({ ...cfg, network: "eip155:1", allowLocalDevNetwork: true }));
});
