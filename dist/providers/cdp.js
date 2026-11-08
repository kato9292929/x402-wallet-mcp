import { CdpX402Client } from "@coinbase/cdp-sdk/x402";
import { BASE, BASE_SEPOLIA, CHAINS, SOLANA, SOLANA_DEVNET } from "../chains.js";
import { onchainUsdcBalance, testnetFundingNotes } from "../balance.js";
import { ProviderConfigError, assertChain, requireEnv } from "./types.js";
export const CDP_ENV = ["CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "CDP_WALLET_SECRET"];
/**
 * Coinbase Developer Platform server wallet.
 *
 * Signs through the CDP SDK's `CdpX402Client`, which provisions an EVM and a
 * Solana account (named CDP_ACCOUNT_NAME, default "x402-wallet-mcp") on first
 * use and registers the `exact` scheme on Base / Solana.
 */
export class CdpProvider {
    mode;
    id = "cdp";
    client;
    constructor(mode) {
        this.mode = mode;
    }
    chains() {
        return this.mode === "testnet" ? [BASE_SEPOLIA, SOLANA_DEVNET] : [BASE, SOLANA];
    }
    getClient() {
        const { missing, values } = requireEnv(CDP_ENV);
        if (missing.length)
            throw new ProviderConfigError(`Missing environment variables for cdp: ${missing.join(", ")}`);
        if (!this.client) {
            const testnet = this.mode === "testnet";
            this.client = new CdpX402Client({
                apiKeyId: values.CDP_API_KEY_ID,
                apiKeySecret: values.CDP_API_KEY_SECRET,
                walletSecret: values.CDP_WALLET_SECRET,
                environment: testnet ? "development" : "production",
                walletConfig: { type: "eoa", accountName: process.env.CDP_ACCOUNT_NAME?.trim() || "x402-wallet-mcp" },
                networkSchemes: [
                    { network: testnet ? "base-sepolia" : "base", scheme: { exact: true } },
                    { network: testnet ? "solana-devnet" : "solana", scheme: { exact: true } },
                ],
            });
        }
        return this.client;
    }
    async address(chain) {
        assertChain(this, chain);
        const addrs = await this.getClient().getAddresses();
        return CHAINS[chain].family === "solana" ? addrs.svmAddress : addrs.evmAddress;
    }
    async usdcBalance(chain) {
        return onchainUsdcBalance(chain, await this.address(chain));
    }
    async fundingInfo(chain) {
        const address = await this.address(chain);
        const notes = testnetFundingNotes(chain);
        if (!CHAINS[chain].testnet) {
            notes.push(`Send USDC on ${CHAINS[chain].name} to the address above (e.g. from a Coinbase account).`);
        }
        return { address, notes };
    }
    async ready() {
        const { missing } = requireEnv(CDP_ENV);
        if (missing.length)
            return { ok: false, reason: `Missing environment variables: ${missing.join(", ")}` };
        try {
            await this.getClient().getAddresses();
            return { ok: true };
        }
        catch (err) {
            return { ok: false, reason: `CDP credentials were rejected or the API is unreachable: ${err.message}` };
        }
    }
    async x402Client() {
        // CdpX402Client extends x402Client; the cast only bridges the CJS/ESM type declarations.
        return this.getClient();
    }
}
