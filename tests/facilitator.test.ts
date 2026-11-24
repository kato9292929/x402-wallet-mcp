import { describe, expect, it, vi } from "vitest";
import { ExactSvmScheme } from "@x402/svm/exact/facilitator";
import { CHAINS, SOLANA } from "../src/chains.js";
import { LIGHTHOUSE_PROGRAM, phantomAwareScheme, policyProblem, settle } from "../src/facilitator/index.js";
import { memoryStore } from "../src/remote/store.js";

const web3 = await import("@solana/web3.js");
const P = (k: string) => new web3.PublicKey(k);
const TOKEN = P("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA = P("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const CB = P("ComputeBudget111111111111111111111111111111");
const MEMO = P("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const LH = P(LIGHTHOUSE_PROGRAM);
const USDC = P(CHAINS[SOLANA].usdc);

const payerKp = web3.Keypair.generate();
const payer = payerKp.publicKey;
const feePayer = web3.Keypair.generate().publicKey;
const payTo = web3.Keypair.generate().publicKey;
const ata = (owner: InstanceType<typeof web3.PublicKey>) =>
  web3.PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN.toBuffer(), USDC.toBuffer()], ATA)[0];

const budget = (d: number[]) => new web3.TransactionInstruction({ programId: CB, keys: [], data: Buffer.from(d) });
const limit = budget([2, 0x40, 0x0d, 0x03, 0]); // 200,000 CU
const price = budget([3, 1, 0, 0, 0, 0, 0, 0, 0]); // 1 microlamport
const pay = (() => {
  const data = Buffer.alloc(10);
  data[0] = 12;
  data.writeBigUInt64LE(1000n, 1);
  data[9] = 6;
  return new web3.TransactionInstruction({
    programId: TOKEN,
    keys: [
      { pubkey: ata(payer), isSigner: false, isWritable: true },
      { pubkey: USDC, isSigner: false, isWritable: false },
      { pubkey: ata(payTo), isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: false },
    ],
    data,
  });
})();
const memo = new web3.TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from("0123456789abcdef0123456789abcdef") });
const guard = (kind: number, account: InstanceType<typeof web3.PublicKey>) =>
  new web3.TransactionInstruction({ programId: LH, keys: [{ pubkey: account, isSigner: false, isWritable: false }], data: Buffer.from([kind, 0]) });

function payload(instructions: InstanceType<typeof web3.TransactionInstruction>[]) {
  const msg = new web3.TransactionMessage({
    payerKey: feePayer,
    recentBlockhash: web3.Keypair.generate().publicKey.toBase58(),
    instructions,
  }).compileToV0Message();
  const tx = new web3.VersionedTransaction(msg);
  tx.sign([payerKp]); // the facilitator signs last
  return {
    x402Version: 2,
    resource: { url: "https://jin.test/api", description: "", mimeType: "application/json" },
    accepted: requirements,
    payload: { transaction: Buffer.from(tx.serialize()).toString("base64") },
  } as any;
}

const requirements = {
  scheme: "exact",
  network: SOLANA,
  asset: USDC.toBase58(),
  amount: "1000",
  payTo: payTo.toBase58(),
  maxTimeoutSeconds: 60,
  extra: { feePayer: feePayer.toBase58() },
} as any;

function fakeSigner() {
  return {
    getAddresses: () => [feePayer.toBase58()],
    simulateTransaction: vi.fn(async () => {}),
    signTransaction: vi.fn(),
    sendTransaction: vi.fn(),
    confirmTransaction: vi.fn(),
  } as any;
}

// What Phantom actually signed (seen on a real approval): assertions before and after the payment,
// one of them reading the fee payer.
const phantomShape = () => [limit, price, guard(6, ata(payer)), guard(6, feePayer), pay, memo, guard(10, ata(payTo))];

describe("facilitator: Phantom's Lighthouse assertions", () => {
  it("the official verifier refuses Phantom's payment (assertion reads the fee payer)", async () => {
    const official = new ExactSvmScheme(fakeSigner());
    expect(await official.verify(payload(phantomShape()), requirements)).toMatchObject({ isValid: false, invalidReason: expect.stringMatching(/fee_payer/) });
  });

  it("ours accepts it, and still simulates the whole signed transaction", async () => {
    const signer = fakeSigner();
    const r = await phantomAwareScheme(signer).verify(payload(phantomShape()), requirements);
    expect(r).toMatchObject({ isValid: true, payer: payer.toBase58() });
    expect(signer.simulateTransaction).toHaveBeenCalledTimes(1);
  });

  it("keeps every other official check", async () => {
    const scheme = phantomAwareScheme(fakeSigner());
    // A Lighthouse instruction that can write (MemoryWrite = 0) is refused even on the fee payer.
    expect(await scheme.verify(payload([limit, price, guard(0, feePayer), pay, memo]), requirements)).toMatchObject({ isValid: false });
    // Wrong amount.
    const bad = new web3.TransactionInstruction({ ...pay, data: Buffer.from(pay.data).fill(0, 1, 9) } as any);
    expect(await scheme.verify(payload([limit, price, bad, memo]), requirements)).toMatchObject({ isValid: false });
    // Payment to someone else.
    expect(await scheme.verify(payload([limit, price, pay, memo]), { ...requirements, payTo: web3.Keypair.generate().publicKey.toBase58() })).toMatchObject({
      isValid: false,
    });
    // Wrong fee payer.
    expect(await scheme.verify(payload([limit, price, pay, memo]), { ...requirements, extra: { feePayer: payTo.toBase58() } })).toMatchObject({
      isValid: false,
    });
  });
});

describe("facilitator: policy", () => {
  const setup = { payTo: new Set([payTo.toBase58()]) } as any;
  it("serves only our sellers, mainnet USDC exact", () => {
    expect(policyProblem(setup, requirements)).toBeNull();
    expect(policyProblem(setup, { ...requirements, payTo: feePayer.toBase58() })).toBe("pay_to_not_allowed");
    expect(policyProblem(setup, { ...requirements, network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" })).toBe("unsupported_network");
    expect(policyProblem(setup, { ...requirements, asset: feePayer.toBase58() })).toBe("unsupported_asset");
  });
});

describe("facilitator: daily limit", () => {
  it("counts only successful settlements", async () => {
    const store = memoryStore();
    let ok = false;
    const setup = { payTo: new Set([payTo.toBase58()]), dailyMax: 1, facilitator: { settle: async () => ({ success: ok }) } } as any;
    expect(await settle(setup, {} as any, requirements, store)).toMatchObject({ success: false });
    ok = true;
    expect(await settle(setup, {} as any, requirements, store)).toMatchObject({ success: true });
    expect(await settle(setup, {} as any, requirements, store)).toMatchObject({ success: false, errorReason: "daily_limit_reached" });
  });
});
