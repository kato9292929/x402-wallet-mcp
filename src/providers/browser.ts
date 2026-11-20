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
import { BASE, BASE_SEPOLIA, CHAINS, SOLANA, SOLANA_DEVNET, type NetworkMode } from "../chains.js";
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

type Request =
  | { family: "evm"; typedData: TypedData }
  | { family: "solana"; wireTx: string; messageBytes: Uint8Array; chain: string };

interface Pending {
  token: string;
  req: Request;
  info?: PaymentInfo;
  resolve(sig: string): void;
  reject(err: Error): void;
}

export interface BrowserProviderOptions {
  /** Opens the approval page; defaults to the system browser. */
  open?: (url: string) => void;
  timeoutMs?: number;
}

export function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
  } catch {
    // The URL is also written to stderr.
  }
}

export class BrowserWalletProvider implements WalletProvider {
  readonly id = "browser" as const;
  private server?: Promise<{ server: Server; port: number }>;
  private readonly pending = new Map<string, Pending>();
  private nextInfo?: PaymentInfo;

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

  /** Called before signing so the approval page can show what is being paid. */
  beforeSign(info: PaymentInfo): void {
    this.nextInfo = info;
  }

  async evmSigner(): Promise<EvmSigner> {
    const address = this.evmAddress();
    return {
      address,
      signTypedData: async (typedData) => {
        const sig = await this.requestApproval({ family: "evm", typedData });
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
      const wireTx = getBase64Decoder().decode(getTransactionEncoder().encode(tx));
      const sigB58 = await this.requestApproval({ family: "solana", wireTx, messageBytes: new Uint8Array(tx.messageBytes), chain });
      let sig: Uint8Array;
      try {
        sig = new Uint8Array(getBase58Encoder().encode(sigB58));
      } catch {
        throw new ApprovalError("The wallet returned an unreadable signature. Nothing was paid.");
      }
      if (sig.length !== 64 || !verify(null, new Uint8Array(tx.messageBytes), pubkey, sig)) {
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
    for (const p of this.pending.values()) p.reject(new ApprovalError("The approval server was closed."));
    this.pending.clear();
    if (this.server) (await this.server).server.close();
    this.server = undefined;
  }

  private async requestApproval(req: Request): Promise<string> {
    const { port } = await this.startServer();
    const id = randomBytes(8).toString("hex");
    const token = randomBytes(16).toString("hex");
    const pageUrl = `http://127.0.0.1:${port}/approve/${id}?t=${token}`;
    const info = this.nextInfo;
    this.nextInfo = undefined;

    const signature = new Promise<string>((resolve, reject) => {
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
        req,
        info,
        resolve: (s) => (done(), resolve(s)),
        reject: (e) => (done(), reject(e)),
      });
    });

    process.stderr.write(`agentpay402-mcp: approve the payment in your browser wallet: ${pageUrl}\n`);
    (this.opts.open ?? openInBrowser)(pageUrl);
    return signature;
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
    const m = /^\/approve\/([0-9a-f]{16})$/.exec(u.pathname);
    const p = m ? this.pending.get(m[1]) : undefined;

    if (req.method === "GET") {
      if (!p || u.searchParams.get("t") !== p.token) return send(res, 404, "text/plain", "This approval link has expired.");
      return send(res, 200, "text/html; charset=utf-8", approvalPage(this.pageData(p)));
    }

    if (req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}") as { t?: string; signature?: string; reject?: boolean };
      if (!p || body.t !== p.token) return send(res, 404, "application/json", JSON.stringify({ ok: false, error: "expired" }));
      if (body.reject) {
        p.reject(new ApprovalError("You rejected the payment. Nothing was signed or paid."));
        return send(res, 200, "application/json", JSON.stringify({ ok: true }));
      }
      if (!body.signature || !/^(0x[0-9a-fA-F]+|[1-9A-HJ-NP-Za-km-z]+)$/.test(body.signature)) {
        return send(res, 400, "application/json", JSON.stringify({ ok: false, error: "no signature" }));
      }
      p.resolve(body.signature);
      return send(res, 200, "application/json", JSON.stringify({ ok: true }));
    }

    send(res, 405, "text/plain", "method not allowed");
  }

  private pageData(p: Pending) {
    const info = p.info;
    if (p.req.family === "solana") {
      const chain = CHAINS[p.req.chain];
      return {
        family: "solana" as const,
        token: p.token,
        address: this.solanaAddress(),
        url: info?.url ?? null,
        chainName: chain.name,
        testnet: chain.testnet,
        to: info?.payTo ?? null,
        amount: transferAmount(p.req.messageBytes) ?? (info?.amount ? formatUsdc(BigInt(info.amount)) : null),
        wireTx: p.req.wireTx,
      };
    }
    const td = p.req.typedData;
    const chainId = Number((td.domain as { chainId?: number | bigint }).chainId);
    const chain = CHAINS[`eip155:${chainId}`];
    const msg = td.message as { to?: string; value?: bigint | string };
    return {
      family: "evm" as const,
      token: p.token,
      address: this.evmAddress(),
      url: info?.url ?? null,
      chainId,
      chainName: chain?.name ?? `chain ${chainId}`,
      testnet: chain?.testnet ?? false,
      to: msg.to ?? null,
      amount: msg.value !== undefined ? formatUsdc(BigInt(msg.value)) : null,
      typedData: serializeTypedData({
        ...(td as any),
        types: { EIP712Domain: getTypesForEIP712Domain({ domain: td.domain as any }), ...(td.types as any) },
      }),
    };
  }
}

/** Amount of the SPL `TransferChecked` instruction in a payment transaction, as USDC. */
function transferAmount(messageBytes: Uint8Array): string | null {
  try {
    const msg = getCompiledTransactionMessageDecoder().decode(messageBytes) as { instructions: { data?: Uint8Array }[] };
    for (const ix of msg.instructions) {
      const d = ix.data;
      if (d && d.length === 10 && d[0] === 12) {
        return formatUsdc(new DataView(d.buffer, d.byteOffset, d.length).getBigUint64(1, true));
      }
    }
  } catch {
    // fall back to the 402's amount
  }
  return null;
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

const CHAIN_PARAMS: Record<number, unknown> = {
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
  const chainParams = d.family === "evm" ? (CHAIN_PARAMS[d.chainId] ?? null) : null;
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
$("reject").onclick = async () => { await post({ reject: true }); finish("拒否しました。支払いはしていません。このタブは閉じてかまいません。"); };
async function signSolana() {
  const sol = (window.phantom && window.phantom.solana) || window.solana;
  if (!sol) return msg("Phantom が見つかりません。");
  msg("Phantom を確認しています…");
  const { publicKey } = await sol.connect();
  if (publicKey.toString() !== d.address) return msg("Phantom で " + d.address + " を選んでから、もう一度押してください。");
  const bytes = Uint8Array.from(atob(d.wireTx), (c) => c.charCodeAt(0));
  const tx = solanaWeb3.VersionedTransaction.deserialize(bytes);
  msg("Phantom で承認してください…");
  const signed = await sol.signTransaction(tx);
  const keys = signed.message.staticAccountKeys;
  const i = keys.findIndex((k) => k.toString() === d.address);
  if (i < 0 || !signed.signatures[i]) return msg("署名が見つかりません。");
  return b58(signed.signatures[i]);
}
function b58(bytes) {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
  let s = ""; while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b === 0) s = "1" + s; else break; }
  return s;
}
$("approve").onclick = async () => {
  if (d.family === "solana") {
    try {
      const signature = await signSolana();
      if (!signature) return;
      const r = await post({ signature });
      if (r.ok) finish("署名しました。Claude に戻ってください。このタブは閉じてかまいません。");
      else finish("このリンクは期限切れです。");
    } catch (e) { msg("署名されませんでした：" + (e && e.message ? e.message : e)); }
    return;
  }
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
