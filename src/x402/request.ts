import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentRequired } from "@x402/core/types";
import { bazaarListedAmount } from "../bazaar.js";
import { chainInfo, formatMicros } from "../chains.js";
import { configDir, loadConfig, paymentLogPath, schemePriority, type SpendConfig } from "../config.js";
import { SpendGuard, SpendLimitError } from "../limits.js";
import { NeverminedPayer, neverminedConfigured, neverminedEnvironment } from "../nevermined.js";
import { buildX402Client, type WalletProvider } from "../providers/index.js";
import { findPayment as defaultFindPayment, payerKeyOf, type ChainResult, type FindOptions, type PayerKey } from "../safe/chain.js";
import { checkInput } from "../safe/input.js";
import { activeRefusals, readNetFailures, recordNetFailure, netFailuresPath } from "../safe/netfail.js";
import { lookupProbe, probeHost, probeSummary, reportToProbe, type ProbeLookup, type ProbeReport } from "../safe/probe.js";
import {
  RECEIPT_HEADER,
  WELL_KNOWN_PATH,
  parseWellKnown,
  refetch,
  verifyReceipt,
  type WellKnown,
} from "../safe/receipt-verify.js";
import {
  describeRequirement,
  isMppChallenge,
  parsePaymentRequired,
  parseSettleResponse,
  type ParsedPaymentRequired,
  type Requirement,
} from "./parse.js";
import { NVM_SCHEME, evaluate, selectRequirement, type SelectionContext } from "./select.js";

export interface HttpRequestInput {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | Record<string, unknown> | unknown[];
}

/** A signed exact-scheme payment: the headers to send and the payload they encode. */
export interface ExactPayment {
  headers: Record<string, string>;
  payload: Record<string, any>;
}

export interface Deps {
  provider: WalletProvider | null;
  guard: SpendGuard;
  nevermined?: NeverminedPayer;
  fetch?: typeof fetch;
  loadConfig?: () => Promise<SpendConfig>;
  /** Overrides how the exact-scheme payment is signed (tests). */
  createExactPayment?: (paymentRequired: Record<string, unknown>) => Promise<ExactPayment>;
  log?: (entry: Record<string, unknown>) => Promise<void>;
  /** Overrides the Seller Probe lookup (tests). */
  probe?: (url: string) => Promise<ProbeLookup>;
  /** Overrides the Bazaar price lookup: atomic amount listed for (url, network), or null if not listed. */
  bazaarPrice?: (url: string, network: string) => Promise<string | null>;
  /** Overrides the on-chain search (tests). */
  findPayment?: (k: PayerKey, headerTx: string | null) => Promise<ChainResult>;
  /** Options for the default on-chain search. */
  findOptions?: FindOptions;
  /** Where (host, network) refusals are remembered. */
  netFailuresFile?: string;
  report?: (r: ProbeReport) => Promise<boolean>;
}

const MAX_BODY_CHARS = 100_000;
const SDK_LABEL = "x402-wallet-mcp";

export class PaymentError extends Error {
  constructor(
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "PaymentError";
  }
}

export type BuyStatus = "fulfilled" | "not_delivered" | "recovered_by_retry" | "blocked" | "rejected_by_seller";
export type BlockedReason =
  | "probe_not_delivered"
  | "missing_input"
  | "over_cap"
  | "price_mismatch"
  | "network_avoided"
  | "host_not_allowed";

function buildInit(input: HttpRequestInput, extraHeaders: Record<string, string> = {}): RequestInit {
  const method = (input.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = { ...(input.headers ?? {}), ...extraHeaders };
  let body: string | undefined;
  if (input.body !== undefined && input.body !== null && method !== "GET" && method !== "HEAD") {
    if (typeof input.body === "string") {
      body = input.body;
    } else {
      body = JSON.stringify(input.body);
      if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
        headers["content-type"] = "application/json";
      }
    }
  }
  return { method, headers, body, redirect: "follow" };
}

interface BodyOut {
  contentType: string;
  body: string;
  truncated: boolean;
  encoding: "text" | "base64";
  body_sha256: string;
  bytes: Uint8Array;
}

function bodyFrom(bytes: Uint8Array, contentType: string): BodyOut {
  const textual = contentType === "" || /json|text|xml|javascript|html|csv|yaml|x-www-form-urlencoded/i.test(contentType);
  const s = textual ? Buffer.from(bytes).toString("utf8") : Buffer.from(bytes).toString("base64");
  return {
    contentType,
    body: s.length > MAX_BODY_CHARS ? s.slice(0, MAX_BODY_CHARS) : s,
    truncated: s.length > MAX_BODY_CHARS,
    encoding: textual ? "text" : "base64",
    body_sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes,
  };
}

async function readBody(res: Response): Promise<BodyOut> {
  return bodyFrom(new Uint8Array(await res.arrayBuffer()), res.headers.get("content-type") ?? "");
}

const publicBody = ({ bytes: _b, ...rest }: BodyOut) => rest;

async function defaultLog(entry: Record<string, unknown>): Promise<void> {
  try {
    await fs.mkdir(configDir(), { recursive: true, mode: 0o700 });
    await fs.appendFile(paymentLogPath(), JSON.stringify(entry) + "\n", { mode: 0o600 });
  } catch {
    // logging must never break a payment response
  }
  process.stderr.write(`[x402-wallet-mcp] payment ${JSON.stringify(entry)}\n`);
}

/** Only real chain hashes get an explorer link (Nevermined credit burns return ids like "tid-..."). */
function isOnchainTx(network: string, tx: string): boolean {
  const family = chainInfo(network)?.family;
  if (family === "evm") return /^0x[0-9a-fA-F]{64}$/.test(tx);
  if (family === "solana") return /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(tx);
  return false;
}

function headerTxOf(settle: Record<string, unknown> | undefined): string | null {
  const t = settle?.transaction ?? settle?.transactionHash;
  return typeof t === "string" && t ? t : null;
}

const bigintSafe = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

export class X402Requester {
  private exactClient?: Promise<x402Client>;
  private readonly fetchImpl: typeof fetch;
  private readonly loadCfg: () => Promise<SpendConfig>;
  private readonly log: (entry: Record<string, unknown>) => Promise<void>;
  private readonly wellKnownCache = new Map<string, Promise<WellKnown | null>>();

  constructor(private readonly deps: Deps) {
    this.fetchImpl = deps.fetch ?? fetch;
    this.loadCfg = deps.loadConfig ?? loadConfig;
    this.log = deps.log ?? defaultLog;
  }

  selectionContext(cfg: SpendConfig, avoidNetworks: string[] = []): SelectionContext {
    return {
      priority: schemePriority(),
      walletChains: this.deps.provider?.chains() ?? [],
      mode: cfg.network,
      nevermined: neverminedConfigured(),
      neverminedEnv: neverminedEnvironment(),
      avoidNetworks,
    };
  }

  /** Fetches the URL without paying and returns the parsed 402 (if any). */
  async probe(input: HttpRequestInput): Promise<{
    status: number;
    paymentRequired?: ParsedPaymentRequired;
    mpp: boolean;
    response: Response;
    bodyText?: string;
  }> {
    const res = await this.fetchImpl(input.url, buildInit(input));
    if (res.status !== 402) return { status: res.status, mpp: false, response: res };
    const bodyText = await res.text();
    const getHeader = (n: string) => res.headers.get(n);
    return {
      status: 402,
      paymentRequired: parsePaymentRequired(getHeader, bodyText),
      mpp: isMppChallenge(getHeader),
      response: res,
      bodyText,
    };
  }

  // ------------------------------------------------------------------ shared checks (steps 2, 4, 5, 6)

  private async probeLookup(cfg: SpendConfig, url: string): Promise<ProbeLookup | null> {
    if (cfg.probeMode === "off") return null;
    return this.deps.probe ? this.deps.probe(url) : lookupProbe(url, this.fetchImpl);
  }

  private async bazaarPrice(url: string, network: string): Promise<string | null> {
    if (this.deps.bazaarPrice) return this.deps.bazaarPrice(url, network);
    try {
      return await bazaarListedAmount(url, network, this.fetchImpl);
    } catch {
      return null;
    }
  }

  /** The seller's Delivery Receipt keys, or null if it does not publish them. Cached per origin. */
  private wellKnown(url: string): Promise<WellKnown | null> {
    const origin = new URL(url).origin;
    let p = this.wellKnownCache.get(origin);
    if (!p) {
      p = (async () => {
        try {
          const r = await this.fetchImpl(origin + WELL_KNOWN_PATH, { signal: AbortSignal.timeout(5000) });
          if (!r.ok) return null;
          return parseWellKnown(await r.json());
        } catch {
          return null;
        }
      })();
      this.wellKnownCache.set(origin, p);
    }
    return p;
  }

  private async refusalsFor(host: string, probe: ProbeLookup | null) {
    const all = await readNetFailures(this.deps.netFailuresFile ?? netFailuresPath());
    const lastPaid = probe?.status === "scored" ? (probe.last_paid?.ts ?? null) : null;
    return activeRefusals(all, host, lastPaid);
  }

  private priceCheck(listed: string | null, selected: Requirement) {
    if (selected.scheme !== "exact") return { listed: null, offered: selected.amount ?? null, matches: null, note: "not an exact-scheme price" };
    if (listed === null) return { listed: null, offered: selected.amount ?? null, matches: null, note: "not listed in the Bazaar" };
    return { listed, offered: selected.amount ?? null, matches: listed === selected.amount };
  }

  // ------------------------------------------------------------------ check_payment_requirements

  /** check_payment_requirements: price list + which option would be paid. Never pays. */
  async checkRequirements(input: HttpRequestInput) {
    const cfg = await this.loadCfg();
    const probe = await this.probe(input);
    if (probe.status !== 402) {
      return { url: input.url, status: probe.status, paymentRequired: false, note: "The endpoint did not ask for payment (no HTTP 402)." };
    }
    if (!probe.paymentRequired) {
      return {
        url: input.url,
        status: 402,
        paymentRequired: true,
        parseable: false,
        note: probe.mpp
          ? "The endpoint uses MPP (WWW-Authenticate: Payment), which this server does not pay."
          : "Got HTTP 402 but no x402 PaymentRequired (header or JSON body) could be parsed.",
        body: probe.bodyText?.slice(0, 2000),
      };
    }
    const pr = probe.paymentRequired;
    const ctx = this.selectionContext(cfg);
    const evaluated = evaluate(pr.accepts, ctx);
    const selected = selectRequirement(pr.accepts, ctx);
    let withinLimits: boolean | undefined;
    let limitReason: string | undefined;
    if (selected?.priceMicros !== undefined) {
      try {
        this.deps.guard.checkHost(cfg, input.url);
        this.deps.guard.checkAmount(cfg, selected.priceMicros);
        withinLimits = true;
      } catch (err) {
        withinLimits = false;
        limitReason = (err as Error).message;
      }
    }
    return {
      url: input.url,
      status: 402,
      paymentRequired: true,
      x402Version: pr.x402Version,
      resource: pr.resource,
      error: pr.error,
      accepts: evaluated.map((c) => ({ ...describeRequirement(c.requirement), payable: c.usable, reason: c.reason })),
      wouldPay: selected ? describeRequirement(selected) : null,
      withinLimits,
      limitReason,
      walletProvider: this.deps.provider?.id ?? "none",
      limits: this.deps.guard.summary(cfg),
    };
  }

  // ------------------------------------------------------------------ check_seller (steps 2-6, never pays)

  async checkSeller(input: HttpRequestInput) {
    const cfg = await this.loadCfg();
    const host = probeHost(input.url) ?? new URL(input.url).hostname;
    const probe = await this.probeLookup(cfg, input.url);
    const [first, wk] = await Promise.all([this.probe(input), this.wellKnown(input.url)]);
    const refusals = await this.refusalsFor(host, probe);
    const out: Record<string, unknown> = {
      url: input.url,
      host,
      probe: probe ? (probe.status === "scored" ? probe : probeSummary(probe)) : "off",
      probe_would_block: cfg.probeMode === "block" && probe?.status === "scored" && probe.verdict === "not_delivered",
      delivery_receipt: wk ? { supported: true, keys: wk.keys.length, refetch_window_s: wk.refetch_window_s } : { supported: false },
      refusals: refusals.map((r) => ({ network: r.network, at: r.ts, reason: r.reason })),
      http_status: first.status,
    };
    if (first.status !== 402) return { ...out, payment_required: false };
    if (!first.paymentRequired) {
      return { ...out, payment_required: true, parseable: false, mpp: first.mpp, body: first.bodyText?.slice(0, 2000) };
    }
    const pr = first.paymentRequired;
    const input_check = checkInput(pr.raw, input);
    const ctx = this.selectionContext(cfg, refusals.map((r) => r.network));
    const evaluated = evaluate(pr.accepts, ctx);
    const selected = selectRequirement(pr.accepts, ctx);
    const prices = await Promise.all(
      pr.accepts.filter((a) => a.scheme === "exact").map(async (a) => ({
        network: a.network,
        ...this.priceCheck(await this.bazaarPrice(input.url, a.network), a),
      })),
    );
    let within_limits: boolean | null = null;
    let limit_reason: string | null = null;
    if (selected?.priceMicros !== undefined) {
      try {
        this.deps.guard.checkHost(cfg, input.url);
        this.deps.guard.checkAmount(cfg, selected.priceMicros);
        within_limits = true;
      } catch (err) {
        within_limits = false;
        limit_reason = (err as Error).message;
      }
    }
    return {
      ...out,
      payment_required: true,
      accepts: evaluated.map((c) => ({ ...describeRequirement(c.requirement), payable: c.usable, reason: c.reason })),
      input: { ok: input_check.ok, missing: input_check.missing, unset_examples: input_check.unsetExamples, declared_in: input_check.declared.source },
      bazaar_price: prices,
      would_pay: selected ? describeRequirement(selected) : null,
      within_limits,
      limit_reason,
    };
  }

  // ------------------------------------------------------------------ signing

  private async exactPayment(paymentRequired: Record<string, unknown>): Promise<ExactPayment> {
    if (this.deps.createExactPayment) return this.deps.createExactPayment(paymentRequired);
    if (!this.deps.provider) throw new PaymentError("No wallet configured (WALLET_PROVIDER=none).");
    this.exactClient ??= buildX402Client(this.deps.provider);
    this.exactClient.catch(() => (this.exactClient = undefined));
    const client = await this.exactClient;
    const payload = await client.createPaymentPayload(paymentRequired as unknown as PaymentRequired);
    return { headers: new x402HTTPClient(client).encodePaymentSignatureHeader(payload), payload: payload as Record<string, any> };
  }

  private blocked(input: HttpRequestInput, reason: BlockedReason, message: string, extra: Record<string, unknown> = {}) {
    return {
      url: input.url,
      status: "blocked" as BuyStatus,
      blocked_reason: reason,
      message,
      paid: false,
      body: null,
      tx: null,
      settlement: null,
      header_tx_matched: null,
      body_sha256: null,
      receipt: null,
      ...extra,
    };
  }

  // ------------------------------------------------------------------ make_x402_request

  /**
   * make_x402_request. Stops before signing on any blocking condition; after paying, decides
   * whether money moved from the chain (the seller's settlement header is only a hint).
   */
  async request(input: HttpRequestInput) {
    // 1. config, allowed hosts
    const cfg = await this.loadCfg();
    const host = probeHost(input.url) ?? new URL(input.url).hostname;
    try {
      this.deps.guard.checkHost(cfg, input.url);
    } catch (err) {
      return this.blocked(input, "host_not_allowed", (err as Error).message);
    }

    // 2. Seller Probe
    const probe = await this.probeLookup(cfg, input.url);
    const probeOut = probe ? probeSummary(probe) : "off";
    const warnings: string[] = [];
    if (probe?.status === "scored" && probe.verdict === "not_delivered") {
      const msg = `Seller Probe's latest paid purchase from ${host} was paid but not delivered (${probe.last_paid?.ts ?? "date unknown"}).`;
      if (cfg.probeMode === "block") return this.blocked(input, "probe_not_delivered", `${msg} Payment was not made.`, { probe: probeOut });
      warnings.push(msg);
    }

    // 3. request, expect 402
    const first = await this.probe(input);
    if (first.status !== 402) {
      const body = await readBody(first.response);
      return {
        url: input.url,
        status: (first.response.ok ? "fulfilled" : "rejected_by_seller") as BuyStatus,
        http_status: first.status,
        paid: false,
        body: body.body,
        content_type: body.contentType,
        encoding: body.encoding,
        truncated: body.truncated,
        tx: null,
        settlement: null,
        header_tx_matched: null,
        body_sha256: body.body_sha256,
        receipt: null,
        probe: probeOut,
        warnings: warnings.length ? warnings : undefined,
        note: "The endpoint did not ask for payment (no HTTP 402); nothing was paid.",
      };
    }
    if (!first.paymentRequired) {
      throw new PaymentError(
        first.mpp
          ? "The endpoint uses MPP (WWW-Authenticate: Payment), which this server does not pay."
          : "Got HTTP 402 but could not parse x402 payment requirements.",
        { body: first.bodyText?.slice(0, 2000) },
      );
    }
    const pr = first.paymentRequired;

    // 4. required input
    const inputCheck = checkInput(pr.raw, input);
    if (inputCheck.unsetExamples.length) {
      warnings.push(
        `The 402 shows example input this request does not set (${inputCheck.unsetExamples.join(", ")}); it is not marked required, so the payment was not stopped.`,
      );
    }
    if (!inputCheck.ok) {
      return this.blocked(input, "missing_input", `The 402 declares input this request does not carry: ${inputCheck.missing.join("; ")}. Payment was not made.`, {
        missing: inputCheck.missing,
        probe: probeOut,
      });
    }

    // 6 (selection). (host, network) refusals: never pick a network refused recently.
    const refusals = await this.refusalsFor(host, probe);
    const ctx = this.selectionContext(cfg, refusals.map((r) => r.network));
    const evaluated = evaluate(pr.accepts, ctx);
    const selected = selectRequirement(pr.accepts, ctx);
    if (!selected) {
      if (evaluated.some((c) => c.avoided)) {
        return this.blocked(input, "network_avoided", "Every payable network for this seller refused a payment recently. Payment was not made.", {
          refusals: refusals.map((r) => ({ network: r.network, at: r.ts })),
          probe: probeOut,
        });
      }
      throw new PaymentError("None of the payment options offered by the endpoint can be paid by this wallet.", {
        accepts: evaluated.map((c) => ({ ...describeRequirement(c.requirement), reason: c.reason })),
      });
    }

    // 5. amount: limits and the Bazaar listing
    let priceCheck: Record<string, unknown> | undefined;
    if (selected.scheme !== NVM_SCHEME) {
      if (selected.priceMicros === undefined) {
        return this.blocked(input, "over_cap", "Price could not be converted to USD; refusing to pay.", { probe: probeOut });
      }
      try {
        this.deps.guard.checkAmount(cfg, selected.priceMicros);
      } catch (err) {
        return this.blocked(input, "over_cap", (err as Error).message, { code: (err as SpendLimitError).code, probe: probeOut });
      }
      if (cfg.priceMismatch !== "off") {
        priceCheck = this.priceCheck(await this.bazaarPrice(input.url, selected.network), selected);
        if (priceCheck.matches === false) {
          const msg = `The 402 asks ${selected.amount} but the Bazaar lists ${priceCheck.listed} (atomic USDC on ${selected.network}).`;
          if (cfg.priceMismatch === "block") return this.blocked(input, "price_mismatch", `${msg} Payment was not made.`, { price_check: priceCheck, probe: probeOut });
          warnings.push(msg);
        }
      }
    }

    // 7. sign; record the payer key before sending
    const started = Date.now();
    if (selected.scheme === NVM_SCHEME) return this.payNevermined(input, cfg, selected, probeOut, warnings);
    const payment = await this.exactPayment({ ...pr.raw, accepts: [selected.raw] });
    let payerKey: PayerKey | null = null;
    try {
      const payerAddress = this.deps.provider ? await this.deps.provider.address(selected.network) : "";
      payerKey = payerKeyOf(payment.payload, selected, payerAddress);
    } catch (err) {
      warnings.push(`Could not read the payer key from the signed payment (${(err as Error).message}); the chain cannot be checked.`);
    }
    const reserved = selected.priceMicros!;
    this.deps.guard.record(reserved);
    await this.log({
      time: new Date().toISOString(),
      kind: "attempt",
      url: input.url,
      provider: this.deps.provider?.id,
      network: selected.network,
      priceUsd: formatMicros(reserved),
      payTo: selected.payTo,
      payer_key: payerKey ? { type: payerKey.family === "evm" ? "authorization_nonce" : "payer_signature", value: payerKey.key } : null,
    });

    let res: Response;
    try {
      res = await this.fetchImpl(input.url, buildInit(input, payment.headers));
    } catch (err) {
      // The signed payment may or may not have reached the seller; keep it counted, never re-send.
      throw new PaymentError(`Request failed after signing the payment: ${(err as Error).message}. It was not re-sent.`, {
        payer_key: payerKey?.key,
      });
    }

    // 8. response, then the chain decides whether money moved
    const getHeader = (n: string) => res.headers.get(n);
    const settle = parseSettleResponse(getHeader);
    const headerTx = headerTxOf(settle);
    const body = await readBody(res);
    const latency = Date.now() - started;
    let chain: ChainResult;
    if (payerKey) {
      chain = this.deps.findPayment
        ? await this.deps.findPayment(payerKey, headerTx)
        : await defaultFindPayment(payerKey, headerTx, this.deps.findOptions);
    } else {
      chain = { settlement: "unknown", tx: null, transferred: null, headerTxMatched: null };
    }

    // 9. classify; refetch once from Delivery Receipt sellers
    let status: BuyStatus;
    let finalBody = body;
    let finalHttp = res.status;
    let receiptHeader = getHeader(RECEIPT_HEADER);
    let refetched = false;
    let refetchResult: Record<string, unknown> | undefined;
    const wk = await this.wellKnown(input.url);
    const paymentId = payerKey ? (payerKey.family === "evm" ? payerKey.key : chain.tx) : null;

    if (res.status === 200) {
      status = "fulfilled";
      if (chain.settlement === "not_found") {
        this.deps.guard.release(reserved);
        warnings.push("The seller delivered but no transfer was found on chain (delivered without settlement); nothing was counted as spent.");
      }
    } else if (chain.settlement === "verified") {
      status = "not_delivered";
      if (cfg.retryWithReceipt && wk && paymentId) {
        refetched = true;
        const rr = await refetch({
          url: input.url,
          paymentHeaders: payment.headers,
          paymentId,
          wellKnown: wk,
          fetch: this.fetchImpl as any,
        });
        if (rr.ok) {
          status = "recovered_by_retry";
          finalBody = bodyFrom(rr.body, "application/json");
          finalHttp = rr.status;
          receiptHeader = null;
          refetchResult = { ok: true, receipt: rr.receipt, verified: true };
        } else {
          refetchResult = { ok: false, reason: rr.reason, status: rr.status, detail: rr.detail };
        }
      } else if (!wk) {
        warnings.push("The seller does not publish Delivery Receipt keys, so the same payment was not re-sent.");
      }
    } else if (chain.settlement === "not_found") {
      status = "rejected_by_seller";
      this.deps.guard.release(reserved);
      await recordNetFailure(host, selected.network, `HTTP ${res.status} after payment, no transfer`, this.deps.netFailuresFile ?? netFailuresPath());
    } else {
      // Could not tell whether money moved: not re-sent, kept counted.
      status = "not_delivered";
      warnings.push("Could not confirm on chain whether the payment landed (all RPCs failed); it was not re-sent and is counted as spent.");
    }

    // Receipt on a 200 first delivery
    let receipt: Record<string, unknown> | null = refetchResult?.receipt ? { ...refetchResult } : null;
    if (!receipt && finalHttp === 200 && wk) {
      const v = verifyReceipt({
        header: receiptHeader,
        body: finalBody.bytes,
        wellKnown: wk,
        expect: paymentId ? { payment_id: paymentId } : undefined,
      });
      receipt = v.ok ? { ok: true, receipt: v.receipt } : { ok: false, reason: v.reason, detail: v.detail };
    }
    if (refetchResult && !refetchResult.ok) receipt = { refetch: refetchResult };

    const txOut = chain.tx ? { network: selected.network, tx: chain.tx, explorer: isOnchainTx(selected.network, chain.tx) ? chainInfo(selected.network)?.explorerTx(chain.tx) : undefined } : null;
    await this.log({
      time: new Date().toISOString(),
      kind: "result",
      url: input.url,
      provider: this.deps.provider?.id,
      network: selected.network,
      priceUsd: formatMicros(reserved),
      http_status: res.status,
      status,
      settlement: chain.settlement,
      transaction: chain.tx,
      header_tx: headerTx,
      header_tx_matched: chain.headerTxMatched,
      body_sha256: finalBody.body_sha256,
      refetched,
    });

    if (cfg.reportToProbe && (status === "not_delivered" || status === "recovered_by_retry")) {
      const rep: ProbeReport = {
        host,
        url: input.url,
        network: selected.network,
        amount: selected.amount ?? "",
        outcome: "not_delivered",
        http_status: res.status,
        latency_ms: latency,
        settled_header: !!settle,
        onchain_found: chain.settlement === "verified",
        receipt_ok: receipt ? receipt.ok === true : null,
        refetched,
        sdk: SDK_LABEL,
        ts: new Date().toISOString(),
      };
      await (this.deps.report ?? ((r) => reportToProbe(r, this.fetchImpl)))(rep);
    }

    // 10. result
    return JSON.parse(
      JSON.stringify(
        {
          url: input.url,
          status,
          http_status: finalHttp,
          paid: chain.settlement !== "not_found",
          body: finalBody.body,
          content_type: finalBody.contentType,
          encoding: finalBody.encoding,
          truncated: finalBody.truncated,
          tx: txOut,
          settlement: chain.settlement,
          header_tx_matched: chain.headerTxMatched,
          body_sha256: finalBody.body_sha256,
          receipt,
          probe: probeOut,
          payment: {
            ...describeRequirement(selected),
            provider: this.deps.provider?.id,
            transferred: chain.transferred,
            transfer_mismatch: chain.mismatch,
            settlement_header: settle ?? null,
          },
          price_check: priceCheck,
          refetched,
          warnings: warnings.length ? warnings : undefined,
        },
        bigintSafe,
      ),
    );
  }

  /** nvm:erc4337 credits: paid through Nevermined; there is no USDC transfer of ours to look for. */
  private async payNevermined(input: HttpRequestInput, cfg: SpendConfig, selected: Requirement, probeOut: unknown, warnings: string[]) {
    if (!this.deps.nevermined) throw new PaymentError("Nevermined is not configured.");
    const headers = await this.deps.nevermined.paymentHeaders(selected, cfg);
    const res = await this.fetchImpl(input.url, buildInit(input, headers));
    const settle = parseSettleResponse((n) => res.headers.get(n));
    const body = await readBody(res);
    const status: BuyStatus = res.status === 200 ? "fulfilled" : res.status === 402 ? "rejected_by_seller" : "not_delivered";
    const tx = headerTxOf(settle);
    await this.log({
      time: new Date().toISOString(),
      kind: "result",
      url: input.url,
      provider: "nevermined",
      scheme: selected.scheme,
      network: selected.network,
      planId: selected.planId,
      http_status: res.status,
      status,
      transaction: tx,
    });
    return {
      url: input.url,
      status,
      http_status: res.status,
      paid: status !== "rejected_by_seller",
      body: body.body,
      content_type: body.contentType,
      encoding: body.encoding,
      truncated: body.truncated,
      tx: tx ? { network: selected.network, tx } : null,
      settlement: "unknown",
      header_tx_matched: null,
      body_sha256: body.body_sha256,
      receipt: settle ?? null,
      probe: probeOut,
      payment: { ...describeRequirement(selected), provider: "nevermined" },
      note: "Nevermined credits: the settlement is Nevermined's credit burn, not a USDC transfer of this wallet, so it is not looked up on chain.",
      warnings: warnings.length ? warnings : undefined,
    };
  }
}

export type { Requirement };
