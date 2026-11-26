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
import { CHANNEL_ABI } from "../../src/channel.mjs";
import { settledDepth } from "../../src/networks.mjs";
import { channelKeys, LEGACY_KEYS } from "../../src/voucher-record.mjs";

const TESTNETS = { "eip155:43113": 43113, "eip155:84532": 84532 };
const POLL_MS = 5_000;
/** Requests (chain and store) that looking at one channel can take, and closing it without the waiting; measured with the fake RPC of the tests. */
export const LOOK_COST = 4;
/** Channels read from the chain in one request (a JSON-RPC batch), to know which ones are due. */
const BATCH = 20;
export const CLOSE_COST = 24;
/** What a close needs after its last look while waiting: the checks of the outcome and the mark. */
const AFTER_WAIT = 8;
const RUN_MS = 15 * 60 * 1000;
void channelKeys, void LEGACY_KEYS;

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
    // a close must fit in a run whatever else happens in it
    ...(Number(env.MAX_SUBREQUESTS ?? 45) < LOOK_COST + CLOSE_COST + 8 ? bad("MAX_SUBREQUESTS must be at least 36") : {}),
  };
}

/**
 * One run. deps (tests): { chain, store, fetch, now }. Returns the result of closeChannels, without anything secret.
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
  let readAll = null; // all channels' state in few requests
  if (!chain) {
    const viemChain = defineChain({ id: s.chainId, name: `chain-${s.chainId}`, nativeCurrency: { name: "Native", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [s.rpcUrl] } } });
    const publicClient = createPublicClient({ chain: viemChain, transport: http(s.rpcUrl, { fetchFn: counted, retryCount: 0 }) });
    const batched = createPublicClient({ chain: viemChain, transport: http(s.rpcUrl, { fetchFn: counted, retryCount: 0, batch: { batchSize: BATCH, wait: 0 } }) });
    readAll = async (ids) => {
      const states = await Promise.all(ids.map((id) => batched.readContract({ address: s.channelContract, abi: CHANNEL_ABI, functionName: "getChannel", args: [id] }).catch(() => null)));
      return ids.map((id, i) => ({ id, closeRequestedAt: states[i] && Number(states[i].status) === 1 ? BigInt(states[i].closeRequestedAt) : 0n }));
    };
    if (Number(await publicClient.getChainId()) !== s.chainId) throw new Error("worker-closer: RPC_URL is on another chain than NETWORK");
    chain = createCloseChain({
      publicClient, account, channelContract: s.channelContract, chainId: s.chainId, maxFeePerGas: s.maxFeePerGas, waitMs: s.waitMs, pollMs: POLL_MS, depth: settledDepth(s.network),
      canPoll: () => used + 3 + AFTER_WAIT <= s.subrequests, // a look while waiting takes three
    });
  }
  // A seller Worker on the same Cloudflare account cannot be reached through its public address: bind it as SELLER_WORKER instead.
  const binding = env.SELLER_WORKER && typeof env.SELLER_WORKER.fetch === "function" ? env.SELLER_WORKER : null;
  const storeFetch = binding ? async (input, init) => (used++, binding.fetch(input, init)) : counted;
  const store = deps.store ?? createRemoteStore(s.storeUrl, env.STORE_SECRET, { fetch: storeFetch });
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
    // One channel after the other, so that every run closes something, and a channel is looked at only while a close still fits.
    // First the channels whose buyer asked to close, the oldest request first; then the others, starting one further on at every run.
    oneByOne: true,
    order: async (ids) => {
      const run = Math.floor((deps.now ?? Date.now)() / RUN_MS);
      const sorted = [...ids].sort();
      const turn = sorted.length ? run % sorted.length : 0;
      const rest = [...sorted.slice(turn), ...sorted.slice(0, turn)];
      const states = readAll ? await readAll(sorted) : await Promise.all(sorted.map(async (id) => ({ id, closeRequestedAt: BigInt((await chain.readChannel(id).catch(() => ({})))?.closeRequestedAt ?? 0) })));
      const asked = states.filter((x) => x.closeRequestedAt > 0n).sort((a, b) => (a.closeRequestedAt < b.closeRequestedAt ? -1 : a.closeRequestedAt > b.closeRequestedAt ? 1 : 0)).map((x) => x.id);
      return [...asked, ...rest.filter((id) => !asked.includes(id))];
    },
    shouldContinue: () => used + LOOK_COST + CLOSE_COST + AFTER_WAIT <= s.subrequests,
  });
  return { ...result, subrequests: used };
}
