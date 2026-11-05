import { isTestnet, type NetworkMode } from "../chains.js";
import type { Requirement } from "./parse.js";

export const NVM_SCHEME = "nvm:erc4337";

export interface SelectionContext {
  /** Scheme order of preference, e.g. ["exact", "nvm:erc4337"]. */
  priority: string[];
  /** CAIP-2 chains the active wallet can sign on. */
  walletChains: string[];
  /** testnet / mainnet from config.json. */
  mode: NetworkMode;
  /** Whether NVM_API_KEY is configured. */
  nevermined: boolean;
}

export interface Candidate {
  requirement: Requirement;
  usable: boolean;
  reason?: string;
}

/** Explains, for every entry in `accepts`, whether this client can pay it. */
export function evaluate(accepts: Requirement[], ctx: SelectionContext): Candidate[] {
  return accepts.map((r) => {
    if (!ctx.priority.includes(r.scheme)) {
      return { requirement: r, usable: false, reason: `scheme "${r.scheme}" is not in SCHEME_PRIORITY (${ctx.priority.join(",")})` };
    }
    if (r.scheme === NVM_SCHEME) {
      if (!ctx.nevermined) return { requirement: r, usable: false, reason: "NVM_API_KEY is not set" };
      if (!r.planId) return { requirement: r, usable: false, reason: "Nevermined requirement has no planId" };
      return { requirement: r, usable: true };
    }
    if (r.scheme === "exact") {
      const testnet = isTestnet(r.network);
      if (testnet === undefined) {
        return { requirement: r, usable: false, reason: `network ${r.network} is not supported` };
      }
      if (testnet !== (ctx.mode === "testnet")) {
        return {
          requirement: r,
          usable: false,
          reason: `network ${r.network} is ${testnet ? "a testnet" : "mainnet"} but config.json has network="${ctx.mode}"`,
        };
      }
      if (!ctx.walletChains.includes(r.network)) {
        return { requirement: r, usable: false, reason: `the active wallet cannot sign on ${r.network}` };
      }
      if (r.priceMicros === undefined) {
        return {
          requirement: r,
          usable: false,
          reason: `asset ${r.asset} on ${r.network} is not a known USD stablecoin, so it cannot be checked against the USD limits`,
        };
      }
      return { requirement: r, usable: true };
    }
    return { requirement: r, usable: false, reason: `scheme "${r.scheme}" is not implemented` };
  });
}

/**
 * Picks the requirement to pay: the first usable scheme in priority order,
 * cheapest first within a scheme.
 */
export function selectRequirement(accepts: Requirement[], ctx: SelectionContext): Requirement | undefined {
  const usable = evaluate(accepts, ctx)
    .filter((c) => c.usable)
    .map((c) => c.requirement);
  usable.sort((a, b) => {
    const pa = ctx.priority.indexOf(a.scheme);
    const pb = ctx.priority.indexOf(b.scheme);
    if (pa !== pb) return pa - pb;
    const ca = a.priceMicros ?? 0n;
    const cb = b.priceMicros ?? 0n;
    return ca < cb ? -1 : ca > cb ? 1 : a.index - b.index;
  });
  return usable[0];
}
