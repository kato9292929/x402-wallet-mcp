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
/**
 * Settings passed in by the plugin's userConfig (as X402_* environment variables).
 * Empty values are ignored, so an option the user left blank falls back to the default.
 */
export const ENV_KEYS: Record<keyof SpendConfig, string> = {
  perCallMaxUsd: "X402_PER_CALL_MAX_USD",
  perSessionMaxUsd: "X402_PER_SESSION_MAX_USD",
  allowedHosts: "X402_ALLOWED_HOSTS",
  network: "X402_NETWORK",
  probeMode: "X402_PROBE_MODE",
  priceMismatch: "X402_PRICE_MISMATCH",
  retryWithReceipt: "X402_RETRY_WITH_RECEIPT",
  reportToProbe: "X402_REPORT_TO_PROBE",
};

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, name] of Object.entries(ENV_KEYS)) {
    const v = env[name]?.trim();
    if (!v) continue;
    if (key === "allowedHosts") {
      out[key] = v.startsWith("[") ? JSON.parse(v) : v.split(",").map((h) => h.trim()).filter(Boolean);
    } else if (key === "retryWithReceipt" || key === "reportToProbe") {
      if (!/^(true|false)$/i.test(v)) throw new Error(`${name} must be true or false (got ${JSON.stringify(v)})`);
      out[key] = v.toLowerCase() === "true";
    } else {
      out[key] = v;
    }
  }
  return out;
}

/**
 * The effective settings: defaults, then the plugin's userConfig (X402_* variables), then
 * ~/.x402-wallet-mcp/config.json when that file exists. A key set in config.json wins, so the
 * wallet owner can pin a limit locally whatever the plugin settings say. The file is only read,
 * never created. Re-read on every payment so edits apply without a restart.
 */
export async function loadConfig(): Promise<SpendConfig> {
  let fromEnv: Record<string, unknown>;
  try {
    fromEnv = configFromEnv();
  } catch (err) {
    throw new Error(`Invalid plugin setting: ${(err as Error).message}`);
  }
  const file = configPath();
  let fromFile: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("config.json must contain a JSON object");
    fromFile = parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Invalid ${file}: ${(err as Error).message}`);
  }
  try {
    return validateConfig({ ...fromEnv, ...fromFile });
  } catch (err) {
    throw new Error(`Invalid settings: ${(err as Error).message}`);
  }
}

/** Where each effective setting came from (for check_sign_in_status). */
export async function configSources(): Promise<Record<string, "config.json" | "plugin setting" | "default">> {
  const fromEnv = (() => {
    try {
      return configFromEnv();
    } catch {
      return {};
    }
  })();
  let fromFile: Record<string, unknown> = {};
  try {
    fromFile = JSON.parse(await fs.readFile(configPath(), "utf8"));
  } catch {
    // no file
  }
  const out: Record<string, "config.json" | "plugin setting" | "default"> = {};
  for (const key of Object.keys(ENV_KEYS)) {
    out[key] = key in fromFile ? "config.json" : key in fromEnv ? "plugin setting" : "default";
  }
  return out;
}

/** SCHEME_PRIORITY env var, e.g. "exact,nvm:erc4337" (the default). */
export function schemePriority(): string[] {
  const raw = process.env.SCHEME_PRIORITY?.trim() || "exact,nvm:erc4337";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
