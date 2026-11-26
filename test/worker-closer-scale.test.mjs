// The closing Worker at its default budget against a fake JSON-RPC that counts every request and keeps a clock: many channels, stale
// requests, a refused batch.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFunctionData, encodeFunctionResult, keccak256, parseTransaction } from "viem";
import { createStoreAdmin } from "../src/admin-store.mjs";
import { CHANNEL_ABI } from "../src/channel.mjs";
import { createMemoryStore } from "../src/store.mjs";
import { runCloser } from "../examples/worker-closer/closer.mjs";
import { A, BUYER, channelGate, useVoucher, voucher } from "./fixtures/gates.mjs";

const SECRET = "test-store-secret-0123456789-0123456789";
const SELLER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const USDC = "0x5425890298aed601595a70AB815c96711a31Bc65";
const ENV = { NETWORK: "eip155:43113", RPC_URL: "https://rpc.example/", CHANNEL_CONTRACT: A("c"), STORE_URL: "https://seller.example/__seller-store", STORE_SECRET: SECRET, SELLER_PRIVATE_KEY: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", MIN_AMOUNT: "1000000" };
const CABI = [...CHANNEL_ABI, { type: "function", name: "challengePeriod", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] }];
const PERIOD = 86_400n;
const RUN = 900n;

/** n channels with one served call each; a chain with a clock (seconds), requests at given times, and closes mined at once. */
async function world(n, { batch = true } = {}) {
  const inner = createMemoryStore();
  const ids = Array.from({ length: n }, (_, i) => `0x${(i + 1).toString(16).padStart(64, "0")}`);
  const gate = channelGate(inner, { seller: SELLER, prepaid: { readChannel: async () => ({ buyer: BUYER, seller: SELLER, token: USDC, deposit: 1_000_000n, closeRequestedAt: 0n, status: 1 }) } });
  for (const id of ids) assert.equal((await useVoucher(gate, await voucher(10000, id))).status, 200);
  const admin = createStoreAdmin({ store: inner, secret: SECRET });
  const w = { ids, inner, now: 10_000_000n, nonce: 0, requested: new Map(), closed: new Map(), withdrawn: new Set(), requests: 0, perRun: [], warnings: new Set() };
  const status = (id) => (w.closed.has(id) || w.withdrawn.has(id) ? 2 : 1);
  const answer = ({ method, params }) => {
    switch (method) {
      case "eth_chainId": return "0xa869";
      case "eth_blockNumber": return "0x100";
      case "eth_getBlockByNumber": return { number: "0x100", timestamp: `0x${w.now.toString(16)}`, baseFeePerGas: "0x3b9aca00", hash: `0x${"1".repeat(64)}`, transactions: [] };
      case "eth_maxPriorityFeePerGas": return "0x3b9aca00";
      case "eth_estimateGas": return "0x186a0";
      case "eth_getTransactionCount": return `0x${w.nonce.toString(16)}`;
      case "eth_call": {
        const d = decodeFunctionData({ abi: CABI, data: params[0].data });
        if (d.functionName === "challengePeriod") return encodeFunctionResult({ abi: CABI, functionName: "challengePeriod", result: PERIOD });
        const id = d.args[0];
        return encodeFunctionResult({ abi: CABI, functionName: "getChannel", result: { buyer: BUYER, seller: SELLER, token: USDC, deposit: 1_000_000n, closeRequestedAt: w.requested.get(id) ?? 0n, status: status(id) } });
      }
      case "eth_sendRawTransaction": {
        const d = decodeFunctionData({ abi: CABI, data: parseTransaction(params[0]).data });
        const asked = w.requested.get(d.args[0]);
        if (asked === undefined || w.now < asked + PERIOD) {
          w.closed.set(d.args[0], { amount: d.args[1], at: w.now });
          w.nonce++;
        }
        return keccak256(params[0]);
      }
      case "eth_getTransactionReceipt": return { status: "0x1", transactionHash: params[0], logs: [], blockNumber: "0x100" };
      default: throw new Error(`not faked: ${method}`);
    }
  };
  w.fetch = async (url, init) => {
    w.requests++;
    const routed = await admin(new Request(url, init));
    if (routed) return routed;
    const body = JSON.parse(init.body);
    if (Array.isArray(body)) {
      if (!batch) return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "batch requests are not allowed" } });
      assert.ok(body.length <= 20);
      return Response.json(body.map((b) => ({ jsonrpc: "2.0", id: b.id, result: answer(b) })));
    }
    return Response.json({ jsonrpc: "2.0", id: body.id, result: answer(body) });
  };
  w.run = async () => {
    const before = w.requests;
    const r = await runCloser(ENV, { fetch: w.fetch, now: () => Number(w.now) * 1000 });
    w.perRun.push(w.requests - before);
    for (const x of r.warnings) w.warnings.add(x);
    w.now += RUN;
    return r;
  };
  return w;
}
const budgetKept = (w) => assert.ok(Math.max(...w.perRun) <= 48, String(Math.max(...w.perRun)));

test("requests whose window is over do not block the others: each closable one is closed, the stale ones leave the index", async () => {
  const w = await world(6);
  for (const i of [4, 5]) w.requested.set(w.ids[i], w.now - PERIOD - 1000n - BigInt(i)); // the oldest requests, already over
  for (const i of [0, 1, 2, 3]) w.requested.set(w.ids[i], w.now - 1000n - BigInt(i));
  for (let run = 0; run < 6; run++) await w.run();
  assert.deepEqual(new Set(w.closed.keys()), new Set(w.ids.slice(0, 4)));
  for (const { amount } of w.closed.values()) assert.equal(amount, 10000n);
  const index = await w.inner.get(`channels:43113:${A("c")}`);
  for (const id of [...w.ids.slice(0, 6)]) assert.equal(index.includes(id), false, id);
  budgetKept(w);
});

test("the soonest window first", async () => {
  const w = await world(5);
  const asked = [3, 0, 4].map((i, k) => [w.ids[i], w.now - 1000n * BigInt(k + 1)]);
  for (const [id, at] of asked) w.requested.set(id, at);
  for (let run = 0; run < 3; run++) await w.run();
  assert.deepEqual([...w.closed.keys()], [w.ids[4], w.ids[0], w.ids[3]]);
});

test("1,000 indexed channels at the default budget: every request is closed within its window", { timeout: 600_000 }, async () => {
  const w = await world(1000);
  // forty requests at different times, a burst of ten at once among them
  let seed = 7;
  const rand = (k) => (seed = (seed * 1103515245 + 12345) % 2147483648) % k;
  const plan = [];
  for (let k = 0; k < 30; k++) plan.push([rand(1000), BigInt(rand(60))]);
  for (let k = 0; k < 10; k++) plan.push([rand(1000), 20n]);
  for (let run = 0n; run < 140n; run++) {
    for (const [i, at] of plan) if (at === run && !w.requested.has(w.ids[i])) w.requested.set(w.ids[i], w.now);
    await w.run();
    if (run > 60n && [...w.requested.keys()].every((id) => w.closed.has(id))) break;
  }
  for (const [id, at] of w.requested) {
    assert.ok(w.closed.has(id), `${id} not closed`);
    assert.ok(w.closed.get(id).at < at + PERIOD, `${id} closed after its window`);
  }
  budgetKept(w);
  assert.equal(w.warnings.has("index_too_large_for_budget"), false);
});

test("a refused batch: read one by one as far as the budget goes, said in the warnings, and still closed", async () => {
  const w = await world(6, { batch: false });
  for (const i of [1, 4]) w.requested.set(w.ids[i], w.now - 10n * BigInt(i));
  for (let run = 0; run < 6 && w.closed.size < 2; run++) await w.run();
  assert.deepEqual(new Set(w.closed.keys()), new Set([w.ids[1], w.ids[4]]));
  assert.ok(w.warnings.has("batch_refused"));
  budgetKept(w);
});

test("a budget too small for one whole run is refused at the start", async () => {
  await assert.rejects(runCloser({ ...ENV, MAX_SUBREQUESTS: "45" }), /MAX_SUBREQUESTS must be at least 46/);
});
