/**
 * End-to-end example: prove balance solvency against the FactRegistry contract
 * in ../src/lib.cairo.
 *
 * Flow:
 *   1. Sign poseidon(DOMAIN_TAG, secret, min_balance.lo, min_balance.hi, token)
 *      with the user's account key — proves consent to disclose solvency.
 *   2. Call the proving service with `verify_sig_and_balance(...)` at block N.
 *      The prover runs the function virtually, reads the user's ERC-20 balance
 *      at block N, checks balance >= min_balance, and emits an L2-to-L1 message
 *      whose payload is the fact `slot`.
 *   3. Read the slot from the L2-to-L1 message.
 *   4. Submit `register_fact(slot)` on-chain with the proof attached. The
 *      contract verifies proof_facts and stores `facts[slot] = true`.
 *
 * After step 4 anyone can call `is_fact_registered(slot)` to confirm that
 * `account` had at least `min_balance` of `token` at block N — without
 * revealing the secret or the exact balance.
 */

import {
  Account,
  CallData,
  RpcProvider,
  TransactionFinalityStatus,
  cairo,
  constants,
  stark,
} from "starknet";
import { buildConsentTypedData } from "./consentTypedData.ts";
import { findMessageFrom, proveContractCall } from "./proveContractCall.ts";

// --- env ---
const RPC_URL = required("RPC_URL");
const PROVING_SERVICE_URL = required("PROVING_SERVICE_URL");
const ACCOUNT_ADDRESS = required("ACCOUNT_ADDRESS");
const ACCOUNT_PRIVATE_KEY = required("ACCOUNT_PRIVATE_KEY");
const FACT_REGISTRY_ADDRESS = required("FACT_REGISTRY_ADDRESS");
const TOKEN_ADDRESS = required("TOKEN_ADDRESS");
const MIN_BALANCE = BigInt(required("MIN_BALANCE"));
const SECRET = BigInt(required("SECRET"));

async function main() {
  const provider = new RpcProvider({ nodeUrl: RPC_URL });
  const account = new Account({
    provider,
    address: ACCOUNT_ADDRESS,
    signer: ACCOUNT_PRIVATE_KEY,
    cairoVersion: "1",
  });

  // 1. Sign the consent typed data (SNIP-12 rev 1). The wallet (or this CLI's
  //    Account) computes the same Poseidon-based message hash that the Cairo
  //    contract will recompute and validate via `is_valid_signature`.
  const minBalance = cairo.uint256(MIN_BALANCE);
  const chainId = await provider.getChainId();
  const typedData = buildConsentTypedData({
    chainId,
    secret: SECRET,
    minBalance: { low: BigInt(minBalance.low), high: BigInt(minBalance.high) },
    token: TOKEN_ADDRESS,
  });
  const consentSignature = stark.formatSignature(await account.signMessage(typedData));

  // 2. Call the proving service against `currentBlock - 10`. The 10-block
  //    offset matches the privacy-pool convention — gives a margin against L2
  //    reorgs and stays well inside `proof_validity_blocks`.
  const provingBlockNumber = (await provider.getBlockNumber()) - 10;
  const nonce = BigInt(await provider.getNonceForAddress(ACCOUNT_ADDRESS, "latest"));
  console.log(`Proving against block ${provingBlockNumber} with nonce ${nonce}…`);

  const verifyCalldata = CallData.compile([
    ACCOUNT_ADDRESS,
    SECRET,
    consentSignature,
    minBalance,
    TOKEN_ADDRESS,
  ]);

  const result = await proveContractCall({
    provingServiceUrl: PROVING_SERVICE_URL,
    blockId: provingBlockNumber,
    account,
    call: {
      contractAddress: FACT_REGISTRY_ADDRESS,
      entrypoint: "verify_sig_and_balance",
      calldata: verifyCalldata,
    },
    chainId: constants.StarknetChainId.SN_SEPOLIA,
    nonce,
  });

  console.log(`Proof received (${result.proof.length} chars), proofFacts:`, result.proofFacts.length, "felts");

  // 3. The slot value is the single felt the virtual execution sent to L1.
  const payload = findMessageFrom(result, FACT_REGISTRY_ADDRESS);
  if (payload.length !== 1) {
    throw new Error(`Expected single-felt payload, got ${payload.length}`);
  }
  const slot = payload[0];
  console.log(`Fact slot: ${slot}`);

  // 4. Register on-chain. The proof bundle is attached as extras on the v3 tx;
  //    starknet.js serializes them into the tx envelope, and the verifier
  //    contract reads them via `get_execution_info_v3_syscall().tx_info.proof_facts`.
  const proofDetails = result.proofFacts.length
    ? { proofFacts: result.proofFacts, proof: result.proof }
    : {};

  const tx = await account.execute(
    {
      contractAddress: FACT_REGISTRY_ADDRESS,
      entrypoint: "register_fact",
      calldata: [slot],
    },
    {
      tip: 0n,
      ...proofDetails,
    },
  );
  console.log(`register_fact submitted: ${tx.transaction_hash}`);

  await provider.waitForTransaction(tx.transaction_hash, {
    successStates: [TransactionFinalityStatus.ACCEPTED_ON_L2],
  });
  console.log(`Fact registered at slot ${slot}.`);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
