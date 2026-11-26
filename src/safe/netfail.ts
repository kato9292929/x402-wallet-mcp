/**
 * Memory of (host, network) pairs where a seller refused our payment, in
 * ~/.x402-wallet-mcp/net-failures.jsonl. A refused network is avoided for that host until
 * 24 hours have passed or Seller Probe has measured the host (a paid purchase) after the
 * refusal, whichever comes first.
 *
 * Ported from kato9292929/RFQ lib/catalog.ts netFailures / activeRefusals /
 * recordNetFailure (0943124).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { configDir } from "../config.js";

export const NET_REFUSAL_TTL_MS = 24 * 3600_000;

export interface NetRefusal {
  ts: string;
  host: string;
  network: string;
  reason?: string;
}

export function netFailuresPath(): string {
  return path.join(configDir(), "net-failures.jsonl");
}

export async function readNetFailures(file = netFailuresPath()): Promise<NetRefusal[]> {
  let text: string;
  try {
    text = await fs.readFile(/*turbopackIgnore: true*/ file, "utf8");
  } catch {
    return [];
  }
  const out: NetRefusal[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r?.host && r?.network && r?.ts) out.push(r);
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

/** Networks still to avoid for a host. */
export function activeRefusals(
  refusals: NetRefusal[],
  host: string,
  probeLastPaidTs: string | null = null,
  now = Date.now(),
  ttlMs = NET_REFUSAL_TTL_MS,
): NetRefusal[] {
  const probeT = probeLastPaidTs ? Date.parse(probeLastPaidTs) : -Infinity;
  return refusals.filter((r) => {
    if (r.host !== host) return false;
    const t = Date.parse(r.ts);
    return now - t < ttlMs && !(probeT > t);
  });
}

export async function recordNetFailure(host: string, network: string, reason: string, file = netFailuresPath()): Promise<void> {
  try {
    await fs.mkdir(/*turbopackIgnore: true*/ path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.appendFile(/*turbopackIgnore: true*/ file, JSON.stringify({ ts: new Date().toISOString(), host, network, reason }) + "\n", { mode: 0o600 });
  } catch {
    // the memory is best effort; never break a payment result on it
  }
}

// ------------------------------------------------------------------ facilitators that refuse wallet-rewritten transactions

/**
 * Solana facilitators (the 402's extra.feePayer) seen refusing transactions signed in Phantom, which adds
 * Lighthouse assertion instructions when signing (4 → 8 instructions, one reading the fee payer).
 * Payments signed in a browser wallet avoid them; signers that do not rewrite the transaction do not.
 * From real payments on 2026-11-25/26.
 */
export const WALLET_INCOMPATIBLE_FEE_PAYERS: Record<string, string> = {
  BENrLoUbndxoNMUS5JXApGMtNykLjFXXixMtpDwDR9SP: "refused a Phantom-signed payment with fee_payer_transferring_funds (2026-11-26)",
  Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88: "refused a Phantom-signed payment with fee_payer_transferring_funds (2026-11-26)",
  FAC42xNoVBZctsRJqwNcRZnXCwmGZvfHcZLD7hQPXuwu: "refused a Phantom-signed payment before sending it, with no reason (2026-11-25)",
};

/** A facilitator learned to refuse wallet-rewritten transactions is avoided for this long. */
export const FEE_PAYER_REFUSAL_TTL_MS = 7 * 24 * 3600_000;

export interface FeePayerRefusal {
  ts: string;
  feePayer: string;
  reason: string;
  host?: string;
}

/** Whether a seller's refusal is caused by the instructions the wallet added (so the facilitator, not the payment, is the problem). */
export function refusesWalletInstructions(reason: string): boolean {
  return /fee_payer_transferring_funds|lighthouse|unexpected[_ -]?instruction|instructions?[_ -]?(length|count)|too[_ -]?many[_ -]?instructions/i.test(reason);
}

export function activeFeePayerRefusals(list: FeePayerRefusal[], now = Date.now(), ttlMs = FEE_PAYER_REFUSAL_TTL_MS): FeePayerRefusal[] {
  return list.filter((r) => now - Date.parse(r.ts) < ttlMs);
}

export function feePayerRefusalsPath(): string {
  return path.join(configDir(), "fee-payer-refusals.jsonl");
}

export async function readFeePayerRefusals(file = feePayerRefusalsPath()): Promise<FeePayerRefusal[]> {
  let text: string;
  try {
    text = await fs.readFile(/*turbopackIgnore: true*/ file, "utf8");
  } catch {
    return [];
  }
  const out: FeePayerRefusal[] = [];
  for (const line of text.split("\n")) {
    try {
      const r = line.trim() ? JSON.parse(line) : null;
      if (r?.feePayer && r?.ts) out.push(r);
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

export async function recordFeePayerRefusal(feePayer: string, reason: string, host: string, file = feePayerRefusalsPath()): Promise<void> {
  try {
    await fs.mkdir(/*turbopackIgnore: true*/ path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.appendFile(/*turbopackIgnore: true*/ file, JSON.stringify({ ts: new Date().toISOString(), feePayer, reason, host }) + "\n", { mode: 0o600 });
  } catch {
    // best effort
  }
}
