import { address as solAddress } from "@solana/kit";
import { getAddress, isAddress } from "viem";
import { parseUsdToMicros } from "../chains.js";
import { DEFAULT_CONFIG } from "../config.js";
export class ParamError extends Error {
}
function lowerOnly(v, def, name) {
    if (v === null || v.trim() === "")
        return def;
    let micros;
    try {
        micros = parseUsdToMicros(v.trim());
    }
    catch {
        throw new ParamError(`"${name}" must be a USD amount like 0.05.`);
    }
    if (micros <= 0n)
        throw new ParamError(`"${name}" must be more than 0.`);
    return micros < parseUsdToMicros(def) ? v.trim() : def;
}
export function parseParams(url) {
    const q = url.searchParams;
    const out = {
        network: "mainnet",
        perCallMaxUsd: lowerOnly(q.get("max"), DEFAULT_CONFIG.perCallMaxUsd, "max"),
        dailyMaxUsd: lowerOnly(q.get("daily"), DEFAULT_CONFIG.perSessionMaxUsd, "daily"),
    };
    const network = q.get("network")?.trim();
    if (network) {
        if (network !== "mainnet" && network !== "testnet")
            throw new ParamError('"network" must be mainnet or testnet.');
        out.network = network;
    }
    const sol = q.get("solana")?.trim();
    if (sol) {
        try {
            out.solana = solAddress(sol);
        }
        catch {
            throw new ParamError('"solana" is not a valid Solana address.');
        }
    }
    const base = q.get("base")?.trim();
    if (base) {
        if (!isAddress(base))
            throw new ParamError('"base" is not a valid EVM address.');
        out.base = getAddress(base);
    }
    return out;
}
/** The spend settings the shared checks read: the URL's limits on top of the defaults. */
export function configFor(p) {
    return { ...DEFAULT_CONFIG, network: p.network, perCallMaxUsd: p.perCallMaxUsd, perSessionMaxUsd: p.dailyMaxUsd };
}
/** Rebuilds the query string, so a stored request can be checked again with the same settings. */
export function paramsQuery(p) {
    const q = new URLSearchParams();
    if (p.solana)
        q.set("solana", p.solana);
    if (p.base)
        q.set("base", p.base);
    q.set("network", p.network);
    q.set("max", p.perCallMaxUsd);
    q.set("daily", p.dailyMaxUsd);
    return q.toString();
}
