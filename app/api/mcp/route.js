// Remote MCP endpoint (Streamable HTTP). The logic lives in src/remote (compiled to dist/remote).
import { handleMcp } from "../../../dist/remote/http.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const GET = handleMcp;
export const POST = handleMcp;
export const DELETE = handleMcp;
