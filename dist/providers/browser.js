import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { getAddress, getTypesForEIP712Domain, isAddress, recoverTypedDataAddress, serializeTypedData } from "viem";
import { evmUsdcBalance, testnetFundingNotes } from "../balance.js";
import { BASE, BASE_SEPOLIA, CHAINS } from "../chains.js";
import { ProviderConfigError, assertChain } from "./types.js";
/**
 * Pays with the user's own browser wallet (Rabby, MetaMask, Coinbase Wallet extension, ...).
 *
 * Every payment is approved by a person: when a payment needs signing, the server opens a page on
 * 127.0.0.1 in the browser; the user checks the amount and recipient there and signs with their
 * wallet, or rejects. Nothing is signed without that click, and no key is held by this server.
 * Base / Base Sepolia only.
 */
export const BROWSER_ENV = ["BROWSER_WALLET_ADDRESS"];
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
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
export class BrowserWalletProvider {
    mode;
    opts;
    id = "browser";
    server;
    pending = new Map();
    nextUrl;
    constructor(mode, opts = {}) {
        this.mode = mode;
        this.opts = opts;
    }
    chains() {
        return [this.mode === "testnet" ? BASE_SEPOLIA : BASE];
    }
    configuredAddress() {
        const a = process.env.BROWSER_WALLET_ADDRESS?.trim();
        if (!a)
            throw new ProviderConfigError("Missing BROWSER_WALLET_ADDRESS (your browser wallet's address on Base).");
        if (!isAddress(a))
            throw new ProviderConfigError("BROWSER_WALLET_ADDRESS is not a valid EVM address.");
        return getAddress(a);
    }
    async address(chain) {
        assertChain(this, chain);
        return this.configuredAddress();
    }
    async usdcBalance(chain) {
        return evmUsdcBalance(chain, await this.address(chain));
    }
    async fundingInfo(chain) {
        return { address: await this.address(chain), notes: testnetFundingNotes(chain) };
    }
    async ready() {
        try {
            this.configuredAddress();
            return { ok: true };
        }
        catch (err) {
            return { ok: false, reason: err.message };
        }
    }
    /** Called before signing so the approval page can show which URL is being paid. */
    beforeSign(info) {
        this.nextUrl = info.url;
    }
    async evmSigner() {
        const address = this.configuredAddress();
        return {
            address,
            signTypedData: (typedData) => this.requestApproval(address, typedData),
        };
    }
    /** Stops the local approval server (tests). */
    async close() {
        for (const p of this.pending.values())
            p.reject(new ApprovalError("The approval server was closed."));
        this.pending.clear();
        if (this.server)
            (await this.server).server.close();
        this.server = undefined;
    }
    async requestApproval(address, typedData) {
        const { port } = await this.startServer();
        const id = randomBytes(8).toString("hex");
        const token = randomBytes(16).toString("hex");
        const pageUrl = `http://127.0.0.1:${port}/approve/${id}?t=${token}`;
        const url = this.nextUrl;
        this.nextUrl = undefined;
        const signature = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new ApprovalError("The payment was not approved in time. Nothing was signed or paid."));
            }, this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
            const done = () => {
                clearTimeout(timer);
                this.pending.delete(id);
            };
            this.pending.set(id, {
                token,
                typedData,
                url,
                resolve: (s) => (done(), resolve(s)),
                reject: (e) => (done(), reject(e)),
            });
        });
        process.stderr.write(`agentpay402-mcp: approve the payment in your browser wallet: ${pageUrl}\n`);
        (this.opts.open ?? openInBrowser)(pageUrl);
        const sig = await signature;
        const recovered = await recoverTypedDataAddress({ ...typedData, signature: sig });
        if (getAddress(recovered) !== address) {
            throw new ApprovalError(`The payment was signed by ${recovered}, not ${address}. Nothing was paid.`);
        }
        return sig;
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
        const m = /^\/approve\/([0-9a-f]{16})$/.exec(u.pathname);
        const p = m ? this.pending.get(m[1]) : undefined;
        if (req.method === "GET") {
            if (!p || u.searchParams.get("t") !== p.token)
                return send(res, 404, "text/plain", "This approval link has expired.");
            return send(res, 200, "text/html; charset=utf-8", approvalPage(this.pageData(p)));
        }
        if (req.method === "POST") {
            const body = JSON.parse((await readBody(req)) || "{}");
            if (!p || body.t !== p.token)
                return send(res, 404, "application/json", JSON.stringify({ ok: false, error: "expired" }));
            if (body.reject) {
                p.reject(new ApprovalError("You rejected the payment. Nothing was signed or paid."));
                return send(res, 200, "application/json", JSON.stringify({ ok: true }));
            }
            if (!body.signature || !/^0x[0-9a-fA-F]+$/.test(body.signature)) {
                return send(res, 400, "application/json", JSON.stringify({ ok: false, error: "no signature" }));
            }
            p.resolve(body.signature);
            return send(res, 200, "application/json", JSON.stringify({ ok: true }));
        }
        send(res, 405, "text/plain", "method not allowed");
    }
    pageData(p) {
        const td = p.typedData;
        const chainId = Number(td.domain.chainId);
        const chain = Object.entries(CHAINS).find(([caip]) => caip === `eip155:${chainId}`);
        const msg = td.message;
        const value = msg.value !== undefined ? BigInt(msg.value) : undefined;
        return {
            token: p.token,
            address: this.configuredAddress(),
            url: p.url ?? null,
            chainId,
            chainName: chain?.[1].name ?? `chain ${chainId}`,
            testnet: chain?.[1].testnet ?? false,
            to: msg.to ?? null,
            amount: value !== undefined ? formatUsdc(value) : null,
            typedData: serializeTypedData({
                ...td,
                types: { EIP712Domain: getTypesForEIP712Domain({ domain: td.domain }), ...td.types },
            }),
        };
    }
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
    const json = JSON.stringify({ ...d, chainParams: CHAIN_PARAMS[d.chainId] ?? null }).replace(/</g, "\\u003c");
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
<p><button id="approve">ウォレットで署名する</button><button id="reject">拒否する</button></p>
<p id="msg"></p>
<script>
const d = ${json};
const $ = (id) => document.getElementById(id);
$("amount").textContent = d.amount ? d.amount + " USDC" : "不明";
$("to").textContent = d.to || "不明";
$("url").textContent = d.url || "不明";
$("chain").textContent = d.chainName;
$("from").textContent = d.address;
$("testnet").hidden = !d.testnet;
const msg = (t) => ($("msg").textContent = t);
const finish = (t) => { msg(t); $("approve").disabled = $("reject").disabled = true; };
async function post(body) {
  const r = await fetch(location.pathname, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ t: d.token, ...body }) });
  return r.json();
}
$("reject").onclick = async () => { await post({ reject: true }); finish("拒否しました。支払いはしていません。このタブは閉じてかまいません。"); };
$("approve").onclick = async () => {
  const eth = window.ethereum;
  if (!eth) return msg("ブラウザのウォレット（Rabby、MetaMask など）が見つかりません。");
  try {
    msg("ウォレットを確認しています…");
    const accounts = await eth.request({ method: "eth_requestAccounts" });
    const acct = accounts.find((a) => a.toLowerCase() === d.address.toLowerCase());
    if (!acct) return msg("ウォレットで " + d.address + " を選んでから、もう一度押してください。");
    const hex = "0x" + d.chainId.toString(16);
    try { await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] }); }
    catch (e) {
      if (e && e.code === 4902 && d.chainParams) await eth.request({ method: "wallet_addEthereumChain", params: [d.chainParams] });
      else throw e;
    }
    msg("ウォレットで署名してください…");
    const signature = await eth.request({ method: "eth_signTypedData_v4", params: [acct, d.typedData] });
    const r = await post({ signature });
    if (r.ok) finish("署名しました。Claude に戻ってください。このタブは閉じてかまいません。");
    else finish("このリンクは期限切れです。");
  } catch (e) {
    msg("署名されませんでした：" + (e && e.message ? e.message : e));
  }
};
</script></body></html>`;
}
