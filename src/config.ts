import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseUsdToMicros, type NetworkMode } from "./chains.js";

/**
 * Human-controlled spending configuration.
 *
 * Lives in ~/.x402-wallet-mcp/config.json (override the directory with
 * X402_WALLET_MCP_HOME). The MCP server only ever reads this file; there is
 * deliberately no tool that lets an agent change it.
 */
export type CheckMode = "block" | "warn" | "off";

export interface SpendConfig {
  perCallMaxUsd: string;
  perSessionMaxUsd: string;
  allowedHosts: string[];
  network: NetworkMode;
  /** Seller Probe: stop when its latest paid verdict is not_delivered (block), only report it (warn), or skip it (off). */
  probeMode: CheckMode;
  /** The 402 price differs from the Bazaar listing: stop (block), report (warn) or skip (off). */
  priceMismatch: CheckMode;
  /** After a paid non-200, refetch once with the same payment from sellers that publish Delivery Receipt keys. */
  retryWithReceipt: boolean;
  /** Send an anonymous not_delivered report to Seller Probe (POST /reports). */
  reportToProbe: boolean;
}

export const DEFAULT_CONFIG: SpendConfig = {
  perCallMaxUsd: "0.10",
  perSessionMaxUsd: "1.00",
  allowedHosts: [],
  network: "testnet",
  probeMode: "block",
  priceMismatch: "warn",
  retryWithReceipt: true,
  reportToProbe: false,
};

function mode(v: unknown, name: string, def: CheckMode): CheckMode {
  if (v === undefined) return def;
  if (v === "block" || v === "warn" || v === "off") return v;
  throw new Error(`${name} must be "block", "warn" or "off" (got ${JSON.stringify(v)})`);
}

function flag(v: unknown, name: string, def: boolean): boolean {
  if (v === undefined) return def;
  if (typeof v === "boolean") return v;
  throw new Error(`${name} must be true or false (got ${JSON.stringify(v)})`);
}

export function configDir(): string {
  return process.env.X402_WALLET_MCP_HOME || path.join(os.homedir(), ".x402-wallet-mcp");
}

export function configPath(): string {
  return path.join(configDir(), "config.json");
}

export function paymentLogPath(): string {
  return path.join(configDir(), "payments.jsonl");
}

export function validateConfig(raw: unknown): SpendConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("config.json must contain a JSON object");
  }
  const r = raw as Record<string, unknown>;
  const cfg: SpendConfig = {
    perCallMaxUsd: String(r.perCallMaxUsd ?? DEFAULT_CONFIG.perCallMaxUsd),
    perSessionMaxUsd: String(r.perSessionMaxUsd ?? DEFAULT_CONFIG.perSessionMaxUsd),
    allowedHosts: (r.allowedHosts ?? DEFAULT_CONFIG.allowedHosts) as string[],
    network: (r.network ?? DEFAULT_CONFIG.network) as NetworkMode,
    probeMode: mode(r.probeMode, "probeMode", DEFAULT_CONFIG.probeMode),
    priceMismatch: mode(r.priceMismatch, "priceMismatch", DEFAULT_CONFIG.priceMismatch),
    retryWithReceipt: flag(r.retryWithReceipt, "retryWithReceipt", DEFAULT_CONFIG.retryWithReceipt),
    reportToProbe: flag(r.reportToProbe, "reportToProbe", DEFAULT_CONFIG.reportToProbe),
  };
  parseUsdToMicros(cfg.perCallMaxUsd);
  parseUsdToMicros(cfg.perSessionMaxUsd);
  if (!Array.isArray(cfg.allowedHosts) || cfg.allowedHosts.some((h) => typeof h !== "string")) {
    throw new Error("allowedHosts must be an array of host names");
  }
  cfg.allowedHosts = cfg.allowedHosts.map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (cfg.network !== "testnet" && cfg.network !== "mainnet") {
    throw new Error(`network must be "testnet" or "mainnet" (got ${JSON.stringify(cfg.network)})`);
  }
  return cfg;
}

/**
 * Loads the config, creating it with defaults on first run so the human has a
 * file to edit. Re-read on every payment so edits apply without a restart.
 */
export async function loadConfig(): Promise<SpendConfig> {
  const file = configPath();
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    await fs.mkdir(configDir(), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", { mode: 0o600 });
    return { ...DEFAULT_CONFIG };
  }
  try {
    return validateConfig(JSON.parse(text));
  } catch (err) {
    throw new Error(`Invalid ${file}: ${(err as Error).message}`);
  }
}

/** SCHEME_PRIORITY env var, e.g. "exact,nvm:erc4337" (the default). */
export function schemePriority(): string[] {
  const raw = process.env.SCHEME_PRIORITY?.trim() || "exact,nvm:erc4337";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
