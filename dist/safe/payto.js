/**
 * Whether a Solana payTo can receive the token: the x402 exact SVM payment transfers to payTo's
 * associated token account (ATA), which must already exist, or the transfer fails (Phantom shows it
 * as a failed simulation). The ATA is derived with the token program that owns the mint
 * (Token or Token-2022).
 */
import { address, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import { rpcCall } from "./rpc.js";
/** One try per RPC with a short timeout: this runs before every Solana payment link. */
const quickRpc = (network, method, params) => rpcCall(network, method, params, { attempts: 1, timeoutMs: 8000 });
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export async function ataOf(owner, mint, tokenProgram) {
    const enc = getAddressEncoder();
    const [pda] = await getProgramDerivedAddress({
        programAddress: address(ATA_PROGRAM),
        seeds: [enc.encode(address(owner)), enc.encode(address(tokenProgram)), enc.encode(address(mint))],
    });
    return pda;
}
export async function checkPayToAccount(network, payTo, mint, rpc = quickRpc) {
    try {
        const m = await rpc(network, "getAccountInfo", [mint, { encoding: "base64" }]);
        const owner = m.result?.value?.owner;
        if (owner !== TOKEN_PROGRAM && owner !== TOKEN_2022_PROGRAM) {
            return { exists: null, error: owner ? `the asset is owned by ${owner}, not a token program` : "the asset (mint) was not found", rpc: m.rpc };
        }
        const ata = await ataOf(payTo, mint, owner);
        const a = await rpc(network, "getAccountInfo", [ata, { encoding: "base64" }]);
        return { exists: a.result?.value != null, ata, tokenProgram: owner, rpc: a.rpc };
    }
    catch (err) {
        return { exists: null, error: err.message.slice(0, 300) };
    }
}
