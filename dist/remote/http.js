import { createMcpHandler, getPublicOrigin } from "mcp-handler";
import { z } from "zod";
import { VERSION } from "../server.js";
import { registerReadOnlyTools, requestShape, ResultError, run } from "../tools.js";
import { PaymentError } from "../x402/request.js";
import { messagePage, approvalPage } from "./page.js";
import { ParamError, parseParams } from "./params.js";
import { FlowError, buildPayment, getResult, pageRecord, rejectPayment, requesterFor, requestPayment, signAndPay, } from "./payments.js";
import { getStore } from "./store.js";
import { AddressWallet } from "./wallet.js";
/**
 * Web-standard handlers for the remote server, mounted by the Next.js route files in app/:
 *   /api/mcp                       MCP (Streamable HTTP)
 *   /approve/<id>?t=<token>        approval page
 *   /api/approve/<id>/<action>     build | sign | reject (called by the page)
 */
async function deps() {
    return { store: await getStore() };
}
async function registerTools(server, params, origin, d) {
    const register = (name, config, cb) => server.registerTool(name, config, cb);
    // Read-only tools: the same as the local server's, with this owner's settings.
    registerReadOnlyTools(register, { provider: new AddressWallet(params), requester: await requesterFor(params, d), payTool: "request_x402_payment" });
    register("request_x402_payment", {
        title: "Request an x402 payment (approval link)",
        description: "Starts a payment for an x402 API and returns an approval link. Nothing is paid until the user opens the link and signs in their own " +
            "wallet (Phantom on Solana, Rabby / MetaMask on Base). First it runs every pre-payment check: the owner's per-payment and 24-hour " +
            "limits, the seller's Seller Probe record, required input, the Bazaar price and networks the seller refused recently; if one fails it " +
            "returns status `blocked` with the reason and no link. Otherwise it returns approve_url, phantom_app_url (to approve on a phone in the " +
            "Phantom app), request_id and expires_at (5 minutes). Show approve_url to the user as a link, then call get_x402_result with request_id " +
            "after the user says they approved. THIS LEADS TO SPENDING MONEY once the user signs.",
        inputSchema: requestShape,
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    }, async (args) => run(async () => {
        const r = await requestPayment(params, args, origin, d);
        if (r?.status === "blocked")
            throw new ResultError(r);
        return r;
    }));
    register("get_x402_result", {
        title: "Get x402 payment result",
        description: "Returns the outcome of a payment started with request_x402_payment: awaiting_approval, processing, or the final result " +
            "(fulfilled, not_delivered, recovered_by_retry, blocked, rejected_by_seller) with the API response body, the transaction found on chain " +
            "and the Delivery Receipt check; expired if the link was never approved. Call it after the user says they approved. A request id is " +
            "never paid twice, so calling this again is safe. Read-only.",
        inputSchema: { request_id: z.string().describe("request_id returned by request_x402_payment") },
        annotations: { readOnlyHint: true, openWorldHint: false },
    }, async ({ request_id }) => run(() => getResult(request_id, d)));
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
export async function handleMcp(req) {
    let params;
    try {
        params = parseParams(new URL(req.url));
    }
    catch (err) {
        if (err instanceof ParamError)
            return json({ error: err.message }, 400);
        throw err;
    }
    const d = await deps();
    const origin = getPublicOrigin(req);
    const handler = createMcpHandler((server) => registerTools(server, params, origin, d), {
        serverInfo: { name: "agentpay402", version: VERSION },
    });
    return handler(req);
}
const htmlHeaders = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
};
export async function handleApprovePage(req, id) {
    const url = new URL(req.url);
    try {
        const rec = await pageRecord(id, url.searchParams.get("t"), await deps());
        return new Response(approvalPage(rec, getPublicOrigin(req)), { headers: htmlHeaders });
    }
    catch (err) {
        if (err instanceof FlowError)
            return new Response(messagePage("このリンクは使えません", err.message), { status: err.status, headers: htmlHeaders });
        throw err;
    }
}
export async function handleApproveAction(req, id, action) {
    let body;
    try {
        body = await req.json();
    }
    catch {
        return json({ error: "bad request" }, 400);
    }
    const d = await deps();
    try {
        if (action === "build")
            return json(await buildPayment(id, body.t ?? null, d, body.payer));
        if (action === "sign") {
            return json(await signAndPay(id, body.t ?? null, String(body.signature ?? ""), d, typeof body.signedTx === "string" ? body.signedTx : undefined));
        }
        if (action === "reject")
            return json(await rejectPayment(id, body.t ?? null, d));
        return json({ error: "unknown action" }, 404);
    }
    catch (err) {
        if (err instanceof FlowError)
            return json({ error: err.message }, err.status);
        if (err instanceof PaymentError)
            return json({ error: err.message }, 502);
        console.error("[agentpay402]", err);
        return json({ error: "エラーが起きました。" }, 500);
    }
}
