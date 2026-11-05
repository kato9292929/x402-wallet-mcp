import { createPublicClient, erc20Abi, http, type Address } from "viem";
import { base, baseSepolia } from "viem/chains";
import { BASE, BASE_SEPOLIA, CHAINS, SOLANA, SOLANA_DEVNET, formatUnits } from "./chains.js";

/**
 * Reads USDC balances straight from the chain so every provider reports
 * balances the same way, independent of vendor balance APIs.
 */

function evmRpc(chain: string): string | undefined {
  if (chain === BASE) return process.env.BASE_RPC_URL || undefined;
  if (chain === BASE_SEPOLIA) return process.env.BASE_SEPOLIA_RPC_URL || undefined;
  return undefined;
}

function solanaRpc(chain: string): string {
  if (chain === SOLANA) return process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  if (chain === SOLANA_DEVNET) return process.env.SOLANA_DEVNET_RPC_URL || "https://api.devnet.solana.com";
  throw new Error(`Not a Solana chain: ${chain}`);
}

export async function evmUsdcBalance(chain: string, owner: string): Promise<string> {
  const info = CHAINS[chain];
  if (!info || info.family !== "evm") throw new Error(`Not a supported EVM chain: ${chain}`);
  const client = createPublicClient({
    chain: chain === BASE ? base : baseSepolia,
    transport: http(evmRpc(chain)),
  });
  const raw = await client.readContract({
    address: info.usdc as Address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner as Address],
  });
  return formatUnits(raw, 6);
}

export async function solanaUsdcBalance(chain: string, owner: string): Promise<string> {
  const info = CHAINS[chain];
  if (!info || info.family !== "solana") throw new Error(`Not a supported Solana chain: ${chain}`);
  const res = await fetch(solanaRpc(chain), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTokenAccountsByOwner",
      params: [owner, { mint: info.usdc }, { encoding: "jsonParsed" }],
    }),
  });
  if (!res.ok) throw new Error(`Solana RPC HTTP ${res.status}`);
  const json = (await res.json()) as {
    error?: { message: string };
    result?: { value: { account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }[] };
  };
  if (json.error) throw new Error(`Solana RPC: ${json.error.message}`);
  let total = 0n;
  for (const acc of json.result?.value ?? []) {
    total += BigInt(acc.account.data.parsed.info.tokenAmount.amount);
  }
  return formatUnits(total, 6);
}

export async function onchainUsdcBalance(chain: string, owner: string): Promise<string> {
  return CHAINS[chain]?.family === "solana" ? solanaUsdcBalance(chain, owner) : evmUsdcBalance(chain, owner);
}

export function testnetFundingNotes(chain: string): string[] {
  if (!CHAINS[chain]?.testnet) return [];
  return [
    `Test USDC for ${CHAINS[chain].name}: https://faucet.circle.com/ (select ${CHAINS[chain].name}, paste the address above).`,
  ];
}
