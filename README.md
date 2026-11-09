# AgentPay402 MCP

AgentPay402 MCP (`agentpay402-mcp`) is a Claude Code plugin with a local MCP server that lets Claude **discover, price, check and pay for** [x402](https://x402.org) APIs with your own wallet.
It exposes the 8 tools of Coinbase's Payments MCP plus `check_seller`, and the wallet is pluggable: **CDP / Privy / Crossmint**, paying USDC on Base and Solana. When a 402 offers Nevermined credits (`nvm:erc4337`), it can pay those too.

- Spending limits (per call / per session / allowed hosts) are set by you in the plugin settings or in `~/.x402-wallet-mcp/config.json`. No tool lets Claude change them.
- The default network is `testnet` (Base Sepolia / Solana Devnet). Paying real USDC requires you to switch it to `mainnet`.
- Before paying, the server checks the seller's record in Seller Probe, the 402's required input and price, and remembered refusals; after paying it confirms the transfer on chain and verifies Delivery Receipts.

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

## Install (Claude Code plugin)

The local MCP server runs in **Claude Code** (terminal, IDE extensions, desktop app's Code tab). Claude chat on claude.ai and Cowork do not start local servers from plugins. Node.js 20+ and npm must be on your PATH; Claude Code installs the plugin's npm dependencies from `package-lock.json`.

1. Install the plugin from the Claude plugin directory (`/plugin directory`), or for local testing run `claude --plugin-dir /path/to/x402-wallet-mcp`.
2. Claude Code asks for the plugin settings (or run `/plugin configure agentpay402-mcp`). Credentials are stored in your system's secure credential store, not in `settings.json`.
3. Start a new session and ask Claude to run `check_sign_in_status`.

| Setting | Meaning | Default |
| - | - | - |
| Wallet provider | `cdp`, `privy`, `crossmint`, or `none` (discovery and checking tools only) | `none` |
| CDP API key ID / secret, CDP wallet secret | for `cdp` (masked) | — |
| Privy app ID / secret, Privy wallet ID | for `privy` (masked) | — |
| Crossmint server API key / signer secret / wallet address | for `crossmint` (masked) | — |
| Nevermined API key | optional, Nevermined credit plans (masked) | — |
| Network | `testnet` or `mainnet` | `testnet` |
| Per-call / per-session limit (USD) | spending limits | `0.10` / `1.00` |
| Allowed hosts | comma-separated; empty = all hosts | empty |
| Seller Probe check | `block` / `warn` / `off` | `block` |
| Bazaar price mismatch | `block` / `warn` / `off` | `warn` |
| Refetch with Delivery Receipt | `true` / `false` | `true` |
| Report non-delivery to Seller Probe | `true` / `false` | `false` |

Only the keys of the provider you choose need values; the others can stay empty. Values are checked when the server starts or pays: an unknown wallet provider, network or check mode is reported as an error.

The plugin hands each setting to the server as `CLAUDE_PLUGIN_OPTION_<KEY>`. When it runs as a plugin, the server takes credentials only from these plugin settings: provider credentials already set in your shell environment are ignored.

The repository and the npm package keep the name `x402-wallet-mcp` (used by the CLI commands below), and the local data folder stays `~/.x402-wallet-mcp/`.

The plugin starts the server with `node ${CLAUDE_PLUGIN_ROOT}/dist/index.js`. `dist/` is the plain `tsc` output of `src/` (not bundled or minified).

## Provider setup

With the plugin, enter these in the plugin settings. Without the plugin, the server reads the same values from environment variables, listed in [`.env.example`](.env.example).

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

## Spending limits and checks

Each setting is taken from, in order of precedence:

1. `~/.x402-wallet-mcp/config.json`, if the file exists — any key set there wins. Use it to pin a limit on your machine whatever the plugin settings say. The server only reads this file; it never creates or changes it.
2. The plugin settings (passed to the server as `X402_*` variables).
3. The defaults below.

`make_x402_request` reads the settings again on every call, so edits to `config.json` apply without a restart. `check_sign_in_status` shows where each value came from (`config.json`, `plugin setting` or `default`), not the values of the limits.

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
| Wallet provider APIs: CDP (`api.cdp.coinbase.com`), Privy (`api.privy.io`), Crossmint (`www.crossmint.com` / `staging.crossmint.com`) | signing and wallet lookups, only for the provider you configure |
| Nevermined (`api.live.nevermined.app` / `api.sandbox.nevermined.app`, chosen by the API key prefix) | only when a Nevermined API key is set and a 402 offers `nvm:erc4337`: list payment methods, create a delegation, mint an access token |
| The x402 seller you call | `make_x402_request`, `check_payment_requirements`, `check_seller`. The seller forwards the signed payment to its facilitator (for example CDP's `api.cdp.coinbase.com/platform/v2/x402` or PayAI), which settles it on chain; this server does not call the facilitator itself |
| The seller's `/.well-known/x402-receipt.json` | `make_x402_request`, `check_seller` (Delivery Receipt keys) |
| Seller Probe (`probe.x402jp.com`): `GET /scores/{host}`; `POST /reports` only when `reportToProbe` is true | `make_x402_request`, `check_seller` (unless `probeMode` is `off`) |
| Chain RPCs, dedicated first then public | balances and the on-chain payment check. The wallet SDKs also read chain RPCs (e.g. a recent Solana blockhash) to build a payment |

Chain RPCs: the dedicated RPC from `BASE_RPC_URL`, `BASE_SEPOLIA_RPC_URL`, `SOLANA_RPC_URL` or `SOLANA_DEVNET_RPC_URL` when set, then these public RPCs in order:

| Network | Public RPCs |
| - | - |
| Base | `mainnet.base.org`, `base-rpc.publicnode.com`, `base.drpc.org` |
| Base Sepolia | `sepolia.base.org`, `base-sepolia-rpc.publicnode.com` |
| Solana | `api.mainnet-beta.solana.com`, `solana-rpc.publicnode.com` |
| Solana Devnet | `api.devnet.solana.com` |

## Privacy Policy

This plugin runs on your computer. It has no server of its own, collects no analytics and sends no telemetry.

- **Credentials** you enter in the plugin settings are kept by Claude Code in your system's secure credential store and passed only to the local server process. They are sent only to the provider they belong to (CDP, Privy, Crossmint or Nevermined), to authenticate requests you trigger.
- **What leaves your computer** is limited to the destinations in [Where this server connects](#where-this-server-connects): the sellers you ask Claude to call (with the request you give and, when you pay, the signed payment), the wallet provider, the CDP Bazaar, Seller Probe lookups by host name, and chain RPC reads.
- **Seller Probe reports** are off by default. With "Report non-delivery to Seller Probe" on, a failed delivery sends the host, the URL without its query, network, amount, outcome, HTTP status, latency and which checks passed to `probe.x402jp.com`. Your address, the transaction and the response body are never sent.
- **Stored on your computer**, in `~/.x402-wallet-mcp/`: `payments.jsonl` (each payment's URL, price, network, payer key, transaction and body hash), `net-failures.jsonl` (hosts and networks that refused a payment) and, if you create it, `config.json`. Nothing else is written. Delete the folder to remove them.
- Spending-limit and balance values are not included in tool results, logs or stderr, except that `get_wallet_balance` returns your balance when Claude calls it.
- Third parties you reach (sellers, facilitators, wallet providers, RPCs, Seller Probe) handle data under their own policies.

Questions: open an issue at https://github.com/kato9292929/x402-wallet-mcp/issues.

## Without the plugin

The same server also runs as a plain stdio MCP server in other clients, configured with environment variables instead of plugin settings.

### MCP client configuration

The examples use CDP; swap the `env` for other providers.

#### Claude Desktop

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

#### Claude Code

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

#### Codex CLI

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

#### Gemini CLI

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
