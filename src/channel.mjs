// Prepaid channel vouchers (ApiPaymentChannelV1). Loaded lazily by the gate; needs `viem`.
// Nothing the buyer sends is trusted for deposit / buyer / seller: all of it is read from the chain.
import { decodeFunctionResult, encodeFunctionData, recoverTypedDataAddress } from "viem";

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

export const VOUCHER_TYPES = {
  Voucher: [
    { name: "channelId", type: "bytes32" },
    { name: "cumulativeAmount", type: "uint256" },
  ],
};

export const STATUS_OPEN = 1;
const RPC_TIMEOUT_MS = 10_000;
const MAX_VOUCHER_HEADER = 4 * 1024;
const MAX_UINT256 = (1n << 256n) - 1n;

function base64ToUtf8(b64) {
  const bin = atob(b64);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function utf8ToBase64(text) {
  let bin = "";
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** JSON-RPC eth_call getChannel. Returns {buyer, seller, token, deposit: bigint, closeRequestedAt: bigint, status: number}. Throws on any problem. */
export async function readChannelViaRpc({ rpcUrl, channelContract, channelId, doFetch = (input, init) => globalThis.fetch(input, init) }) {
  const data = encodeFunctionData({ abi: CHANNEL_ABI, functionName: "getChannel", args: [channelId] });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    const res = await doFetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: channelContract, data }, "latest"] }),
      redirect: "manual",
      signal: controller.signal,
    });
    const body = await res.json();
    if (!res.ok || typeof body?.result !== "string") throw new Error("rpc_error");
    const r = decodeFunctionResult({ abi: CHANNEL_ABI, functionName: "getChannel", data: body.result });
    return { ...r, deposit: BigInt(r.deposit), closeRequestedAt: BigInt(r.closeRequestedAt), status: Number(r.status) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {{ network: string, asset: string, seller: string, resource?: string,
 *           prepaid: { pricePerCallAtomic: string|number|bigint, channelContract: string, minDepositAtomic?: string,
 *                      rpcUrl?: string, readChannel?: (channelId: string) => Promise<object> },
 *           store: { get(k:string):any, set(k:string,v:any):any }, doFetch?: typeof fetch }} o
 */
export function createChannelHandler(o) {
  const { prepaid, store } = o;
  const chainId = Number(o.network.split(":")[1]);
  const contract = prepaid.channelContract.toLowerCase();
  const price = BigInt(prepaid.pricePerCallAtomic);
  const seller = o.seller.toLowerCase();
  const asset = o.asset.toLowerCase();
  const read = prepaid.readChannel ?? ((channelId) => readChannelViaRpc({ rpcUrl: prepaid.rpcUrl, channelContract: contract, channelId, doFetch: o.doFetch }));
  const locks = new Map();

  function withLock(key, fn) {
    const run = (locks.get(key) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => {});
    locks.set(key, tail);
    tail.then(() => locks.get(key) === tail && locks.delete(key));
    return run;
  }

  const reject = (error) => ({ ok: false, status: 402, error });

  /** @returns {Promise<{ok:true, receipt:string, rollback:()=>Promise<void>}|{ok:false, status:number, error:string}>} */
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
    if (typeof v.signature !== "string" || !/^0x[0-9a-fA-F]{128,132}$/.test(v.signature)) return reject("voucher_invalid");
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

    const key = `channel:${channelId}`;
    const signature = v.signature.toLowerCase();
    return withLock(key, async () => {
      const prev = await store.get(key);
      const highest = prev && typeof prev.cumulativeAmount === "string" && /^\d+$/.test(prev.cumulativeAmount) ? BigInt(prev.cumulativeAmount) : 0n;
      if (cumulative - highest < price) return reject("voucher_not_increasing");
      // Persist the highest voucher BEFORE the upstream call so a crash never loses a promise we served.
      await store.set(key, { cumulativeAmount: cumulative.toString(), signature, deposit: deposit.toString() });
      await withLock("index", async () => {
        const index = await store.get("channels");
        const list = Array.isArray(index) ? index : [];
        if (!list.includes(channelId)) await store.set("channels", [...list, channelId]);
      });
      const receipt = utf8ToBase64(
        JSON.stringify({ channelId, cumulativeAmount: cumulative.toString(), remainingAtomic: (deposit - cumulative).toString() }),
      );
      return {
        ok: true,
        receipt,
        rollback: () =>
          withLock(key, async () => {
            const cur = await store.get(key);
            if (cur?.signature !== signature) return; // a later voucher already replaced ours: it covers ours
            await store.set(key, prev ?? { cumulativeAmount: "0", signature: null });
          }),
      };
    });
  }

  return { accept };
}
