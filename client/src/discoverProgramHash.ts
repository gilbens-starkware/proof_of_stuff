/**
 * One-shot helper: ask the proving service to run `verify_sig_and_balance`
 * against our deployed FactRegistry, then print the `virtual_program_hash`
 * the prover binds to it. That hash is what `expected_program_hash` must be
 * pinned to in the contract constructor — chicken-and-egg means we deploy
 * once with a placeholder, learn the hash here, then redeploy.
 *
 * ProofFacts serialization (mirrors the Cairo struct in src/lib.cairo):
 *   [0] proof_version
 *   [1] program_variant
 *   [2] virtual_program_hash   <-- what we want
 *   [3] starknet_os_output_version
 *   [4] base_block_number
 *   [5] base_block_hash
 *   [6] starknet_os_config_hash
 *   [7] message_to_l1_hashes length, then [8..] elements
 */
import {
  Account,
  CallData,
  RpcProvider,
  cairo,
  stark,
} from "starknet";
import { buildConsentTypedData } from "./consentTypedData.ts";
import { proveContractCall } from "./proveContractCall.ts";

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

  const minBalance = cairo.uint256(MIN_BALANCE);
  const chainId = await provider.getChainId();
  const typedData = buildConsentTypedData({
    chainId,
    secret: SECRET,
    minBalance: { low: BigInt(minBalance.low), high: BigInt(minBalance.high) },
    token: TOKEN_ADDRESS,
  });
  const consentSignature = stark.formatSignature(await account.signMessage(typedData));

  const provingBlockNumber = (await provider.getBlockNumber()) - 10;
  console.log(`Proving against block ${provingBlockNumber}…`);

  const verifyCalldata = CallData.compile([
    ACCOUNT_ADDRESS,
    SECRET,
    consentSignature,
    minBalance,
    TOKEN_ADDRESS,
  ]);

  // Virtual INVOKE is sent from the FactRegistry itself (see example.ts).
  const result = await proveContractCall({
    provingServiceUrl: PROVING_SERVICE_URL,
    blockId: provingBlockNumber,
    senderAddress: FACT_REGISTRY_ADDRESS,
    call: {
      contractAddress: FACT_REGISTRY_ADDRESS,
      entrypoint: "verify_sig_and_balance",
      calldata: verifyCalldata,
    },
    nonce: 0n,
  });

  console.log(`proofFacts (${result.proofFacts.length} felts):`);
  for (const [i, f] of result.proofFacts.entries()) {
    console.log(`  [${i}] ${f}`);
  }
  console.log();
  console.log(`virtual_program_hash = ${result.proofFacts[2]}`);
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
