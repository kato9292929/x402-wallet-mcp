import { BASE, BASE_SEPOLIA, CHAINS, SOLANA_DEVNET } from "../src/chains.js";
import { DEFAULT_CONFIG, type SpendConfig } from "../src/config.js";

export const cfg = (over: Partial<SpendConfig> = {}): SpendConfig => ({ ...DEFAULT_CONFIG, ...over });

export const exactReq = (amount: string, network = BASE_SEPOLIA, extra: Record<string, unknown> = {}) => ({
  scheme: "exact",
  network,
  amount,
  asset: CHAINS[network].usdc,
  payTo: "0x000000000000000000000000000000000000dEaD",
  maxTimeoutSeconds: 60,
  extra: { name: "USDC", version: "2", ...extra },
});

export const nvmReq = () => ({
  scheme: "nvm:erc4337",
  network: BASE_SEPOLIA,
  planId: "4474276307",
  extra: { version: "1", agentId: "8091842702" },
});

export const paymentRequired = (accepts: unknown[]) => ({
  x402Version: 2,
  error: "Payment required",
  resource: { url: "https://seller.test/api", description: "test" },
  accepts,
});

export const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");

export function res402(accepts: unknown[]): Response {
  return new Response("{}", {
    status: 402,
    headers: { "payment-required": b64(paymentRequired(accepts)), "content-type": "application/json" },
  });
}

export function res200(body: unknown, receipt?: unknown): Response {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (receipt) headers["payment-response"] = b64(receipt);
  return new Response(JSON.stringify(body), { status: 200, headers });
}

export { BASE, BASE_SEPOLIA, SOLANA_DEVNET };
