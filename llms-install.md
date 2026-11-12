# Installing AgentPay402 MCP (for AI assistants)

AgentPay402 MCP is a stdio MCP server published on npm as `agentpay402-mcp`. It lets the assistant discover x402 APIs, check sellers, and pay for API calls with the user's own wallet, within spending limits the user sets.

## 1. Ask the user which wallet to use

Ask the user for `WALLET_PROVIDER`: `cdp`, `privy`, `crossmint`, or `none` (discovery and checking only, no payments). Then ask for that provider's keys only. Never invent or guess keys.

| Provider | Variables to ask for | Where the user gets them |
| - | - | - |
| cdp | `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `CDP_WALLET_SECRET` | https://portal.cdp.coinbase.com/api-keys/secret and https://portal.cdp.coinbase.com/wallets/non-custodial/security |
| privy | `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_WALLET_ID` | https://dashboard.privy.io/apps?page=settings&tab=basics |
| crossmint | `CROSSMINT_SERVER_API_KEY`, `CROSSMINT_SIGNER_SECRET`, `CROSSMINT_WALLET_ADDRESS` | https://www.crossmint.com/console/projects/apiKeys (staging: https://staging.crossmint.com/console/projects/apiKeys) |

Optional: `NVM_API_KEY` (Nevermined credit plans).

## 2. Keep the safe defaults

Leave `X402_NETWORK` at `testnet` (test USDC on Base Sepolia / Solana Devnet) unless the user explicitly asks to spend real USDC. Keep the default limits (`X402_PER_CALL_MAX_USD=0.10`, `X402_PER_SESSION_MAX_USD=1.00`) unless the user gives other values.

## 3. Add the server to the MCP settings

```json
{
  "mcpServers": {
    "agentpay402": {
      "command": "npx",
      "args": ["-y", "agentpay402-mcp"],
      "env": {
        "WALLET_PROVIDER": "cdp",
        "CDP_API_KEY_ID": "<from the user>",
        "CDP_API_KEY_SECRET": "<from the user>",
        "CDP_WALLET_SECRET": "<from the user>",
        "X402_NETWORK": "testnet"
      }
    }
  }
}
```

Use the variables of the provider the user chose in place of the CDP ones. Node.js 20 or later is required.

## 4. Verify

Call the `check_sign_in_status` tool. `signedIn: true` means the wallet can pay. If it is false, its `reason` names the missing variable. Call `get_wallet_address` to show the user where to fund the wallet (test USDC: https://faucet.circle.com/).

Paying is done only with `make_x402_request`, and only after the user asks for a paid call. Use `check_seller` or `check_payment_requirements` first to show the price.
