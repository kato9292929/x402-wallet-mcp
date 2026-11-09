/**
 * Local Nevermined *sandbox* seller used to test the `nvm:erc4337` scheme.
 *
 * Needs the Nevermined SDK, which is not a dependency of this package:
 *   npm i --no-save @nevermined-io/payments@1.13.0 express@4.21.2
 *
 *   NVM_API_KEY_SELLER=sandbox:... npx tsx scripts/nvm-sandbox-seller.ts register
 *   NVM_API_KEY_SELLER=sandbox:... npx tsx scripts/nvm-sandbox-seller.ts serve
 *
 * `register` creates one crypto plan (0.01 USDC on Base Sepolia for 10 credits,
 * 1 credit per request) and one agent whose endpoint is the local server, and
 * saves the ids to $X402_WALLET_MCP_HOME/nvm-sandbox-seller.json.
 * `serve` runs GET /ask on PORT (default 4021) behind Nevermined's
 * paymentMiddleware, so a 402 with `nvm:erc4337` comes back until paid.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import express from "express";
import { Payments } from "@nevermined-io/payments";
import { paymentMiddleware } from "@nevermined-io/payments/express";
import { CHAINS, BASE_SEPOLIA } from "../src/chains.js";
import { configDir } from "../src/config.js";

const PORT = Number(process.env.PORT ?? 4021);
const stateFile = path.join(configDir(), "nvm-sandbox-seller.json");

function payments(): Payments {
  const key = process.env.NVM_API_KEY_SELLER?.trim();
  if (!key?.startsWith("sandbox:")) throw new Error("NVM_API_KEY_SELLER must be a sandbox: key");
  return Payments.getInstance({ nvmApiKey: key });
}

async function register() {
  const p = payments();
  const receiver = p.getAccountAddress();
  if (!receiver) throw new Error("Could not resolve the seller account address from the API key");
  const { agentId, planId, txHash } = await p.agents.registerAgentAndPlan(
    { name: "x402-wallet-mcp sandbox test seller", description: "Test endpoint for x402-wallet-mcp", tags: ["test"] },
    { endpoints: [{ GET: `http://localhost:${PORT}/ask` }] },
    { name: "x402-wallet-mcp sandbox test plan", description: "0.01 USDC for 10 credits (Base Sepolia)" },
    p.plans.getERC20PriceConfig(10_000n, CHAINS[BASE_SEPOLIA].usdc as `0x${string}`, receiver as `0x${string}`),
    p.plans.getFixedCreditsConfig(10n, 1n),
  );
  const state = { agentId, planId, txHash, receiver, endpoint: `http://localhost:${PORT}/ask` };
  await fs.mkdir(configDir(), { recursive: true });
  await fs.writeFile(stateFile, JSON.stringify(state, null, 2));
  console.log(JSON.stringify(state, null, 2));
}

async function serve() {
  const state = JSON.parse(await fs.readFile(stateFile, "utf8")) as { agentId: string; planId: string };
  const app = express();
  app.use(paymentMiddleware(payments(), { "GET /ask": { planId: state.planId, agentId: state.agentId, credits: 1 } }));
  app.get("/ask", (_req, res) => {
    res.json({ answer: "paid with Nevermined credits", time: new Date().toISOString() });
  });
  app.listen(PORT, () => console.log(`sandbox seller on http://localhost:${PORT}/ask (plan ${state.planId})`));
}

const cmd = process.argv[2];
(cmd === "register" ? register() : cmd === "serve" ? serve() : Promise.reject(new Error("usage: register | serve"))).catch(
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
