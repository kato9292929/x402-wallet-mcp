#!/usr/bin/env bash
# Pays one real 0.001 USDC x402 request on Solana, approved by you in Phantom.
#
#   bash scripts/try-phantom.sh <your Phantom address>
#
# A browser page opens; check the amount and approve in Phantom (or reject).
# Limits for this run: 0.01 USDC per call and in total, only api.losbeto.xyz.
# It uses its own settings folder (.try-phantom/), so your ~/.x402-wallet-mcp is untouched.
set -euo pipefail
cd "$(dirname "$0")/.."

ADDR="${1:-}"
URL="${2:-https://api.losbeto.xyz/ping402}"
if [ -z "$ADDR" ]; then
  echo "usage: bash scripts/try-phantom.sh <your Phantom address> [x402 url]" >&2
  exit 1
fi
[ -d node_modules ] || npm ci --no-audit --no-fund

HOST="$(node -e 'console.log(new URL(process.argv[1]).hostname)' "$URL")"
export X402_WALLET_MCP_HOME="$PWD/.try-phantom"
mkdir -p "$X402_WALLET_MCP_HOME"
cat > "$X402_WALLET_MCP_HOME/config.json" <<EOF
{
  "network": "mainnet",
  "perCallMaxUsd": "0.01",
  "perSessionMaxUsd": "0.01",
  "allowedHosts": ["$HOST"]
}
EOF

export WALLET_PROVIDER=browser
export BROWSER_SOLANA_ADDRESS="$ADDR"
unset BROWSER_WALLET_ADDRESS

echo "== wallet"
node dist/index.js status
echo "== paying $URL (approve in the browser page that opens)"
node dist/index.js pay "$URL"
echo "== payment log: $X402_WALLET_MCP_HOME/payments.jsonl"
