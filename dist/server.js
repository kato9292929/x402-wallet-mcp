import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getResourceDetails, listBazaarResources } from "./bazaar.js";
import { CHAINS, normalizeNetwork } from "./chains.js";
import { configPath, configSources, loadConfig, paymentLogPath, schemePriority } from "./config.js";
import { SpendGuard, SpendLimitError } from "./limits.js";
import { NeverminedPayer, neverminedConfigured, neverminedEnvironment } from "./nevermined.js";
import { PaymentError, X402Requester } from "./x402/request.js";
export const VERSION = "0.4.0";
export const TOOL_NAMES = [
    "get_wallet_address",
    "get_wallet_balance",
    "show_wallet_app",
    "check_sign_in_status",
    "list_bazaar_resources",
    "get_resource_details",
    "make_x402_request",
    "check_payment_requirements",
    "check_seller",
];
/** Carries a full result that should be returned with isError: true. */
class ResultError extends Error {
    result;
    constructor(result) {
        super("result");
        this.result = result;
    }
}
function ok(data) {
    return { content: [{ type: "text", text: JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) }] };
}
function fail(err) {
    if (err instanceof ResultError)
        return { ...ok(err.result), isError: true };
    const e = err;
    const payload = { error: e.message ?? String(err) };
    if (err instanceof SpendLimitError) {
        payload.code = e.code;
        payload.paid = false;
    }
    if (err instanceof PaymentError)
        Object.assign(payload, e.details);
    return { ...ok(payload), isError: true };
}
async function run(fn) {
    try {
        return ok(await fn());
    }
    catch (err) {
        return fail(err);
    }
}
const NO_WALLET = "No wallet is configured (WALLET_PROVIDER=none). Set WALLET_PROVIDER to cdp, privy or crossmint with its credentials.";
const requestShape = {
    url: z.string().url().describe("Full https URL of the x402 endpoint, including any query parameters the service requires"),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]).optional().describe("HTTP method to call the endpoint with; use the method the service documents (default GET)"),
    headers: z.record(z.string(), z.string()).optional().describe("Extra request headers to send, e.g. {\"accept\": \"application/json\"}; payment headers are added automatically"),
    body: z
        .union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())])
        .optional()
        .describe("Request body for POST/PUT/PATCH; objects and arrays are sent as JSON with content-type application/json"),
};
export function createServer(opts) {
    const provider = opts.provider;
    const guard = opts.guard ?? new SpendGuard();
    const requester = new X402Requester({
        provider,
        guard,
        nevermined: new NeverminedPayer(),
        fetch: opts.fetch,
    });
    const server = new McpServer({ name: "agentpay402-mcp", version: VERSION });
    const pickChains = (chain) => {
        if (!provider)
            throw new Error(NO_WALLET);
        if (!chain)
            return provider.chains();
        const c = normalizeNetwork(chain);
        if (!provider.chains().includes(c)) {
            throw new Error(`${provider.id} wallet does not support ${c} right now. Supported: ${provider.chains().join(", ")}`);
        }
        return [c];
    };
    const chainArg = z
        .string()
        .optional()
        .describe('CAIP-2 chain id, e.g. "eip155:84532" (Base Sepolia) or "eip155:8453" (Base). Omit for all chains.');
    // ---------------------------------------------------------------- wallet tools
    server.registerTool("get_wallet_address", {
        title: "Get wallet address",
        description: "Returns the address of the configured wallet on each chain it can pay on (CAIP-2 ids such as eip155:84532 for Base Sepolia). " +
            "Use it to tell the user where to send funds or which address will appear as the payer. Read-only: looks the address up with the " +
            "wallet provider and moves no money. Fails with a clear message when no wallet is configured (WALLET_PROVIDER=none).",
        inputSchema: { chain: chainArg },
        annotations: { readOnlyHint: true },
    }, async ({ chain }) => run(async () => {
        const chains = pickChains(chain);
        const addresses = await Promise.all(chains.map(async (c) => ({ chain: c, name: CHAINS[c]?.name, address: await provider.address(c) })));
        return { provider: provider.id, addresses };
    }));
    server.registerTool("get_wallet_balance", {
        title: "Get wallet balance",
        description: "Returns the wallet's USDC balance on each supported chain (and other tokens the provider reports, e.g. USDXM on Crossmint staging), " +
            "read directly from chain RPCs. Use it before paying to confirm there are funds, or after paying to see the result. " +
            "Read-only: never moves money. Pass `chain` to check one chain only.",
        inputSchema: { chain: chainArg },
        annotations: { readOnlyHint: true },
    }, async ({ chain }) => run(async () => {
        const chains = pickChains(chain);
        const balances = await Promise.all(chains.map(async (c) => {
            const entry = { chain: c, name: CHAINS[c]?.name, testnet: CHAINS[c]?.testnet };
            try {
                entry.address = await provider.address(c);
                entry.usdc = await provider.usdcBalance(c);
            }
            catch (err) {
                entry.error = err.message;
            }
            if (provider.otherBalances) {
                try {
                    entry.other = await provider.otherBalances(c);
                }
                catch {
                    // optional
                }
            }
            return entry;
        }));
        return { provider: provider.id, balances };
    }));
    server.registerTool("show_wallet_app", {
        title: "Show wallet (funding info)",
        description: "Text stand-in for a wallet app: for each chain, the deposit address, faucet or onramp hints for adding funds, and which spending " +
            "controls are in force (limit values are never shown). Use it when the user needs to fund the wallet or asks how payments are limited. " +
            "Read-only. Agents cannot change limits, transfer funds or start an onramp; only the wallet owner can.",
        inputSchema: { chain: chainArg },
        annotations: { readOnlyHint: true },
    }, async ({ chain }) => run(async () => {
        const cfg = await loadConfig();
        const chains = pickChains(chain);
        const funding = await Promise.all(chains.map(async (c) => ({ chain: c, name: CHAINS[c]?.name, ...(await provider.fundingInfo(c)) })));
        return {
            provider: provider.id,
            funding,
            limits: guard.summary(cfg),
            configFile: configPath(),
            paymentLog: paymentLogPath(),
            note: "Agents cannot change limits, transfer funds or start onramp flows. Ask the wallet owner.",
        };
    }));
    server.registerTool("check_sign_in_status", {
        title: "Check sign-in status",
        description: "Checks whether the configured wallet provider's credentials are present and accepted, which chains it can pay on, whether Nevermined " +
            "credits are configured, and where each spending setting comes from. Call it first in a session, or whenever a payment tool reports a " +
            "configuration problem; when not ready it says exactly what the owner must set. Read-only.",
        inputSchema: {},
        annotations: { readOnlyHint: true },
    }, async () => run(async () => {
        let cfgError;
        const cfg = await loadConfig().catch((e) => {
            cfgError = e.message;
            return undefined;
        });
        const status = provider ? await provider.ready() : { ok: false, reason: NO_WALLET };
        return {
            signedIn: status.ok,
            provider: provider?.id ?? "none",
            reason: status.reason,
            chains: provider?.chains() ?? [],
            nevermined: neverminedConfigured()
                ? { configured: true, environment: neverminedEnvironment(), delegation: process.env.NVM_DELEGATION_ID ? "NVM_DELEGATION_ID" : "auto (created on first payment)" }
                : { configured: false },
            schemePriority: schemePriority(),
            config: cfg ? guard.summary(cfg) : { error: cfgError },
            configSources: await configSources(),
            configFile: configPath(),
            nextSteps: status.ok
                ? undefined
                : "The wallet owner must set the provider's environment variables in the MCP client config and restart it. See README.",
        };
    }));
    // ---------------------------------------------------------------- payment tools
    server.registerTool("list_bazaar_resources", {
        title: "List Bazaar resources",
        description: "Finds paid x402 APIs in the public CDP Bazaar catalog. With `query` (and optional network / price filters) it runs a ranked search; " +
            "without arguments it lists the catalog page by page. Returns each resource's URL, description, HTTP method and prices per network. " +
            "Use it to discover services; then use get_resource_details for one entry, check_seller before buying, and make_x402_request to pay. " +
            "Read-only, no authentication, nothing is paid.",
        inputSchema: {
            query: z.string().optional().describe('Natural-language search, e.g. "weather forecast"'),
            network: z.string().optional().describe('Filter by network, e.g. "eip155:84532" for Base Sepolia'),
            maxUsdPrice: z.string().optional().describe('Maximum price in USD, e.g. "0.05"'),
            limit: z.number().int().min(1).max(100).optional().describe("Maximum number of results (1-100; a search returns at most 20)"),
            offset: z.number().int().min(0).optional().describe("Number of entries to skip when paging through the catalog without a query"),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
    }, async (args) => run(() => listBazaarResources(args, opts.fetch)));
    server.registerTool("get_resource_details", {
        title: "Get resource details",
        description: "Returns the full Bazaar record for one resource URL: every accepted payment option with its USD price, the description, and the " +
            "input/output schema (required query or body fields). Use it after list_bazaar_resources to learn how to call a service correctly. " +
            "Read-only, nothing is paid. If the URL is not in the Bazaar it says so; use check_payment_requirements to read the price from the endpoint itself.",
        inputSchema: { resource: z.string().url().describe("The resource URL exactly as returned by list_bazaar_resources") },
        annotations: { readOnlyHint: true, openWorldHint: true },
    }, async ({ resource }) => run(() => getResourceDetails(resource, opts.fetch)));
    server.registerTool("make_x402_request", {
        title: "Make an x402 request",
        description: "Calls a URL and, if it answers HTTP 402, pays for it with the configured wallet (USDC, x402 `exact`) or Nevermined credits, then returns " +
            "the response. THIS SPENDS MONEY. Before signing it checks the owner's host allowlist, per-call and per-session limits, the seller's Seller Probe " +
            "record, required input, the Bazaar price and remembered refusals, and stops without paying if any check fails (status `blocked` with a reason). " +
            "After paying it confirms the transfer on chain and, if the seller did not deliver, refetches once with the same payment when the seller supports " +
            "Delivery Receipts. Returns status, body, tx, settlement, body hash, receipt and probe result. Never re-sends a payment whose outcome is unknown. " +
            "Use check_seller or check_payment_requirements first when unsure.",
        inputSchema: requestShape,
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    }, async (args) => run(async () => {
        const r = await requester.request(args);
        // A purchase that did not deliver is reported as a tool error so clients notice it.
        if (["blocked", "not_delivered", "rejected_by_seller"].includes(r.status))
            throw new ResultError(r);
        return r;
    }));
    server.registerTool("check_payment_requirements", {
        title: "Check payment requirements",
        description: "Calls a URL without paying and returns its HTTP 402 payment options (scheme, network, price, asset, pay-to), which option this wallet " +
            "would pay, and whether that payment fits the owner's limits. Use it to quote a price before deciding to buy. Sends one unpaid request " +
            "to the seller; nothing is signed or paid.",
        inputSchema: requestShape,
        annotations: { readOnlyHint: true, openWorldHint: true },
    }, async (args) => run(() => requester.checkRequirements(args)));
    server.registerTool("check_seller", {
        title: "Check seller",
        description: "Runs every pre-payment check of make_x402_request without paying: the seller's Seller Probe record, the 402's payment options, required " +
            "input missing from the request, the difference from the Bazaar price, payment refusals remembered for this host, and whether the seller " +
            "supports Delivery Receipts. Use it before buying from an unfamiliar seller. Sends one unpaid request plus a Seller Probe lookup; nothing " +
            "is signed or paid.",
        inputSchema: requestShape,
        annotations: { readOnlyHint: true, openWorldHint: true },
    }, async (args) => run(() => requester.checkSeller(args)));
    return server;
}
