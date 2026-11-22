#!/usr/bin/env node
// Close prepaid channels with the highest stored voucher (testnet only).
//   node bin/close-channels.mjs --dry-run      list what would be closed (no key needed)
//   SELLER_PRIVATE_KEY=0x... node bin/close-channels.mjs
// Env: STORE_PATH, RPC_URL, CHANNEL_CONTRACT, NETWORK (eip155:43113), SELLER_PRIVATE_KEY. The key is never printed.
import { createPublicClient, createWalletClient, defineChain, getAddress, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHANNEL_ABI } from "../src/channel.mjs";
import { closeChannels } from "../src/close.mjs";
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
const store = createFileStore(env.STORE_PATH ?? "./seller-kit-store.json");

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
const wallet = account ? createWalletClient({ account, chain, transport: http(rpcUrl) }) : null;

const result = await closeChannels({
  store,
  seller: sellerAddress,
  dryRun,
  log: (line) => console.log(line),
  readChannel: async (channelId) => {
    const r = await publicClient.readContract({ address: channelContract, abi: CHANNEL_ABI, functionName: "getChannel", args: [channelId] });
    return { ...r, status: Number(r.status), deposit: BigInt(r.deposit) };
  },
  sendClose: async (channelId, cumulativeAmount, signature) => {
    const hash = await wallet.writeContract({ address: channelContract, abi: CHANNEL_ABI, functionName: "close", args: [channelId, cumulativeAmount, signature] });
    await publicClient.waitForTransactionReceipt({ hash });
    return hash;
  },
});

console.log(JSON.stringify({ dryRun, closed: result.closed.length, wouldClose: result.wouldClose.length, skipped: result.skipped, failed: result.failed }));
if (result.failed.length) process.exit(2);
