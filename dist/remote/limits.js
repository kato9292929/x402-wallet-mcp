/**
 * Per-connection limits for the connector, so one caller cannot block everyone or flood sellers.
 *
 * Who a caller is: the MCP session, or else the sending IP.
 * - Session ids are issued by this server at initialize and signed with a server key (HMAC), so a caller
 *   cannot make up new ones: an id without a valid signature is ignored and the caller is counted by IP.
 * - initialize (issuing an id) is limited per IP, so a caller cannot get a new id for every request.
 * - Claude.ai connects from Anthropic's cloud and does not forward the user's IP, so many users share
 *   Anthropic's IPs. Requests from Anthropic's published outbound ranges get looser per-IP limits; requests
 *   from other IPs are also limited per IP across all their sessions. The ranges only loosen limits, they
 *   never skip them.
 *
 * Only hashes of session ids and IPs are stored, and they expire with the limit's window.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
/** Approval links one connection (or one wallet address) can have waiting at once. */
export const MAX_PENDING_PER_CONNECTION = 20;
/** Approval links waiting from one IP outside Anthropic's ranges, across all its sessions. */
export const MAX_PENDING_PER_IP = 20;
/** Approval links waiting across all callers: the last guard for the server. */
export const MAX_PENDING_TOTAL = 100;
/** Calls that fetch a seller's 402 (link-making and checking tools) per session per window. */
export const RATE_LIMIT_CALLS = 30;
/** The same per IP outside Anthropic's ranges, across all its sessions (or without a session). */
export const RATE_LIMIT_CALLS_PER_IP = 60;
/** The same for an IP in Anthropic's ranges without a valid session (many Claude.ai users share it). */
export const RATE_LIMIT_CALLS_ANTHROPIC_IP = 300;
/** Session ids issued per IP per window. */
export const MAX_SESSIONS_PER_IP = 10;
export const MAX_SESSIONS_PER_ANTHROPIC_IP = 1000;
export const RATE_WINDOW_S = 300;
/**
 * Anthropic's outbound IPv4 ranges, used "for outbound requests (for example, when making MCP tool calls to
 * external servers)": https://platform.claude.com/docs/en/api/ip-addresses (checked 2026-11-27).
 */
export const ANTHROPIC_OUTBOUND_V4 = ["160.79.104.0/21", "153.61.208.0/20"];
/** The server's secret (AGENTPAY_SESSION_SECRET, else the store's token, which is already set). */
const serverSecret = () => process.env.AGENTPAY_SESSION_SECRET || process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
let processKey;
/** A key for one purpose, derived from the server's secret; without one (local runs, tests), random per process. */
const keyFor = (purpose) => {
    const secret = serverSecret();
    if (secret)
        return createHash("sha256").update(`agentpay402-${purpose}-v1:${secret}`).digest();
    return createHash("sha256").update(purpose).update((processKey ??= randomBytes(32))).digest();
};
/**
 * Hashes of session ids and IPs are keyed with a secret (HMAC): with a public salt, the about 4.3 billion IPv4
 * addresses could be tried one by one to turn a hash back into the IP. AGENTPAY_HASH_SALT overrides the key.
 */
const digest = (v) => createHmac("sha256", process.env.AGENTPAY_HASH_SALT || keyFor("hash")).update(v).digest("hex").slice(0, 32);
/** Key for signing session ids: rotating the store token makes issued ids invalid (callers fall back to IP). */
const sessionKey = () => keyFor("session");
const sign = (nonce) => createHmac("sha256", sessionKey()).update(nonce).digest("hex").slice(0, 32);
/** A new session id: "<random>.<signature>". */
export function newSessionId() {
    const nonce = randomBytes(16).toString("hex");
    return `${nonce}.${sign(nonce)}`;
}
/** Whether a session id was issued by this server. */
export function validSessionId(id) {
    const m = /^([0-9a-f]{32})\.([0-9a-f]{32})$/.exec(id);
    if (!m)
        return false;
    return timingSafeEqual(Buffer.from(sign(m[1])), Buffer.from(m[2]));
}
const v4 = (ip) => {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.replace(/^::ffff:/i, ""));
    if (!m)
        return null;
    const parts = m.slice(1).map(Number);
    if (parts.some((p) => p > 255))
        return null;
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
};
export function isAnthropicIp(ip) {
    const n = v4(ip);
    if (n === null)
        return false;
    return ANTHROPIC_OUTBOUND_V4.some((cidr) => {
        const [base, bits] = cidr.split("/");
        const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
        return ((n & mask) >>> 0) === ((v4(base) & mask) >>> 0);
    });
}
/** The sending IP as Vercel reports it (Vercel sets these headers; see its request-headers docs). */
export function ipOf(req) {
    const h = req.headers;
    return (h.get("x-vercel-forwarded-for") ?? h.get("x-real-ip") ?? h.get("x-forwarded-for") ?? "").split(",")[0].trim();
}
export function clientOf(req) {
    const raw = ipOf(req);
    const ip = raw ? `ip:${digest(raw)}` : "unknown";
    const anthropic = raw ? isAnthropicIp(raw) : false;
    const session = req.headers.get("mcp-session-id")?.trim();
    if (session && validSessionId(session))
        return { conn: `s:${digest(session)}`, bySession: true, ip, anthropic, session: "valid" };
    return { conn: ip, bySession: false, ip, anthropic, session: session ? "invalid" : "none" };
}
const windowOf = (now) => {
    const windowMs = RATE_WINDOW_S * 1000;
    const start = Math.floor(now / windowMs) * windowMs;
    return { start, retryAfterS: Math.max(1, Math.ceil((start + windowMs - now) / 1000)) };
};
/**
 * Counts one call in the current fixed window, per session and (outside Anthropic's ranges) per IP; over a
 * limit, says how long until the window ends.
 */
export async function takeCall(store, client, now = Date.now()) {
    const { start, retryAfterS } = windowOf(now);
    const buckets = [];
    if (client.bySession)
        buckets.push([client.conn, RATE_LIMIT_CALLS]);
    if (!client.anthropic)
        buckets.push([client.ip, RATE_LIMIT_CALLS_PER_IP]);
    else if (!client.bySession)
        buckets.push([client.ip, RATE_LIMIT_CALLS_ANTHROPIC_IP]);
    for (const [key, limit] of buckets) {
        const n = await store.incr(`ap:rl:${key}:${start}`, 1, RATE_WINDOW_S);
        if (n > limit)
            return { ok: false, limit, retryAfterS };
    }
    return { ok: true, limit: buckets[0]?.[1] ?? RATE_LIMIT_CALLS, retryAfterS };
}
/** Whether this IP may be issued another session id in the current window. */
export async function takeSession(store, client, now = Date.now()) {
    const { start } = windowOf(now);
    const n = await store.incr(`ap:sess:${client.ip}:${start}`, 1, RATE_WINDOW_S);
    return n <= (client.anthropic ? MAX_SESSIONS_PER_ANTHROPIC_IP : MAX_SESSIONS_PER_IP);
}
/** Buckets a new approval link is counted in (besides the server total). */
export function pendingBuckets(client, payer) {
    // The address in the connection URL is chosen by the caller, so the connection and the IP are counted too.
    const out = payer ? [{ key: payer, max: MAX_PENDING_PER_CONNECTION, what: "wallet" }] : [];
    out.push({ key: `conn:${client?.conn ?? "unknown"}`, max: MAX_PENDING_PER_CONNECTION, what: "connection" });
    if (client && !client.anthropic && client.ip !== client.conn) {
        out.push({ key: `conn:${client.ip}`, max: MAX_PENDING_PER_IP, what: "network address" });
    }
    return out;
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
/**
 * Day counter of seller-reaching tool calls by the session id sent (valid / invalid / none) and by whether the
 * call came from Anthropic's ranges. Only these six counters per day are kept: no ids or IPs.
 */
export const statKey = (now, session, anthropic) => `ap:stat2:${new Date(now).toISOString().slice(0, 10)}:${session}:${anthropic ? "anthropic" : "other"}`;
/** The day counters before they were split (session / nosession), still read for the overall share. */
export const legacyStatKey = (now, withSession) => `ap:stat:${new Date(now).toISOString().slice(0, 10)}:${withSession ? "session" : "nosession"}`;
