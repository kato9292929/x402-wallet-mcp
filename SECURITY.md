# Security Policy

AgentPay402 MCP signs payments with your wallet, so security reports are taken seriously.

## Supported versions

Only the latest released version (npm `agentpay402-mcp`, the Claude Code plugin `agentpay402-mcp@x402inc`, and the `main` branch) receives fixes.

## Reporting a vulnerability

Please report privately through GitHub's private vulnerability reporting: open https://github.com/kato9292929/x402-wallet-mcp/security/advisories/new. Do not open a public issue for a vulnerability.

Include what you found, how to reproduce it, and the impact (for example: a way to make the server pay more than the configured limits, pay a host outside `allowedHosts`, leak a credential or a limit value, or re-send a payment). You should get a first answer within 7 days.

## Scope notes

- Credentials are read from the plugin settings (Claude Code secure storage) or from environment variables you set; they are only sent to the provider they belong to.
- Spending limits are enforced locally before any payment is signed. Any way around them is in scope.
- Third-party services the server talks to (wallet providers, sellers, facilitators, RPCs, Seller Probe) are out of scope; report issues to them directly.
