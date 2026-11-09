import { PrivyClient } from "@privy-io/node";
import { createX402Client } from "@privy-io/node/x402";
import { x402Client } from "@x402/core/client";
import { BASE, BASE_SEPOLIA, CHAINS, SOLANA, SOLANA_DEVNET } from "../chains.js";
import { onchainUsdcBalance, testnetFundingNotes } from "../balance.js";
import { ProviderConfigError, assertChain, requireEnv } from "./types.js";
export const PRIVY_ENV = ["PRIVY_APP_ID", "PRIVY_APP_SECRET"];
/**
 * Privy server wallet(s).
 *
 * PRIVY_WALLET_ID is an Ethereum wallet (pays on Base / Base Sepolia);
 * PRIVY_SOLANA_WALLET_ID is optional and adds Solana. At least one is needed.
 * If the wallets have an owner (authorization key), set
 * PRIVY_AUTHORIZATION_PRIVATE_KEY so requests can be signed.
 *
 * Signing goes through `createX402Client` from `@privy-io/node/x402`. That
 * helper builds one x402 client per wallet; when both wallets are configured
 * their scheme registrations are combined into a single client.
 */
export class PrivyProvider {
    mode;
    id = "privy";
    privy;
    wallets = new Map();
    combined;
    constructor(mode) {
        this.mode = mode;
    }
    evmWalletId() {
        return process.env.PRIVY_WALLET_ID?.trim() || undefined;
    }
    solWalletId() {
        return process.env.PRIVY_SOLANA_WALLET_ID?.trim() || undefined;
    }
    chains() {
        const out = [];
        if (this.evmWalletId())
            out.push(this.mode === "testnet" ? BASE_SEPOLIA : BASE);
        if (this.solWalletId())
            out.push(this.mode === "testnet" ? SOLANA_DEVNET : SOLANA);
        return out;
    }
    client() {
        const { missing, values } = requireEnv(PRIVY_ENV);
        if (missing.length)
            throw new ProviderConfigError(`Missing environment variables for privy: ${missing.join(", ")}`);
        this.privy ??= new PrivyClient({ appId: values.PRIVY_APP_ID, appSecret: values.PRIVY_APP_SECRET });
        return this.privy;
    }
    wallet(family) {
        let p = this.wallets.get(family);
        if (!p) {
            const id = family === "evm" ? this.evmWalletId() : this.solWalletId();
            if (!id) {
                throw new ProviderConfigError(family === "evm" ? "PRIVY_WALLET_ID is not set" : "PRIVY_SOLANA_WALLET_ID is not set");
            }
            p = this.client()
                .wallets()
                .get(id)
                .then((w) => {
                const expected = family === "evm" ? "ethereum" : "solana";
                if (w.chain_type !== expected) {
                    throw new ProviderConfigError(`Privy wallet ${id} is a ${w.chain_type} wallet, expected ${expected}`);
                }
                return { id: w.id, address: w.address };
            });
            p.catch(() => this.wallets.delete(family));
            this.wallets.set(family, p);
        }
        return p;
    }
    async address(chain) {
        assertChain(this, chain);
        return (await this.wallet(CHAINS[chain].family)).address;
    }
    async usdcBalance(chain) {
        return onchainUsdcBalance(chain, await this.address(chain));
    }
    async fundingInfo(chain) {
        const address = await this.address(chain);
        const notes = testnetFundingNotes(chain);
        if (!CHAINS[chain].testnet)
            notes.push(`Send USDC on ${CHAINS[chain].name} to the address above.`);
        return { address, notes };
    }
    async ready() {
        const { missing } = requireEnv(PRIVY_ENV);
        if (missing.length)
            return { ok: false, reason: `Missing environment variables: ${missing.join(", ")}` };
        if (!this.evmWalletId() && !this.solWalletId()) {
            return { ok: false, reason: "Set PRIVY_WALLET_ID (Ethereum wallet) and/or PRIVY_SOLANA_WALLET_ID" };
        }
        try {
            if (this.evmWalletId())
                await this.wallet("evm");
            if (this.solWalletId())
                await this.wallet("solana");
            return { ok: true };
        }
        catch (err) {
            return { ok: false, reason: `Could not load the Privy wallet: ${err.message}` };
        }
    }
    authorizationContext() {
        const key = process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY?.trim();
        return key ? { authorization_private_keys: [key] } : undefined;
    }
    x402Client() {
        this.combined ??= (async () => {
            const authorizationContext = this.authorizationContext();
            const signatureOptions = process.env.PRIVY_SIGNATURE_TYPE === "erc1271" ? { type: "erc1271" } : undefined;
            const parts = [];
            for (const family of ["evm", "solana"]) {
                if ((family === "evm" ? this.evmWalletId() : this.solWalletId()) === undefined)
                    continue;
                const w = await this.wallet(family);
                parts.push(createX402Client(this.client(), {
                    walletId: w.id,
                    address: w.address,
                    // Limits are enforced by this server (config.json), not by the SDK.
                    spendControls: false,
                    ...(authorizationContext ? { authorizationContext } : {}),
                    ...(signatureOptions && family === "evm" ? { signatureOptions } : {}),
                }));
            }
            if (parts.length === 1)
                return parts[0];
            // Two wallets: route each payment to the client that has a scheme for its network.
            return combineClients(parts);
        })();
        this.combined.catch(() => (this.combined = undefined));
        return this.combined;
    }
}
/** Minimal x402Client facade that tries each underlying client in turn. */
function combineClients(parts) {
    const facade = new x402Client();
    facade.createPaymentPayload = async (paymentRequired) => {
        let lastErr;
        for (const c of parts) {
            try {
                return await c.createPaymentPayload(paymentRequired);
            }
            catch (err) {
                lastErr = err;
            }
        }
        throw lastErr;
    };
    return facade;
}
