import { casUpdate, singleInstanceStore } from "./store.mjs";

// Close prepaid channels with the highest stored voucher. Pure logic: the chain access is injected,
// so tests use fakes and bin/close-channels.mjs wires viem. This module never sees a private key.

/**
 * @param {{ store: { get(k:string):any, set(k:string,v:any):any, compareAndSet?(k:string,expected:any,next:any):any }, seller: string,
 *           readChannel: (channelId: string) => Promise<{seller:string, status:number, deposit:bigint}>,
 *           sendClose: (channelId: string, cumulativeAmount: bigint, signature: string) => Promise<string>,
 *           dryRun?: boolean, log?: (line: string) => void }} o
 * @returns {Promise<{ closed: string[], wouldClose: string[], skipped: {channelId:string, reason:string}[], failed: {channelId:string, reason:string}[] }>}
 */
export async function closeChannels(o) {
  const log = o.log ?? (() => {});
  const atomic = singleInstanceStore(o.store);
  const seller = o.seller.toLowerCase();
  const out = { closed: [], wouldClose: [], skipped: [], failed: [] };
  const index = await o.store.get("channels");
  const ids = Array.isArray(index) ? index : [];
  for (const channelId of ids) {
    const rec = await o.store.get(`channel:${channelId}`);
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
    try {
      const tx = await o.sendClose(channelId, amount, rec.signature);
      // marks whatever is stored now: a gate may have stored a higher voucher meanwhile
      await casUpdate(atomic, `channel:${channelId}`, (cur) => ({ next: { ...(cur ?? rec), closed: true, closeTx: tx } }));
      out.closed.push(channelId);
      log(`closed ${channelId} cumulative=${amount} tx=${tx}`);
    } catch {
      out.failed.push({ channelId, reason: "close_failed" });
    }
  }
  return out;
}
