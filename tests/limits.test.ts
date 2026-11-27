import { describe, expect, it, vi } from "vitest";
import { BASE_SEPOLIA } from "../src/chains.js";
import { handleMcp } from "../src/remote/http.js";
import { MAX_PENDING_PER_CONNECTION, RATE_LIMIT_CALLS, RATE_WINDOW_S, clientOf, takeCall } from "../src/remote/limits.js";
import { parseParams } from "../src/remote/params.js";
import { requestPayment, type FlowDeps } from "../src/remote/payments.js";
import { getStore, memoryStore } from "../src/remote/store.js";
import { exactReq, res402 } from "./helpers.js";

const ORIGIN = "https://agentpay.test";
const URL_ = "https://seller.test/api";

const rpc = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });

const parse = async (res: Response) => {
  const text = await res.text();
  return JSON.parse(text.includes("data:") ? text.split("\n").find((l) => l.startsWith("data:"))!.slice(5) : text);
};

describe("MCP session ids", () => {
  it("are issued at initialize and accepted on later requests", async () => {
    const init = await handleMcp(
      rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
    );
    const sid = init.headers.get("mcp-session-id");
    expect(sid).toMatch(/^[0-9a-f]{32}$/);
    expect((await parse(init)).result.serverInfo.name).toBe("agentpay402");
    const list = await handleMcp(rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { "mcp-session-id": sid! }));
    expect(list.ok).toBe(true);
    expect((await parse(list)).result.tools.length).toBeGreaterThan(5);
  });

  it("identify a connection by a hash of the session id, else of the IP (never stored raw)", () => {
    const s = clientOf(new Request(ORIGIN, { headers: { "mcp-session-id": "abc", "x-forwarded-for": "203.0.113.7, 10.0.0.1" } }));
    expect(s).toMatchObject({ bySession: true });
    expect(s.conn).toMatch(/^s:[0-9a-f]{32}$/);
    expect(s.conn).not.toContain("abc");
    const ip = clientOf(new Request(ORIGIN, { headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" } }));
    expect(ip).toMatchObject({ bySession: false });
    expect(ip.conn).toMatch(/^ip:[0-9a-f]{32}$/);
    expect(ip.conn).not.toContain("203.0.113.7");
  });
});

describe("rate limit on tools that fetch a seller's 402", () => {
  it("allows 30 calls per connection in 5 minutes; the 31st is rate_limited with the wait", async () => {
    const store = memoryStore();
    const client = { conn: "s:test", bySession: true };
    const t = 1_000_000_000_000;
    for (let i = 0; i < RATE_LIMIT_CALLS; i++) expect((await takeCall(store, client, t)).ok).toBe(true);
    const over = await takeCall(store, client, t);
    expect(over).toMatchObject({ ok: false, limit: 30 });
    expect(over.retryAfterS).toBeGreaterThan(0);
    expect(over.retryAfterS).toBeLessThanOrEqual(RATE_WINDOW_S);
    // Another connection is not affected.
    expect((await takeCall(store, { conn: "s:other", bySession: true }, t)).ok).toBe(true);
  });

  it("returns blocked / rate_limited from the tool without contacting the seller", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const req = rpc(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "check_seller", arguments: { url: URL_ } } },
      { "mcp-session-id": "rate-test-session" },
    );
    const client = clientOf(req);
    const store = await getStore();
    const start = Math.floor(Date.now() / (RATE_WINDOW_S * 1000)) * RATE_WINDOW_S * 1000;
    await store.set(`ap:rl:${client.conn}:${start}`, RATE_LIMIT_CALLS, RATE_WINDOW_S);
    const out = await parse(await handleMcp(req));
    const body = JSON.parse(out.result.content[0].text);
    expect(out.result.isError).toBe(true);
    expect(body).toMatchObject({ status: "blocked", blocked_reason: "rate_limited", paid: false });
    expect(body.retry_after_s).toBeGreaterThan(0);
    expect(fetchSpy.mock.calls.some(([u]) => String(u).startsWith(URL_))).toBe(false);
    fetchSpy.mockRestore();
  });
});

describe("waiting approval links per connection", () => {
  const deps = (conn: string, store = memoryStore()): FlowDeps => ({
    store,
    client: { conn, bySession: true },
    fetch: (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/.well-known/x402-receipt.json")) return new Response("no", { status: 404 });
      return res402([exactReq("1000", BASE_SEPOLIA)]);
    }) as typeof fetch,
    requesterOverrides: {
      probe: async () => ({ status: "unscored", host: "seller.test" }) as any,
      bazaarPrice: async () => null,
      walletCode: async () => "0x",
    },
  });
  const params = parseParams(new URL(`${ORIGIN}/mcp?network=testnet`)); // no wallet address

  it("stops the 21st link of one connection; another connection is not affected", async () => {
    const store = memoryStore();
    const a = deps("s:a", store);
    for (let i = 0; i < MAX_PENDING_PER_CONNECTION; i++) {
      expect((await requestPayment(params, { url: URL_ }, ORIGIN, a)).status).toBe("awaiting_approval");
    }
    expect(await requestPayment(params, { url: URL_ }, ORIGIN, a)).toMatchObject({ status: "blocked", blocked_reason: "too_many_pending" });
    expect((await requestPayment(params, { url: URL_ }, ORIGIN, deps("s:b", store))).status).toBe("awaiting_approval");
  });
});
