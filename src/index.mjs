// x402 per-call gate for sellers (testnet only). Fetch API only: Workers and Node 18+.
// Flow: no payment -> 402 quote; payment -> facilitator /verify -> upstream -> (2xx only) /settle -> reply.
// Fail closed: any verify/settle problem means the body is never returned. The payment payload is never logged.
// Optional modes (PREPAID-MONTHLY.md): `prepaid` (hub-channel voucher) and `monthly` (hub-subscription token).
import { bindingOf, boundNonce, gateIdOf } from "./gate-binding.mjs";
import { createSubscriptions } from "./subscription.mjs";
import { ATTEMPT_MS, BodyTooLarge, createPayments, DIRECT_MAX_AGE_SECONDS, IDEMPOTENCY_HEADER, ownerDigest, paymentId, requestDigest, sha256Hex } from "./payments.mjs";
import { createSettlementProof } from "./settlement-proof.mjs";
import { classify, decide, reclassify } from "./settlement-table.mjs";
import { PUBLIC_RPC, settledDepth } from "./networks.mjs";
import { minDeposit } from "./voucher-record.mjs";
import { createFileStore, createMemoryStore, isAtomicStore, isProcessLocal, singleInstanceStore } from "./store.mjs";

/** @typedef {{
 *   network: string, asset: string, payTo: string, seller: string, priceAtomic: string|number|bigint,
 *   facilitatorUrl?: string, direct?: boolean, description?: string, resource?: string, mimeType?: string,
 *   maxTimeoutSeconds?: number, tokenName?: string, tokenVersion?: string,
 *   facilitatorHeaders?: Record<string,string>, fetch?: typeof fetch, allowedNetworks?: string[],
 *   allowLocalDevNetwork?: boolean,
 *   prepaid?: { pricePerCallAtomic: string|number|bigint, channelContract: string, minDepositAtomic?: string|number|bigint, rpcUrl?: string, readChannel?: Function, earlierContracts?: string[], callTimeoutMs?: number },
 *   monthly?: { priceAtomic: string|number|bigint, quota: number|null, subscriptionSecret: string, acceptPrices?: (string|number|bigint)[] },
 *   store?: { get(key: string): any, set(key: string, value: any): any, compareAndSet?(key: string, expected: any, next: any): any },
 *   singleInstance?: boolean, gateId?: string, requireGateBinding?: boolean, upstreamTimeoutMs?: number, settlementRpcUrl?: string, storePath?: string, now?: () => number
 * }} GateConfig */

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const NETWORK = /^eip155:\d{1,12}$/;
// Testnets only. Adding a mainnet needs a separate owner review (see README).
const TESTNETS = ["eip155:43113", "eip155:84532"];
// Local hardhat chain: only behind the explicit `allowLocalDevNetwork` option AND a loopback facilitator.
const LOCAL_DEV_NETWORK = "eip155:31337";
const MAX_PAYMENT_HEADER = 16 * 1024;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const FACILITATOR_TIMEOUT_MS = 30_000;
const MAX_PUBLIC_LOOKS = 10; // a minute, for each gate

/** Header names the Desktop buyer sends / reads (x402 v2), plus the v1 names for other buyers. */
const REQUEST_HEADERS = ["payment-signature", "x-payment"];
const VOUCHER_HEADER = "hub-channel-voucher";
const SUBSCRIPTION_HEADER = "hub-subscription";
const RECEIPT_HEADER = "hub-channel-receipt";
/** A payment the buyer sent to the chain itself, paying its gas (hub-direct): see direct payments in README. */
const DIRECT_HEADER = "hub-direct-payment";
const HEX32 = /^0x[0-9a-fA-F]{64}$/;

function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64ToUtf8(b64) {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

const plain = (v) => (v !== null && typeof v === "object" ? String(v) : v);
const list = (v) => (Array.isArray(v) ? Object.freeze(Array.from(v, plain)) : v);

/** Reads every option once. What the caller changes afterwards, or a getter answers differently, has no effect on a gate that was checked. */
function snapshot(given) {
  if (!given || typeof given !== "object") return given;
  const take = (o, names, lists = [], asIs = []) => {
    const c = {};
    for (const n of names) if (n in o) c[n] = plain(o[n]);
    for (const n of lists) if (n in o) c[n] = list(o[n]);
    for (const n of asIs) if (n in o) c[n] = o[n];
    return c;
  };
  const c = take(
    given,
    ["network", "asset", "payTo", "seller", "priceAtomic", "facilitatorUrl", "description", "resource", "mimeType", "maxTimeoutSeconds", "tokenName", "tokenVersion",
      "allowLocalDevNetwork", "direct", "singleInstance", "upstreamTimeoutMs", "settlementRpcUrl", "storePath", "gateId", "requireGateBinding"],
    ["allowedNetworks"],
    ["fetch", "now", "store", "facilitatorHeaders", "prepaid", "monthly"],
  );
  const isObject = (v) => v !== null && typeof v === "object";
  if (isObject(c.facilitatorHeaders)) c.facilitatorHeaders = Object.freeze({ ...c.facilitatorHeaders });
  if (isObject(c.prepaid)) c.prepaid = Object.freeze(take(c.prepaid, ["pricePerCallAtomic", "channelContract", "minDepositAtomic", "rpcUrl", "callTimeoutMs"], ["earlierContracts"], ["readChannel"]));
  if (isObject(c.monthly)) c.monthly = Object.freeze(take(c.monthly, ["priceAtomic", "quota", "subscriptionSecret"], ["acceptPrices"]));
  for (const n of Object.keys(c)) if (c[n] === undefined) delete c[n];
  return Object.freeze(c);
}

function assertConfig(c) {
  const bad = (m) => {
    throw new Error(`x402 gate config: ${m}`);
  };
  if (!c || typeof c !== "object") bad("config required");
  // Allowlist: every network that can ever be used is named here. `allowedNetworks` only narrows it.
  const known = [...TESTNETS];
  if (c.allowLocalDevNetwork === true) known.push(LOCAL_DEV_NETWORK);
  if (c.allowedNetworks !== undefined && !Array.isArray(c.allowedNetworks)) bad("allowedNetworks must be a list");
  const allowed = c.allowedNetworks === undefined ? known : known.filter((n) => c.allowedNetworks.includes(n));
  if (c.gateId !== undefined && !(typeof c.gateId === "string" && c.gateId.length > 0 && c.gateId.length <= 200)) bad("gateId must be a text of 1 to 200 characters");
  if (c.requireGateBinding !== undefined && typeof c.requireGateBinding !== "boolean") bad("requireGateBinding must be true or false");
  if (!NETWORK.test(c.network) || !allowed.includes(c.network)) bad(`network must be one of ${allowed.join(", ")}`);
  for (const k of ["asset", "payTo", "seller"]) if (!ADDRESS.test(String(c[k]))) bad(`${k} must be a 0x address`);
  if (!/^[1-9]\d{0,29}$/.test(String(c.priceAtomic))) bad("priceAtomic must be a positive integer (atomic units)");
  if (c.direct !== undefined && typeof c.direct !== "boolean") bad("direct must be true or false");
  const direct = c.direct === true;
  // With direct payments only, no facilitator is asked at all: the buyer sends the payment and pays its gas.
  if (c.facilitatorUrl !== undefined || !direct) {
    let url;
    try {
      url = new URL(c.facilitatorUrl);
    } catch {
      bad("facilitatorUrl invalid");
    }
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) bad("facilitatorUrl must be https");
    if (c.network === LOCAL_DEV_NETWORK && !local) bad("local dev network needs a loopback facilitatorUrl");
  }
  if (direct && !c.settlementRpcUrl && !c.prepaid?.rpcUrl && !Object.hasOwn(PUBLIC_RPC, c.network)) bad("direct payments on this network need settlementRpcUrl");
  if (c.upstreamTimeoutMs !== undefined && !(Number.isInteger(c.upstreamTimeoutMs) && c.upstreamTimeoutMs > 0)) bad("upstreamTimeoutMs must be a positive integer");
  if (c.settlementRpcUrl !== undefined) {
    let rpc;
    try {
      rpc = new URL(c.settlementRpcUrl);
    } catch {
      bad("settlementRpcUrl invalid");
    }
    if (rpc.protocol !== "https:" && !(rpc.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(rpc.hostname))) bad("settlementRpcUrl must be https");
  }
  if (c.prepaid !== undefined) {
    const p = c.prepaid;
    if (!p || typeof p !== "object") bad("prepaid must be an object");
    if (!/^[1-9]\d{0,29}$/.test(String(p.pricePerCallAtomic))) bad("prepaid.pricePerCallAtomic must be a positive integer");
    if (!ADDRESS.test(String(p.channelContract))) bad("prepaid.channelContract must be a 0x address");
    if (p.minDepositAtomic !== undefined && !/^[1-9]\d{0,29}$/.test(String(p.minDepositAtomic))) bad("prepaid.minDepositAtomic must be a positive integer");
    if (p.callTimeoutMs !== undefined && !(Number.isInteger(p.callTimeoutMs) && p.callTimeoutMs > 0)) bad("prepaid.callTimeoutMs must be a positive integer");
    if (p.earlierContracts !== undefined && !(Array.isArray(p.earlierContracts) && p.earlierContracts.every((e) => /^eip155:\d{1,12}\/0x[0-9a-fA-F]{40}$/.test(String(e))))) {
      bad("prepaid.earlierContracts must be a list like eip155:43113/0x...");
    }
    if (typeof p.readChannel !== "function" || p.rpcUrl) {
      let rpc;
      try {
        rpc = new URL(p.rpcUrl);
      } catch {
        bad("prepaid.rpcUrl invalid");
      }
      const rpcLocal = ["localhost", "127.0.0.1", "[::1]"].includes(rpc.hostname);
      if (rpc.protocol !== "https:" && !(rpc.protocol === "http:" && rpcLocal)) bad("prepaid.rpcUrl must be https");
    }
  }
  if (c.monthly !== undefined) {
    const m = c.monthly;
    if (!m || typeof m !== "object") bad("monthly must be an object");
    if (!/^[1-9]\d{0,29}$/.test(String(m.priceAtomic))) bad("monthly.priceAtomic must be a positive integer");
    if (!(m.quota === null || (Number.isInteger(m.quota) && m.quota > 0))) bad("monthly.quota must be a positive integer or null");
    if (m.acceptPrices !== undefined && !(Array.isArray(m.acceptPrices) && m.acceptPrices.every((v) => /^[1-9]\d{0,29}$/.test(String(v))))) bad("monthly.acceptPrices must be a list of prices");
    let resource;
    try {
      resource = new URL(c.resource);
    } catch {
      bad("monthly needs resource: the public address of this API");
    }
    if (!c.settlementRpcUrl && !c.prepaid?.rpcUrl && !Object.hasOwn(PUBLIC_RPC, c.network)) bad("monthly on this network needs settlementRpcUrl");
    if (!/^https?:$/.test(resource.protocol)) bad("resource must be an http(s) address");
    if (typeof m.subscriptionSecret !== "string" || m.subscriptionSecret.length < 16) bad("monthly.subscriptionSecret must be a string of 16+ characters");
  }
  // Without them the gate's id comes from payTo alone, and every such gate on that payTo would accept the others' bound payments.
  if ((c.requireGateBinding === true || c.direct === true) && c.gateId === undefined && c.resource === undefined) bad("binding needs gateId or resource, so that this gate's id is its own");
}

/**
 * @param {GateConfig} config
 * @returns {(request: Request, next: (request: Request) => Promise<Response>) => Promise<Response>}
 */
export function createX402Gate(given) {
  const config = snapshot(given);
  assertConfig(config);
  const direct = config.direct === true; // off unless asked for
  const doFetch = config.fetch ?? ((input, init) => globalThis.fetch(input, init)); // Workers: keep fetch bound
  const base = config.facilitatorUrl && config.facilitatorUrl.replace(/\/+$/, "");
  const price = String(config.priceAtomic);
  const timeout = config.maxTimeoutSeconds ?? 300;
  let store = null;
  if (config.prepaid || config.monthly || direct) {
    store = config.store ?? createFileStore(config.storePath ?? "./seller-kit-store.json");
    const counts = direct || config.prepaid !== undefined || config.monthly.quota !== null;
    if (counts && !isAtomicStore(store) && config.singleInstance !== true) {
      throw new Error(
        "x402 gate config: direct payments, prepaid and monthly with a quota need a store with compareAndSet(key, expected, next); " +
          "pass singleInstance: true only when exactly one process uses this store",
      );
    }
    store = singleInstanceStore(store);
  }
  if (!store && config.store && isAtomicStore(config.store)) store = config.store;
  // Per call only and no shared store: one payment is still served once by this process. With several processes they must share a store.
  if (!store && config.storePath !== undefined) store = createFileStore(config.storePath);
  if (globalThis.navigator?.userAgent === "Cloudflare-Workers" && (!store || isProcessLocal(store) || (config.store && !isAtomicStore(config.store)))) {
    throw new Error("x402 gate config: on Workers requests run in many isolates; pass a shared store with compareAndSet (createDurableObjectStore)");
  }
  if ((!store || (config.store && !isAtomicStore(config.store))) && config.singleInstance !== true) {
    console.warn("x402 gate: payments are remembered by this process only; pass a store with compareAndSet when several instances run, or singleInstance: true");
  }
  const thisGateId = gateIdOf(config);
  const requireBinding = config.requireGateBinding === true;
  if (config.gateId === undefined && config.resource === undefined) console.warn("x402 gate: no gateId and no resource: every such gate on this payTo has the same id; give each gate its own gateId");
  const subs = config.monthly ? createSubscriptions({ seller: config.seller, network: config.network, monthly: config.monthly, store, now: config.now, resource: config.resource, gateId: thisGateId, requireBinding }) : null;
  // A month that was paid must be collectable whatever the facilitator answers, so monthly always has an RPC. The public default is asked
  // for the block before every settlement, and when something is unclear.
  const namedRpc = config.settlementRpcUrl ?? (config.prepaid?.rpcUrl || undefined);
  const proofRpc = namedRpc ?? (config.monthly || direct ? PUBLIC_RPC[config.network] : undefined);
  const proof = proofRpc ? createSettlementProof({ rpcUrl: proofRpc, chainId: Number(config.network.split(":")[1]), asset: config.asset, payTo: config.payTo, doFetch, depth: settledDepth(config.network) }) : null;
  /** hub-direct lookups: a few a minute on the public RPC, more on the seller's own; never most of them for one payer. */
  const directLimit = namedRpc ? 600 : 20;
  let directLooks = [];
  const mayLookDirect = (from) => {
    const t = Date.now();
    directLooks = directLooks.filter((x) => t - x.t < 60_000);
    if (directLooks.length >= directLimit || directLooks.filter((x) => x.from === from).length >= Math.max(5, directLimit / 4)) return false;
    directLooks.push({ t, from });
    return true;
  };
  /** Lookups for payments that failed /verify cost their sender nothing, so the public default RPC gets only a few of them. */
  let looks = [];
  const mayLook = (payload, verified) => {
    if (/signature/i.test(String(verified.data?.invalidReason ?? ""))) return false; // never was a payment
    if (namedRpc) return true;
    if (!/^0x([0-9a-fA-F]{2}){65,}$/.test(String(payload.payload?.signature))) return false;
    const now = Date.now();
    looks = looks.filter((t) => now - t < 60_000);
    return looks.length < MAX_PUBLIC_LOOKS && looks.push(now) > 0;
  };
  const thisGate = { chainId: Number(config.network.split(":")[1]), asset: config.asset.toLowerCase(), payTo: config.payTo.toLowerCase(), gateId: thisGateId };
  const upstreamTimeout = config.upstreamTimeoutMs ?? 300_000;
  const payments = createPayments(store ?? createMemoryStore(), upstreamTimeout);
  const now = config.now ?? (() => Math.floor(Date.now() / 1000));
  let channelPromise = null; // viem is only loaded when prepaid is configured
  const channels = () =>
    (channelPromise ??= import("./channel.mjs").then((m) =>
      m.createChannelHandler({ network: config.network, asset: config.asset, seller: config.seller, prepaid: config.prepaid, store, doFetch }),
    ));

  /** The requirements are built from config only; nothing the buyer sends can change them. */
  function requirements(request, monthly = false) {
    const amount = monthly ? String(config.monthly.priceAtomic) : price;
    const req = exactRequirements(request, amount);
    if (monthly) req.extra = { ...req.extra, plan: "monthly", periodDays: 30, quota: config.monthly.quota ?? null };
    return req;
  }

  /** hub-direct: the same EIP-3009 authorization, with this gate's bound nonce, sent to the chain by the buyer. */
  function directEntry(request, monthly = false) {
    const amount = monthly ? String(config.monthly.priceAtomic) : price;
    const exact = exactRequirements(request, amount);
    return {
      scheme: "hub-direct",
      network: config.network,
      amount,
      asset: exact.asset,
      payTo: exact.payTo,
      resource: exact.resource,
      maxTimeoutSeconds: timeout,
      extra: {
        name: exact.extra.name,
        version: exact.extra.version,
        seller: exact.extra.seller,
        gateBinding: { v: 1, gateId: thisGate.gateId, required: true },
        minConfirmations: Number(settledDepth(config.network)) + 1,
        maxAgeSeconds: DIRECT_MAX_AGE_SECONDS,
        header: DIRECT_HEADER,
        ...(monthly ? { plan: "monthly", periodDays: 30, quota: config.monthly.quota ?? null } : {}),
      },
    };
  }

  function channelEntry(request) {
    return {
      scheme: "hub-channel",
      network: config.network,
      asset: config.asset.toLowerCase(),
      payTo: config.seller.toLowerCase(),
      amount: String(config.prepaid.pricePerCallAtomic),
      resource: config.resource ?? request.url,
      maxTimeoutSeconds: timeout,
      extra: {
        channelContract: config.prepaid.channelContract.toLowerCase(),
        seller: config.seller.toLowerCase(),
        minDepositAtomic: String(minDeposit(config.prepaid)),
      },
    };
  }

  function exactRequirements(request, amount) {
    return {
      scheme: "exact",
      network: config.network,
      // `amount` is what the Desktop buyer reads (x402 v2); `maxAmountRequired` is the v1 name.
      amount,
      maxAmountRequired: amount,
      asset: config.asset.toLowerCase(),
      payTo: config.payTo.toLowerCase(),
      resource: config.resource ?? request.url,
      description: config.description ?? "",
      mimeType: config.mimeType ?? "application/json",
      maxTimeoutSeconds: timeout,
      extra: {
        name: config.tokenName ?? (config.network === "eip155:84532" ? "USDC" : "USD Coin"), // EIP-712 domain name on chain: Fuji USDC is "USD Coin", Base Sepolia is "USDC"
        version: config.tokenVersion ?? "2",
        seller: config.seller.toLowerCase(),
        gateBinding: { v: 1, gateId: thisGate.gateId, required: requireBinding }, // see gate-binding.mjs
      },
    };
  }

  function json(status, body, headers = {}) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
    });
  }

  /**
   * What became of a payment, in the body and in the hub-payment-status header:
   *   not_taken  nothing was settled; paying (again) is safe
   *   unclear    it may have been settled; do NOT pay again, repeat the same request with the same payment
   *   settled    it was settled; do NOT pay again
   *   refused    this request settled nothing, but an earlier one with the same payment may have
   */
  const outcome = (payment) => ({ payment, safeToPayAgain: payment === "not_taken" });
  const failed = (status, error, payment, headers = {}) => json(status, { error, ...outcome(payment) }, { "hub-payment-status": payment, ...headers });

  function quote(request, error, extra, payment) {
    const accepts = base ? [requirements(request)] : [];
    if (direct) accepts.push(directEntry(request));
    if (config.prepaid) accepts.push(channelEntry(request));
    if (config.monthly && base) accepts.push(requirements(request, true));
    if (config.monthly && direct) accepts.push(directEntry(request, true));
    const body = { x402Version: 2, accepts };
    if (error) body.error = error;
    if (extra) body.channel = extra;
    if (payment) Object.assign(body, outcome(payment));
    // Buyers read the quote from the `payment-required` header (v2) or from the body.
    return json(402, body, { "payment-required": utf8ToBase64(JSON.stringify(body)), ...(payment ? { "hub-payment-status": payment } : {}) });
  }

  async function facilitator(path, paymentPayload, paymentRequirements, until = Infinity) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(FACILITATOR_TIMEOUT_MS, until - Date.now())));
    try {
      const res = await doFetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(config.facilitatorHeaders ?? {}) },
        body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements }),
        redirect: "manual", // Workers do not support "error"; a redirect is treated as unavailable below
        signal: controller.signal,
      });
      if (res.status >= 300 && res.status < 400) return { ok: false, status: res.status, data: null };
      const data = await res.json().catch(() => null);
      return { ok: res.ok, status: res.status, data };
    } catch {
      return { ok: false, status: 0, data: null };
    } finally {
      clearTimeout(timer);
    }
  }

  /** The seller's API: without the payment headers, with a time limit that also covers reading the body, and never more than the cap. */
  async function callUpstream(request, next) {
    const headers = new Headers(request.headers);
    for (const name of [...REQUEST_HEADERS, VOUCHER_HEADER, SUBSCRIPTION_HEADER, IDEMPOTENCY_HEADER, DIRECT_HEADER]) headers.delete(name);
    // A conditional request could be answered with an uncounted 304 that tells the buyer what they came for.
    for (const name of ["if-none-match", "if-modified-since", "if-match", "if-unmodified-since", "if-range"]) headers.delete(name);
    const controller = new AbortController();
    let timer;
    const late = new Promise((_, refuse) => {
      timer = setTimeout(() => (controller.abort(), refuse(new Error("upstream_timeout"))), upstreamTimeout);
    });
    let reader = null;
    const run = async () => {
      const upstream = await next(new Request(request, { headers, signal: controller.signal }));
      if (!(upstream.status >= 200 && upstream.status < 300)) return { upstream };
      const chunks = [];
      let size = 0;
      if (upstream.body) {
        reader = upstream.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BODY_BYTES) {
            void reader.cancel().catch(() => {});
            return { upstream, tooLarge: true };
          }
          chunks.push(value);
        }
      }
      const bytes = new Uint8Array(size);
      let at = 0;
      for (const c of chunks) {
        bytes.set(c, at);
        at += c.byteLength;
      }
      const out = new Headers(upstream.headers);
      out.delete("content-length");
      out.delete("content-encoding");
      return { upstream, bytes, headers: out };
    };
    const work = run();
    work.catch(() => {});
    try {
      return await Promise.race([work, late]);
    } catch (e) {
      if (reader) void reader.cancel().catch(() => {});
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  function reply(upstream, bytes, headers) {
    const empty = upstream.status === 204 || upstream.status === 205; // these statuses may not carry a body object
    return new Response(empty ? null : bytes, { status: upstream.status, statusText: upstream.statusText, headers });
  }

  /**
   * Serve an already-authorised call (subscription or voucher): give the use back when upstream fails. Upstream streams are read to the
   * end before the buyer gets the first byte, so a body that breaks off half way is a failed call: nothing is delivered, nothing is counted.
   * Once the complete reply is handed over, the call counts, also when the buyer drops the connection.
   * Only 2xx counts: a redirect or an error is passed on as it is and costs nothing.
   */
  async function serveAuthorised(request, next, undo, extraHeaders, done = null) {
    const rollback = () => undo().catch(() => {}); // a store failure here keeps the use counted; the reply stays the upstream error
    let r;
    try {
      r = await callUpstream(request, next);
    } catch {
      await rollback();
      return json(502, { error: "upstream_failed" });
    }
    if (!r.bytes) {
      await rollback();
      return r.tooLarge ? json(502, { error: "upstream_too_large" }) : r.upstream;
    }
    for (const [k, v] of Object.entries(extraHeaders)) r.headers.set(k, v);
    if (done) await done().catch(() => {});
    return reply(r.upstream, r.bytes, r.headers);
  }

  /**
   * hub-direct: the buyer sent the payment to the chain itself and paid its gas; no facilitator is asked. The header names the transaction
   * and the r of the gate-bound nonce. r is the buyer's secret until this call (the chain shows only the nonce), so it also proves the
   * buyer on a retry. The payment is the same record as an x402 one (network, asset, from, nonce): it is served once, at one gate.
   * The record keeps what is needed to finish it (plan, payer, transaction), so whoever takes it over issues the same token.
   * Until one call was answered with 2xx, the payment pays for any call to this gate with the same plan.
   */
  async function directPayment(request, next, header) {
    // After paying, no answer is a 402: a plain x402 client would pay again.
    const refused = (error) => failed(422, error, "refused");
    if (header.length > MAX_PAYMENT_HEADER) return refused("payment_header_too_large");
    let p;
    try {
      p = JSON.parse(base64ToUtf8(header));
    } catch {
      return refused("payment_header_invalid");
    }
    const hex32 = (v) => typeof v === "string" && HEX32.test(v);
    if (!p || typeof p !== "object" || Array.isArray(p) || p.v !== 1 || !hex32(p.txHash) || !(typeof p.from === "string" && ADDRESS.test(p.from)) || !hex32(p.nonce) || !hex32(p.r)) return refused("payment_header_invalid");
    if (p.network !== config.network) return refused("payment_wrong_network");
    if (p.plan !== undefined && !(p.plan === "monthly" && config.monthly)) return refused("payment_plan_unknown");
    const nonce = p.nonce.toLowerCase();
    if (boundNonce({ ...thisGate, r: p.r }) !== nonce) return refused("payment_for_another_gate");
    if (!proof) return failed(503, "chain_unavailable", "unclear", { "retry-after": "10" });
    const plan = p.plan === "monthly" ? "monthly" : "call";
    const from = p.from.toLowerCase();
    const key = `payment:${[config.network, config.asset, from, nonce].join("|").toLowerCase()}`;
    const owner = await sha256Hex(JSON.stringify([key, "hub-direct", p.r.toLowerCase()]));
    const paidHeaders = (rec) => ({
      "hub-payment-status": "settled",
      ...(rec.receipt ? { "X-PAYMENT-RESPONSE": rec.receipt, "PAYMENT-RESPONSE": rec.receipt } : {}),
      ...(rec.token ? { [SUBSCRIPTION_HEADER]: rec.token } : {}),
    });
    /** What a paid record hands out, from the record alone: the same whoever makes it. */
    async function fieldsOf(rec) {
      const d = rec.direct;
      const fields = { transaction: d.transaction, receipt: utf8ToBase64(JSON.stringify({ success: true, transaction: d.transaction, network: config.network, payer: d.from })) };
      if (d.plan === "monthly") fields.token = await subs.issue({ buyer: d.from, payment: (await sha256Hex(key)).slice(0, 32), issuedAt: rec.issuedAt });
      return fields;
    }
    /** One call to the API. Anything but a 2xx leaves the payment owed, for this or another call. */
    async function deliver(rec) {
      let r;
      try {
        r = await callUpstream(request, next);
      } catch {
        r = {};
      }
      if (!r.bytes) {
        await payments.owed(key, rec.id, {}).catch(() => {});
        if (r.upstream && !r.tooLarge) {
          const headers = new Headers(r.upstream.headers);
          for (const [k, v] of Object.entries(paidHeaders(rec))) headers.set(k, v);
          return new Response(r.upstream.body, { status: r.upstream.status, statusText: r.upstream.statusText, headers });
        }
        return failed(502, r.tooLarge ? "upstream_too_large" : "upstream_failed", "settled", paidHeaders(rec));
      }
      if (!(await payments.settled(key, rec.id, {}).catch(() => false))) return failed(409, "payment_in_progress", "settled");
      for (const [k, v] of Object.entries(paidHeaders(rec))) r.headers.set(k, v);
      return reply(r.upstream, r.bytes, r.headers);
    }
    /** Owed, or left half way by a process that died or lost the store: take it for one delivery, finishing the record first. */
    async function deliverOwed() {
      for (let i = 0; i < 3; i++) {
        const rec = await payments.retry(key);
        if (rec === null) return failed(409, "payment_in_progress", "settled");
        if (rec.state === "delivering" && rec.receipt && (rec.direct.plan !== "monthly" || rec.token)) return deliver(rec);
        // it was verified on chain before it was taken
        if (!(await payments.owed(key, rec.id, await fieldsOf(rec)))) return failed(409, "payment_in_progress", "settled");
      }
      return failed(409, "payment_in_progress", "settled");
    }

    try {
      const rec = await payments.get(key);
      if (!payments.isFree(rec)) {
        const status = ["settled", "owed", "delivering", "settling"].includes(rec.state) ? "settled" : "unclear";
        if (rec.owner !== owner || !rec.direct) return failed(409, "payment_already_used", status); // not this buyer, or paid through a facilitator
        if (rec.state === "settled") return failed(409, "already_served", "settled", paidHeaders(rec));
        if (rec.direct.plan !== plan) return failed(409, "payment_for_another_plan", "settled");
        return await deliverOwed();
      }
    } catch {
      return failed(502, "store_unavailable", "unclear");
    }

    // Every lookup costs this gate's RPC; a made-up header costs its sender nothing.
    if (!mayLookDirect(from)) return failed(503, "chain_busy", "unclear", { "retry-after": "20" });
    const minAmount = plan === "monthly" ? String(config.monthly.priceAtomic) : price;
    const found = await proof.direct({ txHash: p.txHash, from, nonce, minAmount, maxAgeSeconds: DIRECT_MAX_AGE_SECONDS, now: now() });
    if (found.state === "pending") return json(402, { error: "payment_pending", ...outcome("unclear") }, { "hub-payment-status": "unclear", "retry-after": "3" });
    if (found.state === "unclear") return failed(503, "chain_unavailable", "unclear", { "retry-after": "10" });
    if (found.state === "reverted") {
      // Somebody else may have sent the same signed authorization first: then the buyer names that transaction.
      const used = await proof.used({ from, nonce, validBefore: null });
      return refused(used === "used" ? "payment_in_another_transaction" : "payment_reverted");
    }
    if (found.state === "too_old") return refused("payment_too_old");
    if (found.state !== "paid") return refused("payment_not_in_transaction");

    try {
      const claim = await payments.claim({ key, expiresAt: now() + DIRECT_MAX_AGE_SECONDS + 7200 }, owner, null, now(), { direct: { plan, from, transaction: found.transaction } });
      if (!claim.rec) return failed(409, claim.existing.owner === owner ? "payment_in_progress" : "payment_already_used", "settled");
      if (!(await payments.settling(key, claim.rec.id, null))) return failed(409, "payment_in_progress", "settled");
      if (!(await payments.owed(key, claim.rec.id, await fieldsOf(claim.rec)))) return failed(409, "payment_in_progress", "settled");
      return await deliverOwed();
    } catch {
      return failed(502, "store_unavailable", "settled", { "retry-after": "180" }); // paid and taken: the same header again finishes it, after the lease
    }
  }

  return async function gate(request, next) {
    let modeError = null;

    const token = subs ? request.headers.get(SUBSCRIPTION_HEADER) : null;
    if (token) {
      let r;
      try {
        r = await subs.accept(token);
      } catch {
        return json(502, { error: "store_unavailable" });
      }
      if (r.ok) return serveAuthorised(request, next, r.rollback, {});
      modeError = r.error;
    }

    const directHeader = direct ? request.headers.get(DIRECT_HEADER) : null;
    if (directHeader) return directPayment(request, next, directHeader);

    let channelInfo;
    const voucher = config.prepaid ? request.headers.get(VOUCHER_HEADER) : null;
    if (voucher) {
      let r;
      try {
        r = await (await channels()).accept(voucher);
      } catch {
        return json(502, { error: "channel_unavailable" });
      }
      if (r.ok) return serveAuthorised(request, next, r.rollback, { [RECEIPT_HEADER]: r.receipt }, r.done);
      if (r.status !== 402) return json(r.status, { error: r.error });
      modeError = r.error;
      channelInfo = r.channel;
    }

    let header = null;
    for (const name of REQUEST_HEADERS) {
      header = request.headers.get(name);
      if (header) break;
    }
    if (!header) return quote(request, modeError ?? undefined, channelInfo);
    if (!base) return quote(request, "pay_with_hub_direct", undefined, "refused"); // this gate asks no facilitator
    if (header.length > MAX_PAYMENT_HEADER) return quote(request, "payment_header_too_large");

    let payload;
    try {
      payload = JSON.parse(base64ToUtf8(header));
    } catch {
      return quote(request, "payment_header_invalid");
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return quote(request, "payment_header_invalid");
    // Made for another gate (or bound wrongly): this gate never serves it, whatever its store says. Unbound: only where allowed.
    const binding = bindingOf(payload, thisGate);
    if (binding === "foreign") return quote(request, "payment_for_another_gate", undefined, "refused");
    if (binding === "unbound" && requireBinding) return quote(request, "payment_not_bound", undefined, "refused");
    if (binding === "bound") {
      const { binding: _proof, ...forwarded } = payload; // the facilitator gets the standard payload
      payload = forwarded;
    }

    // Both requirement sets come from config; the buyer's hint only picks one and the facilitator verifies against it.
    const isMonthly = config.monthly !== undefined && payload.accepted?.extra?.plan === "monthly";
    const reqs = requirements(request, isMonthly);
    const payment = paymentId(config.network, config.asset, payload);
    const owner = payment ? await ownerDigest(request, payment.key) : null;
    let asked = null;
    if (owner) {
      try {
        asked = await requestDigest(request);
      } catch (e) {
        if (e instanceof BodyTooLarge) return failed(413, "body_too_large_for_idempotency_key", "refused");
        throw e;
      }
    }

    /** What to store and to answer for a settled payment. The token is the same whenever it is made. */
    async function outcomeOf(rec, settled) {
      const transaction = settled.data.transaction ?? null;
      const fields = { transaction };
      if (isMonthly) fields.token = await subs.issue({ buyer: payment.from, payment: (await sha256Hex(payment.key)).slice(0, 32), issuedAt: rec.issuedAt });
      const receipt = utf8ToBase64(JSON.stringify({ success: true, transaction, network: settled.data.network ?? config.network, payer: settled.data.payer ?? null }));
      return { fields, receipt };
    }
    const paidHeaders = (rec) => ({
      "hub-payment-status": "settled",
      ...(rec.receipt ? { "X-PAYMENT-RESPONSE": rec.receipt, "PAYMENT-RESPONSE": rec.receipt } : {}),
      ...(rec.token ? { [SUBSCRIPTION_HEADER]: rec.token } : {}),
    });
    /** Asks the chain. Returns a settlement when it proves that this authorization paid this seller. */
    const proven = async (startBlock, until) => {
      if (!proof) return { state: "unclear" };
      const found = await proof.look({ from: payment.from, nonce: payment.nonce, amount: reqs.amount, validBefore: payment.validBefore, startBlock, until });
      return found.state === "paid" ? { state: "paid", settled: { data: { transaction: found.transaction, payer: payment.from } } } : found;
    };

    /** Paid, and the buyer still has no reply: one call to the API. A failed one leaves it owed. */
    async function deliver(rec) {
      let r;
      try {
        r = await callUpstream(request, next);
      } catch {
        r = {};
      }
      if (!r.bytes) {
        await payments.owed(payment.key, rec.id, {}).catch(() => {});
        return failed(502, r.tooLarge ? "upstream_too_large" : "upstream_failed", "settled", paidHeaders(rec));
      }
      if (!(await payments.settled(payment.key, rec.id, {}))) return failed(409, "payment_in_progress", "settled");
      for (const [k, v] of Object.entries(paidHeaders(rec))) r.headers.set(k, v);
      return reply(r.upstream, r.bytes, r.headers);
    }

    /** The buyer who holds the key asks again about a payment whose reply they never had. */
    async function retry() {
      const rec = await payments.retry(payment.key);
      if (rec === null) return failed(409, "payment_in_progress", "unclear");
      if (rec.state === "delivering") return deliver(rec);
      // See settlement-table.mjs. The chain is asked first: a facilitator may answer a settled authorization with a failure, because its nonce is used.
      const until = Date.now() + ATTEMPT_MS;
      let first = rec.first ?? "ambiguous";
      let chain = await proven(rec.startBlock, until);
      let verdict = decide(first, chain.state);
      if (verdict === "unclear" && first !== "contested") {
        const before = chain.state;
        const settled = await facilitator("/settle", payload, reqs, until);
        const again = classify(settled);
        if (again === "ok") {
          first = "ok"; // settled by this very request
          chain = { state: "paid", settled };
        } else {
          first = reclassify(first, again, before);
          chain = { scannedTo: chain.scannedTo, ...(await proven(chain.scannedTo ?? rec.startBlock, until)) };
        }
        verdict = decide(first, chain.state);
      }
      if (verdict === "not_taken") {
        await payments.void(payment.key, rec.id);
        return quote(request, "payment_expired", undefined, "not_taken");
      }
      if (verdict !== "serve") {
        await payments.unclear(payment.key, rec.id, { first, scannedTo: chain.scannedTo });
        return verdict === "elsewhere" ? failed(409, "payment_settled_elsewhere", "settled") : failed(409, "settlement_unclear", "unclear");
      }
      const { fields, receipt } = await outcomeOf(rec, chain.settled);
      if (!(await payments.owed(payment.key, rec.id, { ...fields, receipt }))) return failed(409, "payment_in_progress", "settled");
      const mine = await payments.retry(payment.key);
      return mine === null ? failed(409, "payment_in_progress", "settled") : deliver(mine);
    }

    if (payment) {
      try {
        const rec = await payments.get(payment.key);
        if (!payments.isFree(rec)) {
          if (rec.state === "void") return quote(request, "payment_expired", undefined, "not_taken");
          const status = ["settled", "owed", "delivering"].includes(rec.state) ? "settled" : "unclear";
          // Not a 402: a client that takes it for "not paid" would pay twice.
          if (!owner || rec.owner !== owner) return failed(409, "payment_already_used", status);
          if (rec.state === "settled") return failed(409, "already_served", "settled", paidHeaders(rec)); // the token again, not the body
          if (rec.request !== asked) return failed(409, "not_the_same_request", status); // the paid call is the first one
          return await retry();
        }
      } catch {
        return failed(502, "store_unavailable", "unclear"); // an earlier request with this payment may have settled it
      }
    }

    const verified = await facilitator("/verify", payload, reqs);
    if (verified.data === null && !verified.ok) return failed(502, "facilitator_unavailable", "refused");
    if (!verified.ok || verified.data?.isValid !== true || !payment) {
      // No record (any more). Whether the same payment was settled before, only the chain can say.
      const state = payment && proof && mayLook(payload, verified) ? await proof.used(payment) : "unclear";
      if (state === "used") return failed(409, "payment_already_used", "unclear");
      return state === "void" ? quote(request, "payment_expired", undefined, "not_taken") : quote(request, "payment_invalid", undefined, "refused");
    }

    let claim;
    try {
      claim = await payments.claim(payment, owner, asked, now());
    } catch {
      return failed(502, "store_unavailable", "refused");
    }
    // The same buyer's other request was faster: it is being served, nothing is decided for this one.
    if (!claim.rec && owner && claim.existing.owner === owner) return failed(409, "payment_in_progress", "unclear");
    if (!claim.rec) return failed(409, "payment_already_used", ["settled", "owed", "delivering"].includes(claim.existing.state) ? "settled" : "unclear");
    const release = () => payments.release(payment.key, claim.rec.id).catch(() => {}); // nothing was settled

    let r;
    try {
      r = await callUpstream(request, next);
    } catch {
      await release();
      return failed(502, "upstream_failed", "not_taken");
    }
    if (!r.bytes) {
      await release();
      if (r.tooLarge) return failed(502, "upstream_too_large", "not_taken");
      const headers = new Headers(r.upstream.headers);
      headers.set("hub-payment-status", "not_taken"); // the buyer is not charged for a failed call
      return new Response(r.upstream.body, { status: r.upstream.status, statusText: r.upstream.statusText, headers });
    }

    let startBlock = null;
    try {
      startBlock = proof ? await proof.startBlock() : null;
      if (proof && startBlock === null) {
        // Without the block a lost answer could never be cleared up: rather settle nothing. /settle was not called.
        await release();
        return failed(503, "chain_unavailable", "not_taken", { "retry-after": "10" });
      }
      if (!(await payments.settling(payment.key, claim.rec.id, startBlock))) return failed(409, "payment_in_progress", "unclear"); // another request took it over after the lease
    } catch {
      await release();
      return failed(502, "store_unavailable", "not_taken"); // /settle was not called
    }
    const until = Date.now() + ATTEMPT_MS;
    let settled = await facilitator("/settle", payload, reqs, until);
    const first = classify(settled);
    if (first !== "ok") {
      // The claim is ours and nothing handed out yet: when the chain proves an ambiguous payment, it is served after all.
      const chain = first === "ambiguous" ? await proven(startBlock, until) : { state: "unclear" };
      if (decide(first, chain.state) !== "serve") {
        await payments.unclear(payment.key, claim.rec.id, { first, scannedTo: chain.scannedTo }).catch(() => {});
        return failed(409, "settlement_unclear", "unclear"); // fail closed: the body is withheld
      }
      settled = chain.settled;
    }
    const { fields, receipt } = await outcomeOf(claim.rec, settled).catch(() => ({ fields: null }));
    const recorded = fields && (await payments.settled(payment.key, claim.rec.id, { ...fields, receipt }).catch(() => false));
    if (!recorded) return failed(409, "settlement_unclear", "unclear"); // paid, but not on record: handed out only after that (a retry finds it)
    for (const [k, v] of Object.entries(paidHeaders({ ...fields, receipt }))) r.headers.set(k, v);
    return reply(r.upstream, r.bytes, r.headers);
  };
}
