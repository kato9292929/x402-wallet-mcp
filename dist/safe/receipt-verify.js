// Vendored from kato9292929/delivery-receipt packages/verify/src/index.ts (08f9218). Do not edit here; change it there and copy again.
/**
 * @x402jp/delivery-receipt-verify
 *
 * Buyer-side verifier for x402 Delivery Receipts.
 *
 * This file is intentionally self-contained: it depends only on `node:crypto`
 * and the global `fetch`, so it can be vendor-copied into another repository
 * as a single file. See docs/spec.md for the protocol.
 */
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
export const RECEIPT_VERSION = 1;
/** Response header carrying the encoded receipt. */
export const RECEIPT_HEADER = "X-Delivery-Receipt";
/** Request header a buyer sets (with the payment_id) to ask for a refetch. */
export const REFETCH_HEADER = "X-Payment-Refetch";
/** Path of the seller's public key document. */
export const WELL_KNOWN_PATH = "/.well-known/x402-receipt.json";
/** Minimum refetch window a seller may advertise (24h). */
export const MIN_REFETCH_WINDOW_S = 86_400;
/** Default refetch window / retention (7 days). */
export const DEFAULT_REFETCH_WINDOW_S = 604_800;
// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------
const B64URL_RE = /^[A-Za-z0-9_-]*$/;
/** base64url without padding. */
export function base64urlEncode(bytes) {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64url");
}
/** Strict base64url decode (no padding, no '+' or '/'). Throws on invalid input. */
export function base64urlDecode(s) {
    if (!B64URL_RE.test(s) || s.length % 4 === 1)
        throw new Error("invalid base64url");
    return new Uint8Array(Buffer.from(s, "base64url"));
}
/** Lowercase hex sha256. */
export function sha256Hex(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}
/**
 * Canonical JSON: object keys sorted (recursively, by UTF-16 code unit order,
 * which equals alphabetical order for ASCII keys), no whitespace. Array order is
 * preserved; `undefined` object members are omitted as in JSON.stringify.
 */
export function canonicalJson(value) {
    if (value === null)
        return "null";
    switch (typeof value) {
        case "string":
        case "boolean":
            return JSON.stringify(value);
        case "number":
            if (!Number.isFinite(value))
                throw new Error("canonicalJson: non-finite number");
            return JSON.stringify(value);
        case "object": {
            if (Array.isArray(value)) {
                return "[" + value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",") + "]";
            }
            const obj = value;
            const keys = Object.keys(obj)
                .filter((k) => obj[k] !== undefined)
                .sort();
            return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
        }
        default:
            throw new Error(`canonicalJson: unsupported type ${typeof value}`);
    }
}
/** The exact bytes that are signed: UTF-8 canonical JSON of every field except `sig`. */
export function receiptSigningBytes(receipt) {
    const { sig: _sig, ...payload } = receipt;
    return new Uint8Array(Buffer.from(canonicalJson(payload), "utf8"));
}
/** Encode a receipt as the X-Delivery-Receipt header value (base64url of its JSON). */
export function encodeReceipt(receipt) {
    return base64urlEncode(new Uint8Array(Buffer.from(canonicalJson(receipt), "utf8")));
}
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
/** Decode and shape-check an X-Delivery-Receipt header value. Throws on malformed input. */
export function decodeReceipt(header) {
    const json = Buffer.from(base64urlDecode(header.trim())).toString("utf8");
    const r = JSON.parse(json);
    if (typeof r !== "object" || r === null || Array.isArray(r))
        throw new Error("receipt: not an object");
    if (r.v !== 1)
        throw new Error("receipt: unsupported version");
    for (const k of ["payment_id", "network", "resource", "body_sha256", "issued_at", "key_id", "sig"]) {
        if (typeof r[k] !== "string" || r[k].length === 0)
            throw new Error(`receipt: bad ${k}`);
    }
    if (!HEX64_RE.test(r.body_sha256))
        throw new Error("receipt: bad body_sha256");
    if (!Number.isSafeInteger(r.content_length) || r.content_length < 0) {
        throw new Error("receipt: bad content_length");
    }
    if (!ISO_RE.test(r.issued_at) || Number.isNaN(Date.parse(r.issued_at))) {
        throw new Error("receipt: bad issued_at");
    }
    if (r.delivery !== "first" && r.delivery !== "refetch")
        throw new Error("receipt: bad delivery");
    return r;
}
/** Import a base64url raw 32-byte Ed25519 public key. */
export function importEd25519PublicKey(publicKeyB64u) {
    const raw = base64urlDecode(publicKeyB64u);
    if (raw.length !== 32)
        throw new Error("Ed25519 public key must be 32 bytes");
    return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKeyB64u }, format: "jwk" });
}
// ---------------------------------------------------------------------------
// Well-known document
// ---------------------------------------------------------------------------
/** Shape-check a parsed well-known document. Throws on malformed input. */
export function parseWellKnown(doc) {
    const d = doc;
    if (!d || typeof d !== "object" || !Array.isArray(d.keys))
        throw new Error("well-known: missing keys");
    for (const k of d.keys) {
        if (!k || typeof k.key_id !== "string" || typeof k.public_key !== "string" || k.alg !== "Ed25519") {
            throw new Error("well-known: bad key entry");
        }
        if (k.revoked_at !== undefined && Number.isNaN(Date.parse(k.revoked_at))) {
            throw new Error("well-known: bad revoked_at");
        }
    }
    if (typeof d.refetch_window_s !== "number" || d.refetch_window_s < MIN_REFETCH_WINDOW_S) {
        throw new Error("well-known: refetch_window_s must be >= 86400");
    }
    if (typeof d.refetch_header !== "string")
        throw new Error("well-known: missing refetch_header");
    return d;
}
/** Fetch and validate `<origin>/.well-known/x402-receipt.json`. */
export async function fetchWellKnown(origin, opts = {}) {
    const f = opts.fetch ?? globalThis.fetch;
    const url = new URL(WELL_KNOWN_PATH, origin);
    const res = await f(url, { headers: { accept: "application/json" } });
    if (res.status !== 200)
        throw new Error(`well-known: HTTP ${res.status}`);
    return parseWellKnown(await res.json());
}
// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------
/**
 * Verify a receipt against the exact body bytes and the seller's key document.
 *
 * Check order: presence -> key lookup -> signature -> revocation -> body hash -> expectations.
 * An `expect` mismatch is reported as `receipt_bad_signature` (the receipt does not
 * attest to what the caller asked for) with a `detail`.
 */
export function verifyReceipt(input) {
    const { header, body, wellKnown, expect } = input;
    if (header === null || header === undefined || header.trim() === "") {
        return { ok: false, reason: "receipt_missing" };
    }
    let receipt;
    try {
        receipt = decodeReceipt(header);
    }
    catch (e) {
        return { ok: false, reason: "receipt_bad_signature", detail: `malformed: ${e.message}` };
    }
    const key = wellKnown.keys.find((k) => k.key_id === receipt.key_id);
    if (!key || key.alg !== "Ed25519")
        return { ok: false, reason: "receipt_key_unknown", detail: "unknown key_id" };
    let pub;
    try {
        pub = importEd25519PublicKey(key.public_key);
    }
    catch {
        return { ok: false, reason: "receipt_key_unknown", detail: "unusable public key" };
    }
    let sigOk = false;
    try {
        const sig = base64urlDecode(receipt.sig);
        sigOk = sig.length === 64 && cryptoVerify(null, receiptSigningBytes(receipt), pub, sig);
    }
    catch {
        sigOk = false;
    }
    if (!sigOk)
        return { ok: false, reason: "receipt_bad_signature" };
    if (key.revoked_at !== undefined && !(Date.parse(receipt.issued_at) < Date.parse(key.revoked_at))) {
        return { ok: false, reason: "receipt_key_unknown", detail: "issued at or after key revocation" };
    }
    if (receipt.content_length !== body.byteLength || sha256Hex(body) !== receipt.body_sha256) {
        return { ok: false, reason: "receipt_hash_mismatch" };
    }
    if (expect?.payment_id !== undefined && !samePaymentId(expect.payment_id, receipt.payment_id)) {
        return { ok: false, reason: "receipt_bad_signature", detail: "payment_id mismatch" };
    }
    if (expect?.resource !== undefined && expect.resource !== receipt.resource) {
        return { ok: false, reason: "receipt_bad_signature", detail: "resource mismatch" };
    }
    return { ok: true, receipt };
}
/** EVM nonces are hex and compared case-insensitively; Solana signatures are case-sensitive base58. */
function samePaymentId(a, b) {
    if (a.startsWith("0x") && b.startsWith("0x"))
        return a.toLowerCase() === b.toLowerCase();
    return a === b;
}
// ---------------------------------------------------------------------------
// Refetch
// ---------------------------------------------------------------------------
/**
 * Re-fetch already-paid content by re-sending the original payment header plus
 * `X-Payment-Refetch: <payment_id>`, then verify the returned receipt.
 *
 * 410 -> refetch_expired; any other non-200 (including 402) -> refetch_refused.
 */
export async function refetch(input) {
    const f = input.fetch ?? globalThis.fetch;
    const headers = {
        ...(input.headers ?? {}),
        ...input.paymentHeaders,
        [REFETCH_HEADER]: input.paymentId,
    };
    let res;
    try {
        res = await f(input.url, { method: "GET", headers });
    }
    catch (e) {
        return { ok: false, reason: "refetch_refused", detail: `network error: ${e.message}` };
    }
    if (res.status === 410) {
        await res.body?.cancel().catch(() => { });
        return { ok: false, reason: "refetch_expired", status: 410 };
    }
    if (res.status !== 200) {
        await res.body?.cancel().catch(() => { });
        return { ok: false, reason: "refetch_refused", status: res.status };
    }
    const body = new Uint8Array(await res.arrayBuffer());
    const header = res.headers.get(RECEIPT_HEADER);
    let wellKnown = input.wellKnown;
    if (!wellKnown) {
        try {
            wellKnown = await fetchWellKnown(new URL(input.url).origin, { fetch: f });
        }
        catch (e) {
            return { ok: false, reason: "receipt_key_unknown", status: 200, detail: e.message };
        }
    }
    const v = verifyReceipt({
        header,
        body,
        wellKnown,
        expect: { payment_id: input.paymentId, resource: input.expectResource },
    });
    if (!v.ok)
        return { ...v, status: 200 };
    return { ok: true, body, receipt: v.receipt, status: 200 };
}
