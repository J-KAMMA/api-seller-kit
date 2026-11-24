import { casUpdate, singleInstanceStore } from "./store.mjs";
import { earlierContracts, legacyRecord } from "./legacy.mjs";
import { channelKeys, LEGACY_KEYS, recordState } from "./voucher-record.mjs";

// Close prepaid channels with the highest stored voucher. Pure logic: the chain access is injected,
// so tests use fakes and bin/close-channels.mjs wires viem. This module never sees a private key.

/**
 * Each channel is claimed in the store before the transaction is sent; gates refuse new vouchers on it from then on, so nothing can be
 * accepted that the transaction does not collect. Afterwards the chain decides:
 * - closed on chain: marked closed.
 * - sendClose threw an error with `closeNotSent: true` (nothing was broadcast, or the transaction reverted): the claim is released.
 * - anything else (the transaction may still be mined): the claim stays. Running this again finishes it, sending the same voucher; the
 *   contract pays once. Without another run the claim stops blocking after an hour.
 * The stored vouchers are never touched here.
 *
 * @param {{ store: { get(k:string):any, set(k:string,v:any):any, compareAndSet?(k:string,expected:any,next:any):any }, seller: string,
 *           chainId: number, channelContract: string,
 *           readChannel: (channelId: string) => Promise<{buyer:string, seller:string, status:number, deposit:bigint}>,
 *           sendClose: (channelId: string, cumulativeAmount: bigint, signature: string) => Promise<string>,
 *           dryRun?: boolean, log?: (line: string) => void }} o
 * @returns {Promise<{ closed: string[], wouldClose: string[], skipped: {channelId:string, reason:string}[], failed: {channelId:string, reason:string}[] }>}
 */
export async function closeChannels(o) {
  const log = o.log ?? (() => {});
  const atomic = singleInstanceStore(o.store);
  if (!Number.isInteger(o.chainId) || !/^0x[0-9a-fA-F]{40}$/.test(String(o.channelContract))) throw new Error("close: chainId and channelContract required");
  const keys = channelKeys(o.chainId, o.channelContract);
  const contract = o.channelContract.toLowerCase();
  const seller = o.seller.toLowerCase();
  const out = { closed: [], wouldClose: [], skipped: [], failed: [] };
  const ids = new Set();
  for (const key of [keys.index, LEGACY_KEYS.index]) {
    const index = await o.store.get(key);
    if (Array.isArray(index)) for (const id of index) ids.add(id);
  }
  for (const channelId of ids) {
    const key = keys.record(channelId);
    let rec = (await o.store.get(key)) ?? null;
    if (rec === null) {
      // written by 0.2.0 or older: ours only if the buyer signed it for this contract
      let found;
      try {
        const { buyer } = await o.readChannel(channelId);
        found = await legacyRecord({ store: o.store, chainId: o.chainId, contract, channelId, buyer, earlier: earlierContracts(o.chainId, contract) });
      } catch {
        out.failed.push({ channelId, reason: "channel_unreadable" });
        continue;
      }
      if (found.unknown || found.other) {
        out.skipped.push({ channelId, reason: "other_contract" });
        continue;
      }
      rec = found.record;
      if (rec !== null && !rec.closed && !o.dryRun) {
        try {
          rec = await casUpdate(atomic, key, (cur) => (cur === null ? { next: found.record, result: found.record } : { result: cur }));
          await casUpdate(atomic, keys.index, (cur) => (cur?.includes(channelId) ? {} : { next: [...(cur ?? []), channelId] }));
        } catch {
          out.failed.push({ channelId, reason: "store_unavailable" });
          continue;
        }
      }
    }
    const amount = rec && typeof rec.cumulativeAmount === "string" && /^\d+$/.test(rec.cumulativeAmount) ? BigInt(rec.cumulativeAmount) : 0n;
    if (!rec || !rec.signature || amount === 0n) {
      out.skipped.push({ channelId, reason: "no_voucher" });
      continue;
    }
    if (rec.closed) {
      out.skipped.push({ channelId, reason: "already_closed" });
      continue;
    }
    let ch;
    try {
      ch = await o.readChannel(channelId);
    } catch {
      out.failed.push({ channelId, reason: "channel_unreadable" });
      continue;
    }
    if (ch.status !== 1) {
      if (rec.closing && !o.dryRun) {
        await casUpdate(atomic, key, (cur) => {
          const { closing: _done, ...rest } = cur ?? rec;
          return { next: { ...rest, closed: true } };
        }).catch(() => {});
      }
      out.skipped.push({ channelId, reason: "not_open_on_chain" });
      continue;
    }
    if (String(ch.seller).toLowerCase() !== seller) {
      out.skipped.push({ channelId, reason: "other_seller" });
      continue;
    }
    if (amount > BigInt(ch.deposit)) {
      out.skipped.push({ channelId, reason: "voucher_exceeds_deposit" });
      continue;
    }
    if (o.dryRun) {
      out.wouldClose.push(channelId);
      log(`would close ${channelId} cumulative=${amount} deposit=${ch.deposit}`);
      continue;
    }
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const markClosed = (tx) =>
      casUpdate(atomic, key, (cur) => {
        const { closing: _done, ...rest } = cur ?? rec;
        return { next: { ...rest, closed: true, ...(tx ? { closeTx: tx } : {}) } };
      });
    /** Only our own claim, and only when nobody's transaction can still be on its way. */
    const release = () =>
      casUpdate(atomic, key, (cur) => {
        if (cur?.closing?.id !== id || cur.closing.uncertain) return {};
        const { closing: _mine, ...rest } = cur;
        return { next: rest };
      });
    let claimed;
    try {
      claimed = await casUpdate(atomic, key, (cur) => {
        recordState(cur);
        if (!cur || cur.closed) return { result: null };
        const next = { ...cur, closing: { at: Date.now(), id, ...(cur.closing ? { uncertain: true } : {}) } };
        return { next, result: next };
      });
    } catch {
      out.failed.push({ channelId, reason: "store_unavailable" });
      continue;
    }
    if (!claimed) {
      out.skipped.push({ channelId, reason: "already_closed" });
      continue;
    }
    let sending = false;
    try {
      // the claim froze the voucher: read both sides again
      const amountNow = BigInt(claimed.cumulativeAmount);
      const now = await o.readChannel(channelId);
      if (now.status !== 1) {
        await markClosed();
        out.skipped.push({ channelId, reason: "not_open_on_chain" });
        continue;
      }
      if (amountNow === 0n || !claimed.signature || amountNow > BigInt(now.deposit)) {
        await release();
        out.skipped.push({ channelId, reason: amountNow === 0n || !claimed.signature ? "no_voucher" : "voucher_exceeds_deposit" });
        continue;
      }
      sending = true;
      const tx = await o.sendClose(channelId, amountNow, claimed.signature);
      out.closed.push(channelId); // on chain, whatever happens to the mark below
      log(`closed ${channelId} cumulative=${amountNow} tx=${tx}`);
      await markClosed(tx).catch(() => log(`closed on chain, not yet marked in the store: ${channelId}`)); // the next run marks it
    } catch (e) {
      let reason = "close_failed";
      try {
        if (sending && (await o.readChannel(channelId)).status !== 1) {
          await markClosed(); // our transaction got through, or someone else's did
          out.closed.push(channelId);
          continue;
        }
        if (!sending || e?.closeNotSent === true) await release();
        else reason = "close_unconfirmed"; // it may still be mined: keep refusing vouchers, run again
      } catch {
        reason = "close_unconfirmed";
      }
      out.failed.push({ channelId, reason });
    }
  }
  return out;
}
