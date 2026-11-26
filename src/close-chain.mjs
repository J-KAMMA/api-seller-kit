// The chain side of closing, with viem. The seller's key stays in the account object the caller passes in.
import { encodeFunctionData, keccak256 } from "viem";
import { CHANNEL_ABI } from "./channel.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const CONTRACT_ABI = [...CHANNEL_ABI, { type: "function", name: "challengePeriod", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] }];
/** A replacement must raise both fees by at least a tenth; 12.5% is the usual node rule. */
const raised = (v) => v + v / 8n + 1n;
const max = (a, b) => (a > b ? a : b);

/**
 * @param {{ publicClient: object, account: object|null, channelContract: string, chainId: number, maxFeePerGas: bigint,
 *           waitMs?: number, pollMs?: number, depth?: bigint, canPoll?: () => boolean }} o  depth: blocks below the head that count as settled;
 *           canPoll: asked before every look while waiting (a budget of requests)
 */
export function createCloseChain({ publicClient, account, channelContract, chainId, maxFeePerGas, waitMs = 120_000, pollMs = 1_000, depth = 0n, canPoll = () => true }) {
  const read = async (functionName, args, blockNumber) =>
    publicClient.readContract({ address: channelContract, abi: CONTRACT_ABI, functionName, args, ...(blockNumber === undefined ? {} : { blockNumber }) });
  const readChannel = async (channelId, blockNumber) => {
    const r = await read("getChannel", [channelId], blockNumber);
    return { ...r, status: Number(r.status), deposit: BigInt(r.deposit), closeRequestedAt: BigInt(r.closeRequestedAt) };
  };

  /** Channel and nonce at ONE block: nonce used while the channel is open proves that the transaction with that nonce did not close it. */
  async function snapshot(channelId, from) {
    const head = await publicClient.getBlockNumber({ cacheTime: 0 });
    const blockNumber = head > depth ? head - depth : 0n;
    const [channel, nonce] = await Promise.all([readChannel(channelId, blockNumber), publicClient.getTransactionCount({ address: from, blockNumber })]);
    return { status: channel.status, nonce: Number(nonce) };
  }

  const notSent = (reason, cause) => Object.assign(new Error(reason, { cause }), { closeNotSent: true, reason });

  async function sendClose(channelId, amount, signature, { replace, record }) {
    let tx, serialized;
    try {
      const data = encodeFunctionData({ abi: CHANNEL_ABI, functionName: "close", args: [channelId, amount, signature] });
      const fees = await publicClient.estimateFeesPerGas();
      let maxFee = fees.maxFeePerGas;
      let tip = fees.maxPriorityFeePerGas;
      let gas;
      if (replace) {
        gas = BigInt(replace.gas);
        maxFee = max(maxFee, raised(BigInt(replace.maxFeePerGas)));
        tip = max(tip, raised(BigInt(replace.maxPriorityFeePerGas)));
        if (maxFee > maxFeePerGas) {
          // no room to raise: send exactly the stored transaction again (same fields, same hash)
          maxFee = BigInt(replace.maxFeePerGas);
          tip = BigInt(replace.maxPriorityFeePerGas);
        }
      } else {
        if (maxFee > maxFeePerGas) throw new Error("fee_above_cap");
        const estimate = await publicClient.estimateGas({ account: account.address, to: channelContract, data });
        gas = estimate + estimate / 4n;
      }
      if (tip > maxFee) tip = maxFee;
      const nonce = replace ? replace.nonce : await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" });
      if (replace && replace.from.toLowerCase() !== account.address.toLowerCase()) throw new Error("other_sender");
      serialized = await account.signTransaction({ type: "eip1559", chainId, nonce, to: channelContract, data, value: 0n, gas, maxFeePerGas: maxFee, maxPriorityFeePerGas: tip });
      tx = { hash: keccak256(serialized), nonce, from: account.address.toLowerCase(), gas: gas.toString(), maxFeePerGas: maxFee.toString(), maxPriorityFeePerGas: tip.toString() };
      await record(tx); // stored before the network can know it
    } catch (e) {
      // With an earlier transaction still out, "this attempt was not sent" proves nothing about the claim.
      if (replace) throw new Error("not_replaced", { cause: e });
      throw notSent(/^(fee_above_cap|claim lost)$/.test(e.message) ? e.message.replace(" ", "_") : "close_failed", e);
    }
    let sendError = null;
    try {
      await publicClient.sendRawTransaction({ serializedTransaction: serialized });
    } catch (e) {
      sendError = e; // it may have reached the network all the same: the chain answers
    }
    const until = Date.now() + (sendError && !replace ? Math.min(waitMs, 5_000) : waitMs);
    for (;;) {
      const s = await snapshot(channelId, tx.from);
      if (s.status !== 1 && s.status !== 2) throw new Error("channel_unreadable", { cause: sendError });
      if (s.status === 2) {
        const receipt = await publicClient.getTransactionReceipt({ hash: tx.hash }).catch(() => null);
        if (receipt?.status === "success" && receipt.transactionHash?.toLowerCase() === tx.hash) return tx.hash;
        throw new Error("closed_by_another_transaction", { cause: sendError });
      }
      if (s.nonce > tx.nonce) throw notSent("close_failed", sendError); // reverted, or another transaction took the nonce
      if (Date.now() >= until || !canPoll()) throw new Error("unconfirmed", { cause: sendError }); // the next run finishes it
      await sleep(pollMs);
    }
  }

  /** The channel as of the settled depth. */
  const settledChannel = async (channelId) => {
    const head = await publicClient.getBlockNumber({ cacheTime: 0 });
    return readChannel(channelId, head > depth ? head - depth : 0n);
  };

  return {
    readChannel: (channelId) => readChannel(channelId),
    settledChannel,
    snapshot,
    sendClose,
    challengeSeconds: async () => Number(await read("challengePeriod", [])),
    chainTime: async () => Number((await publicClient.getBlock()).timestamp),
  };
}
