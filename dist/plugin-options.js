/**
 * Plugin settings arrive as CLAUDE_PLUGIN_OPTION_<KEY> variables, one per userConfig option
 * (the names the Claude plugin directory accepts). This maps them onto the names the rest of
 * the server reads.
 *
 * When the server runs as a plugin, credentials come only from the plugin settings: any
 * provider credential already present in the process environment is dropped, so nothing set
 * on the user's machine is picked up or sent anywhere.
 */
export const PLUGIN_PREFIX = "CLAUDE_PLUGIN_OPTION_";
/** Plugin option (upper-cased key) -> variable the server reads. */
export const PLUGIN_OPTION_TARGETS = {
    WALLET_PROVIDER: "WALLET_PROVIDER",
    CDP_API_KEY_ID: "CDP_API_KEY_ID",
    CDP_API_KEY_SECRET: "CDP_API_KEY_SECRET",
    CDP_WALLET_SECRET: "CDP_WALLET_SECRET",
    PRIVY_APP_ID: "PRIVY_APP_ID",
    PRIVY_APP_SECRET: "PRIVY_APP_SECRET",
    PRIVY_WALLET_ID: "PRIVY_WALLET_ID",
    CROSSMINT_SERVER_API_KEY: "CROSSMINT_SERVER_API_KEY",
    CROSSMINT_SIGNER_SECRET: "CROSSMINT_SIGNER_SECRET",
    CROSSMINT_WALLET_ADDRESS: "CROSSMINT_WALLET_ADDRESS",
    NVM_API_KEY: "NVM_API_KEY",
    NETWORK: "X402_NETWORK",
    PER_CALL_MAX_USD: "X402_PER_CALL_MAX_USD",
    PER_SESSION_MAX_USD: "X402_PER_SESSION_MAX_USD",
    ALLOWED_HOSTS: "X402_ALLOWED_HOSTS",
    PROBE_MODE: "X402_PROBE_MODE",
    PRICE_MISMATCH: "X402_PRICE_MISMATCH",
    RETRY_WITH_RECEIPT: "X402_RETRY_WITH_RECEIPT",
    REPORT_TO_PROBE: "X402_REPORT_TO_PROBE",
};
/** Provider credentials that, in plugin mode, may only come from the plugin settings. */
const CREDENTIALS = [
    "CDP_API_KEY_ID",
    "CDP_API_KEY_SECRET",
    "CDP_WALLET_SECRET",
    "PRIVY_APP_ID",
    "PRIVY_APP_SECRET",
    "PRIVY_WALLET_ID",
    "PRIVY_SOLANA_WALLET_ID",
    "PRIVY_AUTHORIZATION_PRIVATE_KEY",
    "CROSSMINT_API_KEY",
    "CROSSMINT_SERVER_API_KEY",
    "CROSSMINT_SIGNER_SECRET",
    "CROSSMINT_WALLET_ADDRESS",
    "NVM_API_KEY",
    "NVM_DELEGATION_ID",
    "NVM_PAYMENT_METHOD_ID",
];
/** An option the user left unset can arrive as the literal "${user_config.KEY}". */
const unset = (v) => !v || !v.trim() || /^\$\{user_config\.[A-Za-z0-9_]+\}$/.test(v.trim());
/**
 * Applies CLAUDE_PLUGIN_OPTION_* to `env` in place. Returns true when the server runs as a
 * plugin (at least one such variable is present).
 */
export function applyPluginOptions(env = process.env) {
    const keys = Object.keys(env).filter((k) => k.startsWith(PLUGIN_PREFIX));
    if (!keys.length)
        return false;
    for (const name of CREDENTIALS)
        delete env[name];
    for (const target of Object.values(PLUGIN_OPTION_TARGETS))
        if (target.startsWith("X402_") || target === "WALLET_PROVIDER")
            delete env[target];
    for (const k of keys) {
        const target = PLUGIN_OPTION_TARGETS[k.slice(PLUGIN_PREFIX.length)];
        const v = env[k];
        if (target && !unset(v))
            env[target] = v.trim();
    }
    return true;
}
