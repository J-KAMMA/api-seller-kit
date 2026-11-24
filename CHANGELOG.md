# Changelog

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
