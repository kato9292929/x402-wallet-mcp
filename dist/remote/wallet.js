import { onchainUsdcBalance, testnetFundingNotes } from "../balance.js";
import { BASE, BASE_SEPOLIA, CHAINS, SOLANA, SOLANA_DEVNET } from "../chains.js";
import { ProviderConfigError, assertChain } from "../providers/types.js";
/**
 * The owner's own wallets, known only by their public addresses from the connection URL.
 * It cannot sign: every payment is signed by the owner in their browser wallet on the approval page.
 */
export class AddressWallet {
    p;
    id = "browser";
    constructor(p) {
        this.p = p;
    }
    /**
     * Base and Solana for the network mode, with or without addresses in the URL: for a chain with no
     * address, the user connects the wallet on the approval page (Phantom for Solana, Rabby / MetaMask for Base).
     */
    chains() {
        return this.p.network === "testnet" ? [SOLANA_DEVNET, BASE_SEPOLIA] : [SOLANA, BASE];
    }
    /**
     * Order of preference when a seller takes several chains at the same price: chains whose address is
     * in the URL first, then Solana before Base.
     */
    preferredChains() {
        const all = this.chains();
        return [...all.filter((c) => this.knows(c)), ...all.filter((c) => !this.knows(c))];
    }
    /** Whether the connection URL fixes the paying address for this chain. */
    knows(chain) {
        return CHAINS[chain]?.family === "solana" ? !!this.p.solana : !!this.p.base;
    }
    async address(chain) {
        assertChain(this, chain);
        const a = CHAINS[chain].family === "solana" ? this.p.solana : this.p.base;
        if (!a) {
            throw new ProviderConfigError("This connection has no wallet address: the user picks the wallet on the approval page when paying. " +
                "To read a balance, ask the user for their wallet address and use it with get_wallet_balance's address argument.");
        }
        return a;
    }
    async usdcBalance(chain) {
        return onchainUsdcBalance(chain, await this.address(chain));
    }
    async fundingInfo(chain) {
        return { address: await this.address(chain), notes: testnetFundingNotes(chain) };
    }
    async ready() {
        return { ok: true };
    }
}
