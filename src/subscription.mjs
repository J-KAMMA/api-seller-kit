// Monthly subscription token (HMAC-SHA256) and quota counter. Token format (PREPAID-MONTHLY.md):
//   base64url(JSON {v:1, seller, buyer, resource, network, expiresAt, quota}) + "." + base64url(HMAC(secret, payloadPart))

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
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(parts[0])));
    if (!payload || typeof payload !== "object" || payload.v !== 1) return null;
    return { payload, signature: parts[1] };
  } catch {
    return null;
  }
}

/**
 * @param {{ seller: string, network: string, monthly: { quota: number|null, subscriptionSecret: string },
 *           store: { get(k:string):any, set(k:string,v:any):any }, now?: () => number, resourceOrigin: (request: Request) => string }} o
 */
export function createSubscriptions(o) {
  const { monthly, store } = o;
  const now = o.now ?? (() => Math.floor(Date.now() / 1000));
  const seller = o.seller.toLowerCase();
  const locks = new Map();

  function withLock(key, fn) {
    const run = (locks.get(key) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => {});
    locks.set(key, tail);
    tail.then(() => locks.get(key) === tail && locks.delete(key));
    return run;
  }

  return {
    /** Issue a token after a settled monthly payment. `buyer` is the EIP-3009 `from`. */
    async issue(buyer, request) {
      const payload = {
        v: 1,
        seller,
        buyer: String(buyer).toLowerCase(),
        resource: o.resourceOrigin(request),
        network: o.network,
        expiresAt: now() + PERIOD_DAYS * 86400,
        quota: monthly.quota ?? null,
      };
      const token = await signToken(monthly.subscriptionSecret, payload);
      await store.set(`quota:${token.split(".")[1]}`, { count: 1 }); // the purchasing call is the first use
      return token;
    },

    /** @returns {Promise<{ok:true, rollback:()=>Promise<void>}|{ok:false, error:string}>} */
    async accept(token, request) {
      const v = await verifyToken(monthly.subscriptionSecret, token);
      if (!v) return { ok: false, error: "subscription_invalid" };
      const p = v.payload;
      if (p.seller !== seller || p.network !== o.network) return { ok: false, error: "subscription_invalid" };
      if (typeof p.buyer !== "string" || !ADDRESS.test(p.buyer)) return { ok: false, error: "subscription_invalid" };
      if (p.resource !== o.resourceOrigin(request)) return { ok: false, error: "subscription_wrong_resource" };
      if (!Number.isInteger(p.expiresAt) || p.expiresAt <= now()) return { ok: false, error: "subscription_expired" };
      if (!(p.quota === null || (Number.isInteger(p.quota) && p.quota > 0))) return { ok: false, error: "subscription_invalid" };
      // the signed quota is the authority; the counter lives in the store
      const key = `quota:${v.signature}`;
      return withLock(key, async () => {
        const rec = await store.get(key);
        const count = Number.isInteger(rec?.count) && rec.count >= 0 ? rec.count : 0;
        if (p.quota !== null && count >= p.quota) return { ok: false, error: "subscription_quota_exceeded" };
        await store.set(key, { count: count + 1 });
        return {
          ok: true,
          rollback: () =>
            withLock(key, async () => {
              const cur = await store.get(key);
              const c = Number.isInteger(cur?.count) ? cur.count : 0;
              if (c > 0) await store.set(key, { count: c - 1 });
            }),
        };
      });
    },
  };
}
