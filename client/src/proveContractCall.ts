/**
 * Self-contained client for proving an arbitrary Cairo call against a virtual
 * Starknet block. No dependency on the privacy SDK — the JSON-RPC client for
 * the proving service is inlined below.
 *
 * Returns a STARK proof plus the proof facts and L2-to-L1 messages emitted
 * during virtual execution. The result is shaped so it can be attached to a
 * follow-up on-chain transaction via `Account.execute(call, { proof,
 * proofFacts, tip })`, where a verifier contract reads `tx_info.proof_facts`
 * to validate the proof.
 *
 * The `senderAddress` must be a contract whose `__validate__` and
 * `__execute__` entrypoints accept the virtual envelope used here (zero
 * tip, zero L2_GAS price). The FactRegistry in src/lib.cairo doubles as
 * its own account for that reason — using it as the sender keeps the
 * sender's nonce pinned at 0 forever (real txs can't pass `__validate__`),
 * which removes the historical-vs-latest nonce race we'd hit if we used
 * the relayer's account here too.
 */

import {
  CallData,
  hash,
  type BlockIdentifier,
  type Call,
  type Calldata,
} from "starknet";

const DEFAULT_L2_GAS_MAX_AMOUNT = 100_000_000n;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface MessageToL1 {
  from_address: string;
  to_address: string;
  payload: string[];
}

export interface ProveCallParams {
  /** Base URL of the proving service (JSON-RPC `starknet_proveTransaction`). */
  provingServiceUrl: string;
  /** Block to run the virtual execution against. `currentBlock - 10` is a safe default. */
  blockId: BlockIdentifier;
  /** Address sent as the virtual INVOKE's `sender_address`. Must be a deployed account-shape contract (see the doc comment at the top of this file). */
  senderAddress: string;
  /** The Cairo call to prove. `calldata` must be pre-serialized (string[] of felts). */
  call: Call & { calldata: Calldata };
  /** Nonce for the proof invocation. Default 0n. With FactRegistry-as-account the on-chain nonce is always 0. */
  nonce?: bigint;
  /** HTTP timeout. Default 30s. */
  requestTimeoutMs?: number;
}

export interface ProveCallResult {
  /** Base64-encoded STARK proof blob. Pass as `proof` to `account.execute`. */
  proof: string;
  /** Serialized `ProofFacts` felts. Pass as `proofFacts` to `account.execute`. */
  proofFacts: string[];
  /** Every L2-to-L1 message emitted during virtual execution. */
  messages: MessageToL1[];
}

/**
 * Prove an arbitrary Cairo call against a virtual Starknet block.
 *
 * The flow inside this function:
 *   1. Hand-roll `__execute__` calldata wrapping the single Call.
 *   2. Build the V3 INVOKE envelope (resource bounds, mode flags, etc.).
 *   3. POST `starknet_proveTransaction` to the proving service.
 *   4. Return the proof bundle to the caller.
 *
 * No signature is computed: the sender's `__validate__` is expected to gate
 * on the resource-bounds shape (zero L2_GAS price + zero tip), not on a
 * signature, so a `['0x0','0x0']` placeholder satisfies the wire schema.
 */
export async function proveContractCall(
  params: ProveCallParams,
): Promise<ProveCallResult> {
  const nonce = params.nonce ?? 0n;
  const senderAddress = toHex(params.senderAddress);

  const executeCalldata = buildExecuteCalldata(params.call);

  // L2_GAS max_price_per_unit must be 0 — that's the invariant the
  // FactRegistry's __validate__ asserts to keep itself unusable from real
  // txs. The other bounds are nominal; the prover doesn't charge gas.
  const resourceBoundsHex = {
    l1_gas: { max_amount: "0x1", max_price_per_unit: "0x0" },
    l2_gas: {
      max_amount: toHex(DEFAULT_L2_GAS_MAX_AMOUNT),
      max_price_per_unit: "0x0",
    },
    l1_data_gas: { max_amount: "0x1", max_price_per_unit: "0x0" },
  };

  const invocation = {
    type: "INVOKE" as const,
    sender_address: senderAddress,
    calldata: executeCalldata,
    signature: ["0x0", "0x0"],
    nonce: toHex(nonce),
    resource_bounds: resourceBoundsHex,
    tip: toHex(0n),
    paymaster_data: [],
    account_deployment_data: [],
    nonce_data_availability_mode: "L1" as const,
    fee_data_availability_mode: "L1" as const,
    version: "0x3" as const,
  };

  const result = await proveTransactionRpc(
    params.provingServiceUrl,
    params.blockId,
    invocation,
    params.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  );

  return {
    proof: result.proof,
    proofFacts: result.proof_facts,
    messages: result.l2_to_l1_messages,
  };
}

/**
 * Extract the payload of the L2-to-L1 message emitted by a given contract.
 * Throws if no message is found — the calling contract failed to emit, or the
 * address doesn't match (case-insensitive hex compare).
 */
export function findMessageFrom(
  result: ProveCallResult,
  fromAddress: string,
): string[] {
  // Compare numerically — addresses may differ in leading-zero padding.
  const target = BigInt(fromAddress);
  const message = result.messages.find(
    (m) => BigInt(m.from_address) === target,
  );
  if (!message) {
    throw new Error(
      `No L2-to-L1 message from ${fromAddress}. Received: ${JSON.stringify(result.messages)}`,
    );
  }
  return message.payload;
}

/**
 * Hand-roll the `__execute__(calls: Array<Call>)` calldata layout for a single Call.
 * Layout: [num_calls=1, to, selector, inner_calldata_len, ...inner_calldata].
 */
function buildExecuteCalldata(call: Call & { calldata: Calldata }): string[] {
  const inner = call.calldata.map(toHex);
  return [
    "0x1",
    toHex(call.contractAddress),
    toHex(hash.getSelectorFromName(call.entrypoint)),
    toHex(BigInt(inner.length)),
    ...inner,
  ];
}

function toHex(value: bigint | string | number): string {
  if (typeof value === "string") {
    return value.startsWith("0x") ? value : "0x" + BigInt(value).toString(16);
  }
  return "0x" + BigInt(value).toString(16);
}

// Re-export CallData for callers who want to serialize Cairo struct args.
export { CallData };

// ─────────────────────────────────────────────────────────────────────────────
// Inlined JSON-RPC client for the proving service.
//
// Mirrors the wire protocol of starkware-libs/starknet-privacy-sdk
// (dist/internal/proving-service.js, MIT). The proving service is a JSON-RPC
// endpoint with a single method we use: `starknet_proveTransaction(block_id,
// transaction)`. Schema validation is minimal — just enough to fail loudly if
// the response is structurally wrong.

interface ProvingServiceInvocation {
  type: "INVOKE";
  sender_address: string;
  calldata: string[];
  signature: string[];
  nonce: string;
  resource_bounds: ResourceBoundsHex;
  tip: string;
  paymaster_data: string[];
  account_deployment_data: string[];
  nonce_data_availability_mode: "L1";
  fee_data_availability_mode: "L1";
  version: "0x3";
}

interface ResourceBoundsHex {
  l1_gas: { max_amount: string; max_price_per_unit: string };
  l2_gas: { max_amount: string; max_price_per_unit: string };
  l1_data_gas: { max_amount: string; max_price_per_unit: string };
}

interface ProveTransactionResult {
  proof: string;
  proof_facts: string[];
  l2_to_l1_messages: MessageToL1[];
}

/** Structured JSON-RPC error from the proving service. */
export class ProvingServiceError extends Error {
  override readonly name = "ProvingServiceError";

  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: string,
  ) {
    super(data ? `${message}: ${data}` : message);
  }
}

async function proveTransactionRpc(
  baseUrl: string,
  blockId: BlockIdentifier,
  transaction: ProvingServiceInvocation,
  requestTimeoutMs: number,
): Promise<ProveTransactionResult> {
  const blockIdParam =
    typeof blockId === "number" || typeof blockId === "bigint"
      ? { block_number: Number(blockId) }
      : blockId;

  const body = {
    jsonrpc: "2.0",
    id: Date.now(),
    method: "starknet_proveTransaction",
    params: { block_id: blockIdParam, transaction },
  };

  const res = await fetch(baseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Proving service HTTP ${res.status}: ${text}`);
  }

  const json = JSON.parse(text) as {
    result?: ProveTransactionResult;
    error?: { code: number; message: string; data?: unknown };
  };

  if (json.error) {
    const { code, message, data } = json.error;
    throw new ProvingServiceError(
      code,
      message,
      typeof data === "string" ? data : undefined,
    );
  }

  const result = json.result;
  if (!result || typeof result.proof !== "string" || !Array.isArray(result.proof_facts) || !Array.isArray(result.l2_to_l1_messages)) {
    throw new Error(
      `Proving service returned invalid result. Expected { proof: string, proof_facts: string[], l2_to_l1_messages: MessageToL1[] }. Got: ${text.slice(0, 500)}`,
    );
  }
  return result;
}
