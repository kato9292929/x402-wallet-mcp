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
    text = await fs.readFile(file, "utf8");
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
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.appendFile(file, JSON.stringify({ ts: new Date().toISOString(), host, network, reason }) + "\n", { mode: 0o600 });
  } catch {
    // the memory is best effort; never break a payment result on it
  }
}
