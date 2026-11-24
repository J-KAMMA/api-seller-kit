// Reference seller API: GET /echo?text=... behind the x402 gate. Testnet only.
// Run: SELLER=0x... PAY_TO=0x... node examples/node-server.mjs   (see README for every variable)
// Optional: PREPAID_CHANNEL_CONTRACT + RPC_URL turns on the prepaid channel; MONTHLY_PRICE_ATOMIC + SUBSCRIPTION_SECRET turns on the monthly plan.
import { createServer } from "node:http";
import { createX402Gate } from "../src/index.mjs";

const env = process.env;
const need = (k) => {
  if (!env[k]) {
    console.error(`missing env ${k}`);
    process.exit(1);
  }
  return env[k];
};

const FUJI_USDC = "0x5425890298aed601595a70AB815c96711a31Bc65";

const prepaid = env.PREPAID_CHANNEL_CONTRACT
  ? {
      channelContract: env.PREPAID_CHANNEL_CONTRACT,
      pricePerCallAtomic: env.PREPAID_PRICE_PER_CALL_ATOMIC ?? env.PRICE_ATOMIC ?? "10000",
      minDepositAtomic: env.PREPAID_MIN_DEPOSIT_ATOMIC, // default: 10 calls
      rpcUrl: need("RPC_URL"),
    }
  : undefined;

const monthly = env.MONTHLY_PRICE_ATOMIC
  ? {
      priceAtomic: env.MONTHLY_PRICE_ATOMIC, // e.g. 5000000 = 5 USDC per 30 days
      quota: env.MONTHLY_QUOTA ? Number(env.MONTHLY_QUOTA) : null, // calls per token, empty = unlimited
      subscriptionSecret: need("SUBSCRIPTION_SECRET"), // long random string; never commit it
    }
  : undefined;

const network = env.NETWORK ?? "eip155:43113";

const gate = createX402Gate({
  network,
  allowLocalDevNetwork: env.ALLOW_LOCAL_DEV_NETWORK === "true", // local hardhat run only (eip155:31337)
  tokenName: env.TOKEN_NAME ?? "USD Coin", // EIP-712 domain name of the asset (Circle USDC: "USD Coin")
  asset: env.ASSET ?? FUJI_USDC,
  seller: need("SELLER"), // your own address; the proceeds go here
  payTo: need("PAY_TO"), // your splitter address, as shown on your Hub listing
  priceAtomic: env.PRICE_ATOMIC ?? "10000", // 0.01 USDC (6 decimals)
  facilitatorUrl: env.FACILITATOR_URL ?? (network === "eip155:43113" ? "https://jkamma-facilitator-staging.jkamma-hub.workers.dev" : "http://127.0.0.1:8790"), // Fuji: Hub's testnet facilitator, no token needed once listed on Hub
  settlementRpcUrl: env.RPC_URL ?? (network === "eip155:43113" ? "https://api.avax-test.network/ext/bc/C/rpc" : undefined), // finds a payment on chain when the settlement answer is lost
  description: "echo (reference API)",
  resource: `${env.PUBLIC_URL ?? `http://127.0.0.1:${env.PORT ?? 8800}`}/echo`, // the address buyers call; never taken from a request
  facilitatorHeaders: env.FACILITATOR_TOKEN ? { authorization: `Bearer ${env.FACILITATOR_TOKEN}` } : undefined,
  prepaid,
  monthly,
  storePath: env.STORE_PATH ?? "./seller-kit-store.json", // vouchers and quota counters (used when prepaid or monthly is on)
});

async function api(request) {
  const url = new URL(request.url);
  if (url.pathname !== "/echo") return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
  const text = (url.searchParams.get("text") ?? "").slice(0, 500);
  return new Response(JSON.stringify({ echo: text }), { headers: { "content-type": "application/json" } });
}

const port = Number(env.PORT ?? 8800);
createServer(async (req, res) => {
  const origin = env.PUBLIC_URL ?? `http://${req.headers.host}`;
  const request = new Request(new URL(req.url ?? "/", origin), { method: req.method, headers: req.headers });
  const response = await gate(request, api);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, "127.0.0.1", () => console.log(`seller API on http://127.0.0.1:${port}/echo?text=hi`));
