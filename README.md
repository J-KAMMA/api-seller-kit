# api-seller-kit

Sell any HTTP API per call on the [Hub API market](https://hub.jkamma.com/market/ai). One wrapper adds x402 payments in USDC. Testnet only: Avalanche Fuji.

- **Pay per call**: the buyer signs once per call and the payment settles on chain.
- **Prepaid**: the buyer deposits once, then each call carries a signed voucher with no confirmation. You close the channel once and get paid.
- **Monthly**: the buyer pays once per 30 days and receives a token, with an optional call quota.

Payments go to your own splitter contract, which keeps 99% for you and sends 1% to Hub. Hub never relays your calls.

## Install

```bash
npm i github:J-KAMMA/api-seller-kit
```

Node 18+ or Cloudflare Workers. Prepaid also needs `viem`:

```bash
npm i viem
```

## Quick start

```js
import { createX402Gate } from "@jkamma/api-seller-kit";

const gate = createX402Gate({
  network: "eip155:43113",                         // Avalanche Fuji
  asset: "0x5425890298aed601595a70ab815c96711a31bc65", // Fuji USDC
  seller: "0xYOUR_ADDRESS",                        // you get paid here
  payTo: "0xYOUR_SPLITTER",                        // shown on your Hub listing
  priceAtomic: "10000",                            // 0.01 USDC
  facilitatorUrl: "https://jkamma-facilitator-staging.jkamma-hub.workers.dev",
  resource: "https://api.example.com/echo",
  monthly: { priceAtomic: "50000", quota: 100, subscriptionSecret: process.env.SUBSCRIPTION_SECRET }, // optional
});

// Fetch API style: works in Workers and Node 18+
export default { fetch: (request) => gate(request, (req) => yourApi(req)) };
```

1. List your API at **hub.jkamma.com/market/ai/sell** with your receiving address. Hub shows your splitter address (`payTo`).
2. Put the gate in front of your API.
3. Once you are listed, the Hub facilitator pays the gas for you. No token is needed.

## Prepaid

```js
prepaid: {
  pricePerCallAtomic: "1000",
  channelContract: "0xd896c44acdfdff4d4dd1298b19c6a668c9e01c11", // Fuji
  rpcUrl: "https://api.avax-test.network/ext/bc/C/rpc",
},
storePath: "./seller-store.json",
```

Collect your earnings with your own key; you pay the gas:

```bash
SELLER_PRIVATE_KEY=… RPC_URL=… CHANNEL_CONTRACT=… NETWORK=eip155:43113 STORE_PATH=./seller-store.json npx api-seller-close --dry-run
```

## Examples

- `examples/node-server.mjs`: a Node server.
- `examples/worker/`: a Cloudflare Worker.

## Notes

- Testnet only. Mainnet needs an audit first.
- Failures close: if verification or settlement fails, the call is not served and the buyer is not charged.
- Tests: `npm test`.

---

日本語：Hub の API マーケットで、手持ちの API を都度払い・前払い・月額で売るための部品です。テスト網（Avalanche Fuji）だけで動きます。受け取りの 99% は提供元に、1% は Hub に入ります。
