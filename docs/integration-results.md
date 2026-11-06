# Integration results

Real payments made with `npm run test:integration` (one `make_x402_request` per provider).
Seller: `https://wallets-demo-seller-server.calebgcarithers.workers.dev/weather?location=Tokyo` (Bazaar, `exact`, $0.001 USDC on Base Sepolia).
Test USDC came from the CDP faucet (`cdp.evm.requestFaucet`, base-sepolia / usdc).

| Date | Provider | Network | Payer | Price | Result | Settle tx |
| - | - | - | - | - | - | - |
| 2026-11-06 | cdp | Base Sepolia | `0xC2515323BFD288DDf1f28Ca3385B974e7a864a37` | $0.001 | 200, settled | [`0xee91db24…f882c7`](https://sepolia.basescan.org/tx/0xee91db24c70f191417544eea08a2995e316edfb7305f1f95dd4f689dddf882c7) |
| 2026-11-06 | privy | Base Sepolia | `0x6F3Bb845bB3Bb53295Ab9aF41EE2729a885f7d87` | $0.001 | 200, settled | [`0x4d112b79…e2561`](https://sepolia.basescan.org/tx/0x4d112b797a83892543bc916a189d03984a3459733c4c874a7b62cda2394e2561) |
| 2026-11-06 | crossmint | Base (mainnet) | `0xB46012a414c8c9aFBAe1e0232857e55D5e15BFaa` | — | ready (wallet + server signer load); no payment made | — |
| — | nevermined (`nvm:erc4337`) | Base Sepolia (sandbox) | — | — | pending: needs a seller endpoint | — |

Notes

- The Crossmint key in use is a production key, which only works on Base mainnet; a payment there spends real USDC and has not been run.
- The Nevermined sandbox key authenticates and the account has an active `erc4337` payment method; the payment test waits for a sandbox seller URL.
