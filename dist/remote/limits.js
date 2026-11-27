/**
 * Per-connection limits for the connector, so one caller cannot block everyone or flood sellers.
 *
 * Who a caller is: the MCP session (Mcp-Session-Id, which this server issues at initialize so that clients
 * send it back), or else the sending IP. Claude.ai connects from Anthropic's cloud and does not forward the
 * user's IP, so many users share one IP: the IP fallback gets a higher limit. Only hashes are stored, and
 * they expire with the limit's window.
 */
import { createHash, randomBytes } from "node:crypto";
/** Approval links one connection (or one wallet address) can have waiting at once. */
export const MAX_PENDING_PER_CONNECTION = 20;
/** Approval links waiting across all callers: the last guard for the server. */
export const MAX_PENDING_TOTAL = 100;
/** Calls that fetch a seller's 402 (link-making and checking tools) per caller per window. */
export const RATE_LIMIT_CALLS = 30;
/** The same, for callers known only by IP (many Claude.ai users share Anthropic's IPs). */
export const RATE_LIMIT_CALLS_BY_IP = 300;
export const RATE_WINDOW_S = 300;
const SALT = () => process.env.AGENTPAY_HASH_SALT || "agentpay402-limits";
const digest = (v) => createHash("sha256").update(`${SALT()}:${v}`).digest("hex").slice(0, 32);
export function clientOf(req) {
    const session = req.headers.get("mcp-session-id")?.trim();
    if (session)
        return { conn: `s:${digest(session)}`, bySession: true };
    const ip = (req.headers.get("x-forwarded-for")?.split(",")[0] ?? req.headers.get("x-real-ip") ?? "").trim();
    return { conn: ip ? `ip:${digest(ip)}` : "unknown", bySession: false };
}
/** Counts one call in the current fixed window; over the limit, says how long until the window ends. */
export async function takeCall(store, client, now = Date.now()) {
    const windowMs = RATE_WINDOW_S * 1000;
    const start = Math.floor(now / windowMs) * windowMs;
    const limit = client.bySession ? RATE_LIMIT_CALLS : RATE_LIMIT_CALLS_BY_IP;
    const n = await store.incr(`ap:rl:${client.conn}:${start}`, 1, RATE_WINDOW_S);
    return { ok: n <= limit, limit, retryAfterS: Math.max(1, Math.ceil((start + windowMs - now) / 1000)) };
}
export function rateLimitedResult(r) {
    const minutes = Math.ceil(r.retryAfterS / 60);
    return {
        status: "blocked",
        blocked_reason: "rate_limited",
        paid: false,
        retry_after_s: r.retryAfterS,
        message: `Too many requests from this connection: at most ${r.limit} per ${RATE_WINDOW_S / 60} minutes. Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}. Nothing was prepared or paid, and the seller was not contacted.`,
    };
}
/** Whether a JSON-RPC body (single or batch) contains an initialize request. */
export function isInitialize(body) {
    try {
        const j = JSON.parse(body);
        return (Array.isArray(j) ? j : [j]).some((m) => m?.method === "initialize");
    }
    catch {
        return false;
    }
}
export const newSessionId = () => randomBytes(16).toString("hex");
