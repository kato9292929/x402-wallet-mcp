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
export function netFailuresPath() {
    return path.join(configDir(), "net-failures.jsonl");
}
export async function readNetFailures(file = netFailuresPath()) {
    let text;
    try {
        text = await fs.readFile(/*turbopackIgnore: true*/ file, "utf8");
    }
    catch {
        return [];
    }
    const out = [];
    for (const line of text.split("\n")) {
        if (!line.trim())
            continue;
        try {
            const r = JSON.parse(line);
            if (r?.host && r?.network && r?.ts)
                out.push(r);
        }
        catch {
            // skip malformed lines
        }
    }
    return out;
}
/** Networks still to avoid for a host. */
export function activeRefusals(refusals, host, probeLastPaidTs = null, now = Date.now(), ttlMs = NET_REFUSAL_TTL_MS) {
    const probeT = probeLastPaidTs ? Date.parse(probeLastPaidTs) : -Infinity;
    return refusals.filter((r) => {
        if (r.host !== host)
            return false;
        const t = Date.parse(r.ts);
        return now - t < ttlMs && !(probeT > t);
    });
}
export async function recordNetFailure(host, network, reason, file = netFailuresPath()) {
    try {
        await fs.mkdir(/*turbopackIgnore: true*/ path.dirname(file), { recursive: true, mode: 0o700 });
        await fs.appendFile(/*turbopackIgnore: true*/ file, JSON.stringify({ ts: new Date().toISOString(), host, network, reason }) + "\n", { mode: 0o600 });
    }
    catch {
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
export const WALLET_INCOMPATIBLE_FEE_PAYERS = {
    BENrLoUbndxoNMUS5JXApGMtNykLjFXXixMtpDwDR9SP: "refused a Phantom-signed payment with fee_payer_transferring_funds (2026-11-26)",
    Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88: "refused a Phantom-signed payment with fee_payer_transferring_funds (2026-11-26)",
    D6ZhtNQ5nT9ZnTHUbqXZsTx5MH2rPFiBBggX4hY1WePM: "refused a Phantom-signed payment with \"Facilitator validation failed: Invalid payment: Facilitator returned 400 Bad Request with no error\" (2026-11-27, CoinGecko pro-api)",
    FAC42xNoVBZctsRJqwNcRZnXCwmGZvfHcZLD7hQPXuwu: "refused a Phantom-signed payment before sending it, with no reason (2026-11-25)",
};
/** A facilitator learned to refuse wallet-rewritten transactions is avoided for this long. */
export const FEE_PAYER_REFUSAL_TTL_MS = 7 * 24 * 3600_000;
/** Whether a seller's refusal is caused by the instructions the wallet added (so the facilitator, not the payment, is the problem). */
export function refusesWalletInstructions(reason) {
    return /fee_payer_transferring_funds|lighthouse|unexpected[_ -]?instruction|instructions?[_ -]?(length|count)|too[_ -]?many[_ -]?instructions|facilitator validation failed|400 bad request with no error/i.test(reason);
}
export function activeFeePayerRefusals(list, now = Date.now(), ttlMs = FEE_PAYER_REFUSAL_TTL_MS) {
    return list.filter((r) => now - Date.parse(r.ts) < ttlMs);
}
export function feePayerRefusalsPath() {
    return path.join(configDir(), "fee-payer-refusals.jsonl");
}
export async function readFeePayerRefusals(file = feePayerRefusalsPath()) {
    let text;
    try {
        text = await fs.readFile(/*turbopackIgnore: true*/ file, "utf8");
    }
    catch {
        return [];
    }
    const out = [];
    for (const line of text.split("\n")) {
        try {
            const r = line.trim() ? JSON.parse(line) : null;
            if (r?.feePayer && r?.ts)
                out.push(r);
        }
        catch {
            // skip malformed lines
        }
    }
    return out;
}
export async function recordFeePayerRefusal(feePayer, reason, host, file = feePayerRefusalsPath()) {
    try {
        await fs.mkdir(/*turbopackIgnore: true*/ path.dirname(file), { recursive: true, mode: 0o700 });
        await fs.appendFile(/*turbopackIgnore: true*/ file, JSON.stringify({ ts: new Date().toISOString(), feePayer, reason, host }) + "\n", { mode: 0o600 });
    }
    catch {
        // best effort
    }
}
export function successesPath() {
    return path.join(configDir(), "successes.jsonl");
}
export async function readSuccesses(file = successesPath()) {
    let text;
    try {
        text = await fs.readFile(/*turbopackIgnore: true*/ file, "utf8");
    }
    catch {
        return [];
    }
    const out = [];
    for (const line of text.split("\n")) {
        try {
            const r = line.trim() ? JSON.parse(line) : null;
            if (r?.host && r?.network && r?.ts)
                out.push(r);
        }
        catch {
            // skip malformed lines
        }
    }
    return out;
}
export async function recordSuccess(r, file = successesPath()) {
    try {
        await fs.mkdir(/*turbopackIgnore: true*/ path.dirname(file), { recursive: true, mode: 0o700 });
        await fs.appendFile(/*turbopackIgnore: true*/ file, JSON.stringify(r) + "\n", { mode: 0o600 });
    }
    catch {
        // best effort
    }
}
