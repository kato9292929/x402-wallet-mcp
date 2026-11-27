/**
 * buy_data: from a short description of the data ("nansen smart money netflow") to an approval link in
 * one call. Searches the Bazaar, picks the best-matching endpoint this wallet can pay, then runs the normal
 * pre-payment checks. Input the endpoint requires is never filled silently: when the user's request does not
 * give it, nothing is prepared and the fields are returned for Claude to fill from the user's words (or the
 * Bazaar's example, only if the user accepts it). When the best match is not clear, the top candidates are
 * returned for Claude to choose.
 */
import { bazaarAccepts, searchBazaar } from "./bazaar.js";
import { formatMicros } from "./chains.js";
const STOP = new Set(["the", "a", "an", "of", "for", "to", "and", "or", "in", "on", "with", "data", "api", "get", "buy", "x402", "me", "my", "latest", "please"]);
const ALIASES = { btc: ["bitcoin"], bitcoin: ["btc"], eth: ["ethereum"], ethereum: ["eth"], sol: ["solana"], solana: ["sol"], sec: ["edgar"] };
/** Common Japanese words for kinds of data, read as English keywords (the Bazaar's descriptions are in English). */
const JA = [
    ["株価", ["stock", "price"]],
    ["価格", ["price"]],
    ["値段", ["price"]],
    ["相場", ["price"]],
    ["提出書類", ["filing", "filings"]],
    ["開示", ["filing"]],
    ["決算", ["earnings"]],
    ["天気", ["weather"]],
    ["天候", ["weather"]],
    ["ニュース", ["news"]],
    ["為替", ["fx", "exchange", "rate"]],
    ["保有者", ["holders"]],
    ["ホルダー", ["holders"]],
    ["残高", ["balance"]],
    ["検索", ["search"]],
];
export function queryTokens(q) {
    const words = q.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2 && !STOP.has(t));
    for (const [ja, en] of JA)
        if (q.includes(ja))
            words.push(...en);
    return [...new Set(words)];
}
/** The text to search the Bazaar with: the query's keywords (with Japanese words read as English), or the query itself. */
export function searchText(q) {
    const t = queryTokens(q);
    return t.length ? t.join(" ") : q;
}
const itemText = (item) => `${item.resource} ${item.serviceName ?? ""} ${String(item.description ?? "").slice(0, 400)}`.toLowerCase();
const mentions = (text, t) => text.includes(t) || (ALIASES[t] ?? []).some((a) => text.includes(a));
/** How many of the query's words (or their aliases) the endpoint's URL, name or description contains. */
export function matchScore(tokens, item) {
    const text = itemText(item);
    return tokens.filter((t) => mentions(text, t)).length;
}
/**
 * Words the user typed (not the Japanese readings) that the chosen endpoint does not mention, e.g. "msft" for a
 * generic SEC filings API: a specific value the request is about, which has to go into the input.
 */
export function unmatchedWords(query, item) {
    const text = itemText(item);
    const typed = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2 && !STOP.has(t));
    return [...new Set(typed.filter((t) => !mentions(text, t)))];
}
function bazaarInput(item) {
    const ext = (item.extensions ?? {});
    const example = ext?.bazaar?.info?.input ?? {};
    const props = ext?.bazaar?.schema?.properties?.input?.properties ?? {};
    const rq = props?.queryParams?.required;
    const rb = props?.body?.required;
    return {
        example,
        requiredQuery: Array.isArray(rq) ? rq : [],
        requiredBody: Array.isArray(rb) ? rb : null,
        bodyProps: props?.body?.properties ?? {},
        queryProps: props?.queryParams?.properties ?? {},
    };
}
/**
 * Bazaar results this wallet can pay (an exact option on one of `networks` within the price cap), best match first.
 * `networks` is in the wallet's order of preference, used when a seller asks the same price on several.
 */
export async function findCandidates(args, networks, capMicros, fetchImpl) {
    const items = await searchBazaar(searchText(args.query), fetchImpl);
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
/** Seller Probe outcomes that rule a seller out: its latest paid purchase failed or was refused. */
export const BAD_PROBE = new Set(["not_delivered", "request_rejected", "failed", "overcharged", "invalid_target"]);
/** Order among equally good matches: paid through AgentPay before, then calls in the last 30 days, then Probe score. */
const byRecord = (a, b) => Number(!!b.succeeded) - Number(!!a.succeeded) || b.calls30d - a.calls30d || (b.probeScore ?? -1) - (a.probeScore ?? -1);
/**
 * Looks up Seller Probe for the five best matches and drops sellers whose latest paid purchase failed or was
 * refused (BAD_PROBE). Among equally good matches, puts first: a seller paid successfully before, then more calls
 * in the last 30 days, then a higher Probe score, then the Bazaar's order.
 */
export async function rankByRecord(candidates, probe, succeeded = () => false) {
    if ((candidates[0]?.score ?? 0) === 0)
        return candidates;
    const head = candidates.slice(0, 5);
    await Promise.all(head.map(async (c) => {
        c.succeeded = succeeded(new URL(c.item.resource).hostname);
        try {
            const p = await probe(c.item.resource);
            c.probe = p.status === "scored" ? (p.verdict ?? "scored") : p.status;
            if (p.status === "scored" && typeof p.score === "number")
                c.probeScore = p.score;
        }
        catch {
            c.probe = "unavailable";
        }
    }));
    return [...head.filter((c) => !BAD_PROBE.has(c.probe ?? "")), ...candidates.slice(5)].sort((a, b) => b.score - a.score || byRecord(a, b) || a.rank - b.rank);
}
/**
 * The best candidate, or null when nothing matches or the top ones cannot be told apart: the same match,
 * no difference in payments through AgentPay, calls in the last 30 days or Probe score.
 */
export function decide(candidates) {
    const [top, next] = candidates;
    if (!top || top.score === 0)
        return null;
    if (!next || next.score < top.score)
        return top;
    return byRecord(top, next) < 0 ? top : null;
}
const desc = (p) => (p?.description ? String(p.description).slice(0, 200) : undefined);
/**
 * The request to send, from the user's input. Required input the user did not give is listed in `needs`
 * (with the Bazaar's example as a suggestion) and left empty, unless use_example: then only the required
 * fields are taken from the example (optional fields such as narrowing filters are not added).
 */
export function requestFor(c, args) {
    const spec = bazaarInput(c.item);
    const { example } = spec;
    const from = [];
    const needs = [];
    const method = (args.method ?? example.method ?? "GET").toUpperCase();
    const hasBody = method !== "GET" && method !== "HEAD";
    let body = args.body;
    if (hasBody) {
        const ex = example.body && typeof example.body === "object" && !Array.isArray(example.body) ? example.body : null;
        if (spec.requiredBody) {
            const given = body && typeof body === "object" && !Array.isArray(body) ? body : body === undefined ? {} : null;
            if (given) {
                const filled = { ...given };
                for (const k of spec.requiredBody) {
                    if (filled[k] !== undefined)
                        continue;
                    needs.push({ field: `body.${k}`, description: desc(spec.bodyProps[k]), example: ex?.[k] });
                    if (args.use_example && ex?.[k] !== undefined) {
                        filled[k] = ex[k];
                        from.push(`body.${k}`);
                    }
                }
                body = Object.keys(filled).length || body !== undefined ? filled : undefined;
            }
        }
        else if (body === undefined && example.body !== undefined) {
            needs.push({ field: "body", example: example.body });
            if (args.use_example) {
                body = example.body;
                from.push("body");
            }
        }
    }
    const qp = { ...(args.query_params ?? {}) };
    for (const k of spec.requiredQuery) {
        if (qp[k] !== undefined)
            continue;
        needs.push({ field: `query_params.${k}`, description: desc(spec.queryProps[k]), example: example.queryParams?.[k] });
        if (args.use_example && example.queryParams?.[k] !== undefined) {
            qp[k] = String(example.queryParams[k]);
            from.push(`query_params.${k}`);
        }
    }
    const optional = [];
    for (const [k, p] of Object.entries(spec.queryProps)) {
        if (qp[k] === undefined && !spec.requiredQuery.includes(k))
            optional.push({ field: `query_params.${k}`, description: desc(p), example: example.queryParams?.[k] });
    }
    if (hasBody) {
        const given = body && typeof body === "object" && !Array.isArray(body) ? body : {};
        for (const [k, p] of Object.entries(spec.bodyProps)) {
            if (given[k] === undefined && !(spec.requiredBody ?? []).includes(k))
                optional.push({ field: `body.${k}`, description: desc(p) });
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
        needs: args.use_example ? [] : needs,
        optional,
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
    const body = (choice.body && typeof choice.body === "object" && !Array.isArray(choice.body) ? choice.body : {});
    for (const f of from) {
        if (f === "body")
            parts.push(`body=${JSON.stringify(choice.body)}`);
        else if (f.startsWith("body."))
            parts.push(`${f.slice(5)}=${JSON.stringify(body[f.slice(5)])}`);
        else if (f.startsWith("query_params."))
            parts.push(`${f.slice(13)}=${choice.input_used.query_params?.[f.slice(13)]}`);
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
        probe_score: c.probeScore,
        paid_before: c.succeeded || undefined,
    };
}
