// Records written by 0.2.0 and older do not say which contract they belong to. Their signature does.
// They are only read here. The first use (a call or a close) copies one to its scoped key with compare-and-set from "absent", so it is
// copied at most once and the scoped record counts from then on.
import { recoverTypedDataAddress } from "viem";
import { LEGACY_KEYS } from "./voucher-record.mjs";

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
export const VOUCHER_TYPES = {
  Voucher: [
    { name: "channelId", type: "bytes32" },
    { name: "cumulativeAmount", type: "uint256" },
  ],
};

/** Contracts older kits were set up with, oldest first. A contract's own records can be followed only by those of later ones. */
const KNOWN = ["eip155:43113/0xd896c44acdfdff4d4dd1298b19c6a668c9e01c11", "eip155:43113/0xa5e4707344b624a7217b7814da1b3611bf4b4559"];

function laterContracts(chainId, contract) {
  const at = KNOWN.indexOf(`eip155:${chainId}/${contract.toLowerCase()}`);
  return at === -1 ? [] : KNOWN.slice(at + 1);
}

export function earlierContracts(chainId, contract, extra = []) {
  const at = KNOWN.indexOf(`eip155:${chainId}/${contract.toLowerCase()}`);
  return [...(at === -1 ? KNOWN : KNOWN.slice(0, at)), ...extra.map((e) => e.toLowerCase())];
}

/** The form the contract accepts (65 bytes, low s, v 27 / 28), or null. Kits before 0.2.0 also stored other forms. */
function canonical(signature) {
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{129,130}$/.test(signature)) return null;
  const r = signature.slice(2, 66);
  let s = BigInt(`0x${signature.slice(66, 130)}`);
  let v = parseInt(signature.slice(130), 16);
  if (v < 2) v += 27;
  if (v !== 27 && v !== 28) return null;
  if (s > N / 2n) {
    s = N - s;
    v = 55 - v;
  }
  return `0x${r}${s.toString(16).padStart(64, "0")}${v.toString(16)}`.toLowerCase();
}

async function signedFor(chainId, contract, channelId, amount, signature, buyer) {
  try {
    const signer = await recoverTypedDataAddress({
      domain: { name: "ApiPaymentChannel", version: "1", chainId, verifyingContract: contract },
      types: VOUCHER_TYPES,
      primaryType: "Voucher",
      message: { channelId, cumulativeAmount: amount },
      signature,
    });
    return signer.toLowerCase() === String(buyer).toLowerCase();
  } catch {
    return false;
  }
}

/**
 * What the unscoped record of a channel means for one contract:
 *   { record: null }   none, or it belongs to an earlier contract: the channel starts at zero here
 *   { record }         it is this contract's: go on from it
 *   { mixed: true }    a later contract wrote over it: what was used here is lost, refuse
 *   { unknown: true }  it belongs to a contract nobody named: refuse, it may hide vouchers already used here
 */
export async function legacyRecord({ store, chainId, contract, channelId, buyer, earlier }) {
  const rec = (await store.get(LEGACY_KEYS.record(channelId))) ?? null;
  if (rec === null) return { record: null };
  if (!/^[0-9]+$/.test(String(rec.cumulativeAmount))) throw new Error("stored_voucher_malformed");
  const amount = BigInt(rec.cumulativeAmount);
  if (amount === 0n && !rec.signature) return { record: null };
  const signature = canonical(rec.signature);
  if (signature) {
    if (await signedFor(chainId, contract, channelId, amount, signature, buyer)) return { record: { ...rec, signature } };
    for (const e of earlier) {
      const [network, address] = e.split("/");
      if (await signedFor(Number(network.slice(7)), address, channelId, amount, signature, buyer)) return { record: null, other: e };
    }
    for (const e of laterContracts(chainId, contract)) {
      const [network, address] = e.split("/");
      if (await signedFor(Number(network.slice(7)), address, channelId, amount, signature, buyer)) return { mixed: true };
    }
  }
  return { unknown: true };
}
