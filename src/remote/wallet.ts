import { onchainUsdcBalance, testnetFundingNotes } from "../balance.js";
import { BASE, BASE_SEPOLIA, CHAINS, SOLANA, SOLANA_DEVNET } from "../chains.js";
import { assertChain, type FundingInfo, type WalletProvider } from "../providers/types.js";
import type { RemoteParams } from "./params.js";

/**
 * The owner's own wallets, known only by their public addresses from the connection URL.
 * It cannot sign: every payment is signed by the owner in their browser wallet on the approval page.
 */
export class AddressWallet implements WalletProvider {
  readonly id = "browser" as const;

  constructor(private readonly p: RemoteParams) {}

  chains(): string[] {
    const out: string[] = [];
    if (this.p.base) out.push(this.p.network === "testnet" ? BASE_SEPOLIA : BASE);
    if (this.p.solana) out.push(this.p.network === "testnet" ? SOLANA_DEVNET : SOLANA);
    return out;
  }

  async address(chain: string): Promise<string> {
    assertChain(this, chain);
    return CHAINS[chain].family === "solana" ? this.p.solana! : this.p.base!;
  }

  async usdcBalance(chain: string): Promise<string> {
    return onchainUsdcBalance(chain, await this.address(chain));
  }

  async fundingInfo(chain: string): Promise<FundingInfo> {
    return { address: await this.address(chain), notes: testnetFundingNotes(chain) };
  }

  async ready(): Promise<{ ok: boolean; reason?: string }> {
    return { ok: true };
  }
}
