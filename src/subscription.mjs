// Monthly subscription token (HMAC-SHA256) and quota counter. Token format (PREPAID-MONTHLY.md):
//   base64url(JSON {v:2, seller, buyer, resource, path, price, network, expiresAt, quota, payment}) + "." + base64url(HMAC(secret, payloadPart))

import { casUpdate } from "./store.mjs";

export const PERIOD_DAYS = 30;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

async function getCrypto() {
  if (globalThis.crypto?.subtle) return globalThis.crypto;
  return (await import("node:crypto")).webcrypto; // Node 18 without the global
}

function toB64url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(text) {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("b64url");
  const pad = text.length % 4 === 0 ? "" : "=".repeat(4 - (text.length % 4));
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmac(secret, text) {
  const c = await getCrypto();
  const key = await c.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await c.subtle.sign("HMAC", key, new TextEncoder().encode(text)));
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function signToken(secret, payload) {
  const part = toB64url(new TextEncoder().encode(JSON.stringify(payload)));
  return `${part}.${toB64url(await hmac(secret, part))}`;
}

/** @returns {Promise<{payload: object, signature: string}|null>} null on any problem (never throws) */
export async function verifyToken(secret, token) {
  try {
    if (typeof token !== "string" || token.length > 2048) return null;
    const parts = token.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    const expected = await hmac(secret, parts[0]);
    if (!constantTimeEqual(expected, fromB64url(parts[1]))) return null;
    if (parts[1] !== toB64url(expected)) return null; // one spelling only: the counter is kept under this text
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(parts[0])));
    if (!payload || typeof payload !== "object" || (payload.v !== 1 && payload.v !== 2)) return null;
    return { payload, signature: parts[1] };
  } catch {
    return null;
  }
}

/**
 * @param {{ seller: string, network: string, monthly: { quota: number|null, subscriptionSecret: string },
 *           store: { get(k:string):any, compareAndSet(k:string,expected:any,next:any):any }, now?: () => number, resource: string }} o
 */
export function createSubscriptions(o) {
  const { monthly, store } = o;
  const now = o.now ?? (() => Math.floor(Date.now() / 1000));
  const seller = o.seller.toLowerCase();
  // From the config only: the Host header of a request says nothing about which API it is.
  const { origin, pathname } = new URL(o.resource);
  const price = String(monthly.priceAtomic);
  const prices = [price, ...(monthly.acceptPrices ?? []).map(String)];
  /** A counter we cannot read must not count as zero. */
  function used(rec) {
    if (rec === null) return 0;
    if (!Number.isInteger(rec.count) || rec.count < 0) throw new Error("stored_quota_malformed");
    return rec.count;
  }

  return {
    /** The token of one settled payment: always the same one, however often and wherever it is issued. The purchasing call is its first use. */
    async issue({ buyer, payment, issuedAt }) {
      const token = await signToken(monthly.subscriptionSecret, {
        v: 2,
        seller,
        buyer: String(buyer).toLowerCase(),
        resource: origin,
        path: pathname,
        price,
        network: o.network,
        expiresAt: issuedAt + PERIOD_DAYS * 86400,
        quota: monthly.quota ?? null,
        payment,
      });
      await casUpdate(store, `quota:${token.split(".")[1]}`, (rec) => (rec === null ? { next: { count: 1 } } : {}));
      return token;
    },

    /** @returns {Promise<{ok:true, rollback:()=>Promise<void>}|{ok:false, error:string}>} */
    async accept(token) {
      const v = await verifyToken(monthly.subscriptionSecret, token);
      if (!v) return { ok: false, error: "subscription_invalid" };
      const p = v.payload;
      if (p.seller !== seller || p.network !== o.network) return { ok: false, error: "subscription_invalid" };
      if (typeof p.buyer !== "string" || !ADDRESS.test(p.buyer)) return { ok: false, error: "subscription_invalid" };
      if (p.v === 2) {
        if (p.path !== pathname) return { ok: false, error: "subscription_wrong_resource" };
        if (!prices.includes(p.price)) return { ok: false, error: "subscription_wrong_plan" };
      } else if (p.quota !== (monthly.quota ?? null)) return { ok: false, error: "subscription_wrong_plan" }; // issued before 0.3.0 (runs out within 30 days): at least the same quota
      if (p.resource !== origin) return { ok: false, error: "subscription_wrong_resource" };
      if (!Number.isInteger(p.expiresAt) || p.expiresAt <= now()) return { ok: false, error: "subscription_expired" };
      if (!(p.quota === null || (Number.isInteger(p.quota) && p.quota > 0))) return { ok: false, error: "subscription_invalid" };
      // the signed quota is the authority; the counter lives in the store
      const key = `quota:${v.signature}`;
      return casUpdate(store, key, (rec) => {
        const count = used(rec);
        if (p.quota !== null && count >= p.quota) return { result: { ok: false, error: "subscription_quota_exceeded" } };
        return {
          next: { count: count + 1 },
          result: {
            ok: true,
            // gives back this one use, on top of whatever the others counted meanwhile
            rollback: () => casUpdate(store, key, (cur) => (used(cur) > 0 ? { next: { count: used(cur) - 1 } } : {})),
          },
        };
      });
    },
  };
}
