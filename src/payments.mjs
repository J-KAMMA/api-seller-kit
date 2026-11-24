// One payment, one reply. A payment is the EIP-3009 authorization (network, asset, from, nonce), however its header is spelled.
//
//   running    the API is being called; nothing was asked to settle. Dead after the lease: anybody may claim it anew.
//   released   the API failed before that: may be claimed anew
//   settling   /settle was called, or is asked again. Dead after the lease: unclear.
//   unclear    the money may have moved. first: the class of the /settle answer, see settlement-table.mjs
//   owed       paid, but the buyer has not had a reply yet (found out on a retry). delivering: one is being made
//   settled    paid and answered
//   void       the authorization ran out unused
// After /settle was called nothing is ever released: no answer, an error and "duplicate" all leave open whether the money moved.
// Every step is a compare-and-set on the attempt id, and is recorded before anything is handed out.
//
// No reply bodies are kept. The buyer's `hub-idempotency-key` (32 to 200 random characters, new for every payment) proves the buyer on a
// retry; only its digest is stored. Nothing else does: a payment's signature and nonce are public on chain once it is settled.
import { casUpdate } from "./store.mjs";

export const IDEMPOTENCY_HEADER = "hub-idempotency-key";
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MAX_VALID_SECONDS = 24 * 3600;
const MARGIN_SECONDS = 3600;
/** How long a payment that still owes somebody something is remembered: longer than a monthly token lives. */
const LONG_SECONDS = 31 * 24 * 3600;
/** Longer than an attempt (ATTEMPT_MS) can take. */
const SETTLING_MS = 180_000;
export const ATTEMPT_MS = 120_000;
const seconds = () => Math.floor(Date.now() / 1000);
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

export async function sha256Hex(data) {
  const subtle = globalThis.crypto?.subtle ?? (await import("node:crypto")).webcrypto.subtle;
  return [...new Uint8Array(await subtle.digest("SHA-256", typeof data === "string" ? new TextEncoder().encode(data) : data))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** null when the buyer sent no usable key. */
const MAX_REQUEST_BODY = 1024 * 1024;
/** A request with an idempotency key whose body is too large to bind the key to. */
export class BodyTooLarge extends Error {}

/** A digest of method, address and body. The API still gets the original, unread. */
export async function requestDigest(request) {
  const chunks = [];
  let size = 0;
  if (request.body) {
    const reader = request.clone().body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BODY) {
        void reader.cancel().catch(() => {});
        throw new BodyTooLarge();
      }
      chunks.push(value);
    }
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return sha256Hex(JSON.stringify([request.method, request.url, request.headers.get("content-type") ?? "", await sha256Hex(all)]));
}

export async function ownerDigest(request, paymentKey) {
  const key = request.headers.get(IDEMPOTENCY_HEADER);
  return !key || key.length < 32 || key.length > 200 ? null : sha256Hex(JSON.stringify([paymentKey, key]));
}

/** null when the payload is no usable authorization. The record may be forgotten once the authorization is void. */
export function paymentId(network, asset, payload) {
  const a = payload?.payload?.authorization;
  if (!a || typeof a !== "object" || !ADDRESS.test(String(a.from)) || !HEX32.test(String(a.nonce))) return null;
  let until = seconds() + MAX_VALID_SECONDS;
  if (a.validBefore !== undefined) {
    if (!/^\d{1,20}$/.test(String(a.validBefore)) || Number(a.validBefore) > until) return null;
    until = Math.max(Number(a.validBefore), seconds());
  }
  return {
    key: `payment:${[network, asset, a.from, a.nonce].join("|").toLowerCase()}`,
    from: a.from,
    nonce: a.nonce.toLowerCase(),
    validBefore: a.validBefore === undefined ? null : String(a.validBefore),
    expiresAt: until + MARGIN_SECONDS,
  };
}

/** callMs: the longest a call to the API can take. */
export function createPayments(store, callMs) {
  const leases = { running: callMs + 60_000, settling: SETTLING_MS, delivering: callMs + 60_000 };
  const dead = (rec, state) => rec.state === state && Date.now() - rec.at > leases[state];
  const step = (key, id, from, change) => casUpdate(store, key, (cur) => (cur?.id === id && from.includes(cur.state) ? { next: { ...cur, at: Date.now(), ...change }, result: true } : { result: false }));
  return {
    get: async (key) => (await store.get(key)) ?? null,
    isFree: (rec) => rec === null || rec.state === "released" || dead(rec, "running"),

    /** { rec } when it is ours now, { existing } otherwise. issuedAt dates the monthly token, whenever it is issued. */
    claim({ key, expiresAt }, owner, request, issuedAt) {
      const rec = { state: "running", id: newId(), owner, request, at: Date.now(), claimedAt: seconds(), issuedAt, expiresAt };
      return casUpdate(store, key, (cur) => (this.isFree(cur) ? { next: rec, result: { rec } } : { result: { existing: cur } }));
    },
    release: (key, id) => step(key, id, ["running"], { state: "released", owner: null }),
    /** Must succeed before /settle is called. */
    settling: (key, id, startBlock) => step(key, id, ["running"], { state: "settling", startBlock }),
    unclear: (key, id, { first, scannedTo } = {}) =>
      step(key, id, ["settling"], { state: "unclear", expiresAt: seconds() + LONG_SECONDS, ...(first === undefined ? {} : { first }), ...(scannedTo === undefined ? {} : { startBlock: scannedTo }) }),
    /** The authorization ran out unused: nothing was paid and never will be. */
    void: (key, id) => step(key, id, ["settling"], { state: "void" }),
    /** fields: { token?, transaction } */
    settled: (key, id, fields) => step(key, id, ["settling", "delivering"], { state: "settled", ...fields, ...(fields.token ? { expiresAt: seconds() + LONG_SECONDS } : {}) }),
    owed: (key, id, fields) => step(key, id, ["settling", "delivering"], { state: "owed", expiresAt: seconds() + LONG_SECONDS, ...fields }),

    /** For the owner's retry: takes an open record for one attempt. null: another attempt is under way. */
    retry(key) {
      const id = newId();
      return casUpdate(store, key, (cur) => {
        if (cur === null) return { result: null };
        const ask = cur.state === "unclear" || dead(cur, "settling");
        const deliver = cur.state === "owed" || dead(cur, "delivering");
        if (!ask && !deliver) return { result: null };
        // a process that died while settling never told how /settle answered: no first class, that is ambiguous
        const next = { ...cur, id, at: Date.now(), state: ask ? "settling" : "delivering" };
        return { next, result: next };
      });
    },
  };
}
