import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpendGuard, SpendLimitError } from "../src/limits.js";
import type { NeverminedPayer } from "../src/nevermined.js";
import type { WalletProvider } from "../src/providers/types.js";
import { PaymentError, X402Requester } from "../src/x402/request.js";
import { BASE_SEPOLIA, cfg, exactReq, nvmReq, res200, res402 } from "./helpers.js";
import type { SpendConfig } from "../src/config.js";

const provider: WalletProvider = {
  id: "cdp",
  chains: () => [BASE_SEPOLIA],
  address: async () => "0xabc",
  usdcBalance: async () => "1.00",
  fundingInfo: async () => ({ address: "0xabc" }),
  ready: async () => ({ ok: true }),
};

function setup(responses: Response[], config: SpendConfig = cfg(), nvm?: Partial<NeverminedPayer>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = responses.shift();
    if (!r) throw new Error("unexpected fetch");
    return r;
  }) as unknown as typeof fetch;
  const createExactHeaders = vi.fn(async () => ({ "PAYMENT-SIGNATURE": "signed" }));
  const log = vi.fn(async () => {});
  const guard = new SpendGuard();
  const requester = new X402Requester({
    provider,
    guard,
    fetch: fetchMock,
    loadConfig: async () => config,
    createExactHeaders,
    log,
    nevermined: nvm as NeverminedPayer | undefined,
  });
  return { requester, calls, createExactHeaders, log, guard };
}

const URL_ = "https://seller.test/api";
const TX = "0x" + "ab".repeat(32);

describe("make_x402_request flow", () => {
  beforeEach(() => {
    delete process.env.NVM_API_KEY;
    delete process.env.SCHEME_PRIORITY;
  });

  it("returns the response untouched when no payment is required", async () => {
    const { requester, createExactHeaders } = setup([res200({ hello: 1 })]);
    const r = await requester.request({ url: URL_ });
    expect(r).toMatchObject({ status: 200, paid: false, body: '{"hello":1}' });
    expect(createExactHeaders).not.toHaveBeenCalled();
  });

  it("pays an exact 402, retries with the signature, and returns the receipt", async () => {
    const { requester, calls, log, guard } = setup([
      res402([exactReq("10000")]),
      res200({ data: "paid" }, { success: true, transaction: TX, network: BASE_SEPOLIA, payer: "0xabc" }),
    ]);
    const r = await requester.request({ url: URL_, method: "POST", body: { q: 1 } });
    expect(calls).toHaveLength(2);
    expect((calls[1].init?.headers as Record<string, string>)["PAYMENT-SIGNATURE"]).toBe("signed");
    expect(calls[1].init?.body).toBe('{"q":1}');
    expect(r).toMatchObject({ paid: true, status: 200, sessionSpentUsd: "0.01" });
    expect((r as { payment: Record<string, unknown> }).payment).toMatchObject({
      transaction: TX,
      priceUsd: "0.01",
      settled: true,
      explorerUrl: `https://sepolia.basescan.org/tx/${TX}`,
    });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ transaction: TX, priceUsd: "0.01" }));
    expect(guard.sessionSpentMicros).toBe(10_000n);
  });

  it("does not pay above the per-call limit", async () => {
    const { requester, calls, createExactHeaders } = setup([res402([exactReq("200000")])]);
    await expect(requester.request({ url: URL_ })).rejects.toMatchObject({ code: "PER_CALL_LIMIT" });
    expect(createExactHeaders).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it("stops paying once the per-session limit is reached", async () => {
    const config = cfg({ perCallMaxUsd: "0.10", perSessionMaxUsd: "0.15" });
    const { requester, createExactHeaders, guard } = setup(
      [res402([exactReq("100000")]), res200({}, { success: true, transaction: "0x1" }), res402([exactReq("100000")])],
      config,
    );
    await requester.request({ url: URL_ });
    expect(guard.sessionSpentMicros).toBe(100_000n);
    const err = await requester.request({ url: URL_ }).catch((e) => e);
    expect(err).toBeInstanceOf(SpendLimitError);
    expect(err.code).toBe("PER_SESSION_LIMIT");
    expect(createExactHeaders).toHaveBeenCalledTimes(1);
    expect(guard.sessionSpentMicros).toBe(100_000n);
  });

  it("refuses hosts outside allowedHosts", async () => {
    const { requester, createExactHeaders } = setup([res402([exactReq("1000")])], cfg({ allowedHosts: ["other.test"] }));
    await expect(requester.request({ url: URL_ })).rejects.toMatchObject({ code: "HOST_NOT_ALLOWED" });
    expect(createExactHeaders).not.toHaveBeenCalled();
  });

  it("releases the reservation when the seller rejects the payment", async () => {
    const { requester, guard } = setup([res402([exactReq("1000")]), res402([exactReq("1000")])]);
    await expect(requester.request({ url: URL_ })).rejects.toBeInstanceOf(PaymentError);
    expect(guard.sessionSpentMicros).toBe(0n);
  });

  it("errors when no option is payable", async () => {
    const { requester } = setup([res402([exactReq("1000", "eip155:8453")])]);
    await expect(requester.request({ url: URL_ })).rejects.toThrow(/None of the payment options/);
  });

  it("pays nvm:erc4337 with a Nevermined access token", async () => {
    process.env.NVM_API_KEY = "sandbox:test";
    const paymentHeaders = vi.fn(async () => ({ "payment-signature": "nvm-token" }));
    const { requester, calls } = setup(
      [res402([nvmReq()]), res200({ ok: 1 }, { success: true, transaction: "tid-123", creditsRedeemed: "1" })],
      cfg(),
      { paymentHeaders },
    );
    const r = await requester.request({ url: URL_ });
    expect(paymentHeaders).toHaveBeenCalledWith(expect.objectContaining({ planId: "4474276307", agentId: "8091842702" }), expect.anything());
    expect((calls[1].init?.headers as Record<string, string>)["payment-signature"]).toBe("nvm-token");
    expect((r as { payment: Record<string, unknown> }).payment).toMatchObject({ provider: "nevermined", transaction: "tid-123", explorerUrl: undefined });
  });

  it("prefers exact over nvm by default, nvm when SCHEME_PRIORITY says so", async () => {
    process.env.NVM_API_KEY = "sandbox:test";
    const paymentHeaders = vi.fn(async () => ({ "payment-signature": "nvm-token" }));
    const a = setup([res402([nvmReq(), exactReq("1000")]), res200({})], cfg(), { paymentHeaders });
    await a.requester.request({ url: URL_ });
    expect(a.createExactHeaders).toHaveBeenCalledTimes(1);
    expect(paymentHeaders).not.toHaveBeenCalled();

    process.env.SCHEME_PRIORITY = "nvm:erc4337,exact";
    const b = setup([res402([exactReq("1000"), nvmReq()]), res200({})], cfg(), { paymentHeaders });
    await b.requester.request({ url: URL_ });
    expect(b.createExactHeaders).not.toHaveBeenCalled();
    expect(paymentHeaders).toHaveBeenCalledTimes(1);
  });

  it("check_payment_requirements never pays", async () => {
    const { requester, calls, createExactHeaders } = setup([res402([exactReq("200000"), exactReq("1000")])]);
    const r = await requester.checkRequirements({ url: URL_ });
    expect(calls).toHaveLength(1);
    expect(createExactHeaders).not.toHaveBeenCalled();
    expect(r).toMatchObject({ paymentRequired: true, withinLimits: true, wouldPay: { amount: "1000" } });
  });
});
