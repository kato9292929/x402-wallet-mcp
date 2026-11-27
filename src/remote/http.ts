import { createMcpHandler, getPublicOrigin } from "mcp-handler";
import { z } from "zod";
import { VERSION } from "../server.js";
import { registerReadOnlyTools, requestShape, ResultError, run } from "../tools.js";
import { PaymentError } from "../x402/request.js";
import { messagePage, approvalPage } from "./page.js";
import { REMOTE_INSTRUCTIONS } from "../instructions.js";
import { clientOf, isInitialize, newSessionId, rateLimitedResult, statKey, takeCall, takeSession } from "./limits.js";
import { ParamError, parseParams, type RemoteParams } from "./params.js";
import {
  FlowError,
  buildPayment,
  buyData,
  getResult,
  pageRecord,
  rejectPayment,
  requesterFor,
  requestPayment,
  signAndPay,
  type FlowDeps,
} from "./payments.js";
import { getStore } from "./store.js";
import { AddressWallet } from "./wallet.js";

/**
 * Web-standard handlers for the remote server, mounted by the Next.js route files in app/:
 *   /api/mcp                       MCP (Streamable HTTP)
 *   /approve/<id>?t=<token>        approval page
 *   /api/approve/<id>/<action>     build | sign | reject (called by the page)
 */

async function deps(): Promise<FlowDeps> {
  return { store: await getStore() };
}

/** Tools that fetch a seller's 402: limited per caller, so a flood of calls does not reach sellers. */
const RATE_LIMITED_TOOLS = new Set(["request_x402_payment", "buy_data", "check_payment_requirements", "check_seller"]);

async function registerTools(server: any, params: RemoteParams, origin: string, d: FlowDeps) {
  const register = (name: string, config: any, cb: (args: any) => Promise<any>) =>
    server.registerTool(
      name,
      config,
      RATE_LIMITED_TOOLS.has(name) && d.client
        ? async (args: any) => {
            await d.store.incr(statKey(Date.now(), d.client!.bySession), 1, 3 * 86400).catch(() => 0);
            const r = await takeCall(d.store, d.client!);
            if (!r.ok) return run(async () => { throw new ResultError(rateLimitedResult(r)); });
            return cb(args);
          }
        : cb,
    );
  // Read-only tools: the same as the local server's, with this owner's settings.
  registerReadOnlyTools(register, { provider: new AddressWallet(params), requester: await requesterFor(params, d), payTool: "request_x402_payment" });

  register(
    "request_x402_payment",
    {
      title: "Request an x402 payment (approval link)",
      description:
        "Use to buy one response from a paid API once the endpoint is known (to go from a description of the data to a link in one call, use " +
        "buy_data). Starts a payment for the x402 API and returns an approval link. Nothing is paid until the user opens the link and signs in " +
        "their own wallet (Phantom on Solana, Rabby / MetaMask on Base). First it runs every pre-payment check: the owner's per-payment and 24-hour " +
        "limits, the seller's Seller Probe record, required input, the Bazaar price, networks the seller refused recently, a Solana " +
        "facilitator known to refuse Phantom-signed transactions (facilitator_incompatible) and whether the seller's Solana address can " +
        "receive the token (payto_account_missing); if one fails it returns status `blocked` with the reason, a `detail` to explain to the " +
        "user (what happened, whose side, what to do next) and no link. When the checks pass it returns approve_url, payment.chain and " +
        "payment.sign_with (the wallet to sign in), phantom_app_url for Solana (to approve on a phone in the Phantom app), request_id, " +
        "expires_at (5 minutes) and show_user: text for the user (how to pay, that the result is kept 30 minutes, and the notice with the " +
        "terms link), to show as is, translated into the user's language. " +
        "Any connection pays on Solana and Base. Show approve_url to the user as a link, then call get_x402_result with request_id " +
        "after the user says they approved. This tool moves no money itself: the payment happens only when the user signs the approval link in their own wallet.",
      inputSchema: {
        ...requestShape,
        allow_incompatible_facilitator: z
          .boolean()
          .optional()
          .describe("Default false. true pays even through a Solana facilitator known to refuse Phantom-signed transactions (for testing it)."),
        network: z
          .enum(["base", "solana"])
          .optional()
          .describe("Pay on this network only. Omit to let AgentPay pick the network the payment is known to go through"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ allow_incompatible_facilitator, network, ...args }: any) =>
      run(async () => {
        const input = { ...args, ...(allow_incompatible_facilitator ? { allowIncompatibleFacilitator: true } : {}), ...(network ? { network } : {}) };
        const r = await requestPayment(params, input, origin, d);
        if (r?.status === "blocked") throw new ResultError(r);
        return r;
      }),
  );

  register(
    "buy_data",
    {
      title: "Buy data from a paid API (approval link)",
      description:
        "Use when the user wants data from a paid API and names the provider or the kind of data (e.g. \"nansen smart money netflow\", " +
        "\"btc price\", \"sec filings aapl\"). Pass the input from the user's request in body / query_params (the token, ticker, address, chain " +
        "or period they named). In one call it searches the Bazaar, picks the best-matching endpoint this connection can pay within the " +
        "per-payment limit (and max_price_usd), skipping sellers whose latest Seller Probe purchase failed or was refused, runs every " +
        "pre-payment check of request_x402_payment and returns the same approval link and show_user, with which endpoint was chosen, its " +
        "price and the input used (chosen). If the endpoint requires input the request does not give, it prepares nothing and returns " +
        "status `confirm_input` with the fields needed and the API's example values as suggestions: fill them from the user's words or ask " +
        "the user, then call again (use_example: true only if the user accepts the example values; then show_user starts with those " +
        "conditions). When several endpoints cannot be told apart it returns status `choose` with the top three candidates: pick one and call " +
        "request_x402_payment. This tool moves no money: it only creates an approval link, and the payment happens when the user signs it " +
        "in their own wallet.",
      inputSchema: {
        query: z
          .string()
          .min(2)
          .describe('Short English keywords for the data: the provider and/or kind of data, e.g. "nansen smart money netflow", "btc price"'),
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional().describe("HTTP method, if the user or the API documentation says"),
        body: z
          .union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())])
          .optional()
          .describe("Request body built from the user's request (e.g. the token or address they asked about). Omit to use the Bazaar's example"),
        query_params: z.record(z.string(), z.string()).optional().describe('Query parameters from the user\'s request, e.g. {"ticker": "AAPL"}'),
        max_price_usd: z.string().optional().describe('Highest price per request to consider, e.g. "0.02" (never above the owner\'s limit)'),
        network: z
          .enum(["base", "solana"])
          .optional()
          .describe("Pay on this network only. Omit to let AgentPay pick the network the payment is known to go through"),
        use_example: z
          .boolean()
          .optional()
          .describe("Default false. true fills required input the user did not give with the API's example values; only when the user agreed to them"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args: any) =>
      run(async () => {
        const r: any = await buyData(params, args, origin, d);
        if (r?.status === "blocked") throw new ResultError(r);
        return r;
      }),
  );

  register(
    "get_x402_result",
    {
      title: "Get x402 payment result",
      description:
        "Returns the outcome of a payment started with request_x402_payment: awaiting_approval, processing, or the final result " +
        "(fulfilled, not_delivered, recovered_by_retry, blocked, rejected_by_seller, no_response) with the API response body, the transaction found on chain " +
        "and the Delivery Receipt check; expired if the link was never approved. When the seller never answered a sent payment, it settles the " +
        "outcome from the chain: not_delivered if the transfer landed, no_response if it did not and can no longer land (nothing paid), " +
        "otherwise processing. Call it after the user says they approved. A request id is never paid twice, so calling this again is safe. " +
        "It never pays.",
      inputSchema: { request_id: z.string().describe("request_id returned by request_x402_payment") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ request_id }: { request_id: string }) => run(() => getResult(request_id, d)),
  );
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export async function handleMcp(req: Request): Promise<Response> {
  let params: RemoteParams;
  try {
    params = parseParams(new URL(req.url));
  } catch (err) {
    if (err instanceof ParamError) return json({ error: err.message }, 400);
    throw err;
  }
  const d: FlowDeps = { ...(await deps()), client: clientOf(req) };
  const origin = getPublicOrigin(req);
  const handler = createMcpHandler((server) => registerTools(server, params, origin, d), {
    serverInfo: { name: "agentpay402", version: VERSION },
    instructions: REMOTE_INSTRUCTIONS,
  } as any);
  // Issue a signed MCP session id at initialize (the server keeps no session state): clients send it back on
  // every request, so limits can be counted per connection rather than per IP, which many Claude.ai users
  // share. Ids are limited per IP; over that, no id is issued and the caller is counted by IP.
  const issue =
    req.method === "POST" &&
    !d.client!.bySession &&
    isInitialize(await req.clone().text()) &&
    (await takeSession(d.store, d.client!));
  const res = await handler(req);
  if (!issue || !res.ok) return res;
  const headers = new Headers(res.headers);
  headers.set("mcp-session-id", newSessionId());
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

const htmlHeaders = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

export async function handleApprovePage(req: Request, id: string): Promise<Response> {
  const url = new URL(req.url);
  try {
    const rec = await pageRecord(id, url.searchParams.get("t"), await deps());
    return new Response(approvalPage(rec, getPublicOrigin(req)), { headers: htmlHeaders });
  } catch (err) {
    if (err instanceof FlowError) return new Response(messagePage("This link cannot be used", err.message), { status: err.status, headers: htmlHeaders });
    throw err;
  }
}

export async function handleApproveAction(req: Request, id: string, action: string): Promise<Response> {
  let body: { t?: string; signature?: string; payer?: string; signedTx?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad request" }, 400);
  }
  const d = await deps();
  try {
    if (action === "build") return json(await buildPayment(id, body.t ?? null, d, body.payer));
    if (action === "sign") {
      return json(await signAndPay(id, body.t ?? null, String(body.signature ?? ""), d, typeof body.signedTx === "string" ? body.signedTx : undefined));
    }
    if (action === "reject") return json(await rejectPayment(id, body.t ?? null, d));
    return json({ error: "unknown action" }, 404);
  } catch (err) {
    if (err instanceof FlowError) return json({ error: err.message }, err.status);
    if (err instanceof PaymentError) return json({ error: err.message }, 502);
    console.error("[agentpay402]", err);
    return json({ error: "Something went wrong." }, 500);
  }
}

/**
 * Share of today's and yesterday's tool calls (those that reach sellers) that came with a session id this
 * server issued. Only two counters per day are kept, no ids or IPs; the counts themselves are not shown.
 */
export async function handleSessionStats(): Promise<Response> {
  const d = await deps();
  const day = 86400_000;
  const out = [];
  for (const t of [Date.now(), Date.now() - day]) {
    const withS = Number((await d.store.get(statKey(t, true))) ?? 0);
    const without = Number((await d.store.get(statKey(t, false))) ?? 0);
    const total = withS + without;
    out.push({ date: new Date(t).toISOString().slice(0, 10), with_session_pct: total ? Math.round((withS / total) * 100) : null });
  }
  return json({ days: out });
}
