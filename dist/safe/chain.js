/**
 * Finding our own payment on chain after a paid request, independent of the seller's
 * settlement header.
 *
 *   Base (exact EVM, EIP-3009): the payer never sends a tx; the facilitator does. The payer's
 *   key is the authorization nonce, consumed on chain by USDC's AuthorizationUsed(authorizer,
 *   nonce) event. The tx carrying that event must also Transfer `amount` USDC payer -> payTo.
 *   Solana (exact SVM): the tx id is the facilitator's (fee payer's) signature; our own
 *   signature sits among the tx's signatures, and the token balances must move `amount`.
 *
 * Ported from kato9292929/seller-probe src/chains/base.ts and src/chains/solana.ts (8bc93ed)
 * and kato9292929/RFQ agents/buyer/src/index.ts findLanded (0943124). Reads only.
 */
import bs58 from "bs58";
import { getBase64Encoder, getTransactionDecoder } from "@solana/kit";
import { chainInfo } from "../chains.js";
import { RpcUnavailable, defaultRpc } from "./rpc.js";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const AUTHORIZATION_USED = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";
const topicAddr = (a) => "0x" + a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
/** Reads the payer key from a signed exact-scheme payment payload. */
export function payerKeyOf(payload, req, payerAddress) {
    const family = chainInfo(req.network)?.family;
    if (!family)
        throw new Error(`unsupported network ${req.network}`);
    const base = {
        network: req.network,
        family,
        payTo: String(req.payTo ?? ""),
        asset: String(req.asset ?? ""),
        amount: BigInt(req.amount ?? "0"),
    };
    if (family === "evm") {
        const auth = payload?.payload?.authorization;
        if (!auth?.nonce)
            throw new Error("EVM payload is not an EIP-3009 authorization");
        return { ...base, payer: String(auth.from ?? payerAddress), key: String(auth.nonce).toLowerCase() };
    }
    const b64 = payload?.payload?.transaction;
    if (typeof b64 !== "string")
        throw new Error("SVM payload has no payload.transaction");
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(b64));
    const sig = tx.signatures[payerAddress];
    if (!sig || sig.every((b) => b === 0))
        throw new Error("payer signature missing in payment tx");
    return { ...base, payer: payerAddress, key: bs58.encode(sig) };
}
/** Pure: does an EVM receipt contain a USDC Transfer of exactly `amount` payer -> payTo? */
export function checkBaseTransfer(receipt, k) {
    if (!receipt)
        return { ok: false, reason: "receipt not found" };
    if (receipt.status !== "0x1")
        return { ok: false, reason: "transaction reverted" };
    const hit = (receipt.logs ?? []).find((l) => l.address?.toLowerCase() === k.asset.toLowerCase() &&
        l.topics?.[0] === TRANSFER &&
        l.topics?.[1]?.toLowerCase() === topicAddr(k.payer) &&
        l.topics?.[2]?.toLowerCase() === topicAddr(k.payTo));
    if (!hit)
        return { ok: false, reason: "no USDC Transfer payer->payTo in receipt" };
    const transferred = BigInt(hit.data);
    if (transferred !== k.amount)
        return { ok: false, reason: `USDC Transfer value ${transferred} != ${k.amount}`, transferred };
    return { ok: true, reason: "USDC transfer matches 402", transferred };
}
/** Pure: does a jsonParsed Solana tx move exactly `amount` of `asset` payer -> payTo? */
export function checkSolanaTransfer(tx, k) {
    if (!tx)
        return { ok: false, reason: "transaction not found" };
    if (tx.meta?.err)
        return { ok: false, reason: `transaction failed: ${JSON.stringify(tx.meta.err)}` };
    const delta = (owner) => {
        const amt = (list) => BigInt(list?.find((b) => b.mint === k.asset && b.owner === owner)?.uiTokenAmount?.amount ?? "0");
        return amt(tx.meta?.postTokenBalances) - amt(tx.meta?.preTokenBalances);
    };
    const toPayTo = delta(k.payTo);
    const transferred = -delta(k.payer);
    if (toPayTo !== k.amount)
        return { ok: false, reason: `payTo USDC delta ${toPayTo} != ${k.amount}`, transferred };
    if (transferred !== k.amount)
        return { ok: false, reason: `payer USDC delta -${transferred} != -${k.amount}`, transferred };
    return { ok: true, reason: "USDC transfer matches 402", transferred };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function findBase(k, headerTx, o) {
    let lastRpc;
    let unknownErrors = null;
    for (let i = 0; i < o.attempts; i++) {
        try {
            const head = await o.rpc(k.network, "eth_blockNumber", []);
            lastRpc = head.rpc;
            const latest = parseInt(head.result, 16);
            const from = Math.max(0, latest - o.blockWindow);
            const logs = await o.rpc(k.network, "eth_getLogs", [
                {
                    address: k.asset,
                    fromBlock: "0x" + from.toString(16),
                    toBlock: "0x" + latest.toString(16),
                    topics: [AUTHORIZATION_USED, topicAddr(k.payer), k.key],
                },
            ]);
            unknownErrors = null;
            if (logs.result?.length) {
                const hash = logs.result[0].transactionHash;
                const receipt = await o.rpc(k.network, "eth_getTransactionReceipt", [hash]);
                const check = checkBaseTransfer(receipt.result, k);
                const headerTxMatched = headerTx ? headerTx.toLowerCase() === hash.toLowerCase() : null;
                return {
                    // Our authorization was used, so money moved; a wrong amount is reported in `mismatch`.
                    settlement: "verified",
                    tx: hash,
                    transferred: check.transferred ?? null,
                    mismatch: check.ok ? undefined : check.reason,
                    headerTxMatched,
                    rpc: receipt.rpc,
                };
            }
        }
        catch (e) {
            if (!(e instanceof RpcUnavailable))
                throw e;
            unknownErrors = e.errors;
        }
        if (i < o.attempts - 1)
            await sleep(o.intervalMs);
    }
    if (unknownErrors)
        return { settlement: "unknown", tx: null, transferred: null, headerTxMatched: null, errors: unknownErrors.slice(-4) };
    return { settlement: "not_found", tx: null, transferred: null, headerTxMatched: headerTx ? false : null, rpc: lastRpc };
}
async function solanaTx(k, sig, rpc) {
    const r = await rpc(k.network, "getTransaction", [
        sig,
        { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
    ]);
    return { tx: r.result, rpc: r.rpc };
}
async function findSolana(k, headerTx, o) {
    const seen = new Set();
    let lastRpc;
    let unknownErrors = null;
    const result = (sig, tx, rpc) => {
        const check = checkSolanaTransfer(tx, k);
        return {
            settlement: "verified",
            tx: sig,
            transferred: check.transferred ?? null,
            mismatch: check.ok ? undefined : check.reason,
            headerTxMatched: headerTx ? headerTx === sig : null,
            rpc,
        };
    };
    for (let i = 0; i < o.attempts; i++) {
        try {
            // The header's tx first: cheapest way to confirm it is ours.
            if (headerTx && !seen.has(headerTx)) {
                const { tx, rpc } = await solanaTx(k, headerTx, o.rpc);
                lastRpc = rpc;
                if (tx) {
                    seen.add(headerTx);
                    if (tx.transaction?.signatures?.includes(k.key) && !tx.meta?.err)
                        return result(headerTx, tx, rpc);
                }
            }
            const sigs = await o.rpc(k.network, "getSignaturesForAddress", [k.payer, { limit: 20, commitment: "confirmed" }]);
            lastRpc = sigs.rpc;
            unknownErrors = null;
            for (const s of sigs.result ?? []) {
                if (seen.has(s.signature))
                    continue;
                seen.add(s.signature);
                const { tx, rpc } = await solanaTx(k, s.signature, o.rpc);
                if (tx?.transaction?.signatures?.includes(k.key) && !tx.meta?.err)
                    return result(s.signature, tx, rpc);
            }
        }
        catch (e) {
            if (!(e instanceof RpcUnavailable))
                throw e;
            unknownErrors = e.errors;
        }
        if (i < o.attempts - 1)
            await sleep(o.intervalMs);
    }
    if (unknownErrors)
        return { settlement: "unknown", tx: null, transferred: null, headerTxMatched: null, errors: unknownErrors.slice(-4) };
    return { settlement: "not_found", tx: null, transferred: null, headerTxMatched: headerTx ? false : null, rpc: lastRpc };
}
/**
 * Looks for our own payment on chain. The settlement header's tx (if any) is only a hint:
 * the result is decided by what the chain holds for our payer key.
 */
export async function findPayment(k, headerTx, opts = {}) {
    const o = {
        rpc: opts.rpc ?? defaultRpc,
        attempts: opts.attempts ?? 12,
        intervalMs: opts.intervalMs ?? 5000,
        blockWindow: opts.blockWindow ?? 1800,
    };
    return k.family === "evm" ? findBase(k, headerTx, o) : findSolana(k, headerTx, o);
}
