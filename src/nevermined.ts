import { Payments } from "@nevermined-io/payments";
import { parseUsdToMicros } from "./chains.js";
import type { SpendConfig } from "./config.js";
import type { Requirement } from "./x402/parse.js";

/** Header Nevermined reads the access token from (x402 v2 `payment-signature`). */
export const NVM_PAYMENT_HEADER = "payment-signature";

export function neverminedConfigured(): boolean {
  return Boolean(process.env.NVM_API_KEY?.trim());
}

/** "sandbox" / "live" / ... from the NVM_API_KEY prefix. */
export function neverminedEnvironment(): string | undefined {
  const key = process.env.NVM_API_KEY?.trim();
  if (!key) return undefined;
  const i = key.indexOf(":");
  return i > 0 ? key.slice(0, i) : undefined;
}

/**
 * Buyer side of the Nevermined `nvm:erc4337` scheme.
 *
 * Plans must already be purchased on nevermined.app (or be auto-topped-up by
 * a delegation). Each payment mints an x402 access token for the plan in the
 * 402 response, using a delegation:
 *   - NVM_DELEGATION_ID if set (recommended: created and capped by the human), else
 *   - one delegation created on first use and reused for the life of the
 *     process, capped at perSessionMaxUsd for 24 hours, bound to
 *     NVM_PAYMENT_METHOD_ID or else the account's first active erc4337
 *     (crypto wallet) payment method.
 */
export class NeverminedPayer {
  private payments?: Payments;
  private delegationId?: Promise<string>;

  private client(): Payments {
    const nvmApiKey = process.env.NVM_API_KEY?.trim();
    if (!nvmApiKey) throw new Error("NVM_API_KEY is not set");
    this.payments ??= Payments.getInstance({ nvmApiKey });
    return this.payments;
  }

  private delegation(cfg: SpendConfig): Promise<string> {
    const fromEnv = process.env.NVM_DELEGATION_ID?.trim();
    if (fromEnv) return Promise.resolve(fromEnv);
    this.delegationId ??= (async () => {
      const cents = Number(parseUsdToMicros(cfg.perSessionMaxUsd) / 10_000n);
      const client = this.client();
      let methodId = process.env.NVM_PAYMENT_METHOD_ID?.trim();
      if (!methodId) {
        const methods = await client.delegation.listPaymentMethods();
        methodId = methods.find((m) => m.provider === "erc4337" && /active/i.test(String(m.status)))?.id;
      }
      const res = await client.delegation.createDelegation({
        provider: "erc4337",
        currency: "usdc",
        spendingLimitCents: Math.max(cents, 1),
        durationSecs: 24 * 60 * 60,
        ...(methodId ? { providerPaymentMethodId: methodId } : {}),
      });
      process.stderr.write(`[x402-wallet-mcp] created Nevermined delegation ${res.delegationId}\n`);
      return res.delegationId;
    })();
    this.delegationId.catch(() => (this.delegationId = undefined));
    return this.delegationId;
  }

  /** Returns the headers to attach to the retried request. */
  async paymentHeaders(req: Requirement, cfg: SpendConfig): Promise<Record<string, string>> {
    if (!req.planId) throw new Error("Nevermined requirement has no planId");
    const delegationId = await this.delegation(cfg);
    const { accessToken } = await this.client().x402.getX402AccessToken(req.planId, req.agentId, {
      scheme: "nvm:erc4337",
      ...(req.network ? { network: req.network } : {}),
      delegationConfig: { delegationId },
    });
    return { [NVM_PAYMENT_HEADER]: accessToken };
  }
}
