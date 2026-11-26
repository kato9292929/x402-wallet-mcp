/**
 * Text for Claude to show the user, translated into their language: how to finish a payment and the
 * notice from the terms (AgentPay402 is not a party to the transaction; Terms Article 2.2–2.4).
 */
export const TERMS_URL = "https://agentpay.x402jp.com/terms";
export const PRIVACY_URL = "https://agentpay.x402jp.com/privacy";
/** How long a payment's result is kept for get_x402_result (remote server). */
export const RESULT_KEPT_MINUTES = 30;
export const NOTICE = [
    "Notice",
    "- The payment and the data are between you and the API provider (seller). AgentPay402 provides the interface only and is not a party to the transaction.",
    "- AgentPay402 never holds your funds or your keys. Payments go directly from your wallet to the seller on chain.",
    "- Alpha version: features and supported wallets may change.",
    `Terms: ${TERMS_URL}`,
    `Privacy: ${PRIVACY_URL}`,
].join("\n");
/** Shown with an approval link: how to pay, then the notice. Solana adds the phone link. */
export function showUserForApproval(family) {
    return [
        "How to pay",
        "1. Open the approval link and check the amount, the API and the address you pay to.",
        "2. Sign in your wallet (Solana: Phantom / Base: Rabby or MetaMask). Nothing is paid until you sign.",
        ...(family === "solana" ? ["   On a phone, open the Phantom app link instead, to sign in the Phantom app."] : []),
        '3. Come back here and say "approved". Claude then fetches the result and shows you the data.',
        `   The result is kept for ${RESULT_KEPT_MINUTES} minutes only, so come back soon.`,
        "The link expires in 5 minutes. If your wallet warns that the request could not be simulated, cancel: nothing is paid.",
        "",
        NOTICE,
    ].join("\n");
}
export const SHOW_USER_INSTRUCTION = "Show the user show_user together with the approval link: translate it into the user's language and show it in full, without leaving anything out.";
export const RESULT_NEXT_STEP = `Show the user the content of body. The result is kept for ${RESULT_KEPT_MINUTES} minutes only, so if the user wants to keep it, show it here now.`;
