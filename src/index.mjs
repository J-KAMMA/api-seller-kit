// x402 per-call gate for sellers (testnet only). Fetch API only: Workers and Node 18+.
// Flow: no payment -> 402 quote; payment -> facilitator /verify -> upstream -> (2xx only) /settle -> reply.
// Fail closed: any verify/settle problem means the body is never returned. The payment payload is never logged.
// Optional modes (PREPAID-MONTHLY.md): `prepaid` (hub-channel voucher) and `monthly` (hub-subscription token).
import { createSubscriptions } from "./subscription.mjs";
import { createFileStore } from "./store.mjs";

/** @typedef {{
 *   network: string, asset: string, payTo: string, seller: string, priceAtomic: string|number|bigint,
 *   facilitatorUrl: string, description?: string, resource?: string, mimeType?: string,
 *   maxTimeoutSeconds?: number, tokenName?: string, tokenVersion?: string,
 *   facilitatorHeaders?: Record<string,string>, fetch?: typeof fetch, allowedNetworks?: string[],
 *   allowLocalDevNetwork?: boolean,
 *   prepaid?: { pricePerCallAtomic: string|number|bigint, channelContract: string, minDepositAtomic?: string|number|bigint, rpcUrl?: string, readChannel?: Function },
 *   monthly?: { priceAtomic: string|number|bigint, quota: number|null, subscriptionSecret: string },
 *   store?: { get(key: string): any, set(key: string, value: any): any }, storePath?: string, now?: () => number
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

/** Header names the Desktop buyer sends / reads (x402 v2), plus the v1 names for other buyers. */
const REQUEST_HEADERS = ["payment-signature", "x-payment"];
const VOUCHER_HEADER = "hub-channel-voucher";
const SUBSCRIPTION_HEADER = "hub-subscription";
const RECEIPT_HEADER = "hub-channel-receipt";

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

function assertConfig(c) {
  const bad = (m) => {
    throw new Error(`x402 gate config: ${m}`);
  };
  if (!c || typeof c !== "object") bad("config required");
  const allowed = c.allowedNetworks ?? (c.allowLocalDevNetwork === true ? [...TESTNETS, LOCAL_DEV_NETWORK] : TESTNETS);
  if (!NETWORK.test(c.network) || !allowed.includes(c.network)) bad(`network must be one of ${allowed.join(", ")}`);
  for (const k of ["asset", "payTo", "seller"]) if (!ADDRESS.test(String(c[k]))) bad(`${k} must be a 0x address`);
  if (!/^[1-9]\d{0,29}$/.test(String(c.priceAtomic))) bad("priceAtomic must be a positive integer (atomic units)");
  let url;
  try {
    url = new URL(c.facilitatorUrl);
  } catch {
    bad("facilitatorUrl invalid");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) bad("facilitatorUrl must be https");
  if (c.network === LOCAL_DEV_NETWORK && !local) bad("local dev network needs a loopback facilitatorUrl");
  if (c.prepaid !== undefined) {
    const p = c.prepaid;
    if (!p || typeof p !== "object") bad("prepaid must be an object");
    if (!/^[1-9]\d{0,29}$/.test(String(p.pricePerCallAtomic))) bad("prepaid.pricePerCallAtomic must be a positive integer");
    if (!ADDRESS.test(String(p.channelContract))) bad("prepaid.channelContract must be a 0x address");
    if (p.minDepositAtomic !== undefined && !/^[1-9]\d{0,29}$/.test(String(p.minDepositAtomic))) bad("prepaid.minDepositAtomic must be a positive integer");
    if (typeof p.readChannel !== "function") {
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
    if (typeof m.subscriptionSecret !== "string" || m.subscriptionSecret.length < 16) bad("monthly.subscriptionSecret must be a string of 16+ characters");
  }
}

/**
 * @param {GateConfig} config
 * @returns {(request: Request, next: (request: Request) => Promise<Response>) => Promise<Response>}
 */
export function createX402Gate(config) {
  assertConfig(config);
  const doFetch = config.fetch ?? ((input, init) => globalThis.fetch(input, init)); // Workers: keep fetch bound
  const base = config.facilitatorUrl.replace(/\/+$/, "");
  const price = String(config.priceAtomic);
  const timeout = config.maxTimeoutSeconds ?? 300;
  const store = config.prepaid || config.monthly ? (config.store ?? createFileStore(config.storePath ?? "./seller-kit-store.json")) : null;
  const resourceOrigin = (request) => {
    try {
      return new URL(config.resource ?? request.url).origin;
    } catch {
      return "";
    }
  };
  const subs = config.monthly
    ? createSubscriptions({ seller: config.seller, network: config.network, monthly: config.monthly, store, now: config.now, resourceOrigin })
    : null;
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
        minDepositAtomic: String(config.prepaid.minDepositAtomic ?? BigInt(config.prepaid.pricePerCallAtomic) * 10n),
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
      },
    };
  }

  function json(status, body, headers = {}) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
    });
  }

  function quote(request, error) {
    const accepts = [requirements(request)];
    if (config.prepaid) accepts.push(channelEntry(request));
    if (config.monthly) accepts.push(requirements(request, true));
    const body = { x402Version: 2, accepts };
    if (error) body.error = error;
    // Buyers read the quote from the `payment-required` header (v2) or from the body.
    return json(402, body, { "payment-required": utf8ToBase64(JSON.stringify(body)) });
  }

  async function facilitator(path, paymentPayload, paymentRequirements) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FACILITATOR_TIMEOUT_MS);
    try {
      const res = await doFetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(config.facilitatorHeaders ?? {}) },
        body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements }),
        redirect: "manual", // Workers do not support "error"; a redirect is treated as unavailable below
        signal: controller.signal,
      });
      if (res.status >= 300 && res.status < 400) return { ok: false, data: null };
      const data = await res.json().catch(() => null);
      return { ok: res.ok, data };
    } catch {
      return { ok: false, data: null };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Serve an already-authorised call (subscription or voucher): roll the counter back when upstream fails. */
  async function serveAuthorised(request, next, rollback, extraHeaders) {
    let upstream;
    try {
      upstream = await next(request);
    } catch {
      await rollback();
      return json(502, { error: "upstream_failed" });
    }
    if (!(upstream.status >= 200 && upstream.status < 300)) {
      await rollback();
      return upstream;
    }
    const bytes = new Uint8Array(await upstream.arrayBuffer());
    if (bytes.byteLength > MAX_BODY_BYTES) {
      await rollback();
      return json(502, { error: "upstream_too_large" });
    }
    const headers = new Headers(upstream.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
    return new Response(bytes, { status: upstream.status, statusText: upstream.statusText, headers });
  }

  return async function gate(request, next) {
    let modeError = null;

    const token = subs ? request.headers.get(SUBSCRIPTION_HEADER) : null;
    if (token) {
      let r;
      try {
        r = await subs.accept(token, request);
      } catch {
        return json(502, { error: "store_unavailable" });
      }
      if (r.ok) return serveAuthorised(request, next, r.rollback, {});
      modeError = r.error;
    }

    const voucher = config.prepaid ? request.headers.get(VOUCHER_HEADER) : null;
    if (voucher) {
      let r;
      try {
        r = await (await channels()).accept(voucher);
      } catch {
        return json(502, { error: "channel_unavailable" });
      }
      if (r.ok) return serveAuthorised(request, next, r.rollback, { [RECEIPT_HEADER]: r.receipt });
      if (r.status !== 402) return json(r.status, { error: r.error });
      modeError = r.error;
    }

    let header = null;
    for (const name of REQUEST_HEADERS) {
      header = request.headers.get(name);
      if (header) break;
    }
    if (!header) return quote(request, modeError ?? undefined);
    if (header.length > MAX_PAYMENT_HEADER) return quote(request, "payment_header_too_large");

    let payload;
    try {
      payload = JSON.parse(base64ToUtf8(header));
    } catch {
      return quote(request, "payment_header_invalid");
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return quote(request, "payment_header_invalid");

    // Both requirement sets come from config; the buyer's hint only picks one and the facilitator verifies against it.
    const isMonthly = config.monthly !== undefined && payload.accepted?.extra?.plan === "monthly";
    const reqs = requirements(request, isMonthly);
    let monthlyBuyer = null;
    if (isMonthly) {
      monthlyBuyer = payload.payload?.authorization?.from;
      if (typeof monthlyBuyer !== "string" || !ADDRESS.test(monthlyBuyer)) return quote(request, "payment_invalid");
    }

    const verified = await facilitator("/verify", payload, reqs);
    if (verified.data === null && !verified.ok) return json(502, { error: "facilitator_unavailable" });
    if (!verified.ok || verified.data?.isValid !== true) {
      return quote(request, "payment_invalid");
    }

    let upstream;
    try {
      upstream = await next(request);
    } catch {
      return json(502, { error: "upstream_failed" }); // nothing was settled
    }
    if (!(upstream.status >= 200 && upstream.status < 300)) {
      return upstream; // the buyer is not charged for a failed call
    }

    // Buffer first so the settlement does not race a half-read stream, and so the cap holds.
    const bytes = new Uint8Array(await upstream.arrayBuffer());
    if (bytes.byteLength > MAX_BODY_BYTES) return json(502, { error: "upstream_too_large" });

    const settled = await facilitator("/settle", payload, reqs);
    if (!settled.ok || settled.data?.success !== true) {
      return json(502, { error: "settlement_failed" }); // fail closed: the body is withheld
    }
    const receipt = utf8ToBase64(
      JSON.stringify({
        success: true,
        transaction: settled.data.transaction ?? null,
        network: settled.data.network ?? config.network,
        payer: settled.data.payer ?? null,
      }),
    );
    const headers = new Headers(upstream.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.set("X-PAYMENT-RESPONSE", receipt);
    headers.set("PAYMENT-RESPONSE", receipt);
    if (isMonthly) {
      // The payment is settled, so the body is served even if recording the token fails (the buyer can show the tx).
      try {
        headers.set(SUBSCRIPTION_HEADER, await subs.issue(monthlyBuyer, request));
      } catch {
        /* no token */
      }
    }
    return new Response(bytes, { status: upstream.status, statusText: upstream.statusText, headers });
  };
}
