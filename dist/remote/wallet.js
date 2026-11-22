import { onchainUsdcBalance, testnetFundingNotes } from "../balance.js";
import { BASE, BASE_SEPOLIA, CHAINS, SOLANA, SOLANA_DEVNET } from "../chains.js";
import { assertChain } from "../providers/types.js";
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
    chains() {
        const out = [];
        if (this.p.base)
            out.push(this.p.network === "testnet" ? BASE_SEPOLIA : BASE);
        if (this.p.solana)
            out.push(this.p.network === "testnet" ? SOLANA_DEVNET : SOLANA);
        return out;
    }
    async address(chain) {
        assertChain(this, chain);
        return CHAINS[chain].family === "solana" ? this.p.solana : this.p.base;
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
