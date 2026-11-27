/**
 * What real payments through AgentPay have shown (Phantom on Solana, Rabby / MetaMask on Base,
 * 2026-11-24..27). Used to pick the network a payment will go through, and listed on the front page.
 */

export interface VerifiedPayment {
  name: string;
  host: string;
  category: string;
  /** Method and path; omitted when the transaction alone does not say which endpoint of the seller it was. */
  endpoint?: string;
  network: "base" | "solana";
  priceUsd: string;
  /** Explorer link to the payment. */
  tx: string;
}

/** Paid and delivered through AgentPay, checked on chain. The front page lists the same entries. */
export const VERIFIED_PAYMENTS: VerifiedPayment[] = [
  { name: "Agent Data", host: "agent-data-api.agentdata.workers.dev", category: "Contract opportunities", endpoint: "GET /v1/contracts/opportunities", network: "base", priceUsd: "0.01", tx: "https://basescan.org/tx/0xe9baa1000060c93d79ebacc35a3db894f52e2671ba93e78222e846652042372f" },
  { name: "NZ Data", host: "nzdata.zakwins.workers.dev", category: "New Zealand working days", endpoint: "GET /nz/working-days", network: "base", priceUsd: "0.002", tx: "https://basescan.org/tx/0xd51cc1a2c54250718530493ee4875316b7725f4b3bbcb5ddab82a6beb05b64c6" },
  { name: "WebberSites", host: "api.webbersites.com", category: "Data API", network: "base", priceUsd: "0.001", tx: "https://basescan.org/tx/0xc6f80351e8513659f0622c432903ea32e0a9e2ece3a744a98969d9237fa4d611" },
  { name: "kagurazaka", host: "kagurazaka.dev", category: "AI and Base tools", network: "base", priceUsd: "0.002", tx: "https://basescan.org/tx/0x736357bdbdf018b2d95346c77f048a1cfdaec6fc997eed1307056feb79f82f55" },
  { name: "WickedAPI", host: "api.wickedapi.com", category: "Trading data", network: "base", priceUsd: "0.001", tx: "https://basescan.org/tx/0xd27f81696e413792ff0966c046d042b5dace4ccdc36330847a82605f75200fea" },
  { name: "Exa", host: "api.exa.ai", category: "Web search", endpoint: "POST /search", network: "base", priceUsd: "0.007", tx: "https://basescan.org/tx/0x01a3a1a64b6b2c459efabbdb2e1d4e588c4dda248b47d528c1b3e6b718054108" },
  { name: "Exa", host: "api.exa.ai", category: "Page contents", endpoint: "POST /contents", network: "base", priceUsd: "0.001", tx: "https://basescan.org/tx/0x060f7b97604bfc7d4bdb902ac27c44070761daffbd0a1b1c19541353239a3c76" },
  { name: "Nansen", host: "api.nansen.ai", category: "On-chain analytics", endpoint: "POST /api/v1/tgm/holders", network: "solana", priceUsd: "0.05", tx: "https://solscan.io/tx/5J7VaDxG25LesWaDo5WbKCdwVB8pdi5FasSvvMa5TjXBz696sVgMDCUgbwaob3ZYVxbxVPq7fHXydtvguXYvRmkg" },
  { name: "Nansen", host: "api.nansen.ai", category: "Smart money netflow", endpoint: "POST /api/v1/smart-money/netflow", network: "solana", priceUsd: "0.05", tx: "https://solscan.io/tx/5K85bZBitrHFibPncEqoqvpyhwqS43CCpsc4s7wr1NB63KcmrmnYnMqnK7Lu2ZmhgRaCL6Zm69Tpi12bSBB3CczW" },
  { name: "citable.run", host: "citable.run", category: "Search results", endpoint: "GET /v1/serp", network: "solana", priceUsd: "0.008", tx: "https://solscan.io/tx/3auH8ZzywTQFpgNNq3B4VCadKAC9yYHSAh3KHPNfMVsnZogzCMzLR4VAA67NqL6KM2eShSp6HLVJLCERmqS6ntgF" },
  { name: "losbeto", host: "api.losbeto.xyz", category: "SEC filings", endpoint: "GET /sec-filing", network: "solana", priceUsd: "0.05", tx: "https://solscan.io/tx/3GAKNzJcLKQNbzxu79jfC32euYJnmABTkay9fkRLcfCBcVKzTY8Bkgx3nyCagMFsk26Qet83xi8rRhiCFrDxm2kQ" },
  { name: "Tanod", host: "tanod.dev", category: "Token price and liquidity", endpoint: "POST /v1/solana/token-price", network: "solana", priceUsd: "0.005", tx: "https://solscan.io/tx/2Jbn6jBqwAGjywmoQYMfR9Z7HfaSmS6rPSbQcR7RngNtPxkKhZhzqB78qLEHfYRvkK1JubdFut2VFaUUZYbDWtMF" },
  { name: "Xynaptic", host: "api.xynaptic.io", category: "Crypto prices", endpoint: "GET /v1/crypto-price", network: "solana", priceUsd: "0.01", tx: "https://solscan.io/tx/4PAEhUrao79BjC5n6Y7riKkqoXudxVRjX1jF16bnpdX2erAv1SJuXZYWMh2b8d53nCZz51nuqx3bAzNDVvUMUyaJ" },
  { name: "solpulsedata", host: "solpulsedata.duckdns.org", category: "Bitcoin cycle", endpoint: "GET /v1/cycle", network: "solana", priceUsd: "0.005", tx: "https://solscan.io/tx/4LdXkP2H4gaMnTME1F7RD8Xs8GttMb6Gw3ZTJ6c8Hy5fYaPHE3uGQjaZ47XY3UnZ3dZ7V6SHunzpfG9gQazfdHo2" },
  { name: "twitterapi.io", host: "api.twitterapi.io", category: "X (Twitter) posts", endpoint: "GET /x402/twitter/user/last_tweets", network: "solana", priceUsd: "0.003", tx: "https://solscan.io/tx/2z78DKwQLTuU2wzqRjUUA1EdQh7bdhG5xYaa4YYUuLQmPx8vGQE3TNCuAq8ukJFjZiVru2UkGgFCZ35Dsu8rdnjW" },
];

/** Solana facilitators (the 402's extra.feePayer) that settled Phantom-signed payments. */
export const KNOWN_GOOD_FEE_PAYERS: Record<string, string> = {
  CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww: "PayAI",
  "2hjRxUkyYRGGjKTVZc5hxss7ZmdXZfZKHgvKYneyVQaU": "the facilitator Xynaptic uses",
};

/**
 * A seller's network that kept refusing payments across days, so another network of the same seller is used.
 * stableenrich.dev on Solana: invalid_exact_svm_transaction_simulation_failed: BlockhashNotFound on 11/25 and 11/27
 * (/api/exa/search and /api/firecrawl/search).
 */
export const SELLER_NETWORK_AVOID: Record<string, { family: "solana" | "evm"; reason: string }> = {
  "stableenrich.dev": { family: "solana", reason: "refused Solana payments with BlockhashNotFound on 2026-11-25 and 2026-11-27" },
};

/** A successful payment remembered at run time (host + network, and the Solana facilitator when there was one). */
export interface SuccessRecord {
  ts: string;
  host: string;
  network: string;
  feePayer?: string;
}

/** Successful payments are remembered this long. */
export const SUCCESS_TTL_MS = 30 * 24 * 3600_000;

const hostOf = (h: string) => h.toLowerCase().replace(/^www\./, "");

/** Whether `host` (or a parent domain listed) matches a verified seller host. */
function sameSeller(host: string, listed: string): boolean {
  const h = hostOf(host);
  const l = hostOf(listed);
  return h === l || h.endsWith("." + l);
}

/** The built-in successes as SuccessRecords (family-level network ids are resolved by the caller). */
export function verifiedFamily(host: string): Set<"base" | "solana"> {
  const out = new Set<"base" | "solana">();
  for (const v of VERIFIED_PAYMENTS) if (sameSeller(host, v.host)) out.add(v.network);
  return out;
}

export function sellerNetworkAvoid(host: string) {
  for (const [h, v] of Object.entries(SELLER_NETWORK_AVOID)) if (sameSeller(host, h)) return v;
  return undefined;
}
