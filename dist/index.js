#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { SpendGuard } from "./limits.js";
import { NeverminedPayer } from "./nevermined.js";
import { providerFromEnv } from "./providers/index.js";
import { createServer, VERSION } from "./server.js";
import { crossmintCreateWallet, crossmintGenSecret, privyCreateWallet } from "./setup.js";
import { X402Requester } from "./x402/request.js";
function die(message) {
    process.stderr.write(message.endsWith("\n") ? message : message + "\n");
    process.exit(1);
}
/** A plugin option the user left unset can arrive as the literal "${user_config.KEY}": treat it as empty. */
function dropUnsetPluginOptions() {
    for (const [k, v] of Object.entries(process.env)) {
        if (typeof v === "string" && /^\$\{user_config\.[A-Za-z0-9_]+\}$/.test(v.trim()))
            delete process.env[k];
    }
}
async function main() {
    dropUnsetPluginOptions();
    const [cmd, ...args] = process.argv.slice(2);
    if (cmd === "--version" || cmd === "-v") {
        console.log(VERSION);
        return;
    }
    const cfg = await loadConfig().catch((e) => die(e.message));
    // Setup helpers that do not need WALLET_PROVIDER.
    if (cmd === "privy-create-wallet") {
        const type = args[0] === "solana" ? "solana" : "ethereum";
        console.log(JSON.stringify(await privyCreateWallet(type), null, 2));
        return;
    }
    if (cmd === "crossmint-gen-secret") {
        console.log(`CROSSMINT_SIGNER_SECRET=${crossmintGenSecret()}`);
        return;
    }
    if (cmd === "crossmint-create-wallet") {
        console.log(JSON.stringify(await crossmintCreateWallet(cfg.network, args[0]), null, 2));
        return;
    }
    let provider;
    try {
        provider = await providerFromEnv(cfg.network);
    }
    catch (err) {
        die(err.message);
    }
    // Human-only helper commands (not exposed as MCP tools).
    if (cmd === "status") {
        console.log(JSON.stringify({ provider: provider?.id ?? "none", chains: provider?.chains(), ...(provider ? await provider.ready() : {}) }, null, 2));
        return;
    }
    if (cmd === "check-seller") {
        const [url, method = "GET", body] = args;
        if (!url)
            die("usage: x402-wallet-mcp check-seller <url> [method] [jsonBody]");
        const requester = new X402Requester({ provider, guard: new SpendGuard(), nevermined: new NeverminedPayer() });
        const result = await requester.checkSeller({ url, method, body: body ? JSON.parse(body) : undefined });
        console.log(JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
        return;
    }
    if (cmd === "pay" || cmd === "check") {
        const [url, method = "GET", body] = args;
        if (!url)
            die(`usage: x402-wallet-mcp ${cmd} <url> [method] [jsonBody]`);
        const requester = new X402Requester({ provider, guard: new SpendGuard(), nevermined: new NeverminedPayer() });
        const input = { url, method, body: body ? JSON.parse(body) : undefined };
        const result = cmd === "pay" ? await requester.request(input) : await requester.checkRequirements(input);
        console.log(JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
        return;
    }
    if (cmd === "crossmint-staging-fund") {
        if (provider?.id !== "crossmint")
            die("WALLET_PROVIDER must be crossmint");
        const amount = Number(args[0] ?? "5");
        console.log(JSON.stringify(await provider.stagingFund(amount), null, 2));
        return;
    }
    if (cmd && cmd !== "serve")
        die(`Unknown command "${cmd}". Commands: serve (default), status, check, check-seller, pay, privy-create-wallet, crossmint-gen-secret, crossmint-create-wallet, crossmint-staging-fund`);
    // stdout carries the MCP protocol; keep any SDK logging off it.
    console.log = console.info = console.debug = (...a) => console.error(...a);
    const server = createServer({ provider });
    await server.connect(new StdioServerTransport());
    process.stderr.write(`[x402-wallet-mcp] v${VERSION} ready on stdio (provider=${provider?.id ?? "none"}, network=${cfg.network})\n`);
}
main().catch((err) => die(`[x402-wallet-mcp] ${err.stack ?? err}`));
