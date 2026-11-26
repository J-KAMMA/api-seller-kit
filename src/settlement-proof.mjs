// Reads from the chain whether one authorization was paid to this seller. Works with any facilitator, and trusts none.
// Paid: a successful transaction in which the token marked exactly this authorization as used, and whose next log is the token's Transfer
// of exactly the price from the buyer to payTo. (A used nonce alone proves nothing: the buyer may have signed it to somebody else.)
// Void: the authorization has run out on chain and was never used. Everything else is unclear.
const AUTHORIZATION_STATE = "0xe94a0102"; // authorizationState(address,bytes32)
const AUTHORIZATION_USED = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TIMEOUT_MS = 10_000;
/** On the way of every payment: short. */
const START_MS = 5_000;
/** RPCs limit the range of a log search, some to 100 blocks: start small, grow while it works, halve on an error. */
const FIRST_CHUNK = 64n;
const MAX_CHUNK = 2_000n;
/** One look; a longer search goes on from where it stopped at the next one. Shorter than the lease of an attempt. */
const BUDGET_MS = 30_000;
const word = (address) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/** depth: blocks below the head that count as settled. */
export function createSettlementProof({ rpcUrl, chainId, asset, payTo, doFetch, depth = 0n, budgetMs = BUDGET_MS }) {
  let checked = null;
  async function rpc(method, params, until = Infinity) {
    const left = Math.min(TIMEOUT_MS, until - Date.now());
    if (left <= 0) throw new Error("too_late");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), left);
    try {
      const res = await doFetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        redirect: "manual",
        signal: controller.signal,
      });
      const body = await res.json();
      if (body?.error) throw Object.assign(new Error("rpc_refused"), { refused: true });
      if (!res.ok || body?.result === undefined || body.result === null) throw new Error("rpc_error");
      return body.result;
    } finally {
      clearTimeout(timer);
    }
  }
  /** The chain id, read once; waiting for it (also for another caller's request) ends at this caller's deadline. */
  async function ready(until = Infinity) {
    checked ??= rpc("eth_chainId", []).then((id) => {
      if (Number(id) !== chainId) throw new Error("rpc_on_another_chain");
    });
    const mine = checked;
    let timer;
    const late = Number.isFinite(until) ? new Promise((_, no) => (timer = setTimeout(() => no(new Error("too_late")), Math.max(0, until - Date.now())))) : null;
    try {
      await (late ? Promise.race([mine, late]) : mine);
    } catch (e) {
      if (e?.message !== "too_late" && checked === mine) checked = null;
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  const hex = (n) => `0x${n.toString(16)}`;
  async function blockAt(number, until) {
    const b = await rpc("eth_getBlockByNumber", [hex(number), false], until);
    return { time: BigInt(b.timestamp) };
  }
  return {
    /**
     * The first block that can hold a settlement asked for after this call; null when the chain cannot be read now. Whatever was settled
     * up to here was not settled by us.
     */
    async startBlock() {
      try {
        const until = Date.now() + START_MS;
        await ready(until);
        return String(BigInt(await rpc("eth_blockNumber", [], until)) + 1n);
      } catch {
        return null;
      }
    },

    /** Only whether it was used: "used", "void", "unused" or "unclear". Never throws. */
    async used({ from, nonce, validBefore }) {
      try {
        await ready();
        const top = BigInt(await rpc("eth_blockNumber", []));
        const head = top > depth ? top - depth : 0n;
        const state = await rpc("eth_call", [{ to: asset, data: AUTHORIZATION_STATE + word(from).slice(2) + nonce.slice(2) }, hex(head)]);
        if (!/^0x[0-9a-fA-F]{64}$/.test(state)) return "unclear";
        if (BigInt(state) !== 0n) return "used";
        return validBefore !== null && (await blockAt(head)).time >= BigInt(validBefore) ? "void" : "unused";
      } catch {
        return "unclear";
      }
    },

    /**
     * "paid" (with the transaction), "void", "unused" (not yet, but still valid) or "unclear"; `scannedTo` is where the next look can go on. Never throws.
     * The search covers every block from startBlock to the end of the authorization's validity. What cannot be covered stays unclear, and
     * without a startBlock nothing counts as paid: an earlier settlement is somebody else's.
     */
    async look({ from, nonce, amount, validBefore, startBlock, until = Infinity }) {
      const deadline = Math.min(until, Date.now() + budgetMs); // for searching on
      const hard = Math.min(until, Date.now() + 2 * budgetMs); // for everything
      let next = startBlock === null || startBlock === undefined ? null : BigInt(startBlock);
      const unclear = () => ({ state: "unclear", ...(next === null ? {} : { scannedTo: String(next) }) });
      try {
        await ready(hard);
        const top = BigInt(await rpc("eth_blockNumber", [], hard));
        const head = top > depth ? top - depth : 0n;
        const last = await blockAt(head, hard);
        const data = AUTHORIZATION_STATE + word(from).slice(2) + nonce.slice(2).toLowerCase();
        const state = await rpc("eth_call", [{ to: asset, data }, hex(head)], hard);
        if (!/^0x[0-9a-fA-F]{64}$/.test(state)) return unclear();
        if (BigInt(state) === 0n) return validBefore !== null && last.time >= BigInt(validBefore) ? { state: "void" } : { ...unclear(), state: "unused" };
        if (next === null) return unclear();
        let size = FIRST_CHUNK;
        let cap = MAX_CHUNK;
        let progressed = false; // at least one step per look
        while (next <= head) {
          if (progressed && Date.now() > deadline) return unclear();
          const end = next + size - 1n < head ? next + size - 1n : head;
          let logs;
          try {
            logs = await rpc("eth_getLogs", [{ address: asset, topics: [AUTHORIZATION_USED, word(from), nonce.toLowerCase()], fromBlock: hex(next), toBlock: hex(end) }], hard);
          } catch (e) {
            if (!e.refused || size === 1n) throw e;
            size /= 2n;
            cap = size;
            continue;
          }
          for (const log of logs) {
            const receipt = await rpc("eth_getTransactionReceipt", [log.transactionHash], hard);
            if (receipt.status !== "0x1") continue;
            const at = receipt.logs.findIndex((l) => same(l.address, asset) && same(l.topics[0], AUTHORIZATION_USED) && same(l.topics[1], word(from)) && same(l.topics[2], nonce));
            const paid = at === -1 ? undefined : receipt.logs[at + 1];
            if (paid && BigInt(paid.logIndex) === BigInt(receipt.logs[at].logIndex) + 1n && same(paid.address, asset) && same(paid.topics[0], TRANSFER) && same(paid.topics[1], word(from)) && same(paid.topics[2], word(payTo)) && BigInt(paid.data) === BigInt(amount)) {
              return { state: "paid", transaction: receipt.transactionHash };
            }
            return unclear(); // used, but not for this seller and price
          }
          next = end + 1n;
          progressed = true;
          // The token takes no authorization after its validity: nothing to find beyond.
          if (validBefore !== null && next <= head && (await blockAt(end, hard)).time >= BigInt(validBefore)) return unclear();
          size = size * 2n < cap ? size * 2n : cap;
        }
      } catch {
        // cannot be read now
      }
      return unclear();
    },
  };
}
