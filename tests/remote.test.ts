import { describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { BASE, BASE_SEPOLIA, SOLANA_DEVNET } from "../src/chains.js";
import { ParamError, parseParams } from "../src/remote/params.js";
import {
  MAX_PENDING_PER_ADDRESS,
  buildPayment,
  getResult,
  phantomBrowseLink,
  solanaPaymentProblem,
  solanaWalletChanges,
  solanaBlockhashes,
  LIGHTHOUSE_PROGRAM,
  rejectPayment,
  normalizeEvmSignature,
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

function setup(opts: { amount?: string; accepts?: unknown[]; seller?: () => Response; chain?: Partial<ChainResult> } = {}) {
  const sellerCalls: RequestInit[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/.well-known/x402-receipt.json")) return new Response("no", { status: 404 });
    if (url.startsWith(URL_)) {
      sellerCalls.push(init ?? {});
      const paid = new Headers(init?.headers).has("payment-signature");
      if (!paid) return res402(opts.accepts ?? [exactReq(opts.amount ?? "5000", BASE_SEPOLIA)]);
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

describe("remote: choosing the chain (any connection URL pays on Solana and Base)", async () => {
  const { Keypair } = await import("@solana/web3.js");
  const sol = Keypair.generate().publicKey.toBase58();
  const solReq = (amount = "5000") => exactReq(amount, SOLANA_DEVNET, { feePayer: Keypair.generate().publicKey.toBase58() });
  const url = (q: string) => parseParams(new URL(`${ORIGIN}/mcp?${q}network=testnet`));
  const { requesterFor } = await import("../src/remote/payments.js");

  it("with solana= only, a Base-only seller is payable on Base and signed in Rabby / MetaMask", async () => {
    const { deps } = setup();
    const params = url(`solana=${sol}&`);
    const check: any = await (await requesterFor(params, deps)).checkRequirements({ url: URL_ });
    expect(check.accepts[0]).toMatchObject({ payable: true });
    expect(check.wouldPay.network).toBe(BASE_SEPOLIA);
    const r = await requestPayment(params, { url: URL_ }, ORIGIN, deps);
    expect(r).toMatchObject({ status: "awaiting_approval", payment: { network: BASE_SEPOLIA, sign_with: "Rabby / MetaMask" } });
    expect(r.phantom_app_url).toBeUndefined();
  });

  it("at the same price, picks the chain whose address is in the URL; with none, Solana", async () => {
    const accepts = [exactReq("5000", BASE_SEPOLIA), solReq("5000")]; // Base listed first, like Agent402
    const pick = async (q: string) => (await requestPayment(url(q), { url: URL_ }, ORIGIN, setup({ accepts }).deps)).payment;
    expect(await pick(`solana=${sol}&`)).toMatchObject({ network: SOLANA_DEVNET, sign_with: "Phantom" });
    expect(await pick(`base=${owner.address}&`)).toMatchObject({ network: BASE_SEPOLIA, sign_with: "Rabby / MetaMask" });
    expect(await pick("")).toMatchObject({ network: SOLANA_DEVNET, sign_with: "Phantom" });
    // A cheaper chain still wins over the preferred one.
    const cheaperBase = [exactReq("4000", BASE_SEPOLIA), solReq("5000")];
    const r = await requestPayment(url(`solana=${sol}&`), { url: URL_ }, ORIGIN, setup({ accepts: cheaperBase }).deps);
    expect(r.payment.network).toBe(BASE_SEPOLIA);
  });

  it("with /mcp only, a Base-only seller gets a link and the EVM wallet connected on the page pays, within its limits", async () => {
    const { deps, sellerCalls } = setup({ amount: "6000" });
    const params = parseParams(new URL(`${ORIGIN}/mcp?network=testnet&daily=0.01`));
    const r = await requestPayment(params, { url: URL_ }, ORIGIN, deps);
    expect(r).toMatchObject({ status: "awaiting_approval", payment: { network: BASE_SEPOLIA, sign_with: "Rabby / MetaMask" } });
    const built = await buildPayment(r.request_id, tokenOf(r.approve_url), deps, owner.address);
    expect(built.family).toBe("evm");
    expect(await signAndPay(r.request_id, tokenOf(r.approve_url), await signTyped(owner, built.typedData as string), deps)).toMatchObject({
      status: "fulfilled",
      paid: true,
    });
    expect(new Headers(sellerCalls.at(-1)!.headers).get("payment-signature")).toBeTruthy();

    // The 24-hour limit counts what that Base wallet already paid: 0.006 + 0.006 > 0.01.
    const r2 = await requestPayment(params, { url: URL_ }, ORIGIN, deps);
    expect(r2.status).toBe("awaiting_approval"); // no wallet known yet
    await expect(buildPayment(r2.request_id, tokenOf(r2.approve_url), deps, owner.address)).rejects.toThrow(/払う前の確認で止まりました/);
    expect((await getResult(r2.request_id, deps)).status).toBe("blocked");
    // Another wallet has its own 24 hours.
    const r3 = await requestPayment(params, { url: URL_ }, ORIGIN, deps);
    expect((await buildPayment(r3.request_id, tokenOf(r3.approve_url), deps, stranger.address)).family).toBe("evm");
  });
});

describe("remote: approval flow (Base)", () => {
  it("pays only after approval and signature, once", async () => {
    const { deps, params, sellerCalls } = setup();
    const r = await requestPayment(params, { url: URL_ }, ORIGIN, deps);
    expect(r.status).toBe("awaiting_approval");
    expect(r.approve_url).toMatch(new RegExp(`^${ORIGIN}/approve/[0-9a-f]{32}\\?t=[0-9a-f]{32}$`));
    expect(r.phantom_app_url).toBeUndefined(); // Base: signed in Rabby / MetaMask, not Phantom
    expect(r.payment.sign_with).toBe("Rabby / MetaMask");
    expect((await getResult(r.request_id, deps)).status).toBe("awaiting_approval");
    expect(sellerCalls).toHaveLength(1); // the unpaid 402 only

    const t = tokenOf(r.approve_url);
    const built = await buildPayment(r.request_id, t, deps);
    expect(built.family).toBe("evm");
    expect((await getResult(r.request_id, deps)).status).toBe("processing");

    const out = await signAndPay(r.request_id, t, await signTyped(owner, built.typedData as string), deps);
    expect(out).toMatchObject({ status: "fulfilled", paid: true });
    // When each step happened: built ≤ signed ≤ sent ≤ result.
    const tm = Object.values(out.timing as Record<string, string>).map((v) => Date.parse(v));
    expect(tm).toHaveLength(4);
    expect(tm.every((v, i) => !Number.isNaN(v) && (i === 0 || tm[i - 1] <= v))).toBe(true);
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

  it("avoids a network only when the seller says it does not accept it", async () => {
    const refuseWith = async (error: string) => {
      const { deps, params } = setup({ seller: () => res402([exactReq("5000", BASE_SEPOLIA)], { error }) });
      const r = await requestPayment(params, { url: URL_ }, ORIGIN, deps);
      const t = tokenOf(r.approve_url);
      const built = await buildPayment(r.request_id, t, deps);
      expect(await signAndPay(r.request_id, t, await signTyped(owner, built.typedData as string), deps)).toMatchObject({
        status: "rejected_by_seller",
        paid: false,
        refusal_reason: error,
      });
      return (await requestPayment(params, { url: URL_ }, ORIGIN, deps)).status;
    };
    expect(await refuseWith("invalid_exact_evm_network_mismatch")).toBe("blocked");
    expect(await refuseWith("invalid_exact_evm_payload_signature: contract call failed: execution reverted")).toBe("awaiting_approval");
  });

  it("fixes a v of 0/1 to 27/28, and records the typed data, v and the authorization sent", async () => {
    const { deps, params, sellerCalls } = setup();
    const r = await requestPayment(params, { url: URL_ }, ORIGIN, deps);
    const t = tokenOf(r.approve_url);
    const built = await buildPayment(r.request_id, t, deps);
    const good = await signTyped(owner, built.typedData as string);
    const v = parseInt(good.slice(-2), 16);
    const low = good.slice(0, -2) + (v - 27).toString(16).padStart(2, "0"); // the same signature with v = 0/1
    expect(normalizeEvmSignature(low)).toBe(good);
    expect(normalizeEvmSignature(good)).toBe(good);

    const out: any = await signAndPay(r.request_id, t, low, deps);
    expect(out).toMatchObject({ status: "fulfilled", paid: true });
    const sent = JSON.parse(Buffer.from(new Headers(sellerCalls.at(-1)!.headers).get("payment-signature")!, "base64").toString());
    expect(sent.payload.signature).toBe(good);
    expect(out.evm_payment.signature_v).toBe(v);
    // Every field the wallet signed is the field sent to the seller.
    const msg = out.evm_payment.typed_data.message;
    const auth = out.evm_payment.authorization;
    for (const k of ["from", "to", "value", "validAfter", "validBefore", "nonce"]) expect(String(auth[k]).toLowerCase()).toBe(String(msg[k]).toLowerCase());
    expect(out.evm_payment.typed_data.domain).toMatchObject({ chainId: 84532 });
    expect(auth).toEqual(sent.payload.authorization);
  });

  it("uses mainnet Base when the URL says mainnet", () => {
    const p = parseParams(new URL(`${ORIGIN}/api/mcp?base=${owner.address}&network=mainnet`));
    expect(p.network).toBe("mainnet");
    expect(BASE).toBe("eip155:8453");
  });
});

describe("remote: checking a signed Solana payment by its outcome", async () => {
  const web3 = await import("@solana/web3.js");
  const P = (k: string) => new web3.PublicKey(k);
  const TOKEN = P("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  const ATA = P("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
  const CB = P("ComputeBudget111111111111111111111111111111");
  const MEMO = P("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
  const LH = P(LIGHTHOUSE_PROGRAM);
  const USDC = P("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  const payer = web3.Keypair.generate().publicKey;
  const feePayer = web3.Keypair.generate().publicKey;
  const payTo = web3.Keypair.generate().publicKey;
  const ata = (owner: any) => web3.PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN.toBuffer(), USDC.toBuffer()], ATA)[0];
  const want = { payer: payer.toBase58(), feePayer: feePayer.toBase58(), payTo: payTo.toBase58(), asset: USDC.toBase58(), amount: "1000" };

  const budget = (d: number[]) => new web3.TransactionInstruction({ programId: CB, keys: [], data: Buffer.from(d) });
  const transferTo = (dest: any, amount = 1000n, mint = USDC) => {
    const data = Buffer.alloc(10);
    data[0] = 12;
    data.writeBigUInt64LE(amount, 1);
    data[9] = 6;
    return new web3.TransactionInstruction({
      programId: TOKEN,
      keys: [
        { pubkey: ata(payer), isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: dest, isSigner: false, isWritable: true },
        { pubkey: payer, isSigner: true, isWritable: false },
      ],
      data,
    });
  };
  const pay = transferTo(ata(payTo));
  const memo = new web3.TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from("nonce-123") });
  const lighthouse = new web3.TransactionInstruction({ programId: LH, keys: [{ pubkey: ata(payer), isSigner: false, isWritable: false }], data: Buffer.from([2, 2]) });
  const msg = (ixs: any[], fp = feePayer) =>
    new web3.TransactionMessage({ payerKey: fp, recentBlockhash: web3.Keypair.generate().publicKey.toBase58(), instructions: ixs }).compileToV0Message().serialize();
  const x402 = [budget([2, 0x40, 0x0d, 0x03, 0]), budget([3, 1, 0, 0, 0, 0, 0, 0, 0]), pay, memo];

  it("accepts the payment as built, and with Phantom's Lighthouse and new compute-budget values", async () => {
    expect(await solanaPaymentProblem(msg(x402), want)).toBeNull();
    expect(await solanaPaymentProblem(msg([budget([2, 9, 9, 9, 0]), budget([3, 7, 0, 0, 0, 0, 0, 0, 0]), pay, memo, lighthouse, lighthouse, lighthouse]), want)).toBeNull();
    expect(await solanaPaymentProblem(msg([lighthouse, ...x402]), want)).toBeNull();
    // Phantom's real shape: assertions before and after the payment, one reading the facilitator.
    const assert6 = new web3.TransactionInstruction({ programId: LH, keys: [{ pubkey: ata(payer), isSigner: false, isWritable: false }], data: Buffer.from([6]) });
    const assert6Fp = new web3.TransactionInstruction({ programId: LH, keys: [{ pubkey: feePayer, isSigner: false, isWritable: false }], data: Buffer.from([6]) });
    const assert10 = new web3.TransactionInstruction({ programId: LH, keys: [{ pubkey: ata(payTo), isSigner: false, isWritable: false }], data: Buffer.from([10]) });
    expect(await solanaPaymentProblem(msg([x402[0], x402[1], assert6, assert6Fp, pay, memo, assert10]), want)).toBeNull();
    // Lighthouse variants that can change state are refused.
    const memoryWrite = new web3.TransactionInstruction({ programId: LH, keys: [{ pubkey: ata(payer), isSigner: false, isWritable: true }], data: Buffer.from([0]) });
    expect(await solanaPaymentProblem(msg([...x402, memoryWrite]), want)).toMatch(/not an assertion/);
  });

  it("reports what the wallet changed: version, blockhash and instruction count, separately", async () => {
    const at = (ixs: any[], blockhash: string) =>
      new web3.TransactionMessage({ payerKey: feePayer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message().serialize();
    const bh = web3.Keypair.generate().publicKey.toBase58();
    const built = at(x402, bh);
    expect(solanaWalletChanges(built, built)).toBe("version 0 → 0 · blockhash kept · instructions 4 → 4");
    expect(solanaWalletChanges(built, at([lighthouse, ...x402, lighthouse], bh))).toBe("version 0 → 0 · blockhash kept · instructions 4 → 6");
    expect(solanaWalletChanges(built, at(x402, web3.Keypair.generate().publicKey.toBase58()))).toBe("version 0 → 0 · blockhash replaced · instructions 4 → 4");
    const other = web3.Keypair.generate().publicKey.toBase58();
    expect(solanaBlockhashes(built, at(x402, other))).toEqual({ built: bh, signed: other });

    // A version 1 transaction (a different layout) is reported and refused with a readable reason, not a crash.
    const k = await import("@solana/kit");
    const v1 = k.pipe(
      k.createTransactionMessage({ version: 1 }),
      (x: any) => k.setTransactionMessageFeePayer(k.address(feePayer.toBase58()), x),
      (x: any) => k.setTransactionMessageLifetimeUsingBlockhash({ blockhash: k.blockhash(bh), lastValidBlockHeight: 1n }, x),
      (x: any) => k.appendTransactionMessageInstructions([{ programAddress: k.address(MEMO.toBase58()), data: new Uint8Array([1]) }], x),
    );
    const v1bytes = new Uint8Array(k.getCompiledTransactionMessageEncoder().encode(k.compileTransactionMessage(v1 as any)));
    expect(solanaWalletChanges(built, v1bytes)).toBe("version 0 → 1 · blockhash kept · instructions 4 → 1");
    expect(await solanaPaymentProblem(v1bytes, want)).toMatch(/version 1/);
  });

  it("checks the seller's memo when it is set", async () => {
    expect(await solanaPaymentProblem(msg(x402), { ...want, memo: "nonce-123" })).toBeNull();
    expect(await solanaPaymentProblem(msg(x402), { ...want, memo: "invoice-9" })).toMatch(/memo/);
  });

  it("refuses anything that is not exactly the payment shown", async () => {
    expect(await solanaPaymentProblem(msg([...x402.slice(0, 2), transferTo(ata(payTo), 2000n), memo]), want)).toMatch(/not the payment/);
    expect(await solanaPaymentProblem(msg([...x402.slice(0, 2), transferTo(ata(web3.Keypair.generate().publicKey)), memo]), want)).toMatch(/not the payment/);
    expect(await solanaPaymentProblem(msg([...x402, pay]), want)).toMatch(/more than once/);
    expect(await solanaPaymentProblem(msg([...x402.slice(0, 2), memo]), want)).toBeTruthy();
    expect(await solanaPaymentProblem(msg([...x402, budget([1, 0, 0, 0, 0])]), want)).toMatch(/compute-budget/);
    const system = web3.SystemProgram.transfer({ fromPubkey: payer, toPubkey: payTo, lamports: 1 });
    expect(await solanaPaymentProblem(msg([...x402, system]), want)).toMatch(/not allowed/);
    const memoWithFacilitator = new web3.TransactionInstruction({ programId: MEMO, keys: [{ pubkey: feePayer, isSigner: false, isWritable: false }], data: Buffer.from("x") });
    expect(await solanaPaymentProblem(msg([...x402, memoWithFacilitator]), want)).toMatch(/facilitator appears/);
    expect(await solanaPaymentProblem(msg(x402, web3.Keypair.generate().publicKey), want)).toMatch(/fee payer/);
  });
});
