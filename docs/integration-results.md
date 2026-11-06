# Integration results

Real payments made with `npm run test:integration` (one `make_x402_request` per provider).
Seller: `https://wallets-demo-seller-server.calebgcarithers.workers.dev/weather?location=Tokyo` (Bazaar, `exact`, $0.001 USDC on Base Sepolia).
Test USDC came from the CDP faucet (`cdp.evm.requestFaucet`, base-sepolia / usdc).

| Date | Provider | Network | Payer | Price | Result | Settle tx |
| - | - | - | - | - | - | - |
| 2026-11-06 | cdp | Base Sepolia | `0xC2515323BFD288DDf1f28Ca3385B974e7a864a37` | $0.001 | 200, settled | [`0xee91db24…f882c7`](https://sepolia.basescan.org/tx/0xee91db24c70f191417544eea08a2995e316edfb7305f1f95dd4f689dddf882c7) |
| 2026-11-06 | privy | Base Sepolia | `0x6F3Bb845bB3Bb53295Ab9aF41EE2729a885f7d87` | $0.001 | 200, settled | [`0x4d112b79…e2561`](https://sepolia.basescan.org/tx/0x4d112b797a83892543bc916a189d03984a3459733c4c874a7b62cda2394e2561) |
| 2026-11-06 | crossmint | Base (mainnet) | `0xB46012a414c8c9aFBAe1e0232857e55D5e15BFaa` | $0.005 (real USDC) | 200, settled; balance 0.005 -> 0.000 USDC | [`0x5e43d716…398385`](https://basescan.org/tx/0x5e43d71631745b1b1949ce5f68466ce64a45dead974334409fa2b9c720398385) |
| 2026-11-06 | nevermined (`nvm:erc4337`) | Base Sepolia (sandbox) | `0x6d565F6091624672B6c0ef6e2D38eD4679143Ed5` (NVM smart account) | 1 credit | 200, settled; plan bought for 0.01 USDC via an auto-created delegation | credit burn `tid-66e58603-f544-459a-9906-204033330ad3` (Nevermined id, not an on-chain hash) |

Notes

- Crossmint: the only key provided was a production key (`sk_production_...`), which works only on Base mainnet, so the owner chose to test on mainnet with real USDC instead of staging/USDXM. Seller: `https://www.api-xpay.com/x402/quote` (Bazaar, `exact`, $0.005 USDC on Base, payTo `0x589a2314a2E05F45e40C4823Da3Ba58D421dB3d8`). Limits for this run: perCallMaxUsd 0.02 / perSessionMaxUsd 0.05; session spend after the payment 0.005. The wallet received 0.005 USDC (not the planned 0.05), which exactly covered the payment.
- `NVM_API_KEY` in the session environment is a `live:` key. The sandbox test above used the `sandbox:` key (`NVM_API_KEY_SELLER`) explicitly; the server now refuses to pay Nevermined when the key environment does not match `config.json` `network`.
- Nevermined: the seller is a local sandbox endpoint from `scripts/nvm-sandbox-seller.ts` (plan `8276400030875084501580801410434147330417427812732283872643085090993314641481`, agent `88604755859322499647438371683811862392474846983346776283004905189633410696948`, 0.01 USDC for 10 credits, 1 credit per request). The same sandbox account acts as buyer and seller. The plan purchase moved 0.01 USDC on Base Sepolia (buyer 1.00 -> 0.99, seller receiver `0xc2A2AB59aF5b4FB9238bE66350FC8BdD761e40FA` +0.0099 after the 1% fee). Nevermined receipts return a `tid-...` id for the credit burn, so no explorer link is generated for it.
- The 実証1 gateway (`https://poc-card-credits.vercel.app`) runs on Nevermined Live and was not used.

## Limit checks against a real seller (no payment)

`make_x402_request` called over MCP stdio with `WALLET_PROVIDER=cdp` on 2026-11-06, against the same Base Sepolia seller ($0.001 USDC). The seller answered 402 both times; the server stopped before signing.

| Case | config.json | Returned (`isError: true`) | CDP balance (Base Sepolia) |
| - | - | - | - |
| Over per-call limit | `perCallMaxUsd: "0.0005"` | `PER_CALL_LIMIT`: "Price $0.001 exceeds the per-call limit of $0.0005. Payment was not made." `paid: false` | 0.999 -> 0.999 |
| Host not allowed | `allowedHosts: ["example.com"]` | `HOST_NOT_ALLOWED`: "Host \"wallets-demo-seller-server.calebgcarithers.workers.dev\" is not in allowedHosts (example.com). Only the wallet owner can change this in the config file." `paid: false` | 0.999 -> 0.999 |

No entry was written to `payments.jsonl` for either call.
