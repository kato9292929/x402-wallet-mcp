import { promises as fs } from "node:fs";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentRequired } from "@x402/core/types";
import { chainInfo, formatMicros } from "../chains.js";
import { configDir, loadConfig, paymentLogPath, schemePriority, type SpendConfig } from "../config.js";
import { SpendGuard, SpendLimitError } from "../limits.js";
import { NeverminedPayer, neverminedConfigured } from "../nevermined.js";
import { buildX402Client, type WalletProvider } from "../providers/index.js";
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

export interface Deps {
  provider: WalletProvider | null;
  guard: SpendGuard;
  nevermined?: NeverminedPayer;
  fetch?: typeof fetch;
  loadConfig?: () => Promise<SpendConfig>;
  /** Overrides how the exact-scheme payment header is produced (tests). */
  createExactHeaders?: (paymentRequired: Record<string, unknown>) => Promise<Record<string, string>>;
  log?: (entry: Record<string, unknown>) => Promise<void>;
}

const MAX_BODY_CHARS = 100_000;

export class PaymentError extends Error {
  constructor(
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "PaymentError";
  }
}

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

async function readBody(res: Response): Promise<{ contentType: string; body: string; truncated: boolean; encoding: "text" | "base64" }> {
  const contentType = res.headers.get("content-type") ?? "";
  const textual = contentType === "" || /json|text|xml|javascript|html|csv|yaml|x-www-form-urlencoded/i.test(contentType);
  if (textual) {
    const text = await res.text();
    return {
      contentType,
      body: text.length > MAX_BODY_CHARS ? text.slice(0, MAX_BODY_CHARS) : text,
      truncated: text.length > MAX_BODY_CHARS,
      encoding: "text",
    };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const b64 = buf.toString("base64");
  return {
    contentType,
    body: b64.length > MAX_BODY_CHARS ? b64.slice(0, MAX_BODY_CHARS) : b64,
    truncated: b64.length > MAX_BODY_CHARS,
    encoding: "base64",
  };
}

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

export class X402Requester {
  private exactClient?: Promise<x402Client>;
  private readonly fetchImpl: typeof fetch;
  private readonly loadCfg: () => Promise<SpendConfig>;
  private readonly log: (entry: Record<string, unknown>) => Promise<void>;

  constructor(private readonly deps: Deps) {
    this.fetchImpl = deps.fetch ?? fetch;
    this.loadCfg = deps.loadConfig ?? loadConfig;
    this.log = deps.log ?? defaultLog;
  }

  selectionContext(cfg: SpendConfig): SelectionContext {
    return {
      priority: schemePriority(),
      walletChains: this.deps.provider?.chains() ?? [],
      mode: cfg.network,
      nevermined: neverminedConfigured(),
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
    let withinLimits: boolean | string | undefined;
    if (selected?.priceMicros !== undefined) {
      try {
        this.deps.guard.checkHost(cfg, input.url);
        this.deps.guard.checkAmount(cfg, selected.priceMicros);
        withinLimits = true;
      } catch (err) {
        withinLimits = (err as Error).message;
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
      walletProvider: this.deps.provider?.id ?? "none",
      limits: this.deps.guard.summary(cfg),
    };
  }

  private async exactHeaders(paymentRequired: Record<string, unknown>): Promise<Record<string, string>> {
    if (this.deps.createExactHeaders) return this.deps.createExactHeaders(paymentRequired);
    if (!this.deps.provider) throw new PaymentError("No wallet configured (WALLET_PROVIDER=none).");
    this.exactClient ??= buildX402Client(this.deps.provider);
    this.exactClient.catch(() => (this.exactClient = undefined));
    const client = await this.exactClient;
    const payload = await client.createPaymentPayload(paymentRequired as unknown as PaymentRequired);
    return new x402HTTPClient(client).encodePaymentSignatureHeader(payload);
  }

  /** make_x402_request: request, pay on 402 within limits, retry, return result + receipt. */
  async request(input: HttpRequestInput) {
    const cfg = await this.loadCfg();
    const first = await this.probe(input);
    if (first.status !== 402) {
      const body = await readBody(first.response);
      return { url: input.url, status: first.status, ok: first.response.ok, paid: false, ...body };
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
    const ctx = this.selectionContext(cfg);
    const selected = selectRequirement(pr.accepts, ctx);
    if (!selected) {
      throw new PaymentError("None of the payment options offered by the endpoint can be paid by this wallet.", {
        accepts: evaluate(pr.accepts, ctx).map((c) => ({ ...describeRequirement(c.requirement), reason: c.reason })),
      });
    }

    // Human-set limits. Throws SpendLimitError before anything is signed.
    this.deps.guard.checkHost(cfg, input.url);
    let reserved = 0n;
    let paymentHeaders: Record<string, string>;
    if (selected.scheme === NVM_SCHEME) {
      if (!this.deps.nevermined) throw new PaymentError("Nevermined is not configured.");
      paymentHeaders = await this.deps.nevermined.paymentHeaders(selected, cfg);
    } else {
      if (selected.priceMicros === undefined) {
        throw new SpendLimitError("Price could not be converted to USD; refusing to pay.", "UNPRICEABLE");
      }
      this.deps.guard.checkAmount(cfg, selected.priceMicros);
      const paymentRequired = { ...pr.raw, accepts: [selected.raw] };
      paymentHeaders = await this.exactHeaders(paymentRequired);
      // Reserve the amount once a signed authorization exists.
      this.deps.guard.record(selected.priceMicros);
      reserved = selected.priceMicros;
    }

    let res: Response;
    try {
      res = await this.fetchImpl(input.url, buildInit(input, paymentHeaders));
    } catch (err) {
      // The signed authorization may or may not have reached the seller; keep it counted.
      throw new PaymentError(`Request failed after signing the payment: ${(err as Error).message}`, {
        reservedUsd: formatMicros(reserved),
      });
    }
    const getHeader = (n: string) => res.headers.get(n);
    const receipt = parseSettleResponse(getHeader);
    const body = await readBody(res);
    const rejected = res.status === 402;
    if (rejected) this.deps.guard.release(reserved);

    const tx = typeof receipt?.transaction === "string" ? receipt.transaction : typeof receipt?.transactionHash === "string" ? receipt.transactionHash : undefined;
    const network = (typeof receipt?.network === "string" && receipt.network) || selected.network;
    const explorer = tx && isOnchainTx(network, tx) ? chainInfo(network)?.explorerTx(tx) : undefined;
    const payment = {
      provider: selected.scheme === NVM_SCHEME ? "nevermined" : this.deps.provider?.id,
      ...describeRequirement(selected),
      settled: !rejected && (receipt ? receipt.success !== false : undefined),
      transaction: tx,
      explorerUrl: explorer,
      receipt,
    };
    await this.log({
      time: new Date().toISOString(),
      url: input.url,
      method: (input.method ?? "GET").toUpperCase(),
      status: res.status,
      provider: payment.provider,
      scheme: selected.scheme,
      network: selected.network,
      priceUsd: payment.priceUsd,
      payTo: selected.payTo,
      planId: selected.planId,
      transaction: tx,
      explorerUrl: explorer,
      settled: payment.settled,
    });

    if (rejected) {
      const again = parsePaymentRequired(getHeader, body.body);
      throw new PaymentError("The seller rejected the payment (HTTP 402 after paying). No funds were counted.", {
        payment,
        sellerError: again?.error,
        body: body.body.slice(0, 2000),
      });
    }
    return {
      url: input.url,
      status: res.status,
      ok: res.ok,
      paid: true,
      payment,
      sessionSpentUsd: formatMicros(this.deps.guard.sessionSpentMicros),
      ...body,
    };
  }
}

export type { Requirement };
