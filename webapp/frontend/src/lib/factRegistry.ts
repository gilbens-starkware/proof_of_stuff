/**
 * Read-side helpers for the FactRegistry contract: `is_fact_registered(slot)`
 * polling and SolvencyFactRegistered event scanning.
 *
 * We avoid the event scanner becoming a tight loop on the public RPC by
 * batching by block range and only running it while there are pending claims.
 */
import { CallData, hash, type RpcProvider } from "starknet";

const SOLVENCY_FACT_REGISTERED = hash.getSelectorFromName("SolvencyFactRegistered");

export async function isFactRegistered(
  provider: RpcProvider,
  factRegistry: string,
  slot: string,
): Promise<boolean> {
  const result = await provider.callContract({
    contractAddress: factRegistry,
    entrypoint: "is_fact_registered",
    calldata: CallData.compile({ slot }),
  });
  return BigInt(result[0]) !== 0n;
}

export async function scanRegisteredSlots(
  provider: RpcProvider,
  factRegistry: string,
  fromBlock: number,
  toBlock: number | "latest" = "latest",
): Promise<string[]> {
  const events = await provider.getEvents({
    address: factRegistry,
    from_block: { block_number: fromBlock },
    to_block: toBlock === "latest" ? "latest" : { block_number: toBlock },
    keys: [[SOLVENCY_FACT_REGISTERED]],
    chunk_size: 100,
  });
  const slots: string[] = [];
  for (const evt of events.events) {
    // `slot` is the indexed key (key index 1; index 0 is the event selector).
    const slotKey = evt.keys[1];
    if (slotKey) slots.push(normalizeSlot(slotKey));
  }
  return slots;
}

export function normalizeSlot(felt: string): string {
  return "0x" + BigInt(felt).toString(16);
}
