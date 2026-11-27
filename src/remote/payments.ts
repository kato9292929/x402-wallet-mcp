import { createPublicKey, randomBytes, verify } from "node:crypto";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentRequired } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import {
  address as solAddress,
  getAddressEncoder,
  getProgramDerivedAddress,
  getBase58Encoder,
  getCompiledTransactionMessageDecoder,
  getBase64Decoder,
  getBase64Encoder,
  getTransactionDecoder,
  getTransactionEncoder,
} from "@solana/kit";
import { getAddress, getTypesForEIP712Domain, recoverTypedDataAddress, serializeTypedData } from "viem";
import { CHAINS, formatMicros, parseUsdToMicros } from "../chains.js";
import { decide, describeCandidate, exampleConditions, findCandidates, rankByRecord, requestFor, unmatchedWords, type BuyDataArgs } from "../buy.js";
import { lookupProbe } from "../safe/probe.js";
import { SUCCESS_TTL_MS, verifiedFamily, type SuccessRecord } from "../safe/known.js";
import { SpendGuard } from "../limits.js";
import { findPayment as defaultFindPayment, payerKeyOf, type ChainResult, type PayerKey } from "../safe/chain.js";
import {
  activeFeePayerRefusals,
  activeRefusals,
  FEE_PAYER_REFUSAL_TTL_MS,
  NET_REFUSAL_TTL_MS,
  type FeePayerRefusal,
  type NetRefusal,
} from "../safe/netfail.js";
import { offerChangedDetail } from "../x402/explain.js";
import { RESULT_KEPT_MINUTES, RESULT_NEXT_STEP, SHOW_USER_INSTRUCTION, showUserForApproval } from "../notice.js";
import { describeRequirement } from "../x402/parse.js";
import { PaymentError, X402Requester, type ExactPayment, type HttpRequestInput, type Prepared } from "../x402/request.js";
import { configFor, type RemoteParams } from "./params.js";
import type { Store } from "./store.js";
import { MAX_PENDING_TOTAL, pendingBuckets, type Client } from "./limits.js";
import { AddressWallet } from "./wallet.js";

/**
 * Remote approval flow (the same shape as Coinbase Wallet MCP's approval mode):
 *   request_x402_payment  runs every pre-payment check and returns an approval link + request id.
 *   approval page          the owner presses approve: the payment is checked again and built *now*
 *                          (fresh Solana blockhash / EIP-3009 window), then signed in their wallet.
 *   get_x402_result        returns the outcome. A request id is paid at most once.
 */

export const PENDING_TTL_S = 300;
const BUILD_TTL_S = 120;
const RESULT_TTL_S = RESULT_KEPT_MINUTES * 60;
const LOCK_TTL_S = 900;
const DAY_S = 24 * 3600;
/**
 * Approval links one wallet can have waiting at once. Each expires in 5 minutes and nothing is paid
 * without a signature, and the per-payment / 24-hour limits are checked again when the user signs, so
 * this only caps how many links are open (enough to test a batch of APIs in one go).
 */
export const MAX_PENDING_PER_ADDRESS = 20;
/** How long to wait for the seller's answer to a paid request before settling the outcome from the chain. */
export const SELLER_TIMEOUT_MS = 45_000;
/** After this, a Solana payment can no longer land: its blockhash (fetched when it was built) has expired. */
const SOLANA_LAND_WINDOW_MS = 180_000;
const SENT_TTL_S = 24 * 3600;
/** Key of the server-wide count of waiting links. */
const TOTAL_KEY = "__all__";

export interface PendingRecord {
  id: string;
  token: string;
  params: RemoteParams;
  input: HttpRequestInput;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  /** The paying wallet: from the connection URL, or chosen on the approval page ("" until then). */
  payer: string;
  /** Pending-count bucket this request was counted in (the first of countKeys). */
  countKey: string;
  /** All pending-count buckets this request was counted in (besides the server total). */
  countKeys?: string[];
  priceUsd: string;
  createdAt: number;
  expiresAt: number;
  state: "pending" | "signing";
}

interface BuildRecord {
  family: "evm" | "solana";
  prep: string;
  payload: string;
  /** Solana: the message the wallet must sign (base64). */
  messageBytes?: string;
  /** EVM: the EIP-712 data (bigint-safe JSON). */
  typedData?: string;
  /** When the payment was built (ms since epoch). */
  builtAt?: number;
}

const K = {
  pending: (id: string) => `ap:p:${id}`,
  build: (id: string) => `ap:b:${id}`,
  result: (id: string) => `ap:r:${id}`,
  lock: (id: string) => `ap:l:${id}`,
  count: (addr: string) => `ap:c:${addr}`,
  sent: (id: string) => `ap:t:${id}`,
  spent: (addr: string) => `ap:s:${addr}`,
  refusals: (host: string) => `ap:n:${host}`,
  feePayerRefusals: () => "ap:f",
  successes: () => "ap:ok",
};

// bigint-safe JSON (a selected requirement carries priceMicros as bigint)
const toJson = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? { $big: x.toString() } : x));
const fromJson = <T>(s: string): T =>
  JSON.parse(s, (_k, x) => (x && typeof x === "object" && typeof x.$big === "string" && Object.keys(x).length === 1 ? BigInt(x.$big) : x));

const hex = (n: number) => randomBytes(n).toString("hex");

export class FlowError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

// ------------------------------------------------------------------ shared pieces

async function spent24h(store: Store, addr: string, now = Date.now()): Promise<bigint> {
  const list = (await store.get<{ t: number; m: string }[]>(K.spent(addr))) ?? [];
  return list.filter((e) => now - e.t < DAY_S * 1000).reduce((a, e) => a + BigInt(e.m), 0n);
}

async function addSpent(store: Store, addr: string, micros: bigint, now = Date.now()) {
  const list = ((await store.get<{ t: number; m: string }[]>(K.spent(addr))) ?? []).filter((e) => now - e.t < DAY_S * 1000);
  list.push({ t: now, m: micros.toString() });
  await store.set(K.spent(addr), list, DAY_S);
}

function netFailuresIn(store: Store) {
  return {
    read: async (host: string) => (await store.get<NetRefusal[]>(K.refusals(host))) ?? [],
    record: async (h: string, network: string, reason: string) => {
      const list = activeRefusals((await store.get<NetRefusal[]>(K.refusals(h))) ?? [], h);
      list.push({ ts: new Date().toISOString(), host: h, network, reason });
      await store.set(K.refusals(h), list, NET_REFUSAL_TTL_MS / 1000);
    },
  };
}

const log = async (entry: Record<string, unknown>) => {
  console.log(`[agentpay402] payment ${JSON.stringify(entry)}`);
};

export interface FlowDeps {
  store: Store;
  fetch?: typeof fetch;
  /** Who is calling (MCP session or IP hash): links without a wallet address are counted per connection. */
  client?: Client;
  /** Overrides on-chain lookups / probe / bazaar (tests). */
  requesterOverrides?: Partial<ConstructorParameters<typeof X402Requester>[0]>;
}

/** A requester with the shared checks, set up for this owner (limits from the URL, 24-hour total from the store). */
export async function requesterFor(params: RemoteParams, deps: FlowDeps): Promise<X402Requester> {
  const wallet = new AddressWallet(params);
  let spent = 0n;
  for (const c of wallet.chains()) if (wallet.knows(c)) spent += await spent24h(deps.store, await wallet.address(c));
  return new X402Requester({
    provider: wallet,
    guard: new SpendGuard(spent),
    fetch: deps.fetch,
    loadConfig: async () => configFor(params),
    log,
    netFailures: netFailuresIn(deps.store),
    feePayerRefusals: {
      read: async () => (await deps.store.get<FeePayerRefusal[]>(K.feePayerRefusals())) ?? [],
      record: async (feePayer: string, reason: string, host: string) => {
        const list = activeFeePayerRefusals((await deps.store.get<FeePayerRefusal[]>(K.feePayerRefusals())) ?? []).filter((r) => r.feePayer !== feePayer);
        list.push({ ts: new Date().toISOString(), feePayer, reason, host });
        await deps.store.set(K.feePayerRefusals(), list, FEE_PAYER_REFUSAL_TTL_MS / 1000);
      },
    },
    successRecords: {
      read: async () => (await deps.store.get<SuccessRecord[]>(K.successes())) ?? [],
      record: async (r: SuccessRecord) => {
        const now = Date.now();
        const list = ((await deps.store.get<SuccessRecord[]>(K.successes())) ?? [])
          .filter((s) => now - Date.parse(s.ts) < SUCCESS_TTL_MS && !(s.host === r.host && s.network === r.network))
          .slice(-500);
        list.push(r);
        await deps.store.set(K.successes(), list, SUCCESS_TTL_MS / 1000);
      },
    },
    sellerTimeoutMs: SELLER_TIMEOUT_MS,
    // Kept short so the seller's answer plus this search fit in one request; get_x402_result checks again later.
    findOptions: { attempts: 6, intervalMs: 5000 },
    ...deps.requesterOverrides,
  });
}

export function phantomBrowseLink(pageUrl: string, origin: string): string {
  return `https://phantom.app/ul/browse/${encodeURIComponent(pageUrl)}?ref=${encodeURIComponent(origin)}`;
}

// ------------------------------------------------------------------ request_x402_payment

export async function requestPayment(params: RemoteParams, input: HttpRequestInput, origin: string, deps: FlowDeps) {
  const requester = await requesterFor(params, deps);
  const prep = await requester.prepare(input);
  if (prep.kind === "result") return prep.result;
  const sel = prep.selected;
  if (sel.scheme !== "exact" || !sel.amount || !sel.payTo || !sel.asset || sel.priceMicros === undefined) {
    throw new PaymentError("This seller's payment option cannot be paid with an approval link (only USDC `exact` payments are supported).");
  }
  const wallet = new AddressWallet(params);
  const payer = wallet.knows(sel.network) ? await wallet.address(sel.network) : "";
  // Links are counted per wallet address (when the URL has one), per connection (MCP session or IP), per IP
  // outside Anthropic's ranges, and for the whole server.
  const buckets = pendingBuckets(deps.client, payer);
  const countKey = buckets[0].key;

  const now = Date.now();
  // Only links that are still open count: an expired or finished one frees its place at once.
  const openOf = async (key: string) => ((await deps.store.get<{ id: string; exp: number }[]>(K.count(key))) ?? []).filter((e) => e.exp > now);
  const opens = await Promise.all(buckets.map((b) => openOf(b.key)));
  const all = await openOf(TOTAL_KEY);
  const full = buckets.findIndex((b, i) => opens[i].length >= b.max);
  if (full >= 0 || all.length >= MAX_PENDING_TOTAL) {
    return {
      url: input.url,
      status: "blocked",
      blocked_reason: "too_many_pending",
      message:
        full >= 0
          ? `There are already ${buckets[full].max} payments waiting for approval for this ${buckets[full].what}. Approve or reject them, or wait ${PENDING_TTL_S / 60} minutes.`
          : `The server has ${MAX_PENDING_TOTAL} payments waiting for approval. Try again in a few minutes.`,
      paid: false,
    };
  }

  const rec: PendingRecord = {
    id: hex(16),
    token: hex(16),
    params,
    input,
    network: sel.network,
    amount: sel.amount,
    asset: sel.asset,
    payTo: sel.payTo,
    payer,
    countKey,
    countKeys: buckets.map((b) => b.key),
    priceUsd: formatMicros(sel.priceMicros),
    createdAt: now,
    expiresAt: now + PENDING_TTL_S * 1000,
    state: "pending",
  };
  await deps.store.set(K.pending(rec.id), rec, PENDING_TTL_S);
  for (const [i, b] of buckets.entries()) {
    await deps.store.set(K.count(b.key), [...opens[i], { id: rec.id, exp: rec.expiresAt }], PENDING_TTL_S);
  }
  await deps.store.set(K.count(TOTAL_KEY), [...all, { id: rec.id, exp: rec.expiresAt }].slice(-MAX_PENDING_TOTAL), PENDING_TTL_S);
  const approveUrl = `${origin}/approve/${rec.id}?t=${rec.token}`;
  const solana = CHAINS[sel.network]?.family === "solana";
  const signWith = solana ? "Phantom" : "Rabby / MetaMask";
  return JSON.parse(
    toJson({
      url: input.url,
      status: "awaiting_approval",
      request_id: rec.id,
      approve_url: approveUrl,
      phantom_app_url: solana ? phantomBrowseLink(approveUrl, origin) : undefined,
      expires_at: new Date(rec.expiresAt).toISOString(),
      payment: {
        network: sel.network,
        chain: CHAINS[sel.network]?.name,
        sign_with: signWith,
        priceUsd: rec.priceUsd,
        payTo: sel.payTo,
        payer: payer || `the ${signWith} wallet the user connects on the approval page`,
      },
      probe: prep.probeOut,
      price_check: prep.priceCheck,
      warnings: prep.warnings.length ? prep.warnings : undefined,
      show_user: showUserForApproval(solana ? "solana" : "evm"),
      next_step:
        `${SHOW_USER_INSTRUCTION} Nothing has been paid yet. Tell the user this is paid on ${CHAINS[sel.network]?.name} and signed in ${signWith}. ` +
        (solana
          ? "Show the user approve_url as a link (and phantom_app_url for approving on a phone in the Phantom app). "
          : "Show the user approve_url as a link to open in a browser with Rabby or MetaMask. ") +
        "The link expires in 5 minutes. If Phantom says the request could not be simulated, the user can cancel: nothing is paid. " +
        "After the user says they approved or rejected, call get_x402_result with request_id.",
    }),
  );
}

// ------------------------------------------------------------------ buy_data

/**
 * From a short description of the data to an approval link: picks the best Bazaar match this wallet can pay
 * within the per-payment limit (and max_price_usd), fills required input from the Bazaar example when none is
 * given, then runs request_x402_payment. When the match is not clear, nothing is prepared and the top three
 * candidates are returned. Money moves only when the user signs the approval link, as with request_x402_payment.
 */
export async function buyData(params: RemoteParams, args: BuyDataArgs, origin: string, deps: FlowDeps) {
  const perCall = parseUsdToMicros(params.perCallMaxUsd);
  const asked = args.max_price_usd ? parseUsdToMicros(args.max_price_usd) : perCall;
  const cap = asked < perCall ? asked : perCall;
  const family = args.network === "base" ? "evm" : args.network === "solana" ? "solana" : undefined;
  const networks = new AddressWallet(params).preferredChains().filter((c) => !family || CHAINS[c]?.family === family);
  const found = await findCandidates(args, networks, cap, deps.fetch);
  // Equally good matches are told apart by the sellers' records: paid through AgentPay before, then calls in the
  // last 30 days, then Seller Probe's score.
  const learned = (await deps.store.get<SuccessRecord[]>(K.successes())) ?? [];
  const succeeded = (host: string) => verifiedFamily(host).size > 0 || learned.some((s) => s.host === host);
  const candidates = await rankByRecord(
    found,
    deps.requesterOverrides?.probe ?? ((url: string) => lookupProbe(url, deps.fetch ?? fetch, 3000)),
    succeeded,
  );
  if (!candidates.length) {
    return {
      status: "no_match",
      paid: false,
      query: args.query,
      message: `No paid API in the Bazaar matched "${args.query}" within $${formatMicros(cap)} per request on a network this connection pays.`,
      next_step: "Nothing was prepared. Try list_bazaar_resources with other words (the provider's name or the kind of data), or ask the user.",
    };
  }
  const pick = decide(candidates);
  if (!pick) {
    return {
      status: "choose",
      paid: false,
      query: args.query,
      candidates: candidates.slice(0, 3).map(describeCandidate),
      next_step:
        "Nothing was prepared: several endpoints match equally well and have the same record. Pick the one that fits what the user asked for (ask the user if unclear), " +
        "then call request_x402_payment with its resource URL and input, or buy_data again with a more specific query.",
    };
  }
  const choice = requestFor(pick, args);
  // Input is never filled silently. Nothing is prepared while required input is missing, or while the request names
  // something specific (e.g. "MSFT") that the endpoint does not cover and that no input carries yet.
  const gaveInput = args.body !== undefined || args.query_params !== undefined;
  const specific = gaveInput ? [] : unmatchedWords(args.query, pick.item);
  if (choice.needs.length || (specific.length && choice.optional.length)) {
    const fields = [...choice.needs, ...(choice.needs.length ? [] : choice.optional)];
    return {
      status: "confirm_input",
      paid: false,
      query: args.query,
      chosen: { ...describeCandidate(pick), url: choice.url },
      needs: choice.needs,
      optional: choice.optional,
      request_mentions: specific.length ? specific : undefined,
      other_candidates: candidates.slice(1, 3).map(describeCandidate),
      next_step:
        "Nothing was prepared. " +
        (choice.needs.length
          ? `This API needs input the user's request did not give: ${choice.needs.map((n) => n.field).join(", ")}. `
          : `The request mentions ${specific.join(", ")}, which this API only covers through its input (${fields.map((n) => n.field).join(", ")}). `) +
        "Fill the input from the user's own words (for example the ticker, token, address or chain they named) and call buy_data again with " +
        "body / query_params (an empty query_params: {} means no optional input); if their request does not say, ask them. The example " +
        "values are only the API's sample: call buy_data with use_example: true only if the user agrees to them.",
    };
  }
  const r: Record<string, any> = await requestPayment(
    params,
    { url: choice.url, method: choice.method, body: choice.body as any, ...(args.network ? { network: args.network } : {}) },
    origin,
    deps,
  );
  // Input the user did not give came from the API's example: the user sees those conditions before signing.
  const conditions = r.status === "awaiting_approval" ? exampleConditions(choice) : null;
  if (conditions) {
    r.show_user = `${conditions}\n\n${r.show_user}`;
    r.next_step =
      "The input came from the API's example, not from the user's request: before the user signs, tell them these conditions (the first " +
      "line of show_user) and ask whether they are what they want. If not, do not let them sign this link; call buy_data again with body / " +
      `query_params built from their answer. ${r.next_step}`;
  }
  return {
    ...r,
    // The network and price actually asked for (the 402 may choose another of the seller's options than the Bazaar's cheapest).
    chosen: {
      ...describeCandidate(pick),
      ...(r.payment ? { network: r.payment.network, price_usd: r.payment.priceUsd } : {}),
      url: choice.url,
      input_used: choice.input_used,
    },
    other_candidates: candidates.slice(1, 3).map(describeCandidate),
  };
}

// ------------------------------------------------------------------ get_x402_result

export async function getResult(id: string, deps: FlowDeps) {
  if (!/^[0-9a-f]{32}$/.test(id)) return { request_id: id, status: "unknown", message: "No such request." };
  const r = await deps.store.get<Record<string, unknown>>(K.result(id));
  if (r) {
    const done = r.status === "fulfilled" || r.status === "recovered_by_retry";
    return { request_id: id, ...r, ...(done ? { next_step: RESULT_NEXT_STEP } : {}) };
  }
  const unresolved = await resolveSent(id, deps);
  if (unresolved) return { request_id: id, ...unresolved };
  const p = await deps.store.get<PendingRecord>(K.pending(id));
  if (p) {
    return {
      request_id: id,
      status: p.state === "pending" ? "awaiting_approval" : "processing",
      message: p.state === "pending" ? "The user has not approved this payment yet." : "The user is signing; the payment is being sent.",
      expires_at: new Date(p.expiresAt).toISOString(),
    };
  }
  if (await deps.store.get(K.lock(id))) return { request_id: id, status: "processing", message: "The payment is being sent." };
  return { request_id: id, status: "expired", paid: false, message: "No such request, or it expired without being approved. Nothing was paid." };
}

// ------------------------------------------------------------------ approval page actions

async function pendingFor(id: string, token: string | null, deps: FlowDeps): Promise<PendingRecord> {
  if (!/^[0-9a-f]{32}$/.test(id) || !token) throw new FlowError("This approval link is not valid.", 404);
  const p = await deps.store.get<PendingRecord>(K.pending(id));
  if (!p || p.token !== token) {
    const r = await deps.store.get<Record<string, unknown>>(K.result(id));
    throw new FlowError(r ? "This payment has already been handled." : "This approval link has expired (5 minutes). Ask Claude again.", 410);
  }
  return p;
}

export async function pageRecord(id: string, token: string | null, deps: FlowDeps) {
  return pendingFor(id, token, deps);
}

async function finishWith(rec: PendingRecord, result: Record<string, unknown>, deps: FlowDeps) {
  await deps.store.set(K.result(rec.id), result, RESULT_TTL_S);
  await deps.store.del(K.pending(rec.id));
  await deps.store.del(K.build(rec.id));
  await deps.store.del(K.sent(rec.id));
  for (const key of [...(rec.countKeys ?? [rec.countKey ?? rec.payer]).map(K.count), K.count(TOTAL_KEY)]) {
    const open = ((await deps.store.get<{ id: string; exp: number }[]>(key)) ?? []).filter((e) => e.id !== rec.id && e.exp > Date.now());
    await deps.store.set(key, open, PENDING_TTL_S);
  }
}

export async function rejectPayment(id: string, token: string | null, deps: FlowDeps) {
  const rec = await pendingFor(id, token, deps);
  if (await deps.store.get(K.lock(id))) throw new FlowError("This payment is being processed.", 409);
  await finishWith(
    rec,
    { url: rec.input.url, status: "blocked", blocked_reason: "not_approved", paid: false, message: "The user rejected the payment. Nothing was signed or paid." },
    deps,
  );
  return { ok: true };
}

/** Builds the unsigned payment with the payer's address only: a placeholder signature stands in for the wallet's. */
async function buildUnsigned(prep: Prepared, payer: string) {
  const sel = prep.selected;
  const family = CHAINS[sel.network].family;
  const client = new x402Client();
  client.setSpendControls?.(false);
  let messageBytes: Uint8Array | undefined;
  let typedData: any;
  if (family === "solana") {
    client.register(
      "solana:*",
      new ExactSvmScheme({
        address: payer,
        signTransactions: async (txs: readonly { messageBytes: Uint8Array }[]) =>
          txs.map((tx) => {
            messageBytes = new Uint8Array(tx.messageBytes);
            return { [payer]: new Uint8Array(64) };
          }),
      } as any, { transactionVersions: [0] }),
    );
  } else {
    client.register(
      "eip155:*",
      new ExactEvmScheme({
        address: payer as `0x${string}`,
        signTypedData: async (td: any) => {
          typedData = td;
          return `0x${"00".repeat(65)}` as `0x${string}`;
        },
      }),
    );
  }
  const payload = await client.createPaymentPayload({ ...prep.rawPaymentRequired, accepts: [sel.raw] } as unknown as PaymentRequired);
  return { family, payload, messageBytes, typedData };
}

/** The wallet that will pay: fixed by the connection URL, or the one the user connected on the page. */
function payerFor(rec: PendingRecord, fromPage: string | undefined): string {
  const family = CHAINS[rec.network].family;
  const given = (fromPage ?? "").trim();
  if (rec.payer) {
    if (given && given.toLowerCase() !== rec.payer.toLowerCase()) {
      throw new FlowError(`This payment is set to be paid from ${rec.payer}. Select that account in your wallet.`);
    }
    return rec.payer;
  }
  if (!given) throw new FlowError("Could not read the wallet's address. Press again.");
  try {
    return family === "solana" ? solAddress(given) : getAddress(given);
  } catch {
    throw new FlowError("Could not read the wallet's address.");
  }
}

function paramsWithPayer(rec: PendingRecord, payer: string): RemoteParams {
  return CHAINS[rec.network].family === "solana" ? { ...rec.params, solana: payer } : { ...rec.params, base: payer as `0x${string}` };
}

export async function buildPayment(id: string, token: string | null, deps: FlowDeps, payerFromPage?: string) {
  let rec = await pendingFor(id, token, deps);
  if (await deps.store.get(K.lock(id))) throw new FlowError("This payment is being processed.", 409);
  const payer = payerFor(rec, payerFromPage);
  rec = { ...rec, payer, params: paramsWithPayer(rec, payer) };

  // Check everything again now, against a fresh 402.
  const requester = await requesterFor(rec.params, deps);
  const prep = await requester.prepare(rec.input);
  if (prep.kind === "result") {
    await finishWith(rec, prep.result, deps);
    throw new FlowError("Stopped by a check before paying. Nothing was paid. Go back to Claude to see why.", 409);
  }
  const sel = prep.selected;
  const offer_changed = (["network", "amount", "payTo", "asset"] as const)
    .filter((k) => sel[k] !== rec[k])
    .map((k) => ({ field: k, before: String(rec[k] ?? ""), after: String(sel[k] ?? "") }));
  // Some sellers (e.g. Tavily) give a new pay-to address in every 402. When only the address changed (same
  // network, amount and asset), the payment is built with the new address and the page shows it before the
  // wallet signs, instead of stopping: asking again would get yet another address.
  let payToChanged: { before: string; after: string } | undefined;
  if (offer_changed.length === 1 && offer_changed[0].field === "payTo" && sel.payTo) {
    payToChanged = { before: offer_changed[0].before, after: offer_changed[0].after };
    console.log(`[agentpay402] seller's pay-to address changed for ${id}: ${JSON.stringify(payToChanged)}`);
    rec = { ...rec, payTo: sel.payTo };
  } else if (offer_changed.length) {
    console.log(`[agentpay402] seller's terms changed for ${id}: ${JSON.stringify(offer_changed)}`);
    await finishWith(
      rec,
      {
        url: rec.input.url,
        status: "blocked",
        blocked_reason: "offer_changed",
        offer_changed,
        detail: offerChangedDetail(offer_changed),
        paid: false,
        message: "The seller's payment terms changed before the wallet signed. Nothing was paid.",
      },
      deps,
    );
    throw new FlowError("The seller's terms changed from what is shown. Nothing was paid.", 409);
  }

  const built = await buildUnsigned(prep, rec.payer);
  const record: BuildRecord = { family: built.family, prep: toJson(prep), payload: toJson(built.payload), builtAt: Date.now() };
  let forPage: Record<string, unknown>;
  if (built.family === "solana") {
    if (!built.messageBytes) throw new FlowError("Could not prepare the Solana payment.", 500);
    record.messageBytes = getBase64Decoder().decode(built.messageBytes);
    forPage = { family: "solana", wireTx: (built.payload.payload as { transaction: string }).transaction };
  } else {
    if (!built.typedData) throw new FlowError("Could not prepare the Base payment.", 500);
    record.typedData = toJson(built.typedData);
    forPage = {
      family: "evm",
      typedData: serializeTypedData({
        ...built.typedData,
        types: { EIP712Domain: getTypesForEIP712Domain({ domain: built.typedData.domain }), ...built.typedData.types },
      }),
    };
  }
  await deps.store.set(K.build(id), record, BUILD_TTL_S);
  const remaining = Math.max(BUILD_TTL_S, Math.ceil((rec.expiresAt - Date.now()) / 1000));
  await deps.store.set(K.pending(id), { ...rec, state: "signing" }, remaining);
  return payToChanged ? { ...forPage, payTo: rec.payTo, payto_changed: payToChanged } : forPage;
}

function ed25519Key(addr: string) {
  return createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(getBase58Encoder().encode(addr))]),
    format: "der",
    type: "spki",
  });
}

/** Puts the wallet's signature into the built payment after checking it is the owner's, over exactly this payment. */
export const LIGHTHOUSE_PROGRAM = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";
const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

export interface SolanaPaymentExpectation {
  payer: string;
  feePayer: string;
  payTo: string;
  asset: string;
  amount: string;
  memo?: string;
}

async function ataOf(owner: string, mint: string, tokenProgram: string): Promise<string> {
  const enc = getAddressEncoder();
  const [pda] = await getProgramDerivedAddress({
    programAddress: solAddress(ATA_PROGRAM),
    seeds: [enc.encode(solAddress(owner)), enc.encode(solAddress(tokenProgram)), enc.encode(solAddress(mint))],
  });
  return pda;
}

/**
 * Checks the transaction the wallet signed by its outcome, as the x402 exact SVM scheme does,
 * not by comparing it with the one we built (wallets such as Phantom add their own instructions):
 *  - no address lookup tables (every account must be visible; §2.1.2),
 *  - only the payer and the facilitator sign, and the facilitator is the fee payer (§2.1.4),
 *  - the facilitator appears in no instruction (§2.1.1),
 *  - exactly one TransferChecked, and it is the payment shown to the user: this mint, from the payer,
 *    to payTo's token account, for exactly this amount (§1.2, §1.4),
 *  - every other instruction is a compute-budget limit/price, a memo or Lighthouse (the programs the
 *    reference facilitator accepts for standard wallets, §2.2.1, §3.1), so nothing else can touch the
 *    payer's funds; with extra.memo, exactly one memo carrying it (§3.1).
 * Returns the reason when it fails.
 */
/**
 * What the wallet changed between the transaction we built and the one it signed: the transaction
 * version, the recent blockhash and the number of instructions, e.g.
 * "version 0 → 0 · blockhash replaced · instructions 4 → 8". Adding instructions (Lighthouse) and
 * replacing the blockhash are separate changes and are reported separately.
 */
function readSolanaMessage(bytes: Uint8Array) {
  try {
    const m: any = getCompiledTransactionMessageDecoder().decode(bytes);
    return { version: String(m.version), blockhash: String(m.lifetimeToken ?? ""), count: m.instructions?.length ?? m.numInstructions ?? "?" };
  } catch {
    return null;
  }
}

/** The recent blockhash of the transaction we built and of the one the wallet signed, to look up later. */
export function solanaBlockhashes(built: Uint8Array, signed: Uint8Array): { built: string | null; signed: string | null } {
  return { built: readSolanaMessage(built)?.blockhash || null, signed: readSolanaMessage(signed)?.blockhash || null };
}

export function solanaWalletChanges(built: Uint8Array, signed: Uint8Array): string {
  const a = readSolanaMessage(built);
  const b = readSolanaMessage(signed);
  if (!a || !b) return "unreadable";
  return [
    `version ${a.version} → ${b.version}`,
    a.blockhash === b.blockhash ? "blockhash kept" : "blockhash replaced",
    `instructions ${a.count} → ${b.count}`,
  ].join(" · ");
}

/** What a signed Solana transaction contains, for error messages: each instruction's program, first data byte and whether it reads the fee payer. */
export function describeSolanaMessage(message: Uint8Array, feePayer: string): string {
  try {
    const m: any = getCompiledTransactionMessageDecoder().decode(message);
    if (!Array.isArray(m.instructions)) return `version ${m.version}, ${m.numInstructions ?? "?"} instructions`;
    const keys: string[] = m.staticAccounts;
    return m.instructions
      .map((ix: any, i: number) => {
        const program = keys[ix.programAddressIndex];
        const name =
          { [COMPUTE_BUDGET_PROGRAM]: "budget", [MEMO_PROGRAM]: "memo", [LIGHTHOUSE_PROGRAM]: "lighthouse", [TOKEN_PROGRAM]: "token", [TOKEN_2022_PROGRAM]: "token2022" }[program] ??
          program.slice(0, 8);
        const reads = (ix.accountIndices ?? []).some((k: number) => keys[k] === feePayer) ? "+feePayer" : "";
        return `${i}:${name}(${ix.data?.[0] ?? "-"})${reads}`;
      })
      .join(" ");
  } catch {
    return "unreadable";
  }
}

export async function solanaPaymentProblem(message: Uint8Array, want: SolanaPaymentExpectation): Promise<string | null> {
  let m: any;
  try {
    m = getCompiledTransactionMessageDecoder().decode(message);
  } catch {
    return "the transaction could not be read";
  }
  if (!Array.isArray(m.instructions)) return `the wallet returned a version ${m.version} transaction, which this check cannot read`;
  const keys: string[] = m.staticAccounts;
  if (m.addressTableLookups?.length) return "it uses address lookup tables";
  if (keys[0] !== want.feePayer) return "the fee payer is not the facilitator";
  const signers = keys.slice(0, m.header.numSignerAccounts);
  if (signers.length !== 2 || !signers.includes(want.payer)) return "it needs signers other than you and the facilitator";

  let transfers = 0;
  const memos: string[] = [];
  for (const ix of m.instructions) {
    const program = keys[ix.programAddressIndex];
    const accounts: string[] = (ix.accountIndices ?? []).map((i: number) => keys[i]);
    const data = Buffer.from(ix.data ?? []);
    if (program === want.feePayer) return "the facilitator is called as a program";
    if (program === LIGHTHOUSE_PROGRAM) {
      // Only Lighthouse assertions (first byte 2..17) may be added; MemoryWrite (0), MemoryClose (1),
      // empty and unknown variants can change state and are refused (x402 exact SVM spec, guard
      // instructions). Phantom's assertions may read the fee payer (to check it keeps its SOL). They
      // cannot move funds, so they are let through: whether the facilitator accepts them is its own
      // policy, and facilitators differ.
      if (data.length === 0 || data[0] < 2 || data[0] > 17) return "it has a Lighthouse instruction that is not an assertion";
      continue;
    }
    if (accounts.includes(want.feePayer)) return "the facilitator appears in an instruction";
    if (program === COMPUTE_BUDGET_PROGRAM) {
      if (data[0] !== 2 && data[0] !== 3) return "it has a compute-budget instruction other than limit/price";
      continue;
    }
    if (program === MEMO_PROGRAM) {
      memos.push(data.toString("utf8"));
      continue;
    }
    if (program === TOKEN_PROGRAM || program === TOKEN_2022_PROGRAM) {
      if (data[0] !== 12 || data.length !== 10 || accounts.length < 4) return "it has a token instruction other than the payment";
      const [, mint, dest, authority] = accounts;
      const amount = data.readBigUInt64LE(1).toString();
      if (mint !== want.asset || authority !== want.payer || amount !== want.amount || dest !== (await ataOf(want.payTo, want.asset, program))) {
        return "it has a token transfer that is not the payment shown";
      }
      transfers++;
      continue;
    }
    return `it calls a program that is not allowed (${program})`;
  }
  if (transfers !== 1) return transfers ? "it pays more than once" : "it has no payment";
  if (want.memo !== undefined && (memos.length !== 1 || memos[0] !== want.memo)) return "the seller's memo is missing";
  return null;
}

/**
 * Some wallets return the recovery id v as 0/1; the USDC contract (ecrecover) and facilitators expect
 * 27/28. Other values are left as they are.
 */
export function normalizeEvmSignature(signature: string): string {
  const v = parseInt(signature.slice(-2), 16);
  return v === 0 || v === 1 ? signature.slice(0, -2) + (v + 27).toString(16) : signature;
}

/** What was signed and sent on Base: the typed data given to the wallet, the signature's v and the authorization sent to the seller. */
export function evmPaymentRecord(typedDataJson: string, payment: ExactPayment) {
  const p = (payment.payload as any)?.payload ?? {};
  const sig = typeof p.signature === "string" ? p.signature : "";
  return {
    typed_data: fromJson<any>(typedDataJson),
    signature_v: sig.length === 132 ? parseInt(sig.slice(-2), 16) : null,
    authorization: p.authorization ?? null,
  };
}

async function attachSignature(b: BuildRecord, payer: string, signature: string, signedTx?: string, want?: SolanaPaymentExpectation): Promise<ExactPayment> {
  const payload = fromJson<Record<string, any>>(b.payload);
  if (b.family === "solana") {
    let sig: Uint8Array;
    try {
      sig = new Uint8Array(getBase58Encoder().encode(signature));
    } catch {
      throw new FlowError("Could not read the wallet's signature. Nothing was paid.");
    }
    const built = getTransactionDecoder().decode(new Uint8Array(getBase64Encoder().encode(payload.payload.transaction)));
    if (getBase64Decoder().decode(built.messageBytes) !== b.messageBytes) throw new FlowError("This does not match the prepared payment. Nothing was paid.", 500);
    // The transaction the wallet actually signed (wallets may add their own instructions), checked by its outcome.
    let tx = built;
    if (signedTx) {
      try {
        tx = getTransactionDecoder().decode(new Uint8Array(getBase64Encoder().encode(signedTx)));
      } catch {
        throw new FlowError("Could not read the transaction the wallet returned. Nothing was paid.");
      }
    }
    const changes = solanaWalletChanges(new Uint8Array(built.messageBytes), new Uint8Array(tx.messageBytes));
    const problem = await solanaPaymentProblem(new Uint8Array(tx.messageBytes), want!);
    if (problem) {
      const shape = describeSolanaMessage(new Uint8Array(tx.messageBytes), want!.feePayer);
      const bh = solanaBlockhashes(new Uint8Array(built.messageBytes), new Uint8Array(tx.messageBytes));
      console.log(`[agentpay402] refused signed payment: ${problem} | ${changes} | blockhash ${bh.built} → ${bh.signed} | ${shape}`);
      throw new FlowError(`The signed transaction does not match the payment shown (${problem} | ${changes} | ${shape}). Nothing was paid.`);
    }
    if (sig.length !== 64 || !verify(null, new Uint8Array(tx.messageBytes), ed25519Key(payer), sig)) {
      throw new FlowError("This is not the chosen wallet's signature for this payment. Nothing was paid.");
    }
    const signers: Record<string, unknown> = {};
    for (const k of Object.keys(tx.signatures)) signers[k] = k === payer ? sig : null;
    payload.payload.transaction = getBase64Decoder().decode(getTransactionEncoder().encode({ ...tx, signatures: signers } as any));
  } else {
    if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new FlowError("Could not read the wallet's signature. Nothing was paid.");
    signature = normalizeEvmSignature(signature);
    const td = fromJson<any>(b.typedData!);
    const recovered = await recoverTypedDataAddress({ ...td, signature: signature as `0x${string}` });
    if (getAddress(recovered) !== getAddress(payer)) {
      throw new FlowError("This is not the chosen wallet's signature. Nothing was paid.");
    }
    payload.payload.signature = signature;
  }
  return { headers: new x402HTTPClient(new x402Client()).encodePaymentSignatureHeader(payload as any), payload };
}

export async function signAndPay(id: string, token: string | null, signature: string, deps: FlowDeps, signedTx?: string) {
  const signedAt = Date.now();
  const rec = await pendingFor(id, token, deps);
  const b = await deps.store.get<BuildRecord>(K.build(id));
  if (!b) throw new FlowError("The payment is not prepared, or too much time has passed. Press again.", 409);
  const prepForCheck = fromJson<Prepared>(b.prep);
  const extra = (prepForCheck.selected.raw as { extra?: { feePayer?: string; memo?: string } }).extra ?? {};
  const want: SolanaPaymentExpectation | undefined =
    b.family === "solana"
      ? { payer: rec.payer, feePayer: String(extra.feePayer ?? ""), payTo: rec.payTo, asset: rec.asset, amount: rec.amount, memo: extra.memo }
      : undefined;
  const payment = await attachSignature(b, rec.payer, signature, signedTx, want);

  // At most once per request id, from here on.
  if (!(await deps.store.setIfAbsent(K.lock(id), Date.now(), LOCK_TTL_S))) throw new FlowError("This payment is being processed.", 409);
  const prep = fromJson<Prepared>(b.prep);
  const requester = await requesterFor(rec.params, deps);
  let result: Record<string, any>;
  const sentAt = Date.now();
  // Kept until the outcome is known, so it can be settled from the chain if this request never finishes.
  let payerKey: PayerKey | null = null;
  try {
    payerKey = payerKeyOf(payment.payload, prep.selected, rec.payer);
  } catch {
    payerKey = null;
  }
  const sent: SentRecord = {
    rec,
    payerKey: payerKey ? toJson(payerKey) : null,
    priceMicros: String(prep.selected.priceMicros ?? 0n),
    sentAt,
    landBy: landDeadline(b, payment),
  };
  await deps.store.set(K.sent(id), sent, SENT_TTL_S);
  let failed: Record<string, any> | null = null;
  try {
    result = await requester.payPrepared(prep, payment);
  } catch (err) {
    // Sent, but no answer (timeout or network error): never re-send; the chain decides below.
    failed = { message: `${(err as Error).message}`, ...(err instanceof PaymentError ? err.details : {}) };
    result = { url: rec.input.url, status: "processing", paid: null, settlement: "unknown", ...failed };
  }
  if (b.family === "evm" && b.typedData) {
    result.evm_payment = JSON.parse(JSON.stringify(evmPaymentRecord(b.typedData, payment), (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
    console.log(`[agentpay402] evm payment ${JSON.stringify({ id, status: result.status, refusal_reason: result.refusal_reason, ...result.evm_payment })}`);
  }
  const iso = (t?: number) => (t ? new Date(t).toISOString() : null);
  // When each step happened, to tell where a slow payment spent its time.
  result.timing = { built_at: iso(b.builtAt), signed_at: iso(signedAt), sent_at: iso(sentAt), result_at: iso(Date.now()) };
  if (want) {
    const builtMsg = new Uint8Array(getBase64Encoder().encode(b.messageBytes!));
    result.signed_transaction_shape = describeSolanaMessage(signedMessageOf(payment), want.feePayer);
    result.wallet_changes = solanaWalletChanges(builtMsg, signedMessageOf(payment));
    result.blockhash = solanaBlockhashes(builtMsg, signedMessageOf(payment));
  }
  if (failed) {
    const { url: _u, status: _s, paid: _p, settlement: _st, ...diagnostics } = result;
    await deps.store.set(K.sent(id), { ...sent, diagnostics }, SENT_TTL_S);
    result = { ...diagnostics, ...(await resolveSent(id, deps, true)) };
    return {
      status: result.status,
      paid: result.paid,
      explorer: result.tx?.explorer ?? null,
      message: result.message,
      wallet_changes: result.wallet_changes,
      blockhash: result.blockhash,
      evm_payment: result.evm_payment,
      timing: result.timing,
    };
  }
  if (result.paid !== false) await addSpent(deps.store, rec.payer, BigInt(prep.selected.priceMicros ?? 0n));
  await finishWith(rec, result, deps);
  return {
    status: result.status,
    paid: result.paid,
    explorer: result.tx?.explorer ?? null,
    message: result.message,
    seller_error: result.status === "rejected_by_seller" ? sellerError(result.body) : undefined,
    signed_transaction_shape: result.signed_transaction_shape,
    wallet_changes: result.wallet_changes,
    blockhash: result.blockhash,
    evm_payment: result.evm_payment,
    refusal_reason: result.refusal_reason,
    timing: result.timing,
  };
}

interface SentRecord {
  rec: PendingRecord;
  /** bigint-safe JSON of the PayerKey, or null if it could not be read. */
  payerKey: string | null;
  priceMicros: string;
  sentAt: number;
  /** After this (ms), the payment can no longer land on chain. */
  landBy: number;
  diagnostics?: Record<string, unknown>;
}

/** When a sent payment stops being able to land: EIP-3009 validBefore, or the Solana blockhash's lifetime from when it was built. */
function landDeadline(b: BuildRecord, payment: ExactPayment): number {
  if (b.family === "evm") {
    const vb = Number((payment.payload as any)?.payload?.authorization?.validBefore);
    if (Number.isFinite(vb) && vb > 0) return vb * 1000;
  }
  return (b.builtAt ?? Date.now()) + SOLANA_LAND_WINDOW_MS;
}

/** The longest the sign request can run (app/api/approve route maxDuration); after it, nothing else will finish this payment. */
const SIGN_REQUEST_MAX_MS = 120_000;

/**
 * Settles a payment that was sent but has no result (the seller never answered, or the request that sent
 * it ended): a transfer on chain → not_delivered (paid); none and it can no longer land → no_response
 * (not paid); otherwise still processing. `now` is true when the sending request itself is asking.
 */
async function resolveSent(id: string, deps: FlowDeps, now = false): Promise<Record<string, any> | null> {
  const s = await deps.store.get<SentRecord>(K.sent(id));
  if (!s) return null;
  const t = Date.now();
  const waiting = (message: string) => ({ status: "processing", paid: null, message });
  // While the sending request may still be running, it finishes the payment itself.
  if (!now && t - s.sentAt < SIGN_REQUEST_MAX_MS) return waiting("The payment was sent; waiting for the seller's answer.");
  if (!(await deps.store.setIfAbsent(`ap:x:${id}`, t, 60))) return waiting("The payment's outcome is being checked.");
  try {
    const base = { url: s.rec.input.url, ...s.diagnostics };
    if (!s.payerKey) {
      const result = { ...base, status: "not_delivered", paid: null, settlement: "unknown", message: "The seller did not answer and the payment could not be looked up on chain. It was not re-sent and is counted as spent." };
      await addSpent(deps.store, s.rec.payer, BigInt(s.priceMicros));
      await finishWith(s.rec, result, deps);
      return result;
    }
    const key = fromJson<PayerKey>(s.payerKey);
    const find = deps.requesterOverrides?.findPayment ?? ((k: PayerKey, h: string | null) => defaultFindPayment(k, h, { attempts: 1 }));
    const chain: ChainResult = await find(key, null);
    if (chain.settlement === "verified") {
      const tx = chain.tx ? { network: s.rec.network, tx: chain.tx, explorer: CHAINS[s.rec.network]?.explorerTx(chain.tx) } : null;
      const result = { ...base, status: "not_delivered", paid: true, settlement: "verified", tx, message: "The seller did not answer, but the transfer is on chain: paid and not delivered." };
      await addSpent(deps.store, s.rec.payer, BigInt(s.priceMicros));
      await finishWith(s.rec, result, deps);
      return result;
    }
    if (chain.settlement === "not_found" && t > s.landBy) {
      const result = { ...base, status: "no_response", paid: false, settlement: "not_found", message: "The seller did not answer and no transfer is on chain; the payment can no longer land. Nothing was paid." };
      await finishWith(s.rec, result, deps);
      return result;
    }
    return waiting(`The seller did not answer. No transfer on chain yet; it can still land until ${new Date(s.landBy).toISOString()}. Ask again after that.`);
  } finally {
    await deps.store.del(`ap:x:${id}`);
  }
}

function signedMessageOf(payment: ExactPayment): Uint8Array {
  const tx = getTransactionDecoder().decode(new Uint8Array(getBase64Encoder().encode(payment.payload.payload.transaction)));
  return new Uint8Array(tx.messageBytes);
}

/** The seller's / facilitator's reason from a 402 body, if it gives one. */
function sellerError(body: unknown): string | undefined {
  if (typeof body !== "string") return undefined;
  try {
    const j = JSON.parse(body);
    return typeof j.error === "string" ? j.error.slice(0, 300) : undefined;
  } catch {
    return undefined;
  }
}

export { describeRequirement };
