/**
 * private_price_match / private_quote_auction.
 *
 * The buyer's per-call limit (config.json `perCallMaxUsd`) is the cap. It is
 * read here, encrypted to the Arcium MXE in `MxeOps`, and compared there with
 * the seller's sealed floor (price match) or the sellers' sealed quotes (quote
 * auction). It never appears in a tool argument, a tool result, an error, the
 * payment log or stderr — the model driving the agent never sees it. The only
 * thing the outcome says about it is what any purchase says: that the price
 * paid was within it.
 *
 * The seller's side is kato9292929/x402-private-pricing: its 402 carries
 * `accepts[i].extra.arcium`, and after the MXE has revealed a result the same
 * offer id gets a 402 at exactly that price. Payment then goes through
 * make_x402_request's own path (limits, signing, receipt, payments.jsonl).
 */
import { formatMicros, parseUsdToMicros } from "../chains.js";
import type { SpendConfig } from "../config.js";
import type { SpendGuard } from "../limits.js";
import type { WalletProvider } from "../providers/types.js";
import type { MxeOps, MxeRun } from "../arcium/mxe.js";
import type { Requirement } from "./parse.js";
import { PaymentError, type X402Requester } from "./request.js";

export interface PrivateDeps {
  requester: X402Requester;
  guard: SpendGuard;
  provider: WalletProvider | null;
  loadConfig: () => Promise<SpendConfig>;
  mxe: () => MxeOps;
  fetch?: typeof fetch;
  /** RFQ length in seconds; default max(60, 30 × sellers). */
  rfqDurationSec?: number;
}

interface ArciumExtra {
  programId: string;
  mode: "price_match" | "rfq";
  offerId: string;
  negotiation?: string;
  seller: string;
}

const arciumOf = (r: Requirement): ArciumExtra | undefined => {
  const a = (r.extra as { arcium?: unknown }).arcium;
  return a && typeof a === "object" ? (a as ArciumExtra) : undefined;
};

const mxeView = (r: MxeRun) => ({
  circuit: r.circuit,
  latencyMs: r.latencyMs,
  lamports: r.lamports,
  baseFeeLamports: r.baseFeeLamports,
  queueTx: r.queueTx,
  finalizeTx: r.finalizeTx,
});

export class PrivatePricer {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly deps: PrivateDeps) {
    this.fetchImpl = deps.fetch ?? fetch;
  }

  /** Wallet and network the private tools run on; the cap as micro-USD. */
  private async preflight(): Promise<{ cfg: SpendConfig; capMicros: bigint }> {
    const cfg = await this.deps.loadConfig();
    const id = this.deps.provider?.id;
    if (id !== "cdp" && id !== "privy") {
      throw new PaymentError("Private pricing needs WALLET_PROVIDER=cdp or privy (a wallet that pays on Solana).");
    }
    if (cfg.network !== "testnet") {
      throw new PaymentError('Private pricing runs on Solana devnet only: config.json must have network="testnet".');
    }
    return { cfg, capMicros: parseUsdToMicros(cfg.perCallMaxUsd) };
  }

  /** The 402's MXE-negotiable requirement, if the seller offers one. */
  private async negotiable(url: string, mode: ArciumExtra["mode"]) {
    const probe = await this.deps.requester.probe({ url });
    if (probe.status !== 402 || !probe.paymentRequired) return { probe };
    const mxe = this.deps.mxe();
    for (const r of probe.paymentRequired.accepts) {
      const a = arciumOf(r);
      if (!a || a.mode !== mode) continue;
      if (a.programId !== mxe.programId) {
        throw new PaymentError(`The seller negotiates on another MXE program (${a.programId}); this wallet is set up for ${mxe.programId}.`);
      }
      if (!/^\d{1,20}$/.test(String(a.offerId))) throw new PaymentError("The seller's offer id is malformed.");
      return { probe, requirement: r, arcium: a, mxe };
    }
    return { probe };
  }

  async priceMatch(url: string) {
    const { cfg, capMicros } = await this.preflight();
    this.deps.guard.checkHost(cfg, url);
    const n = await this.negotiable(url, "price_match");
    if (!n.arcium) {
      // No sealed negotiation offered: the same as make_x402_request.
      const r = await this.deps.requester.request({ url });
      return { negotiated: false, note: "The seller offers no sealed price match; handled as make_x402_request.", ...r };
    }
    if (!n.arcium.negotiation) throw new PaymentError("The seller's offer names no sealed floor (negotiation account).");

    const offerId = n.arcium.offerId;
    const m = await n.mxe.matchCeiling(n.arcium.negotiation, BigInt(offerId), capMicros);
    const mxe = { programId: n.mxe.programId, matchRequest: m.matchRequest, match: mxeView(m.run) };
    if (!m.matched) {
      await n.mxe.closeMatchRequest(m.matchRequest).catch(() => undefined);
      return { negotiated: true, matched: false, offerId, paid: false, mxe, note: "No match: nothing was paid." };
    }

    const paid = await this.deps.requester.request(
      { url, headers: { "x-arcium-offer": offerId } },
      {
        expect: { priceMicros: m.priceMicros, offerId },
        logExtra: { pricing: "private_price_match", offerId, matchRequest: m.matchRequest },
      },
    );
    await n.mxe.closeMatchRequest(m.matchRequest).catch(() => undefined);
    return { negotiated: true, matched: true, priceUsd: formatMicros(m.priceMicros), offerId, mxe, ...paid };
  }

  async quoteAuction(urls: string[]) {
    if (urls.length < 3) throw new PaymentError("A quote auction needs at least 3 seller URLs.");
    const { cfg, capMicros } = await this.preflight();
    for (const u of urls) this.deps.guard.checkHost(cfg, u);

    const sellers: { url: string; offerId: string; seller: string }[] = [];
    let mxeOps: MxeOps | undefined;
    for (const url of urls) {
      const n = await this.negotiable(url, "rfq");
      if (!n.arcium) throw new PaymentError(`${url} does not offer a sealed quote (no rfq offer in its 402).`);
      sellers.push({ url, offerId: n.arcium.offerId, seller: n.arcium.seller });
      mxeOps = n.mxe;
    }
    const mxe = mxeOps!;

    const duration = this.deps.rfqDurationSec ?? Math.max(60, 30 * sellers.length);
    const opened = await mxe.createRfq(capMicros, duration);

    // Each seller signs and pays for its own sealed quote; one at a time, as
    // the program folds them in serially.
    const quotes: { url: string; quoted: boolean; error?: string }[] = [];
    for (const s of sellers) {
      try {
        const res = await this.fetchImpl(s.url, { headers: { "x-arcium-offer": s.offerId, "x-arcium-rfq": opened.rfq } });
        const body = await res.text();
        quotes.push(res.status === 202 ? { url: s.url, quoted: true } : { url: s.url, quoted: false, error: `HTTP ${res.status}: ${body.slice(0, 200)}` });
      } catch (err) {
        quotes.push({ url: s.url, quoted: false, error: (err as Error).message });
      }
    }

    const award = await mxe.closeAndAward(opened.rfq);
    const view = {
      programId: mxe.programId,
      rfq: opened.rfq,
      quoteCount: award.quoteCount,
      open: mxeView(opened.run),
      award: mxeView(award.run),
    };
    if (!award.awarded) {
      return { awarded: false, winner: null, quotes, paid: false, mxe: view, note: "No quote was within the limit: nothing was paid." };
    }
    const winner = sellers.find((s) => s.seller === award.winner);
    if (!winner) throw new PaymentError("The award went to a seller that is not one of the requested URLs. Nothing was paid.", { rfq: opened.rfq });

    const paid = await this.deps.requester.request(
      { url: winner.url, headers: { "x-arcium-offer": winner.offerId, "x-arcium-rfq": opened.rfq } },
      {
        expect: { priceMicros: award.priceMicros, offerId: winner.offerId },
        logExtra: { pricing: "private_quote_auction", offerId: winner.offerId, rfq: opened.rfq },
      },
    );
    return { awarded: true, winner: winner.url, priceUsd: formatMicros(award.priceMicros), quotes, mxe: view, ...paid };
  }
}
