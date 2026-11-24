#!/usr/bin/env node
// Close prepaid channels with the highest stored voucher (testnet only).
//   node bin/close-channels.mjs --dry-run      list what would be closed (no key needed)
//   SELLER_PRIVATE_KEY=0x... node bin/close-channels.mjs
//   ... --only-requested                        only channels whose buyer asked to close, the most urgent first (for a timer)
// Env: STORE_PATH, or STORE_URL + STORE_SECRET for a Worker; RPC_URL, CHANNEL_CONTRACT, NETWORK (eip155:43113), SELLER_PRIVATE_KEY.
// Optional: DRAIN_SECONDS (60) for running calls to end, WAIT_SECONDS (120) per transaction, MAX_FEE_GWEI (200), MIN_AMOUNT (0, atomic). Secrets are never printed.
import { createPublicClient, defineChain, getAddress, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createRemoteStore } from "../src/admin-store.mjs";
import { createCloseChain } from "../src/close-chain.mjs";
import { closeChannels } from "../src/close.mjs";
import { settledDepth } from "../src/networks.mjs";
import { createFileStore } from "../src/store.mjs";

const env = process.env;
const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const fail = (m) => {
  console.error(m);
  process.exit(1);
};
const need = (k) => env[k] || fail(`missing env ${k}`);

const network = env.NETWORK ?? "eip155:43113";
if (!/^eip155:\d{1,12}$/.test(network)) fail("NETWORK invalid");
const chainId = Number(network.split(":")[1]);
if (![43113, 84532, 31337].includes(chainId)) fail("testnet only (43113, 84532; 31337 for a local chain)");
const rpcUrl = need("RPC_URL");
const channelContract = getAddress(need("CHANNEL_CONTRACT"));
const store = env.STORE_URL ? createRemoteStore(env.STORE_URL, need("STORE_SECRET")) : createFileStore(env.STORE_PATH ?? "./seller-kit-store.json");
const seconds = (k, fallback) => {
  const v = env[k] ?? String(fallback);
  return /^\d{1,6}$/.test(v) ? Number(v) : fail(`${k} must be whole seconds`);
};
const drainMs = seconds("DRAIN_SECONDS", 60) * 1000;
const waitMs = seconds("WAIT_SECONDS", 120) * 1000;
if (!/^\d{1,6}$/.test(env.MAX_FEE_GWEI ?? "200")) fail("MAX_FEE_GWEI must be a whole number");
if (!/^\d{1,30}$/.test(env.MIN_AMOUNT ?? "0")) fail("MIN_AMOUNT must be whole atomic units");
for (const a of args) if (!["--dry-run", "--only-requested"].includes(a)) fail(`unknown argument ${a}`);
const maxFeePerGas = BigInt(env.MAX_FEE_GWEI ?? "200") * 1_000_000_000n;

const chain = defineChain({
  id: chainId,
  name: `chain-${chainId}`,
  nativeCurrency: { name: "Native", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

let account = null;
if (!dryRun) {
  const key = need("SELLER_PRIVATE_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) fail("SELLER_PRIVATE_KEY must be a 0x 32-byte hex"); // the value itself is never echoed
  account = privateKeyToAccount(key);
}
const sellerAddress = account?.address ?? (env.SELLER ? getAddress(env.SELLER) : null);
if (!sellerAddress) fail("dry run needs env SELLER (the seller address)");
if (Number(await publicClient.getChainId()) !== chainId) fail("RPC_URL is on another chain than NETWORK");

const onChain = createCloseChain({ publicClient, account, channelContract, chainId, maxFeePerGas, waitMs, depth: settledDepth(network) });
const result = await closeChannels({
  store,
  chainId,
  channelContract,
  seller: sellerAddress,
  dryRun,
  drainMs,
  onlyRequested: args.has("--only-requested"),
  minAmountAtomic: BigInt(env.MIN_AMOUNT ?? "0"),
  challengeSeconds: await onChain.challengeSeconds(),
  chainTime: onChain.chainTime,
  log: (line) => console.log(line),
  readChannel: onChain.readChannel,
  settledChannel: onChain.settledChannel,
  snapshot: onChain.snapshot,
  sendClose: onChain.sendClose,
});

console.log(
  JSON.stringify({ dryRun, closed: result.closed.length, wouldClose: result.wouldClose.length, skipped: result.skipped, failed: result.failed, drainTimedOut: result.drainTimedOut }),
);
if (result.failed.length) process.exit(2);
