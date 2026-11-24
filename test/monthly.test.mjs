import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { createX402Gate } from "../src/index.mjs";
import { createFileStore, createMemoryStore } from "../src/store.mjs";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const A = (c) => `0x${c.repeat(40)}`;
const USDC = "0x5425890298aed601595a70AB815c96711a31Bc65";
const SECRET = "test-subscription-secret-0123456789";
const BUYER = A("4");
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const monthlyPayment = b64({ accepted: { extra: { plan: "monthly" } }, payload: { authorization: { from: BUYER } } });

function setup({ quota = 2, now = () => 1_000_000, plan } = {}) {
  const calls = [];
  const store = createMemoryStore();
  const gate = createX402Gate({
    network: "eip155:43113",
    asset: USDC,
    payTo: A("2"),
    seller: A("3"),
    priceAtomic: "10000",
    facilitatorUrl: "https://facilitator.example",
    resource: "https://api.example/echo",
    monthly: { priceAtomic: "5000000", quota, subscriptionSecret: SECRET },
    store,
    now,
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      calls.push([path, JSON.parse(init.body).paymentRequirements.amount]);
      return new Response(JSON.stringify(path === "/verify" ? { isValid: true } : { success: true, transaction: "0xabc", payer: BUYER }));
    },
  });
  return { gate, store, calls };
}
const ok = async () => new Response(JSON.stringify({ echo: "hi" }), { headers: { "content-type": "application/json" } });
const withToken = (t, url = "https://api.example/echo") => new Request(url, { headers: { "hub-subscription": t } });
const purchase = (gate, next = ok) => gate(new Request("https://api.example/echo", { headers: { "payment-signature": monthlyPayment } }), next);

test("402 quote carries the monthly exact entry with the exact shape", async () => {
  const { gate } = setup({ quota: null });
  const body = await (await gate(new Request("https://api.example/echo"), ok)).json();
  assert.equal(body.accepts.length, 2);
  assert.equal(body.accepts[0].extra.plan, undefined);
  const m = body.accepts[1];
  assert.equal(m.scheme, "exact");
  assert.equal(m.amount, "5000000");
  assert.equal(m.maxAmountRequired, "5000000");
  assert.equal(m.payTo, A("2"));
  assert.deepEqual(m.extra, { name: "USD Coin", version: "2", seller: A("3"), plan: "monthly", periodDays: 30, quota: null });
});

test("monthly purchase settles at the monthly price and returns a spec-shaped token", async () => {
  const { gate, calls } = setup();
  const res = await purchase(gate);
  assert.equal(res.status, 200);
  assert.deepEqual(calls, [["/verify", "5000000"], ["/settle", "5000000"]]);
  const token = res.headers.get("hub-subscription");
  const [part, sig] = token.split(".");
  const payload = JSON.parse(Buffer.from(part, "base64url").toString());
  assert.deepEqual(payload, { v: 1, seller: A("3"), buyer: BUYER, resource: "https://api.example", network: "eip155:43113", expiresAt: 1_000_000 + 30 * 86400, quota: 2 });
  assert.equal(sig, createHmac("sha256", SECRET).update(part).digest("base64url"));
});

test("a plain per-call payment is unaffected when monthly is on", async () => {
  const { gate, calls } = setup();
  const res = await gate(new Request("https://api.example/echo", { headers: { "payment-signature": b64({ payload: {} }) } }), ok);
  assert.equal(res.status, 200);
  assert.equal(calls[0][1], "10000");
  assert.equal(res.headers.get("hub-subscription"), null);
});

test("monthly purchase with a failing upstream is not settled and issues no token", async () => {
  const { gate, calls } = setup();
  const res = await purchase(gate, async () => new Response("boom", { status: 500 }));
  assert.equal(res.status, 500);
  assert.deepEqual(calls.map((c) => c[0]), ["/verify"]);
  assert.equal(res.headers.get("hub-subscription"), null);
});

test("monthly purchase without a buyer address is refused before anything is served", async () => {
  const { gate } = setup();
  const res = await gate(new Request("https://api.example/echo", { headers: { "payment-signature": b64({ accepted: { extra: { plan: "monthly" } } }) } }), ok);
  assert.equal(res.status, 402);
});

test("token is accepted without payment and counts against the quota", async () => {
  const { gate, calls } = setup({ quota: 3 });
  const token = (await purchase(gate)).headers.get("hub-subscription"); // use 1
  calls.length = 0;
  assert.equal((await gate(withToken(token), ok)).status, 200); // use 2
  assert.equal((await gate(withToken(token), ok)).status, 200); // use 3
  assert.equal(calls.length, 0); // facilitator never touched
  const over = await gate(withToken(token), ok);
  assert.equal(over.status, 402);
  const body = await over.json();
  assert.equal(body.error, "subscription_quota_exceeded");
  assert.equal(body.accepts.length, 2);
});

test("null quota is unlimited", async () => {
  const { gate } = setup({ quota: null });
  const token = (await purchase(gate)).headers.get("hub-subscription");
  for (let i = 0; i < 5; i++) assert.equal((await gate(withToken(token), ok)).status, 200);
});

test("upstream failure on a token call gives the use back", async () => {
  const { gate } = setup({ quota: 2 });
  const token = (await purchase(gate)).headers.get("hub-subscription"); // use 1
  assert.equal((await gate(withToken(token), async () => new Response("x", { status: 500 }))).status, 500);
  assert.equal((await gate(withToken(token), ok)).status, 200); // use 2 still available
  assert.equal((await gate(withToken(token), ok)).status, 402);
});

test("only the issued spelling of a token is accepted, and the quota counts once", async () => {
  const { gate } = setup({ quota: 3 });
  const token = (await purchase(gate)).headers.get("hub-subscription"); // use 1
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const last = alphabet.indexOf(token.at(-1));
  let served = 0;
  for (let bits = 0; bits < 4; bits++) {
    const spelled = token.slice(0, -1) + alphabet[(last & ~3) + bits];
    if (spelled === token) continue;
    for (let i = 0; i < 2; i++) if ((await gate(withToken(spelled), ok)).status === 200) served++;
  }
  for (const spelled of [`${token}=`, `${token} `, token.replaceAll("-", "+")]) {
    if (spelled.trim() !== token && (await gate(withToken(spelled), ok)).status === 200) served++;
  }
  assert.equal(served, 0);
  assert.equal((await gate(withToken(token), ok)).status, 200);
  assert.equal((await gate(withToken(token), ok)).status, 200);
  assert.equal((await gate(withToken(token), ok)).status, 402);
});

test("expired token -> 402", async () => {
  let t = 1_000_000;
  const { gate } = setup({ now: () => t });
  const token = (await purchase(gate)).headers.get("hub-subscription");
  t += 30 * 86400 - 1;
  assert.equal((await gate(withToken(token), ok)).status, 200);
  t += 1;
  const res = await gate(withToken(token), ok);
  assert.equal(res.status, 402);
  assert.equal((await res.json()).error, "subscription_expired");
});

test("tampered, wrong-secret, wrong-resource and garbage tokens -> 402", async () => {
  const { gate } = setup({ quota: null });
  const token = (await purchase(gate)).headers.get("hub-subscription");
  const [part, sig] = token.split(".");
  const forged = (payload, secret = SECRET) => {
    const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${p}.${createHmac("sha256", secret).update(p).digest("base64url")}`;
  };
  const payload = JSON.parse(Buffer.from(part, "base64url").toString());
  const edited = Buffer.from(JSON.stringify({ ...payload, expiresAt: payload.expiresAt + 99999 })).toString("base64url");
  for (const bad of [`${edited}.${sig}`, forged(payload, "another-secret-another-secret"), `${part}.${sig.slice(0, -2)}AA`, "garbage", "a.b", `${part}`, ""]) {
    if (!bad) continue;
    assert.equal((await gate(withToken(bad), ok)).status, 402, bad.slice(0, 20));
  }
  // validly signed but for another seller / network
  assert.equal((await gate(withToken(forged({ ...payload, seller: A("9") })), ok)).status, 402);
  assert.equal((await gate(withToken(forged({ ...payload, network: "eip155:84532" })), ok)).status, 402);
  assert.equal((await gate(withToken(forged({ ...payload, buyer: "nope" })), ok)).status, 402);
  // and a token valid for this resource stays valid
  assert.equal((await gate(withToken(token), ok)).status, 200);
});

test("token for another API origin is refused", async () => {
  const mk = (resource) =>
    createX402Gate({
      network: "eip155:43113", asset: USDC, payTo: A("2"), seller: A("3"), priceAtomic: "10000", facilitatorUrl: "https://f.example", resource,
      monthly: { priceAtomic: "5000000", quota: null, subscriptionSecret: SECRET }, store: createMemoryStore(), now: () => 1_000_000,
      fetch: async (url) => new Response(JSON.stringify(new URL(url).pathname === "/verify" ? { isValid: true } : { success: true })),
    });
  const a = mk("https://one.example/echo");
  const token = (await a(new Request("https://one.example/echo", { headers: { "payment-signature": monthlyPayment } }), ok)).headers.get("hub-subscription");
  const b = mk("https://two.example/echo");
  const res = await b(withToken(token, "https://two.example/echo"), ok);
  assert.equal(res.status, 402);
  assert.equal((await res.json()).error, "subscription_wrong_resource");
});

test("monthly config validation", () => {
  const base = { network: "eip155:43113", asset: USDC, payTo: A("2"), seller: A("3"), priceAtomic: "1", facilitatorUrl: "https://f.example", store: createMemoryStore() };
  assert.throws(() => createX402Gate({ ...base, monthly: { priceAtomic: "0", quota: null, subscriptionSecret: SECRET } }));
  assert.throws(() => createX402Gate({ ...base, monthly: { priceAtomic: "1", quota: 0, subscriptionSecret: SECRET } }));
  assert.throws(() => createX402Gate({ ...base, monthly: { priceAtomic: "1", quota: null, subscriptionSecret: "short" } }));
});

test("file store: atomic JSON, survives a new instance, refuses a corrupt file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "seller-kit-"));
  const path = join(dir, "s.json");
  const s1 = createFileStore(path);
  assert.equal(await s1.get("a"), null);
  await Promise.all([s1.set("a", { n: 1 }), s1.set("b", [2]), s1.set("c", "3")]);
  const s2 = createFileStore(path);
  assert.deepEqual(await s2.get("a"), { n: 1 });
  assert.deepEqual(await s2.get("b"), [2]);
  assert.equal(await s2.get("c"), "3");
  assert.equal(await s2.get("__proto__"), null);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, "utf8"))).sort(), ["a", "b", "c"]);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(path, "{oops");
  await assert.rejects(() => s2.set("d", 1));
  assert.equal(readFileSync(path, "utf8"), "{oops");
});
