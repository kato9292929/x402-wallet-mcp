import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { BrowserWalletProvider } from "../src/providers/browser.js";
import { buildX402Client } from "../src/providers/index.js";
import { BASE_SEPOLIA, SOLANA_DEVNET } from "../src/chains.js";
import { exactReq, paymentRequired } from "./helpers.js";

const owner = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());

type Page = { token: string; amount: string | null; to: string | null; url: string | null; chainName: string; family: string };

/** Reads the approval page the way the browser would and returns its data. */
async function openPage(url: string): Promise<Page> {
  const html = await (await fetch(url)).text();
  const json = /const d = (\{.*\});\n/.exec(html)?.[1];
  if (!json) throw new Error("no page data");
  return JSON.parse(json);
}

async function post(url: string, body: unknown) {
  const u = new URL(url);
  return fetch(`${u.origin}${u.pathname}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

/** What the page does after the approve click: wait for the payment to be built. */
async function waitForPayment(url: string, token: string) {
  const u = new URL(url);
  for (let i = 0; i < 100; i++) {
    const r = await (await fetch(`${u.origin}${u.pathname}/request?t=${token}`)).json();
    if (r.state === "ready") return r;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error("payment never built");
}

/** A user who approves, then signs with `sign`. */
const approvesWith = (sign: (req: any) => Promise<string>, seen?: (p: Page) => void) => async (url: string) => {
  const page = await openPage(url);
  seen?.(page);
  await post(url, { t: page.token, action: "approve" });
  const req = await waitForPayment(url, page.token);
  await post(url, { t: page.token, action: "signature", signature: await sign(req) });
};

const evmSign = (account: typeof owner) => async (req: any) => {
  const typed = JSON.parse(req.typedData);
  const { EIP712Domain, ...types } = typed.types;
  return account.signTypedData({ ...typed, types });
};

let provider: BrowserWalletProvider | undefined;
beforeEach(() => {
  process.env.BROWSER_WALLET_ADDRESS = owner.address;
  delete process.env.BROWSER_SOLANA_ADDRESS;
});
afterEach(async () => {
  await provider?.close();
  delete process.env.BROWSER_WALLET_ADDRESS;
  delete process.env.BROWSER_SOLANA_ADDRESS;
});

/** The order request.ts uses: beforeSign (page, approve click), then build and sign. */
async function pay(user: (url: string) => Promise<void>, timeoutMs = 5000) {
  provider = new BrowserWalletProvider("testnet", { open: (u) => void user(u).catch(() => {}), timeoutMs, signTimeoutMs: timeoutMs });
  const req = exactReq("5000");
  await provider.beforeSign({ url: "https://seller.test/api", network: BASE_SEPOLIA, amount: req.amount, payTo: req.payTo });
  const client = await buildX402Client(provider);
  return client.createPaymentPayload(paymentRequired([req]) as any);
}

describe("browser wallet provider: Base", () => {
  it("builds the payment only after the approve click, then takes the wallet's signature", async () => {
    let page: Page | undefined;
    const payload = await pay(approvesWith(evmSign(owner), (p) => (page = p)));
    expect(page).toMatchObject({ amount: "0.005", url: "https://seller.test/api", chainName: "Base Sepolia" });
    expect((payload.payload as any).authorization.from).toBe(owner.address);
  });

  it("does not build or sign anything when the user rejects", async () => {
    await expect(
      pay(async (url) => {
        const p = await openPage(url);
        await post(url, { t: p.token, action: "reject" });
      }),
    ).rejects.toMatchObject({ name: "ApprovalError" });
  });

  it("refuses a signature from another wallet", async () => {
    await expect(pay(approvesWith(evmSign(stranger)))).rejects.toThrow(/signed by/);
  });

  it("refuses a wrong token and times out", async () => {
    await expect(
      pay(async (url) => {
        const r = await post(url, { t: "wrong", action: "approve" });
        expect(r.status).toBe(404);
      }, 300),
    ).rejects.toThrow(/not approved in time/);
  });

  it("refuses when the payment to sign differs from the approved amount", async () => {
    provider = new BrowserWalletProvider("testnet", { open: (u) => void approvesWith(evmSign(owner))(u).catch(() => {}), timeoutMs: 5000 });
    await provider.beforeSign({ url: "https://seller.test/api", network: BASE_SEPOLIA, amount: "1000" });
    const client = await buildX402Client(provider);
    await expect(client.createPaymentPayload(paymentRequired([exactReq("5000")]) as any)).rejects.toThrow(/differs from the amount you approved/);
  });
});

describe("browser wallet provider: Solana (Phantom)", () => {
  it("accepts Phantom's signature for exactly this transaction, and nothing else", async () => {
    const web3 = await import("@solana/web3.js");
    const { getBase58Decoder } = await import("@solana/kit");
    const user = web3.Keypair.generate();
    const feePayer = web3.Keypair.generate().publicKey;
    delete process.env.BROWSER_WALLET_ADDRESS;
    process.env.BROWSER_SOLANA_ADDRESS = user.publicKey.toBase58();

    // A TransferChecked-shaped instruction: tag 12, amount 5000 (u64 LE), decimals 6.
    const data = Buffer.alloc(10);
    data[0] = 12;
    data.writeBigUInt64LE(5000n, 1);
    data[9] = 6;
    const ix = new web3.TransactionInstruction({
      programId: new web3.PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      keys: [{ pubkey: user.publicKey, isSigner: true, isWritable: false }],
      data,
    });
    const message = new web3.TransactionMessage({
      payerKey: feePayer,
      recentBlockhash: web3.Keypair.generate().publicKey.toBase58(),
      instructions: [ix],
    }).compileToV0Message();
    const tx = { messageBytes: message.serialize(), signatures: { [feePayer.toBase58()]: null, [user.publicKey.toBase58()]: null } };

    const phantom = (signer: InstanceType<typeof web3.Keypair>) => async (req: any) => {
      const vtx = web3.VersionedTransaction.deserialize(Buffer.from(req.wireTx, "base64"));
      vtx.sign([signer]);
      const i = vtx.message.staticAccountKeys.findIndex((k) => k.equals(user.publicKey));
      return getBase58Decoder().decode(vtx.signatures[i]);
    };

    let page: Page | undefined;
    provider = new BrowserWalletProvider("testnet", {
      open: (u) => void approvesWith(phantom(user), (p) => (page = p))(u).catch(() => {}),
      timeoutMs: 5000,
    });
    expect(provider.chains()).toEqual([SOLANA_DEVNET]);
    await provider.beforeSign({ url: "https://seller.test/api", network: SOLANA_DEVNET, amount: "5000", payTo: "seller" });
    const [dict] = await ((await provider.solanaSigner()) as any).signTransactions([tx]);
    expect(page).toMatchObject({ family: "solana", amount: "0.005", chainName: "Solana Devnet" });
    expect(dict[user.publicKey.toBase58()]).toHaveLength(64);
    await provider.close();

    // A signature from another key is refused.
    provider = new BrowserWalletProvider("testnet", {
      open: (u) => void approvesWith(async () => getBase58Decoder().decode(web3.Keypair.generate().secretKey.slice(0, 64)))(u).catch(() => {}),
      timeoutMs: 5000,
    });
    await provider.beforeSign({ url: "https://seller.test/api", network: SOLANA_DEVNET, amount: "5000" });
    await expect(((await provider.solanaSigner()) as any).signTransactions([tx])).rejects.toThrow(/does not match/);
  });
});
