import { getStore } from "../remote/store.js";
import { FacilitatorConfigError, getFacilitator, settle, verify } from "./index.js";

/**
 * x402 facilitator HTTP API, as @x402/core's HTTPFacilitatorClient calls it:
 *   GET  /facilitator/supported
 *   POST /facilitator/verify   { x402Version, paymentPayload, paymentRequirements }
 *   POST /facilitator/settle   { x402Version, paymentPayload, paymentRequirements }
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export async function handleFacilitator(req: Request, action: string): Promise<Response> {
  let setup;
  try {
    setup = await getFacilitator();
  } catch (err) {
    if (err instanceof FacilitatorConfigError) return json({ error: err.message }, 503);
    throw err;
  }
  if (action === "supported" && req.method === "GET") return json(setup.facilitator.getSupported());
  if ((action === "verify" || action === "settle") && req.method === "POST") {
    let body: { paymentPayload?: any; paymentRequirements?: any };
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid JSON" }, 400);
    }
    if (!body?.paymentPayload || !body?.paymentRequirements) return json({ error: "paymentPayload and paymentRequirements are required" }, 400);
    try {
      if (action === "verify") return json(await verify(setup, body.paymentPayload, body.paymentRequirements));
      return json(await settle(setup, body.paymentPayload, body.paymentRequirements, await getStore()));
    } catch (err) {
      console.error("[agentpay402] facilitator", action, err);
      return json({ error: (err as Error).message ?? "error" }, 500);
    }
  }
  return json({ error: "not found" }, 404);
}
