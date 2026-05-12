/**
 * SNIP-12 revision-1 typed-data schema the FactRegistry's
 * `verify_sig_and_balance` recomputes inside the virtual block.
 *
 * Argent X and Braavos sign this exact structure via `wallet_signTypedData`;
 * the Cairo contract recomputes the same Poseidon-based hash and validates
 * the signature through the user's account contract.
 *
 * If you change anything here you must regenerate the type-hash constants
 * (see ./computeTypeHashes.ts) and update src/lib.cairo to match.
 */
import { type TypedData } from "starknet";

export const CONSENT_TYPES = {
  StarknetDomain: [
    { name: "name", type: "shortstring" },
    { name: "version", type: "shortstring" },
    { name: "chainId", type: "shortstring" },
    { name: "revision", type: "shortstring" },
  ],
  Consent: [
    { name: "secret", type: "felt" },
    { name: "min_balance", type: "u256" },
    { name: "token", type: "ContractAddress" },
  ],
} as const;

export interface ConsentMessage {
  secret: string; // felt as hex string
  min_balance: { low: string; high: string };
  token: string; // ContractAddress hex
}

/**
 * Build the SNIP-12 typed-data payload to pass to `account.signMessage(...)`
 * or `wallet_signTypedData`.
 *
 * `chainId` must be the felt-encoded chain id the wallet sees (e.g.
 * "SN_SEPOLIA" or "SN_MAIN"). starknet.js encodes both the human name and the
 * raw felt hex consistently for shortstring.
 */
export function buildConsentTypedData(params: {
  chainId: string;
  secret: bigint;
  minBalance: { low: bigint; high: bigint };
  token: string;
}): TypedData {
  return {
    domain: {
      name: "ProofOfSolvency",
      version: "1",
      chainId: params.chainId,
      revision: "1",
    },
    primaryType: "Consent",
    types: CONSENT_TYPES as unknown as TypedData["types"],
    message: {
      secret: "0x" + params.secret.toString(16),
      min_balance: {
        low: "0x" + params.minBalance.low.toString(16),
        high: "0x" + params.minBalance.high.toString(16),
      },
      token: params.token,
    },
  };
}
