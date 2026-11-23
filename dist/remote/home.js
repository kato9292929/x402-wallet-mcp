import { APPROVAL_CSS } from "../providers/browser.js";
/**
 * The how-to page at "/": make your connection URL (from your Phantom address), add it to Claude,
 * and approve a first payment. Claude's UI labels follow the Japanese help article
 * https://support.claude.com/ja/articles/11175166 .
 */
export function homePage(origin) {
    const json = JSON.stringify({ origin }).replace(/</g, "\\u003c");
    return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AgentPay402 の使い方</title>
<meta name="description" content="Claude に、あなたの Phantom で有料 API を買わせる。払うたびにあなたが承認します。">
<style>${APPROVAL_CSS}
body{display:block;padding:32px 16px}
.wrap{max-width:560px;margin:0 auto}
h1{font-size:26px;margin:18px 0 8px;letter-spacing:-.01em}
.sub{color:var(--sub);font-size:15px;line-height:1.7;margin:0 0 24px}
.step{background:var(--card);border-radius:20px;padding:20px;margin:0 0 16px}
.step h2{font-size:17px;margin:0 0 12px;display:flex;gap:10px;align-items:center}
.num{flex:none;width:26px;height:26px;border-radius:50%;background:var(--accent);color:var(--accent-ink);display:inline-flex;align-items:center;justify-content:center;font-size:14px;font-weight:700}
.step p,.step li{font-size:15px;line-height:1.75;color:#ddd}
.step ol{margin:0;padding-left:1.3em}
b.ui{color:#fff;background:#2c2c2c;border-radius:6px;padding:1px 7px;font-weight:600;overflow-wrap:anywhere}
label{display:block;font-size:13px;color:var(--sub);margin:14px 0 6px}
input[type=text]{width:100%;font:inherit;font-size:15px;padding:12px 14px;border-radius:12px;border:1px solid #333;background:#111;color:#fff}
.row{display:flex;gap:10px;flex-wrap:wrap}
.row button{flex:1;min-width:140px}
#connect{background:var(--accent);color:var(--accent-ink)}
.sec{background:#333;color:#fff}
.out{margin-top:14px;padding:12px 14px;border-radius:12px;background:#111;border:1px solid #333;font-size:13px;word-break:break-all;color:#cfc8ff;min-height:44px}
.radio{display:flex;gap:16px;font-size:15px;margin-top:6px}
.note{font-size:13px;color:var(--sub);line-height:1.7}
details summary{cursor:pointer;color:var(--sub);font-size:14px;margin-top:12px}
.err{color:#ff8a8a;font-size:13px;min-height:18px;margin-top:8px}
</style></head><body><div class="wrap">
<div class="brand"><i></i>AgentPay402</div>
<h1>Claude に、あなたの財布で<br>有料の API を買わせる</h1>
<p class="sub">Claude がデータなどの有料 API を使うとき、代金を USDC で払えるようにします。払うたびに、あなたが Phantom で「承認」を押します。押さなければ、1円も動きません。</p>

<section class="step">
<h2><span class="num">1</span>あなた専用の URL を作る</h2>
<p>Phantom（パソコンのブラウザ拡張）を入れているなら、ボタンを押すだけです。</p>
<div class="row"><button id="connect">Phantom から読み込む</button></div>
<label for="sol">または、Phantom の Solana アドレスを貼る</label>
<input id="sol" type="text" placeholder="例：4s8XQC2WzRfgH8Xiep7ybnCW11VKRCMwxQF6jknx3VPf" autocomplete="off" spellcheck="false">
<details><summary>Base（Rabby・MetaMask）でも払う場合</summary>
<label for="base">Rabby / MetaMask のアドレス（0x から始まるもの）</label>
<input id="base" type="text" placeholder="0x..." autocomplete="off" spellcheck="false">
</details>
<label>使うお金</label>
<div class="radio"><label style="margin:0;color:#ddd"><input type="radio" name="net" value="mainnet" checked> 本物の USDC</label>
<label style="margin:0;color:#ddd"><input type="radio" name="net" value="testnet"> 試し用（テストネット）</label></div>
<div class="err" id="err"></div>
<label>あなたの URL</label>
<div class="out" id="url">アドレスを入れると、ここに出ます</div>
<div class="row" style="margin-top:12px"><button id="copy" class="sec" disabled>URL をコピー</button></div>
<p class="note">この URL には、あなたの財布のアドレス（公開されている番号）だけが入っています。秘密の鍵やパスワードは入っていません。</p>
</section>

<section class="step">
<h2><span class="num">2</span>Claude に登録する</h2>
<ol>
<li>Claude（claude.ai）を開き、<b class="ui">カスタマイズ</b> → <b class="ui">コネクタ</b> に進む。</li>
<li><b class="ui">+ 追加</b> → <b class="ui">カスタムコネクタを追加</b> を押す。</li>
<li>名前に <b class="ui">AgentPay402</b> と入れる。</li>
<li>URL の欄に、1 でコピーした URL を貼り、<b class="ui">続行</b> を押す。</li>
<li>もう一度 <b class="ui">続行</b> を押し、認証で <b class="ui">サインインなし</b> を選ぶ。</li>
<li><b class="ui">追加</b> を押して完了。</li>
</ol>
<p class="note">無料プランでも 1 つまで追加できます。会社のプラン（Team・Enterprise）では、管理者が <b class="ui">組織設定</b> → <b class="ui">コネクタ</b> から追加します。</p>
</section>

<section class="step">
<h2><span class="num">3</span>チャットでオンにする</h2>
<p>チャット欄の左下の <b class="ui">+</b> → <b class="ui">コネクタ</b> を開き、<b class="ui">AgentPay402</b> のスイッチをオンにします。</p>
</section>

<section class="step">
<h2><span class="num">4</span>使ってみる</h2>
<ol>
<li>Claude に「<b class="ui">https://api.losbeto.xyz/ping402 を買って</b>」と頼む（0.001 USDC の試し用 API です）。</li>
<li>Claude が出す承認のリンクを開く。</li>
<li>金額と支払い先を確かめて <b class="ui">ウォレットで署名する</b> を押し、Phantom で承認する。</li>
<li>Claude に「<b class="ui">承認した</b>」と伝える。Claude が結果を受け取ります。</li>
</ol>
<p class="note">スマホのときは、承認ページの「Phantom アプリで開く」から承認できます。承認しないまま 5 分たつと、その支払いは消えます。</p>
</section>

<section class="step">
<h2><span class="num">✓</span>安心して使うために</h2>
<ul style="margin:0;padding-left:1.2em">
<li>AgentPay402 は、あなたの鍵を預かりません。払うのは、あなたが Phantom で承認したときだけです。</li>
<li>1 回に払える額は 0.10 ドルまで、24 時間で 1.00 ドルまでです。Claude がこの上限を変えることはできません。</li>
<li>払う前に、売り手が過去にちゃんと納品しているかを確かめます。払った後は、送金が本当に届いたかを確かめます。</li>
<li>アドレスを変えたいときは、コネクタを削除して、新しい URL で追加し直してください。</li>
</ul>
</section>
</div>
<script>
const d = ${json};
const $ = (id) => document.getElementById(id);
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, EVM = /^0x[0-9a-fA-F]{40}$/;
let url = "";
function update() {
  const sol = $("sol").value.trim(), base = $("base").value.trim();
  const net = document.querySelector('input[name=net]:checked').value;
  $("err").textContent = "";
  url = "";
  if (sol && !B58.test(sol)) $("err").textContent = "Solana のアドレスの形が違います。Phantom からもう一度コピーしてください。";
  else if (base && !EVM.test(base)) $("err").textContent = "Base のアドレスは 0x から始まる 42 文字です。";
  else if (sol || base) {
    const q = new URLSearchParams();
    if (sol) q.set("solana", sol);
    if (base) q.set("base", base);
    q.set("network", net);
    url = d.origin + "/api/mcp?" + q.toString();
  }
  $("url").textContent = url || "アドレスを入れると、ここに出ます";
  $("copy").disabled = !url;
}
["sol", "base"].forEach((id) => $(id).addEventListener("input", update));
document.querySelectorAll("input[name=net]").forEach((r) => r.addEventListener("change", update));
$("connect").onclick = async () => {
  const p = (window.phantom && window.phantom.solana) || window.solana;
  if (!p) { $("err").textContent = "Phantom が見つかりません。アドレスを下の欄に貼ってください。"; return; }
  try { const { publicKey } = await p.connect(); $("sol").value = publicKey.toString(); update(); }
  catch (e) { $("err").textContent = "Phantom から読み込めませんでした。アドレスを下の欄に貼ってください。"; }
};
$("copy").onclick = async () => {
  try { await navigator.clipboard.writeText(url); $("copy").textContent = "コピーしました"; setTimeout(() => ($("copy").textContent = "URL をコピー"), 1500); }
  catch { $("err").textContent = "コピーできませんでした。上の URL を選んでコピーしてください。"; }
};
</script></body></html>`;
}
