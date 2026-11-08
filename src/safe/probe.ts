/**
 * Seller Probe (probe.x402jp.com): the public record of a seller host, read before paying.
 *
 *   scored       the Probe has a record; `verdict` is its latest paid measurement's outcome
 *   unscored     404: the Probe has never measured the host (not a reason to stop)
 *   unavailable  the Probe did not answer (not a reason to stop)
 *
 * Ported from kato9292929/RFQ lib/probe.ts (0943124); the verdict comes from the Probe's own
 * `last_paid.outcome` (kato9292929/seller-probe README "API", 8bc93ed).
 */
export const PROBE_URL = () => (process.env.PROBE_URL || "https://probe.x402jp.com").replace(/\/$/, "");

/** Same host key as the Probe: lowercase hostname, no port, no leading "www.". */
export function probeHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

export type ProbeVerdict =
  | "delivered"
  | "not_delivered"
  | "request_rejected"
  | "delivered_unsettled"
  | "failed"
  | "overcharged"
  | "invalid_target";

export interface ProbeLastPaid {
  ts: string;
  outcome: ProbeVerdict;
  network: string | null;
  amount: string | null;
  price_usd: number | null;
}

export type ProbeLookup =
  | {
      status: "scored";
      host: string;
      score: number | null;
      verdict: ProbeVerdict | null;
      last_paid: ProbeLastPaid | null;
      buyable_without_input: boolean | null;
      requires_input_reason: string | null;
      receipt_advertised: boolean | null;
      catalog_price_usd: number | null;
    }
  | { status: "unscored"; host: string }
  | { status: "unavailable"; host: string | null; error: string };

export async function lookupProbe(url: string, fetchImpl: typeof fetch = fetch, timeoutMs = 5000): Promise<ProbeLookup> {
  const host = probeHost(url);
  if (!host) return { status: "unavailable", host: null, error: `cannot parse host of ${url}` };
  try {
    const r = await fetchImpl(`${PROBE_URL()}/scores/${encodeURIComponent(host)}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (r.status === 404) return { status: "unscored", host };
    if (!r.ok) return { status: "unavailable", host, error: `HTTP ${r.status}` };
    const d: any = await r.json();
    const lp = d?.last_paid;
    const last_paid: ProbeLastPaid | null =
      lp && typeof lp.outcome === "string"
        ? {
            ts: String(lp.ts ?? lp.date ?? ""),
            outcome: lp.outcome,
            network: lp.network ?? null,
            amount: lp.amount ?? null,
            price_usd: typeof lp.price_usd === "number" ? lp.price_usd : null,
          }
        : null;
    const rir = d?.requires_input_reason;
    return {
      status: "scored",
      host,
      score: typeof d?.score === "number" ? d.score : null,
      verdict: last_paid?.outcome ?? null,
      last_paid,
      buyable_without_input: typeof d?.buyable_without_input === "boolean" ? d.buyable_without_input : null,
      requires_input_reason: rir ? String(rir.reason ?? rir) : null,
      receipt_advertised: typeof d?.receipt?.advertised === "boolean" ? d.receipt.advertised : null,
      catalog_price_usd: typeof d?.catalog?.price_usd === "number" ? d.catalog.price_usd : null,
    };
  } catch (e: any) {
    return { status: "unavailable", host, error: e?.name === "TimeoutError" ? "timeout" : String(e?.message ?? e) };
  }
}

/** The compact form returned to the agent: verdict + score, "unscored" or "unavailable". */
export function probeSummary(l: ProbeLookup | null): Record<string, unknown> | string | null {
  if (!l) return null;
  if (l.status === "unscored") return "unscored";
  if (l.status === "unavailable") return "unavailable";
  return {
    verdict: l.verdict,
    score: l.score,
    last_paid_at: l.last_paid?.ts ?? null,
    buyable_without_input: l.buyable_without_input,
    requires_input_reason: l.requires_input_reason,
  };
}

/** Fields the Probe's POST /reports accepts (seller-probe README "買い手からの報告"). */
export interface ProbeReport {
  host: string;
  url: string;
  network: string;
  amount: string;
  outcome: string;
  http_status: number;
  latency_ms: number;
  settled_header: boolean;
  onchain_found: boolean;
  receipt_ok: boolean | null;
  refetched: boolean;
  sdk: string;
  ts: string;
}

/** Sends an anonymous report. Never throws; the payment result does not depend on it. */
export async function reportToProbe(rep: ProbeReport, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const u = new URL(rep.url);
    const r = await fetchImpl(`${PROBE_URL()}/reports`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...rep, url: `${u.origin}${u.pathname}` }),
      signal: AbortSignal.timeout(5000),
    });
    return r.ok;
  } catch {
    return false;
  }
}
