import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import type { NetworkMode } from "../chains.js";
import type { ProviderId, WalletProvider } from "./types.js";

// Kept here (not imported from the provider modules) so vendor SDKs are only
// loaded for the provider actually selected.
const CDP_ENV = ["CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "CDP_WALLET_SECRET"];
const PRIVY_ENV = ["PRIVY_APP_ID", "PRIVY_APP_SECRET"];
const CROSSMINT_ENV = ["CROSSMINT_SERVER_API_KEY", "CROSSMINT_SIGNER_SECRET", "CROSSMINT_WALLET_ADDRESS"];

export * from "./types.js";

export const PROVIDER_IDS: ProviderId[] = ["cdp", "privy", "crossmint"];

export const SETUP_HELP = `x402-wallet-mcp: WALLET_PROVIDER is not set.

Set WALLET_PROVIDER to one of: cdp | privy | crossmint
(or "none" to run only the discovery tools without a wallet).

  cdp        ${CDP_ENV.join(", ")}
  privy      ${PRIVY_ENV.join(", ")}, PRIVY_WALLET_ID and/or PRIVY_SOLANA_WALLET_ID
  crossmint  ${CROSSMINT_ENV.join(", ")} (CROSSMINT_API_KEY is accepted for the key)

Optional: NVM_API_KEY (Nevermined credits), SCHEME_PRIORITY (default "exact,nvm:erc4337").
Spending limits live in ~/.x402-wallet-mcp/config.json.

Example (Claude Code):
  claude mcp add x402-wallet -e WALLET_PROVIDER=cdp -e CDP_API_KEY_ID=... \\
    -e CDP_API_KEY_SECRET=... -e CDP_WALLET_SECRET=... -- npx -y x402-wallet-mcp

See https://github.com/kato9292929/x402-wallet-mcp#readme
`;

/** Returns null for WALLET_PROVIDER=none; throws on unset / unknown values. */
export async function providerFromEnv(mode: NetworkMode): Promise<WalletProvider | null> {
  const id = process.env.WALLET_PROVIDER?.trim().toLowerCase();
  if (!id) throw new Error(SETUP_HELP);
  if (id === "none") return null;
  switch (id) {
    case "cdp":
      return new (await import("./cdp.js")).CdpProvider(mode);
    case "privy":
      return new (await import("./privy.js")).PrivyProvider(mode);
    case "crossmint":
      return new (await import("./crossmint.js")).CrossmintProvider(mode);
    default:
      throw new Error(`Unknown WALLET_PROVIDER "${id}".\n\n${SETUP_HELP}`);
  }
}

/** Builds the x402Client used to sign `exact` payments for this provider. */
export async function buildX402Client(provider: WalletProvider): Promise<x402Client> {
  if (provider.x402Client) return provider.x402Client();
  const client = new x402Client();
  // Limits are enforced by SpendGuard before we ever get here.
  client.setSpendControls(false);
  if (provider.evmSigner) client.register("eip155:*", new ExactEvmScheme(await provider.evmSigner()));
  if (provider.solanaSigner) client.register("solana:*", new ExactSvmScheme(await provider.solanaSigner()));
  return client;
}
