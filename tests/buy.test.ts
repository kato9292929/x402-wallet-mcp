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

function deps(items: unknown[], probe: (url: string) => Promise<any> = async () => ({ status: "unscored", host: "seller.test" })) {
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
      probe: probe as any,
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

describe("tool annotations", () => {
  it("mark the link-making tools as additive, not destructive: money moves only when the user signs", async () => {
    const res = await handleMcp(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      }),
    );
    const text = await res.text();
    const json = JSON.parse(text.includes("data:") ? text.split("\n").find((l) => l.startsWith("data:"))!.slice(5) : text);
    const byName = Object.fromEntries(json.result.tools.map((t: any) => [t.name, t.annotations]));
    for (const name of ["buy_data", "request_x402_payment"]) {
      expect(byName[name]).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
    }
  });
});

describe("buy_data", () => {
  it("does not fill required input silently: returns confirm_input with the fields and the example as a suggestion", async () => {
    const netflowExample = { chains: ["ethereum", "solana"], filters: { include_smart_money_labels: ["Smart Trader"] } };
    const nansenNetflow = {
      ...item("https://api.nansen.ai/api/v1/smart-money/netflow", "Nansen", "Get Smart Money Netflow Data", "50000", { method: "POST", body: netflowExample }),
    };
    (nansenNetflow.extensions.bazaar as any).schema = {
      properties: { input: { properties: { body: { required: ["chains"], properties: { chains: { type: "array", description: "Chains to include" } } } } } },
    };
    const { d, sellerCalls } = deps([
      item("https://api.nansen.ai/api/v1/smart-money/holdings", "Nansen", "Smart money holdings", "50000", { method: "POST", body: { chains: ["ethereum"] } }),
      nansenNetflow,
      item("https://liquidvision.app/api/v1/hl/smart-money/netflow", "LiquidVision.app", "Hyperliquid netflow", "30000"),
    ]);

    // 1. No input in the request: nothing is prepared; Claude gets the field to fill.
    const r: any = await buyData(params, { query: "Nansenのsmart moneyのnetflowが欲しい" }, ORIGIN, d);
    expect(r).toMatchObject({ status: "confirm_input", paid: false });
    expect(r.approve_url).toBeUndefined();
    expect(r.chosen.resource).toBe("https://api.nansen.ai/api/v1/smart-money/netflow");
    expect(r.needs).toEqual([{ field: "body.chains", description: "Chains to include", example: ["ethereum", "solana"] }]);
    expect(r.next_step).toMatch(/Fill the input from the user's own words/);
    expect(sellerCalls).toHaveLength(0);

    // 2. The user gives the chains: paid with exactly that, no conditions line.
    const own: any = await buyData(params, { query: "nansen smart money netflow", body: { chains: ["ethereum"] } }, ORIGIN, d);
    expect(own.status).toBe("awaiting_approval");
    expect(JSON.parse(String(sellerCalls.at(-1)!.init?.body))).toEqual({ chains: ["ethereum"] });
    expect(own.show_user).toMatch(/^How to pay/);

    // 3. The user accepts the example: only the required field is taken (not the narrowing filters), and shown first.
    const ex: any = await buyData(params, { query: "nansen smart money netflow", use_example: true }, ORIGIN, d);
    expect(ex.status).toBe("awaiting_approval");
    expect(JSON.parse(String(sellerCalls.at(-1)!.init?.body))).toEqual({ chains: ["ethereum", "solana"] });
    expect(ex.show_user.split("\n")[0]).toBe('Buying with these conditions (the API\'s example; you did not choose them): chains=["ethereum","solana"]');
    expect(ex.next_step).toMatch(/^The input came from the API's example/);
    // The price and network are the ones the 402 asked for (the mock seller asks 0.01 on Base).
    expect(ex.chosen).toMatchObject({ resource: "https://api.nansen.ai/api/v1/smart-money/netflow", price_usd: "0.01", network: BASE });
    expect(ex.chosen.input_used).toMatchObject({ from_bazaar_example: ["body.chains"] });
  });

  it("asks for a required query parameter instead of using the example's value", async () => {
    const sec = item("https://sec.test/v1/filings", "SEC filings", "Latest SEC filings by ticker", "10000", { method: "GET", queryParams: { ticker: "AAPL" } });
    (sec.extensions.bazaar as any).schema = { properties: { input: { properties: { queryParams: { required: ["ticker"], properties: { ticker: { description: "Stock ticker" } } } } } } };
    const { d, sellerCalls } = deps([sec]);
    const r: any = await buyData(params, { query: "SECの提出書類でMSFTの最新を" }, ORIGIN, d);
    expect(r).toMatchObject({ status: "confirm_input", needs: [{ field: "query_params.ticker", description: "Stock ticker", example: "AAPL" }] });
    expect(sellerCalls).toHaveLength(0);
    const msft: any = await buyData(params, { query: "sec filings", query_params: { ticker: "MSFT" } }, ORIGIN, d);
    expect(msft.status).toBe("awaiting_approval");
    expect(sellerCalls.at(-1)!.url).toBe("https://sec.test/v1/filings?ticker=MSFT");
  });

  it("does not pay for a generic result when the request names something the endpoint only covers through optional input", async () => {
    const sec = item("https://sec.test/api/v1/sec/filings", "SEC filings", "Latest SEC filings", "10000", { method: "GET" });
    (sec.extensions.bazaar as any).schema = {
      properties: { input: { properties: { queryParams: { properties: { query: { description: "Text that the title must contain, e.g. a ticker" } } } } } },
    };
    const { d, sellerCalls } = deps([sec]);
    // "msft" is not in the endpoint: the request is about it, so the input has to carry it.
    const r: any = await buyData(params, { query: "SECの提出書類でMSFTの最新を" }, ORIGIN, d);
    expect(r).toMatchObject({ status: "confirm_input", needs: [], request_mentions: ["msft"] });
    expect(r.optional).toEqual([{ field: "query_params.query", description: "Text that the title must contain, e.g. a ticker" }]);
    expect(r.next_step).toMatch(/mentions msft/);
    expect(sellerCalls).toHaveLength(0);
    const ok: any = await buyData(params, { query: "SECの提出書類でMSFTの最新を", query_params: { query: "MSFT" } }, ORIGIN, d);
    expect(ok.status).toBe("awaiting_approval");
    expect(sellerCalls.at(-1)!.url).toBe("https://sec.test/api/v1/sec/filings?query=MSFT");
  });

  it("reads common Japanese words as English keywords", async () => {
    const { queryTokens } = await import("../src/buy.js");
    expect(queryTokens("BTCの価格をx402で買って")).toEqual(["btc", "price"]);
    expect(queryTokens("SECの提出書類でMSFTの最新を")).toEqual(["sec", "msft", "filing", "filings"]);
  });

  it("skips a seller whose latest Seller Probe purchase was refused, even when it matches best", async () => {
    const probe = async (url: string) => {
      const host = new URL(url).hostname;
      return host === "x402node.test" ? { status: "scored", host, verdict: "request_rejected" } : { status: "unscored", host };
    };
    const { d } = deps(
      [
        item("https://x402node.test/crypto/price/btc/usd", "BTC USD price", "BTC price", "2000"),
        item("https://ok.test/price", "Crypto price", "Prices of coins", "2000"),
      ],
      probe,
    );
    const r: any = await buyData(params, { query: "btc price" }, ORIGIN, d);
    expect(r.status).toBe("awaiting_approval");
    expect(r.chosen.resource).toBe("https://ok.test/price");
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

  it("tells equal matches apart by calls in the last 30 days", async () => {
    const busy = { ...item("https://b.test/bitcoin/price", "Bitcoin price", "BTC spot price", "2000"), quality: { l30DaysTotalCalls: 900 } };
    const { d } = deps([
      { ...item("https://a.test/btc-price", "Bitcoin (BTC) price", "Current BTC price", "2000"), quality: { l30DaysTotalCalls: 12 } },
      busy,
    ]);
    const r: any = await buyData(params, { query: "btc price" }, ORIGIN, d);
    expect(r.status).toBe("awaiting_approval");
    expect(r.chosen).toMatchObject({ resource: "https://b.test/bitcoin/price", calls_30d: 900 });
  });

  it("prefers a seller whose latest Seller Probe purchase was delivered, and drops one that was not", async () => {
    const verdicts: Record<string, string> = { "a.test": "not_delivered", "c.test": "delivered" };
    const probe = async (url: string) => {
      const host = new URL(url).hostname;
      return verdicts[host] ? { status: "scored", host, verdict: verdicts[host] } : { status: "unscored", host };
    };
    const { d } = deps(
      [
        { ...item("https://a.test/btc-price", "Bitcoin (BTC) price", "Current BTC price", "2000"), quality: { l30DaysTotalCalls: 5000 } },
        { ...item("https://b.test/bitcoin/price", "Bitcoin price", "BTC spot price", "2000"), quality: { l30DaysTotalCalls: 900 } },
        { ...item("https://c.test/btc/price", "BTC price", "Bitcoin price", "2000"), quality: { l30DaysTotalCalls: 3 } },
      ],
      probe,
    );
    const r: any = await buyData(params, { query: "btc price" }, ORIGIN, d);
    expect(r.status).toBe("awaiting_approval");
    expect(r.chosen).toMatchObject({ resource: "https://c.test/btc/price", seller_probe: "delivered" });
    expect(r.other_candidates.map((c: any) => c.resource)).toEqual(["https://b.test/bitcoin/price"]);
  });

  it("skips endpoints over the price cap or with a path template, and says when nothing matches", async () => {
    const { d } = deps([
      item("https://e.test/expensive", "Expensive data", "data", "500000"),
      item("https://f.test/delta/:ticker", "Filing delta", "filings"),
    ]);
    expect(await buyData(params, { query: "filing data" }, ORIGIN, d)).toMatchObject({ status: "no_match", paid: false });
  });
});
