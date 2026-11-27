import { describe, expect, it, vi } from "vitest";
import { BASE_SEPOLIA } from "../src/chains.js";
import { handleMcp } from "../src/remote/http.js";
import {
  MAX_PENDING_PER_CONNECTION,
  MAX_SESSIONS_PER_IP,
  RATE_LIMIT_CALLS,
  RATE_LIMIT_CALLS_PER_IP,
  RATE_WINDOW_S,
  clientOf,
  isAnthropicIp,
  newSessionId,
  takeCall,
  validSessionId,
  type Client,
} from "../src/remote/limits.js";
import { parseParams } from "../src/remote/params.js";
import { requestPayment, type FlowDeps } from "../src/remote/payments.js";
import { getStore, memoryStore } from "../src/remote/store.js";
import { exactReq, res402 } from "./helpers.js";

const ORIGIN = "https://agentpay.test";
const URL_ = "https://seller.test/api";
const ANTHROPIC_IP = "160.79.106.10";

const rpc = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
const init = (headers: Record<string, string> = {}) =>
  rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }, headers);

const parse = async (res: Response) => {
  const text = await res.text();
  return JSON.parse(text.includes("data:") ? text.split("\n").find((l) => l.startsWith("data:"))!.slice(5) : text);
};

describe("MCP session ids", () => {
  it("are issued signed at initialize and accepted on later requests", async () => {
    const res = await handleMcp(init({ "x-vercel-forwarded-for": "198.51.100.1" }));
    const sid = res.headers.get("mcp-session-id");
    expect(sid).toMatch(/^[0-9a-f]{32}\.[0-9a-f]{32}$/);
    expect(validSessionId(sid!)).toBe(true);
    expect((await parse(res)).result.serverInfo.name).toBe("agentpay402");
    const list = await handleMcp(rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { "mcp-session-id": sid! }));
    expect(list.ok).toBe(true);
    expect((await parse(list)).result.tools.length).toBeGreaterThan(5);
  });

  it("made-up or altered ids are not counted as sessions: the caller is counted by IP", () => {
    const sid = newSessionId();
    const forged = sid.slice(0, -1) + (sid.endsWith("0") ? "1" : "0");
    for (const id of ["abc", "0".repeat(32), `${"1".repeat(32)}.${"2".repeat(32)}`, forged]) {
      expect(validSessionId(id)).toBe(false);
      const c = clientOf(new Request(ORIGIN, { headers: { "mcp-session-id": id, "x-vercel-forwarded-for": "203.0.113.7" } }));
      expect(c.bySession).toBe(false);
      expect(c.conn).toBe(c.ip);
    }
  });

  it("identify a connection by a hash of the session id, else of the IP (never stored raw)", () => {
    const sid = newSessionId();
    const s = clientOf(new Request(ORIGIN, { headers: { "mcp-session-id": sid, "x-forwarded-for": "203.0.113.7, 10.0.0.1" } }));
    expect(s).toMatchObject({ bySession: true, anthropic: false });
    expect(s.conn).toMatch(/^s:[0-9a-f]{32}$/);
    expect(s.conn).not.toContain(sid.slice(0, 32));
    expect(s.ip).toMatch(/^ip:[0-9a-f]{32}$/);
    expect(s.ip).not.toContain("203.0.113.7");
  });

  it("limits ids issued per IP; over that, initialize still works but no id is issued", async () => {
    const ip = "198.51.100.77";
    for (let i = 0; i < MAX_SESSIONS_PER_IP; i++) {
      expect((await handleMcp(init({ "x-vercel-forwarded-for": ip }))).headers.get("mcp-session-id")).toBeTruthy();
    }
    const over = await handleMcp(init({ "x-vercel-forwarded-for": ip }));
    expect(over.ok).toBe(true);
    expect(over.headers.get("mcp-session-id")).toBeNull();
    // Anthropic's IPs (shared by Claude.ai users) get far more.
    for (let i = 0; i < MAX_SESSIONS_PER_IP + 5; i++) {
      expect((await handleMcp(init({ "x-vercel-forwarded-for": ANTHROPIC_IP }))).headers.get("mcp-session-id")).toBeTruthy();
    }
  });

  it("knows Anthropic's published outbound ranges", () => {
    expect(isAnthropicIp("160.79.104.0")).toBe(true);
    expect(isAnthropicIp("160.79.111.255")).toBe(true);
    expect(isAnthropicIp("160.79.112.0")).toBe(false);
    expect(isAnthropicIp("153.61.208.1")).toBe(true);
    expect(isAnthropicIp("153.61.223.255")).toBe(true);
    expect(isAnthropicIp("153.61.224.0")).toBe(false);
    expect(isAnthropicIp("8.8.8.8")).toBe(false);
    expect(isAnthropicIp("not-an-ip")).toBe(false);
  });
});

const session = (name: string, ip = "ip:x", anthropic = false): Client => ({ conn: `s:${name}`, bySession: true, ip, anthropic });

describe("rate limit on tools that fetch a seller's 402", () => {
  const t = 1_000_000_000_000;

  it("allows 30 calls per session in 5 minutes; the 31st is rate_limited with the wait", async () => {
    const store = memoryStore();
    const client = session("a", "ip:a", true);
    for (let i = 0; i < RATE_LIMIT_CALLS; i++) expect((await takeCall(store, client, t)).ok).toBe(true);
    const over = await takeCall(store, client, t);
    expect(over).toMatchObject({ ok: false, limit: 30 });
    expect(over.retryAfterS).toBeGreaterThan(0);
    expect(over.retryAfterS).toBeLessThanOrEqual(RATE_WINDOW_S);
    // Another session from the same (Anthropic) IP is not affected.
    expect((await takeCall(store, session("b", "ip:a", true), t)).ok).toBe(true);
  });

  it("outside Anthropic's ranges, new sessions from one IP do not give new calls", async () => {
    const store = memoryStore();
    let i = 0;
    for (; i < RATE_LIMIT_CALLS_PER_IP; i++) expect((await takeCall(store, session(`n${i}`, "ip:z"), t)).ok).toBe(true);
    expect(await takeCall(store, session(`n${i}`, "ip:z"), t)).toMatchObject({ ok: false, limit: RATE_LIMIT_CALLS_PER_IP });
    expect((await takeCall(store, session("other", "ip:y"), t)).ok).toBe(true);
  });

  it("returns blocked / rate_limited from the tool without contacting the seller", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const req = rpc(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "check_seller", arguments: { url: URL_ } } },
      { "mcp-session-id": newSessionId(), "x-vercel-forwarded-for": ANTHROPIC_IP },
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
  const deps = (client: Client, store = memoryStore()): FlowDeps => ({
    store,
    client,
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
    const a = deps(session("a", "ip:anthropic", true), store);
    for (let i = 0; i < MAX_PENDING_PER_CONNECTION; i++) {
      expect((await requestPayment(params, { url: URL_ }, ORIGIN, a)).status).toBe("awaiting_approval");
    }
    expect(await requestPayment(params, { url: URL_ }, ORIGIN, a)).toMatchObject({ status: "blocked", blocked_reason: "too_many_pending" });
    expect((await requestPayment(params, { url: URL_ }, ORIGIN, deps(session("b", "ip:anthropic", true), store))).status).toBe(
      "awaiting_approval",
    );
  });

  it("outside Anthropic's ranges, one IP gets 20 links in all, however many sessions it opens", async () => {
    const store = memoryStore();
    for (let i = 0; i < MAX_PENDING_PER_CONNECTION; i++) {
      expect((await requestPayment(params, { url: URL_ }, ORIGIN, deps(session(`n${i}`, "ip:z"), store))).status).toBe("awaiting_approval");
    }
    expect(await requestPayment(params, { url: URL_ }, ORIGIN, deps(session("new", "ip:z"), store))).toMatchObject({
      status: "blocked",
      blocked_reason: "too_many_pending",
    });
    expect((await requestPayment(params, { url: URL_ }, ORIGIN, deps(session("c", "ip:y"), store))).status).toBe("awaiting_approval");
  });
});
