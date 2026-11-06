/**
 * Buyer-side operations on the private_pricing MXE program
 * (kato9292929/x402-private-pricing): seal the cap, queue the match or the
 * RFQ, read back only what the cluster revealed.
 *
 * The cap is encrypted here, with a one-off x25519 key shared with the MXE,
 * and leaves this process only as ciphertext. Nothing in this file logs it or
 * puts it in an error.
 *
 * Fees for the computations are paid by ARCIUM_FEE_PAYER_KEYPAIR, a devnet key
 * that holds devnet SOL only; the USDC payment itself is signed by the wallet
 * provider, as for make_x402_request.
 */
import { randomBytes } from "node:crypto";
import * as anchor from "@anchor-lang/core";
// Under ESM, BN and web3 exist only on the CommonJS default export.
import anchorPkg from "@anchor-lang/core";
const { BN, web3 } = anchorPkg;
import { RescueCipher, deserializeLE, x25519 } from "@arcium-hq/client";
import { MxeChain, keypairWallet, sleep, type ComputationRun } from "./chain.js";
import idlJson from "./private_pricing.json" with { type: "json" };

const { Connection, PublicKey } = web3;
type PublicKey = anchor.web3.PublicKey;

/** Measurements of one MXE step, safe to show (no inputs). */
export interface MxeRun {
  circuit: string;
  queueTx: string;
  finalizeTx: string;
  latencyMs: number;
  lamports: number;
  baseFeeLamports?: number;
}

export interface MatchResult {
  matched: boolean;
  priceMicros: bigint;
  matchRequest: string;
  run: MxeRun;
}

export interface AwardResult {
  awarded: boolean;
  winner?: string;
  priceMicros: bigint;
  quoteCount: number;
  run: MxeRun;
}

/** What the private tools need from the chain. Injected in tests. */
export interface MxeOps {
  readonly programId: string;
  matchCeiling(negotiation: string, requestId: bigint, capMicros: bigint): Promise<MatchResult>;
  closeMatchRequest(matchRequest: string): Promise<void>;
  createRfq(capMicros: bigint, durationSec: number): Promise<{ rfq: string; endTime: number; run: MxeRun }>;
  closeAndAward(rfq: string): Promise<AwardResult>;
}

const view = (r: ComputationRun): MxeRun => ({
  circuit: r.circuit,
  queueTx: r.queueTx,
  finalizeTx: r.finalizeTx,
  latencyMs: r.latencyMs,
  lamports: r.lamports,
  baseFeeLamports: r.baseFeeLamports,
});

const le64 = (n: bigint) => new BN(n.toString()).toArrayLike(Buffer, "le", 8);
const newId = () => BigInt("0x" + randomBytes(6).toString("hex"));

export class ChainMxeOps implements MxeOps {
  constructor(private readonly chain: MxeChain) {}

  get programId(): string {
    return this.chain.cfg.programId.toBase58();
  }

  /** Encrypts `values` to the MXE with a one-off key. */
  private async seal(values: bigint[]): Promise<{ cts: number[][]; pub: number[]; nonce: anchor.BN }> {
    const sk = x25519.utils.randomSecretKey();
    const cipher = new RescueCipher(x25519.getSharedSecret(sk, await this.chain.mxePublicKey()));
    const nonce = randomBytes(16);
    return {
      cts: cipher.encrypt(values, nonce).map((c) => Array.from(c)),
      pub: Array.from(x25519.getPublicKey(sk)),
      nonce: new BN(deserializeLE(nonce).toString()),
    };
  }

  async matchCeiling(negotiation: string, requestId: bigint, capMicros: bigint): Promise<MatchResult> {
    const neg = new PublicKey(negotiation);
    const matchRequest = this.chain.pda([Buffer.from("match"), neg.toBuffer(), le64(requestId)]);
    const s = await this.seal([capMicros]);
    const run = await this.chain.queue(
      "matchCeiling",
      "match_ceiling",
      "buyer",
      [new BN(requestId.toString()), s.cts[0], s.pub, s.nonce],
      { negotiation: neg, matchRequest },
    );
    const acc = await this.chain.fetch<{ status: { settled?: object }; matched: boolean; price: anchor.BN }>("matchRequest", matchRequest);
    if (!acc?.status.settled) throw new Error("the match was not settled after the computation finalized");
    return { matched: acc.matched, priceMicros: BigInt(acc.price.toString()), matchRequest: matchRequest.toBase58(), run: view(run) };
  }

  async closeMatchRequest(matchRequest: string): Promise<void> {
    await this.chain.send("closeMatchRequest", "buyer", [], { matchRequest: new PublicKey(matchRequest) });
  }

  async createRfq(capMicros: bigint, durationSec: number) {
    const rfqId = newId();
    const rfq = this.chain.pda([Buffer.from("rfq"), this.chain.signer.toBuffer(), le64(rfqId)]);
    const s = await this.seal([capMicros]);
    const run = await this.chain.queue(
      "createRfq",
      "open_rfq_state",
      "authority",
      [new BN(rfqId.toString()), new BN(durationSec), s.cts[0], s.pub, s.nonce],
      { rfq },
    );
    const acc = await this.chain.fetch<{ status: { open?: object }; endTime: anchor.BN }>("rfq", rfq);
    if (!acc?.status.open) throw new Error("the RFQ is not open after the computation finalized");
    return { rfq: rfq.toBase58(), endTime: Number(acc.endTime.toString()), run: view(run) };
  }

  async closeAndAward(rfqAddress: string): Promise<AwardResult> {
    const rfq = new PublicKey(rfqAddress);
    type Rfq = {
      status: { awarded?: object };
      endTime: anchor.BN;
      busy: boolean;
      quoteCount: number;
      awarded: boolean;
      awardWinner: number[];
      awardPrice: anchor.BN;
    };
    const acc = await this.chain.fetch<Rfq>("rfq", rfq);
    if (!acc) throw new Error("no such RFQ");
    while ((await this.chain.clusterTime()) < Number(acc.endTime.toString())) await sleep(2000);
    for (let i = 0; (await this.chain.fetch<Rfq>("rfq", rfq))?.busy && i < 60; i++) await sleep(2000);
    await this.chain.send("closeRfq", "authority", [], { rfq });
    const run = await this.chain.queue("awardRfq", "award_rfq", "authority", [], { rfq });
    const done = await this.chain.fetch<Rfq>("rfq", rfq);
    if (!done?.status.awarded) throw new Error("the RFQ was not awarded after the computation finalized");
    return {
      awarded: done.awarded,
      winner: done.awarded ? new PublicKey(Uint8Array.from(done.awardWinner)).toBase58() : undefined,
      priceMicros: BigInt(done.awardPrice.toString()),
      quoteCount: done.quoteCount,
      run: view(run),
    };
  }
}

/** The program's IDL, shipped with the package (copied from x402-private-pricing's CI build). */
export function loadPrivatePricingIdl(): anchor.Idl {
  return idlJson as unknown as anchor.Idl;
}

export const ARCIUM_ENV = ["ARCIUM_MXE_PROGRAM_ID", "ARCIUM_FEE_PAYER_KEYPAIR"];

/** Whether the private tools are offered at all (ARCIUM_MXE_PROGRAM_ID set). */
export function privatePricingConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.ARCIUM_MXE_PROGRAM_ID?.trim();
}

export function mxeOpsFromEnv(env: NodeJS.ProcessEnv = process.env): MxeOps {
  const programId = env.ARCIUM_MXE_PROGRAM_ID?.trim();
  const key = env.ARCIUM_FEE_PAYER_KEYPAIR?.trim();
  if (!programId) throw new Error("ARCIUM_MXE_PROGRAM_ID is not set");
  if (!key) throw new Error("ARCIUM_FEE_PAYER_KEYPAIR is not set (a devnet keypair JSON that holds devnet SOL only)");
  const pid = new PublicKey(programId);
  return new ChainMxeOps(
    new MxeChain({
      connection: new Connection(env.SOLANA_DEVNET_RPC_URL?.trim() || "https://api.devnet.solana.com", "confirmed"),
      wallet: keypairWallet(key, "ARCIUM_FEE_PAYER_KEYPAIR"),
      programId: pid,
      clusterOffset: Number(env.ARCIUM_CLUSTER_OFFSET ?? 456),
      idl: loadPrivatePricingIdl(),
    }),
  );
}
