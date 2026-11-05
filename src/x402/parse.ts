import { atomicToMicros, chainInfo, formatMicros, knownUsdAsset, normalizeNetwork } from "../chains.js";

/** A single entry of `accepts`, normalized across x402 v1 / v2 / Nevermined. */
export interface Requirement {
  index: number;
  scheme: string;
  network: string;
  amount?: string;
  asset?: string;
  payTo?: string;
  maxTimeoutSeconds?: number;
  extra: Record<string, unknown>;
  /** Present for Nevermined schemes. */
  planId?: string;
  agentId?: string;
  /** USD price in micro-USD when the asset is a known stablecoin. */
  priceMicros?: bigint;
  /** The untouched entry from the seller, passed back when paying. */
  raw: Record<string, unknown>;
}

export interface ParsedPaymentRequired {
  x402Version: number;
  error?: string;
  resource?: { url?: string; description?: string; mimeType?: string; [k: string]: unknown };
  accepts: Requirement[];
  /** The untouched PaymentRequired object (needed to build the payment payload). */
  raw: Record<string, unknown>;
  source: "header" | "body";
}

function decodeBase64Json(value: string): unknown {
  return JSON.parse(Buffer.from(value.trim(), "base64").toString("utf8"));
}

function normalizeRequirement(raw: Record<string, unknown>, index: number, version: number): Requirement {
  const extra = (raw.extra && typeof raw.extra === "object" ? raw.extra : {}) as Record<string, unknown>;
  const network = normalizeNetwork(String(raw.network ?? ""));
  // v1 used maxAmountRequired, v2 uses amount
  const amountRaw = version === 1 ? (raw.maxAmountRequired ?? raw.amount) : (raw.amount ?? raw.maxAmountRequired);
  const amount = amountRaw === undefined || amountRaw === null ? undefined : String(amountRaw);
  const asset = raw.asset === undefined ? undefined : String(raw.asset);
  const req: Requirement = {
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
  if (planId !== undefined) req.planId = String(planId);
  if (agentId !== undefined) req.agentId = String(agentId);

  if (amount && asset && /^\d+$/.test(amount)) {
    const known = knownUsdAsset(network, asset);
    if (known) req.priceMicros = atomicToMicros(BigInt(amount), known.decimals);
  }
  return req;
}

function fromObject(obj: unknown, source: "header" | "body"): ParsedPaymentRequired | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const o = obj as Record<string, unknown>;
  if (!Array.isArray(o.accepts)) return undefined;
  const version = typeof o.x402Version === "number" ? o.x402Version : source === "header" ? 2 : 1;
  return {
    x402Version: version,
    error: typeof o.error === "string" ? o.error : undefined,
    resource: (o.resource && typeof o.resource === "object" ? o.resource : undefined) as ParsedPaymentRequired["resource"],
    accepts: (o.accepts as Record<string, unknown>[]).map((a, i) => normalizeRequirement(a, i, version)),
    raw: o,
    source,
  };
}

/**
 * Parses a 402 response. x402 v2 puts the PaymentRequired object in the
 * base64 `PAYMENT-REQUIRED` header; v1 (and some servers) put it in the JSON
 * body. Returns undefined if neither is present.
 */
export function parsePaymentRequired(
  getHeader: (name: string) => string | null | undefined,
  bodyText: string | undefined,
): ParsedPaymentRequired | undefined {
  const header = getHeader("payment-required");
  if (header) {
    try {
      const parsed = fromObject(decodeBase64Json(header), "header");
      if (parsed) return parsed;
    } catch {
      // fall through to the body
    }
  }
  if (bodyText) {
    try {
      return fromObject(JSON.parse(bodyText), "body");
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Settlement receipt from PAYMENT-RESPONSE (v2) or X-PAYMENT-RESPONSE (v1). */
export function parseSettleResponse(
  getHeader: (name: string) => string | null | undefined,
): Record<string, unknown> | undefined {
  const header = getHeader("payment-response") ?? getHeader("x-payment-response");
  if (!header) return undefined;
  try {
    const decoded = decodeBase64Json(header);
    return decoded && typeof decoded === "object" ? (decoded as Record<string, unknown>) : undefined;
  } catch {
    return { raw: header };
  }
}

/** Is the 402 an MPP challenge (`WWW-Authenticate: Payment ...`) rather than x402? */
export function isMppChallenge(getHeader: (name: string) => string | null | undefined): boolean {
  return /^\s*payment\b/i.test(getHeader("www-authenticate") ?? "");
}

/** Human/agent-friendly view of one requirement. */
export function describeRequirement(r: Requirement) {
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
