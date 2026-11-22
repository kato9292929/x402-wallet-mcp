import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CHAINS, normalizeNetwork } from "./chains.js";
import { configPath, configSources, loadConfig, paymentLogPath, schemePriority } from "./config.js";
import { SpendGuard } from "./limits.js";
import { NeverminedPayer, neverminedConfigured, neverminedEnvironment } from "./nevermined.js";
import { NO_WALLET, ResultError, registerReadOnlyTools, requestShape, run } from "./tools.js";
import { X402Requester } from "./x402/request.js";
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
    registerReadOnlyTools((name, config, cb) => server.registerTool(name, config, cb), {
        provider,
        requester,
        fetch: opts.fetch,
        payTool: "make_x402_request",
    });
    return server;
}
