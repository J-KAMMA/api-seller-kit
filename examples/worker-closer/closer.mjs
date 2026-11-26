// Closes the prepaid channels of a seller Worker on a timer (testnet only). The seller key is a secret of THIS Worker: use a key that only
// receives earnings. The vouchers stay in the seller Worker; this one reads and claims them through its admin route.
//
// Each run: channels whose buyer asked to close (most urgent first), and channels whose stored amount reached MIN_AMOUNT. A run stops starting
// new work when its subrequest budget is nearly used; what is left is done by the next run. A run that is cut off anywhere is finished by
// a later one: the transaction is stored before it is sent, and the chain decides (see src/close.mjs).
import { createPublicClient, defineChain, getAddress, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createRemoteStore } from "../../src/admin-store.mjs";
import { createCloseChain } from "../../src/close-chain.mjs";
import { closeChannels } from "../../src/close.mjs";
import { settledDepth } from "../../src/networks.mjs";

const TESTNETS = { "eip155:43113": 43113, "eip155:84532": 84532 };
/** Requests one channel needs at most: reads and claims, the transaction, and the waiting (one look every POLL_MS). */
const POLL_MS = 5_000;
const perChannel = (waitMs) => 20 + 3 * Math.ceil(waitMs / POLL_MS);

/** Throws with a message that names the setting, never its value. */
export function settings(env) {
  const bad = (m) => {
    throw new Error(`worker-closer: ${m}`);
  };
  const network = env.NETWORK ?? "eip155:43113";
  const local = env.ALLOW_LOCAL_DEV_NETWORK === "true" && network === "eip155:31337"; // tests on this machine only
  const chainId = TESTNETS[network] ?? (local ? 31337 : bad("NETWORK must be eip155:43113 or eip155:84532 (testnet only)"));
  let rpc;
  try {
    rpc = new URL(env.RPC_URL);
  } catch {
    bad("RPC_URL missing or invalid");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(rpc.hostname);
  if (rpc.protocol !== "https:" && !(local && loopback)) bad("RPC_URL must be https");
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(env.CHANNEL_CONTRACT))) bad("CHANNEL_CONTRACT must be a 0x address");
  if (!/^https:\/\/[^/]+(\/.*)?\/__seller-store$/.test(String(env.STORE_URL)) && !(local && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/__seller-store$/.test(String(env.STORE_URL)))) {
    bad("STORE_URL must be the https address of the seller Worker's /__seller-store");
  }
  if (typeof env.STORE_SECRET !== "string" || env.STORE_SECRET.length < 32) bad("STORE_SECRET must be a secret of 32+ characters");
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(env.SELLER_PRIVATE_KEY))) bad("SELLER_PRIVATE_KEY must be a 0x 32-byte hex secret");
  const whole = (name, fallback, max) => {
    const v = env[name] ?? String(fallback);
    if (!/^\d{1,30}$/.test(v) || (max !== undefined && Number(v) > max)) bad(`${name} must be a whole number${max === undefined ? "" : ` up to ${max}`}`);
    return v;
  };
  const waitMs = Number(whole("WAIT_SECONDS", 30, 120)) * 1000; // per transaction, within one run
  return {
    network, chainId, rpcUrl: rpc.href, channelContract: getAddress(env.CHANNEL_CONTRACT), storeUrl: env.STORE_URL,
    waitMs,
    maxFeePerGas: BigInt(whole("MAX_FEE_GWEI", 200)) * 1_000_000_000n,
    minAmountAtomic: BigInt(whole("MIN_AMOUNT", 0)),
    drainMs: Number(whole("DRAIN_SECONDS", 0, 60)) * 1000,
    subrequests: Number(whole("MAX_SUBREQUESTS", 45, 1000)), // 50 a run on the free plan
  };
}

/**
 * One run. deps (tests): { chain, store, fetch }. Returns the result of closeChannels, without anything secret.
 * @param {Record<string,string>} env
 */
export async function runCloser(env, deps = {}) {
  const s = settings(env);
  let used = 0;
  const counted = async (input, init) => {
    used++;
    return (deps.fetch ?? globalThis.fetch)(input, init);
  };
  const account = privateKeyToAccount(env.SELLER_PRIVATE_KEY);
  let chain = deps.chain;
  if (!chain) {
    const viemChain = defineChain({ id: s.chainId, name: `chain-${s.chainId}`, nativeCurrency: { name: "Native", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [s.rpcUrl] } } });
    const publicClient = createPublicClient({ chain: viemChain, transport: http(s.rpcUrl, { fetchFn: counted, retryCount: 0 }) });
    if (Number(await publicClient.getChainId()) !== s.chainId) throw new Error("worker-closer: RPC_URL is on another chain than NETWORK");
    chain = createCloseChain({ publicClient, account, channelContract: s.channelContract, chainId: s.chainId, maxFeePerGas: s.maxFeePerGas, waitMs: s.waitMs, pollMs: POLL_MS, depth: settledDepth(s.network) });
  }
  // A seller Worker on the same Cloudflare account cannot be reached through its public address: bind it as SELLER_WORKER instead.
  const binding = env.SELLER_WORKER && typeof env.SELLER_WORKER.fetch === "function" ? env.SELLER_WORKER : null;
  const storeFetch = binding ? async (input, init) => (used++, binding.fetch(input, init)) : counted;
  const store = deps.store ?? createRemoteStore(s.storeUrl, env.STORE_SECRET, { fetch: storeFetch });
  const reserve = perChannel(s.waitMs);
  const result = await closeChannels({
    store,
    chainId: s.chainId,
    channelContract: s.channelContract,
    seller: account.address,
    onlyRequested: true,
    minAmountAtomic: s.minAmountAtomic,
    drainMs: s.drainMs,
    challengeSeconds: await chain.challengeSeconds(),
    chainTime: chain.chainTime,
    readChannel: chain.readChannel,
    settledChannel: chain.settledChannel,
    snapshot: chain.snapshot,
    sendClose: chain.sendClose,
    // Stop before a channel could run out of requests half way: it is safe, but it is wasted.
    shouldContinue: () => used + reserve <= s.subrequests,
  });
  return { ...result, subrequests: used };
}
