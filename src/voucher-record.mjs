// The stored record of one prepaid channel.
//
// Rule: every call uses the price per call, and a voucher covers a call when it reaches what is used so far plus that price. A failed
// call gives its price back. Calls may overlap and end in any order; what is used is always exactly (calls not failed) x price.
// A voucher is a promise "up to this amount" and cannot be lowered, so the vouchers received are kept and the channel is closed with
// the smallest one that covers what is used. A buyer that raises by the price per call (what the quote asks) is charged exactly what was
// served. When no voucher has exactly that amount (the buyer raised by more than the price), the next larger one is used: served calls
// are never unpaid, and the rest stays usable for further calls until the channel is closed.
//
// { used, cumulativeAmount, signature, deposit, held: [[amount, signature]...], calls: {id: [expiry, price]}, closing?, closed?: true, closeTx? }
// cumulativeAmount + signature are the voucher to close with ("0" + null when nothing is used). calls are the ones still running.
// closing: { v: 2, at, id, phase: "claimed" | "sent" | "unknown", tx?, amount?, signature?, mayBeOut? }, see close.mjs.

/** Vouchers kept; more calls than this running at once on one channel may settle on a larger voucher, never a smaller one. */
const HELD_MAX = 64;
const LOWER_MAX = 4;
/** A claim of a closer that died before it stored a transaction (so before broadcasting one) stops blocking after this. */
export const CLOSING_LEASE_MS = 60 * 60 * 1000;

/** The smallest deposit a gate accepts. The 402 quote and the check both use this. */
export function minDeposit(prepaid) {
  return BigInt(prepaid.minDepositAtomic ?? BigInt(prepaid.pricePerCallAtomic) * 10n);
}

/** A channel id names neither its contract nor its chain, so every key does. */
export function channelKeys(chainId, channelContract) {
  const scope = `${Number(chainId)}:${String(channelContract).toLowerCase()}`;
  return { index: `channels:${scope}`, record: (channelId) => `channel:${scope}:${String(channelId).toLowerCase()}` };
}
/** Keys of 0.2.0 and older. Read only: never written, never deleted. */
export const LEGACY_KEYS = { index: "channels", record: (channelId) => `channel:${String(channelId).toLowerCase()}` };

const isAmount = (v) => typeof v === "string" && /^[0-9]+$/.test(v);

/** Is a close under way? Time alone ends only a claim that certainly never broadcast anything. */
export function isClaimed(rec, now = Date.now()) {
  const c = rec?.closing;
  if (c === undefined) return false;
  return !(c.v === 2 && c.phase === "claimed" && !c.mayBeOut && now - c.at >= CLOSING_LEASE_MS);
}

const running = (rec, now) => Object.fromEntries(Object.entries(rec?.calls ?? {}).filter(([, call]) => call?.[0] > now));

/** Calls still running. One whose gate died counts until its expiry. */
export function callsInFlight(rec, now = Date.now()) {
  return Object.keys(running(rec, now)).length;
}

/** Reads a record, also one written by 0.2.0 and older (no used / held). Throws when it makes no sense. */
export function recordState(rec) {
  if (rec === null || rec === undefined) return { used: 0n, held: [] };
  if (!isAmount(rec.cumulativeAmount)) throw new Error("stored_voucher_malformed");
  if (rec.used === undefined) {
    return { used: BigInt(rec.cumulativeAmount), held: rec.signature ? [[BigInt(rec.cumulativeAmount), rec.signature]] : [] };
  }
  if (!isAmount(rec.used) || !Array.isArray(rec.held)) throw new Error("stored_voucher_malformed");
  const held = rec.held.map((h) => {
    if (!isAmount(h?.[0]) || typeof h[1] !== "string") throw new Error("stored_voucher_malformed");
    return [BigInt(h[0]), h[1]];
  });
  return { used: BigInt(rec.used), held };
}

/** The record after one more call, paid by a voucher already checked to cover it. An unfinished, expired close claim is dropped. */
export function takeUse(rec, price, amount, signature, deposit, call, now = Date.now()) {
  const { used, held } = recordState(rec);
  const list = held.some(([a]) => a === amount) ? held : [...held, [amount, signature]].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const { closing: _expired, ...rest } = rec ?? {};
  const calls = { ...running(rec, now), [call.id]: [call.expiry, price.toString()] };
  return build({ ...rest, deposit: deposit.toString() }, used + price, prune(list, used + price, calls), calls);
}

const openAmount = (calls) => Object.values(calls).reduce((sum, [, price]) => sum + BigInt(price), 0n);

/** A refused voucher that could settle the channel more exactly is kept, without counting a call. null: nothing to keep. */
export function keepVoucher(rec, amount, signature) {
  const { used, held } = recordState(rec);
  if (!rec || used === 0n || held.some(([a]) => a === amount)) return null;
  const calls = rec.calls ?? {};
  if (amount < used - openAmount(calls)) return null; // below what even failing calls can leave
  const list = prune([...held, [amount, signature]].sort((a, b) => (a[0] < b[0] ? -1 : 1)), used, calls);
  return list.some(([a]) => a === amount) ? build(rec, used, list, calls) : null;
}

/** The record after a call ended. A failed one gives its price back, also when its entry already expired. */
export function endCall(rec, id, price, failed) {
  const { used, held } = recordState(rec);
  const { [id]: _ended, ...calls } = rec.calls ?? {};
  const left = failed ? (used > price ? used - price : 0n) : used;
  return build(rec, left, prune(held, left, calls), calls);
}

/**
 * Keeps what any outcome of the running calls can need, the highest one, and a few lower ones (should the chain ever show a smaller
 * deposit); beyond HELD_MAX the second highest goes.
 */
function prune(held, used, calls) {
  const floor = used - openAmount(calls);
  const needed = held.filter(([amount]) => amount >= floor && amount > 0n);
  while (needed.length > HELD_MAX) needed.splice(needed.length - 2, 1);
  return [...held.filter(([amount]) => amount < floor).slice(-LOWER_MAX), ...needed];
}

function build(rec, used, held, calls) {
  const settle = used === 0n ? null : held.find(([amount]) => amount >= used);
  if (used !== 0n && !settle) throw new Error("stored_voucher_missing"); // cannot happen: a call is only counted with a voucher covering it
  return {
    ...rec,
    used: used.toString(),
    cumulativeAmount: settle ? settle[0].toString() : "0",
    signature: settle ? settle[1] : null,
    held: held.map(([amount, signature]) => [amount.toString(), signature]),
    calls,
  };
}
