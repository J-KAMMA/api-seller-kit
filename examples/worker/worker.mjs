// 見本の売り手の窓口（Cloudflare Worker、Avalanche Fuji テスト網のみ）。GET /echo?text=… を x402 の門の後ろに置く。
// 1回ごと（0.01 USDC）と月額（0.05 USDC・30日・5回まで）。前払いは締めに売り手の鍵が要るので、この見本では出さない。
// 月額の回数は Durable Object に置く（どの実体から呼ばれても同じ数を数える）。
import { createX402Gate } from "../../src/index.mjs";
import { createDurableObjectStore } from "../../src/durable-object.mjs";

export { SellerKitStore } from "../../src/durable-object.mjs";

const FUJI_USDC = "0x5425890298aed601595a70ab815c96711a31bc65";
let gate = null;

function gateFor(env, origin) {
  if (gate) return gate;
  gate = createX402Gate({
    network: "eip155:43113",
    asset: FUJI_USDC,
    tokenName: "USD Coin",
    seller: env.SELLER,
    payTo: env.PAY_TO,
    priceAtomic: env.PRICE_ATOMIC ?? "10000",
    facilitatorUrl: env.FACILITATOR_URL,
    settlementRpcUrl: env.RPC_URL ?? "https://api.avax-test.network/ext/bc/C/rpc",
    description: "echo (Hub API market sample, testnet)",
    resource: env.PUBLIC_URL ?? `${origin}/echo`, // 公開の住所を決めて置く（PUBLIC_URL）。呼び出しの Host には従わない
    monthly: env.SUBSCRIPTION_SECRET ? { priceAtomic: env.MONTHLY_PRICE_ATOMIC ?? "50000", quota: Number(env.MONTHLY_QUOTA ?? 5), subscriptionSecret: env.SUBSCRIPTION_SECRET } : undefined,
    store: createDurableObjectStore(env.SELLER_STORE), // 月額の回数と、支払い1件につき返事1つ
    // 同じアカウントの Worker どうしは workers.dev で呼べないので、サービス バインディングで呼ぶ（宛先の住所は公開のまま＝合言葉なしの道）。
    // 鎖を読む呼び出し（settlementRpcUrl）は外へ出す。
    fetch: env.FACILITATOR ? (input, init) => (new URL(input).origin === new URL(env.FACILITATOR_URL).origin ? env.FACILITATOR.fetch(new Request(input, init)) : fetch(input, init)) : undefined,
  });
  return gate;
}

async function api(request) {
  const url = new URL(request.url);
  if (url.pathname !== "/echo") return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ echo: (url.searchParams.get("text") ?? "").slice(0, 500) });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/openapi.json") { // 入口（/）は門の後ろ：Hub の出品の確かめが 402 を見られるように
      return Response.json({
        openapi: "3.1.0",
        info: { title: "echo (Hub API market sample)", version: "1", description: "Avalanche Fuji testnet only. Pay per call with x402 or monthly." },
        paths: { "/echo": { get: { parameters: [{ name: "text", in: "query", schema: { type: "string", maxLength: 500 } }], responses: { "200": { description: "the text back" }, "402": { description: "payment required" } } } } },
      });
    }
    return gateFor(env, url.origin)(request, api);
  },
};
