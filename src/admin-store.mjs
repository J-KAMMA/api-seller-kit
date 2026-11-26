// Lets the seller's own machine close channels whose vouchers live in a Worker: the Worker needs no key, the close command no database.
// One route, two operations (get, compareAndSet), channel records only. Off unless a secret of 32+ characters is set. It fails closed: a
// request without the secret gets the same 404 as any unknown path, before the store is touched or the body is read. There is no CORS,
// and requests from browser pages (Origin header) are refused. Guessing a 32-character random secret is not feasible, so there is no
// lockout that a stranger could use to keep the seller from closing in time.
import { casUpdate, stableJson } from "./store.mjs";

export const ADMIN_PATH = "/__seller-store";
const HEADER = "x-seller-admin";
const MIN_SECRET = 32;
const MAX_BODY = 1024 * 1024;
const KEY = /^(channels?(:\d{1,12}:0x[0-9a-f]{40})?(:0x[0-9a-f]{64})?|closer:\d{1,12}:0x[0-9a-f]{40})$/; // channel records, and a closer's own state

async function digest(text) {
  const subtle = globalThis.crypto?.subtle ?? (await import("node:crypto")).webcrypto.subtle;
  return new Uint8Array(await subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

async function sameSecret(a, b) {
  const [x, y] = [await digest(a), await digest(b)];
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/**
 * @param {{ store: object, secret?: string, path?: string }} o
 * @returns {(request: Request) => Promise<Response|null>} null: not this route, go on
 */
export function createStoreAdmin({ store, secret, path = ADMIN_PATH }) {
  const on = typeof secret === "string" && secret.length >= MIN_SECRET;
  return async function admin(request) {
    if (new URL(request.url).pathname !== path) return null;
    const refuse = () => reply(404, { error: "not_found" });
    if (!on || request.method !== "POST" || request.headers.has("origin")) return refuse();
    if (!(await sameSecret(request.headers.get(HEADER) ?? "", secret))) return refuse();
    let body;
    try {
      const text = await request.text();
      if (text.length > MAX_BODY) return reply(413, { error: "too_large" });
      body = JSON.parse(text);
    } catch {
      return reply(400, { error: "bad_request" });
    }
    if (typeof body?.key !== "string" || !KEY.test(body.key)) return reply(400, { error: "bad_request" });
    try {
      if (body.op === "get") return reply(200, { value: (await store.get(body.key)) ?? null });
      if (body.op === "compareAndSet" && body.next !== undefined && body.next !== null) {
        // The caller names the value it has seen by its digest (an index can be long). The store still compares the value itself.
        const current = (await store.get(body.key)) ?? null;
        if (typeof body.expected !== "string" || hex(await digest(stableJson(current))) !== body.expected) return reply(200, { written: false });
        return reply(200, { written: (await store.compareAndSet(body.key, current, body.next)) === true });
      }
    } catch {
      return reply(502, { error: "store_unavailable" });
    }
    return reply(400, { error: "bad_request" });
  };
}

/** The store of a Worker that runs createStoreAdmin, for the close command. */
export function createRemoteStore(url, secret, { fetch: doFetch = (i, init) => globalThis.fetch(i, init), timeoutMs = 15_000 } = {}) {
  const target = new URL(url);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname);
  if (target.protocol !== "https:" && !(target.protocol === "http:" && local)) throw new Error("remote store: url must be https");
  if (typeof secret !== "string" || secret.length < MIN_SECRET) throw new Error(`remote store: secret must be ${MIN_SECRET}+ characters`);
  async function ask(body) {
    const res = await doFetch(target.href, {
      method: "POST",
      headers: { "content-type": "application/json", [HEADER]: secret },
      body: JSON.stringify(body),
      redirect: "manual", // the secret is never sent on to another address
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status !== 200) throw new Error(`remote store: status ${res.status}`);
    return res.json();
  }
  const store = {
    get: async (key) => (await ask({ op: "get", key })).value ?? null,
    compareAndSet: async (key, expected, next) => (await ask({ op: "compareAndSet", key, expected: hex(await digest(stableJson(expected ?? null))), next })).written === true,
    set: (key, value) => casUpdate(store, key, () => ({ next: value })),
  };
  return store;
}
