# Changelog

## 0.3.4 (2026-11-26)

- Closing Worker: with several channels a run spent its budget on looking and closed nothing. It now takes one channel after the other, starting one further on at every run, and looks at a channel only while a close still fits; the wait for a receipt also stops at the budget. `MAX_SUBREQUESTS` must be at least 36.
- Closing Worker: errors from the RPC library are logged as a category, never with the RPC address.
- `closeChannels`: `oneByOne`, `startAt`; `shouldContinue` is told whether the next step looks or closes. `createCloseChain`: `canPoll`.
- README: what happens when the block or the store cannot be read, exactly.

## 0.3.3 (2026-11-26)

- When the block cannot be read before a settlement, nothing is settled: 503 `chain_unavailable`, `not_taken`. Before, such a payment could stay unclear after a lost answer.
- Waiting for the RPC's chain id ends at the caller's deadline.
- `examples/worker-closer/`: closes prepaid channels from a Worker on a timer. `--only-requested` with `MIN_AMOUNT` also closes channels that reached it. A run can stop early (`shouldContinue`) and leaves the rest to the next one. A seller Worker on the same Cloudflare account is reached through a service binding `SELLER_WORKER`.
- Examples: `/openapi.json` is free in the prepaid example too.
- README: one shared store per `payTo` is required; the block check does not replace it. The lookup limit counts per process or isolate.

## 0.3.2 (2026-11-25)

- The default RPC is asked for the block before every settlement, like a named one; only later blocks can prove a payment. This does not make separate stores safe (see 0.3.3).
- Options are read once when the gate is created; later changes to the object have no effect.
- Payments that fail verification reach the public RPC at most ten times a minute.
- An empty `prepaid.rpcUrl` next to `readChannel` counts as none; one that is given must be valid.

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
