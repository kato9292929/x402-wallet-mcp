import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseUsdToMicros } from "./chains.js";
export const DEFAULT_CONFIG = {
    perCallMaxUsd: "0.10",
    perSessionMaxUsd: "1.00",
    allowedHosts: [],
    network: "testnet",
    probeMode: "block",
    priceMismatch: "warn",
    retryWithReceipt: true,
    reportToProbe: false,
};
function mode(v, name, def) {
    if (v === undefined)
        return def;
    if (v === "block" || v === "warn" || v === "off")
        return v;
    throw new Error(`${name} must be "block", "warn" or "off" (got ${JSON.stringify(v)})`);
}
function flag(v, name, def) {
    if (v === undefined)
        return def;
    if (typeof v === "boolean")
        return v;
    throw new Error(`${name} must be true or false (got ${JSON.stringify(v)})`);
}
export function configDir() {
    return process.env.X402_WALLET_MCP_HOME || path.join(os.homedir(), ".x402-wallet-mcp");
}
export function configPath() {
    return path.join(configDir(), "config.json");
}
export function paymentLogPath() {
    return path.join(configDir(), "payments.jsonl");
}
export function validateConfig(raw) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new Error("config.json must contain a JSON object");
    }
    const r = raw;
    const cfg = {
        perCallMaxUsd: String(r.perCallMaxUsd ?? DEFAULT_CONFIG.perCallMaxUsd),
        perSessionMaxUsd: String(r.perSessionMaxUsd ?? DEFAULT_CONFIG.perSessionMaxUsd),
        allowedHosts: (r.allowedHosts ?? DEFAULT_CONFIG.allowedHosts),
        network: (r.network ?? DEFAULT_CONFIG.network),
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
export const ENV_KEYS = {
    perCallMaxUsd: "X402_PER_CALL_MAX_USD",
    perSessionMaxUsd: "X402_PER_SESSION_MAX_USD",
    allowedHosts: "X402_ALLOWED_HOSTS",
    network: "X402_NETWORK",
    probeMode: "X402_PROBE_MODE",
    priceMismatch: "X402_PRICE_MISMATCH",
    retryWithReceipt: "X402_RETRY_WITH_RECEIPT",
    reportToProbe: "X402_REPORT_TO_PROBE",
};
export function configFromEnv(env = process.env) {
    const out = {};
    for (const [key, name] of Object.entries(ENV_KEYS)) {
        const v = env[name]?.trim();
        if (!v)
            continue;
        if (key === "allowedHosts") {
            out[key] = v.startsWith("[") ? JSON.parse(v) : v.split(",").map((h) => h.trim()).filter(Boolean);
        }
        else if (key === "retryWithReceipt" || key === "reportToProbe") {
            if (!/^(true|false)$/i.test(v))
                throw new Error(`${name} must be true or false (got ${JSON.stringify(v)})`);
            out[key] = v.toLowerCase() === "true";
        }
        else {
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
export async function loadConfig() {
    let fromEnv;
    try {
        fromEnv = configFromEnv();
    }
    catch (err) {
        throw new Error(`Invalid plugin setting: ${err.message}`);
    }
    const file = configPath();
    let fromFile = {};
    try {
        const parsed = JSON.parse(await fs.readFile(file, "utf8"));
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
            throw new Error("config.json must contain a JSON object");
        fromFile = parsed;
    }
    catch (err) {
        if (err.code !== "ENOENT")
            throw new Error(`Invalid ${file}: ${err.message}`);
    }
    try {
        return validateConfig({ ...fromEnv, ...fromFile });
    }
    catch (err) {
        throw new Error(`Invalid settings: ${err.message}`);
    }
}
/** Where each effective setting came from (for check_sign_in_status). */
export async function configSources() {
    const fromEnv = (() => {
        try {
            return configFromEnv();
        }
        catch {
            return {};
        }
    })();
    let fromFile = {};
    try {
        fromFile = JSON.parse(await fs.readFile(configPath(), "utf8"));
    }
    catch {
        // no file
    }
    const out = {};
    for (const key of Object.keys(ENV_KEYS)) {
        out[key] = key in fromFile ? "config.json" : key in fromEnv ? "plugin setting" : "default";
    }
    return out;
}
/** SCHEME_PRIORITY env var, e.g. "exact,nvm:erc4337" (the default). */
export function schemePriority() {
    const raw = process.env.SCHEME_PRIORITY?.trim() || "exact,nvm:erc4337";
    return raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}
