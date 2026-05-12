/**
 * SNIP-12 revision-1 typed-data schema shared with src/lib.cairo's
 * `compute_snip12_consent_hash`. The Cairo contract recomputes a Poseidon hash
 * over the same fields and validates the wallet's signature via
 * `is_valid_signature` on the user's account.
 *
 * This file is intentionally an exact duplicate of
 * ../../../client/src/consentTypedData.ts. The CLI example in client/ and the
 * webapp both depend on the same schema; if you edit one, edit both — and
 * regenerate the type-hash constants pinned in src/lib.cairo via
 * `npx tsx client/src/computeTypeHashes.ts`.
 */
import type { TypedData } from "starknet";

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
  secret: string;
  min_balance: { low: string; high: string };
  token: string;
}

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
