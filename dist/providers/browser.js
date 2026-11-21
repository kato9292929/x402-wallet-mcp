import { spawn } from "node:child_process";
import { createPublicKey, randomBytes, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { getAddress, getTypesForEIP712Domain, isAddress, recoverTypedDataAddress, serializeTypedData } from "viem";
import { address as solAddress, getBase58Encoder, getBase64Decoder, getCompiledTransactionMessageDecoder, getTransactionEncoder, } from "@solana/kit";
import { onchainUsdcBalance, testnetFundingNotes } from "../balance.js";
import { BASE, BASE_SEPOLIA, CHAINS, SOLANA, SOLANA_DEVNET, normalizeNetwork } from "../chains.js";
import { ProviderConfigError, assertChain, } from "./types.js";
/**
 * Pays with the user's own browser wallet (Rabby, MetaMask, Coinbase Wallet extension, ...).
 *
 * Every payment is approved by a person: when a payment needs signing, the server opens a page on
 * 127.0.0.1 in the browser; the user checks the amount and recipient there and signs with their
 * wallet, or rejects. Nothing is signed without that click, and no key is held by this server.
 * EVM (Base) is signed with an injected EVM wallet; Solana with Phantom (or any wallet that
 * injects `window.phantom.solana` / `window.solana`).
 */
export const BROWSER_ENV = ["BROWSER_WALLET_ADDRESS", "BROWSER_SOLANA_ADDRESS"];
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const SIGN_TIMEOUT_MS = 2 * 60_000;
export class ApprovalError extends Error {
    constructor(message) {
        super(message);
        this.name = "ApprovalError";
    }
}
export function openInBrowser(url) {
    const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
    try {
        spawn(cmd, args, { detached: true, stdio: "ignore" }).on("error", () => { }).unref();
    }
    catch {
        // The URL is also written to stderr.
    }
}
const json = (res, status, body) => send(res, status, "application/json", JSON.stringify(body));
export class BrowserWalletProvider {
    mode;
    opts;
    id = "browser";
    server;
    sessions = new Map();
    /** The session approved in beforeSign, waiting for the signer. */
    approved;
    constructor(mode, opts = {}) {
        this.mode = mode;
        this.opts = opts;
    }
    chains() {
        const out = [];
        if (process.env.BROWSER_WALLET_ADDRESS?.trim())
            out.push(this.mode === "testnet" ? BASE_SEPOLIA : BASE);
        if (process.env.BROWSER_SOLANA_ADDRESS?.trim())
            out.push(this.mode === "testnet" ? SOLANA_DEVNET : SOLANA);
        return out;
    }
    evmAddress() {
        const a = process.env.BROWSER_WALLET_ADDRESS?.trim();
        if (!a)
            throw new ProviderConfigError("Missing BROWSER_WALLET_ADDRESS (your Rabby / MetaMask address on Base).");
        if (!isAddress(a))
            throw new ProviderConfigError("BROWSER_WALLET_ADDRESS is not a valid EVM address.");
        return getAddress(a);
    }
    solanaAddress() {
        const a = process.env.BROWSER_SOLANA_ADDRESS?.trim();
        if (!a)
            throw new ProviderConfigError("Missing BROWSER_SOLANA_ADDRESS (your Phantom address).");
        try {
            return solAddress(a);
        }
        catch {
            throw new ProviderConfigError("BROWSER_SOLANA_ADDRESS is not a valid Solana address.");
        }
    }
    async address(chain) {
        assertChain(this, chain);
        return CHAINS[chain].family === "solana" ? this.solanaAddress() : this.evmAddress();
    }
    async usdcBalance(chain) {
        return onchainUsdcBalance(chain, await this.address(chain));
    }
    async fundingInfo(chain) {
        return { address: await this.address(chain), notes: testnetFundingNotes(chain) };
    }
    async ready() {
        try {
            if (!this.chains().length) {
                throw new ProviderConfigError("Set BROWSER_SOLANA_ADDRESS (Phantom) and/or BROWSER_WALLET_ADDRESS (Rabby / MetaMask).");
            }
            if (process.env.BROWSER_WALLET_ADDRESS?.trim())
                this.evmAddress();
            if (process.env.BROWSER_SOLANA_ADDRESS?.trim())
                this.solanaAddress();
            return { ok: true };
        }
        catch (err) {
            return { ok: false, reason: err.message };
        }
    }
    /**
     * Opens the approval page and waits for the user to press approve. Only then does the caller
     * build the payment, which the wallet signs right away.
     */
    async beforeSign(info) {
        this.approved = undefined;
        const chain = info.network ? normalizeNetwork(info.network) : undefined;
        if (!chain || !this.chains().includes(chain))
            return;
        const session = await this.openSession(chain, info);
        await this.waitForApproval(session);
        this.approved = session;
    }
    async evmSigner() {
        const address = this.evmAddress();
        const chain = this.mode === "testnet" ? BASE_SEPOLIA : BASE;
        return {
            address,
            signTypedData: async (typedData) => {
                const msg = typedData.message;
                const session = await this.sessionFor(chain, msg.value !== undefined ? String(msg.value) : undefined);
                const sig = await this.requestSignature(session, {
                    family: "evm",
                    typedData: serializeTypedData({
                        ...typedData,
                        types: { EIP712Domain: getTypesForEIP712Domain({ domain: typedData.domain }), ...typedData.types },
                    }),
                });
                const recovered = await recoverTypedDataAddress({ ...typedData, signature: sig });
                if (getAddress(recovered) !== address) {
                    throw new ApprovalError(`The payment was signed by ${recovered}, not ${address}. Nothing was paid.`);
                }
                return sig;
            },
        };
    }
    async solanaSigner() {
        const addr = this.solanaAddress();
        const chain = this.mode === "testnet" ? SOLANA_DEVNET : SOLANA;
        const pubkey = createPublicKey({
            key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(getBase58Encoder().encode(addr))]),
            format: "der",
            type: "spki",
        });
        const signOne = async (tx) => {
            const messageBytes = new Uint8Array(tx.messageBytes);
            const session = await this.sessionFor(chain, transferAtomic(messageBytes));
            const wireTx = getBase64Decoder().decode(getTransactionEncoder().encode(tx));
            const sigB58 = await this.requestSignature(session, { family: "solana", wireTx });
            let sig;
            try {
                sig = new Uint8Array(getBase58Encoder().encode(sigB58));
            }
            catch {
                throw new ApprovalError("The wallet returned an unreadable signature. Nothing was paid.");
            }
            if (sig.length !== 64 || !verify(null, messageBytes, pubkey, sig)) {
                throw new ApprovalError(`The signature does not match this payment from ${addr} (the wallet may have changed the transaction). Nothing was paid.`);
            }
            return { [addr]: sig };
        };
        return {
            address: addr,
            signTransactions: async (txs) => {
                const out = [];
                for (const tx of txs)
                    out.push(await signOne(tx));
                return out;
            },
        };
    }
    /** Stops the local approval server (tests). */
    async close() {
        for (const s of this.sessions.values())
            this.fail(s, new ApprovalError("The approval server was closed."));
        this.sessions.clear();
        this.approved = undefined;
        if (this.server)
            (await this.server).server.close();
        this.server = undefined;
    }
    /**
     * The approved session for this payment, after checking that the amount being signed is the one
     * the user approved. Without beforeSign (direct use), opens and waits for a new approval.
     */
    async sessionFor(chain, atomicAmount) {
        let session = this.approved;
        this.approved = undefined;
        if (!session || session.chain !== chain) {
            session = await this.openSession(chain, atomicAmount ? { url: "", amount: atomicAmount } : undefined);
            await this.waitForApproval(session);
        }
        const shown = session.info?.amount;
        if (shown !== undefined && atomicAmount !== undefined && BigInt(shown) !== BigInt(atomicAmount)) {
            this.fail(session, new ApprovalError("The amount to sign differs from the approved amount."));
            throw new ApprovalError(`The payment to sign (${atomicAmount}) differs from the amount you approved (${shown}). Nothing was paid.`);
        }
        return session;
    }
    async openSession(chain, info) {
        const { port } = await this.startServer();
        const session = {
            id: randomBytes(8).toString("hex"),
            token: randomBytes(16).toString("hex"),
            family: CHAINS[chain].family,
            chain,
            info,
            approved: false,
        };
        this.sessions.set(session.id, session);
        const pageUrl = `http://127.0.0.1:${port}/approve/${session.id}?t=${session.token}`;
        process.stderr.write(`agentpay402-mcp: approve the payment in your browser wallet: ${pageUrl}\n`);
        (this.opts.open ?? openInBrowser)(pageUrl);
        return session;
    }
    waitForApproval(session) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.fail(session, new ApprovalError("The payment was not approved in time. Nothing was signed or paid."));
            }, this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
            session.onApprove = {
                resolve: () => (clearTimeout(timer), resolve()),
                reject: (e) => (clearTimeout(timer), reject(e)),
            };
        });
    }
    requestSignature(session, req) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.fail(session, new ApprovalError("The wallet did not sign in time. Nothing was paid."));
            }, this.opts.signTimeoutMs ?? SIGN_TIMEOUT_MS);
            session.onSignature = {
                resolve: (s) => (clearTimeout(timer), this.sessions.delete(session.id), resolve(s)),
                reject: (e) => (clearTimeout(timer), this.sessions.delete(session.id), reject(e)),
            };
            session.req = req;
        });
    }
    fail(session, err) {
        this.sessions.delete(session.id);
        if (this.approved === session)
            this.approved = undefined;
        session.onApprove?.reject(err);
        session.onSignature?.reject(err);
    }
    startServer() {
        this.server ??= new Promise((resolve, reject) => {
            const server = createServer((req, res) => this.handle(req, res).catch(() => send(res, 500, "text/plain", "error")));
            server.on("error", reject);
            server.listen(0, "127.0.0.1", () => {
                server.unref();
                resolve({ server, port: server.address().port });
            });
        });
        this.server.catch(() => (this.server = undefined));
        return this.server;
    }
    async handle(req, res) {
        const u = new URL(req.url ?? "/", "http://127.0.0.1");
        if (req.method === "GET" && u.pathname === "/solana-web3.js") {
            return send(res, 200, "text/javascript; charset=utf-8", await solanaWeb3Script());
        }
        const m = /^\/approve\/([0-9a-f]{16})(\/request)?$/.exec(u.pathname);
        const s = m ? this.sessions.get(m[1]) : undefined;
        if (req.method === "GET") {
            if (!s || u.searchParams.get("t") !== s.token) {
                return m?.[2] ? json(res, 404, { state: "gone" }) : send(res, 404, "text/plain", "This approval link has expired.");
            }
            if (m[2])
                return json(res, 200, s.req ? { state: "ready", ...s.req } : { state: "waiting" });
            return send(res, 200, "text/html; charset=utf-8", approvalPage(this.pageData(s)));
        }
        if (req.method === "POST" && m && !m[2]) {
            const body = JSON.parse((await readBody(req)) || "{}");
            if (!s || body.t !== s.token)
                return json(res, 404, { ok: false, error: "expired" });
            if (body.action === "reject") {
                this.fail(s, new ApprovalError("You rejected the payment. Nothing was signed or paid."));
                return json(res, 200, { ok: true });
            }
            if (body.action === "approve") {
                if (!s.approved) {
                    s.approved = true;
                    s.onApprove?.resolve();
                }
                return json(res, 200, { ok: true });
            }
            if (body.action === "signature") {
                if (!s.req || !body.signature || !/^(0x[0-9a-fA-F]+|[1-9A-HJ-NP-Za-km-z]+)$/.test(body.signature)) {
                    return json(res, 400, { ok: false, error: "no signature" });
                }
                s.onSignature?.resolve(body.signature);
                return json(res, 200, { ok: true });
            }
            return json(res, 400, { ok: false, error: "unknown action" });
        }
        send(res, 405, "text/plain", "method not allowed");
    }
    pageData(s) {
        const chain = CHAINS[s.chain];
        return {
            family: s.family,
            token: s.token,
            address: s.family === "solana" ? this.solanaAddress() : this.evmAddress(),
            url: s.info?.url || null,
            chainId: s.family === "evm" ? Number(s.chain.split(":")[1]) : null,
            chainName: chain.name,
            testnet: chain.testnet,
            to: s.info?.payTo ?? null,
            amount: s.info?.amount !== undefined ? formatUsdc(BigInt(s.info.amount)) : null,
        };
    }
}
/** Amount (atomic units) of the SPL `TransferChecked` instruction in a payment transaction. */
function transferAtomic(messageBytes) {
    try {
        const msg = getCompiledTransactionMessageDecoder().decode(messageBytes);
        for (const ix of msg.instructions) {
            const d = ix.data;
            if (d && d.length === 10 && d[0] === 12) {
                return new DataView(d.buffer, d.byteOffset, d.length).getBigUint64(1, true).toString();
            }
        }
    }
    catch {
        // not decodable: no amount check
    }
    return undefined;
}
let web3Script;
function solanaWeb3Script() {
    web3Script ??= readFile(createRequire(import.meta.url).resolve("@solana/web3.js").replace(/lib[\\/].*$/, "lib/index.iife.min.js"), "utf8");
    return web3Script;
}
function formatUsdc(v) {
    const s = v.toString().padStart(7, "0");
    return `${s.slice(0, -6)}.${s.slice(-6)}`.replace(/0+$/, "").replace(/\.$/, ".00");
}
function send(res, status, type, body) {
    res.writeHead(status, {
        "content-type": type,
        "cache-control": "no-store",
        "x-frame-options": "DENY",
        "referrer-policy": "no-referrer",
    });
    res.end(body);
}
function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = "";
        req.setEncoding("utf8");
        req.on("data", (c) => {
            data += c;
            if (data.length > 100_000)
                req.destroy();
        });
        req.on("end", () => resolve(data));
        req.on("error", reject);
    });
}
const CHAIN_PARAMS = {
    8453: {
        chainId: "0x2105",
        chainName: "Base",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: ["https://mainnet.base.org"],
        blockExplorerUrls: ["https://basescan.org"],
    },
    84532: {
        chainId: "0x14a34",
        chainName: "Base Sepolia",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: ["https://sepolia.base.org"],
        blockExplorerUrls: ["https://sepolia.basescan.org"],
    },
};
function approvalPage(d) {
    const chainParams = d.chainId ? (CHAIN_PARAMS[d.chainId] ?? null) : null;
    const json = JSON.stringify({ ...d, chainParams }).replace(/</g, "\\u003c");
    return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AgentPay402 支払いの承認</title>
<style>
body{font-family:system-ui,sans-serif;max-width:520px;margin:40px auto;padding:0 16px;color:#111;background:#fff}
h1{font-size:20px}dl{display:grid;grid-template-columns:7em 1fr;gap:8px 12px}dt{color:#666}dd{margin:0;word-break:break-all}
.amount{font-size:28px;font-weight:700}.warn{background:#fff4d6;padding:8px 12px;border-radius:6px}
button{font-size:16px;padding:10px 20px;border-radius:8px;border:1px solid #888;background:#fff;cursor:pointer;margin-right:8px}
#approve{background:#111;color:#fff;border-color:#111}#msg{margin-top:16px;font-weight:600}
</style></head><body>
<h1>AgentPay402：支払いの承認</h1>
<p>Claude がこの支払いをしようとしています。内容を確かめて、よければウォレットで署名してください。</p>
<dl>
<dt>金額</dt><dd class="amount" id="amount"></dd>
<dt>支払い先</dt><dd id="to"></dd>
<dt>API</dt><dd id="url"></dd>
<dt>ネットワーク</dt><dd id="chain"></dd>
<dt>払う財布</dt><dd id="from"></dd>
</dl>
<p id="testnet" class="warn" hidden>テストネットです。本物のお金は動きません。</p>
<p id="devnet" class="warn" hidden>Phantom の設定で「テストネット」を有効にしておくと、内容の確認が正しく出ます。</p>
<p><button id="approve">ウォレットで署名する</button><button id="reject">拒否する</button></p>
<p id="msg"></p>
${d.family === "solana" ? '<script src="/solana-web3.js"></script>' : ""}
<script>
const d = ${json};
const $ = (id) => document.getElementById(id);
$("amount").textContent = d.amount ? d.amount + " USDC" : "不明";
$("to").textContent = d.to || "不明";
$("url").textContent = d.url || "不明";
$("chain").textContent = d.chainName;
$("from").textContent = d.address;
$("testnet").hidden = !d.testnet;
$("devnet").hidden = !(d.testnet && d.family === "solana");
const msg = (t) => ($("msg").textContent = t);
const finish = (t) => { msg(t); $("approve").disabled = $("reject").disabled = true; };
async function post(body) {
  const r = await fetch(location.pathname, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ t: d.token, ...body }) });
  return r.json();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForPayment() {
  for (let i = 0; i < 300; i++) {
    const r = await (await fetch(location.pathname + "/request?t=" + d.token)).json();
    if (r.state === "ready") return r;
    if (r.state === "gone") throw new Error("この支払いは取り消されました。");
    await sleep(200);
  }
  throw new Error("支払いの準備ができませんでした。");
}
function b58(bytes) {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
  let s = ""; while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b === 0) s = "1" + s; else break; }
  return s;
}
async function connectSolana() {
  const sol = (window.phantom && window.phantom.solana) || window.solana;
  if (!sol) throw new Error("Phantom が見つかりません。");
  const { publicKey } = await sol.connect();
  if (publicKey.toString() !== d.address) throw new Error("Phantom で " + d.address + " を選んでから、もう一度押してください。");
  return async (req) => {
    const tx = solanaWeb3.VersionedTransaction.deserialize(Uint8Array.from(atob(req.wireTx), (c) => c.charCodeAt(0)));
    const signed = await sol.signTransaction(tx);
    const i = signed.message.staticAccountKeys.findIndex((k) => k.toString() === d.address);
    if (i < 0 || !signed.signatures[i]) throw new Error("署名が見つかりません。");
    return b58(signed.signatures[i]);
  };
}
async function connectEvm() {
  const eth = window.ethereum;
  if (!eth) throw new Error("ブラウザのウォレット（Rabby、MetaMask など）が見つかりません。");
  const accounts = await eth.request({ method: "eth_requestAccounts" });
  const acct = accounts.find((a) => a.toLowerCase() === d.address.toLowerCase());
  if (!acct) throw new Error("ウォレットで " + d.address + " を選んでから、もう一度押してください。");
  const hex = "0x" + d.chainId.toString(16);
  try { await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] }); }
  catch (e) {
    if (e && e.code === 4902 && d.chainParams) await eth.request({ method: "wallet_addEthereumChain", params: [d.chainParams] });
    else throw e;
  }
  return (req) => eth.request({ method: "eth_signTypedData_v4", params: [acct, req.typedData] });
}
$("reject").onclick = async () => { await post({ action: "reject" }); finish("拒否しました。支払いはしていません。このタブは閉じてかまいません。"); };
$("approve").onclick = async () => {
  $("approve").disabled = true;
  try {
    msg("ウォレットを確認しています…");
    const sign = d.family === "solana" ? await connectSolana() : await connectEvm();
    await post({ action: "approve" });
    msg("支払いを用意しています…");
    const req = await waitForPayment();
    msg("ウォレットで承認してください…");
    const signature = await sign(req);
    const r = await post({ action: "signature", signature });
    if (r.ok) finish("署名しました。Claude に戻ってください。このタブは閉じてかまいません。");
    else finish("このリンクは期限切れです。");
  } catch (e) {
    $("approve").disabled = false;
    msg("署名されませんでした：" + (e && e.message ? e.message : e));
  }
};
</script></body></html>`;
}
