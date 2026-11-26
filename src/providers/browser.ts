import { spawn } from "node:child_process";
import { createPublicKey, randomBytes, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { getAddress, getTypesForEIP712Domain, isAddress, recoverTypedDataAddress, serializeTypedData } from "viem";
import {
  address as solAddress,
  getBase58Decoder,
  getBase58Encoder,
  getBase64Decoder,
  getCompiledTransactionMessageDecoder,
  getTransactionEncoder,
  type Transaction,
} from "@solana/kit";
import { onchainUsdcBalance, testnetFundingNotes } from "../balance.js";
import { BASE, BASE_SEPOLIA, CHAINS, SOLANA, SOLANA_DEVNET, normalizeNetwork, type NetworkMode } from "../chains.js";
import {
  ProviderConfigError,
  assertChain,
  type EvmSigner,
  type FundingInfo,
  type SolanaSigner,
  type WalletProvider,
} from "./types.js";

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
  constructor(message: string) {
    super(message);
    this.name = "ApprovalError";
  }
}

type TypedData = Parameters<EvmSigner["signTypedData"]>[0];

export interface PaymentInfo {
  url: string;
  network?: string;
  amount?: string;
  payTo?: string;
}

type SignRequest =
  | { family: "evm"; typedData: TypedData }
  | { family: "solana"; wireTx: string };

/**
 * One payment's approval. The page opens first; the payment is built only after the user presses
 * approve (so a Solana blockhash or an EIP-3009 validity window is fresh when the wallet signs).
 */
interface Session {
  id: string;
  token: string;
  family: "evm" | "solana";
  chain: string;
  info?: PaymentInfo;
  approved: boolean;
  req?: SignRequest;
  onApprove?: { resolve(): void; reject(e: Error): void };
  onSignature?: { resolve(sig: string): void; reject(e: Error): void };
}

export interface BrowserProviderOptions {
  /** Opens the approval page; defaults to the system browser. */
  open?: (url: string) => void;
  /** How long to wait for the approve click (default 5 minutes). */
  timeoutMs?: number;
  /** How long to wait for the wallet's signature after the click (default 2 minutes). */
  signTimeoutMs?: number;
}

export function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    spawn(/*turbopackIgnore: true*/ cmd, args, { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
  } catch {
    // The URL is also written to stderr.
  }
}

const json = (res: ServerResponse, status: number, body: unknown) => send(res, status, "application/json", JSON.stringify(body));

export class BrowserWalletProvider implements WalletProvider {
  readonly id = "browser" as const;
  private server?: Promise<{ server: Server; port: number }>;
  private readonly sessions = new Map<string, Session>();
  /** The session approved in beforeSign, waiting for the signer. */
  private approved?: Session;

  constructor(
    private readonly mode: NetworkMode,
    private readonly opts: BrowserProviderOptions = {},
  ) {}

  chains(): string[] {
    const out: string[] = [];
    if (process.env.BROWSER_WALLET_ADDRESS?.trim()) out.push(this.mode === "testnet" ? BASE_SEPOLIA : BASE);
    if (process.env.BROWSER_SOLANA_ADDRESS?.trim()) out.push(this.mode === "testnet" ? SOLANA_DEVNET : SOLANA);
    return out;
  }

  private evmAddress(): `0x${string}` {
    const a = process.env.BROWSER_WALLET_ADDRESS?.trim();
    if (!a) throw new ProviderConfigError("Missing BROWSER_WALLET_ADDRESS (your Rabby / MetaMask address on Base).");
    if (!isAddress(a)) throw new ProviderConfigError("BROWSER_WALLET_ADDRESS is not a valid EVM address.");
    return getAddress(a);
  }

  private solanaAddress(): string {
    const a = process.env.BROWSER_SOLANA_ADDRESS?.trim();
    if (!a) throw new ProviderConfigError("Missing BROWSER_SOLANA_ADDRESS (your Phantom address).");
    try {
      return solAddress(a);
    } catch {
      throw new ProviderConfigError("BROWSER_SOLANA_ADDRESS is not a valid Solana address.");
    }
  }

  async address(chain: string): Promise<string> {
    assertChain(this, chain);
    return CHAINS[chain].family === "solana" ? this.solanaAddress() : this.evmAddress();
  }

  async usdcBalance(chain: string): Promise<string> {
    return onchainUsdcBalance(chain, await this.address(chain));
  }

  async fundingInfo(chain: string): Promise<FundingInfo> {
    return { address: await this.address(chain), notes: testnetFundingNotes(chain) };
  }

  async ready(): Promise<{ ok: boolean; reason?: string }> {
    try {
      if (!this.chains().length) {
        throw new ProviderConfigError("Set BROWSER_SOLANA_ADDRESS (Phantom) and/or BROWSER_WALLET_ADDRESS (Rabby / MetaMask).");
      }
      if (process.env.BROWSER_WALLET_ADDRESS?.trim()) this.evmAddress();
      if (process.env.BROWSER_SOLANA_ADDRESS?.trim()) this.solanaAddress();
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
  }

  /**
   * Opens the approval page and waits for the user to press approve. Only then does the caller
   * build the payment, which the wallet signs right away.
   */
  async beforeSign(info: PaymentInfo): Promise<void> {
    this.approved = undefined;
    const chain = info.network ? normalizeNetwork(info.network) : undefined;
    if (!chain || !this.chains().includes(chain)) return;
    const session = await this.openSession(chain, info);
    await this.waitForApproval(session);
    this.approved = session;
  }

  async evmSigner(): Promise<EvmSigner> {
    const address = this.evmAddress();
    const chain = this.mode === "testnet" ? BASE_SEPOLIA : BASE;
    return {
      address,
      signTypedData: async (typedData) => {
        const msg = typedData.message as { value?: bigint | string };
        const session = await this.sessionFor(chain, msg.value !== undefined ? String(msg.value) : undefined);
        const sig = await this.requestSignature(session, {
          family: "evm",
          typedData: serializeTypedData({
            ...(typedData as any),
            types: { EIP712Domain: getTypesForEIP712Domain({ domain: typedData.domain as any }), ...(typedData.types as any) },
          }) as unknown as TypedData,
        });
        const recovered = await recoverTypedDataAddress({ ...(typedData as any), signature: sig as `0x${string}` });
        if (getAddress(recovered) !== address) {
          throw new ApprovalError(`The payment was signed by ${recovered}, not ${address}. Nothing was paid.`);
        }
        return sig as `0x${string}`;
      },
    };
  }

  async solanaSigner(): Promise<SolanaSigner> {
    const addr = this.solanaAddress();
    const chain = this.mode === "testnet" ? SOLANA_DEVNET : SOLANA;
    const pubkey = createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(getBase58Encoder().encode(addr))]),
      format: "der",
      type: "spki",
    });
    const signOne = async (tx: Transaction) => {
      const messageBytes = new Uint8Array(tx.messageBytes);
      const session = await this.sessionFor(chain, transferAtomic(messageBytes));
      const wireTx = getBase64Decoder().decode(getTransactionEncoder().encode(tx));
      const sigB58 = await this.requestSignature(session, { family: "solana", wireTx });
      let sig: Uint8Array;
      try {
        sig = new Uint8Array(getBase58Encoder().encode(sigB58));
      } catch {
        throw new ApprovalError("The wallet returned an unreadable signature. Nothing was paid.");
      }
      if (sig.length !== 64 || !verify(null, messageBytes, pubkey, sig)) {
        throw new ApprovalError(
          `The signature does not match this payment from ${addr} (the wallet may have changed the transaction). Nothing was paid.`,
        );
      }
      return { [addr]: sig };
    };
    return {
      address: addr,
      signTransactions: async (txs: readonly Transaction[]) => {
        const out = [];
        for (const tx of txs) out.push(await signOne(tx));
        return out;
      },
    } as unknown as SolanaSigner;
  }

  /** Stops the local approval server (tests). */
  async close(): Promise<void> {
    for (const s of this.sessions.values()) this.fail(s, new ApprovalError("The approval server was closed."));
    this.sessions.clear();
    this.approved = undefined;
    if (this.server) (await this.server).server.close();
    this.server = undefined;
  }

  /**
   * The approved session for this payment, after checking that the amount being signed is the one
   * the user approved. Without beforeSign (direct use), opens and waits for a new approval.
   */
  private async sessionFor(chain: string, atomicAmount: string | undefined): Promise<Session> {
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

  private async openSession(chain: string, info?: PaymentInfo): Promise<Session> {
    const { port } = await this.startServer();
    const session: Session = {
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

  private waitForApproval(session: Session): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(session, new ApprovalError("The payment was not approved in time. Nothing was signed or paid."));
      }, this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      session.onApprove = {
        resolve: () => (clearTimeout(timer), resolve()),
        reject: (e) => (clearTimeout(timer), reject(e)),
      };
    });
  }

  private requestSignature(session: Session, req: SignRequest): Promise<string> {
    return new Promise<string>((resolve, reject) => {
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

  private fail(session: Session, err: Error): void {
    this.sessions.delete(session.id);
    if (this.approved === session) this.approved = undefined;
    session.onApprove?.reject(err);
    session.onSignature?.reject(err);
  }

  private startServer(): Promise<{ server: Server; port: number }> {
    this.server ??= new Promise((resolve, reject) => {
      const server = createServer((req, res) => this.handle(req, res).catch(() => send(res, 500, "text/plain", "error")));
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.unref();
        resolve({ server, port: (server.address() as AddressInfo).port });
      });
    });
    this.server.catch(() => (this.server = undefined));
    return this.server;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
      if (m![2]) return json(res, 200, s.req ? { state: "ready", ...s.req } : { state: "waiting" });
      return send(res, 200, "text/html; charset=utf-8", approvalPage(this.pageData(s)));
    }

    if (req.method === "POST" && m && !m[2]) {
      const body = JSON.parse((await readBody(req)) || "{}") as { t?: string; action?: string; signature?: string };
      if (!s || body.t !== s.token) return json(res, 404, { ok: false, error: "expired" });
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

  private pageData(s: Session) {
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
function transferAtomic(messageBytes: Uint8Array): string | undefined {
  try {
    const msg = getCompiledTransactionMessageDecoder().decode(messageBytes) as { instructions: { data?: Uint8Array }[] };
    for (const ix of msg.instructions) {
      const d = ix.data;
      if (d && d.length === 10 && d[0] === 12) {
        return new DataView(d.buffer, d.byteOffset, d.length).getBigUint64(1, true).toString();
      }
    }
  } catch {
    // not decodable: no amount check
  }
  return undefined;
}

let web3Script: Promise<string> | undefined;
function solanaWeb3Script(): Promise<string> {
  web3Script ??= readFile(
    createRequire(import.meta.url).resolve("@solana/web3.js").replace(/lib[\\/].*$/, "lib/index.iife.min.js"),
    "utf8",
  );
  return web3Script;
}

function formatUsdc(v: bigint): string {
  const s = v.toString().padStart(7, "0");
  return `${s.slice(0, -6)}.${s.slice(-6)}`.replace(/0+$/, "").replace(/\.$/, ".00");
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => {
      data += c;
      if (data.length > 100_000) req.destroy();
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/** The approval page style, shared with the remote server's page. */
/** Fonts for the approval pages: Outfit, as on the front page (agentpay.x402jp.com). */
export const APPROVAL_FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300..600&display=swap" rel="stylesheet">`;

/** The approval page's look: the front page's colours, type, borders and cards. */
export const APPROVAL_CSS = `:root{--bg:#151517;--ink:#ededed;--muted:#a1a1a1;--dim:#6e6e73;--line:rgba(255,255,255,.12);--chip:rgba(255,255,255,.04);
--ok:#6ee7a8;--err:#ff8a8a;--warn:#f5c97a}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px;background:var(--bg);color:var(--ink);
font-family:Outfit,"Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP","Yu Gothic UI",Meiryo,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.card{position:relative;width:100%;max-width:420px;border:1px solid var(--line);border-radius:16px;padding:26px 22px 22px;
background:linear-gradient(180deg,rgba(255,255,255,.035),rgba(255,255,255,.01));overflow:hidden}
.card::before{content:"";position:absolute;left:0;right:0;top:0;height:2px;opacity:.85;
background:linear-gradient(90deg,#ff2d2d,#ff9a00,#ffe600,#2bff5a,#00e5ff,#2a5bff,#8a2bff)}
.brand{font-size:19px;font-weight:500;letter-spacing:-.02em;color:var(--ink)}
.brand i{display:none}
.site{margin:22px 0 4px;text-align:center}
.host{display:inline-block;padding:6px 14px;border:1px solid var(--line);border-radius:999px;background:var(--chip);font-size:14px;font-weight:500;
max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lead{color:var(--muted);font-size:13px;text-align:center;margin:12px 0 0}
.amount{text-align:center;margin:16px 0 22px}
.amount b{display:block;font-size:44px;font-weight:500;letter-spacing:-.035em;line-height:1.1}
.amount span{display:block;margin-top:4px;color:var(--muted);font-size:14px}
.rows{margin:0;border:1px solid var(--line);border-radius:12px;overflow:hidden}
.r{display:flex;justify-content:space-between;gap:12px;padding:12px 14px;font-size:14px}
.r+.r{border-top:1px solid var(--line)}
.r dt{color:var(--dim);margin:0}.r dd{margin:0;text-align:right;font-weight:500;word-break:break-all}
.warn{margin:12px 0 0;padding:10px 14px;border:1px solid rgba(245,201,122,.3);border-radius:12px;color:var(--warn);font-size:13px}
.btns{display:flex;gap:10px;margin-top:20px}
button{flex:1;font:inherit;font-size:16px;font-weight:500;padding:13px;border-radius:10px;cursor:pointer;transition:background .2s,opacity .2s,border-color .2s}
#reject{background:transparent;color:var(--ink);border:1px solid var(--line)}#reject:hover{border-color:rgba(255,255,255,.3)}
#approve{font-weight:600;letter-spacing:.01em;border:1.5px solid transparent;
background:linear-gradient(#1b1b1e,#1b1b1e) padding-box,linear-gradient(90deg,#ff6a5c,#ffb347,#ffe46b,#7cf2a0,#6fe3ff,#8fa8ff,#c29bff) border-box}
#approve span{background:linear-gradient(90deg,#ff6a5c,#ffb347,#ffe46b,#7cf2a0,#6fe3ff,#8fa8ff,#c29bff);-webkit-background-clip:text;background-clip:text;color:transparent}
#approve:hover{background:linear-gradient(#232327,#232327) padding-box,linear-gradient(90deg,#ff6a5c,#ffb347,#ffe46b,#7cf2a0,#6fe3ff,#8fa8ff,#c29bff) border-box}
button:disabled{opacity:.4;cursor:default}
#msg{min-height:20px;margin:14px 0 0;text-align:center;font-size:14px;line-height:1.6;color:var(--muted)}
#msg.ok{color:var(--ok)}#msg.err{color:var(--err)}
:focus-visible{outline:2px solid #fff;outline-offset:3px}
[hidden]{display:none!important}
#approve{flex:2.2;white-space:nowrap}
#reject{white-space:nowrap}
@media (max-width:380px){.btns{flex-direction:column-reverse}}
`;

export const CHAIN_PARAMS: Record<number, unknown> = {
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

function approvalPage(d: ReturnType<BrowserWalletProvider["pageData"]>): string {
  const chainParams = d.chainId ? (CHAIN_PARAMS[d.chainId] ?? null) : null;
  const json = JSON.stringify({ ...d, chainParams }).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AgentPay 支払いの承認</title>
${APPROVAL_FONTS}
<style>
${APPROVAL_CSS}</style></head><body>
<main class="card">
<div class="brand">AgentPay</div>
<div class="site"><span class="host" id="host"></span></div>
<p class="lead">Claude がこの API に支払おうとしています</p>
<div class="amount"><b id="amount"></b><span id="chain"></span></div>
<dl class="rows">
<div class="r"><dt>支払い先</dt><dd id="to"></dd></div>
<div class="r"><dt>払うウォレット</dt><dd id="from"></dd></div>
<div class="r"><dt>API</dt><dd id="url"></dd></div>
</dl>
<p id="testnet" class="warn" hidden>テストネットです。本物のお金は動きません。</p>
<p id="devnet" class="warn" hidden>Phantom の設定で「テストネット」を有効にしておくと、内容の確認が正しく出ます。</p>
<div class="btns"><button id="reject">拒否</button><button id="approve"><span>承認する</span></button></div>
<p id="msg"></p>
</main>
${d.family === "solana" ? '<script src="/solana-web3.js"></script>' : ""}
<script>
const d = ${json};
const $ = (id) => document.getElementById(id);
const short = (a) => (a && a.length > 16 ? a.slice(0, 6) + "…" + a.slice(-6) : a || "不明");
const setFull = (id, text, full) => { $(id).textContent = text; if (full) $(id).title = full; };
let host = "";
try { host = d.url ? new URL(d.url).host : ""; } catch {}
$("host").textContent = host || "x402 API";
$("amount").textContent = d.amount ? d.amount + " USDC" : "金額不明";
$("chain").textContent = d.chainName + " で支払い";
setFull("to", short(d.to), d.to);
setFull("from", short(d.address), d.address);
setFull("url", d.url ? new URL(d.url).pathname : "不明", d.url);
$("testnet").hidden = !d.testnet;
$("devnet").hidden = !(d.testnet && d.family === "solana");
const msg = (t, cls = "") => { $("msg").textContent = t; $("msg").className = cls; };
const finish = (t, cls = "ok") => { msg(t, cls); $("approve").disabled = $("reject").disabled = true; };
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
$("reject").onclick = async () => { await post({ action: "reject" }); finish("拒否しました。支払いはしていません。このタブは閉じてかまいません。", ""); };
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
    else finish("このリンクは期限切れです。", "err");
  } catch (e) {
    $("approve").disabled = false;
    msg("署名されませんでした：" + (e && e.message ? e.message : e), "err");
  }
};
</script></body></html>`;
}
