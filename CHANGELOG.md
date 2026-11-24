# Changelog

## 0.3.1 (2026-11-25)

- Monthly always has an RPC to look up an unclear payment: a public one by default on Fuji and Base Sepolia.
- Overlapping requests of one buyer with the same payment answer `payment_in_progress`.
- Worker example: chain lookups no longer go to the facilitator binding.

## 0.3.0 (2026-11-25)

Upgrade gates and `api-seller-close` together.

- A close is tracked by its transaction: a channel takes calls again only when that transaction can no longer be mined. Unfinished closes are resumed with the same nonce, with a higher fee up to `MAX_FEE_GWEI`.
- Calls running when a close starts are waited for (`DRAIN_SECONDS`); the voucher is chosen after that.
- Prepaid on Workers: `examples/worker-prepaid/`, `createStoreAdmin`, and `STORE_URL` + `STORE_SECRET` for `api-seller-close`.
- Vouchers that arrive out of order are kept for an exact close; they pay for no extra call.
- `channel_record_mixed` for a record of 0.2.0 that a later contract wrote over.
- One payment is served once, per call and monthly, and buys one token; `hub-idempotency-key` lets the buyer clear up an unclear payment. On Workers a shared store is required.
- `hub-payment-status`, `payment` and `safeToPayAgain` tell "unclear, do not pay again" (409) from "not taken". `settlementRpcUrl` lets the gate read the outcome from the chain, also through RPCs that search few blocks at a time.
- Monthly tokens are bound to path and price; `monthly` needs `resource`; `monthly.acceptPrices`.
- `minDepositAtomic` is enforced. Prepaid is refused on mainnet. A refused voucher's 402 says where the channel stands (`channel.usedAtomic`, `nextAtomic`).
- Closing: only a closed status on chain counts as closed, and marked channels are checked again. `--only-requested`, `MIN_AMOUNT`.
- The API gets no payment headers, has a time limit (`upstreamTimeoutMs`), and its body is read only up to the cap.
- The file store writes through to the disk. The RPC's chain is checked.
- `prepaid.callTimeoutMs`.

## 0.2.2 (2026-11-24)

- Monthly tokens are accepted only in the spelling they were issued in. All sellers of monthly plans should update.

## 0.2.1 (2026-11-24)

- Prepaid records are kept per chain and channel contract. Records of 0.2.0 and older stay usable and closable.
- `api-seller-close` stops new vouchers on a channel before it sends the transaction, and can be run again after an unclear result.
- Overlapping calls: the channel is closed with the voucher that fits the calls actually served. An unused part of a voucher can be used by a later call.
- A reply body that breaks off half way is a failed call: 502, not counted. Replies with status 204 and 205 work.
- `allowedNetworks` only narrows the supported networks.
- New option `prepaid.earlierContracts`. New error codes `channel_record_unknown`; `channel_closing` is also used while a close is under way.
- Fuji examples use ApiPaymentChannelV2.

## 0.2.0 (2026-11-24)

Breaking: prepaid, and monthly with a quota, need a store with `compareAndSet(key, expected, next)`, or `singleInstance: true` when exactly one process uses the store.

- Voucher and quota updates are safe across several instances that share one store.
- The memory and file stores implement `compareAndSet`. Stop all 0.1 processes before starting 0.2 on the same file.
- New Durable Object store for Cloudflare Workers (`@jkamma/api-seller-kit/durable-object`).
- Stricter voucher signature format check (already on main since 4417837).

All sellers should update.
