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
/** Bazaar results this wallet can pay (an exact option on one of `networks` within the price cap), best match first. */
export async function findCandidates(args, networks, capMicros, fetchImpl) {
    const items = await searchBazaar(args.query, fetchImpl);
    const tokens = queryTokens(args.query);
    const out = [];
    items.forEach((item, rank) => {
        if (/\/:[a-z]|[{}]/i.test(item.resource))
            return; // a path template, not a URL that can be called
        const payable = bazaarAccepts(item)
            .filter((r) => r.scheme === "exact" && networks.includes(r.network) && r.priceMicros !== undefined && r.priceMicros <= capMicros)
            .sort((a, b) => (a.priceMicros < b.priceMicros ? -1 : a.priceMicros > b.priceMicros ? 1 : 0));
        if (!payable.length)
            return;
        out.push({ item, score: matchScore(tokens, item), rank, cheapest: payable[0] });
    });
    return out.sort((a, b) => b.score - a.score || a.rank - b.rank);
}
/** The best candidate, or null when the top ones match equally well (or nothing matches). */
export function decide(candidates) {
    const [top, next] = candidates;
    if (!top || top.score === 0)
        return null;
    if (next && next.score === top.score)
        return null;
    return top;
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
    };
}
