import { privateKeyToAccount } from "viem/accounts";
import { createX402Gate } from "../../src/index.mjs";
import { signToken } from "../../src/subscription.mjs";

// Hardhat account #0: a public well-known test key, used only to sign fake vouchers.
const buyer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
export const A = (c) => `0x${c.repeat(40)}`;
export const CHANNEL_ID = `0x${"ab".repeat(32)}`;
const USDC = "0x5425890298aed601595a70AB815c96711a31Bc65";
const SECRET = "test-subscription-secret-0123456789";
const NOW = 1_000_000;
const URL_ = "https://api.example/echo";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");

const base = {
  network: "eip155:43113",
  asset: USDC,
  payTo: A("2"),
  seller: A("3"),
  priceAtomic: "10000",
  facilitatorUrl: "https://facilitator.example",
  resource: URL_,
  now: () => NOW,
  fetch: async (url) => new Response(JSON.stringify(new URL(url).pathname === "/verify" ? { isValid: true } : { success: true, transaction: "0xabc" })),
};
export const BUYER = buyer.address;
export const channelGate = (store, { contract = A("c"), network = base.network, prepaid = {}, ...extra } = {}) =>
  createX402Gate({
    ...base,
    network,
    allowedNetworks: [network],
    store,
    prepaid: {
      pricePerCallAtomic: "10000",
      channelContract: contract,
      readChannel: async () => ({ buyer: buyer.address, seller: A("3"), token: USDC, deposit: 1_000_000n, closeRequestedAt: 0n, status: 1 }),
      ...prepaid,
    },
    ...extra,
  });
export const monthlyGate = (store, quota, extra = {}) =>
  createX402Gate({ ...base, store, monthly: { priceAtomic: "5000000", quota, subscriptionSecret: SECRET }, ...extra });

export async function voucher(cumulative, channelId = CHANNEL_ID, { contract = A("c"), chainId = 43113 } = {}) {
  const signature = await buyer.signTypedData({
    domain: { name: "ApiPaymentChannel", version: "1", chainId, verifyingContract: contract },
    types: { Voucher: [{ name: "channelId", type: "bytes32" }, { name: "cumulativeAmount", type: "uint256" }] },
    primaryType: "Voucher",
    message: { channelId, cumulativeAmount: BigInt(cumulative) },
  });
  return b64({ channelId, cumulativeAmount: String(cumulative), signature });
}
export const quotaToken = (quota) =>
  signToken(SECRET, { v: 1, seller: A("3"), buyer: A("4"), resource: "https://api.example", network: "eip155:43113", expiresAt: NOW + 999, quota });
export const quotaKey = (token) => `quota:${token.split(".")[1]}`;

/** `status`: a number, or a function returning one (possibly later). */
const upstream = (status) => async () => new Response("{}", { status: typeof status === "function" ? await status() : status });
export const useVoucher = (gate, v, status = 200) => gate(new Request(URL_, { headers: { "hub-channel-voucher": v } }), upstream(status));
export const useToken = (gate, t, status = 200) => gate(new Request(URL_, { headers: { "hub-subscription": t } }), upstream(status));
export const purchase = (gate) =>
  gate(new Request(URL_, { headers: { "payment-signature": b64({ accepted: { extra: { plan: "monthly" } }, payload: { authorization: { from: A("4") } } }) } }), upstream(200));
