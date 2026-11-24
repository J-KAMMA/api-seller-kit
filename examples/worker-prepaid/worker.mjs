// 前払いの見本（Cloudflare Worker、Avalanche Fuji テスト網のみ）。売り手の鍵は Worker に置かない。
// 券は Durable Object に貯まり、締めは売り手の手元で api-seller-close を回す（STORE_URL と STORE_SECRET）。
import { createStoreAdmin } from "../../src/admin-store.mjs";
import { createDurableObjectStore } from "../../src/durable-object.mjs";
import { createX402Gate } from "../../src/index.mjs";

export { SellerKitStore } from "../../src/durable-object.mjs";

const FUJI_USDC = "0x5425890298aed601595a70ab815c96711a31bc65";
let gate = null;
let admin = null;

function setup(env, origin) {
  const store = createDurableObjectStore(env.SELLER_STORE);
  // STORE_SECRET が無いか 32 文字未満なら、この口は無い（404）。
  admin = createStoreAdmin({ store, secret: env.STORE_SECRET });
  gate = createX402Gate({
    network: env.NETWORK ?? "eip155:43113",
    allowLocalDevNetwork: env.ALLOW_LOCAL_DEV_NETWORK === "true", // 手元の試験だけ
    asset: env.ASSET ?? FUJI_USDC,
    seller: env.SELLER,
    payTo: env.PAY_TO,
    priceAtomic: env.PRICE_ATOMIC ?? "10000",
    facilitatorUrl: env.FACILITATOR_URL,
    description: "echo (Hub API market sample, testnet)",
    resource: env.PUBLIC_URL ?? `${origin}/echo`,
    prepaid: { pricePerCallAtomic: env.PRICE_ATOMIC ?? "10000", channelContract: env.CHANNEL_CONTRACT, rpcUrl: env.RPC_URL },
    store,
  });
}

async function api(request) {
  const url = new URL(request.url);
  if (url.pathname !== "/echo") return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ echo: (url.searchParams.get("text") ?? "").slice(0, 500) });
}

export default {
  async fetch(request, env) {
    if (!gate) setup(env, new URL(request.url).origin);
    return (await admin(request)) ?? gate(request, api);
  },
};
