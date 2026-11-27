# AgentPay402

**Agent payments, without the friction — Claude × x402.**

AgentPay402 lets Claude buy data from paid [x402](https://x402.org) APIs, one request at a time, in USDC from your own wallet. No account, subscription or API key is needed. Claude finds the API and checks the seller, the price and your limits. You sign the payment in Phantom (Solana) or Rabby / MetaMask (Base), and then Claude confirms the transfer on chain and the delivery.

Site: https://agentpay.x402jp.com · [Terms](https://agentpay.x402jp.com/terms.html) · [Privacy](https://agentpay.x402jp.com/privacy.html)

There are two ways to use it:

- **Connector** (`https://agentpay.x402jp.com/mcp`). Works in Claude (web, desktop) and Claude Code. You sign each payment through an approval link. This is the one most people want.
- **Claude Code plugin**. Runs on your computer and can pay from a server wallet (CDP, Privy, Crossmint) without a link per payment. See [Claude Code plugin](#claude-code-plugin).

## Connector

### Add it

**Claude** (Free, Pro, Max; Free plans allow one custom connector):

1. Open **Customize → Connectors** (https://claude.ai/customize/connectors).
2. Choose **+ Add → Add custom connector**.
3. Name it `AgentPay402` and paste `https://agentpay.x402jp.com/mcp`.
4. Choose **No sign in**, then **Add**.
5. In a chat, turn it on from **+ → Connectors**.

On Team and Enterprise plans, an owner adds it under Organization settings → Connectors. These steps follow Anthropic's [custom connector guide](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp).

**Claude Code**:

```bash
claude mcp add --transport http agentpay https://agentpay.x402jp.com/mcp
```

Add `--scope user` to use it in every project.

This one URL pays on both Solana and Base. You pick the wallet on the approval page. The URL can also carry settings, all optional:

| Parameter | Meaning | Default |
| - | - | - |
| `solana` | Your Phantom address, so payments are counted per wallet | chosen on the approval page |
| `base` | Your Rabby / MetaMask address | chosen on the approval page |
| `network` | `mainnet` or `testnet` (Base Sepolia / Solana Devnet) | `mainnet` |
| `max` | Per-payment limit in USD (can only be lowered) | `0.10` |
| `daily` | 24-hour total per wallet in USD (can only be lowered) | `1.00` |

Example: `https://agentpay.x402jp.com/mcp?network=testnet&max=0.05`. No tool can change these settings.

### How a payment works

1. **Ask Claude to buy.** Name the provider or the kind of data (for example "Nansen smart money netflow on Base" or "BTC price"), or paste a paid API's URL and say "buy this". AgentPay402 checks the seller, the price, your limits and whether the payment can go through. If a check fails, Claude tells you why and nothing is prepared.
2. **Open the link and sign.** Claude shows an approval link with the price, the payee, the API and the network. Sign in Phantom on Solana, or in Rabby / MetaMask on Base. On a phone, open the link in the Phantom app.
3. **Tell Claude "approved".** Claude fetches the result: the API response, the transaction found on chain and the delivery check.

A link that is not approved expires in 5 minutes, and nothing is paid unless you sign.

### Tools

| Tool | What it does |
| - | - |
| `buy_data` | Finds the best-matching paid endpoint for a request and returns an approval link in one call. Asks for missing input (`confirm_input`) instead of guessing |
| `request_x402_payment` | Checks a specific x402 URL and returns an approval link |
| `get_x402_result` | After you approve: the response, the transaction and the delivery check |
| `list_bazaar_resources` | Searches x402 services in the CDP Bazaar |
| `get_resource_details` | Shows the price, payment options and input/output for one service |
| `check_payment_requirements` | Shows what a 402 asks for and whether it fits the limits |
| `check_seller` | Runs every pre-payment check without paying |
| `get_wallet_address` / `get_wallet_balance` | Shows the addresses in the URL and their USDC balance |

No tool moves money. A payment happens only when you sign the approval link in your own wallet. The server holds no keys.

### Checks and network choice

- Before a link is made, AgentPay402 checks a number of things. If any check fails, no link is made:
  - [Seller Probe](https://probe.x402jp.com)'s record of the seller;
  - required input that is missing;
  - the price against your limits and the Bazaar listing;
  - payments the seller refused recently;
  - whether the seller's Solana address can receive USDC;
  - whether the facilitator accepts what your wallet signs.
- The seller's payment terms are checked again when you sign. If only the payee address changed (some sellers rotate it), the payment is rebuilt for the new address.
- AgentPay402 picks the network in this order:
  1. the network a payment to that seller is known to go through;
  2. Solana through a facilitator known to accept Phantom;
  3. Base;
  4. any other Solana option.
- The front page lists the APIs that have actually been paid and delivered through AgentPay402, each with its transaction.

### Limits on approval links

- One wallet address (when the connection URL has one), or else one connection, can have at most **20** approval links waiting at once, and the whole server at most 100. Each link expires in 5 minutes, nothing is paid unless it is signed, and the per-payment and 24-hour limits are checked again when it is signed, so these numbers only cap how many links are open. 20 is enough to test a batch of APIs in one go. An expired, rejected or finished link frees its place at once.
- A connection is the MCP session or, without one, the sending IP. This server issues an `Mcp-Session-Id` at initialize, signed with a server key (HMAC): an id it did not issue is ignored and the caller is counted by IP. Ids are issued at most 10 times per 5 minutes per IP (1000 for Anthropic's published outbound IPs); over that, initialize still works but no id is issued.
- Claude.ai connects from Anthropic's cloud and does not forward users' IPs, so the session is what tells users apart there. Anthropic's published outbound ranges (`160.79.104.0/21`, `153.61.208.0/20`, from https://platform.claude.com/docs/en/api/ip-addresses) only get looser limits; they never skip them. From any other IP, all its sessions together also count toward per-IP limits: 20 waiting links and 60 calls per 5 minutes.
- Tools that fetch a seller's 402 (`request_x402_payment`, `buy_data`, `check_payment_requirements`, `check_seller`) can be called 30 times per 5 minutes per session (300 per Anthropic IP when there is no valid session). Over that, they return `blocked` / `rate_limited` with `retry_after_s`, without contacting the seller.
- Only hashes of session ids and IPs are kept, keyed with the server secret, for 5 minutes. `/api/session-stats` shows, for today and yesterday, the share of those tool calls that came with a valid session id (no counts, ids or IPs).
- After a payment is signed and sent, AgentPay402 waits up to 45 seconds for the seller's answer. If none comes, the outcome is settled from the chain: `not_delivered` (paid) when the transfer landed, or `no_response` (nothing paid) once the payment can no longer land: after the EIP-3009 `validBefore` on Base, or 3 minutes after it was built on Solana (its blockhash has expired by then). Until then `get_x402_result` returns `processing`.

## Claude Code plugin

A local MCP server for Claude Code that pays from a wallet you configure: CDP, Privy, Crossmint, or your own browser wallet (Phantom, Rabby, MetaMask). It uses USDC on Base and Solana, plus Nevermined credits. It adds `make_x402_request`, which pays within your limits from that wallet. A server wallet pays without asking each time; with a browser wallet, you sign each payment on a page it opens.

### Install

```bash
claude plugin marketplace add kato9292929/x402-wallet-mcp
claude plugin install agentpay402-mcp@x402inc
```

1. Enter your settings when Claude Code asks (or run `/plugin configure agentpay402-mcp@x402inc`). Credentials are kept in your system's secure credential store.
2. Start a new session and ask Claude to run `check_sign_in_status`.

To update: `claude plugin marketplace update x402inc`.

The plugin runs in Claude Code (terminal, IDE extensions, the desktop app's Code tab) and needs Node.js 20+ on your PATH. In Claude chat, use the [connector](#connector) instead.

### Settings

| Setting | Meaning | Default |
| - | - | - |
| Wallet provider | `cdp`, `privy`, `crossmint`, `browser`, or `none` (discovery and checking tools only) | `none` |
| CDP API key ID / secret, CDP wallet secret | for `cdp` | — |
| Privy app ID / secret, Privy wallet ID | for `privy` | — |
| Crossmint server API key / signer secret / wallet address | for `crossmint` | — |
| Phantom address (Solana) / Browser wallet address (Base) | for `browser`: set one or both | — |
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

- **browser** (no keys): enter your Phantom address to pay on Solana, and/or your Rabby / MetaMask address to pay on Base. Each payment opens a page in your browser showing the amount, recipient and API; you approve it in Phantom (or sign it in Rabby / MetaMask) or reject it. On `testnet`, turn on testnet mode in Phantom so it previews the payment correctly. Nothing is paid without your signature, and the plugin never holds your key. The spending limits still apply before the page opens.
- **cdp**: API key ID and secret from [CDP Portal → API Keys](https://portal.cdp.coinbase.com/api-keys/secret); wallet secret from [Wallets → Non-custodial → Security](https://portal.cdp.coinbase.com/wallets/non-custodial/security). Accounts are created on first use.
- **privy**: app ID and secret from [Privy Dashboard → App settings → Basics](https://dashboard.privy.io/apps?page=settings&tab=basics). Create the wallet with `privy-create-wallet ethereum` (see [Helper commands](#helper-commands)).
- **crossmint** (Base only): server API key from the [Crossmint Console](https://staging.crossmint.com/console/projects/apiKeys) (`sk_staging_...` works only with `testnet`, `sk_production_...` only with `mainnet`). Create the signer secret and wallet with `crossmint-gen-secret` and `crossmint-create-wallet`.
- **Nevermined**: [nevermined.app](https://nevermined.app) → Settings → API Keys. A `sandbox:` key works only with `testnet`, a `live:` key only with `mainnet`. Nevermined bills in credits, so the USD limits do not apply to it; cap it with the delegation's own limit.

Test USDC for Base Sepolia and Solana Devnet: [Circle faucet](https://faucet.circle.com/).

### Tools

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

### Spending limits and checks

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
   - with a browser wallet (Phantom), every Solana option goes through a facilitator known to refuse the transactions Phantom signs (`facilitator_incompatible`): a built-in list, plus any facilitator that refused such a payment in the last 7 days. Another option the seller offers (such as Base) is chosen instead when there is one;
   - the seller's Solana address has no account to receive the token (`payto_account_missing`); if the RPC cannot tell, the payment goes ahead with a warning.
2. **Pay** — sign, record the attempt, send.
3. **After paying** — find the transfer on chain (the seller's header is only a hint). If the seller took the money but did not deliver, and it publishes Delivery Receipt keys, refetch once with the same payment. A payment is never sent twice.

The result says `fulfilled`, `not_delivered`, `recovered_by_retry`, `blocked` or `rejected_by_seller`, with the transaction, a hash of the body and the receipt. A `blocked` or `rejected_by_seller` result carries a `detail`: what happened, which side the problem is on (wallet, facilitator, seller, or AgentPay402's own check) and what to do next.

### Privacy (plugin)

The connector's privacy policy is at https://agentpay.x402jp.com/privacy.html. The plugin runs on your computer. It has no server of its own, collects no analytics and sends no telemetry.

- **Credentials** you enter in the plugin settings are kept by Claude Code in your system's secure credential store and passed only to the local server. They are sent only to the provider they belong to (CDP, Privy, Crossmint or Nevermined), for requests you trigger.
- **What leaves your computer**: the sellers you ask Claude to call (your request and, when you pay, the signed payment); your wallet provider; the CDP Bazaar (`api.cdp.coinbase.com`); Seller Probe lookups by host name (`probe.x402jp.com`); the seller's `/.well-known/x402-receipt.json`; and chain RPC reads (Base, Base Sepolia, Solana, Solana Devnet public RPCs, or your own via `BASE_RPC_URL` etc.).
- **Seller Probe reports** are off by default. When on, a failed delivery sends the host, the URL without its query, network, amount, outcome, HTTP status, latency and which checks passed. Your address, the transaction and the response body are never sent.
- **Stored on your computer**, in `~/.x402-wallet-mcp/`: `payments.jsonl` (each payment's URL, price, network, payer key, transaction and body hash), `net-failures.jsonl` (hosts and networks that refused a payment) and, if you create it, `config.json`. Delete the folder to remove them.
- Third parties you reach (sellers, facilitators, wallet providers, RPCs, Seller Probe) handle data under their own policies.

Questions: open an issue at https://github.com/kato9292929/x402-wallet-mcp/issues.

### Helper commands

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
