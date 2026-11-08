import { isTestnet } from "../chains.js";
export const NVM_SCHEME = "nvm:erc4337";
/** sandbox-type keys pay testnets only, live-type keys mainnets only. */
function nvmEnvIsTestnet(env) {
    if (!env)
        return undefined;
    if (/sandbox/i.test(env))
        return true;
    if (/live/i.test(env))
        return false;
    return undefined;
}
/** Explains, for every entry in `accepts`, whether this client can pay it. */
export function evaluate(accepts, ctx) {
    return accepts.map((r) => {
        if (ctx.avoidNetworks?.includes(r.network)) {
            return { requirement: r, usable: false, reason: `this seller refused a payment on ${r.network} recently`, avoided: true };
        }
        if (!ctx.priority.includes(r.scheme)) {
            return { requirement: r, usable: false, reason: `scheme "${r.scheme}" is not in SCHEME_PRIORITY (${ctx.priority.join(",")})` };
        }
        if (r.scheme === NVM_SCHEME) {
            if (!ctx.nevermined)
                return { requirement: r, usable: false, reason: "NVM_API_KEY is not set" };
            if (!r.planId)
                return { requirement: r, usable: false, reason: "Nevermined requirement has no planId" };
            const wantTestnet = ctx.mode === "testnet";
            const keyTestnet = nvmEnvIsTestnet(ctx.neverminedEnv);
            if (keyTestnet !== wantTestnet) {
                return {
                    requirement: r,
                    usable: false,
                    reason: `NVM_API_KEY is a "${ctx.neverminedEnv ?? "unknown"}" key but config.json has network="${ctx.mode}" (testnet needs a sandbox: key, mainnet a live: key)`,
                };
            }
            const netTestnet = isTestnet(r.network);
            if (netTestnet !== undefined && netTestnet !== wantTestnet) {
                return { requirement: r, usable: false, reason: `network ${r.network} does not match config.json network="${ctx.mode}"` };
            }
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
export function selectRequirement(accepts, ctx) {
    const usable = evaluate(accepts, ctx)
        .filter((c) => c.usable)
        .map((c) => c.requirement);
    usable.sort((a, b) => {
        const pa = ctx.priority.indexOf(a.scheme);
        const pb = ctx.priority.indexOf(b.scheme);
        if (pa !== pb)
            return pa - pb;
        const ca = a.priceMicros ?? 0n;
        const cb = b.priceMicros ?? 0n;
        return ca < cb ? -1 : ca > cb ? 1 : a.index - b.index;
    });
    return usable[0];
}
