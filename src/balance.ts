import { CHAINS, formatUnits } from "./chains.js";
import { rpcCall } from "./safe/rpc.js";

/**
 * Reads USDC balances straight from the chain so every provider reports balances the same
 * way, independent of vendor balance APIs. Uses the dedicated RPC first, then public RPCs
 * (src/safe/rpc.ts).
 */

export async function evmUsdcBalance(chain: string, owner: string): Promise<string> {
  const info = CHAINS[chain];
  if (!info || info.family !== "evm") throw new Error(`Not a supported EVM chain: ${chain}`);
  // balanceOf(address)
  const data = "0x70a08231" + owner.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const { result } = await rpcCall<string>(chain, "eth_call", [{ to: info.usdc, data }, "latest"]);
  return formatUnits(BigInt(result && result !== "0x" ? result : "0x0"), 6);
}

export async function solanaUsdcBalance(chain: string, owner: string): Promise<string> {
  const info = CHAINS[chain];
  if (!info || info.family !== "solana") throw new Error(`Not a supported Solana chain: ${chain}`);
  const { result } = await rpcCall<{ value: { account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }[] }>(
    chain,
    "getTokenAccountsByOwner",
    [owner, { mint: info.usdc }, { encoding: "jsonParsed" }],
  );
  let total = 0n;
  for (const acc of result?.value ?? []) total += BigInt(acc.account.data.parsed.info.tokenAmount.amount);
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
