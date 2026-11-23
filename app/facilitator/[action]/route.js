// x402 facilitator for Solana (supported / verify / settle). Logic in src/facilitator (dist/facilitator).
import { handleFacilitator } from "../../../dist/facilitator/http.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req, { params }) {
  const { action } = await params;
  return handleFacilitator(req, action);
}

export const GET = handle;
export const POST = handle;
