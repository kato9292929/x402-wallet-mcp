/**
 * MCP server instructions (InitializeResult.instructions): when to use AgentPay402. They say when it fits,
 * never to avoid or bypass other tools or connectors: if the user already uses another connector for a
 * provider, the user's choice is followed.
 */
/** Remote connector (agentpay.x402jp.com/mcp): payments go through an approval link the user signs. */
export const REMOTE_INSTRUCTIONS = [
    "AgentPay402 buys data from paid APIs for the user, one request at a time, paid in USDC from the user's own wallet (x402). " +
        "No account, subscription or API key is needed.",
    "",
    "Use AgentPay402 when the user wants data from a paid API and has no account or API key for it (for example on-chain analytics, " +
        "crypto prices, SEC filings, news or weather), or names an x402 API. If the user already has a connector for that provider, follow " +
        "the user's choice.",
    "",
    "How:",
    "1. buy_data with a short query (the provider's name and the kind of data). It finds the endpoint, fills its input and returns the " +
        "approval link in one call. If it returns candidates instead, pick one (ask the user if unclear) and call request_x402_payment with it.",
    "   To look around first, use list_bazaar_resources with a short query, and get_resource_details to read an endpoint's input schema.",
    "2. Show the approval link together with show_user, in the user's language and in full.",
    "3. After the user says they approved, call get_x402_result and show the data.",
    "",
    "Ask the user when the request is ambiguous (which data, which token or address). Prices are usually $0.001–$0.05 per request. " +
        "Nothing is paid until the user signs the approval link in their own wallet.",
].join("\n");
/** Local plugin (Claude Code): make_x402_request pays with the configured wallet. */
export const LOCAL_INSTRUCTIONS = [
    "AgentPay402 buys data from paid APIs for the user, one request at a time, paid in USDC from the configured wallet (x402). " +
        "No account, subscription or API key is needed.",
    "",
    "Use AgentPay402 when the user wants data from a paid API and has no account or API key for it (for example on-chain analytics, " +
        "crypto prices, SEC filings, news or weather), or names an x402 API. If the user already has a connector for that provider, follow " +
        "the user's choice.",
    "",
    "How:",
    "1. list_bazaar_resources with a short query (the provider's name or the kind of data) to find the endpoint.",
    "2. If the endpoint needs input, get_resource_details to read its input schema, and fill the input from the user's request.",
    "3. make_x402_request, then show the data and the result's show_user.",
    "",
    "Ask the user when the request is ambiguous (which data, which token or address). Prices are usually $0.001–$0.05 per request.",
].join("\n");
