import { CHAINS } from "../chains.js";
import { APPROVAL_CSS, APPROVAL_FONTS, CHAIN_PARAMS } from "../providers/browser.js";
import { phantomBrowseLink } from "./payments.js";
// Pinned with Subresource Integrity: the page needs web3.js only to hand Phantom a transaction object.
const SOLANA_WEB3 = {
    src: "https://cdn.jsdelivr.net/npm/@solana/web3.js@1.99.0/lib/index.iife.min.js",
    integrity: "sha384-DjHoHg45N+L5RZPO5p+uK874TyHExfoonwFDUKKpozAERZGg+SY8y+ntxvWd672b",
};
const esc = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export function messagePage(title, text) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AgentPay402</title>${APPROVAL_FONTS}<style>${APPROVAL_CSS}</style></head><body><main class="card">
<div class="brand">AgentPay402</div><p class="lead" style="font-size:16px;color:var(--ink);margin-top:24px">${esc(title)}</p>
<p class="lead">${esc(text)}</p></main></body></html>`;
}
export function approvalPage(rec, origin) {
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
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>AgentPay402 — approve a payment</title>
${APPROVAL_FONTS}
<style>${APPROVAL_CSS}
#approve{flex:2}
.applink{display:block;text-align:center;margin-top:12px;font-size:13px;color:var(--muted);text-decoration:underline;text-underline-offset:3px}
.applink:hover{color:var(--ink)}
</style></head><body>
<main class="card">
<div class="brand">AgentPay402</div>
<div class="site"><span class="host" id="host"></span></div>
<p class="lead">Claude wants to pay for this API</p>
<div class="amount"><b id="amount"></b><span id="chain"></span></div>
<dl class="rows">
<div class="r"><dt>Pay to</dt><dd id="to"></dd></div>
<div class="r"><dt>From</dt><dd id="from"></dd></div>
<div class="r"><dt>API</dt><dd id="url"></dd></div>
</dl>
<p id="testnet" class="warn" hidden>Testnet: no real money moves.</p>
<div class="btns"><button id="reject">Reject</button><button id="approve"><span>Sign</span></button></div>
<p id="msg"></p>
<a id="applink" class="applink" hidden>On a phone: open in the Phantom app</a>
</main>
${family === "solana" ? `<script src="${SOLANA_WEB3.src}" integrity="${SOLANA_WEB3.integrity}" crossorigin="anonymous"></script>` : ""}
<script>
const d = ${json};
const $ = (id) => document.getElementById(id);
const short = (a) => (a && a.length > 16 ? a.slice(0, 6) + "…" + a.slice(-6) : a || "unknown");
const setFull = (id, text, full) => { $(id).textContent = text; if (full) $(id).title = full; };
$("host").textContent = new URL(d.url).host;
$("amount").textContent = d.amount + " USDC";
$("chain").textContent = "on " + d.chainName;
setFull("to", short(d.to), d.to);
setFull("from", d.address ? short(d.address) : "The wallet you connect", d.address);
setFull("url", new URL(d.url).pathname, d.url);
$("testnet").hidden = !d.testnet;
const sol = (window.phantom && window.phantom.solana) || window.solana;
if (d.phantom) { $("applink").href = d.phantom; $("applink").hidden = false; }
const msg = (t, cls = "") => { $("msg").textContent = t; $("msg").className = cls; };
const finish = (t, cls = "ok") => { msg(t, cls); $("approve").disabled = $("reject").disabled = true; };
async function post(action, body = {}) {
  const r = await fetch("/api/approve/" + d.id + "/" + action, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ t: d.token, ...body }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "Something went wrong.");
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
  if (!sol) throw new Error(d.phantom ? "Phantom was not found. On a phone, open this page in the Phantom app with the link below." : "Phantom was not found.");
  const { publicKey } = await sol.connect();
  const me = publicKey.toString();
  if (d.address && me !== d.address) throw new Error("Select " + d.address + " in Phantom, then press Sign again.");
  d.address = me; setFull("from", short(me), me);
  return async (req) => {
    const tx = solanaWeb3.VersionedTransaction.deserialize(Uint8Array.from(atob(req.wireTx), (c) => c.charCodeAt(0)));
    const signed = await sol.signTransaction(tx);
    const i = signed.message.staticAccountKeys.findIndex((k) => k.toString() === d.address);
    if (i < 0 || !signed.signatures[i]) throw new Error("The signature was not found.");
    // Phantom may add its Lighthouse safety instructions; the server checks what changed.
    let bin = ""; for (const x of signed.serialize()) bin += String.fromCharCode(x);
    return { signature: b58(signed.signatures[i]), signedTx: btoa(bin) };
  };
}
async function connectEvm() {
  const eth = window.ethereum;
  if (!eth) throw new Error("No browser wallet (Rabby, MetaMask, …) was found.");
  const accounts = await eth.request({ method: "eth_requestAccounts" });
  const acct = d.address ? accounts.find((a) => a.toLowerCase() === d.address.toLowerCase()) : accounts[0];
  if (!acct) throw new Error("Select " + d.address + " in your wallet, then press Sign again.");
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
  try { await post("reject"); finish("Rejected. Nothing was paid. Go back to Claude.", ""); }
  catch (e) { msg(e.message, "err"); }
};
$("approve").onclick = async () => {
  $("approve").disabled = true;
  try {
    msg("Checking your wallet…");
    const sign = d.family === "solana" ? await connectSolana() : await connectEvm();
    msg("Preparing the payment…");
    const req = await post("build", { payer: d.address });
    if (req.payTo && req.payTo !== d.to) {
      // The seller gave a new pay-to address (same amount and network): show it before the wallet asks.
      d.to = req.payTo; setFull("to", short(req.payTo), req.payTo);
      msg("The seller's pay-to address changed to " + short(req.payTo) + ". Check it in your wallet before you approve.");
      await new Promise((r) => setTimeout(r, 1500));
    }
    msg("Approve it in your wallet…");
    const signed = await sign(req);
    msg("Paying…");
    const r = await post("sign", signed);
    if (r.status === "fulfilled" || r.status === "recovered_by_retry") finish("Paid. Go back to Claude and say you approved.");
    else if (r.status === "processing") finish("Sent. The seller has not answered yet, so the result will be checked later. Go back to Claude and say you approved.", "");
    else finish("Result: " + r.status + (r.refusal_reason || r.seller_error ? " (" + (r.refusal_reason || r.seller_error) + ")" : "") + (r.wallet_changes ? " · " + r.wallet_changes : "") + ". Go back to Claude and say you approved.", r.paid === false ? "" : "err");
  } catch (e) {
    $("approve").disabled = false;
    msg("Not signed: " + (e && e.message ? e.message : e), "err");
  }
};
</script></body></html>`;
}
