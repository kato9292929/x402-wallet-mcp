// Remote MCP endpoint (Streamable HTTP): the short connection URL. /api/mcp stays for existing connectors.
import { handleMcp } from "../../dist/remote/http.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const GET = handleMcp;
export const POST = handleMcp;
export const DELETE = handleMcp;
