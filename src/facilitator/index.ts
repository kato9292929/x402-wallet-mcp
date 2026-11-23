import { createKeyPairSignerFromBytes, getBase58Encoder } from "@solana/kit";
import { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { toFacilitatorSvmSigner, type FacilitatorSvmSigner } from "@x402/svm";
import { ExactSvmScheme } from "@x402/svm/exact/facilitator";
import { CHAINS, SOLANA } from "../chains.js";
import type { Store } from "../remote/store.js";

/**
 * AgentPay402's own x402 facilitator for Solana `exact` payments (mainnet USDC).
 *
 * It is the official @x402/svm 2.31 facilitator with one exception: Phantom adds Lighthouse
 * assertion instructions (first data byte 2..17) to the transactions it signs, and one of them
 * reads the fee payer (to check it keeps its SOL). The official verifier refuses any Lighthouse
 * instruction that references the fee payer (`fee_payer_transferring_funds`). Assertions only read
 * accounts and cannot move funds, so here an assertion that references the fee payer is accepted.
 * Every other check (signatures, the single TransferChecked to payTo's account for the exact
 * amount, the fee payer not paying for anything but the network fee, compute limits, memo,
 * simulation of the whole transaction, settlement) is the official code, unchanged.
 *
 * Policy, to keep the fee payer's SOL for our own sellers: only payTo addresses listed in
 * FACILITATOR_PAY_TO, only mainnet USDC, and at most FACILITATOR_DAILY_MAX settlements a day.
 */

export const LIGHTHOUSE_PROGRAM = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";
const DEFAULT_DAILY_MAX = 200;

export class FacilitatorConfigError extends Error {}

type Instruction = { programAddress: { toString(): string }; accounts?: { address: { toString(): string } }[]; data?: Uint8Array };

/** Drops only Phantom's Lighthouse assertions that read the fee payer; everything else goes to the official checks. */
export function withoutFeePayerAssertions(instructions: readonly Instruction[], feePayer: string | undefined): Instruction[] {
  return instructions.filter((ix) => {
    if (!feePayer || ix.programAddress.toString() !== LIGHTHOUSE_PROGRAM) return true;
    const kind = ix.data?.[0];
    const isAssertion = kind !== undefined && kind >= 2 && kind <= 17;
    const readsFeePayer = (ix.accounts ?? []).some((a) => a.address.toString() === feePayer);
    return !(isAssertion && readsFeePayer);
  });
}

/** The official scheme, with the Phantom exception applied before its static (standard wallet) checks. */
export function phantomAwareScheme(signer: FacilitatorSvmSigner): ExactSvmScheme {
  const scheme = new ExactSvmScheme(signer);
  const s = scheme as unknown as { verifyStaticPath: (...args: any[]) => Promise<unknown> };
  const official = s.verifyStaticPath.bind(scheme);
  // _verify (used by both verify and settle) calls this.verifyStaticPath; the instance property wins.
  s.verifyStaticPath = (transaction, compiled, decompiled, payload, requirements, signerAddresses) =>
    official(
      transaction,
      compiled,
      { ...decompiled, instructions: withoutFeePayerAssertions(decompiled.instructions ?? [], requirements?.extra?.feePayer) },
      payload,
      requirements,
      signerAddresses,
    );
  return scheme;
}

function secretKeyBytes(raw: string): Uint8Array {
  const v = raw.trim();
  const bytes = v.startsWith("[") ? Uint8Array.from(JSON.parse(v) as number[]) : new Uint8Array(getBase58Encoder().encode(v));
  if (bytes.length !== 64) throw new FacilitatorConfigError("SOLANA_FACILITATOR_KEY must be a 64-byte Solana secret key (base58 or JSON array).");
  return bytes;
}

export interface FacilitatorSetup {
  facilitator: x402Facilitator;
  feePayer: string;
  payTo: Set<string>;
  dailyMax: number;
}

let cached: Promise<FacilitatorSetup> | undefined;

export function getFacilitator(env: NodeJS.ProcessEnv = process.env): Promise<FacilitatorSetup> {
  cached ??= (async () => {
    const key = env.SOLANA_FACILITATOR_KEY;
    if (!key) throw new FacilitatorConfigError("The facilitator is not set up (SOLANA_FACILITATOR_KEY is missing).");
    const keypair = await createKeyPairSignerFromBytes(secretKeyBytes(key));
    const signer = toFacilitatorSvmSigner(keypair, env.SOLANA_RPC_URL ? { defaultRpcUrl: env.SOLANA_RPC_URL } : undefined);
    const facilitator = new x402Facilitator().register(SOLANA, phantomAwareScheme(signer));
    const payTo = new Set((env.FACILITATOR_PAY_TO ?? "").split(",").map((s) => s.trim()).filter(Boolean));
    const dailyMax = Number(env.FACILITATOR_DAILY_MAX) > 0 ? Number(env.FACILITATOR_DAILY_MAX) : DEFAULT_DAILY_MAX;
    return { facilitator, feePayer: keypair.address, payTo, dailyMax };
  })();
  cached.catch(() => (cached = undefined));
  return cached;
}

/** Why this facilitator will not handle these requirements, or null. */
export function policyProblem(setup: FacilitatorSetup, req: PaymentRequirements): string | null {
  if (req.scheme !== "exact") return "unsupported_scheme";
  if (req.network !== SOLANA) return "unsupported_network";
  if (req.asset !== CHAINS[SOLANA].usdc) return "unsupported_asset";
  if (!setup.payTo.has(req.payTo)) return "pay_to_not_allowed";
  return null;
}

const dayKey = () => `ap:f:settles:${new Date().toISOString().slice(0, 10)}`;

export async function verify(setup: FacilitatorSetup, payload: PaymentPayload, req: PaymentRequirements) {
  const problem = policyProblem(setup, req);
  if (problem) return { isValid: false, invalidReason: problem, payer: "" };
  return setup.facilitator.verify(payload, req);
}

export async function settle(setup: FacilitatorSetup, payload: PaymentPayload, req: PaymentRequirements, store: Store) {
  const problem = policyProblem(setup, req);
  if (problem) return { success: false, errorReason: problem, transaction: "", network: req.network, payer: "" };
  const n = await store.incr(dayKey(), 1, 2 * 24 * 3600);
  if (n > setup.dailyMax) return { success: false, errorReason: "daily_limit_reached", transaction: "", network: req.network, payer: "" };
  return setup.facilitator.settle(payload, req);
}
