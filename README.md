# x402-wallet-mcp

A stdio MCP server that lets AI agents **discover, price, and pay for** [x402](https://x402.org) APIs.
It exposes the 8 tools of Coinbase's Payments MCP (`npx @coinbase/payments-mcp`) plus `check_seller`, and the wallet is pluggable: choose **CDP / Privy / Crossmint** with `WALLET_PROVIDER`. When a 402 offers Nevermined credits (`nvm:erc4337`), it can pay those too with `NVM_API_KEY`.

- Spending limits (per call / per session / allowed hosts) live in `~/.x402-wallet-mcp/config.json` and are set by a human only. No tool lets the agent change them.
- The default is `"network": "testnet"` (Base Sepolia / Solana Devnet). Paying with real USDC requires a human to switch it to `"mainnet"`.

## Tools

| Tool | What it does |
| - | - |
| `get_wallet_address` | The provider's wallet address, per chain |
| `get_wallet_balance` | USDC balance on every supported chain (also USDXM on Crossmint staging) |
| `show_wallet_app` | Text replacement for the original wallet UI: deposit address, chain, faucet / onramp hints and the current limits |
| `check_sign_in_status` | Whether the provider's credentials are configured and can sign, and what is missing if not |
| `list_bazaar_resources` | Search / list x402 services in the CDP Bazaar (public discovery API, no auth) |
| `get_resource_details` | Accepted payment options, price, description and input/output schema for one resource |
| `make_x402_request` | Calls a URL; on 402, runs the safe-buy checks, pays within the limits, finds the payment on chain and returns the response, tx, body hash and Delivery Receipt (see below) |
| `check_payment_requirements` | Returns the 402 `accepts`, which option would be paid, and whether it fits the limits — without paying |
| `check_seller` | Runs the pre-payment checks only — Seller Probe record, 402 `accepts`, missing input, Bazaar price difference, remembered refusals, Delivery Receipt support — without paying |

## Quick start

Requires Node.js 20+.

```bash
npx -y x402-wallet-mcp status
```

> Until the package is published to npm, run it straight from GitHub with `npx -y github:kato9292929/x402-wallet-mcp` (the first run builds it).

If `WALLET_PROVIDER` is not set, the server prints setup instructions to stderr and exits. Use `WALLET_PROVIDER=none` to run only the discovery tools without a wallet.

## Provider setup

All environment variables are listed in [`.env.example`](.env.example). Put the values in the `env` section of your MCP client config.

### cdp (Coinbase Developer Platform)

| Variable | Where to get it |
| - | - |
| `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` | [CDP Portal → API Keys → Secret API Keys](https://portal.cdp.coinbase.com/api-keys/secret): **Create API Key** → download the JSON (`id` and `privateKey`) |
| `CDP_WALLET_SECRET` | [CDP Portal → Wallets → Non-custodial → Security](https://portal.cdp.coinbase.com/wallets/non-custodial/security): **Generate Wallet Secret** |

The accounts (EVM and Solana) are created automatically on first use, named `CDP_ACCOUNT_NAME` (default `x402-wallet-mcp`). Signing uses `CdpX402Client` from `@coinbase/cdp-sdk/x402`. Chains: Base / Base Sepolia / Solana / Solana Devnet.

### privy

| Variable | Where to get it |
| - | - |
| `PRIVY_APP_ID` / `PRIVY_APP_SECRET` | [Privy Dashboard → Configuration → App settings → Basics](https://dashboard.privy.io/apps?page=settings&tab=basics), under **API keys** → **New secret** (Full access) |
| `PRIVY_WALLET_ID` | Create with the command below (Ethereum wallet; pays on Base / Base Sepolia) |
| `PRIVY_SOLANA_WALLET_ID` (optional) | Create with `privy-create-wallet solana` |

```bash
PRIVY_APP_ID=... PRIVY_APP_SECRET=... npx -y x402-wallet-mcp privy-create-wallet ethereum
```

If the wallet has an owner (authorization key), also set `PRIVY_AUTHORIZATION_PRIVATE_KEY`. Signing uses `createX402Client` from `@privy-io/node/x402`.

### crossmint (EVM only)

| Variable | Where to get it |
| - | - |
| `CROSSMINT_SERVER_API_KEY` (alias `CROSSMINT_API_KEY`) | Server-side key from the [Crossmint Staging Console → API Keys](https://staging.crossmint.com/console/projects/apiKeys) (`sk_staging_...`; staging keys have all scopes enabled). For production, use the [Production Console](https://www.crossmint.com/console/projects/apiKeys) |
| `CROSSMINT_SIGNER_SECRET` | Generate with `npx -y x402-wallet-mcp crossmint-gen-secret` (32 random bytes, generated locally and never sent to Crossmint) |
| `CROSSMINT_WALLET_ADDRESS` | Create with `npx -y x402-wallet-mcp crossmint-create-wallet` (a smart wallet with the server signer as its recovery method) |

A staging key only works with `network: "testnet"` (Base Sepolia), and a production key only with `"mainnet"` (Base). On staging,
`npx -y x402-wallet-mcp crossmint-staging-fund 5` mints test USDXM, but most x402 sellers on Base Sepolia want USDC, so fund USDC from the Circle faucet. Signing uses a custom signer (`ExactEvmScheme`) that delegates `signTypedData` to the Crossmint wallet.

### Nevermined (optional extra scheme)

| Variable | Description |
| - | - |
| `NVM_API_KEY` | [nevermined.app](https://nevermined.app) → **Settings → Global NVM API Keys**. A `sandbox:` key targets sandbox and a `live:` key targets live (the prefix selects the environment). It must match `config.json`: `testnet` pays only with a `sandbox:` key, `mainnet` only with a `live:` key |
| `NVM_DELEGATION_ID` (recommended) | A delegation created by a human with its own spend cap and expiry. If unset, one is created on the first payment, capped at `perSessionMaxUsd` for 24 hours, and reused for the life of the process |
| `NVM_PAYMENT_METHOD_ID` (optional) | Payment method for the auto-created delegation. Defaults to the account's first active `erc4337` (crypto wallet) method |

If a 402's `accepts` contains `scheme: "nvm:erc4337"` and `NVM_API_KEY` is set, the server gets an access token with `payments.x402.getX402AccessToken(planId, agentId, { delegationConfig })` and retries with it in the `payment-signature` header (x402 v2), as Nevermined specifies. Buying plans is out of scope (purchase them on nevermined.app beforehand).

When a 402 offers both `exact` and `nvm:erc4337`, `SCHEME_PRIORITY` decides the order (default `exact,nvm:erc4337`).

> Nevermined bills in credits and its 402 carries no USD price, so the USD limits (perCall / perSession) cannot apply. Cap Nevermined spend with the delegation's spending limit. `allowedHosts` still applies.

## Spending limits (`~/.x402-wallet-mcp/config.json`)

Created with defaults on first run. `make_x402_request` re-reads it on every call, so edits apply without a restart.

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

- `perCallMaxUsd`: maximum for a single payment. Anything above it is refused before signing.
- `perSessionMaxUsd`: cumulative maximum since the process started (kept in memory). Payments the seller rejected (still 402 after retry) are not counted.
- `allowedHosts`: empty means all hosts. Otherwise only exact host matches are paid.
- `network`: `testnet` or `mainnet`. Chains from the other side are never paid.
- Assets that cannot be converted to USD (anything other than known USDC) are never paid.
- `probeMode` (`block` / `warn` / `off`): what to do when Seller Probe's latest paid purchase from the host was paid but not delivered.
- `priceMismatch` (`block` / `warn` / `off`): what to do when the 402 asks a different amount than the Bazaar lists.
- `retryWithReceipt`: after a paid request that did not deliver, refetch once with the same payment — only from sellers that publish `/.well-known/x402-receipt.json`.
- `reportToProbe`: send an anonymous `not_delivered` report to Seller Probe (host, URL without query, network, amount, outcome, HTTP status, latency and which checks passed; never the payer, tx or body).

Limit and balance values are never written into tool results, logs or stderr: a refusal says which limit was hit, not its value.

Payments are logged to `~/.x402-wallet-mcp/payments.jsonl`: an `attempt` line with the payer key (Solana signature or Base authorization nonce) before the request is sent, then a `result` line (status, settlement, tx, body hash). Refusals by sellers are remembered in `~/.x402-wallet-mcp/net-failures.jsonl`.

## Safe buy (`make_x402_request`)

| # | Step | Stops (without signing) when |
| - | - | - |
| 1 | Read `config.json`, check `allowedHosts` | the host is not allowed |
| 2 | Look the host up in Seller Probe (`GET https://probe.x402jp.com/scores/{host}`) | its latest paid verdict is "paid but not delivered" and `probeMode` is `block`. No answer → `probe: "unavailable"`, no score → `probe: "unscored"`; neither stops |
| 3 | Send the request, receive the 402 | — |
| 4 | Read the 402's input schema (`extensions.bazaar` / `accepts[].outputSchema`) | an input marked required is missing from the request |
| 5 | Check the amount | it is over a limit, or differs from the Bazaar listing and `priceMismatch` is `block` |
| 6 | Pick the network, skipping (host, network) pairs that refused a payment | every payable network refused within 24 h (or before Seller Probe's next paid measurement) |
| 7 | Sign; record the payer key; send | — |
| 8 | Find our own transfer on chain (dedicated RPC, then public RPCs). The settlement header is only a hint | — (if no RPC can tell: `settlement: "unknown"`, never re-sent) |
| 9 | Non-200 with a landed transfer → `not_delivered`; from a Delivery Receipt seller, refetch once with the same payment | — |
| 10 | Return the result | — |

Result fields: `status` (`fulfilled` / `not_delivered` / `recovered_by_retry` / `blocked` / `rejected_by_seller`), `blocked_reason` (`probe_not_delivered` / `missing_input` / `over_cap` / `price_mismatch` / `network_avoided` / `host_not_allowed`), `body`, `tx` (network and tx found on chain), `settlement` (`verified` / `not_found` / `unknown`), `header_tx_matched` (did the settlement header's tx match the transfer on chain; `null` without a header), `body_sha256`, `receipt` (Delivery Receipt and its verification), `probe`.

## Where this server connects

| Destination | When |
| - | - |
| CDP Bazaar discovery API (`api.cdp.coinbase.com/platform/v2/x402/discovery`) | `list_bazaar_resources`, `get_resource_details`, and the Bazaar price check |
| Wallet provider APIs: CDP (`api.cdp.coinbase.com`), Privy (`api.privy.io`), Crossmint (`www.crossmint.com` / `staging.crossmint.com`), Nevermined (`api.live.nevermined.app` / `api.sandbox.nevermined.app`) | signing and wallet lookups, for the provider you configure |
| The x402 seller you call, and the facilitator it uses | `make_x402_request`, `check_payment_requirements`, `check_seller` |
| The seller's `/.well-known/x402-receipt.json` | `make_x402_request`, `check_seller` (Delivery Receipt keys) |
| Seller Probe (`probe.x402jp.com`): `GET /scores/{host}`; `POST /reports` only when `reportToProbe` is true | `make_x402_request`, `check_seller` (unless `probeMode` is `off`) |
| Chain RPCs, dedicated first then public | balances and the on-chain payment check |

Chain RPCs: the dedicated RPC from `BASE_RPC_URL`, `BASE_SEPOLIA_RPC_URL`, `SOLANA_RPC_URL` or `SOLANA_DEVNET_RPC_URL` when set, then these public RPCs in order:

| Network | Public RPCs |
| - | - |
| Base | `mainnet.base.org`, `base-rpc.publicnode.com`, `base.drpc.org` |
| Base Sepolia | `sepolia.base.org`, `base-sepolia-rpc.publicnode.com` |
| Solana | `api.mainnet-beta.solana.com`, `solana-rpc.publicnode.com` |
| Solana Devnet | `api.devnet.solana.com` |

## MCP client configuration

The examples use CDP; swap the `env` for other providers.

### Claude Desktop

`claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "x402-wallet": {
      "command": "npx",
      "args": ["-y", "x402-wallet-mcp"],
      "env": {
        "WALLET_PROVIDER": "cdp",
        "CDP_API_KEY_ID": "...",
        "CDP_API_KEY_SECRET": "...",
        "CDP_WALLET_SECRET": "..."
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add x402-wallet -e WALLET_PROVIDER=cdp -e CDP_API_KEY_ID=... -e CDP_API_KEY_SECRET=... -e CDP_WALLET_SECRET=... -- npx -y x402-wallet-mcp
```

Or in `.mcp.json`:

```json
{
  "mcpServers": {
    "x402-wallet": {
      "command": "npx",
      "args": ["-y", "x402-wallet-mcp"],
      "env": { "WALLET_PROVIDER": "cdp", "CDP_API_KEY_ID": "...", "CDP_API_KEY_SECRET": "...", "CDP_WALLET_SECRET": "..." }
    }
  }
}
```

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.x402-wallet]
command = "npx"
args = ["-y", "x402-wallet-mcp"]

[mcp_servers.x402-wallet.env]
WALLET_PROVIDER = "cdp"
CDP_API_KEY_ID = "..."
CDP_API_KEY_SECRET = "..."
CDP_WALLET_SECRET = "..."
```

### Gemini CLI

`~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "x402-wallet": {
      "command": "npx",
      "args": ["-y", "x402-wallet-mcp"],
      "env": { "WALLET_PROVIDER": "cdp", "CDP_API_KEY_ID": "...", "CDP_API_KEY_SECRET": "...", "CDP_WALLET_SECRET": "..." }
    }
  }
}
```

## CLI (for humans)

Helper commands that are not exposed as MCP tools.

```bash
npx -y x402-wallet-mcp status                       # provider readiness
npx -y x402-wallet-mcp check <url> [method] [json]  # inspect a 402 (does not pay)
npx -y x402-wallet-mcp check-seller <url> [method] [json]  # pre-payment checks (does not pay)
npx -y x402-wallet-mcp pay <url> [method] [json]    # pay once, within the limits
npx -y x402-wallet-mcp privy-create-wallet [ethereum|solana]
npx -y x402-wallet-mcp crossmint-gen-secret
npx -y x402-wallet-mcp crossmint-create-wallet [alias]
npx -y x402-wallet-mcp crossmint-staging-fund [amount]
```

## Development

```bash
npm install
npm run build
npm test                 # unit tests (402 parsing, accepts selection, limit checks, payment flow)
WALLET_PROVIDER=cdp ... npm run test:integration -- [url]   # one real payment on testnet
```

To test the Nevermined scheme without a public seller, `scripts/nvm-sandbox-seller.ts` registers a sandbox crypto plan + agent (`register`) and serves a local endpoint behind Nevermined's `paymentMiddleware` (`serve`, port 4021). Set `NVM_API_KEY_SELLER` to a `sandbox:` key, then run the integration test against `http://localhost:4021/ask` with `NVM_API_KEY` set.

The integration test defaults to a $0.001 Base Sepolia endpoint from the Bazaar, and refuses to run unless `config.json` is set to `testnet`. Get test USDC from the [Circle faucet](https://faucet.circle.com/) (Base Sepolia / Solana Devnet).

## License

MIT
