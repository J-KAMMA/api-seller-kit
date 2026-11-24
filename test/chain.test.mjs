// Closing against a real local chain (anvil, public test keys). Skipped when anvil is not installed.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { after, before, test } from "node:test";
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { closeChannels } from "../src/close.mjs";
import { createX402Gate } from "../src/index.mjs";
import { createMemoryStore } from "../src/store.mjs";

const skip = spawnSync("anvil", ["--version"]).status !== 0 && "anvil is not installed";
const { createCloseChain } = await import("../src/close-chain.mjs").catch(() => ({}));
const art = JSON.parse(readFileSync(new URL("./fixtures/contracts.json", import.meta.url), "utf8"));
const KEYS = ["0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"];
const HOUR = 3_600_000;
const GWEI = 1_000_000_000n;
let anvil, rpc, pub, seller, buyer, usdc, channel;
const wait = (hash) => pub.waitForTransactionReceipt({ hash });
const deploy = async (a, args = []) => (await wait(await seller.deployContract({ abi: a.abi, bytecode: a.bytecode, args }))).contractAddress;
const rpcCall = (method, params = []) => pub.request({ method, params });
const balance = (who) => pub.readContract({ address: usdc, abi: art.usdc.abi, functionName: "balanceOf", args: [who] });

before(async () => {
  if (skip) return;
  const port = await new Promise((r) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => r(p));
    });
  });
  anvil = spawn("anvil", ["--port", String(port), "--silent"], { stdio: "ignore" });
  rpc = `http://127.0.0.1:${port}`;
  const chain = defineChain({ id: 31337, name: "local", nativeCurrency: { name: "e", symbol: "E", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  pub = createPublicClient({ chain, transport: http(rpc), pollingInterval: 50 });
  for (let i = 0; i < 100; i++) {
    if (await pub.getBlockNumber().catch(() => null)) break;
    if ((await pub.getBlockNumber().catch(() => null)) === 0n) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  [seller, buyer] = KEYS.map((k) => createWalletClient({ account: privateKeyToAccount(k), chain, transport: http(rpc) }));
  usdc = await deploy(art.usdc);
  channel = await deploy(art.channel, ["0x000000000000000000000000000000000000fee1", 86400n, [usdc], [10n ** 12n]]);
  await wait(await seller.writeContract({ address: usdc, abi: art.usdc.abi, functionName: "mint", args: [buyer.account.address, 10n ** 12n] }));
  await wait(await buyer.writeContract({ address: usdc, abi: art.usdc.abi, functionName: "approve", args: [channel, 10n ** 12n] }));
});
after(() => anvil?.kill());

/** A fresh channel with calls already paid. */
async function setup(calls = 2) {
  const store = createMemoryStore();
  const id = await pub.readContract({ address: channel, abi: art.channel.abi, functionName: "nextChannelId", args: [buyer.account.address, seller.account.address, usdc] });
  await wait(await buyer.writeContract({ address: channel, abi: art.channel.abi, functionName: "open", args: [seller.account.address, usdc, 1_000_000n] }));
  const gateOn = (s) =>
    createX402Gate({
      network: "eip155:31337", allowLocalDevNetwork: true, asset: usdc, payTo: usdc, seller: seller.account.address, priceAtomic: "1",
      facilitatorUrl: "http://127.0.0.1:1", resource: "https://api.example/x", store: s,
      prepaid: { pricePerCallAtomic: "10000", channelContract: channel, rpcUrl: rpc },
    });
  const call = async (amount, s = store) => {
    const signature = await buyer.signTypedData({
      domain: { name: "ApiPaymentChannel", version: "1", chainId: 31337, verifyingContract: channel },
      types: { Voucher: [{ name: "channelId", type: "bytes32" }, { name: "cumulativeAmount", type: "uint256" }] },
      primaryType: "Voucher",
      message: { channelId: id, cumulativeAmount: BigInt(amount) },
    });
    const header = Buffer.from(JSON.stringify({ channelId: id, cumulativeAmount: String(amount), signature })).toString("base64");
    return (await gateOn(s)(new Request("https://api.example/x", { headers: { "hub-channel-voucher": header } }), async () => new Response("ok"))).status;
  };
  for (let i = 1; i <= calls; i++) assert.equal(await call(i * 10000), 200);
  const key = `channel:31337:${channel.toLowerCase()}:${id.toLowerCase()}`;
  return { store, id, key, call };
}
const run = (store, { client = pub, account = seller.account, cap = 1000n * GWEI, waitMs = 600, ...extra } = {}) => {
  const c = createCloseChain({ publicClient: client, account, channelContract: channel, chainId: 31337, maxFeePerGas: cap, waitMs, pollMs: 50 });
  return closeChannels({ store, chainId: 31337, channelContract: channel, seller: seller.account.address, readChannel: c.readChannel, settledChannel: c.settledChannel, snapshot: c.snapshot, sendClose: c.sendClose, ...extra });
};
const paused = async (fn) => {
  await rpcCall("evm_setAutomine", [false]);
  try {
    return await fn();
  } finally {
    await rpcCall("evm_setAutomine", [true]);
    await rpcCall("evm_mine");
  }
};
const age = async (ctx, ms = 5 * HOUR) => {
  const rec = await ctx.store.get(ctx.key);
  await ctx.store.set(ctx.key, { ...rec, closing: { ...rec.closing, at: rec.closing.at - ms } });
};
const closing = async (ctx) => (await ctx.store.get(ctx.key)).closing;
const reasons = (out) => out.failed.map((f) => f.reason);
async function assertPaid(ctx, beforeBalance, amount = 20000n) {
  assert.equal((await ctx.store.get(ctx.key)).closed, true);
  assert.equal((await balance(seller.account.address)) - beforeBalance, amount - amount / 100n);
}

test("plain close: the transaction is stored before it is sent, the channel is paid once", { skip }, async () => {
  const ctx = await setup();
  const b = await balance(seller.account.address);
  let stored;
  const client = { ...pub, sendRawTransaction: async (a) => ((stored = await closing(ctx)), pub.sendRawTransaction(a)) };
  const out = await run(ctx.store, { client, waitMs: 10_000 });
  assert.deepEqual([out.closed, out.failed], [[ctx.id.toLowerCase()], []]);
  assert.equal(stored.phase, "sent");
  assert.match(stored.tx.hash, /^0x[0-9a-f]{64}$/);
  assert.equal(stored.tx.from, seller.account.address.toLowerCase());
  assert.equal(JSON.stringify(stored).includes(KEYS[0].slice(2)), false);
  await assertPaid(ctx, b);
  assert.deepEqual((await run(ctx.store)).skipped.map((s) => s.reason), ["already_closed"]);
});

test("stuck in the mempool: no amount of time reopens the channel; the next run replaces it with the same nonce", { skip }, async () => {
  const ctx = await setup();
  const b = await balance(seller.account.address);
  await paused(async () => {
    assert.deepEqual(reasons(await run(ctx.store)), ["close_unconfirmed"]);
    const first = (await closing(ctx)).tx;
    for (let i = 0; i < 3; i++) {
      await age(ctx, 1000 * HOUR);
      assert.equal(await ctx.call(30000), 402);
    }
    assert.deepEqual(reasons(await run(ctx.store)), ["close_unconfirmed"]);
    const second = (await closing(ctx)).tx;
    assert.equal(second.nonce, first.nonce);
    assert.notEqual(second.hash, first.hash);
    assert.ok(BigInt(second.maxFeePerGas) * 100n >= BigInt(first.maxFeePerGas) * 110n);
    // at the cap: exactly the same transaction again, never above it
    assert.deepEqual(reasons(await run(ctx.store, { cap: BigInt(second.maxFeePerGas) })), ["close_unconfirmed"]);
    assert.equal((await closing(ctx)).tx.hash, second.hash);
    const pool = await rpcCall("txpool_content");
    const own = Object.entries(pool.pending).find(([a]) => a.toLowerCase() === seller.account.address.toLowerCase())[1];
    assert.deepEqual(Object.values(own).map((t) => t.hash), [second.hash]);
    assert.equal(await ctx.call(30000), 402);
  });
  assert.deepEqual((await run(ctx.store)).skipped.map((s) => s.reason), ["not_open_on_chain"]);
  await assertPaid(ctx, b);
});

test("dropped from the mempool: stays closed to calls, sent again with the same nonce", { skip }, async () => {
  const ctx = await setup();
  const b = await balance(seller.account.address);
  let first;
  await paused(async () => {
    await run(ctx.store);
    first = (await closing(ctx)).tx;
    await rpcCall("anvil_dropTransaction", [first.hash]);
    await age(ctx);
    assert.equal(await ctx.call(30000), 402); // any node may still hold it
  });
  const out = await run(ctx.store, { waitMs: 10_000 });
  assert.equal(out.closed.length, 1);
  await assertPaid(ctx, b);
  assert.equal(await pub.getTransactionCount({ address: seller.account.address }), first.nonce + 1);
});

test("replaced by another transaction of the seller: proven dead, the next run closes with a new nonce", { skip }, async () => {
  const ctx = await setup();
  const b = await balance(seller.account.address);
  await paused(async () => {
    await run(ctx.store);
    const { tx } = await closing(ctx);
    await seller.sendTransaction({ to: buyer.account.address, value: 1n, nonce: tx.nonce, maxFeePerGas: BigInt(tx.maxFeePerGas) * 3n, maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas) * 3n });
  });
  assert.equal(await ctx.call(30000), 402);
  const out = await run(ctx.store, { waitMs: 10_000 });
  assert.deepEqual([out.closed.length, out.failed], [1, []]);
  await assertPaid(ctx, b);
});

test("replaced while waiting: not mistaken for our own success, released", { skip }, async () => {
  const ctx = await setup();
  let out;
  await rpcCall("evm_setAutomine", [false]);
  try {
    const running = run(ctx.store, { waitMs: 8_000 });
    while ((await closing(ctx))?.phase !== "sent") await new Promise((r) => setTimeout(r, 20));
    const { tx } = await closing(ctx);
    await new Promise((r) => setTimeout(r, 200));
    await seller.sendTransaction({ to: buyer.account.address, value: 1n, nonce: tx.nonce, maxFeePerGas: BigInt(tx.maxFeePerGas) * 3n, maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas) * 3n });
    await rpcCall("evm_mine");
    out = await running;
  } finally {
    await rpcCall("evm_setAutomine", [true]);
  }
  assert.deepEqual([out.closed, reasons(out)], [[], ["close_failed"]]);
  assert.equal(await closing(ctx), undefined);
  assert.equal(await ctx.call(30000), 200);
});

test("reverted: released, calls go on, the next run closes with the newer voucher", { skip }, async () => {
  const ctx = await setup();
  const b = await balance(seller.account.address);
  const poor = { ...seller.account, signTransaction: (t) => seller.account.signTransaction({ ...t, gas: 60_000n }) };
  const out = await run(ctx.store, { account: poor, waitMs: 10_000 });
  assert.deepEqual([out.closed, reasons(out)], [[], ["close_failed"]]);
  assert.equal(await closing(ctx), undefined);
  assert.equal(await ctx.call(30000), 200);
  assert.equal((await run(ctx.store, { waitMs: 10_000 })).closed.length, 1);
  await assertPaid(ctx, b, 30000n);
});

test("fee above the cap: nothing is sent, released", { skip }, async () => {
  const ctx = await setup();
  const out = await run(ctx.store, { cap: 1n });
  assert.deepEqual(reasons(out), ["fee_above_cap"]);
  assert.equal(await ctx.call(30000), 200);
});

test("the process dies at each step: never reopened while a transaction may be out, always finished by the next run", { skip }, async () => {
  class Died extends Error {}
  const never = () => new Promise(() => {});
  const steps = {
    "after the claim": { client: (die) => ({ ...pub, estimateFeesPerGas: die }), broadcast: false },
    "signed and stored, not broadcast": { client: (die) => ({ ...pub, sendRawTransaction: die }), broadcast: false, sent: true },
    "broadcast": { client: (die) => ({ ...pub, sendRawTransaction: async (a) => (await pub.sendRawTransaction(a), die()) }), broadcast: true, sent: true },
  };
  for (const [name, step] of Object.entries(steps)) {
    const ctx = await setup();
    const b = await balance(seller.account.address);
    await paused(async () => {
      let died;
      const dead = new Promise((r) => (died = r));
      void run(ctx.store, { client: step.client(() => (died(), never())), waitMs: 50 }).catch((e) => assert.ok(e instanceof Died));
      await dead; // the run hangs here for good, like a killed process
      assert.equal((await closing(ctx)).phase, step.sent ? "sent" : "claimed", name);
      assert.equal(await ctx.call(30000), 402, name);
      await age(ctx, 1000 * HOUR);
      if (step.sent) assert.equal(await ctx.call(30000), 402, name);
    });
    if (step.sent) {
      const out = await run(ctx.store, { waitMs: 10_000 });
      assert.equal(out.failed.length, 0, name);
      await assertPaid(ctx, b);
    } else {
      assert.equal(await ctx.call(30000), 200, name); // nothing was broadcast: releasable by time
      assert.equal((await run(ctx.store, { waitMs: 10_000 })).closed.length, 1, name);
      await assertPaid(ctx, b, 30000n);
    }
  }
  // mined, but died before the mark
  const ctx = await setup();
  const b = await balance(seller.account.address);
  let mined;
  const done = new Promise((r) => (mined = r));
  void run(ctx.store, { client: { ...pub, getTransactionReceipt: () => (mined(), never()) }, waitMs: 10_000 });
  await done;
  await age(ctx, 1000 * HOUR);
  assert.equal(await ctx.call(30000), 402);
  assert.deepEqual((await run(ctx.store)).skipped.map((s) => s.reason), ["not_open_on_chain"]);
  await assertPaid(ctx, b);
});

test("the node refuses or loses the broadcast: not released on a guess", { skip }, async () => {
  const ctx = await setup();
  const b = await balance(seller.account.address);
  // accepted, but the answer is lost
  await paused(async () => {
    const client = { ...pub, sendRawTransaction: async (a) => (await pub.sendRawTransaction(a), Promise.reject(new Error("connection reset"))) };
    assert.deepEqual(reasons(await run(ctx.store, { client })), ["close_unconfirmed"]);
    assert.equal(await ctx.call(30000), 402);
  });
  await run(ctx.store);
  await assertPaid(ctx, b);
});

test("two runs at once: one payment, nothing left claimed", { skip }, async () => {
  for (let i = 0; i < 3; i++) {
    const ctx = await setup();
    const b = await balance(seller.account.address);
    await Promise.all([run(ctx.store, { waitMs: 5_000 }), run(ctx.store, { waitMs: 5_000 })]);
    await run(ctx.store, { waitMs: 5_000 });
    await assertPaid(ctx, b);
  }
});
