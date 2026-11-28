/** Remote server (app/): the route files only mount the handlers compiled into dist/remote. */
export default {
  // "/", "/terms" and "/privacy" show the static pages in public/.
  async rewrites() {
    return [
      { source: "/", destination: "/index.html" },
      { source: "/terms", destination: "/terms.html" },
      { source: "/privacy", destination: "/privacy.html" },
    ];
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
