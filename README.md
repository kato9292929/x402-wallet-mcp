# AgentPay402 MCP

## Install

```bash
claude plugin marketplace add kato9292929/x402-wallet-mcp
claude plugin install agentpay402-mcp@x402inc
```

**Claude Code only.** The plugin runs a local MCP server on your computer, which only Claude Code starts (terminal, IDE extensions, the desktop app's Code tab). It does not work in Claude chat on claude.ai, the Claude desktop app's chat, or Cowork. Node.js 20+ and npm must be on your PATH. After installing, enter your settings when Claude Code asks (or run `/plugin configure agentpay402-mcp@x402inc`), then start a new session.

## About

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

## Setup

This repository is its own plugin marketplace (`x402inc`, in `.claude-plugin/marketplace.json`) and lists one plugin, `agentpay402-mcp`, at the repository root. Claude Code installs the plugin's npm dependencies from `package-lock.json` when you install it.

1. Add the marketplace and install the plugin with the two commands under [Install](#install). Inside a Claude Code session, `/plugin marketplace add kato9292929/x402-wallet-mcp` and `/plugin install agentpay402-mcp@x402inc` do the same.
2. Claude Code asks for the plugin settings (or run `/plugin configure agentpay402-mcp@x402inc`). Credentials are stored in your system's secure credential store, not in `settings.json`.
3. Start a new session and ask Claude to run `check_sign_in_status`.

To update later: `claude plugin marketplace update x402inc`. To try a local checkout without installing: `claude --plugin-dir /path/to/x402-wallet-mcp`.

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

The npm package is `agentpay402-mcp` (also in the official MCP Registry as `io.github.kato9292929/agentpay402-mcp`); the repository keeps the name `x402-wallet-mcp`, and the local data folder stays `~/.x402-wallet-mcp/`.

### Plugin or npm: how the server tells

The same `dist/index.js` runs both ways. At startup it looks for variables named `CLAUDE_PLUGIN_OPTION_*`:

- **Present → plugin mode.** Claude Code started it from the plugin and passed the plugin settings. The server uses only these values; provider credentials and `X402_*` settings already in the environment are ignored.
- **Absent → npm / standalone mode** (`npx agentpay402-mcp`, or any MCP client). The server reads the ordinary environment variables: `WALLET_PROVIDER`, the provider keys, and the `X402_*` settings listed in [`.env.example`](.env.example) and [`server.json`](server.json).

`check_sign_in_status` shows where each spending setting came from.

The plugin starts the server with `node ${CLAUDE_PLUGIN_ROOT}/dist/index.js`. `dist/` is the plain `tsc` output of `src/` (not bundled or minified).

## Provider setup

With the plugin, enter these in the plugin settings. Without the plugin, set the same values as environment variables in your MCP client's config, listed in [`.env.example`](.env.example).

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
PRIVY_APP_ID=... PRIVY_APP_SECRET=... npx -y agentpay402-mcp privy-create-wallet ethereum
```

If the wallet has an owner (authorization key), also set `PRIVY_AUTHORIZATION_PRIVATE_KEY`. Signing uses `createX402Client` from `@privy-io/node/x402`.

### crossmint (EVM only)

| Variable | Where to get it |
| - | - |
| `CROSSMINT_SERVER_API_KEY` (alias `CROSSMINT_API_KEY`) | Server-side key from the [Crossmint Staging Console → API Keys](https://staging.crossmint.com/console/projects/apiKeys) (`sk_staging_...`; staging keys have all scopes enabled). For production, use the [Production Console](https://www.crossmint.com/console/projects/apiKeys) |
| `CROSSMINT_SIGNER_SECRET` | Generate with `npx -y agentpay402-mcp crossmint-gen-secret` (32 random bytes, generated locally and never sent to Crossmint) |
| `CROSSMINT_WALLET_ADDRESS` | Create with `npx -y agentpay402-mcp crossmint-create-wallet` (a smart wallet with the server signer as its recovery method) |

A staging key only works with `network: "testnet"` (Base Sepolia), and a production key only with `"mainnet"` (Base). On staging,
`npx -y agentpay402-mcp crossmint-staging-fund 5` mints test USDXM, but most x402 sellers on Base Sepolia want USDC, so fund USDC from the Circle faucet. Signing uses a custom signer (`ExactEvmScheme`) that delegates `signTypedData` to the Crossmint wallet.

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

## Other agent clients (Agent Plugins 1.0)

The repository is also an [Agent Plugins 1.0](https://agent-plugins.org/specification) package: `plugin.json` and `mcp.json` at the root (the Claude Code files under `.claude-plugin/` are separate and unaffected), plus a Codex marketplace file at `.agents/plugins/marketplace.json`. The plugin's `mcp.json` starts the server from npm as `npx -y agentpay402-mcp@<version>`, so the client does not need to install dependencies.

Agent Plugins has no way to pass settings or secrets to a plugin's server, so a server started from the plugin runs **without a wallet** (`WALLET_PROVIDER=none`): discovery and checking tools work, payments do not. To pay, register the server once more in the client's own MCP settings with your keys, using the client's secret mechanism below. Use the variable names from [Without the plugin](#without-the-plugin-npm-other-mcp-clients).

### Codex CLI

Install ([Codex plugins](https://developers.openai.com/codex/plugins/build)):

```bash
codex plugin marketplace add kato9292929/x402-wallet-mcp
```

```bash
codex plugin add agentpay402-mcp@x402inc
```

To pay, add a server to `~/.codex/config.toml` that forwards the keys you export in your shell ([`env_vars`](https://developers.openai.com/codex/mcp)); Codex does not pass environment variables to a plugin's server ([openai/codex#24401](https://github.com/openai/codex/issues/24401)):

```toml
[mcp_servers.agentpay402]
command = "npx"
args = ["-y", "agentpay402-mcp"]
env_vars = ["WALLET_PROVIDER", "CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "CDP_WALLET_SECRET", "X402_NETWORK"]
```

### Cursor

Install the plugin from Cursor's plugin UI or [cursor.directory](https://cursor.directory) ([Cursor plugins](https://cursor.com/docs/plugins)). To pay, add the server to `~/.cursor/mcp.json` and read the keys from your environment with `${env:NAME}`, or from a file with `envFile` ([Cursor MCP](https://cursor.com/docs/mcp)):

```json
{
  "mcpServers": {
    "agentpay402": {
      "command": "npx",
      "args": ["-y", "agentpay402-mcp"],
      "env": {
        "WALLET_PROVIDER": "cdp",
        "CDP_API_KEY_ID": "${env:CDP_API_KEY_ID}",
        "CDP_API_KEY_SECRET": "${env:CDP_API_KEY_SECRET}",
        "CDP_WALLET_SECRET": "${env:CDP_WALLET_SECRET}"
      }
    }
  }
}
```

### VS Code (Copilot agent mode)

Enable `chat.plugins.enabled`, then run **Chat: Install Plugin from Source** with `https://github.com/kato9292929/x402-wallet-mcp` ([Agent plugins in VS Code](https://code.visualstudio.com/docs/agent-customization/agent-plugins)). To pay, add the server to `.vscode/mcp.json` with password inputs, which VS Code prompts for and stores securely ([MCP configuration](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)):

```json
{
  "inputs": [
    { "type": "promptString", "id": "cdp-key-id", "description": "CDP API key ID", "password": true },
    { "type": "promptString", "id": "cdp-key-secret", "description": "CDP API key secret", "password": true },
    { "type": "promptString", "id": "cdp-wallet-secret", "description": "CDP wallet secret", "password": true }
  ],
  "servers": {
    "agentpay402": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "agentpay402-mcp"],
      "env": {
        "WALLET_PROVIDER": "cdp",
        "CDP_API_KEY_ID": "${input:cdp-key-id}",
        "CDP_API_KEY_SECRET": "${input:cdp-key-secret}",
        "CDP_WALLET_SECRET": "${input:cdp-wallet-secret}"
      }
    }
  }
}
```

### GitHub Copilot CLI

Install ([CLI plugin reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference)):

```bash
copilot plugin install kato9292929/x402-wallet-mcp
```

Copilot CLI passes only `PATH` to MCP servers, so set the keys on a server entry ([Add MCP servers](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers)); this writes `~/.copilot/mcp-config.json`:

```bash
copilot mcp add agentpay402 --env WALLET_PROVIDER=cdp --env CDP_API_KEY_ID=... --env CDP_API_KEY_SECRET=... --env CDP_WALLET_SECRET=... -- npx -y agentpay402-mcp
```

## Without the plugin (npm, other MCP clients)

The same server runs as a plain stdio MCP server in any MCP client: `npx -y agentpay402-mcp`, published on npm and in the [official MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.kato9292929/agentpay402-mcp) as `io.github.kato9292929/agentpay402-mcp`. Configure it with environment variables instead of plugin settings:

| Variable | Meaning | Default |
| - | - | - |
| `WALLET_PROVIDER` | `cdp`, `privy`, `crossmint` or `none` (discovery and checking only) | — (required) |
| `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `CDP_WALLET_SECRET` | for `cdp` | — |
| `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_WALLET_ID` | for `privy` | — |
| `CROSSMINT_SERVER_API_KEY`, `CROSSMINT_SIGNER_SECRET`, `CROSSMINT_WALLET_ADDRESS` | for `crossmint` | — |
| `NVM_API_KEY` | optional, Nevermined credit plans | — |
| `X402_NETWORK` | `testnet` or `mainnet` | `testnet` |
| `X402_PER_CALL_MAX_USD`, `X402_PER_SESSION_MAX_USD` | spending limits | `0.10`, `1.00` |
| `X402_ALLOWED_HOSTS` | comma-separated hosts; empty = all | empty |
| `X402_PROBE_MODE`, `X402_PRICE_MISMATCH` | `block` / `warn` / `off` | `block`, `warn` |
| `X402_RETRY_WITH_RECEIPT`, `X402_REPORT_TO_PROBE` | `true` / `false` | `true`, `false` |

`~/.x402-wallet-mcp/config.json`, when present, still overrides the `X402_*` values.

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
claude mcp add x402-wallet -e WALLET_PROVIDER=cdp -e CDP_API_KEY_ID=... -e CDP_API_KEY_SECRET=... -e CDP_WALLET_SECRET=... -- npx -y agentpay402-mcp
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
npx -y agentpay402-mcp status                       # provider readiness
npx -y agentpay402-mcp check <url> [method] [json]  # inspect a 402 (does not pay)
npx -y agentpay402-mcp check-seller <url> [method] [json]  # pre-payment checks (does not pay)
npx -y agentpay402-mcp pay <url> [method] [json]    # pay once, within the limits
npx -y agentpay402-mcp privy-create-wallet [ethereum|solana]
npx -y agentpay402-mcp crossmint-gen-secret
npx -y agentpay402-mcp crossmint-create-wallet [alias]
npx -y agentpay402-mcp crossmint-staging-fund [amount]
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
