/**
 * buy_data: from a short description of the data ("nansen smart money netflow") to an approval link in
 * one call. Searches the Bazaar, picks the best-matching endpoint this wallet can pay, fills its input
 * from the Bazaar's example when the user gave none, then runs the normal pre-payment checks. When the
 * best match is not clear, nothing is prepared and the top candidates are returned for Claude to choose.
 */
import { bazaarAccepts, searchBazaar, type BazaarItem } from "./bazaar.js";
import { formatMicros } from "./chains.js";
import type { Requirement } from "./x402/parse.js";

export interface BuyDataArgs {
  query: string;
  method?: string;
  body?: unknown;
  query_params?: Record<string, string>;
  max_price_usd?: string;
}

const STOP = new Set(["the", "a", "an", "of", "for", "to", "and", "or", "in", "on", "with", "data", "api", "get", "buy", "x402", "me", "my", "latest", "please"]);
const ALIASES: Record<string, string[]> = { btc: ["bitcoin"], bitcoin: ["btc"], eth: ["ethereum"], ethereum: ["eth"], sol: ["solana"], solana: ["sol"], sec: ["edgar"] };

export function queryTokens(q: string): string[] {
  return [...new Set(q.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2 && !STOP.has(t)))];
}

/** How many of the query's words (or their aliases) the endpoint's URL, name or description contains. */
export function matchScore(tokens: string[], item: BazaarItem): number {
  const text = `${item.resource} ${item.serviceName ?? ""} ${String(item.description ?? "").slice(0, 400)}`.toLowerCase();
  return tokens.filter((t) => text.includes(t) || (ALIASES[t] ?? []).some((a) => text.includes(a))).length;
}

interface Input {
  method?: string;
  body?: unknown;
  queryParams?: Record<string, unknown>;
}

function bazaarInput(item: BazaarItem): { example: Input; requiredQuery: string[] } {
  const ext = (item.extensions ?? {}) as any;
  const example: Input = ext?.bazaar?.info?.input ?? {};
  const required: string[] = ext?.bazaar?.schema?.properties?.input?.properties?.queryParams?.required ?? [];
  return { example, requiredQuery: Array.isArray(required) ? required : [] };
}

export interface Candidate {
  item: BazaarItem;
  score: number;
  rank: number;
  cheapest: Requirement;
}

export interface Choice {
  url: string;
  method: string;
  body?: unknown;
  input_used: { query_params?: Record<string, string>; body?: unknown; from_bazaar_example: string[] };
}

/** Bazaar results this wallet can pay (an exact option on one of `networks` within the price cap), best match first. */
export async function findCandidates(args: BuyDataArgs, networks: string[], capMicros: bigint, fetchImpl?: typeof fetch): Promise<Candidate[]> {
  const items = await searchBazaar(args.query, fetchImpl);
  const tokens = queryTokens(args.query);
  const out: Candidate[] = [];
  items.forEach((item, rank) => {
    if (/\/:[a-z]|[{}]/i.test(item.resource)) return; // a path template, not a URL that can be called
    const payable = bazaarAccepts(item)
      .filter((r) => r.scheme === "exact" && networks.includes(r.network) && r.priceMicros !== undefined && r.priceMicros <= capMicros)
      .sort((a, b) => (a.priceMicros! < b.priceMicros! ? -1 : a.priceMicros! > b.priceMicros! ? 1 : 0));
    if (!payable.length) return;
    out.push({ item, score: matchScore(tokens, item), rank, cheapest: payable[0] });
  });
  return out.sort((a, b) => b.score - a.score || a.rank - b.rank);
}

/** The best candidate, or null when the top ones match equally well (or nothing matches). */
export function decide(candidates: Candidate[]): Candidate | null {
  const [top, next] = candidates;
  if (!top || top.score === 0) return null;
  if (next && next.score === top.score) return null;
  return top;
}

/** The request to send: the user's input first, then the Bazaar's example for what is required and missing. */
export function requestFor(c: Candidate, args: BuyDataArgs): Choice {
  const { example, requiredQuery } = bazaarInput(c.item);
  const from: string[] = [];
  const method = (args.method ?? example.method ?? "GET").toUpperCase();
  let body = args.body;
  if (body === undefined && method !== "GET" && method !== "HEAD" && example.body !== undefined) {
    body = example.body;
    from.push("body");
  }
  const qp: Record<string, string> = { ...(args.query_params ?? {}) };
  for (const k of requiredQuery) {
    if (qp[k] === undefined && example.queryParams?.[k] !== undefined) {
      qp[k] = String(example.queryParams[k]);
      from.push(`query_params.${k}`);
    }
  }
  const u = new URL(c.item.resource);
  for (const [k, v] of Object.entries(qp)) u.searchParams.set(k, v);
  return {
    url: u.toString(),
    method,
    body,
    input_used: { query_params: Object.keys(qp).length ? qp : undefined, body, from_bazaar_example: from },
  };
}

export function describeCandidate(c: Candidate) {
  return {
    resource: c.item.resource,
    service: c.item.serviceName,
    description: c.item.description ? String(c.item.description).slice(0, 200) : undefined,
    price_usd: formatMicros(c.cheapest.priceMicros!),
    network: c.cheapest.network,
    method: (c.item.extensions as any)?.bazaar?.info?.input?.method,
  };
}
