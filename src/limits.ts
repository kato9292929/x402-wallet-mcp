import { formatMicros, parseUsdToMicros } from "./chains.js";
import type { SpendConfig } from "./config.js";

export class SpendLimitError extends Error {
  constructor(
    message: string,
    readonly code: "HOST_NOT_ALLOWED" | "PER_CALL_LIMIT" | "PER_SESSION_LIMIT" | "UNPRICEABLE",
  ) {
    super(message);
    this.name = "SpendLimitError";
  }
}

/**
 * Enforces the human-set limits. The session total lives in memory and starts
 * at zero each time the MCP server process starts.
 */
export class SpendGuard {
  private spentMicros = 0n;

  get sessionSpentMicros(): bigint {
    return this.spentMicros;
  }

  checkHost(cfg: SpendConfig, url: string): void {
    if (cfg.allowedHosts.length === 0) return;
    const host = new URL(url).hostname.toLowerCase();
    if (!cfg.allowedHosts.includes(host)) {
      throw new SpendLimitError(
        `Host "${host}" is not in allowedHosts (${cfg.allowedHosts.join(", ")}). ` +
          `Only the wallet owner can change this in the config file.`,
        "HOST_NOT_ALLOWED",
      );
    }
  }

  /** Throws if paying `micros` would break the per-call or per-session limit. */
  checkAmount(cfg: SpendConfig, micros: bigint): void {
    const perCall = parseUsdToMicros(cfg.perCallMaxUsd);
    const perSession = parseUsdToMicros(cfg.perSessionMaxUsd);
    if (micros > perCall) {
      throw new SpendLimitError(
        `Price $${formatMicros(micros)} exceeds the per-call limit of $${formatMicros(perCall)}. ` +
          `Payment was not made.`,
        "PER_CALL_LIMIT",
      );
    }
    if (this.spentMicros + micros > perSession) {
      throw new SpendLimitError(
        `Price $${formatMicros(micros)} would bring this session's spend to ` +
          `$${formatMicros(this.spentMicros + micros)}, over the per-session limit of ` +
          `$${formatMicros(perSession)} (already spent $${formatMicros(this.spentMicros)}). ` +
          `Payment was not made.`,
        "PER_SESSION_LIMIT",
      );
    }
  }

  record(micros: bigint): void {
    this.spentMicros += micros;
  }

  /** Undo a reservation when the seller rejected the payment (nothing settled). */
  release(micros: bigint): void {
    this.spentMicros -= micros;
    if (this.spentMicros < 0n) this.spentMicros = 0n;
  }

  summary(cfg: SpendConfig) {
    const perSession = parseUsdToMicros(cfg.perSessionMaxUsd);
    return {
      perCallMaxUsd: cfg.perCallMaxUsd,
      perSessionMaxUsd: cfg.perSessionMaxUsd,
      sessionSpentUsd: formatMicros(this.spentMicros),
      sessionRemainingUsd: formatMicros(perSession > this.spentMicros ? perSession - this.spentMicros : 0n),
      allowedHosts: cfg.allowedHosts.length ? cfg.allowedHosts : "all hosts",
      network: cfg.network,
    };
  }
}
