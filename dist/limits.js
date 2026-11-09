import { formatMicros, parseUsdToMicros } from "./chains.js";
export class SpendLimitError extends Error {
    code;
    constructor(message, code) {
        super(message);
        this.code = code;
        this.name = "SpendLimitError";
    }
}
/**
 * Enforces the human-set limits. The session total lives in memory and starts
 * at zero each time the MCP server process starts.
 */
export class SpendGuard {
    spentMicros = 0n;
    get sessionSpentMicros() {
        return this.spentMicros;
    }
    checkHost(cfg, url) {
        if (cfg.allowedHosts.length === 0)
            return;
        const host = new URL(url).hostname.toLowerCase();
        if (!cfg.allowedHosts.includes(host)) {
            throw new SpendLimitError(`Host "${host}" is not in allowedHosts (${cfg.allowedHosts.join(", ")}). ` +
                `Only the wallet owner can change this in the config file.`, "HOST_NOT_ALLOWED");
        }
    }
    /** Throws if paying `micros` would break the per-call or per-session limit. */
    checkAmount(cfg, micros) {
        const perCall = parseUsdToMicros(cfg.perCallMaxUsd);
        const perSession = parseUsdToMicros(cfg.perSessionMaxUsd);
        // Messages carry the price only: limit, spend and balance values never leave the server.
        if (micros > perCall) {
            throw new SpendLimitError(`Price $${formatMicros(micros)} exceeds the per-call limit. Payment was not made.`, "PER_CALL_LIMIT");
        }
        if (this.spentMicros + micros > perSession) {
            throw new SpendLimitError(`Price $${formatMicros(micros)} would exceed the per-session limit. Payment was not made.`, "PER_SESSION_LIMIT");
        }
    }
    record(micros) {
        this.spentMicros += micros;
    }
    /** Undo a reservation when the seller rejected the payment (nothing settled). */
    release(micros) {
        this.spentMicros -= micros;
        if (this.spentMicros < 0n)
            this.spentMicros = 0n;
    }
    /** What the agent may see about the limits: that they exist, not their values. */
    summary(cfg) {
        return {
            perCallLimit: "set by the wallet owner",
            perSessionLimit: "set by the wallet owner",
            allowedHosts: cfg.allowedHosts.length ? cfg.allowedHosts : "all hosts",
            network: cfg.network,
            probeMode: cfg.probeMode,
            priceMismatch: cfg.priceMismatch,
            retryWithReceipt: cfg.retryWithReceipt,
            reportToProbe: cfg.reportToProbe,
        };
    }
}
