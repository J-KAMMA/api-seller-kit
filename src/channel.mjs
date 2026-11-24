// Prepaid channel vouchers (ApiPaymentChannelV1 / V2: same ABI and voucher). Loaded lazily by the gate; needs `viem`.
// Nothing the buyer sends is trusted for deposit / buyer / seller: all of it is read from the chain.
import { decodeFunctionResult, encodeFunctionData, recoverTypedDataAddress } from "viem";
import { earlierContracts, legacyRecord, VOUCHER_TYPES } from "./legacy.mjs";
import { casUpdate } from "./store.mjs";
import { channelKeys, endCall, isClaimed, keepVoucher, minDeposit, recordState, takeUse } from "./voucher-record.mjs";

export const CHANNEL_ABI = [
  {
    type: "function",
    name: "getChannel",
    stateMutability: "view",
    inputs: [{ name: "channelId", type: "bytes32" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "buyer", type: "address" },
          { name: "seller", type: "address" },
          { name: "token", type: "address" },
          { name: "deposit", type: "uint128" },
          { name: "closeRequestedAt", type: "uint64" },
          { name: "status", type: "uint8" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "close",
    stateMutability: "nonpayable",
    inputs: [
      { name: "channelId", type: "bytes32" },
      { name: "cumulativeAmount", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
];

export { VOUCHER_TYPES };

export const STATUS_OPEN = 1;
const RPC_TIMEOUT_MS = 10_000;
const MAX_VOUCHER_HEADER = 4 * 1024;
const MAX_UINT256 = (1n << 256n) - 1n;
const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/** The canonical ECDSA form only: 65 bytes, low s, v = 27 or 28. */
function isCanonicalSignature(signature) {
  return typeof signature === "string" && /^0x[0-9a-fA-F]{128}1[bBcC]$/.test(signature) && BigInt(`0x${signature.slice(66, 130)}`) <= SECP256K1_HALF_N;
}

function base64ToUtf8(b64) {
  const bin = atob(b64);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function utf8ToBase64(text) {
  let bin = "";
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function rpcCall({ rpcUrl, method, params, doFetch }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    const res = await doFetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      redirect: "manual",
      signal: controller.signal,
    });
    const body = await res.json();
    if (!res.ok || typeof body?.result !== "string") throw new Error("rpc_error");
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

/** JSON-RPC eth_call getChannel. Returns {buyer, seller, token, deposit: bigint, closeRequestedAt: bigint, status: number}. Throws on any problem. */
export async function readChannelViaRpc({ rpcUrl, channelContract, channelId, doFetch = (input, init) => globalThis.fetch(input, init) }) {
  const data = encodeFunctionData({ abi: CHANNEL_ABI, functionName: "getChannel", args: [channelId] });
  const result = await rpcCall({ rpcUrl, method: "eth_call", params: [{ to: channelContract, data }, "latest"], doFetch });
  const r = decodeFunctionResult({ abi: CHANNEL_ABI, functionName: "getChannel", data: result });
  return { ...r, deposit: BigInt(r.deposit), closeRequestedAt: BigInt(r.closeRequestedAt), status: Number(r.status) };
}

/**
 * @param {{ network: string, asset: string, seller: string, resource?: string,
 *           prepaid: { pricePerCallAtomic: string|number|bigint, channelContract: string, minDepositAtomic?: string,
 *                      rpcUrl?: string, readChannel?: (channelId: string) => Promise<object> },
 *           store: { get(k:string):any, compareAndSet(k:string,expected:any,next:any):any }, doFetch?: typeof fetch }} o
 */
export function createChannelHandler(o) {
  const { prepaid, store } = o;
  const chainId = Number(o.network.split(":")[1]);
  const contract = prepaid.channelContract.toLowerCase();
  const price = BigInt(prepaid.pricePerCallAtomic);
  const seller = o.seller.toLowerCase();
  const asset = o.asset.toLowerCase();
  const keys = channelKeys(chainId, contract);
  const earlier = earlierContracts(chainId, contract, prepaid.earlierContracts);
  let chainChecked = null; // once per process: the RPC really is on the configured chain
  const read =
    prepaid.readChannel ??
    (async (channelId) => {
      const channel = await readChannelViaRpc({ rpcUrl: prepaid.rpcUrl, channelContract: contract, channelId, doFetch: o.doFetch });
      chainChecked ??= rpcCall({ rpcUrl: prepaid.rpcUrl, method: "eth_chainId", params: [], doFetch: o.doFetch }).then((id) => {
        if (Number(id) !== chainId) throw new Error("rpc_on_another_chain");
      });
      try {
        await chainChecked;
      } catch (e) {
        chainChecked = null;
        throw e;
      }
      return channel;
    });
  let warned = false;
  const smallest = minDeposit(prepaid);
  const callTimeout = prepaid.callTimeoutMs ?? 600_000;
  const reject = (error) => ({ ok: false, status: 402, error });

  /** @returns {Promise<{ok:true, receipt:string, rollback:()=>Promise<void>, done:()=>Promise<void>}|{ok:false, status:number, error:string}>} */
  async function accept(headerValue) {
    if (typeof headerValue !== "string" || headerValue.length > MAX_VOUCHER_HEADER) return reject("voucher_invalid");
    let v;
    try {
      v = JSON.parse(base64ToUtf8(headerValue));
    } catch {
      return reject("voucher_invalid");
    }
    if (!v || typeof v !== "object" || Array.isArray(v)) return reject("voucher_invalid");
    if (typeof v.channelId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(v.channelId)) return reject("voucher_invalid");
    if (typeof v.cumulativeAmount !== "string" || !/^(0|[1-9]\d{0,77})$/.test(v.cumulativeAmount)) return reject("voucher_invalid");
    if (!isCanonicalSignature(v.signature)) return reject("voucher_invalid");
    const cumulative = BigInt(v.cumulativeAmount);
    if (cumulative > MAX_UINT256) return reject("voucher_invalid");
    const channelId = v.channelId.toLowerCase();

    let ch;
    try {
      ch = await read(channelId);
    } catch {
      return { ok: false, status: 502, error: "channel_unreadable" }; // fail closed
    }
    if (!ch || ch.status !== STATUS_OPEN) return reject("channel_not_open");
    if (BigInt(ch.closeRequestedAt) !== 0n) return reject("channel_closing"); // buyer asked to close: take no new calls
    if (String(ch.seller).toLowerCase() !== seller) return reject("channel_wrong_seller");
    if (String(ch.token).toLowerCase() !== asset) return reject("channel_wrong_token");
    const deposit = BigInt(ch.deposit);
    if (deposit < smallest) return reject("deposit_too_small");
    if (cumulative > deposit) return reject("voucher_exceeds_deposit");

    let signer;
    try {
      signer = await recoverTypedDataAddress({
        domain: { name: "ApiPaymentChannel", version: "1", chainId, verifyingContract: contract },
        types: VOUCHER_TYPES,
        primaryType: "Voucher",
        message: { channelId, cumulativeAmount: cumulative },
        signature: v.signature,
      });
    } catch {
      return reject("voucher_bad_signature");
    }
    if (signer.toLowerCase() !== String(ch.buyer).toLowerCase()) return reject("voucher_bad_signature");

    const key = keys.record(channelId);
    const signature = v.signature.toLowerCase();
    // Count the call and keep the voucher BEFORE the upstream call, so a crash never loses a promise we served.
    let legacy = null;
    let info = null;
    const fresh = ((await store.get(key)) ?? null) === null;
    if (fresh) {
      const found = await legacyRecord({ store, chainId, contract, channelId, buyer: ch.buyer, earlier });
      if (found.mixed) return reject("channel_record_mixed");
      if (found.unknown) return reject("channel_record_unknown");
      legacy = found.record;
      if (legacy === null && cumulative >= price * 2n && !warned) {
        warned = true;
        console.warn("x402 gate: a channel without a record starts above the price per call; if this store replaced another one, vouchers already used may be used again");
      }
    }
    if (fresh) {
      // Listed before its first record, so that no record is ever missing from the list. A listed channel without a record is skipped when closing.
      await casUpdate(store, keys.index, (index) => {
        const list = Array.isArray(index) ? index : [];
        return list.includes(channelId) ? {} : { next: [...list, channelId] };
      });
    }
    const call = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`, expiry: Date.now() + callTimeout };
    const take = () => casUpdate(store, key, (stored) => {
      const prev = stored ?? legacy;
      const state = recordState(prev); // throws on a record we cannot read: fail closed
      if (prev?.closed) return { result: "channel_not_open" };
      if (isClaimed(prev)) return { result: "channel_closing" }; // being closed: what we accept now could not be claimed any more
      info = { usedAtomic: state.used.toString(), nextAtomic: (state.used + price).toString() };
      if (stored?.calls?.[call.id]) return { result: "ok" }; // written by the attempt whose answer was lost
      if (cumulative < state.used + price) {
        // no call for it, but the close may need it: vouchers can arrive out of order
        const kept = stored ? keepVoucher(stored, cumulative, signature) : null;
        return { ...(kept ? { next: kept } : {}), result: "voucher_not_increasing" };
      }
      return { next: takeUse(prev, price, cumulative, signature, deposit, call), result: "ok" };
    });
    let taken;
    try {
      taken = await take();
    } catch (e) {
      // The write may have arrived although its answer did not: look, so that the buyer is not charged for a refused call.
      let arrived = false;
      for (let i = 0; i < 4 && !arrived; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, 50 * i));
        arrived = Boolean((await store.get(key).catch(() => null))?.calls?.[call.id]);
      }
      if (!arrived) throw e;
      taken = "ok";
    }
    // The signature proved that this is the buyer: where the channel stands is theirs to know.
    if (taken !== "ok") return { ...reject(taken), ...(taken === "voucher_not_increasing" ? { channel: { channelId, ...info } } : {}) };

    /** Gives back this one call, on top of whatever other calls did meanwhile. */
    const rollback = () => casUpdate(store, key, (cur) => ({ next: endCall(cur, call.id, price, true) }));
    /** The call was served. Only ends its entry, so that a close need not wait for it; when this fails the entry runs out by itself. */
    const done = () => casUpdate(store, key, (cur) => ({ next: endCall(cur, call.id, price, false) }));

    const receipt = utf8ToBase64(
      JSON.stringify({ channelId, cumulativeAmount: cumulative.toString(), remainingAtomic: (deposit - cumulative).toString() }),
    );
    return { ok: true, receipt, rollback, done };
  }

  return { accept };
}
