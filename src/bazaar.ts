import { normalizeNetwork } from "./chains.js";
import { describeRequirement, type Requirement } from "./x402/parse.js";
import { parsePaymentRequired } from "./x402/parse.js";

/** CDP Bazaar public discovery API (no authentication). */
export const BAZAAR_BASE =
  process.env.BAZAAR_BASE_URL?.replace(/\/$/, "") || "https://api.cdp.coinbase.com/platform/v2/x402/discovery";

export interface BazaarItem {
  resource: string;
  type?: string;
  x402Version?: number;
  description?: string;
  serviceName?: string;
  tags?: string[];
  accepts?: Record<string, unknown>[];
  extensions?: Record<string, unknown>;
  quality?: Record<string, unknown>;
  lastUpdated?: string;
  [k: string]: unknown;
}

export interface ListParams {
  query?: string;
  network?: string;
  maxUsdPrice?: string;
  limit?: number;
  offset?: number;
}

async function getJson(url: string, fetchImpl: typeof fetch): Promise<Record<string, unknown>> {
  const res = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Bazaar API ${res.status}: ${(await res.text()).slice(0, 500)}`);
  return (await res.json()) as Record<string, unknown>;
}

function acceptsOf(item: BazaarItem): Requirement[] {
  // Reuse the 402 normalizer so prices are computed the same way.
  const fake = { x402Version: item.x402Version ?? 2, accepts: item.accepts ?? [] };
  return parsePaymentRequired(() => undefined, JSON.stringify(fake))?.accepts ?? [];
}

function httpMethod(item: BazaarItem): string | undefined {
  const bazaar = (item.extensions as { bazaar?: { info?: { input?: { method?: string } } } } | undefined)?.bazaar;
  return bazaar?.info?.input?.method;
}

export function summarizeItem(item: BazaarItem) {
  return {
    resource: item.resource,
    serviceName: item.serviceName,
    description: item.description,
    method: httpMethod(item),
    tags: item.tags,
    accepts: acceptsOf(item).map((r) => {
      const d = describeRequirement(r);
      return { scheme: d.scheme, network: d.network, chain: d.chain, testnet: d.testnet, priceUsd: d.priceUsd, amount: d.priceUsd ? undefined : d.amount, asset: d.priceUsd ? undefined : d.asset };
    }),
    calls30d: (item.quality as { l30DaysTotalCalls?: number } | undefined)?.l30DaysTotalCalls,
  };
}

export async function listBazaarResources(params: ListParams, fetchImpl: typeof fetch = fetch) {
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
  const qs = new URLSearchParams();
  let url: string;
  if (params.query || params.network || params.maxUsdPrice) {
    // The search endpoint supports filters; it needs a query, so fall back to a broad one.
    qs.set("query", params.query || "api");
    if (params.network) qs.set("network", normalizeNetwork(params.network));
    if (params.maxUsdPrice) qs.set("maxUsdPrice", params.maxUsdPrice);
    qs.set("limit", String(Math.min(limit, 20)));
    url = `${BAZAAR_BASE}/search?${qs}`;
  } else {
    qs.set("limit", String(limit));
    qs.set("offset", String(params.offset ?? 0));
    url = `${BAZAAR_BASE}/resources?${qs}`;
  }
  const json = await getJson(url, fetchImpl);
  const items = ((json.items ?? json.resources ?? []) as BazaarItem[]).map(summarizeItem);
  return {
    source: url,
    count: items.length,
    pagination: json.pagination,
    partialResults: json.partialResults,
    items,
  };
}

/**
 * Full Bazaar record for one resource URL (accepts, price, description,
 * input/output schema). Falls back to probing the URL itself when the
 * resource is not indexed.
 */
export async function getResourceDetails(resource: string, fetchImpl: typeof fetch = fetch) {
  const qs = new URLSearchParams({ query: resource, urlSubstring: resource, limit: "20" });
  const json = await getJson(`${BAZAAR_BASE}/search?${qs}`, fetchImpl);
  const items = (json.resources ?? json.items ?? []) as BazaarItem[];
  const norm = (u: string) => u.replace(/\/+$/, "").toLowerCase();
  const match = items.find((i) => norm(i.resource) === norm(resource)) ?? (items.length === 1 ? items[0] : undefined);
  if (match) {
    return {
      found: true,
      source: "bazaar",
      ...summarizeItem(match),
      accepts: acceptsOf(match).map(describeRequirement),
      extensions: match.extensions,
      quality: match.quality,
      lastUpdated: match.lastUpdated,
      x402Version: match.x402Version,
    };
  }
  return {
    found: false,
    note: "Not indexed in the Bazaar. Use check_payment_requirements to read the price straight from the endpoint.",
    similar: items.slice(0, 5).map((i) => i.resource),
  };
}
