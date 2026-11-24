import { casUpdate, singleInstanceStore } from "./store.mjs";
import { earlierContracts, legacyRecord } from "./legacy.mjs";
import { callsInFlight, channelKeys, LEGACY_KEYS, recordState } from "./voucher-record.mjs";

// Close prepaid channels with the stored voucher that fits the served calls. Pure logic: the chain access is injected,
// so tests use fakes and bin/close-channels.mjs wires viem. This module never sees a private key.

const POLL_MS = 100;
const OPEN = 1;
const CLOSED = 2;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 1. Channels are taken one after the other, urgent ones first. Each is claimed in the store right before it is closed; gates refuse new
 *    vouchers on it from then on.
 * 2. Calls already running get until `drainMs` (for the whole run, and never more than a tenth of the challenge period or of what is left
 *    of it) to end, so failed ones are not charged. The voucher is chosen after that.
 * 3. The signed transaction's identity is stored before it is broadcast. From then on only the chain decides, never the clock:
 *    channel not open                              -> marked closed
 *    open, and the sender's nonce used, both read
 *    at one block                                  -> that transaction can no longer close it: released
 *    anything else                                 -> stays claimed; the next run sends again with the SAME nonce
 * A claim without a stored transaction was never broadcast; it stops blocking after an hour.
 * The stored vouchers are never touched here.
 *
 * sendClose(channelId, amount, signature, { replace, record }) must call `await record({hash, nonce, from, ...})` before broadcasting and
 * use `replace.nonce` when `replace` is given. It throws an error with `closeNotSent: true` when nothing was broadcast or the
 * transaction can no longer be mined.
 *
 * @param {{ store: { get(k:string):any, set(k:string,v:any):any, compareAndSet?(k:string,expected:any,next:any):any }, seller: string,
 *           chainId: number, channelContract: string,
 *           readChannel: (channelId: string) => Promise<{buyer:string, seller:string, status:number, deposit:bigint, closeRequestedAt?:bigint}>,
 *           settledChannel?: (channelId: string) => Promise<{status:number}>,
 *           snapshot?: (channelId: string, from: string) => Promise<{status:number, nonce:number}>,
 *           sendClose: Function, drainMs?: number, onlyRequested?: boolean, minAmountAtomic?: bigint, challengeSeconds?: number, chainTime?: () => Promise<number>,
 *           dryRun?: boolean, log?: (line: string) => void }} o
 * @returns {Promise<{ closed: string[], wouldClose: string[], skipped: {channelId:string, reason:string}[], failed: {channelId:string, reason:string}[],
 *                     drainTimedOut: {channelId:string, calls:number}[] }>}
 */
export async function closeChannels(o) {
  const log = o.log ?? (() => {});
  const atomic = singleInstanceStore(o.store);
  if (!Number.isInteger(o.chainId) || !/^0x[0-9a-fA-F]{40}$/.test(String(o.channelContract))) throw new Error("close: chainId and channelContract required");
  const keys = channelKeys(o.chainId, o.channelContract);
  const contract = o.channelContract.toLowerCase();
  const seller = o.seller.toLowerCase();
  const out = { closed: [], wouldClose: [], skipped: [], failed: [], drainTimedOut: [] };
  const skip = (channelId, reason) => void out.skipped.push({ channelId, reason });
  const failed = (channelId, reason) => void out.failed.push({ channelId, reason });
  const chainTime = o.chainTime ?? (async () => Math.floor(Date.now() / 1000));

  const markClosed = (key, tx) =>
    casUpdate(atomic, key, (cur) => {
      const { closing: _done, ...rest } = cur;
      return { next: { ...rest, closed: true, ...(tx ? { closeTx: tx } : {}) } };
    });

  /** Closed below the depth at which this chain counts as settled. Only then is anything marked or forgotten. */
  const closedForGood = async (channelId) => (await (o.settledChannel ?? o.readChannel)(channelId)).status === CLOSED;

  /** A channel that is closed for good needs no visit any more. Its record stays, so gates go on refusing it. */
  const forget = (channelId) => casUpdate(atomic, keys.index, (cur) => (Array.isArray(cur) && cur.includes(channelId) ? { next: cur.filter((id) => id !== channelId) } : {}));
  const payable = (rec, deposit) => recordState(rec).held.filter(([amount]) => amount <= deposit).at(-1) ?? null;

  /** Looks at one channel, without claiming it. Returns a job, or undefined when there is nothing to send. */
  async function prepare(channelId) {
    const key = keys.record(channelId);
    let rec = (await o.store.get(key)) ?? null;
    if (rec === null) {
      // written by 0.2.0 or older: ours only if the buyer signed it for this contract
      let found;
      try {
        const { buyer } = await o.readChannel(channelId);
        found = await legacyRecord({ store: o.store, chainId: o.chainId, contract, channelId, buyer, earlier: earlierContracts(o.chainId, contract) });
      } catch {
        return failed(channelId, "channel_unreadable");
      }
      if (found.mixed) return skip(channelId, "mixed_record");
      if (found.unknown || found.other) return skip(channelId, "other_contract");
      rec = found.record;
      if (rec !== null && !rec.closed && !o.dryRun) {
        try {
          rec = await casUpdate(atomic, key, (cur) => (cur === null ? { next: found.record, result: found.record } : { result: cur }));
          await casUpdate(atomic, keys.index, (cur) => (cur?.includes(channelId) ? {} : { next: [...(cur ?? []), channelId] }));
        } catch {
          return failed(channelId, "store_unavailable");
        }
      }
    }
    const amount = rec && typeof rec.cumulativeAmount === "string" && /^\d+$/.test(rec.cumulativeAmount) ? BigInt(rec.cumulativeAmount) : 0n;
    if (!rec || ((!rec.signature || amount === 0n) && !rec.closing && !rec.closed)) return skip(channelId, "no_voucher");
    let ch;
    try {
      ch = await o.readChannel(channelId);
    } catch {
      return failed(channelId, "channel_unreadable");
    }
    if (ch.status !== OPEN && ch.status !== CLOSED) return failed(channelId, "channel_unreadable"); // 0 = this RPC does not know it
    if (ch.status === CLOSED) {
      if (!o.dryRun && (await closedForGood(channelId).catch(() => false))) {
        if (!rec.closed) await markClosed(key).catch(() => {});
        await forget(channelId).catch(() => {});
      }
      return skip(channelId, rec.closed ? "already_closed" : "not_open_on_chain");
    }
    if (rec.closed) {
      log(`${channelId} was marked closed, but is open on chain: closing it again`);
      if (!o.dryRun) {
        try {
          rec = await casUpdate(atomic, key, (cur) => {
            const { closed: _not, closeTx: _tx, ...rest } = cur;
            // its transaction may still be out: never released, only finished
            const next = { ...rest, closing: rest.closing ?? { v: 2, at: Date.now(), id: "reopened", phase: "unknown" } };
            return { next, result: next };
          });
        } catch {
          return failed(channelId, "store_unavailable");
        }
      }
    }
    if (String(ch.seller).toLowerCase() !== seller) return skip(channelId, "other_seller");
    if (!rec.closing && amount > BigInt(ch.deposit) && !payable(rec, BigInt(ch.deposit))) return skip(channelId, "voucher_exceeds_deposit");
    const requestedAt = Number(ch.closeRequestedAt ?? 0n);
    // A claim that is there already is always followed up: it keeps the buyer out until it is resolved.
    if (requestedAt === 0 && !rec.closing) {
      if (o.onlyRequested) return skip(channelId, "close_not_requested");
      if (amount < BigInt(o.minAmountAtomic ?? 0n)) return skip(channelId, "below_minimum");
    } else if (requestedAt !== 0 && challengeMs !== 0 && (await chainTime()) * 1000 >= requestedAt * 1000 + challengeMs) {
      return skip(channelId, "challenge_period_over");
    }
    if (o.dryRun) {
      out.wouldClose.push(channelId);
      log(`would close ${channelId} cumulative=${amount} deposit=${ch.deposit}`);
      return undefined;
    }

    return { channelId, key, requestedAt };
  }

  /** Claims it, right before sending. */
  async function claim({ channelId, key, requestedAt }) {
    const rec = await o.store.get(key);
    if (!rec || rec.closed) return skip(channelId, "already_closed");
    // An earlier run's transaction: can it still be mined?
    let dead = null;
    if (rec.closing?.phase === "sent") {
      try {
        const s = await o.snapshot(channelId, rec.closing.tx.from);
        if (s.status === CLOSED) {
          await markClosed(key); // the snapshot is at the settled depth
          return skip(channelId, "not_open_on_chain");
        }
        if (s.status !== OPEN) return failed(channelId, "channel_unreadable");
        if (s.nonce > rec.closing.tx.nonce) dead = rec.closing.tx.hash;
      } catch {
        return failed(channelId, "close_unconfirmed");
      }
    }

    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let claimed;
    try {
      claimed = await casUpdate(atomic, key, (cur) => {
        recordState(cur);
        if (!cur || cur.closed) return { result: null };
        const was = cur.closing;
        const closing = { v: 2, at: Date.now(), id, phase: "claimed" };
        if (was?.phase === "sent" && was.tx.hash !== dead) Object.assign(closing, { phase: "sent", tx: was.tx, amount: was.amount, signature: was.signature });
        // A claim that does not say what it did (0.2.1, or a sender without identities) may have a transaction out: never released, only finished.
        if (was && (was.mayBeOut || was.phase === "unknown" || was.v !== 2)) closing.mayBeOut = true;
        const next = { ...cur, closing };
        return { next, result: next };
      });
    } catch {
      return failed(channelId, "store_unavailable");
    }
    if (!claimed) return skip(channelId, "already_closed");
    return { channelId, key, id, closing: claimed.closing, requestedAt };
  }

  /** Only our own claim, and only when no transaction can still be on its way. */
  const release = (job, provenDead = false) =>
    casUpdate(atomic, job.key, (cur) => {
      if (cur?.closing?.id !== job.id || cur.closing.mayBeOut || (cur.closing.phase === "sent" && !provenDead)) return {};
      const { closing: _mine, ...rest } = cur;
      return { next: rest };
    });
  const updateClaim = (job, change) =>
    casUpdate(atomic, job.key, (cur) => (cur?.closing?.id === job.id && !cur.closed ? { next: { ...cur, closing: { ...cur.closing, ...change } }, result: true } : { result: false }));

  /** Waits for the calls that were running when the channel was claimed. Returns how many still run. */
  async function drain(job, until) {
    let rec = await o.store.get(job.key);
    while (callsInFlight(rec) > 0 && Date.now() < until) {
      await sleep(Math.min(POLL_MS, Math.max(1, until - Date.now())));
      rec = await o.store.get(job.key);
    }
    return callsInFlight(rec);
  }

  async function send(job, runUntil) {
    const { channelId, key } = job;
    let sending = false;
    try {
      let { amount, signature, tx: replace } = job.closing;
      if (!replace) {
        let until = Math.min(runUntil, Date.now() + challengeMs / 10);
        if (job.requestedAt !== 0) {
          const left = job.requestedAt * 1000 + challengeMs - (await chainTime()) * 1000;
          until = Math.min(until, Date.now() + Math.max(0, left) / 10);
        }
        const calls = await drain(job, until);
        if (calls > 0 && o.drainMs > 0) {
          out.drainTimedOut.push({ channelId, calls });
          log(`${channelId}: ${calls} call(s) still running, closing without waiting longer`);
        }
      }
      // the claim froze the channel: read both sides again
      const now = await o.readChannel(channelId);
      if (now.status !== OPEN && now.status !== CLOSED) throw new Error("channel_unreadable");
      if (now.status === CLOSED) {
        if (await closedForGood(channelId)) await markClosed(key);
        return skip(channelId, "not_open_on_chain");
      }
      if (!replace) {
        const rec = await o.store.get(key);
        amount = rec.cumulativeAmount;
        signature = rec.signature;
        if (BigInt(amount) > BigInt(now.deposit)) {
          // the deposit shrank under us (a reorganisation): the best voucher it still covers
          const best = payable(rec, BigInt(now.deposit));
          if (best) {
            log(`${channelId}: deposit ${now.deposit} is below ${amount}, closing with ${best[0]}`);
            [amount, signature] = [best[0].toString(), best[1]];
          }
        }
      }
      if (BigInt(amount) === 0n || !signature || BigInt(amount) > BigInt(now.deposit)) {
        if (replace) return failed(channelId, "close_unconfirmed"); // a transaction is out: the claim stays
        await release(job);
        return skip(channelId, BigInt(amount) === 0n || !signature ? "no_voucher" : "voucher_exceeds_deposit");
      }
      if (!(await updateClaim(job, { at: Date.now() }))) return failed(channelId, "claim_lost"); // another run took over: it sends
      sending = true;
      const record = async (tx) => {
        const own = await updateClaim(job, { phase: "sent", tx, amount, signature });
        if (!own) throw Object.assign(new Error("claim lost"), { closeNotSent: true });
      };
      const tx = await o.sendClose(channelId, BigInt(amount), signature, { replace, record });
      if (!(await closedForGood(channelId))) throw new Error("not_closed_on_chain"); // whatever the sender says
      out.closed.push(channelId); // on chain, whatever happens to the mark below
      log(`closed ${channelId} cumulative=${amount} tx=${tx}`);
      await markClosed(key, tx).catch(() => log(`closed on chain, not yet marked in the store: ${channelId}`)); // the next run marks it
    } catch (e) {
      try {
        if (sending && (await closedForGood(channelId))) {
          await markClosed(key); // our transaction got through, or someone else's did
          out.closed.push(channelId);
          return undefined;
        }
        // Not sending yet: a transaction carried over from an earlier run is still out, so only a claim without one may go.
        if (sending ? e?.closeNotSent === true : job.closing.phase !== "sent") {
          await release(job, sending); // the sender proved it
          return failed(channelId, e?.reason ?? "close_failed");
        }
        // it may still be mined: keep refusing vouchers, run again
        await casUpdate(atomic, key, (cur) =>
          cur?.closing?.id === job.id && cur.closing.phase === "claimed" ? { next: { ...cur, closing: { ...cur.closing, phase: "unknown" } } } : {},
        );
      } catch {
        // the claim stays
      }
      failed(channelId, "close_unconfirmed");
    }
    return undefined;
  }

  const ids = new Set();
  for (const key of [keys.index, LEGACY_KEYS.index]) {
    const index = await o.store.get(key);
    if (Array.isArray(index)) for (const id of index) ids.add(id);
  }
  const challengeMs = (o.challengeSeconds ?? 0) * 1000; // unknown: no waiting
  const jobs = [];
  for (const channelId of ids) {
    try {
      const job = await prepare(channelId);
      if (job) jobs.push(job);
    } catch {
      failed(channelId, "store_unavailable"); // one channel never stops the others
    }
  }
  // Channels whose buyer asked to close first, the oldest request first.
  jobs.sort((a, b) => (a.requestedAt || Infinity) - (b.requestedAt || Infinity) || 0);
  const runUntil = Date.now() + (o.drainMs ?? 0);
  for (const candidate of jobs) {
    try {
      const job = await claim(candidate);
      if (job) await send(job, runUntil);
    } catch {
      failed(candidate.channelId, "store_unavailable");
    }
  }
  return out;
}
