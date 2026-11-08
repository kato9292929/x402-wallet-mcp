import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getResourceDetails, listBazaarResources } from "./bazaar.js";
import { CHAINS, normalizeNetwork } from "./chains.js";
import { configPath, configSources, loadConfig, paymentLogPath, schemePriority } from "./config.js";
import { SpendGuard, SpendLimitError } from "./limits.js";
import { NeverminedPayer, neverminedConfigured, neverminedEnvironment } from "./nevermined.js";
import type { WalletProvider } from "./providers/index.js";
import { PaymentError, X402Requester } from "./x402/request.js";

export const VERSION = "0.2.0";

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
] as const;

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** Carries a full result that should be returned with isError: true. */
class ResultError extends Error {
  constructor(readonly result: unknown) {
    super("result");
  }
}

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) }] };
}

function fail(err: unknown): ToolResult {
  if (err instanceof ResultError) return { ...ok(err.result), isError: true };
  const e = err as Error & { details?: Record<string, unknown>; code?: string };
  const payload: Record<string, unknown> = { error: e.message ?? String(err) };
  if (err instanceof SpendLimitError) {
    payload.code = e.code;
    payload.paid = false;
  }
  if (err instanceof PaymentError) Object.assign(payload, e.details);
  return { ...ok(payload), isError: true };
}

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err);
  }
}

const NO_WALLET =
  "No wallet is configured (WALLET_PROVIDER=none). Set WALLET_PROVIDER to cdp, privy or crossmint with its credentials.";

const requestShape = {
  url: z.string().url().describe("Full URL of the x402-protected endpoint"),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]).optional().describe("HTTP method (default GET)"),
  headers: z.record(z.string(), z.string()).optional().describe("Extra request headers"),
  body: z
    .union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())])
    .optional()
    .describe("Request body. Objects/arrays are sent as JSON."),
};

export interface ServerOptions {
  provider: WalletProvider | null;
  guard?: SpendGuard;
  fetch?: typeof fetch;
}

export function createServer(opts: ServerOptions): McpServer {
  const provider = opts.provider;
  const guard = opts.guard ?? new SpendGuard();
  const requester = new X402Requester({
    provider,
    guard,
    nevermined: new NeverminedPayer(),
    fetch: opts.fetch,
  });

  const server = new McpServer({ name: "x402-wallet-mcp", version: VERSION });

  const pickChains = (chain?: string): string[] => {
    if (!provider) throw new Error(NO_WALLET);
    if (!chain) return provider.chains();
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

  server.registerTool(
    "get_wallet_address",
    {
      title: "Get wallet address",
      description: "Returns the wallet address for each chain the configured wallet provider supports.",
      inputSchema: { chain: chainArg },
      annotations: { readOnlyHint: true },
    },
    async ({ chain }) =>
      run(async () => {
        const chains = pickChains(chain);
        const addresses = await Promise.all(
          chains.map(async (c) => ({ chain: c, name: CHAINS[c]?.name, address: await provider!.address(c) })),
        );
        return { provider: provider!.id, addresses };
      }),
  );

  server.registerTool(
    "get_wallet_balance",
    {
      title: "Get wallet balance",
      description: "Shows the wallet's USDC balance on every supported chain (plus other tokens the provider reports).",
      inputSchema: { chain: chainArg },
      annotations: { readOnlyHint: true },
    },
    async ({ chain }) =>
      run(async () => {
        const chains = pickChains(chain);
        const balances = await Promise.all(
          chains.map(async (c) => {
            const entry: Record<string, unknown> = { chain: c, name: CHAINS[c]?.name, testnet: CHAINS[c]?.testnet };
            try {
              entry.address = await provider!.address(c);
              entry.usdc = await provider!.usdcBalance(c);
            } catch (err) {
              entry.error = (err as Error).message;
            }
            if (provider!.otherBalances) {
              try {
                entry.other = await provider!.otherBalances(c);
              } catch {
                // optional
              }
            }
            return entry;
          }),
        );
        return { provider: provider!.id, balances };
      }),
  );

  server.registerTool(
    "show_wallet_app",
    {
      title: "Show wallet (funding info)",
      description:
        "Text replacement for the wallet UI: deposit address and chain for funding, faucet/onramp links, and the current " +
        "spending limits. Limits can only be changed by the wallet owner in the config file.",
      inputSchema: { chain: chainArg },
      annotations: { readOnlyHint: true },
    },
    async ({ chain }) =>
      run(async () => {
        const cfg = await loadConfig();
        const chains = pickChains(chain);
        const funding = await Promise.all(
          chains.map(async (c) => ({ chain: c, name: CHAINS[c]?.name, ...(await provider!.fundingInfo(c)) })),
        );
        return {
          provider: provider!.id,
          funding,
          limits: guard.summary(cfg),
          configFile: configPath(),
          paymentLog: paymentLogPath(),
          note: "Agents cannot change limits, transfer funds or start onramp flows. Ask the wallet owner.",
        };
      }),
  );

  server.registerTool(
    "check_sign_in_status",
    {
      title: "Check sign-in status",
      description:
        "Checks whether the wallet provider's credentials are configured and can sign, and explains what is missing if not.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      run(async () => {
        let cfgError: string | undefined;
        const cfg = await loadConfig().catch((e: Error) => {
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
      }),
  );

  // ---------------------------------------------------------------- payment tools

  server.registerTool(
    "list_bazaar_resources",
    {
      title: "List Bazaar resources",
      description:
        "Discovers x402 services in the CDP Bazaar. With `query` (or filters) it runs a ranked search; without, it lists the catalog page by page.",
      inputSchema: {
        query: z.string().optional().describe('Natural-language search, e.g. "weather forecast"'),
        network: z.string().optional().describe('Filter by network, e.g. "eip155:84532" for Base Sepolia'),
        maxUsdPrice: z.string().optional().describe('Maximum price in USD, e.g. "0.05"'),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (search returns at most 20)"),
        offset: z.number().int().min(0).optional().describe("Offset when listing without a query"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => run(() => listBazaarResources(args, opts.fetch)),
  );

  server.registerTool(
    "get_resource_details",
    {
      title: "Get resource details",
      description: "Full Bazaar record for one service: accepted payment options, price, description and input/output schema.",
      inputSchema: { resource: z.string().url().describe("The resource URL from list_bazaar_resources") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ resource }) => run(() => getResourceDetails(resource, opts.fetch)),
  );

  server.registerTool(
    "make_x402_request",
    {
      title: "Make an x402 request",
      description:
        "Calls a URL. If it answers HTTP 402, pays with the configured wallet (USDC `exact`) or Nevermined credits " +
        "(`nvm:erc4337`), within the owner's per-call / per-session limits and host allowlist, then retries and returns " +
        "the response with the settlement receipt. Over-limit requests are not paid.",
      inputSchema: requestShape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args) =>
      run(async () => {
        const r = await requester.request(args);
        // A purchase that did not deliver is reported as a tool error so clients notice it.
        if (["blocked", "not_delivered", "rejected_by_seller"].includes(r.status)) throw new ResultError(r);
        return r;
      }),
  );

  server.registerTool(
    "check_payment_requirements",
    {
      title: "Check payment requirements",
      description: "Calls a URL without paying and returns its 402 payment options, which one would be paid, and whether it fits the limits.",
      inputSchema: requestShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => run(() => requester.checkRequirements(args)),
  );

  server.registerTool(
    "check_seller",
    {
      title: "Check seller",
      description:
        "Checks a seller without paying: its Seller Probe record, the 402's payment options, missing required input, " +
        "the difference from the Bazaar price, recent payment refusals remembered for this host, and whether it supports " +
        "Delivery Receipts (refetch after a failed delivery).",
      inputSchema: requestShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => run(() => requester.checkSeller(args)),
  );

  return server;
}
