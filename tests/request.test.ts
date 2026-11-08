import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SpendConfig } from "../src/config.js";
import { SpendGuard } from "../src/limits.js";
import type { WalletProvider } from "../src/providers/types.js";
import type { ChainResult, PayerKey } from "../src/safe/chain.js";
import type { ProbeLookup } from "../src/safe/probe.js";
import { rpcCall } from "../src/safe/rpc.js";
import { base64urlEncode, encodeReceipt, receiptSigningBytes, sha256Hex, type ReceiptPayload } from "../src/safe/receipt-verify.js";
import { X402Requester, type Deps } from "../src/x402/request.js";
import { BASE, BASE_SEPOLIA, SOLANA_DEVNET, b64, cfg, exactReq, paymentRequired } from "./helpers.js";

const URL_ = "https://seller.test/api/data";
const ORIGIN = "https://seller.test";
const PAYER = "0x00000000000000000000000000000000000000aa";
const NONCE = "0x" + "11".repeat(32);
const TX = "0x" + "ab".repeat(32);

const provider: WalletProvider = {
  id: "cdp",
  chains: () => [BASE_SEPOLIA, SOLANA_DEVNET],
  address: async () => PAYER,
  usdcBalance: async () => "1.00",
  fundingInfo: async () => ({ address: PAYER }),
  ready: async () => ({ ok: true }),
};

const evmPayload = (req: Record<string, any>) => ({
  x402Version: 2,
  accepted: req,
  payload: {
    signature: "0x" + "22".repeat(65),
    authorization: { from: PAYER, to: req.payTo, value: req.amount, validAfter: "0", validBefore: "9999999999", nonce: NONCE },
  },
});

function res402(accepts: unknown[], extra: Record<string, unknown> = {}): Response {
  return new Response("{}", {
    status: 402,
    headers: { "payment-required": b64({ ...paymentRequired(accepts), ...extra }), "content-type": "application/json" },
  });
}

function resOk(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });
}

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;

function setup(opts: {
  seller: Response[];
  config?: Partial<SpendConfig>;
  probe?: ProbeLookup;
  bazaar?: string | null;
  chain?: Partial<ChainResult> | ((k: PayerKey, headerTx: string | null) => Promise<ChainResult>);
  wellKnown?: unknown;
  extraRoutes?: Route;
  deps?: Partial<Deps>;
}) {
  const sellerCalls: RequestInit[] = [];
  const queue = [...opts.seller];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === ORIGIN + "/.well-known/x402-receipt.json") {
      return opts.wellKnown ? resOk(opts.wellKnown) : new Response("not found", { status: 404 });
    }
    if (opts.extraRoutes && !url.startsWith(URL_)) return opts.extraRoutes(url, init);
    if (url.startsWith(URL_)) {
      sellerCalls.push(init ?? {});
      const r = queue.shift();
      if (!r) throw new Error("unexpected seller call");
      return r;
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;
  const createExactPayment = vi.fn(async (pr: Record<string, any>) => ({
    headers: { "PAYMENT-SIGNATURE": "signed" },
    payload: evmPayload(pr.accepts[0]),
  }));
  const findPayment =
    typeof opts.chain === "function"
      ? vi.fn(opts.chain)
      : vi.fn(async (_k: PayerKey, headerTx: string | null): Promise<ChainResult> => ({
          settlement: "verified",
          tx: TX,
          transferred: 1000n,
          headerTxMatched: headerTx ? headerTx === TX : null,
          ...(opts.chain as Partial<ChainResult> | undefined),
        }));
  const dir = mkdtempSync(path.join(os.tmpdir(), "x402-safe-"));
  const netFailuresFile = path.join(dir, "net-failures.jsonl");
  const log = vi.fn(async () => {});
  const report = vi.fn(async () => true);
  const guard = new SpendGuard();
  const requester = new X402Requester({
    provider,
    guard,
    fetch: fetchMock,
    loadConfig: async () => cfg(opts.config),
    createExactPayment,
    probe: async () => opts.probe ?? { status: "unscored", host: "seller.test" },
    bazaarPrice: async () => (opts.bazaar === undefined ? null : opts.bazaar),
    findPayment: opts.chain === "skip" ? undefined : findPayment,
    netFailuresFile,
    log,
    report,
    ...opts.deps,
  });
  return { requester, sellerCalls, createExactPayment, findPayment, guard, log, report, netFailuresFile };
}

const scored = (verdict: string, ts = "2026-11-01T00:00:00.000Z"): ProbeLookup => ({
  status: "scored",
  host: "seller.test",
  score: 50,
  verdict: verdict as any,
  last_paid: { ts, outcome: verdict as any, network: BASE_SEPOLIA, amount: "1000", price_usd: 0.001 },
  buyable_without_input: true,
  requires_input_reason: null,
  receipt_advertised: null,
  catalog_price_usd: null,
});

describe("make_x402_request (safe buy)", () => {
  beforeEach(() => {
    delete process.env.NVM_API_KEY;
    delete process.env.SCHEME_PRIORITY;
  });

  it("200 with a settlement header whose tx is our transfer: fulfilled / verified / header matched", async () => {
    const { requester, sellerCalls } = setup({
      seller: [res402([exactReq("1000")]), resOk({ data: 1 }, { "payment-response": b64({ success: true, transaction: TX, network: BASE_SEPOLIA }) })],
    });
    const r = await requester.request({ url: URL_ });
    expect(r).toMatchObject({ status: "fulfilled", settlement: "verified", header_tx_matched: true, tx: { network: BASE_SEPOLIA, tx: TX } });
    expect(r.body_sha256).toBe(sha256Hex(JSON.stringify({ data: 1 })));
    expect(sellerCalls).toHaveLength(2);
    expect((sellerCalls[1].headers as Record<string, string>)["PAYMENT-SIGNATURE"]).toBe("signed");
  });

  it("200 without a settlement header: the tx is identified on chain (header_tx_matched null)", async () => {
    const { requester, findPayment } = setup({ seller: [res402([exactReq("1000")]), resOk({ data: 1 })] });
    const r = await requester.request({ url: URL_ });
    expect(r).toMatchObject({ status: "fulfilled", settlement: "verified", header_tx_matched: null, tx: { tx: TX } });
    const [key, headerTx] = findPayment.mock.calls[0];
    expect(key).toMatchObject({ family: "evm", key: NONCE, payer: PAYER, amount: 1000n });
    expect(headerTx).toBeNull();
  });

  it("settlement header names a tx the chain does not have: not_found, header not matched, not counted", async () => {
    const fake = "0x" + "cd".repeat(32);
    const { requester, guard } = setup({
      seller: [res402([exactReq("1000")]), resOk({ data: 1 }, { "payment-response": b64({ success: true, transaction: fake }) })],
      chain: { settlement: "not_found", tx: null, transferred: null, headerTxMatched: false },
    });
    const r = await requester.request({ url: URL_ });
    expect(r).toMatchObject({ status: "fulfilled", settlement: "not_found", header_tx_matched: false, tx: null, paid: false });
    expect(guard.sessionSpentMicros).toBe(0n);
  });

  it("402 again after paying, no transfer: rejected_by_seller, (host, network) remembered", async () => {
    const { requester, netFailuresFile, guard } = setup({
      seller: [res402([exactReq("1000")]), res402([exactReq("1000")])],
      chain: { settlement: "not_found", tx: null, transferred: null, headerTxMatched: null },
    });
    const r = await requester.request({ url: URL_ });
    expect(r).toMatchObject({ status: "rejected_by_seller", settlement: "not_found" });
    expect(guard.sessionSpentMicros).toBe(0n);
    const rec = JSON.parse(readFileSync(netFailuresFile, "utf8").trim());
    expect(rec).toMatchObject({ host: "seller.test", network: BASE_SEPOLIA });
  });

  it("402 again after paying, transfer landed: not_delivered / verified, not re-sent", async () => {
    const { requester, sellerCalls } = setup({ seller: [res402([exactReq("1000")]), res402([exactReq("1000")])] });
    const r = await requester.request({ url: URL_ });
    expect(r).toMatchObject({ status: "not_delivered", settlement: "verified", refetched: false });
    expect(sellerCalls).toHaveLength(2);
  });

  it("required input missing: blocked before signing", async () => {
    const bazaar = { bazaar: { info: { input: { type: "http", method: "GET", queryParams: { ticker: { type: "string", required: true } } } } } };
    const { requester, createExactPayment, sellerCalls } = setup({ seller: [res402([exactReq("1000")], { extensions: bazaar })] });
    const r = await requester.request({ url: URL_ });
    expect(r).toMatchObject({ status: "blocked", blocked_reason: "missing_input", missing: ["query: ticker"] });
    expect(createExactPayment).not.toHaveBeenCalled();
    expect(sellerCalls).toHaveLength(1);
  });

  it("required input present: pays", async () => {
    const bazaar = { bazaar: { info: { input: { type: "http", method: "GET", queryParams: { ticker: { type: "string", required: true } } } } } };
    const { requester } = setup({ seller: [res402([exactReq("1000")], { extensions: bazaar }), resOk({ ok: 1 })] });
    const r = await requester.request({ url: URL_ + "?ticker=NVDA" });
    expect(r.status).toBe("fulfilled");
  });

  it("Probe says paid but not delivered: blocked (probeMode block), never even asks for the 402", async () => {
    const { requester, createExactPayment, sellerCalls } = setup({ seller: [], probe: scored("not_delivered") });
    const r = await requester.request({ url: URL_ });
    expect(r).toMatchObject({ status: "blocked", blocked_reason: "probe_not_delivered" });
    expect(createExactPayment).not.toHaveBeenCalled();
    expect(sellerCalls).toHaveLength(0);
  });

  it("Probe not_delivered with probeMode warn: pays and warns; unavailable / unscored never stop", async () => {
    const a = setup({ seller: [res402([exactReq("1000")]), resOk({})], probe: scored("not_delivered"), config: { probeMode: "warn" } });
    const ra = await a.requester.request({ url: URL_ });
    expect(ra.status).toBe("fulfilled");
    expect(ra.warnings?.join(" ")).toMatch(/not delivered/);
    const b = setup({ seller: [res402([exactReq("1000")]), resOk({})], probe: { status: "unavailable", host: "seller.test", error: "timeout" } });
    expect(await b.requester.request({ url: URL_ })).toMatchObject({ status: "fulfilled", probe: "unavailable" });
    const c = setup({ seller: [res402([exactReq("1000")]), resOk({})] });
    expect(await c.requester.request({ url: URL_ })).toMatchObject({ status: "fulfilled", probe: "unscored" });
  });

  it("(host, network) refused recently: another network is chosen; all refused: blocked", async () => {
    const solReq = { ...exactReq("1000", SOLANA_DEVNET), payTo: "So11111111111111111111111111111111111111112" };
    const a = setup({ seller: [res402([exactReq("1000"), solReq])] });
    const { appendFileSync } = await import("node:fs");
    appendFileSync(a.netFailuresFile, JSON.stringify({ ts: new Date().toISOString(), host: "seller.test", network: BASE_SEPOLIA }) + "\n");
    // Solana payload cannot be decoded from the EVM mock, so stop at signing to see the choice.
    a.createExactPayment.mockImplementationOnce(async (pr: Record<string, any>) => {
      throw Object.assign(new Error(`chose ${pr.accepts[0].network}`), {});
    });
    await expect(a.requester.request({ url: URL_ })).rejects.toThrow(`chose ${SOLANA_DEVNET}`);

    const b = setup({ seller: [res402([exactReq("1000")])] });
    appendFileSync(b.netFailuresFile, JSON.stringify({ ts: new Date().toISOString(), host: "seller.test", network: BASE_SEPOLIA }) + "\n");
    const rb = await b.requester.request({ url: URL_ });
    expect(rb).toMatchObject({ status: "blocked", blocked_reason: "network_avoided" });
    expect(b.createExactPayment).not.toHaveBeenCalled();

    // A refusal older than 24 h, or older than the Probe's latest paid measurement, no longer counts.
    const c = setup({ seller: [res402([exactReq("1000")]), resOk({})], probe: scored("delivered", new Date().toISOString()) });
    appendFileSync(c.netFailuresFile, JSON.stringify({ ts: new Date(Date.now() - 60_000).toISOString(), host: "seller.test", network: BASE_SEPOLIA }) + "\n");
    expect((await c.requester.request({ url: URL_ })).status).toBe("fulfilled");
  });

  it("over the per-call limit or a Bazaar price mismatch (block): blocked, no value of the limit in the result", async () => {
    const a = setup({ seller: [res402([exactReq("200000")])], config: { perCallMaxUsd: "0.0005" } });
    const ra = await a.requester.request({ url: URL_ });
    expect(ra).toMatchObject({ status: "blocked", blocked_reason: "over_cap" });
    expect(JSON.stringify(ra)).not.toMatch(/0\.0005|0\.00050/);
    expect(a.createExactPayment).not.toHaveBeenCalled();

    const b = setup({ seller: [res402([exactReq("2000")])], bazaar: "1000", config: { priceMismatch: "block" } });
    expect(await b.requester.request({ url: URL_ })).toMatchObject({ status: "blocked", blocked_reason: "price_mismatch" });

    const c = setup({ seller: [res402([exactReq("2000")]), resOk({})], bazaar: "1000" });
    const rc = await c.requester.request({ url: URL_ });
    expect(rc.status).toBe("fulfilled");
    expect(rc.price_check).toMatchObject({ listed: "1000", offered: "2000", matches: false });
  });

  it("host outside allowedHosts: blocked before any request", async () => {
    const { requester, sellerCalls } = setup({ seller: [], config: { allowedHosts: ["other.test"] } });
    expect(await requester.request({ url: URL_ })).toMatchObject({ status: "blocked", blocked_reason: "host_not_allowed" });
    expect(sellerCalls).toHaveLength(0);
  });
});

describe("Delivery Receipt refetch", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const rawPub = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  const wellKnown = { keys: [{ key_id: "k1", alg: "Ed25519", public_key: base64urlEncode(new Uint8Array(rawPub)) }], refetch_window_s: 604800, refetch_header: "X-Payment-Refetch" };
  const signedReceipt = (body: string, delivery: "first" | "refetch") => {
    const payload: ReceiptPayload = {
      v: 1,
      payment_id: NONCE,
      network: BASE_SEPOLIA,
      resource: URL_,
      body_sha256: sha256Hex(body),
      content_length: Buffer.byteLength(body),
      issued_at: new Date().toISOString(),
      delivery,
      key_id: "k1",
    };
    const sig = edSign(null, Buffer.from(receiptSigningBytes(payload)), privateKey);
    return encodeReceipt({ ...payload, sig: base64urlEncode(new Uint8Array(sig)) });
  };

  it("receipt seller answers 500 after the transfer: refetched once with the same payment -> recovered_by_retry", async () => {
    const body = JSON.stringify({ data: "paid" });
    const { requester, sellerCalls } = setup({
      seller: [
        res402([exactReq("1000")]),
        new Response("boom", { status: 500 }),
        new Response(body, { status: 200, headers: { "content-type": "application/json", "X-Delivery-Receipt": signedReceipt(body, "refetch") } }),
      ],
      wellKnown,
    });
    const r = await requester.request({ url: URL_ });
    expect(r).toMatchObject({ status: "recovered_by_retry", settlement: "verified", refetched: true, http_status: 200 });
    expect(r.receipt).toMatchObject({ ok: true, verified: true });
    expect(r.body_sha256).toBe(sha256Hex(body));
    expect(sellerCalls).toHaveLength(3);
    const refetchHeaders = sellerCalls[2].headers as Record<string, string>;
    expect(refetchHeaders["PAYMENT-SIGNATURE"]).toBe("signed");
    expect(refetchHeaders["X-Payment-Refetch"]).toBe(NONCE);
  });

  it("seller without receipt keys answers 500: the payment is not re-sent", async () => {
    const { requester, sellerCalls } = setup({ seller: [res402([exactReq("1000")]), new Response("boom", { status: 500 })] });
    const r = await requester.request({ url: URL_ });
    expect(r).toMatchObject({ status: "not_delivered", settlement: "verified", refetched: false });
    expect(sellerCalls).toHaveLength(2);
  });

  it("first delivery with a receipt: hash and signature verified", async () => {
    const body = JSON.stringify({ data: "paid" });
    const { requester } = setup({
      seller: [res402([exactReq("1000")]), new Response(body, { status: 200, headers: { "content-type": "application/json", "X-Delivery-Receipt": signedReceipt(body, "first") } })],
      wellKnown,
    });
    const r = await requester.request({ url: URL_ });
    expect(r).toMatchObject({ status: "fulfilled", receipt: { ok: true } });
    const tampered = setup({
      seller: [res402([exactReq("1000")]), new Response(body + " ", { status: 200, headers: { "X-Delivery-Receipt": signedReceipt(body, "first") } })],
      wellKnown,
    });
    expect((await tampered.requester.request({ url: URL_ })).receipt).toMatchObject({ ok: false, reason: "receipt_hash_mismatch" });
  });
});

describe("RPC failover in the chain check", () => {
  it("first RPC answers 429: switches to the next, finds the payment, never re-sends", async () => {
    const rpcHits: string[] = [];
    const rpcFetch = (async (url: string, init?: RequestInit) => {
      rpcHits.push(new URL(url).host);
      if (url.includes("limited")) return new Response("Too Many Requests", { status: 429 });
      const { method } = JSON.parse(String(init?.body));
      const result =
        method === "eth_blockNumber"
          ? "0x100"
          : method === "eth_getLogs"
            ? [{ transactionHash: TX }]
            : {
                status: "0x1",
                logs: [
                  {
                    address: exactReq("1000").asset,
                    topics: [
                      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                      "0x" + PAYER.slice(2).padStart(64, "0"),
                      "0x" + exactReq("1000").payTo.slice(2).toLowerCase().padStart(64, "0"),
                    ],
                    data: "0x" + (1000).toString(16).padStart(64, "0"),
                  },
                ],
              };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
    }) as unknown as typeof fetch;
    const rpc = (network: string, method: string, params: unknown[]) =>
      rpcCall(network, method, params, { urls: ["https://limited.rpc", "https://second.rpc"], fetch: rpcFetch, attempts: 2, delayMs: 0 });
    const { requester, sellerCalls } = setup({
      seller: [res402([exactReq("1000")]), resOk({ ok: 1 })],
      chain: "skip" as any,
      deps: { findOptions: { rpc: rpc as any, attempts: 1, intervalMs: 0 } },
    });
    const r = await requester.request({ url: URL_ });
    expect(r).toMatchObject({ status: "fulfilled", settlement: "verified", tx: { tx: TX } });
    expect(rpcHits.filter((h) => h === "limited.rpc").length).toBeGreaterThan(0);
    expect(rpcHits).toContain("second.rpc");
    expect(sellerCalls).toHaveLength(2);
  });

  it("every RPC fails: settlement unknown, counted, not re-sent", async () => {
    const rpcFetch = (async () => new Response("Too Many Requests", { status: 429 })) as unknown as typeof fetch;
    const rpc = (network: string, method: string, params: unknown[]) =>
      rpcCall(network, method, params, { urls: ["https://a.rpc", "https://b.rpc"], fetch: rpcFetch, attempts: 1, delayMs: 0 });
    const { requester, sellerCalls, guard } = setup({
      seller: [res402([exactReq("1000")]), new Response("boom", { status: 500 })],
      chain: "skip" as any,
      deps: { findOptions: { rpc: rpc as any, attempts: 1, intervalMs: 0 } },
    });
    const r = await requester.request({ url: URL_ });
    expect(r).toMatchObject({ status: "not_delivered", settlement: "unknown" });
    expect(sellerCalls).toHaveLength(2);
    expect(guard.sessionSpentMicros).toBe(1000n);
  });
});

describe("check_seller", () => {
  it("reports Probe, accepts, missing input, Bazaar price, refusals and receipt support without paying", async () => {
    const bazaar = { bazaar: { info: { input: { type: "http", method: "GET", queryParams: { q: { required: true } } } } } };
    const { requester, createExactPayment, sellerCalls } = setup({
      seller: [res402([exactReq("2000")], { extensions: bazaar })],
      probe: scored("delivered"),
      bazaar: "1000",
      wellKnown: { keys: [{ key_id: "k", alg: "Ed25519", public_key: "A".repeat(43) }], refetch_window_s: 604800, refetch_header: "X-Payment-Refetch" },
    });
    const r: any = await requester.checkSeller({ url: URL_ });
    expect(createExactPayment).not.toHaveBeenCalled();
    expect(sellerCalls).toHaveLength(1);
    expect(r.probe).toMatchObject({ status: "scored", verdict: "delivered" });
    expect(r.input).toMatchObject({ ok: false, missing: ["query: q"] });
    expect(r.bazaar_price[0]).toMatchObject({ network: BASE_SEPOLIA, listed: "1000", offered: "2000", matches: false });
    expect(r.delivery_receipt).toMatchObject({ supported: true });
    expect(r.would_pay).toMatchObject({ amount: "2000" });
  });
});

describe("limits never leak their values", () => {
  it("summary and errors carry no limit or spend values", () => {
    const g = new SpendGuard();
    const c = cfg({ perCallMaxUsd: "0.0005", perSessionMaxUsd: "0.0123" });
    expect(JSON.stringify(g.summary(c))).not.toMatch(/0\.0005|0\.0123/);
    for (const amount of [1000n, 600n]) {
      try {
        g.checkAmount(c, amount);
      } catch (e) {
        expect((e as Error).message).not.toMatch(/0\.0005|0\.0123|0\.000500/);
      }
    }
    expect(BASE).toBe("eip155:8453");
  });
});
