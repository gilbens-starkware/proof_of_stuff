export type ClaimStatus = "pending" | "registered" | "failed";

export interface Claim {
  /** poseidon-derived fact slot — the public key under which the registry stores the claim. */
  slot: string;
  /** Secret used to derive the slot. Stays client-side; user exports it deliberately. */
  secret: string; // hex
  /** Token whose balance was proven solvent. */
  token: string;
  /** Display info captured at proof time. */
  tokenSymbol: string;
  tokenDecimals: number;
  /** Raw min_balance as a decimal string (smallest units). */
  minBalance: string;
  /** Display amount, rounded for the UI. */
  minBalanceDisplay: string;
  /** Base block the proof was generated against. */
  baseBlockNumber: number;
  /** register_fact transaction hash. */
  txHash: string;
  /** Tracking the chain id helps a verifier figure out which network to query. */
  chainId: string;
  /** Address of the FactRegistry. Same reason as chainId. */
  factRegistry: string;
  /** Account that signed the consent. Useful in the export bundle. */
  account: string;
  status: ClaimStatus;
  createdAt: number;
  /** Optional error message if the relay or registration failed. */
  error?: string;
}

export interface ProveResponse {
  slot: string;
  tx_hash: string;
  base_block_number: number;
}

export interface ConfigEnv {
  rpcUrl: string;
  factRegistry: string;
}
