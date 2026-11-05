/**
 * Chain constants (CAIP-2) and the stablecoins this server knows how to price.
 *
 * Only assets listed in KNOWN_USD_ASSETS can be paid with the `exact` scheme:
 * the spend limits are expressed in USD, so an asset we cannot convert to USD
 * is refused rather than paid blindly.
 */

export const BASE = "eip155:8453";
export const BASE_SEPOLIA = "eip155:84532";
export const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

export type NetworkMode = "testnet" | "mainnet";

export interface ChainInfo {
  caip2: string;
  name: string;
  family: "evm" | "solana";
  testnet: boolean;
  usdc: string;
  explorerTx: (hash: string) => string;
}

export const CHAINS: Record<string, ChainInfo> = {
  [BASE]: {
    caip2: BASE,
    name: "Base",
    family: "evm",
    testnet: false,
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    explorerTx: (h) => `https://basescan.org/tx/${h}`,
  },
  [BASE_SEPOLIA]: {
    caip2: BASE_SEPOLIA,
    name: "Base Sepolia",
    family: "evm",
    testnet: true,
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    explorerTx: (h) => `https://sepolia.basescan.org/tx/${h}`,
  },
  [SOLANA]: {
    caip2: SOLANA,
    name: "Solana",
    family: "solana",
    testnet: false,
    usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    explorerTx: (h) => `https://solscan.io/tx/${h}`,
  },
  [SOLANA_DEVNET]: {
    caip2: SOLANA_DEVNET,
    name: "Solana Devnet",
    family: "solana",
    testnet: true,
    usdc: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    explorerTx: (h) => `https://solscan.io/tx/${h}?cluster=devnet`,
  },
};

/** x402 v1 used plain network names; map them onto CAIP-2. */
const V1_NAMES: Record<string, string> = {
  base: BASE,
  "base-sepolia": BASE_SEPOLIA,
  solana: SOLANA,
  "solana-devnet": SOLANA_DEVNET,
};

export function normalizeNetwork(network: string): string {
  return V1_NAMES[network] ?? network;
}

export function chainInfo(network: string): ChainInfo | undefined {
  return CHAINS[normalizeNetwork(network)];
}

export function isTestnet(network: string): boolean | undefined {
  return chainInfo(network)?.testnet;
}

export function chainsForMode(mode: NetworkMode): string[] {
  return Object.values(CHAINS)
    .filter((c) => c.testnet === (mode === "testnet"))
    .map((c) => c.caip2);
}

export interface KnownAsset {
  symbol: string;
  decimals: number;
  /** atomic units per 1 USD */
  usdPerUnit: 1;
}

/** Returns the USD-pegged asset for (network, asset) or undefined if unknown. */
export function knownUsdAsset(network: string, asset: string): KnownAsset | undefined {
  const info = chainInfo(network);
  if (!info) return undefined;
  const same =
    info.family === "evm" ? info.usdc.toLowerCase() === asset.toLowerCase() : info.usdc === asset;
  return same ? { symbol: "USDC", decimals: 6, usdPerUnit: 1 } : undefined;
}

/** "0.10" -> 100000n (micro-USD, i.e. 6 decimals). Throws on malformed input. */
export function parseUsdToMicros(value: string | number): bigint {
  const s = String(value).trim().replace(/^\$/, "");
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Invalid USD amount: ${value}`);
  const [whole, frac = ""] = s.split(".");
  const fracPadded = (frac + "000000").slice(0, 6);
  if (frac.length > 6 && /[1-9]/.test(frac.slice(6))) {
    throw new Error(`USD amount has more than 6 decimals: ${value}`);
  }
  return BigInt(whole) * 1_000_000n + BigInt(fracPadded);
}

/** Formats atomic units with the given decimals: (10000n, 6) -> "0.01". */
export function formatUnits(amount: bigint, decimals: number): string {
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  let frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

export function formatMicros(micros: bigint): string {
  return formatUnits(micros, 6);
}

/** Converts an atomic amount of a known USD asset to micro-USD. */
export function atomicToMicros(amount: bigint, decimals: number): bigint {
  if (decimals === 6) return amount;
  if (decimals > 6) {
    // round up so the limit check is never under-counted
    const div = 10n ** BigInt(decimals - 6);
    return (amount + div - 1n) / div;
  }
  return amount * 10n ** BigInt(6 - decimals);
}
