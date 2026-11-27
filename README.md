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

`api-seller-close` stops new vouchers on a channel before it sends the transaction. If a run ends with `close_unconfirmed`, run it again: it looks at the chain, finishes the same close with the same nonce, and never pays twice. Until then the channel takes no new calls. Calls already running get up to `DRAIN_SECONDS` (60) to end; if that is not enough, `drainTimedOut` names the channel, and a call that fails after that cannot be taken out of the close. `MAX_FEE_GWEI` (200) limits the fee. A call that never reports back counts as running for `prepaid.callTimeoutMs` (10 minutes), then as served.

A reply is read from your API to the end before the buyer gets any of it. If your API fails or breaks off half way, the buyer gets a 502 and the call is not counted. Streaming replies arrive in one piece (8 MB at most).

### Prepaid on Workers

`examples/worker-prepaid/`: the Worker stores vouchers in a Durable Object and holds no seller key. Set a random secret of 32 or more characters (`wrangler secret put STORE_SECRET`), then close from your own machine:

```bash
STORE_URL=https://YOUR_WORKER/__seller-store STORE_SECRET=… SELLER_PRIVATE_KEY=… RPC_URL=… CHANNEL_CONTRACT=… npx api-seller-close
```

Without the secret the route does not exist. Keep the secret as safe as your key: it can change your stored vouchers.

Or let a second Worker close on a timer: `examples/worker-closer/` runs every 15 minutes. It reads 20 channels of the index per run, in turn, remembers in the seller's store those whose buyer asked to close and closes the one whose window ends soonest first. It closes those whose buyer asked to close (the challenge period of the Fuji contract is 86400 seconds) and those whose stored amount reached `MIN_AMOUNT`. On the free plan a run closes about one channel and reads 20, so a request is found within (channels / 20) runs: 1,000 channels take 50 runs, about 12.5 hours, within the 24-hour window; beyond about 1,400 channels (a turn through the index then takes three quarters of the window), or with many requests at once, raise `MAX_SUBREQUESTS` (a paid plan allows more); the log then says `index_too_large_for_budget`. Channels closed on chain or past their window leave the index. That Worker holds the seller key as a secret: use a key that only receives earnings. Each run stays within `MAX_SUBREQUESTS` (48, below the 50 of the free plan; at least 46) and waits up to `WAIT_SECONDS` (30) per transaction; what does not fit is closed by a later run, and a run that is cut off is finished by the next one. Its log names no RPC address.

## Direct payments (buyer pays the gas)

With `direct: true` (off by default) the 402 quote offers a `hub-direct` entry, and no facilitator is needed. The buyer:

1. reads the `hub-direct` entry: `network`, `asset`, `payTo`, `amount`, `extra.gateBinding.gateId`, `extra.name` and `extra.version` (the token's EIP-712 domain), `extra.minConfirmations`, `extra.maxAgeSeconds`;
2. picks a random 32-byte `r` and keeps it secret until the call;
3. sets `nonce = keccak256(abi.encode(keccak256("hub-gate-v1"), chainId, asset, payTo, gateId, r))`;
4. signs EIP-3009 `TransferWithAuthorization(from, payTo, amount, validAfter, validBefore, nonce)` and sends `transferWithAuthorization` to the token from its own wallet (not `receiveWithAuthorization`, which only `payTo` may call);
5. keeps `txHash`, `nonce`, `r` and the request durably before it sends;
6. after `minConfirmations`, calls the API with `hub-direct-payment: base64(JSON {v:1, network, txHash, from, nonce, r})`, adding `plan: "monthly"` for the monthly entry;
7. on `payment_pending`, `chain_busy`, `chain_unavailable` or another 5xx, repeats after `retry-after` with the same header. It never pays again, because `r` proves the buyer on every retry. Until one call has been answered with a 2xx, the payment pays for any call to this gate on the same plan, so a call the API refused (4xx) or failed does not use it up. After that, the header gets `already_served`, with the monthly token again;
8. on `payment_in_another_transaction` (somebody else sent its signed authorization first), sends the hash of that transaction instead;
9. calls within `maxAgeSeconds` (3 days) of the block. Older transactions are refused, because the gate forgets served payments a little after that.

After the buyer has paid, refusals are 422 and carry no `accepts` and no `payment-required`, so that no x402 client takes them for a price. Lookups are limited per gate and per payer: 20 a minute on the public RPC and 600 with `settlementRpcUrl`, since made-up headers cost their sender nothing. Name your own RPC for production.

The gate reads the receipt from `settlementRpcUrl` (the public RPC of the testnet by default; name your own for production). It checks a successful transaction, `minConfirmations`, the block hash at that height, `AuthorizationUsed(from, nonce)` and the next log `Transfer(from, payTo, value >= amount)` from the token, and this gate's nonce for `r`. Then it records the payment like a settled x402 one.

## Store

One store per gate: two deployments with the same `gateId` (or the same `resource` and `payTo`) and separate stores serve the same payment twice, by x402 and by hub-direct alike. A gate is one `gateId` (default: made from `resource` and `payTo`); every process that serves it must share its store. The same `gateId` means one shared store: two gates for the same `payTo` (two APIs, or the same API run twice with separate stores) must have different `gateId`s. Without `gateId` and `resource` the id comes from `payTo` alone; the gate then refuses to start where binding is required, and warns elsewhere.

Payments can be bound to one gate (0.4.0): the 402 quote carries `extra.gateBinding.gateId`, and a buyer that knows the rule derives the payment's nonce from it, so no other gate accepts that payment, whatever its store. This holds only when every gate on that `payTo` requires binding. Payments that are not bound are accepted unless `requireGateBinding: true` (on by default on mainnet). Where a gate accepts them, a buyer can leave the binding out: a payment made for gate A is then served at gate B as an unbound one, and a payment can be served twice when two gates share the same `payTo` but not a store. A seller with more than one gate on a `payTo` should set `requireGateBinding: true` on each. Monthly tokens name the gate they were bought at and are refused at every other gate; tokens issued before 0.4.1 name none and are accepted only where binding is not required. Prepaid vouchers cannot be bound like this: a channel belongs to a seller and contract, so all gates of that seller and contract must share one store, or the same voucher pays at each of them while it is closed only once.

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

### Upgrading from 0.2.1

- `monthly` needs `resource`, the public address of the API. New tokens hold for that path and price; after a price change list the old price in `monthly.acceptPrices`. Tokens issued before 0.3.0 hold until they run out if the quota is unchanged.
- Selling per call from several instances: pass a shared `store`. With one process, `singleInstance: true` silences the warning.
- Deposits below `minDepositAtomic` (default: ten calls) are refused. Prepaid is not available on mainnet.
- A custom store may drop values whose `expiresAt` (unix seconds) has passed if their key starts with `payment:`, and must drop nothing else.
- `--only-requested` closes only channels whose buyer asked to close, plus, when `MIN_AMOUNT` is set, those that reached it; run it on a timer well inside the challenge period. Without `--only-requested`, `MIN_AMOUNT` skips small ones.

Upgrade the gates and `api-seller-close` together, and stop the old ones first. A close that 0.2.1 left unfinished is finished by the next `api-seller-close`; until then that channel takes no calls.

If one 0.2.0 store served two contracts at the same time, the overwritten record cannot be restored: the kit refuses it with `channel_record_mixed` (`mixed_record` when closing) where it can tell.

### Upgrading from 0.2.0

Stop all 0.2.0 processes before starting 0.2.1 on the same store. Records are now kept per chain and contract, so one store can serve several. Old records are read where their signature fits the configured contract; they are neither moved nor deleted, and the close command finds them. If a channel answers `channel_record_unknown`, the old record belongs to a contract the kit does not know: list it in `prepaid.earlierContracts` (`eip155:43113/0x…`). Only list contracts you used before the current one. Two more changes: a channel being closed answers `channel_closing`, and an unused part of a voucher can be used by a later call.

### Upgrading from 0.1

- Default file store: nothing to change. Stop all 0.1 processes before starting 0.2 on the same file.
- Your own store: add `compareAndSet`, or pass `singleInstance: true`.
- Worker example: add the `SELLER_STORE` binding and the migration from `examples/worker/wrangler.jsonc`.

## Examples

- `examples/node-server.mjs`: a Node server.
- `examples/worker/`: a Cloudflare Worker.
- `examples/worker-prepaid/`: a Cloudflare Worker with prepaid, closed from your own machine.
- `examples/worker-closer/`: a Cloudflare Worker that closes those channels on a timer.

## Notes

- Testnet only. Mainnet needs an audit first.
- Failures close: if verification fails, or your API fails, the call is not served and nothing is settled. If it stays unclear whether the payment went through, the body is withheld.
- Every answer to a payment says what became of it, in the `hub-payment-status` header and, in JSON errors, as `payment` and `safeToPayAgain`:

  | `payment` | Status | What a client does |
  |---|---|---|
  | `not_taken` | 402, 502, or your API's own status | nothing was settled; paying again is safe |
  | `unclear` | 409 (502 `store_unavailable`) | it may have been settled. Do not pay again: repeat the same request with the same payment and key |
  | `settled` | 200, 409, 502 | it was settled; do not pay again. With 502 the reply is still owed: repeat the same request |
  | `refused` | 402, 413, 502 | this request settled nothing; safe to pay unless the same payment was sent before |

- Set `settlementRpcUrl` (an RPC of the same chain; prepaid's `rpcUrl` is used otherwise). Monthly always has one: on Fuji and Base Sepolia a public RPC is the default; elsewhere you must name it. The RPC is asked for the current block before every settlement (two short requests at most) and when a payment is unclear. Payments that fail verification cause at most ten lookups a minute at the public default, counted in each process or Worker isolate. Anybody can use up that allowance with signatures that cost nothing; then such a payment, even one that really was settled, is answered `refused` instead of `unclear` until the minute is over. If the block cannot be read before a payment's first settlement, that settlement is not asked for: the answer is 503 `chain_unavailable`, `not_taken`, and the same payment can be sent again. If the store fails while the payment is given back, the answer is still `not_taken`, but the same payment answers `payment_in_progress` for about a minute. A retry of a payment that is already `unclear` asks the facilitator again (its block was recorded the first time) and stays `unclear` until it is cleared up. With it the gate finds a payment on chain that the facilitator did not confirm, and can tell when an authorization ran out unused. Without it such a payment stays `unclear`.
- One payment gets one reply. Several instances must share a store for that, also when you only sell per call; on Workers the gate refuses to start without one. Instances that do not share a store cannot see each other's payments: if two get the same payment at once and the facilitator answers both with a plain success, both serve it.
- A buyer who sends `hub-idempotency-key` (32 to 200 random characters, new for every payment) can repeat the same request (method, address and body up to 1 MB) after an unclear payment. If it turns out paid, the API is called for that buyer, once more if the first reply was withheld, and the payment is done. A monthly token is given again at any time. Replies are not stored: one that was sent but got lost cannot be fetched again, and neither can a lost prepaid or monthly call. Without the key nothing can be repeated: a payment's signature is public on chain and proves nothing.
- Only 2xx replies count. A redirect or an error of your API is passed on and costs nothing. Your API gets the request without the payment headers and without conditional ones (`if-none-match` and the like), and must answer within `upstreamTimeoutMs` (5 minutes).
- Tests: `npm test`.

---

日本語：Hub の API マーケットで、手持ちの API を都度払い・前払い・月額で売るための部品です。テスト網（Avalanche Fuji）だけで動きます。受け取りの 99% は提供元に、1% は Hub に入ります。
