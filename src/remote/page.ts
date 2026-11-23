import { CHAINS } from "../chains.js";
import { APPROVAL_CSS, CHAIN_PARAMS } from "../providers/browser.js";
import { phantomBrowseLink, type PendingRecord } from "./payments.js";

// Pinned with Subresource Integrity: the page needs web3.js only to hand Phantom a transaction object.
const SOLANA_WEB3 = {
  src: "https://cdn.jsdelivr.net/npm/@solana/web3.js@1.99.0/lib/index.iife.min.js",
  integrity: "sha384-DjHoHg45N+L5RZPO5p+uK874TyHExfoonwFDUKKpozAERZGg+SY8y+ntxvWd672b",
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function messagePage(title: string, text: string): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AgentPay402</title><style>${APPROVAL_CSS}</style></head><body><main class="card">
<div class="brand"><i></i>AgentPay402</div><p class="lead" style="font-size:16px;color:#fff;margin-top:24px">${esc(title)}</p>
<p class="lead">${esc(text)}</p></main></body></html>`;
}

export function approvalPage(rec: PendingRecord, origin: string): string {
  const chain = CHAINS[rec.network];
  const family = chain.family;
  const chainId = family === "evm" ? Number(rec.network.split(":")[1]) : null;
  const pageUrl = `${origin}/approve/${rec.id}?t=${rec.token}`;
  const d = {
    id: rec.id,
    token: rec.token,
    family,
    address: rec.payer,
    url: rec.input.url,
    amount: rec.priceUsd,
    to: rec.payTo,
    chainName: chain.name,
    chainId,
    chainParams: chainId ? (CHAIN_PARAMS[chainId] ?? null) : null,
    testnet: chain.testnet,
    expiresAt: rec.expiresAt,
    phantom: family === "solana" ? phantomBrowseLink(pageUrl, origin) : null,
  };
  const json = JSON.stringify(d).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>AgentPay402 支払いの承認</title>
<style>${APPROVAL_CSS}
#approve{flex:2}
.applink{display:block;text-align:center;margin-top:12px;font-size:13px;color:var(--accent);text-decoration:none}
</style></head><body>
<main class="card">
<div class="brand"><i></i>AgentPay402</div>
<div class="site"><span class="host" id="host"></span></div>
<p class="lead">Claude がこの API に支払おうとしています</p>
<div class="amount"><b id="amount"></b><span id="chain"></span></div>
<dl class="rows">
<div class="r"><dt>支払い先</dt><dd id="to"></dd></div>
<div class="r"><dt>払う財布</dt><dd id="from"></dd></div>
<div class="r"><dt>API</dt><dd id="url"></dd></div>
</dl>
<p id="testnet" class="warn" hidden>テストネットです。本物のお金は動きません。</p>
<div class="btns"><button id="reject">拒否</button><button id="approve">ウォレットで署名する</button></div>
<p id="msg"></p>
<a id="applink" class="applink" hidden>スマホの方：Phantom アプリで開く</a>
</main>
${family === "solana" ? `<script src="${SOLANA_WEB3.src}" integrity="${SOLANA_WEB3.integrity}" crossorigin="anonymous"></script>` : ""}
<script>
const d = ${json};
const $ = (id) => document.getElementById(id);
const short = (a) => (a && a.length > 16 ? a.slice(0, 6) + "…" + a.slice(-6) : a || "不明");
const setFull = (id, text, full) => { $(id).textContent = text; if (full) $(id).title = full; };
$("host").textContent = new URL(d.url).host;
$("amount").textContent = d.amount + " USDC";
$("chain").textContent = d.chainName + " で支払い";
setFull("to", short(d.to), d.to);
setFull("from", d.address ? short(d.address) : "承認するときに選ぶ財布", d.address);
setFull("url", new URL(d.url).pathname, d.url);
$("testnet").hidden = !d.testnet;
const sol = (window.phantom && window.phantom.solana) || window.solana;
if (d.phantom) { $("applink").href = d.phantom; $("applink").hidden = false; }
const msg = (t, cls = "") => { $("msg").textContent = t; $("msg").className = cls; };
const finish = (t, cls = "ok") => { msg(t, cls); $("approve").disabled = $("reject").disabled = true; };
async function post(action, body = {}) {
  const r = await fetch("/api/approve/" + d.id + "/" + action, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ t: d.token, ...body }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "エラーが起きました。");
  return j;
}
function b58(bytes) {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
  let s = ""; while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b === 0) s = "1" + s; else break; }
  return s;
}
async function connectSolana() {
  if (!sol) throw new Error(d.phantom ? "Phantom が見つかりません。スマホなら下のリンクから Phantom アプリで開いてください。" : "Phantom が見つかりません。");
  const { publicKey } = await sol.connect();
  const me = publicKey.toString();
  if (d.address && me !== d.address) throw new Error("Phantom で " + d.address + " を選んでから、もう一度押してください。");
  d.address = me; setFull("from", short(me), me);
  return async (req) => {
    const tx = solanaWeb3.VersionedTransaction.deserialize(Uint8Array.from(atob(req.wireTx), (c) => c.charCodeAt(0)));
    const signed = await sol.signTransaction(tx);
    const i = signed.message.staticAccountKeys.findIndex((k) => k.toString() === d.address);
    if (i < 0 || !signed.signatures[i]) throw new Error("署名が見つかりません。");
    // Phantom may add its Lighthouse safety instructions; the server checks what changed.
    let bin = ""; for (const x of signed.serialize()) bin += String.fromCharCode(x);
    return { signature: b58(signed.signatures[i]), signedTx: btoa(bin) };
  };
}
async function connectEvm() {
  const eth = window.ethereum;
  if (!eth) throw new Error("ブラウザのウォレット（Rabby、MetaMask など）が見つかりません。");
  const accounts = await eth.request({ method: "eth_requestAccounts" });
  const acct = d.address ? accounts.find((a) => a.toLowerCase() === d.address.toLowerCase()) : accounts[0];
  if (!acct) throw new Error("ウォレットで " + d.address + " を選んでから、もう一度押してください。");
  d.address = acct; setFull("from", short(acct), acct);
  const hex = "0x" + d.chainId.toString(16);
  try { await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] }); }
  catch (e) {
    if (e && e.code === 4902 && d.chainParams) await eth.request({ method: "wallet_addEthereumChain", params: [d.chainParams] });
    else throw e;
  }
  return async (req) => ({ signature: await eth.request({ method: "eth_signTypedData_v4", params: [acct, req.typedData] }) });
}
$("reject").onclick = async () => {
  try { await post("reject"); finish("拒否しました。支払いはしていません。Claude に戻ってください。", ""); }
  catch (e) { msg(e.message, "err"); }
};
$("approve").onclick = async () => {
  $("approve").disabled = true;
  try {
    msg("ウォレットを確認しています…");
    const sign = d.family === "solana" ? await connectSolana() : await connectEvm();
    msg("支払いを用意しています…");
    const req = await post("build", { payer: d.address });
    msg("ウォレットで承認してください…");
    const signed = await sign(req);
    msg("支払っています…");
    const r = await post("sign", signed);
    if (r.status === "fulfilled" || r.status === "recovered_by_retry") finish("支払いました。Claude に戻って「承認した」と伝えてください。");
    else finish("結果：" + r.status + "。Claude に戻って「承認した」と伝えてください。", r.paid === false ? "" : "err");
  } catch (e) {
    $("approve").disabled = false;
    msg("署名されませんでした：" + (e && e.message ? e.message : e), "err");
  }
};
</script></body></html>`;
}
