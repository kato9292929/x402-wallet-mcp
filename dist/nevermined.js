import { parseUsdToMicros } from "./chains.js";
/**
 * Buyer side of the Nevermined `nvm:erc4337` scheme, over Nevermined's REST API.
 *
 * Ported from @nevermined-io/payments 1.13.0 (x402/token.js getX402AccessToken,
 * x402/token-request.js buildX402TokenRequestBody, x402/delegation-api.js createDelegation /
 * listPaymentMethods, environments.js). The SDK itself is not a dependency: it pulls in
 * OpenTelemetry, LangChain and an OpenAI client whose peer requirements conflict with the
 * rest of this package, and only these three calls are used here.
 */
/** Header Nevermined reads the access token from (x402 v2 `payment-signature`). */
export const NVM_PAYMENT_HEADER = "payment-signature";
/** API version the SDK pins (common/api-version.js LOCKED_API_VERSION). */
const NVM_API_VERSION = "1.1";
/** Backend per key prefix (environments.js). */
const BACKENDS = {
    sandbox: "https://api.sandbox.nevermined.app",
    live: "https://api.live.nevermined.app",
    "sandbox-staging": "https://api.sandbox.nevermined.dev",
    "live-staging": "https://api.live.nevermined.dev",
};
export function neverminedConfigured() {
    return Boolean(process.env.NVM_API_KEY?.trim());
}
/** "sandbox" / "live" / ... from the NVM_API_KEY prefix. */
export function neverminedEnvironment() {
    const key = process.env.NVM_API_KEY?.trim();
    if (!key)
        return undefined;
    const i = key.indexOf(":");
    return i > 0 ? key.slice(0, i) : undefined;
}
export function neverminedBackend() {
    const env = neverminedEnvironment();
    const backend = process.env.NVM_BACKEND_URL?.trim() || (env ? BACKENDS[env] : undefined);
    if (!backend)
        throw new Error(`NVM_API_KEY has an unknown environment prefix "${env ?? ""}" (expected sandbox: or live:)`);
    return backend.replace(/\/$/, "");
}
/**
 * Plans must already be purchased on nevermined.app (or be auto-topped-up by a delegation).
 * Each payment mints an x402 access token for the plan in the 402 response, using a delegation:
 *   - NVM_DELEGATION_ID if set (recommended: created and capped by the human), else
 *   - one delegation created on first use and reused for the life of the process, capped at
 *     perSessionMaxUsd for 24 hours, bound to NVM_PAYMENT_METHOD_ID or else the account's
 *     first active erc4337 (crypto wallet) payment method.
 */
export class NeverminedPayer {
    fetchImpl;
    delegationId;
    constructor(fetchImpl = fetch) {
        this.fetchImpl = fetchImpl;
    }
    async call(method, path, body) {
        const key = process.env.NVM_API_KEY?.trim();
        if (!key)
            throw new Error("NVM_API_KEY is not set");
        const res = await this.fetchImpl(neverminedBackend() + path, {
            method,
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                Authorization: `Bearer ${key}`,
                "Nevermined-Version": NVM_API_VERSION,
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(30_000),
        });
        const text = await res.text();
        let json;
        try {
            json = text ? JSON.parse(text) : undefined;
        }
        catch {
            json = undefined;
        }
        if (!res.ok) {
            const msg = json?.message ? `${json.message}${json.hint ? ` — ${json.hint}` : ""}` : text.slice(0, 200);
            throw new Error(`Nevermined ${method} ${path} failed (HTTP ${res.status}): ${msg}`);
        }
        return json;
    }
    delegation(cfg) {
        const fromEnv = process.env.NVM_DELEGATION_ID?.trim();
        if (fromEnv)
            return Promise.resolve(fromEnv);
        this.delegationId ??= (async () => {
            const cents = Number(parseUsdToMicros(cfg.perSessionMaxUsd) / 10000n);
            let methodId = process.env.NVM_PAYMENT_METHOD_ID?.trim();
            if (!methodId) {
                const methods = await this.call("GET", "/api/v1/payment-methods");
                methodId = (methods ?? []).find((m) => m.provider === "erc4337" && /active/i.test(String(m.status)))?.id;
            }
            const res = await this.call("POST", "/api/v1/delegation/create", {
                provider: "erc4337",
                currency: "usdc",
                spendingLimitCents: Math.max(cents, 1),
                durationSecs: 24 * 60 * 60,
                ...(methodId ? { providerPaymentMethodId: methodId } : {}),
            });
            if (!res?.delegationId)
                throw new Error("Nevermined created no delegation");
            process.stderr.write(`[x402-wallet-mcp] created Nevermined delegation ${res.delegationId}\n`);
            return res.delegationId;
        })();
        this.delegationId.catch(() => (this.delegationId = undefined));
        return this.delegationId;
    }
    /** Returns the headers to attach to the retried request. */
    async paymentHeaders(req, cfg) {
        if (!req.planId)
            throw new Error("Nevermined requirement has no planId");
        const delegationId = await this.delegation(cfg);
        const result = await this.call("POST", "/api/v1/x402/permissions", {
            accepted: {
                scheme: "nvm:erc4337",
                network: req.network,
                planId: req.planId,
                extra: { ...(req.agentId ? { agentId: req.agentId } : {}) },
            },
            delegationConfig: { delegationId },
        });
        if (typeof result?.accessToken !== "string" || !result.accessToken) {
            throw new Error("Nevermined token request succeeded but returned no accessToken");
        }
        return { [NVM_PAYMENT_HEADER]: result.accessToken };
    }
}
