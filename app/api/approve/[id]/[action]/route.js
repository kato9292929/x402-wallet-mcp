// Called by the approval page: build | sign | reject
import { handleApproveAction } from "../../../../../dist/remote/http.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req, { params }) {
  const { id, action } = await params;
  return handleApproveAction(req, id, action);
}
