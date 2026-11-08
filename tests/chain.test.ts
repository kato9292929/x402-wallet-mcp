import { describe, expect, it } from "vitest";
import { checkInput } from "../src/safe/input.js";
import { activeRefusals } from "../src/safe/netfail.js";
import { checkSolanaTransfer, findPayment, type PayerKey } from "../src/safe/chain.js";
import { BASE_SEPOLIA, SOLANA_DEVNET } from "./helpers.js";

const evmKey: PayerKey = {
  network: BASE_SEPOLIA,
  family: "evm",
  payer: "0x00000000000000000000000000000000000000aa",
  key: "0x" + "11".repeat(32),
  payTo: "0x000000000000000000000000000000000000dEaD",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  amount: 1000n,
};

describe("findPayment (EVM)", () => {
  it("header names a tx but our nonce was never used: not_found, header not matched", async () => {
    const rpc = async (_n: string, method: string) => ({ result: method === "eth_blockNumber" ? "0x10" : [], rpc: "x" }) as any;
    const r = await findPayment(evmKey, "0x" + "cd".repeat(32), { rpc: rpc as any, attempts: 2, intervalMs: 0 });
    expect(r).toMatchObject({ settlement: "not_found", tx: null, headerTxMatched: false });
  });

  it("landed with a different amount: verified (money moved) with a mismatch", async () => {
    const tx = "0x" + "ab".repeat(32);
    const rpc = async (_n: string, method: string) => {
      if (method === "eth_blockNumber") return { result: "0x10", rpc: "x" };
      if (method === "eth_getLogs") return { result: [{ transactionHash: tx }], rpc: "x" };
      return {
        result: {
          status: "0x1",
          logs: [
            {
              address: evmKey.asset,
              topics: [
                "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                "0x" + evmKey.payer.slice(2).padStart(64, "0"),
                "0x" + evmKey.payTo.slice(2).toLowerCase().padStart(64, "0"),
              ],
              data: "0x" + (2000).toString(16).padStart(64, "0"),
            },
          ],
        },
        rpc: "x",
      };
    };
    const r = await findPayment(evmKey, tx, { rpc: rpc as any, attempts: 1, intervalMs: 0 });
    expect(r).toMatchObject({ settlement: "verified", tx, transferred: 2000n, headerTxMatched: true });
    expect(r.mismatch).toMatch(/2000 != 1000/);
  });
});

describe("Solana transfer check", () => {
  const k = { payer: "Payer111", payTo: "PayTo111", asset: "Mint111", amount: 1000n };
  const bal = (owner: string, amount: string) => ({ mint: "Mint111", owner, uiTokenAmount: { amount } });
  it("matches when payTo gains and payer loses exactly the amount", () => {
    const tx = { meta: { err: null, preTokenBalances: [bal("Payer111", "5000"), bal("PayTo111", "0")], postTokenBalances: [bal("Payer111", "4000"), bal("PayTo111", "1000")] } };
    expect(checkSolanaTransfer(tx, k)).toMatchObject({ ok: true, transferred: 1000n });
  });
  it("flags a different amount", () => {
    const tx = { meta: { err: null, preTokenBalances: [bal("Payer111", "5000"), bal("PayTo111", "0")], postTokenBalances: [bal("Payer111", "3000"), bal("PayTo111", "2000")] } };
    expect(checkSolanaTransfer(tx, k).ok).toBe(false);
  });
  it("Solana search finds our signature in the header's tx", async () => {
    const key: PayerKey = { ...evmKey, network: SOLANA_DEVNET, family: "solana", payer: "Payer111", key: "MySig", payTo: "PayTo111", asset: "Mint111" };
    const tx = {
      transaction: { signatures: ["FeePayerSig", "MySig"] },
      meta: { err: null, preTokenBalances: [bal("Payer111", "5000"), bal("PayTo111", "0")], postTokenBalances: [bal("Payer111", "4000"), bal("PayTo111", "1000")] },
    };
    const rpc = async (_n: string, method: string) => ({ result: method === "getTransaction" ? tx : [], rpc: "x" }) as any;
    const r = await findPayment(key, "FeePayerSig", { rpc: rpc as any, attempts: 1, intervalMs: 0 });
    expect(r).toMatchObject({ settlement: "verified", tx: "FeePayerSig", headerTxMatched: true, transferred: 1000n });
  });
});

describe("input check", () => {
  it("reads JSON-schema and example forms", () => {
    const schema = {
      extensions: {
        bazaar: { schema: { properties: { input: { properties: { method: { enum: ["POST"] }, body: { required: ["prompt"] } } } } } },
      },
    };
    expect(checkInput(schema, { url: "https://x.test/a", method: "GET" }).missing).toEqual(["method POST (request uses GET)", "body: prompt"]);
    expect(checkInput(schema, { url: "https://x.test/a", method: "POST", body: { prompt: "hi" } }).ok).toBe(true);
    const v1 = { accepts: [{ outputSchema: { input: { method: "GET", queryParams: { ticker: { required: true } } } } }] };
    expect(checkInput(v1, { url: "https://x.test/a?ticker=X" }).ok).toBe(true);
    expect(checkInput({}, { url: "https://x.test/a" }).ok).toBe(true);
    // coincap-style: schema marks nothing required, info shows an example value
    const ex = { extensions: { bazaar: { info: { input: { method: "GET", queryParams: { slugs: "bitcoin" } } }, schema: { properties: { input: { properties: { method: { enum: ["GET"] }, queryParams: { properties: { slugs: { type: "string" } } } } } } } } } };
    const c = checkInput(ex, { url: "https://x.test/a" });
    expect(c).toMatchObject({ ok: true, unsetExamples: ["query: slugs"] });
    expect(checkInput(ex, { url: "https://x.test/a?slugs=bitcoin" }).unsetExamples).toEqual([]);
  });
});

describe("refusal memory", () => {
  it("24 h, or until the Probe measures again", () => {
    const now = Date.parse("2026-11-07T12:00:00Z");
    const r = [{ ts: "2026-11-07T00:00:00Z", host: "h", network: "n" }];
    expect(activeRefusals(r, "h", null, now)).toHaveLength(1);
    expect(activeRefusals(r, "h", null, now + 13 * 3600_000)).toHaveLength(0);
    expect(activeRefusals(r, "h", "2026-11-07T06:00:00Z", now)).toHaveLength(0);
    expect(activeRefusals(r, "other", null, now)).toHaveLength(0);
  });
});
