/**
 * Required input declared by the 402 (bazaar extension or accepts[].outputSchema), and
 * whether the request actually carries it. A seller that settles first and then rejects a
 * request for missing input (HTTP 400/405) takes the money for nothing, so we stop before
 * signing.
 *
 * Schema reading ported from kato9292929/seller-probe src/x402.ts inputRequirement
 * (8bc93ed); this version also lists the names and compares them with the request.
 */

export interface DeclaredInput {
  /** HTTP methods the endpoint accepts, when declared. */
  methods: string[] | null;
  query: string[];
  body: string[];
  /** A body is required, without named fields. */
  bodyRequired: boolean;
  source: "bazaar" | "outputSchema" | null;
  /**
   * Query parameters the seller shows only as examples (e.g. `queryParams: { slugs: "bitcoin" }`),
   * not marked required. Not a reason to stop, but sellers that need them answer 400 after settling.
   */
  exampleQuery: string[];
}

/** Example-form query params: values given as plain examples rather than field descriptions. */
function exampleQueryOf(i: any): string[] {
  const q = i?.queryParams;
  if (!q || typeof q !== "object" || Array.isArray(q)) return [];
  return Object.entries(q)
    .filter(([, v]) => v === null || typeof v !== "object")
    .map(([k]) => k);
}

function fromInputSchema(s: any): Omit<DeclaredInput, "source" | "exampleQuery"> | null {
  if (!s || typeof s !== "object" || !s.properties) return null;
  const props = s.properties ?? {};
  const m = props.method;
  const methods: string[] | null = Array.isArray(m?.enum) ? m.enum.map(String) : typeof m?.const === "string" ? [m.const] : null;
  const query: string[] = Array.isArray(props.queryParams?.required) ? props.queryParams.required.map(String) : [];
  const body: string[] = Array.isArray(props.body?.required) ? props.body.required.map(String) : [];
  const bodyRequired = Array.isArray(s.required) && s.required.includes("body");
  return { methods, query, body, bodyRequired };
}

function fromInputInfo(i: any): Omit<DeclaredInput, "source" | "exampleQuery"> | null {
  if (!i || typeof i !== "object") return null;
  const requiredNames = (fields: any) =>
    fields && typeof fields === "object" && !Array.isArray(fields)
      ? Object.entries(fields)
          .filter(([, v]) => (v as any)?.required === true)
          .map(([k]) => k)
      : [];
  return {
    methods: typeof i.method === "string" ? [i.method] : null,
    query: requiredNames(i.queryParams),
    body: requiredNames(i.bodyFields),
    bodyRequired: false,
  };
}

/** What the 402 says the request must carry. Nothing declared means nothing known to be missing. */
export function declaredInput(paymentRequired: Record<string, any>): DeclaredInput {
  const bazaar = paymentRequired?.extensions?.bazaar;
  const fromBazaar = fromInputSchema(bazaar?.schema?.properties?.input) ?? fromInputInfo(bazaar?.info?.input);
  if (fromBazaar) return { ...fromBazaar, source: "bazaar", exampleQuery: exampleQueryOf(bazaar?.info?.input) };
  for (const a of (paymentRequired?.accepts ?? []) as any[]) {
    const os = a?.outputSchema;
    const r = fromInputSchema(os?.input?.type === "object" ? os.input : null) ?? fromInputInfo(os?.input);
    if (r) return { ...r, source: "outputSchema", exampleQuery: exampleQueryOf(os?.input) };
  }
  return { methods: null, query: [], body: [], bodyRequired: false, source: null, exampleQuery: [] };
}

export interface InputCheck {
  ok: boolean;
  missing: string[];
  /** Example query params (not marked required) the request does not set. A warning only. */
  unsetExamples: string[];
  declared: DeclaredInput;
}

/** Compares the declared input with the request about to be paid for. */
export function checkInput(
  paymentRequired: Record<string, any>,
  req: { url: string; method?: string; body?: unknown },
): InputCheck {
  const declared = declaredInput(paymentRequired);
  const missing: string[] = [];
  const method = (req.method ?? "GET").toUpperCase();
  if (declared.methods && declared.methods.length && !declared.methods.map((m) => m.toUpperCase()).includes(method)) {
    missing.push(`method ${declared.methods.join("/")} (request uses ${method})`);
  }
  const params = new URL(req.url).searchParams;
  for (const q of declared.query) if (!params.has(q)) missing.push(`query: ${q}`);
  let body: Record<string, unknown> | null = null;
  if (req.body && typeof req.body === "object" && !Array.isArray(req.body)) body = req.body as Record<string, unknown>;
  else if (typeof req.body === "string") {
    try {
      const parsed = JSON.parse(req.body);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed;
    } catch {
      // not JSON: field names cannot be checked
    }
  }
  const hasBody = req.body !== undefined && req.body !== null && req.body !== "";
  if (declared.bodyRequired && !hasBody) missing.push("body");
  for (const f of declared.body) {
    if (body ? !(f in body) : !(typeof req.body === "string" && hasBody)) missing.push(`body: ${f}`);
  }
  const unsetExamples = declared.exampleQuery.filter((q) => !declared.query.includes(q) && !params.has(q)).map((q) => `query: ${q}`);
  return { ok: missing.length === 0, missing, unsetExamples, declared };
}
