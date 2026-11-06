/**
 * The private_pricing program on an Arcium cluster: queue a computation, wait
 * for the cluster to finalize it, and measure what that took.
 *
 * Same as kato9292929/x402-private-pricing src/mxe/chain.ts (which adapted the
 * x402 Autonomous Agent's). Instructions are built from the program's IDL
 * (src/arcium/private_pricing.json, produced by that repository's CI build).
 *
 * Measured once, here, so every record carries the same kind of number:
 * latency is queue → finalization; cost is the signer's balance delta over the
 * same span (tx fees, the computation fee, and rent for accounts the step
 * created); the execution fee is read from the computation account.
 *
 * Nothing is retried or substituted on failure. An error after the queue tx
 * confirmed carries the computation offset.
 */
import { randomBytes } from "node:crypto";
import * as anchor from "@anchor-lang/core";
// Under ESM, BN and web3 exist only on the CommonJS default export.
import anchorPkg from "@anchor-lang/core";
const { BN, web3 } = anchorPkg;
import {
  awaitComputationFinalization,
  getArciumProgram,
  getArciumProgramId,
  getArciumSignerAccAddress,
  getClockAccAddress,
  getClusterAccAddress,
  getCompDefAccAddress,
  getCompDefAccOffset,
  getComputationAccAddress,
  getExecutingPoolAccAddress,
  getFeePoolAccAddress,
  getMempoolAccAddress,
  getMXEAccAddress,
  getMXEPublicKey,
} from "@arcium-hq/client";

// web3.js v1 as Anchor and the Arcium client use it (this package's own @solana/web3.js is v3).
const { Keypair, PublicKey, SystemProgram, Transaction, VersionedTransaction } = web3;
type Connection = anchor.web3.Connection;
type PublicKey = anchor.web3.PublicKey;
type Transaction = anchor.web3.Transaction;
type VersionedTransaction = anchor.web3.VersionedTransaction;

/** Anchor's wallet contract, as far as `.rpc()` needs it. */
export interface MxeWallet {
  publicKey: PublicKey;
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>;
  signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]>;
}

/** A Solana CLI keypair (JSON array of 64 numbers) as the signer. Devnet keys only. */
export function keypairWallet(json: string, name = "keypair"): MxeWallet {
  let bytes: unknown;
  try {
    bytes = JSON.parse(json);
  } catch {
    throw new Error(`${name} is not JSON (it must be the keypair file's contents, not its path)`);
  }
  if (!Array.isArray(bytes) || bytes.length !== 64) throw new Error(`${name} must be a JSON array of 64 numbers`);
  const kp = Keypair.fromSecretKey(Uint8Array.from(bytes as number[]));
  const sign = async <T extends Transaction | VersionedTransaction>(tx: T): Promise<T> => {
    if (tx instanceof VersionedTransaction) tx.sign([kp]);
    else tx.partialSign(kp);
    return tx;
  };
  return { publicKey: kp.publicKey, signTransaction: sign, signAllTransactions: async (txs) => Promise.all(txs.map(sign)) };
}

export interface MxeChainConfig {
  connection: Connection;
  wallet: MxeWallet;
  programId: PublicKey;
  clusterOffset: number;
  idl: anchor.Idl;
  /** Queue → finalization timeout. Devnet MPC takes seconds to minutes. */
  finalizeTimeoutMs?: number;
}

/** One finalized computation, as measured. */
export interface ComputationRun {
  circuit: string;
  offset: string;
  account: string;
  queueTx: string;
  /** Signature that finalized the computation (the callback). */
  finalizeTx: string;
  latencyMs: number;
  /** Signer balance delta, queue → finalize. */
  lamports: number;
  baseFeeLamports?: number;
  priorityFeeLamports?: number;
}

export class ComputationFailed extends Error {
  constructor(
    message: string,
    readonly circuit: string,
    readonly offset: string,
    readonly queueTx?: string,
  ) {
    super(message);
    this.name = "ComputationFailed";
  }
}

export class MxeChain {
  readonly program: anchor.Program;
  readonly provider: anchor.AnchorProvider;
  private mxeKey?: Uint8Array;

  constructor(readonly cfg: MxeChainConfig) {
    this.provider = new anchor.AnchorProvider(cfg.connection, cfg.wallet as anchor.Wallet, {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    });
    this.program = new anchor.Program({ ...cfg.idl, address: cfg.programId.toBase58() }, this.provider);
  }

  get signer(): PublicKey {
    return this.cfg.wallet.publicKey;
  }

  /** The MXE's x25519 key, which clients encrypt to. Fetched once. */
  async mxePublicKey(): Promise<Uint8Array> {
    if (this.mxeKey) return this.mxeKey;
    for (let i = 0; i < 10; i++) {
      const k = await getMXEPublicKey(this.provider, this.cfg.programId);
      if (k) return (this.mxeKey = k);
      await sleep(1000);
    }
    throw new Error("MXE x25519 public key not available (is the MXE initialized on this cluster?)");
  }

  pda(seeds: (Buffer | Uint8Array)[]): PublicKey {
    return PublicKey.findProgramAddressSync(seeds, this.cfg.programId)[0];
  }

  private queueAccounts(circuit: string, offset: anchor.BN): Record<string, PublicKey> {
    const c = this.cfg.clusterOffset;
    return {
      signPdaAccount: getArciumSignerAccAddress(this.cfg.programId),
      mxeAccount: getMXEAccAddress(this.cfg.programId),
      mempoolAccount: getMempoolAccAddress(c),
      executingPool: getExecutingPoolAccAddress(c),
      computationAccount: getComputationAccAddress(c, offset),
      compDefAccount: getCompDefAccAddress(this.cfg.programId, Buffer.from(getCompDefAccOffset(circuit)).readUInt32LE()),
      clusterAccount: getClusterAccAddress(c),
      poolAccount: getFeePoolAccAddress(),
      clockAccount: getClockAccAddress(),
      systemProgram: SystemProgram.programId,
      arciumProgram: getArciumProgramId(),
    };
  }

  /**
   * Queue `method` (first argument: the computation offset) signed as `role`
   * ("authority", "buyer" or "seller", as the instruction names its signer),
   * wait for finalization, and return the measurements.
   */
  async queue(
    method: string,
    circuit: string,
    role: "authority" | "buyer" | "seller",
    args: unknown[],
    accounts: Record<string, PublicKey>,
  ): Promise<ComputationRun> {
    const offset = new BN(randomBytes(8), "hex");
    const before = await this.cfg.connection.getBalance(this.signer, "confirmed");
    const t0 = Date.now();

    const queueTx: string = await (this.program.methods as any)
      [method](offset, ...args)
      .accountsStrict({ [role]: this.signer, ...accounts, ...this.queueAccounts(circuit, offset) })
      .rpc({ skipPreflight: true, commitment: "confirmed" });

    const fail = (msg: string) => new ComputationFailed(msg, circuit, offset.toString(), queueTx);
    const queued = await this.cfg.connection.getTransaction(queueTx, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (queued?.meta?.err) throw fail(`queue tx failed: ${JSON.stringify(queued.meta.err)}`);

    const fees = await this.readFees(getComputationAccAddress(this.cfg.clusterOffset, offset));

    let finalizeTx: string;
    try {
      finalizeTx = await awaitComputationFinalization(
        this.provider,
        offset,
        this.cfg.programId,
        "confirmed",
        this.cfg.finalizeTimeoutMs ?? 300_000,
      );
    } catch (err) {
      throw fail(`not finalized: ${String(err)}`);
    }
    const latencyMs = Date.now() - t0;
    const after = await this.cfg.connection.getBalance(this.signer, "confirmed");
    return {
      circuit,
      offset: offset.toString(),
      account: getComputationAccAddress(this.cfg.clusterOffset, offset).toBase58(),
      queueTx,
      finalizeTx,
      latencyMs,
      lamports: before - after,
      ...fees,
    };
  }

  /** A plain instruction (no computation). */
  async send(
    method: string,
    role: "authority" | "buyer" | "seller",
    args: unknown[],
    accounts: Record<string, PublicKey>,
  ): Promise<{ tx: string; lamports: number }> {
    const before = await this.cfg.connection.getBalance(this.signer, "confirmed");
    const tx: string = await (this.program.methods as any)
      [method](...args)
      .accountsPartial({ [role]: this.signer, ...accounts })
      .rpc({ commitment: "confirmed" });
    const after = await this.cfg.connection.getBalance(this.signer, "confirmed");
    return { tx, lamports: before - after };
  }

  async fetch<T>(accountName: string, address: PublicKey): Promise<T | null> {
    return ((this.program.account as any)[accountName].fetchNullable(address, "confirmed")) as Promise<T | null>;
  }

  private async readFees(account: PublicKey): Promise<Pick<ComputationRun, "baseFeeLamports" | "priorityFeeLamports">> {
    try {
      const acc = (await getArciumProgram(this.provider).account.computationAccount.fetch(account, "confirmed")) as {
        executionFee: { baseFee: { toString(): string }; priorityFee: { toString(): string } };
      };
      return {
        baseFeeLamports: Number(acc.executionFee.baseFee.toString()),
        priorityFeeLamports: Number(acc.executionFee.priorityFee.toString()),
      };
    } catch {
      return {};
    }
  }

  /** Current cluster time, for RFQ deadlines (`Clock::unix_timestamp`). */
  async clusterTime(): Promise<number> {
    const slot = await this.cfg.connection.getSlot("confirmed");
    const t = await this.cfg.connection.getBlockTime(slot);
    if (t === null) throw new Error(`no block time for slot ${slot}`);
    return t;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
