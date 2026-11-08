# Safe buy results

Checks of `make_x402_request` (Probe lookup, chain matching, refetch) and `check_seller` against real sellers on mainnet.
Limits for these runs: at most $0.01 per call, $0.10 in total.

## Wallet (CDP, account `x402-wallet-mcp`)

| Network | Address |
| - | - |
| Solana | `GbPTDBvinYY8w1CkiWac4m2TTX5ZZi4AKmACLyoiRxuU` |
| Base | `0xC2515323BFD288DDf1f28Ca3385B974e7a864a37` |

## Real payments

All three sellers ask for USDC on Solana mainnet (JIN and OSD offer only Solana; surf.cascade.fyi offers Solana first).

| Seller | Expected | Price | Result |
| - | - | - | - |
| JIN `https://jin.x402jp.com/api/jin/series` | Delivery Receipt verifies | $0.01 | pending (wallet not funded yet) |
| OSD `https://osd.x402jp.com/api/catalyst/NVDA` | Delivery Receipt verifies | $0.001 | pending (wallet not funded yet) |
| surf.cascade.fyi `https://surf.cascade.fyi/api/v1/twitter/trends` (Probe: delivered, no settlement header) | tx found on chain, amount as the 402 offered | $0.001 | pending (wallet not funded yet) |

## check_seller (no payment), 2026-11-07

Run over MCP stdio with `WALLET_PROVIDER=cdp` and `network: "mainnet"`. Three hosts with different Seller Probe records.

| Host / URL | Probe | `probe_would_block` | Input | Bazaar price | Delivery Receipt | Would pay |
| - | - | - | - | - | - | - |
| `surf.cascade.fyi/api/v1/twitter/trends` | delivered, score 91.1 | false | ok, none declared | listed 1000 = offered 1000 (Solana, Base, Monad) | not supported | Solana, $0.001 |
| `rest.coincap.io/v3/agentFriendly/full_assets_by_slug` | **not_delivered**, score 73.9 | **true** (blocked under `probeMode: block`) | ok (schema marks nothing required; `slugs` shown only as an example) | listed 2000 = offered 2000 (Base) | not supported | Base, $0.002 |
| `jin.x402jp.com/api/jin/series` | no paid record yet, score 20 | false | ok, none declared | not listed in the Bazaar | supported (1 key, 7-day window) | Solana, $0.01 |

Note on coincap: Seller Probe recorded HTTP 400 "slugs parameter is required" after a paid request. The 402's schema does not mark `slugs` required, so the input check does not stop on it; `make_x402_request` and `check_seller` now report example query parameters the request does not set (`unset_examples` / a warning). The Probe verdict alone already blocks this host under the default `probeMode: block`.
