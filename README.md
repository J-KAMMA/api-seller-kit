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
  channelContract: "0xA5E4707344b624A7217b7814dA1b3611Bf4b4559", // Fuji, ApiPaymentChannelV2
  rpcUrl: "https://api.avax-test.network/ext/bc/C/rpc",
},
storePath: "./seller-store.json",
```

Collect your earnings with your own key; you pay the gas:

```bash
SELLER_PRIVATE_KEY=… RPC_URL=… CHANNEL_CONTRACT=… NETWORK=eip155:43113 STORE_PATH=./seller-store.json npx api-seller-close --dry-run
```

New sellers use this contract. If you used the first one (`0xd896c44aCdFdfF4d4dD1298B19C6a668c9e01c11`), close out its channels: run `api-seller-close` once with `CHANNEL_CONTRACT` set to that address and the same `STORE_PATH`.

Each call uses the price per call. A call that fails gives its use back. The channel is closed with the smallest voucher that covers the served calls, so a buyer who raises by the price per call pays exactly for what was served. A buyer who signs further ahead can use the rest for later calls until you close.

`api-seller-close` stops new vouchers on a channel before it sends the transaction. If a run ends with `close_unconfirmed`, run it again: it finishes the same close and never pays twice. Close when no calls are running; a call that fails while its close is being sent cannot be taken out of it any more.

A reply is read from your API to the end before the buyer gets any of it. If your API fails or breaks off half way, the buyer gets a 502 and the call is not counted. Streaming replies arrive in one piece (8 MB at most).

## Store

Prepaid vouchers and monthly quotas are counted in a store. It needs three methods:

| Method | |
|---|---|
| `get(key)` | the JSON value, or `null` |
| `set(key, value)` | writes it |
| `compareAndSet(key, expected, next)` | writes `next` only if the stored value equals `expected` (`null` = absent), in one step. Returns `true` or `false` |

Pick one that all your instances share:

- **Node, one machine**: the default file store (`storePath`). Several processes may share the file. Use a local disk, not a network share.
- **Workers**: `createDurableObjectStore` from `@jkamma/api-seller-kit/durable-object` (see `examples/worker/`). Workers KV cannot be used: it has no compare-and-set.
- **Several machines**: your own store on a database. In SQL: `UPDATE … SET value = :next WHERE key = :key AND value = :expected`, and `INSERT … ON CONFLICT DO NOTHING` when `expected` is `null`. Return whether one row changed, and compare values whatever their key order.
- **Tests**: `createMemoryStore()` lives in one process only.

Prepaid, and monthly with a quota, refuse to start with a store that has no `compareAndSet`. If exactly one process uses your store, you can pass `singleInstance: true` instead.

If the store cannot be reached, or the file lock is not free within 10 seconds, the call is answered with 502 and not served. A lock left by a stopped process on the same machine is removed automatically; after moving the file to another machine, delete `<storePath>.lock` yourself.

### Upgrading from 0.2.0

Stop all 0.2.0 processes before starting 0.2.1 on the same store. Records are now kept per chain and contract, so one store can serve several. Old records are read where their signature fits the configured contract; they are neither moved nor deleted, and the close command finds them. If a channel answers `channel_record_unknown`, the old record belongs to a contract the kit does not know: list it in `prepaid.earlierContracts` (`eip155:43113/0x…`). Only list contracts you used before the current one. Two more changes: a channel being closed answers `channel_closing`, and an unused part of a voucher can be used by a later call.

### Upgrading from 0.1

- Default file store: nothing to change. Stop all 0.1 processes before starting 0.2 on the same file.
- Your own store: add `compareAndSet`, or pass `singleInstance: true`.
- Worker example: add the `SELLER_STORE` binding and the migration from `examples/worker/wrangler.jsonc`.

## Examples

- `examples/node-server.mjs`: a Node server.
- `examples/worker/`: a Cloudflare Worker.

## Notes

- Testnet only. Mainnet needs an audit first.
- Failures close: if verification or settlement fails, the call is not served and the buyer is not charged.
- Tests: `npm test`.

---

日本語：Hub の API マーケットで、手持ちの API を都度払い・前払い・月額で売るための部品です。テスト網（Avalanche Fuji）だけで動きます。受け取りの 99% は提供元に、1% は Hub に入ります。
