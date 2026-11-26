/**
 * buy_data: from a short description of the data ("nansen smart money netflow") to an approval link in
 * one call. Searches the Bazaar, picks the best-matching endpoint this wallet can pay, fills its input
 * from the Bazaar's example when the user gave none, then runs the normal pre-payment checks. When the
 * best match is not clear, nothing is prepared and the top candidates are returned for Claude to choose.
 */
import { bazaarAccepts, searchBazaar } from "./bazaar.js";
import { formatMicros } from "./chains.js";
const STOP = new Set(["the", "a", "an", "of", "for", "to", "and", "or", "in", "on", "with", "data", "api", "get", "buy", "x402", "me", "my", "latest", "please"]);
const ALIASES = { btc: ["bitcoin"], bitcoin: ["btc"], eth: ["ethereum"], ethereum: ["eth"], sol: ["solana"], solana: ["sol"], sec: ["edgar"] };
export function queryTokens(q) {
    return [...new Set(q.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2 && !STOP.has(t)))];
}
/** How many of the query's words (or their aliases) the endpoint's URL, name or description contains. */
export function matchScore(tokens, item) {
    const text = `${item.resource} ${item.serviceName ?? ""} ${String(item.description ?? "").slice(0, 400)}`.toLowerCase();
    return tokens.filter((t) => text.includes(t) || (ALIASES[t] ?? []).some((a) => text.includes(a))).length;
}
function bazaarInput(item) {
    const ext = (item.extensions ?? {});
    const example = ext?.bazaar?.info?.input ?? {};
    const required = ext?.bazaar?.schema?.properties?.input?.properties?.queryParams?.required ?? [];
    return { example, requiredQuery: Array.isArray(required) ? required : [] };
}
/**
 * Bazaar results this wallet can pay (an exact option on one of `networks` within the price cap), best match first.
 * `networks` is in the wallet's order of preference, used when a seller asks the same price on several.
 */
export async function findCandidates(args, networks, capMicros, fetchImpl) {
    const items = await searchBazaar(args.query, fetchImpl);
    const tokens = queryTokens(args.query);
    const out = [];
    items.forEach((item, rank) => {
        if (/\/:[a-z]|[{}]/i.test(item.resource))
            return; // a path template, not a URL that can be called
        const payable = bazaarAccepts(item)
            .filter((r) => r.scheme === "exact" && networks.includes(r.network) && r.priceMicros !== undefined && r.priceMicros <= capMicros)
            .sort((a, b) => a.priceMicros < b.priceMicros ? -1 : a.priceMicros > b.priceMicros ? 1 : networks.indexOf(a.network) - networks.indexOf(b.network));
        if (!payable.length)
            return;
        const calls30d = Number(item.quality?.l30DaysTotalCalls ?? 0) || 0;
        out.push({ item, score: matchScore(tokens, item), rank, cheapest: payable[0], calls30d });
    });
    return out.sort((a, b) => b.score - a.score || a.rank - b.rank);
}
const delivered = (c) => (c.probe === "delivered" ? 1 : 0);
/**
 * Among the candidates that match the query equally well, puts first the ones with a better record:
 * Seller Probe's latest paid purchase delivered, then more calls in the last 30 days, then the Bazaar's order.
 * Sellers whose latest Probe purchase was paid but not delivered are dropped. Looks up at most 5 hosts.
 */
export async function rankByRecord(candidates, probe) {
    const top = candidates[0]?.score ?? 0;
    if (top === 0)
        return candidates;
    const tied = candidates.filter((c) => c.score === top).slice(0, 5);
    const rest = candidates.filter((c) => !tied.includes(c));
    await Promise.all(tied.map(async (c) => {
        try {
            const p = await probe(c.item.resource);
            c.probe = p.status === "scored" ? (p.verdict ?? "scored") : p.status;
        }
        catch {
            c.probe = "unavailable";
        }
    }));
    const ok = tied.filter((c) => c.probe !== "not_delivered");
    ok.sort((a, b) => delivered(b) - delivered(a) || b.calls30d - a.calls30d || a.rank - b.rank);
    return [...ok, ...rest];
}
/**
 * The best candidate, or null when nothing matches or the top ones cannot be told apart: the same match,
 * the same Probe record and the same number of calls in the last 30 days.
 */
export function decide(candidates) {
    const [top, next] = candidates;
    if (!top || top.score === 0)
        return null;
    if (!next || next.score < top.score)
        return top;
    if (delivered(top) !== delivered(next) || top.calls30d !== next.calls30d)
        return top;
    return null;
}
/** The request to send: the user's input first, then the Bazaar's example for what is required and missing. */
export function requestFor(c, args) {
    const { example, requiredQuery } = bazaarInput(c.item);
    const from = [];
    const method = (args.method ?? example.method ?? "GET").toUpperCase();
    let body = args.body;
    if (body === undefined && method !== "GET" && method !== "HEAD" && example.body !== undefined) {
        body = example.body;
        from.push("body");
    }
    const qp = { ...(args.query_params ?? {}) };
    for (const k of requiredQuery) {
        if (qp[k] === undefined && example.queryParams?.[k] !== undefined) {
            qp[k] = String(example.queryParams[k]);
            from.push(`query_params.${k}`);
        }
    }
    const u = new URL(c.item.resource);
    for (const [k, v] of Object.entries(qp))
        u.searchParams.set(k, v);
    return {
        url: u.toString(),
        method,
        body,
        input_used: { query_params: Object.keys(qp).length ? qp : undefined, body, from_bazaar_example: from },
    };
}
/**
 * One line for the user when the input came from the Bazaar example, e.g.
 * 'Buying with these conditions (the API's example; you did not choose them): chains=["ethereum","solana"], filters={...}'.
 */
export function exampleConditions(choice) {
    const from = choice.input_used.from_bazaar_example;
    if (!from.length)
        return null;
    const parts = [];
    if (from.includes("body") && choice.body && typeof choice.body === "object" && !Array.isArray(choice.body)) {
        for (const [k, v] of Object.entries(choice.body))
            parts.push(`${k}=${JSON.stringify(v)}`);
    }
    else if (from.includes("body")) {
        parts.push(`body=${JSON.stringify(choice.body)}`);
    }
    for (const f of from.filter((x) => x.startsWith("query_params."))) {
        const k = f.slice("query_params.".length);
        parts.push(`${k}=${choice.input_used.query_params?.[k]}`);
    }
    let line = parts.join(", ");
    if (line.length > 400)
        line = line.slice(0, 399) + "…";
    return `Buying with these conditions (the API's example; you did not choose them): ${line}`;
}
export function describeCandidate(c) {
    return {
        resource: c.item.resource,
        service: c.item.serviceName,
        description: c.item.description ? String(c.item.description).slice(0, 200) : undefined,
        price_usd: formatMicros(c.cheapest.priceMicros),
        network: c.cheapest.network,
        method: c.item.extensions?.bazaar?.info?.input?.method,
        calls_30d: c.calls30d,
        seller_probe: c.probe,
    };
}
