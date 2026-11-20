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
