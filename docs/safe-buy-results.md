# Safe buy results

Checks of `make_x402_request` (Probe lookup, chain matching, refetch) and `check_seller` against real sellers on mainnet.
Limits for these runs: at most $0.01 per call, $0.10 in total.

## Wallet (CDP, account `x402-wallet-mcp`)

| Network | Address |
| - | - |
| Solana | `GbPTDBvinYY8w1CkiWac4m2TTX5ZZi4AKmACLyoiRxuU` |
| Base | `0xC2515323BFD288DDf1f28Ca3385B974e7a864a37` |

## Real payments, 2026-11-08

`make_x402_request` (via the `pay` CLI, same code path) with `WALLET_PROVIDER=cdp`, `network: "mainnet"`, `perCallMaxUsd: "0.01"`, `perSessionMaxUsd: "0.10"`. All three sellers were paid in USDC on Solana mainnet. Solana USDC balance 0.500 -> 0.488 (total $0.012); Base untouched (0.50).

| Seller | Status | Settlement | Header tx matched | Amount (402 / on chain) | Receipt | Tx |
| - | - | - | - | - | - | - |
| JIN `https://jin.x402jp.com/api/jin/series` | fulfilled (200) | verified | true | 10000 / 10000 ($0.01) | **ok** (delivery `first`, payment_id = tx) | [`4a47nwRf…ggqNTip`](https://solscan.io/tx/4a47nwRfBiZD7gnz893XRVGLSM5Q2zDzMPiWwvUhsbHSk8VD3yTZzYuKxfvHUNH2hbrfgrE6JDHjhwcR8ggqNTip) |
| OSD `https://osd.x402jp.com/api/catalyst/NVDA` | fulfilled (200) | verified | true | 1000 / 1000 ($0.001) | **ok** (delivery `first`) | [`5oSvaTRm…JKQooVK`](https://solscan.io/tx/5oSvaTRmDMWfGjhq9ykGC2F1FB4mNTuPCdtYuftrszmjRmqGSau6boT5MYNwYSn16h9rz9GVi3sqUSWz5JKQooVK) |
| surf.cascade.fyi `https://surf.cascade.fyi/api/v1/twitter/trends` (Probe: delivered, score 91.1) | fulfilled (200) | verified | null (**no settlement header**) | 1000 / 1000 ($0.001) | none (seller does not support receipts) | [`4iGT4tfS…FpXb3`](https://solscan.io/tx/4iGT4tfSsTmrEzAoG8yAdTq1hLQEpfKB2UCnN58XmzPJUUi6jzmbHy3rpWRDDVnZPfx2W3vUhxWHygAgLQ2FpXb3) |

Body hashes (`body_sha256`): JIN `2a70a806cefd0a383d76702796b993c5f3add52abe8b4a8170e66b0eb92dce67`, OSD `a4378e5d66839cbaef6988ca3edf9059e448c6adfcdc413d7c65c0006b8f5bc4`, surf `beecd57bd83a809c591ff4912e0a8d496cc0b837e553e629c0c10f0771de414e`.

For surf the seller returned no `PAYMENT-RESPONSE`; the tx was identified on chain by our own payer signature in a recent transaction of the payer, and the USDC moved matches the 402 offer exactly.

## check_seller (no payment), 2026-11-07

Run over MCP stdio with `WALLET_PROVIDER=cdp` and `network: "mainnet"`. Three hosts with different Seller Probe records.

| Host / URL | Probe | `probe_would_block` | Input | Bazaar price | Delivery Receipt | Would pay |
| - | - | - | - | - | - | - |
| `surf.cascade.fyi/api/v1/twitter/trends` | delivered, score 91.1 | false | ok, none declared | listed 1000 = offered 1000 (Solana, Base, Monad) | not supported | Solana, $0.001 |
| `rest.coincap.io/v3/agentFriendly/full_assets_by_slug` | **not_delivered**, score 73.9 | **true** (blocked under `probeMode: block`) | ok (schema marks nothing required; `slugs` shown only as an example) | listed 2000 = offered 2000 (Base) | not supported | Base, $0.002 |
| `jin.x402jp.com/api/jin/series` | no paid record yet, score 20 | false | ok, none declared | not listed in the Bazaar | supported (1 key, 7-day window) | Solana, $0.01 |

Note on coincap: Seller Probe recorded HTTP 400 "slugs parameter is required" after a paid request. The 402's schema does not mark `slugs` required, so the input check does not stop on it; `make_x402_request` and `check_seller` now report example query parameters the request does not set (`unset_examples` / a warning). The Probe verdict alone already blocks this host under the default `probeMode: block`.
