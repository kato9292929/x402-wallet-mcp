import { atomicToMicros, chainInfo, formatMicros, knownUsdAsset, normalizeNetwork } from "../chains.js";
function decodeBase64Json(value) {
    return JSON.parse(Buffer.from(value.trim(), "base64").toString("utf8"));
}
function normalizeRequirement(raw, index, version) {
    const extra = (raw.extra && typeof raw.extra === "object" ? raw.extra : {});
    const network = normalizeNetwork(String(raw.network ?? ""));
    // v1 used maxAmountRequired, v2 uses amount
    const amountRaw = version === 1 ? (raw.maxAmountRequired ?? raw.amount) : (raw.amount ?? raw.maxAmountRequired);
    const amount = amountRaw === undefined || amountRaw === null ? undefined : String(amountRaw);
    const asset = raw.asset === undefined ? undefined : String(raw.asset);
    const req = {
        index,
        scheme: String(raw.scheme ?? ""),
        network,
        amount,
        asset,
        payTo: raw.payTo === undefined ? undefined : String(raw.payTo),
        maxTimeoutSeconds: typeof raw.maxTimeoutSeconds === "number" ? raw.maxTimeoutSeconds : undefined,
        extra,
        raw,
    };
    const planId = raw.planId ?? extra.planId;
    const agentId = extra.agentId ?? raw.agentId;
    if (planId !== undefined)
        req.planId = String(planId);
    if (agentId !== undefined)
        req.agentId = String(agentId);
    if (amount && asset && /^\d+$/.test(amount)) {
        const known = knownUsdAsset(network, asset);
        if (known)
            req.priceMicros = atomicToMicros(BigInt(amount), known.decimals);
    }
    return req;
}
function fromObject(obj, source) {
    if (!obj || typeof obj !== "object")
        return undefined;
    const o = obj;
    if (!Array.isArray(o.accepts))
        return undefined;
    const version = typeof o.x402Version === "number" ? o.x402Version : source === "header" ? 2 : 1;
    return {
        x402Version: version,
        error: typeof o.error === "string" ? o.error : undefined,
        resource: (o.resource && typeof o.resource === "object" ? o.resource : undefined),
        accepts: o.accepts.map((a, i) => normalizeRequirement(a, i, version)),
        raw: o,
        source,
    };
}
/**
 * Parses a 402 response. x402 v2 puts the PaymentRequired object in the
 * base64 `PAYMENT-REQUIRED` header; v1 (and some servers) put it in the JSON
 * body. Returns undefined if neither is present.
 */
export function parsePaymentRequired(getHeader, bodyText) {
    const header = getHeader("payment-required");
    if (header) {
        try {
            const parsed = fromObject(decodeBase64Json(header), "header");
            if (parsed)
                return parsed;
        }
        catch {
            // fall through to the body
        }
    }
    if (bodyText) {
        try {
            return fromObject(JSON.parse(bodyText), "body");
        }
        catch {
            return undefined;
        }
    }
    return undefined;
}
/** Settlement receipt from PAYMENT-RESPONSE (v2) or X-PAYMENT-RESPONSE (v1). */
export function parseSettleResponse(getHeader) {
    const header = getHeader("payment-response") ?? getHeader("x-payment-response");
    if (!header)
        return undefined;
    try {
        const decoded = decodeBase64Json(header);
        return decoded && typeof decoded === "object" ? decoded : undefined;
    }
    catch {
        return { raw: header };
    }
}
/** Is the 402 an MPP challenge (`WWW-Authenticate: Payment ...`) rather than x402? */
export function isMppChallenge(getHeader) {
    return /^\s*payment\b/i.test(getHeader("www-authenticate") ?? "");
}
/** Human/agent-friendly view of one requirement. */
export function describeRequirement(r) {
    const chain = chainInfo(r.network);
    return {
        index: r.index,
        scheme: r.scheme,
        network: r.network,
        chain: chain?.name,
        testnet: chain?.testnet,
        priceUsd: r.priceMicros !== undefined ? formatMicros(r.priceMicros) : undefined,
        amount: r.amount,
        asset: r.asset,
        assetSymbol: r.asset && knownUsdAsset(r.network, r.asset)?.symbol,
        payTo: r.payTo,
        maxTimeoutSeconds: r.maxTimeoutSeconds,
        planId: r.planId,
        agentId: r.agentId,
        extra: Object.keys(r.extra).length ? r.extra : undefined,
    };
}
