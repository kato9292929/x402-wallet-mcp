import { describe, expect, it } from "vitest";
import { atomicToMicros, formatMicros, parseUsdToMicros } from "../src/chains.js";
import { validateConfig } from "../src/config.js";
import { parsePaymentRequired, parseSettleResponse, isMppChallenge } from "../src/x402/parse.js";
import { evaluate, selectRequirement, type SelectionContext } from "../src/x402/select.js";
import { BASE, BASE_SEPOLIA, SOLANA_DEVNET, b64, exactReq, nvmReq, paymentRequired } from "./helpers.js";

const headers = (h: Record<string, string>) => (n: string) => h[n.toLowerCase()] ?? null;

describe("USD helpers", () => {
  it("parses USD strings to micro-USD", () => {
    expect(parseUsdToMicros("0.10")).toBe(100_000n);
    expect(parseUsdToMicros("$1")).toBe(1_000_000n);
    expect(parseUsdToMicros("0.000001")).toBe(1n);
    expect(() => parseUsdToMicros("abc")).toThrow();
    expect(() => parseUsdToMicros("0.0000001")).toThrow();
  });
  it("formats and converts", () => {
    expect(formatMicros(10_000n)).toBe("0.01");
    expect(formatMicros(1_000n)).toBe("0.001");
    expect(formatMicros(1_500_000n)).toBe("1.50");
    expect(atomicToMicros(10n ** 18n, 18)).toBe(1_000_000n);
    expect(atomicToMicros(1n, 18)).toBe(1n); // rounds up
  });
});

describe("parsePaymentRequired", () => {
  it("reads the v2 PAYMENT-REQUIRED header", () => {
    const pr = paymentRequired([exactReq("10000")]);
    const parsed = parsePaymentRequired(headers({ "payment-required": b64(pr) }), "{}");
    expect(parsed?.x402Version).toBe(2);
    expect(parsed?.source).toBe("header");
    expect(parsed?.accepts[0]).toMatchObject({ scheme: "exact", network: BASE_SEPOLIA, amount: "10000", priceMicros: 10_000n });
  });

  it("reads a v1 JSON body with maxAmountRequired and legacy network names", () => {
    const body = {
      x402Version: 1,
      accepts: [{ ...exactReq("5000"), amount: undefined, maxAmountRequired: "5000", network: "base-sepolia" }],
    };
    const parsed = parsePaymentRequired(headers({}), JSON.stringify(body));
    expect(parsed?.x402Version).toBe(1);
    expect(parsed?.accepts[0]).toMatchObject({ network: BASE_SEPOLIA, amount: "5000", priceMicros: 5000n });
  });

  it("keeps Nevermined planId / agentId and leaves price unknown", () => {
    const parsed = parsePaymentRequired(headers({ "payment-required": b64(paymentRequired([nvmReq()])) }), undefined);
    expect(parsed?.accepts[0]).toMatchObject({ scheme: "nvm:erc4337", planId: "4474276307", agentId: "8091842702" });
    expect(parsed?.accepts[0].priceMicros).toBeUndefined();
  });

  it("does not price unknown assets", () => {
    const parsed = parsePaymentRequired(
      headers({ "payment-required": b64(paymentRequired([{ ...exactReq("1"), asset: "0x1111111111111111111111111111111111111111" }])) }),
      undefined,
    );
    expect(parsed?.accepts[0].priceMicros).toBeUndefined();
  });

  it("returns undefined for non-x402 402s", () => {
    expect(parsePaymentRequired(headers({}), "not json")).toBeUndefined();
    expect(parsePaymentRequired(headers({}), JSON.stringify({ error: "pay" }))).toBeUndefined();
  });

  it("parses settle receipts and detects MPP", () => {
    expect(parseSettleResponse(headers({ "payment-response": b64({ success: true, transaction: "0xabc" }) }))).toEqual({
      success: true,
      transaction: "0xabc",
    });
    expect(parseSettleResponse(headers({ "x-payment-response": b64({ transaction: "sig" }) }))).toEqual({ transaction: "sig" });
    expect(isMppChallenge(headers({ "www-authenticate": 'Payment id="x"' }))).toBe(true);
  });
});

describe("selectRequirement", () => {
  const ctx = (over: Partial<SelectionContext> = {}): SelectionContext => ({
    priority: ["exact", "nvm:erc4337"],
    walletChains: [BASE_SEPOLIA, SOLANA_DEVNET],
    mode: "testnet",
    nevermined: true,
    neverminedEnv: "sandbox",
    ...over,
  });
  const parse = (accepts: unknown[]) =>
    parsePaymentRequired(headers({ "payment-required": b64(paymentRequired(accepts)) }), undefined)!.accepts;

  it("prefers exact by default and picks the cheapest", () => {
    const accepts = parse([nvmReq(), exactReq("3000"), exactReq("2000", SOLANA_DEVNET)]);
    expect(selectRequirement(accepts, ctx())).toMatchObject({ scheme: "exact", amount: "2000", network: SOLANA_DEVNET });
  });

  it("honours SCHEME_PRIORITY", () => {
    const accepts = parse([exactReq("3000"), nvmReq()]);
    expect(selectRequirement(accepts, ctx({ priority: ["nvm:erc4337", "exact"] }))?.scheme).toBe("nvm:erc4337");
  });

  it("falls back to nvm when exact is not payable, and skips nvm without a key", () => {
    const accepts = parse([exactReq("3000", BASE), nvmReq()]);
    expect(selectRequirement(accepts, ctx())?.scheme).toBe("nvm:erc4337");
    expect(selectRequirement(accepts, ctx({ nevermined: false }))).toBeUndefined();
  });

  it("only pays Nevermined when the key environment matches the network mode", () => {
    const accepts = parse([nvmReq()]);
    expect(evaluate(accepts, ctx({ neverminedEnv: "live" }))[0].reason).toMatch(/live/);
    expect(evaluate(accepts, ctx({ neverminedEnv: "sandbox" }))[0].usable).toBe(true);
    expect(evaluate(accepts, ctx({ mode: "mainnet", neverminedEnv: "live", walletChains: [] }))[0].reason).toMatch(/does not match/);
  });

  it("refuses mainnet in testnet mode and unsupported chains", () => {
    const accepts = parse([exactReq("1000", BASE)]);
    const [c] = evaluate(accepts, ctx());
    expect(c.usable).toBe(false);
    expect(c.reason).toMatch(/mainnet/);
    const [d] = evaluate(parse([exactReq("1000", SOLANA_DEVNET)]), ctx({ walletChains: [BASE_SEPOLIA] }));
    expect(d.reason).toMatch(/cannot sign/);
  });
});

describe("validateConfig", () => {
  it("fills defaults and normalizes hosts", () => {
    expect(validateConfig({ allowedHosts: [" API.Example.com "] })).toEqual({
      perCallMaxUsd: "0.10",
      perSessionMaxUsd: "1.00",
      allowedHosts: ["api.example.com"],
      network: "testnet",
      probeMode: "block",
      priceMismatch: "warn",
      retryWithReceipt: true,
      reportToProbe: false,
    });
  });
  it("rejects bad values", () => {
    expect(() => validateConfig({ network: "devnet" })).toThrow();
    expect(() => validateConfig({ perCallMaxUsd: "ten" })).toThrow();
    expect(() => validateConfig([])).toThrow();
    expect(() => validateConfig({ probeMode: "maybe" })).toThrow();
    expect(() => validateConfig({ retryWithReceipt: "yes" })).toThrow();
  });
});
