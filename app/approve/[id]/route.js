// Approval page: /approve/<request id>?t=<token>
import { handleApprovePage } from "../../../dist/remote/http.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req, { params }) {
  const { id } = await params;
  return handleApprovePage(req, id);
}
