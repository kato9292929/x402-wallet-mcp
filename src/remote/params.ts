import { address as solAddress } from "@solana/kit";
import { getAddress, isAddress } from "viem";
import { parseUsdToMicros, type NetworkMode } from "../chains.js";
import { DEFAULT_CONFIG, type SpendConfig } from "../config.js";

/**
 * Settings carried by the connection URL the owner pastes into Claude:
 *   /api/mcp?solana=<Phantom address>&base=<Rabby / MetaMask address>&network=mainnet&max=0.05&daily=0.50
 * The server holds no keys. `max` (per payment) and `daily` (24-hour total per address) can only
 * lower the defaults, never raise them. No tool can change any of this.
 */
export interface RemoteParams {
  solana?: string;
  base?: `0x${string}`;
  network: NetworkMode;
  perCallMaxUsd: string;
  dailyMaxUsd: string;
}

export class ParamError extends Error {}

function lowerOnly(v: string | null, def: string, name: string): string {
  if (v === null || v.trim() === "") return def;
  let micros: bigint;
  try {
    micros = parseUsdToMicros(v.trim());
  } catch {
    throw new ParamError(`"${name}" must be a USD amount like 0.05.`);
  }
  if (micros <= 0n) throw new ParamError(`"${name}" must be more than 0.`);
  return micros < parseUsdToMicros(def) ? v.trim() : def;
}

export function parseParams(url: URL): RemoteParams {
  const q = url.searchParams;
  const out: RemoteParams = {
    network: "testnet",
    perCallMaxUsd: lowerOnly(q.get("max"), DEFAULT_CONFIG.perCallMaxUsd, "max"),
    dailyMaxUsd: lowerOnly(q.get("daily"), DEFAULT_CONFIG.perSessionMaxUsd, "daily"),
  };
  const network = q.get("network")?.trim();
  if (network) {
    if (network !== "mainnet" && network !== "testnet") throw new ParamError('"network" must be mainnet or testnet.');
    out.network = network;
  }
  const sol = q.get("solana")?.trim();
  if (sol) {
    try {
      out.solana = solAddress(sol);
    } catch {
      throw new ParamError('"solana" is not a valid Solana address.');
    }
  }
  const base = q.get("base")?.trim();
  if (base) {
    if (!isAddress(base)) throw new ParamError('"base" is not a valid EVM address.');
    out.base = getAddress(base);
  }
  if (!out.solana && !out.base) {
    throw new ParamError('Add your wallet address to the connection URL: ?solana=<Phantom address> and/or &base=<Rabby / MetaMask address>.');
  }
  return out;
}

/** The spend settings the shared checks read: the URL's limits on top of the defaults. */
export function configFor(p: RemoteParams): SpendConfig {
  return { ...DEFAULT_CONFIG, network: p.network, perCallMaxUsd: p.perCallMaxUsd, perSessionMaxUsd: p.dailyMaxUsd };
}

/** Rebuilds the query string, so a stored request can be checked again with the same settings. */
export function paramsQuery(p: RemoteParams): string {
  const q = new URLSearchParams();
  if (p.solana) q.set("solana", p.solana);
  if (p.base) q.set("base", p.base);
  q.set("network", p.network);
  q.set("max", p.perCallMaxUsd);
  q.set("daily", p.dailyMaxUsd);
  return q.toString();
}
