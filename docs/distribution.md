# Distribution: where AgentPay402 MCP is listed

Status of each channel and the exact text to submit where a person has to log in or open a pull request. Descriptions stay within what the README says: a buyer-side x402 plugin / MCP server for safe purchases (Seller Probe lookup before paying, on-chain confirmation after paying, Delivery Receipt refetch).

Common facts:

- Name: **AgentPay402 MCP**
- Repository: https://github.com/kato9292929/x402-wallet-mcp
- npm: `agentpay402-mcp` (https://www.npmjs.com/package/agentpay402-mcp)
- MCP Registry: `io.github.kato9292929/agentpay402-mcp`
- License: MIT
- Short description (≤100 chars): Pay for x402 APIs safely with your own wallet: Seller Probe check, on-chain proof, receipt refetch.
- Long description: AgentPay402 MCP is a buyer-side x402 MCP server and Claude Code plugin. Before paying it checks the seller in Seller Probe, the required input and the price; after paying it confirms the transfer on chain, and if a paid response is not delivered it refetches once with the same payment from sellers that support Delivery Receipts. Wallets: CDP, Privy or Crossmint; USDC on Base and Solana; optional Nevermined credits. Spending limits are set by the owner only.
- Category: Payments / Finance (x402, agentic commerce)

## 1. Official MCP Registry and npm

Published by `.github/workflows/publish.yml` when a `v*` tag is pushed: `npm publish` (needs the `NPM_TOKEN` repository secret), then `mcp-publisher login github-oidc` + `mcp-publisher publish` (GitHub OIDC; no device code or token needed for the `io.github.kato9292929/` namespace).

Check after publishing:

```bash
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.kato9292929/agentpay402-mcp"
```

## 2. Agent Plugins 1.0 clients

`plugin.json` + `mcp.json` at the repository root and `.agents/plugins/marketplace.json` (Codex). Install commands per client are in the README ("Other agent clients").

## 3. Community directories

| Directory | How it lists | Action |
| - | - | - |
| PulseMCP | Picks servers up from the official MCP Registry (its form is paused: https://www.pulsemcp.com/submit) | none — automatic after the Registry publish |
| Glama | Ingests the official MCP Registry; owner claims with GitHub login (`glama.json` is in the repo) | log in and claim, then release (below) |
| mcp.so | Web form, free review (paid "publish immediately" option not used) | submit (below) |
| MCPMarket | Web form, free tier (4–6 weeks; paid option not used) | submit (below) |
| cursor.directory | Web form with GitHub login; detects plugin components | submit (below) |
| Cline MCP Marketplace | GitHub issue with a 400×400 PNG logo (required) | skipped while there is no logo; `llms-install.md` is ready |
| Smithery | Self-serve listing ended on 2026-10-31 (curated directory only) | none |

### Glama

1. Wait until the server appears on https://glama.ai/mcp/servers (ingested from the Registry), or use **Add Server** there with the repository URL.
2. Sign in with GitHub, open the server page and choose **Claim ownership** (`glama.json` lists `kato9292929` as maintainer).
3. On the server's admin page, build it (the repository has a `Dockerfile`) and choose **Make Release**; the release unlocks the security scan and the tool-quality score.

### mcp.so — https://mcp.so/submit

- Type: MCP Server
- Repository URL: `https://github.com/kato9292929/x402-wallet-mcp`
- Name: `AgentPay402 MCP`
- Choose the free review.

### MCPMarket — https://mcpmarket.com/submit

- Type: MCP Server
- GitHub repository URL: `https://github.com/kato9292929/x402-wallet-mcp`
- Choose the free listing.

### cursor.directory — https://cursor.directory/plugins/new

- Sign in with GitHub, paste `https://github.com/kato9292929/x402-wallet-mcp`, submit.

## 4. x402 lists (pull requests)

Open each file on GitHub, choose **Edit** (pencil), paste the line where shown, and choose **Propose changes**: GitHub forks the repository, commits (signed by GitHub) and opens the pull request in one step. One pull request per repository.

### x402 Foundation — `docs/dev-tools/third-party-extensions.md`

https://github.com/x402-foundation/x402/edit/main/docs/dev-tools/third-party-extensions.md

Add as the last row of the **Third-party utilities** table (tools that never touch the payload `extensions`):

```
| [AgentPay402 MCP](https://github.com/kato9292929/x402-wallet-mcp) | Buyer-side MCP server and Claude Code plugin: checks the seller in Seller Probe before paying, confirms the transfer on chain after paying, and refetches an undelivered paid response via Delivery Receipt | TypeScript | [GitHub](https://github.com/kato9292929/x402-wallet-mcp) · [npm](https://www.npmjs.com/package/agentpay402-mcp) |
```

- Commit message / PR title: `docs: add AgentPay402 MCP to third-party utilities`
- PR body (follows the repository's template):

```
## Description

Adds AgentPay402 MCP to the Third-party utilities table. It is a buyer-side MCP server / Claude Code plugin that checks the seller in Seller Probe before paying, confirms the transfer on chain after paying, and refetches an undelivered paid response via Delivery Receipt. It does not read or write the payload `extensions` field, so it belongs in Third-party utilities.

## Tests

Docs-only change.

## Checklist

- [x] Docs only; no changelog fragment needed
- [x] AI assistance: the entry text was drafted with Claude Code and reviewed by me
```

### awesome-x402 — `README.md`

https://github.com/xpaysh/awesome-x402/edit/main/README.md

Add at the bottom of **🤖 AI Agent Integration → Model Context Protocol (MCP)**:

```
- [AgentPay402 MCP](https://github.com/kato9292929/x402-wallet-mcp) - Buyer-side x402 MCP server and Claude Code plugin that checks the seller in Seller Probe before paying, confirms the transfer on chain after paying, and refetches an undelivered paid response via Delivery Receipt.
```

- Commit message / PR title: `Add AgentPay402 MCP`
- PR body (from the repository's CONTRIBUTING):

```
## Add AgentPay402 MCP

**What:** A buyer-side x402 MCP server and Claude Code plugin (MIT, TypeScript) that pays x402 APIs with the user's own CDP, Privy or Crossmint wallet.

**Why:** It makes x402 purchases safer for agents: Seller Probe lookup before paying, on-chain confirmation after paying, and Delivery Receipt refetch when a paid response is not delivered.

**Quality checklist:**
- [x] Actively maintained
- [x] Documented (README, install steps)
- [x] x402-related
- [x] Link works
- [x] Follows the entry format

**Category:** AI Agent Integration → Model Context Protocol (MCP)
```

### awesome-agentic-commerce — `README.md` (branch `master`)

https://github.com/Merit-Systems/awesome-agentic-commerce/edit/master/README.md

Add at the end of **Open Source & SDKs**. The list already has an unrelated `agentpay-mcp`; the full name and npm link keep them apart:

```
- [AgentPay402 MCP](https://github.com/kato9292929/x402-wallet-mcp) - Buyer-side x402 MCP server and Claude Code plugin: Seller Probe check before paying, on-chain transfer confirmation after, and Delivery Receipt refetch for undelivered paid responses. ([npm](https://www.npmjs.com/package/agentpay402-mcp))
```

- PR title: `Add AgentPay402 MCP — buyer-side x402 MCP server with pre-payment seller checks`
- PR body: `Adds AgentPay402 MCP (MIT) under Open Source & SDKs: a buyer-side x402 MCP server / Claude Code plugin that checks sellers before paying, confirms transfers on chain and refetches undelivered paid responses. Not related to the existing agentpay-mcp entry.`

## 5. Own products

- x402 Endpoint: https://github.com/kato9292929/endpoint/pull/42 (site For Agents, README, `mcp/README.md`, MCP server instructions)
- Seller Probe: https://github.com/kato9292929/seller-probe/pull/29 (README, API section of the page; it has no MCP server)

Both are held until `agentpay402-mcp` is on npm, because they show `npx -y agentpay402-mcp`.
