/** Remote server (app/): the route files only mount the handlers compiled into dist/remote. */
export default {
  // "/" shows the static front page in public/index.html.
  async rewrites() {
    return [{ source: "/", destination: "/index.html" }];
  },
  typescript: { tsconfigPath: "tsconfig.next.json" },
  serverExternalPackages: [
    "@coinbase/cdp-sdk",
    "@privy-io/node",
    "@crossmint/wallets-sdk",
    "@x402/core",
    "@x402/evm",
    "@x402/svm",
    "@x402/extensions",
    "@x402/fetch",
    "@solana/kit",
    "@solana/web3.js",
    "viem",
    "mcp-handler",
    "@modelcontextprotocol/server",
    "@upstash/redis",
  ],
};
