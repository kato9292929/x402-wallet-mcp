import { z } from "zod";
import { getResourceDetails, listBazaarResources } from "./bazaar.js";
import { onchainUsdcBalance } from "./balance.js";
import { CHAINS, normalizeNetwork } from "./chains.js";
import { SpendLimitError } from "./limits.js";
import type { WalletProvider } from "./providers/index.js";
import { PaymentError, type X402Requester } from "./x402/request.js";

/**
 * Tools that need no key and move no money, shared by the local server (src/server.ts) and the
 * remote server (src/remote). `register` is the server's registerTool with a zod shape as input.
 */

export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** Carries a full result that should be returned with isError: true. */
export class ResultError extends Error {
  constructor(readonly result: unknown) {
    super("result");
  }
}

export function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) }] };
}

export function fail(err: unknown): ToolResult {
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

export async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err);
  }
}

export const NO_WALLET =
  "No wallet is configured (WALLET_PROVIDER=none). Set WALLET_PROVIDER to cdp, privy or crossmint with its credentials, or browser with your wallet address.";

export const requestShape = {
  url: z.string().url().describe("Full https URL of the x402 endpoint, including any query parameters the service requires"),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]).optional().describe("HTTP method to call the endpoint with; use the method the service documents (default GET)"),
  headers: z.record(z.string(), z.string()).optional().describe("Extra request headers to send, e.g. {\"accept\": \"application/json\"}; payment headers are added automatically"),
  body: z
    .union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())])
    .optional()
    .describe("Request body for POST/PUT/PATCH; objects and arrays are sent as JSON with content-type application/json"),
};


export type RegisterTool = (
  name: string,
  config: { title: string; description: string; inputSchema: Record<string, z.ZodType>; annotations?: Record<string, boolean> },
  cb: (args: any) => Promise<ToolResult>,
) => void;

export interface ReadOnlyToolsContext {
  provider: WalletProvider | null;
  requester: X402Requester;
  fetch?: typeof fetch;
  /** The tool that pays, named in descriptions. */
  payTool: string;
}

export function registerReadOnlyTools(register: RegisterTool, ctx: ReadOnlyToolsContext): void {
  const { provider, requester, payTool } = ctx;

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
    .describe('CAIP-2 chain id, e.g. "eip155:8453" (Base) or "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" (Solana). Omit for all chains.');

  register(
    "get_wallet_address",
    {
      title: "Get wallet address",
      description:
        "Returns the address of the configured wallet on each chain it can pay on (CAIP-2 ids such as eip155:84532 for Base Sepolia). " +
        "Use it to tell the user where to send funds or which address will appear as the payer. Read-only: looks the address up with the " +
        "wallet provider and moves no money. Fails with a clear message when no wallet is configured (WALLET_PROVIDER=none).",
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

  register(
    "get_wallet_balance",
    {
      title: "Get wallet balance",
      description:
        "Returns the wallet's USDC balance on each supported chain (and other tokens the provider reports, e.g. USDXM on Crossmint staging), " +
        "read directly from chain RPCs. Use it before paying to confirm there are funds, or after paying to see the result. " +
        "Read-only: never moves money. Pass `chain` to check one chain only, and `address` to read another wallet's balance " +
        "(for example the user's own wallet address when the connection has none).",
      inputSchema: {
        chain: chainArg,
        address: z.string().optional().describe("A wallet address to read instead of the configured one (Solana or 0x address)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ chain, address }) =>
      run(async () => {
        const isEvm = address ? /^0x[0-9a-fA-F]{40}$/.test(address) : false;
        const chains = pickChains(chain).filter((c) => !address || (CHAINS[c]?.family === "evm") === isEvm);
        if (address && !chains.length) throw new Error(`No supported chain for address ${address} here.`);
        const balances = await Promise.all(
          chains.map(async (c) => {
            const entry: Record<string, unknown> = { chain: c, name: CHAINS[c]?.name, testnet: CHAINS[c]?.testnet };
            try {
              entry.address = address ?? (await provider!.address(c));
              entry.usdc = address ? await onchainUsdcBalance(c, address) : await provider!.usdcBalance(c);
            } catch (err) {
              entry.error = (err as Error).message;
            }
            if (!address && provider!.otherBalances) {
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

  register(
    "list_bazaar_resources",
    {
      title: "List Bazaar resources",
      description:
        "Finds paid x402 APIs in the public CDP Bazaar catalog. With `query` (and optional network / price filters) it runs a ranked search; " +
        "without arguments it lists the catalog page by page. Returns each resource's URL, description, HTTP method and prices per network. " +
        `Use it to discover services; then use get_resource_details for one entry, check_seller before buying, and ${payTool} to pay. ` +
        "Read-only, no authentication, nothing is paid.",
      inputSchema: {
        query: z.string().optional().describe('Natural-language search, e.g. "weather forecast"'),
        network: z.string().optional().describe('Filter by network, e.g. "eip155:84532" for Base Sepolia'),
        maxUsdPrice: z.string().optional().describe('Maximum price in USD, e.g. "0.05"'),
        limit: z.number().int().min(1).max(100).optional().describe("Maximum number of results (1-100; a search returns at most 20)"),
        offset: z.number().int().min(0).optional().describe("Number of entries to skip when paging through the catalog without a query"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => run(() => listBazaarResources(args, ctx.fetch)),
  );

  register(
    "get_resource_details",
    {
      title: "Get resource details",
      description:
        "Returns the full Bazaar record for one resource URL: every accepted payment option with its USD price, the description, and the " +
        "input/output schema (required query or body fields). Use it after list_bazaar_resources to learn how to call a service correctly. " +
        "Read-only, nothing is paid. If the URL is not in the Bazaar it says so; use check_payment_requirements to read the price from the endpoint itself.",
      inputSchema: { resource: z.string().url().describe("The resource URL exactly as returned by list_bazaar_resources") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ resource }) => run(() => getResourceDetails(resource, ctx.fetch)),
  );

  register(
    "check_payment_requirements",
    {
      title: "Check payment requirements",
      description:
        "Calls a URL without paying and returns its HTTP 402 payment options (scheme, network, price, asset, pay-to), which option this wallet " +
        "would pay, and whether that payment fits the owner's limits. Use it to quote a price before deciding to buy. Sends one unpaid request " +
        "to the seller; nothing is signed or paid.",
      inputSchema: requestShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => run(() => requester.checkRequirements(args)),
  );

  register(
    "check_seller",
    {
      title: "Check seller",
      description:
        `Runs every pre-payment check of ${payTool} without paying: the seller's Seller Probe record, the 402's payment options, required ` +
        "input missing from the request, the difference from the Bazaar price, payment refusals remembered for this host, and whether the seller " +
        "supports Delivery Receipts. Use it before buying from an unfamiliar seller. Sends one unpaid request plus a Seller Probe lookup; nothing " +
        "is signed or paid.",
      inputSchema: requestShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => run(() => requester.checkSeller(args)),
  );

}
