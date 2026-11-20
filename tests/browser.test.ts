import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { BrowserWalletProvider } from "../src/providers/browser.js";
import { buildX402Client } from "../src/providers/index.js";
import { exactReq, paymentRequired } from "./helpers.js";

const owner = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());

/** Reads the approval page the way the browser would and returns its data. */
async function openPage(url: string) {
  const html = await (await fetch(url)).text();
  const json = /const d = (\{.*\});\n/.exec(html)?.[1];
  if (!json) throw new Error("no page data");
  return JSON.parse(json) as { token: string; typedData: string; amount: string; to: string; url: string; chainName: string };
}

async function post(url: string, body: unknown) {
  const u = new URL(url);
  return fetch(`${u.origin}${u.pathname}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

let provider: BrowserWalletProvider | undefined;
beforeEach(() => {
  process.env.BROWSER_WALLET_ADDRESS = owner.address;
});
afterEach(async () => {
  await provider?.close();
  delete process.env.BROWSER_WALLET_ADDRESS;
});

async function pay(onOpen: (url: string) => Promise<void>, timeoutMs = 5000) {
  provider = new BrowserWalletProvider("testnet", { open: (u) => void onOpen(u).catch(() => {}), timeoutMs });
  provider.beforeSign({ url: "https://seller.test/api" });
  const client = await buildX402Client(provider);
  return client.createPaymentPayload(paymentRequired([exactReq("5000")]) as any);
}

describe("browser wallet provider", () => {
  it("signs only after the user signs on the approval page", async () => {
    let seen: Awaited<ReturnType<typeof openPage>> | undefined;
    const payload = await pay(async (url) => {
      seen = await openPage(url);
      const typed = JSON.parse(seen.typedData);
      const { EIP712Domain, ...types } = typed.types;
      const signature = await owner.signTypedData({ ...typed, types });
      await post(url, { t: seen.token, signature });
    });
    expect(seen).toMatchObject({ amount: "0.005", url: "https://seller.test/api", chainName: "Base Sepolia" });
    expect((payload.payload as any).authorization.from).toBe(owner.address);
    expect((payload.payload as any).signature).toMatch(/^0x/);
  });

  it("refuses when the user rejects", async () => {
    await expect(
      pay(async (url) => {
        const d = await openPage(url);
        await post(url, { t: d.token, reject: true });
      }),
    ).rejects.toMatchObject({ name: "ApprovalError" });
  });

  it("refuses a signature from another wallet", async () => {
    await expect(
      pay(async (url) => {
        const d = await openPage(url);
        const typed = JSON.parse(d.typedData);
        const { EIP712Domain, ...types } = typed.types;
        await post(url, { t: d.token, signature: await stranger.signTypedData({ ...typed, types }) });
      }),
    ).rejects.toThrow(/signed by/);
  });

  it("refuses a wrong token and times out", async () => {
    await expect(
      pay(async (url) => {
        const r = await post(url, { t: "wrong", reject: true });
        expect(r.status).toBe(404);
      }, 300),
    ).rejects.toThrow(/not approved in time/);
  });
});

describe("browser wallet provider: Solana (Phantom)", () => {
  it("accepts Phantom's signature for exactly this transaction, and nothing else", async () => {
    const web3 = await import("@solana/web3.js");
    const { getBase58Decoder } = await import("@solana/kit");
    const user = web3.Keypair.generate();
    const other = web3.Keypair.generate();
    const feePayer = web3.Keypair.generate().publicKey;
    process.env.BROWSER_SOLANA_ADDRESS = user.publicKey.toBase58();
    delete process.env.BROWSER_WALLET_ADDRESS;

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
    const tx = {
      messageBytes: message.serialize(),
      signatures: { [feePayer.toBase58()]: null, [user.publicKey.toBase58()]: null },
    };

    const phantomSign = (signer: InstanceType<typeof web3.Keypair>) => async (url: string) => {
      const d = (await openPage(url)) as any;
      expect(d).toMatchObject({ family: "solana", amount: "0.005", chainName: "Solana Devnet" });
      const vtx = web3.VersionedTransaction.deserialize(Buffer.from(d.wireTx, "base64"));
      vtx.sign([signer]);
      const i = vtx.message.staticAccountKeys.findIndex((k) => k.equals(user.publicKey));
      const sig = getBase58Decoder().decode(signer === user ? vtx.signatures[i] : vtx.signatures[vtx.message.staticAccountKeys.findIndex((k) => k.equals(user.publicKey))] ?? new Uint8Array(64));
      await post(url, { t: d.token, signature: sig });
    };

    provider = new BrowserWalletProvider("testnet", { open: (u) => void phantomSign(user)(u).catch(() => {}), timeoutMs: 5000 });
    expect(provider.chains()).toEqual(["solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"]);
    const signer = (await provider.solanaSigner()) as any;
    const [dict] = await signer.signTransactions([tx]);
    expect(web3.PublicKey.default).toBeDefined();
    expect(dict[user.publicKey.toBase58()]).toHaveLength(64);
    await provider.close();

    // A signature made over a different message is refused.
    provider = new BrowserWalletProvider("testnet", {
      open: (u) =>
        void (async () => {
          const d = (await openPage(u)) as any;
          const fake = getBase58Decoder().decode(web3.Keypair.generate().secretKey.slice(0, 64));
          await post(u, { t: d.token, signature: fake });
        })().catch(() => {}),
      timeoutMs: 5000,
    });
    const signer2 = (await provider.solanaSigner()) as any;
    await expect(signer2.signTransactions([tx])).rejects.toThrow(/does not match/);
    void other;
    delete process.env.BROWSER_SOLANA_ADDRESS;
  });
});
