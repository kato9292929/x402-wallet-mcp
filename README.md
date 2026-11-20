# AgentPay402 MCP

A Claude Code plugin that lets Claude **discover, check and pay for** [x402](https://x402.org) APIs with your own wallet (CDP, Privy or Crossmint; USDC on Base and Solana, plus Nevermined credits). Before paying it checks the seller; after paying it confirms the transfer on chain and the delivery.

## Install

```bash
claude plugin marketplace add kato9292929/x402-wallet-mcp
claude plugin install agentpay402-mcp@x402inc
```

1. Enter your settings when Claude Code asks (or run `/plugin configure agentpay402-mcp@x402inc`). Credentials are kept in your system's secure credential store.
2. Start a new session and ask Claude to run `check_sign_in_status`.

To update: `claude plugin marketplace update x402inc`.

**Claude Code only** (terminal, IDE extensions, the desktop app's Code tab). It does not work in Claude chat on claude.ai, the desktop app's chat, or Cowork. Node.js 20+ must be on your PATH.

## Settings

| Setting | Meaning | Default |
| - | - | - |
| Wallet provider | `cdp`, `privy`, `crossmint`, or `none` (discovery and checking tools only) | `none` |
| CDP API key ID / secret, CDP wallet secret | for `cdp` | — |
| Privy app ID / secret, Privy wallet ID | for `privy` | — |
| Crossmint server API key / signer secret / wallet address | for `crossmint` | — |
| Nevermined API key | optional, Nevermined credit plans | — |
| Network | `testnet` or `mainnet` | `testnet` |
| Per-call / per-session limit (USD) | spending limits | `0.10` / `1.00` |
| Allowed hosts | comma-separated; empty = all hosts | empty |
| Seller Probe check | `block` / `warn` / `off` | `block` |
| Bazaar price mismatch | `block` / `warn` / `off` | `warn` |
| Refetch with Delivery Receipt | `true` / `false` | `true` |
| Report non-delivery to Seller Probe | `true` / `false` | `false` |

Only the keys of the provider you choose need values.

### Where to get the keys

- **cdp**: API key ID and secret from [CDP Portal → API Keys](https://portal.cdp.coinbase.com/api-keys/secret); wallet secret from [Wallets → Non-custodial → Security](https://portal.cdp.coinbase.com/wallets/non-custodial/security). Accounts are created on first use.
- **privy**: app ID and secret from [Privy Dashboard → App settings → Basics](https://dashboard.privy.io/apps?page=settings&tab=basics). Create the wallet with `privy-create-wallet ethereum` (see [Helper commands](#helper-commands)).
- **crossmint** (Base only): server API key from the [Crossmint Console](https://staging.crossmint.com/console/projects/apiKeys) (`sk_staging_...` works only with `testnet`, `sk_production_...` only with `mainnet`). Create the signer secret and wallet with `crossmint-gen-secret` and `crossmint-create-wallet`.
- **Nevermined**: [nevermined.app](https://nevermined.app) → Settings → API Keys. A `sandbox:` key works only with `testnet`, a `live:` key only with `mainnet`. Nevermined bills in credits, so the USD limits do not apply to it; cap it with the delegation's own limit.

Test USDC for Base Sepolia and Solana Devnet: [Circle faucet](https://faucet.circle.com/).

## Tools

| Tool | What it does |
| - | - |
| `get_wallet_address` | Your wallet address, per chain |
| `get_wallet_balance` | USDC balance on each supported chain |
| `show_wallet_app` | Deposit address, chain, faucet hints and the current limits |
| `check_sign_in_status` | Whether the wallet is set up and can sign, and what is missing |
| `list_bazaar_resources` | Search x402 services in the CDP Bazaar |
| `get_resource_details` | Price, payment options and input/output for one service |
| `check_payment_requirements` | What a 402 asks for and whether it fits the limits — does not pay |
| `check_seller` | The pre-payment checks only — does not pay |
| `make_x402_request` | Calls a URL; on 402, checks, pays within the limits and confirms delivery |

Only `make_x402_request` moves money.

## Spending limits and checks

Only you can set the limits — in the plugin settings, or in `~/.x402-wallet-mcp/config.json`, which wins over the plugin settings. No tool lets Claude change them. The server only reads `config.json`, and re-reads it on every payment, so edits apply without a restart.

```json
{
  "perCallMaxUsd": "0.10",
  "perSessionMaxUsd": "1.00",
  "allowedHosts": [],
  "network": "testnet",
  "probeMode": "block",
  "priceMismatch": "warn",
  "retryWithReceipt": true,
  "reportToProbe": false
}
```

- A payment over the per-call limit, or one that would exceed the per-session total, is refused before signing.
- `testnet` pays only on Base Sepolia / Solana Devnet. Real USDC is paid only after you switch to `mainnet`.
- Only known USDC is paid; other assets are refused.
- Limit and balance values are never written into tool results or logs; a refusal says which limit was hit, not its value.

What `make_x402_request` does, in order:

1. **Before paying** — stops without signing when:
   - the host is not in your allowed hosts;
   - [Seller Probe](https://probe.x402jp.com)'s latest paid purchase from the host was paid but not delivered (`probeMode: block`);
   - an input the 402 marks as required is missing;
   - the price is over a limit, or differs from the Bazaar listing (`priceMismatch: block`);
   - every network the seller offers refused a payment recently.
2. **Pay** — sign, record the attempt, send.
3. **After paying** — find the transfer on chain (the seller's header is only a hint). If the seller took the money but did not deliver, and it publishes Delivery Receipt keys, refetch once with the same payment. A payment is never sent twice.

The result says `fulfilled`, `not_delivered`, `recovered_by_retry`, `blocked` or `rejected_by_seller`, with the transaction, a hash of the body and the receipt.

## Privacy Policy

This plugin runs on your computer. It has no server of its own, collects no analytics and sends no telemetry.

- **Credentials** you enter in the plugin settings are kept by Claude Code in your system's secure credential store and passed only to the local server. They are sent only to the provider they belong to (CDP, Privy, Crossmint or Nevermined), for requests you trigger.
- **What leaves your computer**: the sellers you ask Claude to call (your request and, when you pay, the signed payment); your wallet provider; the CDP Bazaar (`api.cdp.coinbase.com`); Seller Probe lookups by host name (`probe.x402jp.com`); the seller's `/.well-known/x402-receipt.json`; and chain RPC reads (Base, Base Sepolia, Solana, Solana Devnet public RPCs, or your own via `BASE_RPC_URL` etc.).
- **Seller Probe reports** are off by default. When on, a failed delivery sends the host, the URL without its query, network, amount, outcome, HTTP status, latency and which checks passed. Your address, the transaction and the response body are never sent.
- **Stored on your computer**, in `~/.x402-wallet-mcp/`: `payments.jsonl` (each payment's URL, price, network, payer key, transaction and body hash), `net-failures.jsonl` (hosts and networks that refused a payment) and, if you create it, `config.json`. Delete the folder to remove them.
- Third parties you reach (sellers, facilitators, wallet providers, RPCs, Seller Probe) handle data under their own policies.

Questions: open an issue at https://github.com/kato9292929/x402-wallet-mcp/issues.

## Helper commands

Wallet setup commands, run from a clone of this repository after `npm install`:

```bash
node dist/index.js status                         # is the wallet ready
node dist/index.js check-seller <url>             # pre-payment checks (does not pay)
node dist/index.js privy-create-wallet [ethereum|solana]
node dist/index.js crossmint-gen-secret
node dist/index.js crossmint-create-wallet
```

Run them with the same keys as environment variables (`WALLET_PROVIDER`, `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `CROSSMINT_SERVER_API_KEY`, …; see [`.env.example`](.env.example)).

## Development

```bash
npm install
npm run build
npm test
claude --plugin-dir .    # try this checkout without installing
```

## License

MIT
