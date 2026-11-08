/**
 * JSON-RPC with failover: the dedicated RPC (env) first, then public RPCs in order.
 * Rate limits (429, "limit"), 5xx, timeouts and network errors are retried with a
 * growing pause, then the next RPC is tried. Reads only; nothing is ever (re)sent.
 *
 * Ported from kato9292929/RFQ lib/base-rpc.ts (0943124), extended to Base Sepolia and
 * Solana mainnet / devnet.
 */
import { BASE, BASE_SEPOLIA, SOLANA, SOLANA_DEVNET } from "../chains.js";
/** Public RPCs per network, tried after the dedicated one. Listed in the README. */
export const PUBLIC_RPCS = {
    [BASE]: ["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.drpc.org"],
    [BASE_SEPOLIA]: ["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com"],
    [SOLANA]: ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"],
    [SOLANA_DEVNET]: ["https://api.devnet.solana.com"],
};
/** Env var holding the dedicated RPC for each network. */
export const DEDICATED_RPC_ENV = {
    [BASE]: "BASE_RPC_URL",
    [BASE_SEPOLIA]: "BASE_SEPOLIA_RPC_URL",
    [SOLANA]: "SOLANA_RPC_URL",
    [SOLANA_DEVNET]: "SOLANA_DEVNET_RPC_URL",
};
export function rpcUrls(network) {
    const env = DEDICATED_RPC_ENV[network];
    const dedicated = env && process.env[env]?.trim() ? [process.env[env].trim()] : [];
    return [...new Set([...dedicated, ...(PUBLIC_RPCS[network] ?? [])])];
}
/** Host only: never log an API key that sits in a URL path or query. */
export const rpcLabel = (url) => {
    try {
        return new URL(url).host;
    }
    catch {
        return "?";
    }
};
export class RpcUnavailable extends Error {
    errors;
    constructor(errors) {
        super(`all RPCs failed: ${errors.join("; ")}`);
        this.errors = errors;
        this.name = "RpcUnavailable";
    }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const transient = (status, msg) => status === 429 || status >= 500 || /limit|rate|too many|timeout|busy|unavailable/i.test(msg);
/** One JSON-RPC call with retries per RPC and failover across RPCs. */
export async function rpcCall(network, method, params, o = {}) {
    const urls = o.urls ?? rpcUrls(network);
    const attempts = o.attempts ?? 3;
    const delay = o.delayMs ?? 1500;
    const doFetch = o.fetch ?? fetch;
    const errors = [];
    for (const url of urls) {
        for (let i = 0; i < attempts; i++) {
            let status = 0;
            let msg = "";
            try {
                const r = await doFetch(url, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
                    signal: AbortSignal.timeout(o.timeoutMs ?? 20_000),
                });
                status = r.status;
                const text = await r.text();
                let j;
                try {
                    j = JSON.parse(text);
                }
                catch {
                    msg = `HTTP ${r.status}: ${text.slice(0, 80)}`;
                }
                if (j && !j.error && r.ok)
                    return { result: j.result, rpc: rpcLabel(url) };
                msg ||= j?.error ? `${j.error.code}: ${j.error.message}` : `HTTP ${r.status}`;
                if (!transient(status, msg)) {
                    errors.push(`${rpcLabel(url)} ${msg}`);
                    break; // not worth retrying on this RPC
                }
            }
            catch (e) {
                msg = e?.name === "TimeoutError" ? "timeout" : String(e?.message ?? e);
            }
            errors.push(`${rpcLabel(url)} ${msg}`);
            if (i < attempts - 1)
                await sleep(delay * (i + 1));
        }
    }
    throw new RpcUnavailable(errors);
}
export const defaultRpc = (network, method, params) => rpcCall(network, method, params);
