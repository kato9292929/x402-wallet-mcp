import { describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { BASE, BASE_SEPOLIA } from "../src/chains.js";
import { ParamError, parseParams } from "../src/remote/params.js";
import {
  MAX_PENDING_PER_ADDRESS,
  buildPayment,
  getResult,
  phantomBrowseLink,
  walletChangeProblem,
  LIGHTHOUSE_PROGRAM,
  rejectPayment,
  requestPayment,
  signAndPay,
  type FlowDeps,
} from "../src/remote/payments.js";
import { memoryStore } from "../src/remote/store.js";
import type { ChainResult } from "../src/safe/chain.js";
import { exactReq, res200, res402 } from "./helpers.js";

const owner = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const URL_ = "https://seller.test/api";
const ORIGIN = "https://agentpay.test";
const TX = "0x" + "ab".repeat(32);

function setup(opts: { amount?: string; seller?: () => Response; chain?: Partial<ChainResult> } = {}) {
  const sellerCalls: RequestInit[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/.well-known/x402-receipt.json")) return new Response("no", { status: 404 });
    if (url.startsWith(URL_)) {
      sellerCalls.push(init ?? {});
      const paid = new Headers(init?.headers).has("payment-signature");
      if (!paid) return res402([exactReq(opts.amount ?? "5000", BASE_SEPOLIA)]);
      return opts.seller ? opts.seller() : res200({ ok: true }, { success: true, transaction: TX, network: BASE_SEPOLIA });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;
  const deps: FlowDeps = {
    store: memoryStore(),
    fetch: fetchMock,
    requesterOverrides: {
      probe: async () => ({ status: "unscored", host: "seller.test" }) as any,
      bazaarPrice: async () => null,
      findPayment: async () => ({ settlement: "verified", tx: TX, transferred: 5000n, headerTxMatched: true, ...opts.chain }),
    },
  };
  const params = parseParams(new URL(`${ORIGIN}/api/mcp?base=${owner.address}&network=testnet`));
  return { deps, params, sellerCalls };
}

const tokenOf = (approveUrl: string) => new URL(approveUrl).searchParams.get("t");

async function signTyped(account: typeof owner, typedData: string) {
  const td = JSON.parse(typedData);
  const { EIP712Domain, ...types } = td.types;
  return account.signTypedData({ ...td, types });
}

describe("remote: connection URL", () => {
  it("reads addresses and can only lower the limits", () => {
    const p = parseParams(new URL(`${ORIGIN}/api/mcp?base=${owner.address}&network=mainnet&max=0.05&daily=5`));
    expect(p).toMatchObject({ base: owner.address, network: "mainnet", perCallMaxUsd: "0.05", dailyMaxUsd: "1.00" });
    expect(parseParams(new URL(`${ORIGIN}/mcp`))).toMatchObject({ network: "mainnet", perCallMaxUsd: "0.10", dailyMaxUsd: "1.00" });
    expect(() => parseParams(new URL(`${ORIGIN}/mcp?network=moon`))).toThrow(ParamError);
    expect(() => parseParams(new URL(`${ORIGIN}/api/mcp?solana=nope`))).toThrow(/Solana/);
  });

  it("builds a Phantom in-app browser link with both parts encoded", () => {
    const page = `${ORIGIN}/approve/abc?t=123&x=1`;
    const link = phantomBrowseLink(page, ORIGIN);
    expect(link).toBe(
      "https://phantom.app/ul/browse/https%3A%2F%2Fagentpay.test%2Fapprove%2Fabc%3Ft%3D123%26x%3D1?ref=https%3A%2F%2Fagentpay.test",
    );
    const u = new URL(link);
    expect(decodeURIComponent(u.pathname.replace("/ul/browse/", ""))).toBe(page);
    expect(u.searchParams.get("ref")).toBe(ORIGIN);
  });
});

describe("remote: approval flow (Base)", () => {
  it("pays only after approval and signature, once", async () => {
    const { deps, params, sellerCalls } = setup();
    const r = await requestPayment(params, { url: URL_ }, ORIGIN, deps);
    expect(r.status).toBe("awaiting_approval");
    expect(r.approve_url).toMatch(new RegExp(`^${ORIGIN}/approve/[0-9a-f]{32}\\?t=[0-9a-f]{32}$`));
    expect(r.phantom_app_url).toContain("phantom.app/ul/browse/");
    expect((await getResult(r.request_id, deps)).status).toBe("awaiting_approval");
    expect(sellerCalls).toHaveLength(1); // the unpaid 402 only

    const t = tokenOf(r.approve_url);
    const built = await buildPayment(r.request_id, t, deps);
    expect(built.family).toBe("evm");
    expect((await getResult(r.request_id, deps)).status).toBe("processing");

    const out = await signAndPay(r.request_id, t, await signTyped(owner, built.typedData as string), deps);
    expect(out).toMatchObject({ status: "fulfilled", paid: true });
    const paidCall = sellerCalls.at(-1)!;
    expect(new Headers(paidCall.headers).get("payment-signature")).toBeTruthy();

    const res = await getResult(r.request_id, deps);
    expect(res).toMatchObject({ status: "fulfilled", paid: true, body: JSON.stringify({ ok: true }) });

    // The same request id is never paid again.
    await expect(signAndPay(r.request_id, t, "0x00", deps)).rejects.toThrow(/処理が終わっています/);
    expect(sellerCalls.filter((c) => new Headers(c.headers).has("payment-signature"))).toHaveLength(1);
  });

  it("refuses a signature from another wallet and pays nothing", async () => {
    const { deps, params, sellerCalls } = setup();
    const r = await requestPayment(params, { url: URL_ }, ORIGIN, deps);
    const t = tokenOf(r.approve_url);
    const built = await buildPayment(r.request_id, t, deps);
    await expect(signAndPay(r.request_id, t, await signTyped(stranger, built.typedData as string), deps)).rejects.toThrow(/指定した財布の署名ではありません/);
    expect(sellerCalls.some((c) => new Headers(c.headers).has("payment-signature"))).toBe(false);
  });

  it("needs the link's token", async () => {
    const { deps, params } = setup();
    const r = await requestPayment(params, { url: URL_ }, ORIGIN, deps);
    await expect(buildPayment(r.request_id, "wrong", deps)).rejects.toThrow(/期限が切れました/);
  });

  it("reject ends the request without paying", async () => {
    const { deps, params, sellerCalls } = setup();
    const r = await requestPayment(params, { url: URL_ }, ORIGIN, deps);
    await rejectPayment(r.request_id, tokenOf(r.approve_url), deps);
    expect(await getResult(r.request_id, deps)).toMatchObject({ status: "blocked", blocked_reason: "not_approved", paid: false });
    expect(sellerCalls).toHaveLength(1);
  });

  it("blocks over the per-payment limit set in the URL, before any link", async () => {
    const { deps } = setup({ amount: "50000" }); // 0.05 USDC
    const params = parseParams(new URL(`${ORIGIN}/api/mcp?base=${owner.address}&network=testnet&max=0.01`));
    const r = await requestPayment(params, { url: URL_ }, ORIGIN, deps);
    expect(r).toMatchObject({ status: "blocked", blocked_reason: "over_cap" });
  });

  it("counts payments toward the 24-hour total", async () => {
    const { deps } = setup({ amount: "60000" }); // 0.06 USDC each
    const params = parseParams(new URL(`${ORIGIN}/api/mcp?base=${owner.address}&network=testnet&daily=0.10`));
    const r = await requestPayment(params, { url: URL_ }, ORIGIN, deps);
    const t = tokenOf(r.approve_url);
    const built = await buildPayment(r.request_id, t, deps);
    await signAndPay(r.request_id, t, await signTyped(owner, built.typedData as string), deps);
    const second = await requestPayment(params, { url: URL_ }, ORIGIN, deps);
    expect(second).toMatchObject({ status: "blocked", blocked_reason: "over_cap" });
  });

  it("limits how many payments can wait for approval", async () => {
    const { deps, params } = setup();
    for (let i = 0; i < MAX_PENDING_PER_ADDRESS; i++) {
      expect((await requestPayment(params, { url: URL_ }, ORIGIN, deps)).status).toBe("awaiting_approval");
    }
    expect(await requestPayment(params, { url: URL_ }, ORIGIN, deps)).toMatchObject({ status: "blocked", blocked_reason: "too_many_pending" });
  });

  it("remembers a seller's refusal and avoids that network", async () => {
    const { deps, params } = setup({
      seller: () => res402([exactReq("5000", BASE_SEPOLIA)]),
      chain: { settlement: "not_found", tx: null, transferred: null, headerTxMatched: null },
    });
    const r = await requestPayment(params, { url: URL_ }, ORIGIN, deps);
    const t = tokenOf(r.approve_url);
    const built = await buildPayment(r.request_id, t, deps);
    expect(await signAndPay(r.request_id, t, await signTyped(owner, built.typedData as string), deps)).toMatchObject({
      status: "rejected_by_seller",
      paid: false,
    });
    expect(await requestPayment(params, { url: URL_ }, ORIGIN, deps)).toMatchObject({ status: "blocked", blocked_reason: "network_avoided" });
  });

  it("uses mainnet Base when the URL says mainnet", () => {
    const p = parseParams(new URL(`${ORIGIN}/api/mcp?base=${owner.address}&network=mainnet`));
    expect(p.network).toBe("mainnet");
    expect(BASE).toBe("eip155:8453");
  });
});

describe("remote: what Phantom may change in a Solana payment", async () => {
  const web3 = await import("@solana/web3.js");
  const user = web3.Keypair.generate().publicKey;
  const feePayer = web3.Keypair.generate().publicKey;
  const blockhash = web3.Keypair.generate().publicKey.toBase58();
  const TOKEN = new web3.PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  const ix = (program: InstanceType<typeof web3.PublicKey>, data: number[]) =>
    new web3.TransactionInstruction({ programId: program, keys: [{ pubkey: user, isSigner: true, isWritable: true }], data: Buffer.from(data) });
  const transfer = ix(TOKEN, [12, 1, 2, 3]);
  const memo = ix(new web3.PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), [7, 7]);
  const lighthouse = ix(new web3.PublicKey(LIGHTHOUSE_PROGRAM), [9]);
  const msg = (ixs: InstanceType<typeof web3.TransactionInstruction>[], opts: { payer?: any; hash?: string } = {}) =>
    new web3.TransactionMessage({ payerKey: opts.payer ?? feePayer, recentBlockhash: opts.hash ?? blockhash, instructions: ixs }).compileToV0Message().serialize();
  const original = msg([transfer, memo]);

  it("accepts the same transaction, or up to 3 added Lighthouse instructions", () => {
    expect(walletChangeProblem(original, original)).toBeNull();
    expect(walletChangeProblem(original, msg([transfer, memo, lighthouse]))).toBeNull();
    expect(walletChangeProblem(original, msg([lighthouse, transfer, lighthouse, memo, lighthouse]))).toBeNull();
  });

  it("accepts new compute-budget values, not other compute-budget instructions", () => {
    const CB = new web3.PublicKey("ComputeBudget111111111111111111111111111111");
    const budget = (d: number[]) => new web3.TransactionInstruction({ programId: CB, keys: [], data: Buffer.from(d) });
    const built = msg([budget([2, 1, 0, 0, 0]), budget([3, 1, 0, 0, 0, 0, 0, 0, 0]), transfer, memo]);
    expect(walletChangeProblem(built, msg([budget([2, 9, 9, 0, 0]), budget([3, 5, 0, 0, 0, 0, 0, 0, 0]), transfer, memo, lighthouse]))).toBeNull();
    expect(walletChangeProblem(built, msg([budget([2, 1, 0, 0, 0]), budget([3, 1, 0, 0, 0, 0, 0, 0, 0]), budget([1, 0, 0, 0, 0]), transfer, memo]))).toMatch(/changed or added/);
  });

  it("refuses any other change", () => {
    expect(walletChangeProblem(original, msg([transfer, memo, lighthouse, lighthouse, lighthouse, lighthouse]))).toMatch(/too many/);
    expect(walletChangeProblem(original, msg([transfer, memo, ix(TOKEN, [3])]))).toMatch(/changed or added/);
    expect(walletChangeProblem(original, msg([ix(TOKEN, [12, 9, 9, 9]), memo]))).toBeTruthy();
    expect(walletChangeProblem(original, msg([transfer]))).toBeTruthy();
    expect(walletChangeProblem(original, msg([transfer, memo], { hash: web3.Keypair.generate().publicKey.toBase58() }))).toMatch(/blockhash/);
    expect(walletChangeProblem(original, msg([transfer, memo], { payer: web3.Keypair.generate().publicKey }))).toMatch(/fee payer/);
  });
});
