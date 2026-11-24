# Changelog

## 0.2.0 (2026-11-24)

Breaking: prepaid, and monthly with a quota, need a store with `compareAndSet(key, expected, next)`, or `singleInstance: true` when exactly one process uses the store.

- Voucher and quota updates are safe across several instances that share one store.
- The memory and file stores implement `compareAndSet`. Stop all 0.1 processes before starting 0.2 on the same file.
- New Durable Object store for Cloudflare Workers (`@jkamma/api-seller-kit/durable-object`).
- Stricter voucher signature format check (already on main since 4417837).

All sellers should update.
