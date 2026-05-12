/**
 * Client-side slot recomputation. Mirrors the L1-message payload the Cairo
 * `verify_sig_and_balance` emits inside the virtual block:
 *
 *   slot = poseidon(poseidon(secret), base_block_number, min_balance.low,
 *                   min_balance.high, token)
 *
 * Used so the UI can derive the expected slot before the backend round-trips,
 * and so a third-party verifier with (secret, base_block, min_balance, token)
 * can recompute it offline.
 */
import { hash, uint256 } from "starknet";

export function computeSlot(params: {
  secret: bigint;
  baseBlockNumber: number | bigint;
  minBalance: bigint;
  token: string;
}): string {
  const mb = uint256.bnToUint256(params.minBalance);
  const secretHash = hash.computePoseidonHashOnElements([params.secret]);
  return hash.computePoseidonHashOnElements([
    BigInt(secretHash),
    BigInt(params.baseBlockNumber),
    BigInt(mb.low),
    BigInt(mb.high),
    BigInt(params.token),
  ]);
}
