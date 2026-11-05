/**
 * Integration test: one real payment with the provider selected by
 * WALLET_PROVIDER, on testnet only.
 *
 *   WALLET_PROVIDER=cdp CDP_API_KEY_ID=... npm run test:integration -- [url] [method] [jsonBody]
 *
 * Default URL is a $0.001 Base Sepolia endpoint from the Bazaar. The settle
 * receipt (transaction hash) is printed and appended to
 * ~/.x402-wallet-mcp/payments.jsonl.
 */
import { loadConfig } from "../src/config.js";
import { SpendGuard } from "../src/limits.js";
import { NeverminedPayer } from "../src/nevermined.js";
import { providerFromEnv } from "../src/providers/index.js";
import { X402Requester } from "../src/x402/request.js";

const DEFAULT_URL = "https://wallets-demo-seller-server.calebgcarithers.workers.dev/weather?location=Tokyo";

async function main() {
  const [url = DEFAULT_URL, method = "GET", body] = process.argv.slice(2);
  const cfg = await loadConfig();
  if (cfg.network !== "testnet") throw new Error('Refusing to run: config.json network must be "testnet" for integration tests.');

  const provider = await providerFromEnv(cfg.network);
  const label = provider?.id ?? "nevermined-only";
  console.log(`# provider=${label} network=${cfg.network}`);

  if (provider) {
    const ready = await provider.ready();
    console.log("ready:", ready);
    if (!ready.ok) process.exit(1);
    for (const chain of provider.chains()) {
      const address = await provider.address(chain);
      const usdc = await provider.usdcBalance(chain).catch((e: Error) => `error: ${e.message}`);
      console.log(`${chain} ${address} USDC=${usdc}`);
    }
  }

  const requester = new X402Requester({ provider, guard: new SpendGuard(), nevermined: new NeverminedPayer() });
  console.log("\n# check_payment_requirements");
  const check = await requester.checkRequirements({ url, method, body: body ? JSON.parse(body) : undefined });
  console.log(JSON.stringify((check as { wouldPay?: unknown }).wouldPay ?? check, null, 2));

  console.log("\n# make_x402_request");
  const res = await requester.request({ url, method, body: body ? JSON.parse(body) : undefined });
  const payment = (res as { payment?: { transaction?: string; explorerUrl?: string; settled?: boolean } }).payment;
  console.log(`status=${res.status} paid=${res.paid} settled=${payment?.settled}`);
  console.log(`transaction=${payment?.transaction ?? "(none)"}`);
  if (payment?.explorerUrl) console.log(`explorer=${payment.explorerUrl}`);
  console.log(`body=${String((res as { body?: string }).body).slice(0, 300)}`);
}

main().catch((err) => {
  console.error("FAILED:", err.message, err.details ? JSON.stringify(err.details, null, 2) : "");
  process.exit(1);
});
