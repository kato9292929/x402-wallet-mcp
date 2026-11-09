import { CrossmintWallets, EVMWallet, createCrossmint } from "@crossmint/wallets-sdk";
import { BASE, BASE_SEPOLIA, CHAINS } from "../chains.js";
import { onchainUsdcBalance, testnetFundingNotes } from "../balance.js";
import { ProviderConfigError, assertChain, requireEnv, } from "./types.js";
export const CROSSMINT_ENV = ["CROSSMINT_SERVER_API_KEY", "CROSSMINT_SIGNER_SECRET", "CROSSMINT_WALLET_ADDRESS"];
/** Server-side key; CROSSMINT_API_KEY is accepted as an alias. */
export function crossmintApiKey() {
    return process.env.CROSSMINT_SERVER_API_KEY?.trim() || process.env.CROSSMINT_API_KEY?.trim() || undefined;
}
function crossmintEnv() {
    const { missing, values } = requireEnv(["CROSSMINT_SIGNER_SECRET", "CROSSMINT_WALLET_ADDRESS"]);
    const apiKey = crossmintApiKey();
    if (apiKey)
        values.CROSSMINT_API_KEY = apiKey;
    else
        missing.unshift("CROSSMINT_SERVER_API_KEY");
    return { missing, values };
}
/**
 * Crossmint smart wallet (EVM only).
 *
 * The agent is a "server" signer on the wallet (CROSSMINT_SIGNER_SECRET);
 * x402's `ExactEvmScheme` asks this provider to `signTypedData`, which is
 * delegated to the Crossmint wallet. Use a staging server key
 * (sk_staging_...) with network="testnet" (Base Sepolia) and a production key
 * with network="mainnet" (Base).
 */
export class CrossmintProvider {
    mode;
    id = "crossmint";
    walletPromise;
    constructor(mode) {
        this.mode = mode;
    }
    chains() {
        return [this.mode === "testnet" ? BASE_SEPOLIA : BASE];
    }
    crossmintChain() {
        return this.mode === "testnet" ? "base-sepolia" : "base";
    }
    isStagingKey() {
        return (crossmintApiKey() ?? "").startsWith("sk_staging");
    }
    /** Loads the wallet and attaches the agent's server signer. */
    wallet() {
        if (!this.walletPromise) {
            const { missing, values } = crossmintEnv();
            if (missing.length) {
                throw new ProviderConfigError(`Missing environment variables for crossmint: ${missing.join(", ")}`);
            }
            this.walletPromise = (async () => {
                const crossmint = createCrossmint({ apiKey: values.CROSSMINT_API_KEY });
                const wallets = CrossmintWallets.from(crossmint);
                const wallet = await wallets.getWallet(values.CROSSMINT_WALLET_ADDRESS, { chain: this.crossmintChain() });
                await wallet.useSigner({ type: "server", secret: values.CROSSMINT_SIGNER_SECRET });
                return EVMWallet.from(wallet);
            })();
            this.walletPromise.catch(() => (this.walletPromise = undefined));
        }
        return this.walletPromise;
    }
    async address(chain) {
        assertChain(this, chain);
        const configured = process.env.CROSSMINT_WALLET_ADDRESS?.trim();
        if (configured)
            return configured;
        return (await this.wallet()).address;
    }
    async usdcBalance(chain) {
        return onchainUsdcBalance(chain, await this.address(chain));
    }
    async otherBalances(chain) {
        assertChain(this, chain);
        const w = await this.wallet();
        const b = await w.balances(this.isStagingKey() ? ["usdxm"] : []);
        const out = [{ symbol: b.nativeToken.symbol.toUpperCase(), amount: b.nativeToken.amount }];
        for (const t of b.tokens)
            out.push({ symbol: t.symbol.toUpperCase(), amount: t.amount });
        return out;
    }
    async fundingInfo(chain) {
        const address = await this.address(chain);
        const notes = testnetFundingNotes(chain);
        if (this.isStagingKey()) {
            notes.push("Crossmint staging: the wallet owner can mint test USDXM with `npx x402-wallet-mcp crossmint-staging-fund 5` " +
                "(only useful for sellers that accept USDXM; most x402 sellers on Base Sepolia want USDC).");
        }
        else if (!CHAINS[chain].testnet) {
            notes.push("Fund with USDC on Base, e.g. via Crossmint onramp: https://docs.crossmint.com/agents/payment-methods/stablecoin-wallets/onramp-add-funds");
        }
        return { address, notes };
    }
    async ready() {
        const { missing } = crossmintEnv();
        if (missing.length)
            return { ok: false, reason: `Missing environment variables: ${missing.join(", ")}` };
        if (this.mode === "testnet" && !this.isStagingKey()) {
            return { ok: false, reason: 'network="testnet" needs a staging server key (sk_staging_...)' };
        }
        if (this.mode === "mainnet" && this.isStagingKey()) {
            return { ok: false, reason: 'network="mainnet" needs a production server key, not sk_staging_...' };
        }
        try {
            await this.wallet();
            return { ok: true };
        }
        catch (err) {
            return { ok: false, reason: `Could not load the Crossmint wallet / signer: ${err.message}` };
        }
    }
    async evmSigner() {
        const wallet = await this.wallet();
        const chain = this.crossmintChain();
        return {
            address: wallet.address,
            async signTypedData(typedData) {
                const { signature } = await wallet.signTypedData({
                    ...typedData,
                    chain,
                });
                return signature;
            },
        };
    }
    async stagingFund(amount) {
        if (!this.isStagingKey())
            throw new Error("stagingFund only works with a staging key (sk_staging_...)");
        const w = await this.wallet();
        return w.stagingFund(amount);
    }
}
