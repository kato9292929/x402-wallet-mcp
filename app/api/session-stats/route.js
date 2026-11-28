// Share of tool calls that came with an MCP session id issued by this server (no counts, ids or IPs).
import { handleSessionStats } from "../../../dist/remote/http.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handleSessionStats;
