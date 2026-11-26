// The closing Worker through viem, with a fake JSON-RPC that implements the calls a close makes and counts every request.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFunctionData, encodeFunctionResult, keccak256, parseTransaction } from "viem";
import { createStoreAdmin } from "../src/admin-store.mjs";
import { CHANNEL_ABI } from "../src/channel.mjs";
import { createMemoryStore } from "../src/store.mjs";
import { runCloser } from "../examples/worker-closer/closer.mjs";
import worker from "../examples/worker-closer/worker.mjs";
import { A, BUYER, channelGate, useVoucher, voucher } from "./fixtures/gates.mjs";

const SECRET = "test-store-secret-0123456789-0123456789";
const SELLER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // a public test key
const USDC = "0x5425890298aed601595a70AB815c96711a31Bc65";
const ENV = { NETWORK: "eip155:43113", RPC_URL: "https://rpc.example/key-in-the-path", CHANNEL_CONTRACT: A("c"), STORE_URL: "https://seller.example/__seller-store", STORE_SECRET: SECRET, SELLER_PRIVATE_KEY: KEY, MIN_AMOUNT: "1000000" };
const CABI = [...CHANNEL_ABI, { type: "function", name: "challengePeriod", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] }];
const RUN = 15 * 60 * 1000;

/** n channels, each with `calls` served calls; `requested` of them asked to close; a chain that mines (or not) every close it gets. */
async function world(n, { requested = n, calls = 2, mines = true } = {}) {
  const inner = createMemoryStore();
  const ids = Array.from({ length: n }, (_, i) => `0x${(i + 1).toString(16).padStart(64, "0")}`);
  const gate = channelGate(inner, { seller: SELLER, prepaid: { readChannel: async () => ({ buyer: BUYER, seller: SELLER, token: USDC, deposit: 1_000_000n, closeRequestedAt: 0n, status: 1 }) } });
  for (const id of ids) for (let i = 1; i <= calls; i++) assert.equal((await useVoucher(gate, await voucher(i * 10000, id))).status, 200);
  const admin = createStoreAdmin({ store: inner, secret: SECRET });
  const w = { ids, inner, nonce: 0, closed: new Map(), requests: 0, perRun: [], now: 2_000_000, pending: [] };
  const time = BigInt(w.now);
  // the asked ones in reverse order of their requests: the last channel asked first
  const channel = (id) => ({ buyer: BUYER, seller: SELLER, token: USDC, deposit: 1_000_000n, closeRequestedAt: ids.indexOf(id) < requested ? time - 1000n - BigInt(ids.indexOf(id)) : 0n, status: w.closed.has(id) ? 2 : 1 });
  const answer = ({ method, params }) => {
    switch (method) {
      case "eth_chainId": return "0xa869";
      case "eth_blockNumber": return "0x100";
      case "eth_getBlockByNumber": return { number: "0x100", timestamp: `0x${time.toString(16)}`, baseFeePerGas: "0x3b9aca00", hash: `0x${"1".repeat(64)}`, transactions: [] };
      case "eth_maxPriorityFeePerGas": return "0x3b9aca00";
      case "eth_estimateGas": return "0x186a0";
      case "eth_getTransactionCount": return `0x${w.nonce.toString(16)}`;
      case "eth_call": {
        const d = decodeFunctionData({ abi: CABI, data: params[0].data });
        if (d.functionName === "challengePeriod") return encodeFunctionResult({ abi: CABI, functionName: "challengePeriod", result: 86400n });
        return encodeFunctionResult({ abi: CABI, functionName: "getChannel", result: channel(d.args[0]) });
      }
      case "eth_sendRawTransaction": {
        const tx = parseTransaction(params[0]);
        const d = decodeFunctionData({ abi: CABI, data: tx.data });
        if (mines) {
          w.closed.set(d.args[0], d.args[1]);
          w.nonce++;
        } else w.pending.push(d.args[0]);
        return keccak256(params[0]);
      }
      case "eth_getTransactionReceipt": return mines ? { status: "0x1", transactionHash: params[0], logs: [], blockNumber: "0x100" } : null;
      default: throw new Error(`not faked: ${method}`);
    }
  };
  w.fetch = async (url, init) => {
    w.requests++;
    const routed = await admin(new Request(url, init));
    if (routed) return routed;
    const one = (body) => {
      try {
        return { jsonrpc: "2.0", id: body.id, result: answer(body) };
      } catch (e) {
        return { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: e.message } };
      }
    };
    const body = JSON.parse(init.body);
    if (Array.isArray(body)) {
      assert.ok(body.length <= 20, "batch size");
      return Response.json(body.map(one));
    }
    return Response.json(one(body));
  };
  w.run = async (env = {}) => {
    const before = w.requests;
    const r = await runCloser({ ...ENV, ...env }, { fetch: w.fetch, now: () => w.now });
    w.perRun.push(w.requests - before);
    w.now += RUN;
    return r;
  };
  return w;
}

test("every channel whose buyer asked is closed within as many runs as there are channels, oldest request first, with the voucher that was served", { timeout: 300_000 }, async () => {
  for (const n of [1, 2, 6, 30]) {
    const w = await world(n);
    let runs = 0;
    while (w.closed.size < n && runs < n + 1) {
      const r = await w.run();
      assert.ok(r.closed.length >= 1, `n=${n} run ${runs}: ${JSON.stringify({ ...r, skipped: undefined })}`);
      runs++;
    }
    assert.equal(w.closed.size, n, `n=${n} after ${runs} runs`);
    assert.ok(runs <= n, `n=${n}: ${runs} runs`);
    for (const amount of w.closed.values()) assert.equal(amount, 20000n); // exactly the served calls
    // the oldest request first among the 20 read in a run (30 channels: read in turn, 20 and then 10)
    if (n <= 20) assert.deepEqual([...w.closed.keys()].slice(0, Math.min(n, 3)), [...w.ids].reverse().slice(0, Math.min(n, 3)));
    assert.ok(Math.max(...w.perRun) <= 48, `n=${n}: ${w.perRun}`);
  }
});

test("channels nobody asked to close do not keep the asked ones waiting", { timeout: 120_000 }, async () => {
  const w = await world(12, { requested: 3 });
  for (let run = 0; run < 3; run++) await w.run();
  assert.equal(w.perRun.length, 3); // one requested channel per run
  assert.deepEqual([...w.closed.keys()], [w.ids[2], w.ids[1], w.ids[0]]); // the oldest request first, nobody else
  assert.ok(Math.max(...w.perRun) <= 48);
});

test("a close that is not mined in time stays within the budget, and the next run does not send it twice", { timeout: 400_000 }, async () => {
  const w = await world(2, { mines: false });
  for (let i = 0; i < 3; i++) await w.run({ WAIT_SECONDS: "30" });
  assert.ok(Math.max(...w.perRun) <= 48, String(w.perRun));
  for (const budget of ["46", "100"]) {
    const v = await world(1, { mines: false });
    await v.run({ MAX_SUBREQUESTS: budget, WAIT_SECONDS: "60" });
    assert.ok(v.perRun[0] <= Number(budget), `${budget}: ${v.perRun}`);
  }
  await assert.rejects(runCloser({ ...ENV, MAX_SUBREQUESTS: "45" }), /MAX_SUBREQUESTS/);
});

test("the log names no address and no request", async () => {
  const printed = [];
  const log = console.log;
  console.log = (...a) => printed.push(a.join(" "));
  try {
    for (const env of [ENV, { ...ENV, RPC_URL: "https://127.0.0.1:1/secret-provider-key" }]) {
      let done;
      await worker.scheduled({}, env, { waitUntil: (p) => (done = p) });
      await done;
    }
  } finally {
    console.log = log;
  }
  const text = printed.join("\n");
  assert.ok(printed.length >= 2);
  for (const secret of ["rpc.example", "key-in-the-path", "secret-provider-key", "127.0.0.1", "jsonrpc", KEY.slice(2, 20), SECRET]) assert.equal(text.includes(secret), false, text);
});

test("channels that reached the minimum are all reached too, also while the index shrinks", { timeout: 120_000 }, async () => {
  const w = await world(10, { requested: 0, calls: 2 });
  for (let run = 0; run < 12 && w.closed.size < 10; run++) await w.run({ MIN_AMOUNT: "20000" });
  assert.equal(w.closed.size, 10);
  assert.ok(Math.max(...w.perRun) <= 48);
});
