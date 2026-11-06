# x402-wallet-mcp

A stdio MCP server that lets AI agents **discover, price, and pay for** [x402](https://x402.org) APIs.
It exposes the same 8 tools as Coinbase's Payments MCP (`npx @coinbase/payments-mcp`), but the wallet is pluggable: choose **CDP / Privy / Crossmint** with `WALLET_PROVIDER`. When a 402 offers Nevermined credits (`nvm:erc4337`), it can pay those too with `NVM_API_KEY`.

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
| `make_x402_request` | Calls a URL; on 402, signs within the limits and retries. Returns the response and the settle receipt (tx hash) |
| `check_payment_requirements` | Returns the 402 `accepts`, which option would be paid, and whether it fits the limits — without paying |

With `ARCIUM_MXE_PROGRAM_ID` set, two more (see [Private pricing](#private-pricing-arcium-mxe-optional)):

| Tool | What it does |
| - | - |
| `private_price_match` | Settles the price with a seller by comparing the owner's `perCallMaxUsd` with the seller's sealed floor inside Arcium MPC. Pays the revealed price on a match, nothing otherwise |
| `private_quote_auction` | Sealed-quote auction across 3+ sellers: only the lowest quote within `perCallMaxUsd` and its seller are revealed. Pays the winner |

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

### Private pricing (Arcium MXE, optional)

The owner's per-call limit doubles as a sealed cap: it is encrypted on this machine to an [Arcium](https://arcium.com) MXE and compared there with what the seller sealed, so neither the seller, the chain, nor the model driving the agent ever sees it. Only the outcome is revealed (matched + price, or winner + price). The seller side is [x402-private-pricing](https://github.com/kato9292929/x402-private-pricing), whose 402 carries `accepts[i].extra.arcium`.

| Variable | Description |
| - | - |
| `ARCIUM_MXE_PROGRAM_ID` | The `private_pricing` program on Arcium devnet. Setting it offers the two tools |
| `ARCIUM_FEE_PAYER_KEYPAIR` | A **devnet-only** Solana keypair (JSON array of 64 numbers) holding devnet SOL only. It pays the MPC computation fees. The USDC payment itself is signed by the wallet provider as usual |
| `SOLANA_DEVNET_RPC_URL` (optional) | Devnet RPC (default `https://api.devnet.solana.com`) |
| `ARCIUM_CLUSTER_OFFSET` (optional) | Arcium cluster (default `456`, devnet) |
| `ARCIUM_RFQ_DURATION_SEC` (optional) | How long a quote auction stays open (default `max(60, 30 × sellers)`) |

- Works with `WALLET_PROVIDER=cdp` or `privy` (they pay on Solana) and `"network": "testnet"` only.
- The tools take no amount. The cap is `perCallMaxUsd`, read from `config.json`.
- While it is set, `perCallMaxUsd` is also kept out of every other tool's output: `show_wallet_app` / `check_sign_in_status` show it as `sealed`, and a limit error says only that the price is above the limit.
- The flow: GET → 402 with `extra.arcium` → seal the cap and queue the match (or open an RFQ and have each seller place its sealed quote) → read the revealed result from the chain → GET with the offer id → a 402 at exactly the revealed price → paid through `make_x402_request`'s own path (limits, signing, receipt, `payments.jsonl` with the offer id). A 402 at any other price is not paid.
- A seller without `extra.arcium` is handled like `make_x402_request`.
- A match takes seconds to a minute; a quote auction a few minutes. Raise the MCP client's tool timeout if it is shorter.

## Spending limits (`~/.x402-wallet-mcp/config.json`)

Created with defaults on first run. `make_x402_request` re-reads it on every call, so edits apply without a restart.

```json
{
  "perCallMaxUsd": "0.10",
  "perSessionMaxUsd": "1.00",
  "allowedHosts": [],
  "network": "testnet"
}
```

- `perCallMaxUsd`: maximum for a single payment. Anything above it is refused before signing.
- `perSessionMaxUsd`: cumulative maximum since the process started (kept in memory). Payments the seller rejected (still 402 after retry) are not counted.
- `allowedHosts`: empty means all hosts. Otherwise only exact host matches are paid.
- `network`: `testnet` or `mainnet`. Chains from the other side are never paid.
- Assets that cannot be converted to USD (anything other than known USDC) are never paid.

Payments are logged to `~/.x402-wallet-mcp/payments.jsonl` (URL, amount, tx hash, explorer URL).

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
