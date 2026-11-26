import { describe, expect, it, vi } from "vitest";
import { BASE } from "../src/chains.js";
import { REMOTE_INSTRUCTIONS } from "../src/instructions.js";
import { handleMcp } from "../src/remote/http.js";
import { parseParams } from "../src/remote/params.js";
import { buyData, type FlowDeps } from "../src/remote/payments.js";
import { memoryStore } from "../src/remote/store.js";
import { exactReq, res402 } from "./helpers.js";

const ORIGIN = "https://agentpay.test";
const params = parseParams(new URL(`${ORIGIN}/mcp`)); // no wallet in the URL, mainnet

const item = (resource: string, serviceName: string, description: string, amount = "10000", input: Record<string, unknown> = { method: "GET", type: "http" }) => ({
  resource,
  serviceName,
  description,
  x402Version: 2,
  accepts: [exactReq(amount, BASE)],
  extensions: { bazaar: { info: { input } } },
});

function deps(items: unknown[]) {
  const sellerCalls: { url: string; init?: RequestInit }[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/x402/discovery/search")) return new Response(JSON.stringify({ resources: items }), { headers: { "content-type": "application/json" } });
    if (url.endsWith("/.well-known/x402-receipt.json")) return new Response("no", { status: 404 });
    sellerCalls.push({ url, init });
    return res402([exactReq("10000", BASE)]);
  }) as unknown as typeof fetch;
  const d: FlowDeps = {
    store: memoryStore(),
    fetch: fetchMock,
    requesterOverrides: {
      probe: async () => ({ status: "unscored", host: "seller.test" }) as any,
      bazaarPrice: async () => null,
      checkPayTo: async () => ({ exists: true }),
      walletCode: async () => "0x",
    },
  };
  return { d, sellerCalls };
}

describe("MCP instructions", () => {
  it("are sent in the initialize result, so clients know to use AgentPay402 for paid data", async () => {
    const res = await handleMcp(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
        }),
      }),
    );
    const text = await res.text();
    const json = JSON.parse(text.includes("data:") ? text.split("\n").find((l) => l.startsWith("data:"))!.slice(5) : text);
    expect(json.result.instructions).toBe(REMOTE_INSTRUCTIONS);
    expect(json.result.instructions).toMatch(/buy_data/);
    // When to use it only: never tells Claude to avoid or bypass other tools or connectors (directory policy 2.C / 2.E).
    expect(json.result.instructions).toMatch(/has no account or API key for it/);
    expect(json.result.instructions).toMatch(/already has a connector for that provider, follow the user's choice/);
    expect(json.result.instructions).not.toMatch(/do not search|other connectors first|instead of|avoid/i);
  });
});

describe("buy_data", () => {
  it("picks the endpoint that matches the request, fills its input from the Bazaar example and returns the approval link", async () => {
    const netflowBody = { chains: ["ethereum", "solana"] };
    const { d, sellerCalls } = deps([
      item("https://api.nansen.ai/api/v1/smart-money/holdings", "Nansen", "Smart money holdings", "50000", { method: "POST", body: { chains: ["ethereum"] } }),
      item("https://api.nansen.ai/api/v1/smart-money/netflow", "Nansen", "Get Smart Money Netflow Data", "50000", { method: "POST", body: netflowBody }),
      item("https://liquidvision.app/api/v1/hl/smart-money/netflow", "LiquidVision.app", "Hyperliquid netflow", "30000"),
    ]);
    const r: any = await buyData(params, { query: "nansen smart money netflow" }, ORIGIN, d);
    expect(r.status).toBe("awaiting_approval");
    expect(r.approve_url).toMatch(new RegExp(`^${ORIGIN}/approve/`));
    // The input was not the user's: show_user starts with the conditions, and Claude is told to confirm them before signing.
    expect(r.show_user.split("\n")[0]).toBe(
      'Buying with these conditions (the API\'s example; you did not choose them): chains=["ethereum","solana"]',
    );
    expect(r.show_user).toMatch(/How to pay/);
    expect(r.next_step).toMatch(/^The input came from the API's example.*ask whether they are what they want/);
    // The price and network are the ones the 402 asked for (the mock seller asks 0.01 on Base).
    expect(r.chosen).toMatchObject({ resource: "https://api.nansen.ai/api/v1/smart-money/netflow", price_usd: "0.01", network: BASE });
    expect(r.chosen.input_used).toMatchObject({ body: netflowBody, from_bazaar_example: ["body"] });
    // The seller was asked with the example body.
    expect(sellerCalls[0].url).toBe("https://api.nansen.ai/api/v1/smart-money/netflow");
    expect(sellerCalls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(sellerCalls[0].init?.body))).toEqual(netflowBody);
  });

  it("uses the user's own body and query parameters over the example", async () => {
    const { d, sellerCalls } = deps([item("https://sec.test/v1/filings", "SEC filings", "Latest SEC filings by ticker")]);
    const r: any = await buyData(params, { query: "sec filings", query_params: { ticker: "AAPL" } }, ORIGIN, d);
    expect(r.status).toBe("awaiting_approval");
    expect(sellerCalls[0].url).toBe("https://sec.test/v1/filings?ticker=AAPL");
    expect(r.chosen.input_used).toMatchObject({ query_params: { ticker: "AAPL" }, from_bazaar_example: [] });
    // The user's own input: no conditions line, no extra confirmation step.
    expect(r.show_user).toMatch(/^How to pay/);
    expect(r.next_step).toMatch(/^Show the user show_user/);
  });

  it("prepares nothing and returns the top candidates when several match equally", async () => {
    const { d, sellerCalls } = deps([
      item("https://a.test/btc-price", "Bitcoin (BTC) price", "Current BTC price", "2000"),
      item("https://b.test/bitcoin/price", "Bitcoin price", "BTC spot price", "2000"),
      item("https://c.test/crypto/price", "Crypto price", "Price of BTC and others", "2000"),
      item("https://d.test/weather", "Weather", "Forecast", "2000"),
    ]);
    const r: any = await buyData(params, { query: "btc price" }, ORIGIN, d);
    expect(r).toMatchObject({ status: "choose", paid: false });
    expect(r.candidates).toHaveLength(3);
    expect(r.candidates.map((c: any) => c.resource)).not.toContain("https://d.test/weather");
    expect(r.approve_url).toBeUndefined();
    expect(sellerCalls).toHaveLength(0);
  });

  it("skips endpoints over the price cap or with a path template, and says when nothing matches", async () => {
    const { d } = deps([
      item("https://e.test/expensive", "Expensive data", "data", "500000"),
      item("https://f.test/delta/:ticker", "Filing delta", "filings"),
    ]);
    expect(await buyData(params, { query: "filing data" }, ORIGIN, d)).toMatchObject({ status: "no_match", paid: false });
  });
});
