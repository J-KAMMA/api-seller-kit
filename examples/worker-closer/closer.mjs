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
import { casUpdate } from "../../src/store.mjs";
import { channelKeys } from "../../src/voucher-record.mjs";

const TESTNETS = { "eip155:43113": 43113, "eip155:84532": 84532 };
const POLL_MS = 5_000;
/** Requests (chain and store) that looking at one channel can take, and closing it without the waiting; measured with the fake RPC of the tests. */
export const LOOK_COST = 4;
/** Channels read from the chain in one request (a JSON-RPC batch), to know which ones are due. */
const BATCH = 20;
export const CLOSE_COST = 24;
/** What a close needs after its last look while waiting: the checks of the outcome and the mark. */
const AFTER_WAIT = 8;
/**
 * Fixed requests of a run besides looking and closing, measured with the fake RPC of the tests: the chain id, the challenge period, the
 * time, two index reads, the closer's state read and write, one batch read of the window. Taking channels off the index (two more) is done
 * only when the budget still allows it, else by a later run.
 */
const FIXED_COST = 10;
export const MIN_SUBREQUESTS = FIXED_COST + LOOK_COST + CLOSE_COST + AFTER_WAIT;
/** Channels read from the chain per run, in one batch at the minimum budget: they are taken in turn through the whole index. */
const WINDOW = BATCH;
const RUN_SECONDS = 15 * 60;

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
    subrequests: Number(whole("MAX_SUBREQUESTS", 48, 1000)), // 50 a run on the free plan
    // a close must fit in a run whatever else happens in it
    ...(Number(env.MAX_SUBREQUESTS ?? 48) < MIN_SUBREQUESTS ? bad(`MAX_SUBREQUESTS must be at least ${MIN_SUBREQUESTS}`) : {}),
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
  const warnings = new Set();
  let chain = deps.chain;
  let readAll = null; // all channels' state in few requests
  if (!chain) {
    const viemChain = defineChain({ id: s.chainId, name: `chain-${s.chainId}`, nativeCurrency: { name: "Native", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [s.rpcUrl] } } });
    const publicClient = createPublicClient({ chain: viemChain, transport: http(s.rpcUrl, { fetchFn: counted, retryCount: 0 }) });
    const batched = createPublicClient({ chain: viemChain, transport: http(s.rpcUrl, { fetchFn: counted, retryCount: 0, batch: { batchSize: BATCH, wait: 0 } }) });
    const read = (client) => (id) => client.readContract({ address: s.channelContract, abi: CHANNEL_ABI, functionName: "getChannel", args: [id] }).then((c) => ({ status: Number(c.status), closeRequestedAt: BigInt(c.closeRequestedAt) }));
    readAll = async (ids, noBatch) => {
      const states = noBatch ? ids.map(() => null) : await Promise.all(ids.map((id) => read(batched)(id).catch(() => null)));
      if (states.every((x) => x !== null)) return states;
      // The RPC refused the batch or answered part of it: the missing ones one by one, as long as a close still fits after them.
      warnings.add("batch_refused");
      for (const [i, id] of ids.entries()) {
        if (states[i] !== null) continue;
        if (used + 1 + LOOK_COST + CLOSE_COST + AFTER_WAIT + 1 > s.subrequests) break;
        states[i] = await read(publicClient)(id).catch(() => null);
      }
      return states;
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
  const challengeSeconds = await chain.challengeSeconds();
  const stateKey = `closer:${s.chainId}:${s.channelContract.toLowerCase()}`;
  const indexKey = channelKeys(s.chainId, s.channelContract).index;
  let forget = [];
  let state = null;
  let stored = null;

  /**
   * The order of this run. The closer remembers in the seller's store, between runs:
   *   queue   channels whose buyer asked to close, with the end of their window: the soonest end first, dropped once it has passed
   *   cursor  where the next window of the index starts: every channel is read once in index.length / WINDOW runs
   * Channels found closed on chain, or past their window, are taken off the index (their records stay, so gates go on refusing them).
   */
  async function order(ids) {
    const now = BigInt(await chain.chainTime());
    stored = (await store.get(stateKey).catch(() => null)) ?? null;
    state = stored ?? { cursor: 0, queue: [] };
    const sorted = [...ids].sort();
    const n = sorted.length;
    const start = n ? Number(state.cursor ?? 0) % n : 0;
    const window = Array.from({ length: Math.min(WINDOW, n) }, (_, i) => sorted[(start + i) % n]);
    const states = readAll ? await readAll(window, state.noBatch === true) : await Promise.all(window.map((id) => chain.readChannel(id).then((c) => ({ status: Number(c.status), closeRequestedAt: BigInt(c.closeRequestedAt ?? 0) })).catch(() => null)));
    const queue = new Map((state.queue ?? []).filter((q) => ids.includes(q.id)).map((q) => [q.id, BigInt(q.until)]));
    for (const [i, id] of window.entries()) {
      const c = states[i];
      if (!c) continue;
      if (c.status === 2) forget.push(id); // closed on chain, by anyone
      else if (c.status === 1 && c.closeRequestedAt > 0n) queue.set(id, c.closeRequestedAt + BigInt(challengeSeconds));
    }
    for (const [id, until] of queue) {
      if (until <= now) {
        queue.delete(id); // the buyer may withdraw now: the seller can no longer close it
        forget.push(id);
      }
    }
    const due = [...queue].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)).map(([id]) => id);
    // on from the first one that could not be read, so that none is passed over
    const read = states.findIndex((x) => x === null);
    const advanced = read === -1 ? window.length : read;
    state = { cursor: n ? (start + advanced) % n : 0, queue: due.map((id) => ({ id, until: queue.get(id).toString() })), ...(warnings.has("batch_refused") ? { noBatch: true } : {}) };
    if (states.some((x) => x === null)) warnings.add("chain_unreadable");
    if (n > 0 && Math.ceil(n / WINDOW) * RUN_SECONDS >= (challengeSeconds * 3) / 4) warnings.add("index_too_large_for_budget");
    // the window's other channels, for MIN_AMOUNT: every channel comes in turn
    return [...due, ...window.filter((id) => !queue.has(id) && !forget.includes(id))];
  }

  const result = await closeChannels({
    store,
    chainId: s.chainId,
    channelContract: s.channelContract,
    seller: account.address,
    onlyRequested: true,
    minAmountAtomic: s.minAmountAtomic,
    drainMs: s.drainMs,
    challengeSeconds,
    chainTime: chain.chainTime,
    readChannel: chain.readChannel,
    settledChannel: chain.settledChannel,
    snapshot: chain.snapshot,
    sendClose: chain.sendClose,
    // One channel after the other, so that every run closes something, and a channel is looked at only while a close still fits.
    oneByOne: true,
    order,
    shouldContinue: () => used + LOOK_COST + CLOSE_COST + AFTER_WAIT + 1 <= s.subrequests, // 1: the state below
  });
  // Remember: closed ones leave the queue, and the closed and the hopeless leave the index.
  try {
    const done = new Set([...result.closed, ...result.skipped.filter((x) => ["not_open_on_chain", "already_closed", "challenge_period_over"].includes(x.reason)).map((x) => x.channelId)]);
    for (const x of result.skipped) if (x.reason === "challenge_period_over") forget.push(x.channelId);
    // one request: written only over what this run read (a run that overlapped wins, this one's work is found again)
    if (state && used + 1 <= s.subrequests) await store.compareAndSet(stateKey, stored, { ...state, queue: state.queue.filter((q) => !done.has(q.id)) });
    if (forget.length && used + 2 <= s.subrequests) await casUpdate(store, indexKey, (cur) => (Array.isArray(cur) && cur.some((id) => forget.includes(id)) ? { next: cur.filter((id) => !forget.includes(id)) } : {}));
  } catch {
    warnings.add("state_not_saved"); // the next run reads the window again
  }
  return { ...result, subrequests: used, warnings: [...warnings] };
}
