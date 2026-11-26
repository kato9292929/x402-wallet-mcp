/**
 * Plain-English explanations for blocked and refused payments, for Claude to pass on to the user:
 * what happened, which side the problem is on, and what can be done next (only what is known).
 */

const SIGNER_NOTE =
  "a signer that does not rewrite the transaction (the x402 SDK in a terminal, or a server-side wallet) can pay it";

export function facilitatorIncompatibleDetail(avoided: { feePayer: string; network: string; why: string }[]): string {
  const list = avoided.map((a) => `${a.feePayer} (${a.why})`).join("; ");
  return (
    `This seller's Solana payment goes through a facilitator that refuses transactions signed in Phantom: ${list}. ` +
    "When signing, Phantom adds safety-check (Lighthouse) instructions, one of which reads the facilitator's fee-payer account, and this facilitator rejects that. " +
    "Problem side: the facilitator's compatibility with the wallet, not the seller's API. Nothing was prepared or paid. " +
    "Next: the seller offers no other option this connection can pay, so use a similar API whose facilitator accepts Phantom (PayAI's does), " +
    `or ${SIGNER_NOTE}. To try anyway, call request_x402_payment again with allow_incompatible_facilitator: true.`
  );
}

export function payToAccountMissingDetail(o: { payTo: string; ata?: string; asset?: string; network: string }): string {
  return (
    `The seller's receiving address on ${o.network} (${o.payTo}) has no token account for this asset${o.asset ? ` (${o.asset})` : ""}` +
    `${o.ata ? `: its associated token account ${o.ata} does not exist` : ""}, so the transfer would fail. Phantom shows this as a failed simulation. ` +
    "Problem side: the seller's setup (it has not set up receiving this token). Nothing was paid. " +
    "Next: pay on another network if the seller offers one, use a similar API, or tell the seller."
  );
}

export function offerChangedDetail(changes: { field: string; before: string; after: string }[]): string {
  const list = changes.map((c) => `${c.field} ${c.before} → ${c.after}`).join(", ");
  return (
    `The seller's payment terms changed between the approval link and signing (${list}), so AgentPay stopped before the wallet signed. ` +
    "Problem side: the seller (its 402 changed); AgentPay's check stopped it. Nothing was paid. " +
    "Next: ask for a new approval link; if the terms keep changing, the seller's 402 is not stable enough to pay."
  );
}

export function networkAvoidedDetail(networks: string[]): string {
  return (
    `This seller said recently that it does not accept payments on ${networks.join(", ")}, and it offers nothing else this connection can pay. ` +
    "Problem side: the seller's accepted networks. Nothing was paid. Next: try again after 24 hours, or use a similar API."
  );
}

/** A refused payment (rejected_by_seller): why, whose side, next step. */
export function refusalDetail(o: {
  reason: string;
  httpStatus: number;
  settlement: string;
  network: string;
  feePayer?: string;
  learned?: boolean;
}): string {
  const r = o.reason;
  const nothingPaid =
    o.settlement === "not_checked"
      ? "Nothing was paid: the seller refused before settling and returned no transaction."
      : o.settlement === "not_found"
        ? "Nothing was paid: no transfer was found on chain (checked)."
        : "Whether money moved could not be confirmed.";
  if (/fee_payer_transferring_funds/i.test(r) || (/lighthouse|instruction/i.test(r) && o.network.startsWith("solana:"))) {
    return (
      `The seller's facilitator${o.feePayer ? ` (${o.feePayer})` : ""} refused the transaction (${r}): when signing, Phantom adds safety-check (Lighthouse) instructions, ` +
      "one of which reads the facilitator's fee-payer account, and this facilitator rejects any transaction that touches its fee payer. " +
      `Problem side: the facilitator's compatibility with the wallet. ${nothingPaid} ` +
      `Next: pay on Base if the seller offers it; use a similar API whose facilitator accepts Phantom (PayAI's does); or ${SIGNER_NOTE}.` +
      (o.learned ? " This facilitator is now avoided for 7 days." : "")
    );
  }
  if (/blockhash/i.test(r)) {
    return (
      `The facilitator could not use the transaction's blockhash (${r}). Problem side: the facilitator's view of the chain, usually passing. ${nothingPaid} ` +
      "Next: ask for a new approval link and try again."
    );
  }
  if (o.httpStatus >= 500 || /upstream|unavailable|internal/i.test(r)) {
    return (
      `The seller's server failed (HTTP ${o.httpStatus}${r ? `: ${r}` : ""}). Problem side: the seller (an outage on its side). ${nothingPaid} ` +
      "Next: try again later."
    );
  }
  return (
    `The seller or its facilitator refused the payment${r ? ` (${r})` : " without giving a reason"}. Problem side: the seller or its facilitator. ${nothingPaid} ` +
    "Next: try again with a new approval link; if it repeats, this seller's payment setup does not accept this payment."
  );
}
