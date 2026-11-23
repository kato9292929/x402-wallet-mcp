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
    /** With no address in the URL, payments are on Solana and the wallet is chosen on the approval page. */
    chains() {
        const out = [];
        if (this.p.base)
            out.push(this.p.network === "testnet" ? BASE_SEPOLIA : BASE);
        if (this.p.solana || !this.p.base)
            out.push(this.p.network === "testnet" ? SOLANA_DEVNET : SOLANA);
        return out;
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
