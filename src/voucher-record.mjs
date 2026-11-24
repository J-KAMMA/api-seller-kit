// The stored record of one prepaid channel.
//
// Rule: every call uses the price per call, and a voucher covers a call when it reaches what is used so far plus that price. A failed
// call gives its price back. Calls may overlap and end in any order; what is used is always exactly (calls not failed) x price.
// A voucher is a promise "up to this amount" and cannot be lowered, so the vouchers received are kept and the channel is closed with
// the smallest one that covers what is used. A buyer that raises by the price per call (what the quote asks) is charged exactly what was
// served. When no voucher has exactly that amount (the buyer raised by more than the price), the next larger one is used: served calls
// are never unpaid, and the rest stays usable for further calls until the channel is closed.
//
// { used, cumulativeAmount, signature, deposit, held: [[amount, signature]...], closing?: {at, id}, closed?: true, closeTx? }
// cumulativeAmount + signature are the voucher to close with ("0" + null when nothing is used).

/** Vouchers kept besides what is needed; calls in flight on one channel beyond this may settle on a larger voucher, never a smaller one. */
const HELD_MAX = 16;
/** A close claim nobody finished stops blocking after this; far longer than a sent transaction stays minable in practice. */
export const CLOSING_LEASE_MS = 60 * 60 * 1000;

/** A channel id names neither its contract nor its chain, so every key does. */
export function channelKeys(chainId, channelContract) {
  const scope = `${Number(chainId)}:${String(channelContract).toLowerCase()}`;
  return { index: `channels:${scope}`, record: (channelId) => `channel:${scope}:${String(channelId).toLowerCase()}` };
}
/** Keys of 0.2.0 and older. Read only: never written, never deleted. */
export const LEGACY_KEYS = { index: "channels", record: (channelId) => `channel:${String(channelId).toLowerCase()}` };

const isAmount = (v) => typeof v === "string" && /^[0-9]+$/.test(v);

/** Is a close under way? The time comes from the process that claimed it. */
export function isClaimed(rec, now = Date.now()) {
  return rec?.closing !== undefined && !(now - rec.closing.at >= CLOSING_LEASE_MS);
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

function build(rec, used, held) {
  const settle = used === 0n ? null : held.find(([amount]) => amount >= used);
  if (used !== 0n && !settle) throw new Error("stored_voucher_missing"); // cannot happen: a call is only counted with a voucher covering it
  return {
    ...rec,
    used: used.toString(),
    cumulativeAmount: settle ? settle[0].toString() : "0",
    signature: settle ? settle[1] : null,
    held: held.map(([amount, signature]) => [amount.toString(), signature]),
  };
}

/** The record after one more call, paid by a voucher already checked to cover it. An unfinished, expired close claim is dropped. */
export function takeUse(rec, price, amount, signature, deposit) {
  const { used, held } = recordState(rec);
  const list = held.some(([a]) => a === amount) ? held : [...held, [amount, signature]].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const next = used + price;
  while (list.length > HELD_MAX) list.splice(list[0][0] < next ? 0 : list.length - 2, 1); // the oldest covered one; the highest is never dropped
  const { closing: _expired, ...rest } = rec ?? {};
  return build({ ...rest, deposit: deposit.toString() }, next, list);
}

/** The record after a call that failed. */
export function giveBack(rec, price) {
  const { used, held } = recordState(rec);
  return build(rec, used > price ? used - price : 0n, held);
}
