/**
 * Whether a Solana payTo can receive the token: the x402 exact SVM payment transfers to payTo's
 * associated token account (ATA), which must already exist, or the transfer fails (Phantom shows it
 * as a failed simulation). The ATA is derived with the token program that owns the mint
 * (Token or Token-2022).
 */
import { address, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import { rpcCall, type RpcCall } from "./rpc.js";

/** One try per RPC with a short timeout: this runs before every Solana payment link. */
const quickRpc: RpcCall = (network, method, params) => rpcCall(network, method, params, { attempts: 1, timeoutMs: 8000 });

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

export async function ataOf(owner: string, mint: string, tokenProgram: string): Promise<string> {
  const enc = getAddressEncoder();
  const [pda] = await getProgramDerivedAddress({
    programAddress: address(ATA_PROGRAM),
    seeds: [enc.encode(address(owner)), enc.encode(address(tokenProgram)), enc.encode(address(mint))],
  });
  return pda;
}

export interface PayToAccount {
  /** true: the receiving account exists; false: it does not; null: could not tell (RPC failed or unexpected data). */
  exists: boolean | null;
  ata?: string;
  tokenProgram?: string;
  rpc?: string;
  error?: string;
}

export type PayToCheck = (network: string, payTo: string, mint: string) => Promise<PayToAccount>;

export async function checkPayToAccount(network: string, payTo: string, mint: string, rpc: RpcCall = quickRpc): Promise<PayToAccount> {
  try {
    const m = await rpc<{ value: { owner: string } | null }>(network, "getAccountInfo", [mint, { encoding: "base64" }]);
    const owner = m.result?.value?.owner;
    if (owner !== TOKEN_PROGRAM && owner !== TOKEN_2022_PROGRAM) {
      return { exists: null, error: owner ? `the asset is owned by ${owner}, not a token program` : "the asset (mint) was not found", rpc: m.rpc };
    }
    const ata = await ataOf(payTo, mint, owner);
    const a = await rpc<{ value: unknown | null }>(network, "getAccountInfo", [ata, { encoding: "base64" }]);
    return { exists: a.result?.value != null, ata, tokenProgram: owner, rpc: a.rpc };
  } catch (err) {
    return { exists: null, error: (err as Error).message.slice(0, 300) };
  }
}
