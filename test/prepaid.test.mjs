import assert from "node:assert/strict";
import { test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { createX402Gate } from "../src/index.mjs";
import { createMemoryStore } from "../src/store.mjs";
import { closeChannels } from "../src/close.mjs";

// Hardhat account #0 / #1: public well-known test keys, used only to sign fake vouchers.
const buyer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const stranger = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const A = (c) => `0x${c.repeat(40)}`;
const USDC = "0x5425890298aed601595a70AB815c96711a31Bc65";
const CHANNEL = A("c");
const SELLER = A("3");
const CHANNEL_ID = `0x${"ab".repeat(32)}`;
const PRICE = 10000n;
const types = { Voucher: [{ name: "channelId", type: "bytes32" }, { name: "cumulativeAmount", type: "uint256" }] };
const domain = { name: "ApiPaymentChannel", version: "1", chainId: 43113, verifyingContract: CHANNEL };

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
async function voucher(cum, { account = buyer, channelId = CHANNEL_ID } = {}) {
  const signature = await account.signTypedData({ domain, types, primaryType: "Voucher", message: { channelId, cumulativeAmount: BigInt(cum) } });
  return b64({ channelId, cumulativeAmount: String(cum), signature });
}

function setup({ channel = {}, readChannel } = {}) {
  const state = { buyer: buyer.address, seller: SELLER, token: USDC, deposit: 1_000_000n, closeRequestedAt: 0n, status: 1, ...channel };
  const store = createMemoryStore();
  const gate = createX402Gate({
    network: "eip155:43113",
    asset: USDC,
    payTo: A("2"),
    seller: SELLER,
    priceAtomic: "10000",
    facilitatorUrl: "https://facilitator.example",
    resource: "https://api.example/echo",
    prepaid: { pricePerCallAtomic: String(PRICE), channelContract: CHANNEL, minDepositAtomic: "100000", readChannel: readChannel ?? (async () => state) },
    store,
    fetch: async () => {
      throw new Error("facilitator must not be called for vouchers");
    },
  });
  return { gate, store, state };
}
const req = (v) => new Request("https://api.example/echo?text=hi", { headers: v ? { "hub-channel-voucher": v } : {} });
const ok = async () => new Response(JSON.stringify({ echo: "hi" }), { headers: { "content-type": "application/json" } });
const rejected = async (res, error) => {
  assert.equal(res.status, 402);
  assert.equal((await res.json()).error, error);
};

test("402 quote lists exact first and the hub-channel entry with the exact shape", async () => {
  const { gate } = setup();
  const res = await gate(req(), ok);
  assert.equal(res.status, 402);
  const body = await res.json();
  assert.equal(body.accepts.length, 2);
  assert.equal(body.accepts[0].scheme, "exact");
  assert.equal(body.accepts[0].extra.plan, undefined);
  assert.deepEqual(body.accepts[1], {
    scheme: "hub-channel",
    network: "eip155:43113",
    asset: USDC.toLowerCase(),
    payTo: SELLER,
    amount: "10000",
    resource: "https://api.example/echo",
    maxTimeoutSeconds: 300,
    extra: { channelContract: CHANNEL, seller: SELLER, minDepositAtomic: "100000" },
  });
});

test("valid voucher is served, receipt header is returned, highest is stored", async () => {
  const { gate, store } = setup();
  const res = await gate(req(await voucher(10000)), ok);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { echo: "hi" });
  const receipt = JSON.parse(Buffer.from(res.headers.get("hub-channel-receipt"), "base64").toString());
  assert.deepEqual(receipt, { channelId: CHANNEL_ID, cumulativeAmount: "10000", remainingAtomic: "990000" });
  const rec = await store.get(`channel:43113:${CHANNEL}:${CHANNEL_ID}`);
  assert.equal(rec.cumulativeAmount, "10000");
  assert.deepEqual(await store.get(`channels:43113:${CHANNEL}`), [CHANNEL_ID]);
  // next call must go up by at least the price
  assert.equal((await gate(req(await voucher(20000)), ok)).status, 200);
  assert.equal((await store.get(`channel:43113:${CHANNEL}:${CHANNEL_ID}`)).cumulativeAmount, "20000");
});

test("rejections: wrong signer, over deposit, not increasing, replay, wrong seller/token, closed, closing, none", async () => {
  await rejected(await setup().gate(req(await voucher(10000, { account: stranger })), ok), "voucher_bad_signature");
  await rejected(await setup().gate(req(await voucher(1_000_001)), ok), "voucher_exceeds_deposit");
  await rejected(await setup().gate(req(await voucher(9999)), ok), "voucher_not_increasing");
  await rejected(await setup({ channel: { seller: A("9") } }).gate(req(await voucher(10000)), ok), "channel_wrong_seller");
  await rejected(await setup({ channel: { token: A("8") } }).gate(req(await voucher(10000)), ok), "channel_wrong_token");
  await rejected(await setup({ channel: { status: 2 } }).gate(req(await voucher(10000)), ok), "channel_not_open");
  await rejected(await setup({ channel: { status: 0 } }).gate(req(await voucher(10000)), ok), "channel_not_open");
  await rejected(await setup({ channel: { closeRequestedAt: 1n } }).gate(req(await voucher(10000)), ok), "channel_closing");
  await rejected(await setup().gate(req("!!!"), ok), "voucher_invalid");
  await rejected(await setup().gate(req(b64({ channelId: "0x12", cumulativeAmount: "1", signature: "0x00" })), ok), "voucher_invalid");

  const { gate } = setup();
  const v = await voucher(10000);
  assert.equal((await gate(req(v), ok)).status, 200);
  await rejected(await gate(req(v), ok), "voucher_not_increasing"); // replay
  await rejected(await gate(req(await voucher(19999)), ok), "voucher_not_increasing"); // less than price above highest
});

test("a rejected voucher still carries the full quote", async () => {
  const res = await setup().gate(req(await voucher(1)), ok);
  const body = await res.json();
  assert.equal(body.accepts.length, 2);
  assert.ok(res.headers.get("payment-required"));
});

test("deposit and buyer come from the chain, never from the voucher", async () => {
  const { gate } = setup();
  const v = JSON.parse(Buffer.from(await voucher(2_000_000), "base64").toString());
  v.deposit = "99999999";
  v.buyer = stranger.address;
  await rejected(await gate(req(b64(v)), ok), "voucher_exceeds_deposit");
});

test("upstream 500 or throw rolls the stored highest back", async () => {
  const { gate, store } = setup();
  assert.equal((await gate(req(await voucher(10000)), ok)).status, 200);
  const v2 = await voucher(20000);
  const bad = await gate(req(v2), async () => new Response("boom", { status: 500 }));
  assert.equal(bad.status, 500);
  assert.equal(bad.headers.get("hub-channel-receipt"), null);
  assert.equal((await store.get(`channel:43113:${CHANNEL}:${CHANNEL_ID}`)).cumulativeAmount, "10000");
  const thrown = await gate(req(v2), async () => {
    throw new Error("x");
  });
  assert.equal(thrown.status, 502);
  assert.equal((await store.get(`channel:43113:${CHANNEL}:${CHANNEL_ID}`)).cumulativeAmount, "10000");
  // the same voucher works once upstream is healthy again
  assert.equal((await gate(req(v2), ok)).status, 200);
  assert.equal((await store.get(`channel:43113:${CHANNEL}:${CHANNEL_ID}`)).cumulativeAmount, "20000");
});

test("first voucher failing upstream rolls back to zero and is not closable", async () => {
  const { gate, store } = setup();
  await gate(req(await voucher(10000)), async () => new Response("x", { status: 500 }));
  const rec = await store.get(`channel:43113:${CHANNEL}:${CHANNEL_ID}`);
  assert.equal(rec.cumulativeAmount, "0");
  assert.equal(rec.signature, null);
  const out = await closeChannels({ store, chainId: 43113, channelContract: CHANNEL, seller: SELLER, readChannel: async () => ({ buyer: buyer.address, seller: SELLER, status: 1, deposit: 1n }), sendClose: async () => "0x" });
  assert.deepEqual(out.skipped, [{ channelId: CHANNEL_ID, reason: "no_voucher" }]);
});

test("chain read failure fails closed with 502", async () => {
  const { gate } = setup({
    readChannel: async () => {
      throw new Error("rpc down");
    },
  });
  const res = await gate(req(await voucher(10000)), ok);
  assert.equal(res.status, 502);
});

test("per-call exact path is unchanged when prepaid is on (facilitator still verifies and settles)", async () => {
  const calls = [];
  const gate = createX402Gate({
    network: "eip155:43113",
    asset: USDC,
    payTo: A("2"),
    seller: SELLER,
    priceAtomic: "10000",
    facilitatorUrl: "https://facilitator.example",
    prepaid: { pricePerCallAtomic: "10000", channelContract: CHANNEL, readChannel: async () => ({}) },
    store: createMemoryStore(),
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      calls.push([path, JSON.parse(init.body).paymentRequirements.amount]);
      return new Response(JSON.stringify(path === "/verify" ? { isValid: true } : { success: true, transaction: "0xabc" }));
    },
  });
  const res = await gate(new Request("https://api.example/echo", { headers: { "payment-signature": b64({ payload: { authorization: { from: A("4"), nonce: `0x${"1".repeat(64)}` } } }) } }), ok);
  assert.equal(res.status, 200);
  assert.deepEqual(calls, [["/verify", "10000"], ["/settle", "10000"]]);
  assert.ok(res.headers.get("x-payment-response"));
});

test("only the canonical signature form is accepted, and a refused voucher is not stored", async () => {
  const { gate, store } = setup();
  const good = JSON.parse(Buffer.from(await voucher(10000), "base64").toString());
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const r = good.signature.slice(2, 66);
  const s = good.signature.slice(66, 130);
  const v = good.signature.slice(130);
  const highS = (N - BigInt(`0x${s}`)).toString(16).padStart(64, "0");
  const odd = v === "1b" ? "0" : "1";
  for (const signature of [
    `0x${r}${s}0${odd}`,
    `0x${r}${s}${odd}`,
    `0x${r}${highS}${v === "1b" ? "1c" : "1b"}`,
    `0x${r}${s}`,
    `0x${r}${s}1d`,
    `0x${r}${s}${v}00`,
  ]) {
    await rejected(await gate(req(b64({ ...good, signature })), ok), "voucher_invalid");
  }
  assert.equal(await store.get(`channel:43113:${CHANNEL}:${CHANNEL_ID}`) ?? null, null);
  assert.equal((await gate(req(b64({ ...good, signature: `0x${(r + s + v).toUpperCase()}` })), ok)).status, 200);
});

test("prepaid config validation", () => {
  const base = { network: "eip155:43113", asset: USDC, payTo: A("2"), seller: SELLER, priceAtomic: "1", facilitatorUrl: "https://f.example" };
  const p = { pricePerCallAtomic: "1", channelContract: CHANNEL, rpcUrl: "https://rpc.example" };
  assert.doesNotThrow(() => createX402Gate({ ...base, prepaid: p, store: createMemoryStore() }));
  assert.throws(() => createX402Gate({ ...base, prepaid: { ...p, pricePerCallAtomic: "0" } }));
  assert.throws(() => createX402Gate({ ...base, prepaid: { ...p, channelContract: "0x1" } }));
  assert.throws(() => createX402Gate({ ...base, prepaid: { ...p, rpcUrl: "http://evil.example" } }));
});

test("close: dry run lists, real run closes with the highest voucher and marks it", async () => {
  const { gate, store } = setup();
  await gate(req(await voucher(10000)), ok);
  await gate(req(await voucher(20000)), ok);
  let status = 1;
  const readChannel = async () => ({ buyer: buyer.address, seller: SELLER, status, deposit: 1_000_000n });
  const sent = [];
  const dry = await closeChannels({ store, chainId: 43113, channelContract: CHANNEL, seller: SELLER, readChannel, sendClose: async () => assert.fail("dry run must not send"), dryRun: true });
  assert.deepEqual(dry.wouldClose, [CHANNEL_ID]);
  const real = await closeChannels({ store, chainId: 43113, channelContract: CHANNEL, seller: SELLER, readChannel, sendClose: async (id, amt, sig) => (sent.push([id, amt, sig]), (status = 2), "0xtx") });
  assert.deepEqual(real.closed, [CHANNEL_ID]);
  assert.equal(sent[0][1], 20000n);
  assert.equal(sent[0][2], (await store.get(`channel:43113:${CHANNEL}:${CHANNEL_ID}`)).signature);
  const again = await closeChannels({ store, chainId: 43113, channelContract: CHANNEL, seller: SELLER, readChannel, sendClose: async () => assert.fail("already closed") });
  assert.deepEqual(again.skipped, [{ channelId: CHANNEL_ID, reason: "already_closed" }]);
});

test("rpc path: eth_call getChannel is encoded and decoded (fake JSON-RPC)", async () => {
  const { encodeFunctionResult, decodeFunctionData } = await import("viem");
  const { CHANNEL_ABI } = await import("../src/channel.mjs");
  const seen = [];
  const rpc = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body);
    if (body.method === "eth_chainId") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0xa869" }));
    const { args } = decodeFunctionData({ abi: CHANNEL_ABI, data: body.params[0].data });
    assert.equal(args[0], CHANNEL_ID);
    const result = encodeFunctionResult({ abi: CHANNEL_ABI, functionName: "getChannel", result: { buyer: buyer.address, seller: SELLER, token: USDC, deposit: 1_000_000n, closeRequestedAt: 0n, status: 1 } });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  };
  const gate = createX402Gate({
    network: "eip155:43113", asset: USDC, payTo: A("2"), seller: SELLER, priceAtomic: "10000", facilitatorUrl: "https://f.example",
    prepaid: { pricePerCallAtomic: "10000", channelContract: CHANNEL, rpcUrl: "https://rpc.example" }, store: createMemoryStore(), fetch: rpc,
  });
  assert.equal((await gate(req(await voucher(10000)), ok)).status, 200);
  assert.equal(seen[0].method, "eth_call");
  assert.equal(seen[0].params[0].to, CHANNEL);
  assert.equal(seen[0].params[1], "latest");
});
