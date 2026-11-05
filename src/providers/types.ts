import type { x402Client } from "@x402/core/client";
import type { ClientEvmSigner } from "@x402/evm";
import type { ClientSvmSigner } from "@x402/svm";

export type ProviderId = "cdp" | "privy" | "crossmint";

export type EvmSigner = ClientEvmSigner;
export type SolanaSigner = ClientSvmSigner;

export interface FundingInfo {
  address: string;
  onrampUrl?: string;
  notes?: string[];
}

export interface TokenBalance {
  symbol: string;
  amount: string;
  asset?: string;
}

/**
 * A wallet that can sign x402 payments.
 *
 * Providers either hand out raw signers (`evmSigner` / `solanaSigner`), which
 * are registered on a fresh `x402Client`, or, when their SDK ships its own
 * x402 client (CDP's `CdpX402Client`, Privy's `createX402Client`), return it
 * from `x402Client()` directly.
 */
export interface WalletProvider {
  id: ProviderId;
  /** CAIP-2 chains this wallet can pay on, e.g. "eip155:84532". */
  chains(): string[];
  address(chain: string): Promise<string>;
  usdcBalance(chain: string): Promise<string>;
  /** Extra balances worth showing (e.g. Crossmint's USDXM on staging). */
  otherBalances?(chain: string): Promise<TokenBalance[]>;
  fundingInfo(chain: string): Promise<FundingInfo>;
  ready(): Promise<{ ok: boolean; reason?: string }>;
  evmSigner?(): Promise<EvmSigner>;
  solanaSigner?(): Promise<SolanaSigner>;
  x402Client?(): Promise<x402Client>;
}

export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigError";
  }
}

export function requireEnv(names: string[]): { missing: string[]; values: Record<string, string> } {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const n of names) {
    const v = process.env[n]?.trim();
    if (v) values[n] = v;
    else missing.push(n);
  }
  return { missing, values };
}

export function assertChain(provider: WalletProvider, chain: string): void {
  if (!provider.chains().includes(chain)) {
    throw new ProviderConfigError(
      `${provider.id} wallet does not support ${chain} in the current network mode. Supported: ${provider.chains().join(", ")}`,
    );
  }
}
