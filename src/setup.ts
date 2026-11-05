/**
 * Human-run setup helpers (CLI only, never exposed as MCP tools).
 *
 *   x402-wallet-mcp privy-create-wallet [ethereum|solana]
 *   x402-wallet-mcp crossmint-create-wallet [alias]
 *   x402-wallet-mcp crossmint-gen-secret
 */
import { randomBytes } from "node:crypto";
import type { NetworkMode } from "./chains.js";

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export async function privyCreateWallet(chainType: "ethereum" | "solana") {
  const { PrivyClient } = await import("@privy-io/node");
  const privy = new PrivyClient({ appId: need("PRIVY_APP_ID"), appSecret: need("PRIVY_APP_SECRET") });
  // No owner: an app-controlled server wallet, signed with the app secret.
  const w = await privy.wallets().create({ chain_type: chainType });
  return {
    id: w.id,
    address: w.address,
    chain_type: w.chain_type,
    env: chainType === "ethereum" ? `PRIVY_WALLET_ID=${w.id}` : `PRIVY_SOLANA_WALLET_ID=${w.id}`,
  };
}

export function crossmintGenSecret(): string {
  return `xmsk1_${randomBytes(32).toString("hex")}`;
}

export async function crossmintCreateWallet(mode: NetworkMode, alias = "x402-wallet-mcp") {
  const { CrossmintWallets, createCrossmint } = await import("@crossmint/wallets-sdk");
  const apiKey = process.env.CROSSMINT_API_KEY?.trim() || need("CROSSMINT_SERVER_API_KEY");
  const secret = need("CROSSMINT_SIGNER_SECRET");
  const chain = mode === "testnet" ? "base-sepolia" : "base";
  const wallets = CrossmintWallets.from(createCrossmint({ apiKey }));
  let wallet;
  try {
    wallet = await wallets.createWallet({ chain, recoveryMethods: [{ type: "server", secret }], alias });
  } catch (err) {
    // Already created with this alias: look it up instead.
    wallet = await wallets.getWallet(`evm:alias:${alias}`, { chain }).catch(() => {
      throw err;
    });
  }
  return { address: wallet.address, chain, alias, env: `CROSSMINT_WALLET_ADDRESS=${wallet.address}` };
}
