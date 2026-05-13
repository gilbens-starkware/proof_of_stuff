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
import { hash, shortString, uint256 } from "starknet";

// Mirrors the Cairo slot formula in verify_passport_age:
//   slot = poseidon(poseidon(secret), block_number, 'age_over_18', account)
export function computeAgeClaimSlot(params: {
  secret: bigint;
  baseBlockNumber: number | bigint;
  account: string;
}): string {
  const secretHash = hash.computePoseidonHashOnElements([params.secret]);
  const claimTag = BigInt(shortString.encodeShortString("age_over_18"));
  return hash.computePoseidonHashOnElements([
    BigInt(secretHash),
    BigInt(params.baseBlockNumber),
    claimTag,
    BigInt(params.account),
  ]);
}

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
