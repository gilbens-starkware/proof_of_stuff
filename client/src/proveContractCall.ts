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
 */

import {
  CallData,
  hash,
  stark,
  type Account,
  type BlockIdentifier,
  type Call,
  type Calldata,
  type V3InvocationsSignerDetails,
  type constants,
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
  /** Account whose signer signs the proof invocation. With skipValidate, content of the signature is mostly cosmetic, but starknet.js still needs a valid Account to build the v3 envelope. */
  account: Account;
  /** The Cairo call to prove. `calldata` must be pre-serialized (string[] of felts). */
  call: Call & { calldata: Calldata };
  /** Chain ID — used in the transaction-hash domain separator at signing time. */
  chainId: constants.StarknetChainId;
  /** Nonce for the proof invocation. Default 0n — the prover does not check it when skipValidate is true. */
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
 *   3. Sign with the account's signer for cosmetic validity.
 *   4. POST `starknet_proveTransaction` to the proving service.
 *   5. Return the proof bundle to the caller.
 */
export async function proveContractCall(
  params: ProveCallParams,
): Promise<ProveCallResult> {
  const nonce = params.nonce ?? 0n;
  const senderAddress = toHex(params.account.address);

  const executeCalldata = buildExecuteCalldata(params.call);

  const resourceBounds = {
    l1_gas: { max_amount: "0x1", max_price_per_unit: "0x0" },
    l2_gas: {
      max_amount: toHex(DEFAULT_L2_GAS_MAX_AMOUNT),
      max_price_per_unit: "0x0",
    },
    l1_data_gas: { max_amount: "0x1", max_price_per_unit: "0x0" },
  };

  const signerDetails = {
    walletAddress: senderAddress,
    cairoVersion: "1",
    chainId: params.chainId,
    nonce,
    version: "0x3",
    resourceBounds,
    tip: 0n,
    paymasterData: [],
    accountDeploymentData: [],
    nonceDataAvailabilityMode: "L1",
    feeDataAvailabilityMode: "L1",
  } as unknown as V3InvocationsSignerDetails;

  const signature = await params.account.signer.signTransaction(
    [params.call],
    signerDetails,
  );

  const invocation = {
    type: "INVOKE" as const,
    sender_address: senderAddress,
    calldata: executeCalldata,
    signature: stark.formatSignature(signature),
    nonce: toHex(nonce),
    resource_bounds: resourceBounds,
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
  const target = toHex(fromAddress).toLowerCase();
  const message = result.messages.find(
    (m) => toHex(m.from_address).toLowerCase() === target,
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
