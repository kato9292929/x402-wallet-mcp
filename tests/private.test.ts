import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { MxeOps } from "../src/arcium/mxe.js";
import { PRIVATE_TOOL_NAMES, createServer } from "../src/server.js";
import type { WalletProvider } from "../src/providers/types.js";
import { SOLANA_DEVNET, b64, cfg, exactReq, paymentRequired, res200 } from "./helpers.js";

// A cap no other number in these flows can produce, so any appearance is a leak.
const CAP = "0.043217";
const LEAKS = [CAP, "43217", "0.0432", "0,043"];

const provider: WalletProvider = {
  id: "cdp",
  chains: () => [SOLANA_DEVNET],
  address: async () => "BuyerSo1ana1111111111111111111111111111111",
  usdcBalance: async () => "1.00",
  fundingInfo: async () => ({ address: "BuyerSo1ana1111111111111111111111111111111" }),
  ready: async () => ({ ok: true }),
};

const TX = "5".repeat(88);
const arcium = (mode: "price_match" | "rfq", offerId: string, seller = "SellerA") => ({
  programId: "Prog",
  cluster: 456,
  mode,
  offerId,
  expiresAt: "2099-01-01T00:00:00Z",
  ...(mode === "price_match" ? { negotiation: "Neg" } : {}),
  seller,
});
const req402 = (amount: string, extra?: Record<string, unknown>) =>
  new Response("{}", {
    status: 402,
    headers: { "payment-required": b64(paymentRequired([exactReq(amount, SOLANA_DEVNET, extra ?? {})])) },
  });

/** A seller gateway: list price unless an offer header is sent; the offer's price after that. */
function seller(opts: { list: string; offered?: () => string; arc?: (id: string) => Record<string, unknown> | undefined; rfqStatus?: number }) {
  return (url: string, init: RequestInit = {}) => {
    const h = new Headers(init.headers);
    if (h.get("payment-signature")) return res200({ data: "series" }, { success: true, transaction: TX, network: SOLANA_DEVNET, payer: "Buyer" });
    const offer = h.get("x-arcium-offer");
    if (offer && h.get("x-arcium-rfq") && opts.rfqStatus !== undefined && !opts.offered) {
      return new Response('{"quoted":true}', { status: opts.rfqStatus });
    }
    if (offer) {
      const a = opts.arc?.(offer);
      return req402(opts.offered!(), a ? { arcium: a } : {});
    }
    const a = opts.arc?.("777");
    return req402(opts.list, a ? { arcium: a } : {});
  };
}

function fakeMxe(floor: bigint, over: Partial<MxeOps> = {}): MxeOps & { closed: string[] } {
  const closed: string[] = [];
  return {
    programId: "Prog",
    closed,
    matchCeiling: async (_neg, _id, cap) => ({
      matched: cap >= floor,
      priceMicros: cap >= floor ? floor : 0n,
      matchRequest: "MatchReq",
      run: { circuit: "match_ceiling", queueTx: "q", finalizeTx: "f", latencyMs: 4200, lamports: 5000 },
    }),
    closeMatchRequest: async (m) => void closed.push(m),
    createRfq: async () => ({ rfq: "Rfq1", endTime: 0, run: { circuit: "open_rfq_state", queueTx: "q", finalizeTx: "f", latencyMs: 3000, lamports: 9000 } }),
    closeAndAward: async () => ({ awarded: false, priceMicros: 0n, quoteCount: 3, run: { circuit: "award_rfq", queueTx: "q", finalizeTx: "f", latencyMs: 3000, lamports: 5000 } }),
    ...over,
  };
}

let stderr: string[];
let logs: Record<string, unknown>[];

async function connect(fetchImpl: (url: string, init?: RequestInit) => Response | Promise<Response>, mxe: MxeOps) {
  const server = createServer({
    provider,
    fetch: vi.fn(async (u: string | URL | Request, init?: RequestInit) => fetchImpl(String(u), init)) as unknown as typeof fetch,
    privatePricing: true,
    mxe: () => mxe,
    rfqDurationSec: 1,
    requesterDeps: {
      loadConfig: async () => cfg({ perCallMaxUsd: CAP, network: "testnet" }),
      createExactHeaders: async () => ({ "PAYMENT-SIGNATURE": "signed" }),
      log: async (e) => {
        logs.push(e);
        process.stderr.write(`[x402-wallet-mcp] payment ${JSON.stringify(e)}\n`);
      },
    },
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  return { text: r.content[0].text, json: JSON.parse(r.content[0].text), isError: !!r.isError };
}

const everything = (texts: string[]) => [...texts, ...stderr, JSON.stringify(logs)].join("\n");
const expectNoCap = (texts: string[]) => {
  const all = everything(texts);
  for (const l of LEAKS) expect(all, `leaked "${l}"`).not.toContain(l);
};

describe("private pricing tools", () => {
  beforeEach(() => {
    stderr = [];
    logs = [];
    vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => {
      stderr.push(String(s));
      return true;
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("pays the matched price and returns the receipt, without the cap anywhere", async () => {
    const mxe = fakeMxe(30_000n);
    const client = await connect(seller({ list: "50000", offered: () => "30000", arc: (id) => arcium("price_match", id) }), mxe);
    const r = await call(client, "private_price_match", { url: "https://seller.test/jin/series" });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ matched: true, priceUsd: "0.03", offerId: "777", paid: true });
    expect(r.json.payment).toMatchObject({ transaction: TX, settled: true });
    expect(logs[0]).toMatchObject({ pricing: "private_price_match", offerId: "777", priceUsd: "0.03" });
    expect(mxe.closed).toEqual(["MatchReq"]);
    expectNoCap([r.text]);
  });

  it("pays nothing when there is no match", async () => {
    const fetchSpy = vi.fn(seller({ list: "50000", offered: () => "50000", arc: (id) => arcium("price_match", id) }));
    const client = await connect(fetchSpy, fakeMxe(50_000n));
    const r = await call(client, "private_price_match", { url: "https://seller.test/jin/series" });
    expect(r.json).toMatchObject({ matched: false, paid: false });
    expect(logs).toHaveLength(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // the first 402 only
    expectNoCap([r.text]);
  });

  it("refuses a 402 that differs from the matched price", async () => {
    const client = await connect(seller({ list: "50000", offered: () => "40000", arc: (id) => arcium("price_match", id) }), fakeMxe(30_000n));
    const r = await call(client, "private_price_match", { url: "https://seller.test/jin/series" });
    expect(r.isError).toBe(true);
    expect(r.json.error).toMatch(/does not match the sealed result/);
    expect(logs).toHaveLength(0);
    expectNoCap([r.text]);
  });

  it("refuses a matched price above the cap (a lying seller or MXE), without saying the cap", async () => {
    const lying = fakeMxe(0n, {
      matchCeiling: async () => ({
        matched: true,
        priceMicros: 90_000n,
        matchRequest: "M",
        run: { circuit: "match_ceiling", queueTx: "q", finalizeTx: "f", latencyMs: 1, lamports: 1 },
      }),
    });
    const client = await connect(seller({ list: "50000", offered: () => "90000", arc: (id) => arcium("price_match", id) }), lying);
    const r = await call(client, "private_price_match", { url: "https://seller.test/jin/series" });
    expect(r.isError).toBe(true);
    expect(r.json).toMatchObject({ code: "PER_CALL_LIMIT", paid: false });
    expect(logs).toHaveLength(0);
    expectNoCap([r.text]);
  });

  it("falls back to make_x402_request when the 402 has no extra.arcium", async () => {
    const client = await connect(seller({ list: "10000" }), fakeMxe(0n));
    const r = await call(client, "private_price_match", { url: "https://seller.test/plain" });
    expect(r.json).toMatchObject({ negotiated: false, paid: true });
    expectNoCap([r.text]);
  });

  it("keeps the cap out of the limit error on the fallback path too", async () => {
    const client = await connect(seller({ list: "90000" }), fakeMxe(0n));
    const r = await call(client, "private_price_match", { url: "https://seller.test/plain" });
    expect(r.json).toMatchObject({ code: "PER_CALL_LIMIT" });
    expect(r.json.error).toContain("0.09");
    expectNoCap([r.text]);
  });

  describe("quote auction", () => {
    const urls = ["https://a.test/s", "https://b.test/s", "https://c.test/s"];
    const sellerKey: Record<string, string> = { "https://a.test/s": "SellerA", "https://b.test/s": "SellerB", "https://c.test/s": "SellerC" };

    function auctionFetch(awardPrice?: string) {
      let awarded = false;
      const quoted: string[] = [];
      const f = (url: string, init: RequestInit = {}) => {
        const h = new Headers(init.headers);
        if (h.get("payment-signature")) return res200({ data: "series" }, { success: true, transaction: TX, network: SOLANA_DEVNET });
        if (h.get("x-arcium-rfq") && !awarded) {
          quoted.push(url);
          return new Response('{"quoted":true}', { status: 202 });
        }
        if (h.get("x-arcium-rfq")) return req402(awardPrice!, { arcium: arcium("rfq", "9" + urls.indexOf(url), sellerKey[url]) });
        return req402("50000", { arcium: arcium("rfq", "9" + urls.indexOf(url), sellerKey[url]) });
      };
      return { f, quoted, markAwarded: () => (awarded = true) };
    }

    it("pays the winner at the award price", async () => {
      const af = auctionFetch("18000");
      const mxe = fakeMxe(0n, {
        closeAndAward: async () => {
          af.markAwarded();
          return { awarded: true, winner: "SellerB", priceMicros: 18_000n, quoteCount: 3, run: { circuit: "award_rfq", queueTx: "q", finalizeTx: "f", latencyMs: 1, lamports: 1 } };
        },
      });
      const client = await connect(af.f, mxe);
      const r = await call(client, "private_quote_auction", { urls });
      expect(r.isError).toBe(false);
      expect(af.quoted).toEqual(urls);
      expect(r.json).toMatchObject({ awarded: true, winner: "https://b.test/s", priceUsd: "0.018", paid: true });
      expect(logs[0]).toMatchObject({ pricing: "private_quote_auction", rfq: "Rfq1" });
      expectNoCap([r.text]);
    });

    it("pays nothing when no quote is within the cap", async () => {
      const af = auctionFetch();
      const client = await connect(af.f, fakeMxe(0n));
      const r = await call(client, "private_quote_auction", { urls });
      expect(r.json).toMatchObject({ awarded: false, winner: null, paid: false });
      expect(logs).toHaveLength(0);
      expectNoCap([r.text]);
    });
  });

  it("keeps the cap out of the wallet tools as well", async () => {
    const client = await connect(seller({ list: "10000" }), fakeMxe(0n));
    const texts = [
      (await call(client, "show_wallet_app", {})).text,
      (await call(client, "check_sign_in_status", {})).text,
      (await call(client, "check_payment_requirements", { url: "https://seller.test/plain" })).text,
    ];
    expect(texts[0]).toContain("sealed");
    expectNoCap(texts);
  });

  it("does not offer the private tools unless enabled", async () => {
    const server = createServer({ provider, privatePricing: false });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of PRIVATE_TOOL_NAMES) expect(names).not.toContain(n);
  });
});
