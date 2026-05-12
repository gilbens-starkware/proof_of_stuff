/**
 * Server-side wrapper around the proving service. Builds the
 * `verify_sig_and_balance` call from the consent signature the user gave us
 * in the wallet, hands it to the proving service, then submits
 * `register_fact` from the relayer account with the proof attached.
 *
 * The proving service's signature field is cosmetic (skipValidate=true), so
 * we sign the proof transaction with the relayer key. The signature the
 * *Cairo contract* validates is the user's consent signature, which travels
 * inside the call's calldata.
 */
import {
  Account,
  CallData,
  RpcProvider,
  TransactionFinalityStatus,
  cairo,
} from "starknet";
import {
  findMessageFrom,
  proveContractCall,
} from "../../../client/src/proveContractCall.ts";

export interface ProveAndRegisterParams {
  rpcUrl: string;
  provingServiceUrl: string;
  relayerAddress: string;
  relayerPrivateKey: string;
  blockOffset: number;
  account: string;
  secret: string;
  signature: string[];
  minBalance: bigint;
  token: string;
  factRegistry: string;
}

export interface ProveAndRegisterResult {
  slot: string;
  txHash: string;
  baseBlockNumber: number;
}

export async function proveAndRegister(
  params: ProveAndRegisterParams,
): Promise<ProveAndRegisterResult> {
  const provider = new RpcProvider({ nodeUrl: params.rpcUrl });
  const relayer = new Account({
    provider,
    address: params.relayerAddress,
    signer: params.relayerPrivateKey,
    cairoVersion: "1",
  });

  // The proving service runs verify_sig_and_balance virtually at this block.
  // Subtract a small offset to dodge L2 reorgs and to let state at that block
  // settle (the 10-block convention from the privacy SDK).
  const currentBlock = await provider.getBlockNumber();
  const baseBlockNumber = Math.max(0, currentBlock - params.blockOffset);
  const relayerNonce = BigInt(
    await provider.getNonceForAddress(params.relayerAddress, "latest"),
  );

  const u256MinBalance = cairo.uint256(params.minBalance);
  const verifyCalldata = CallData.compile([
    params.account,
    params.secret,
    params.signature.map(String),
    u256MinBalance,
    params.token,
  ]);

  const chainIdHex = await provider.getChainId();

  const proof = await proveContractCall({
    provingServiceUrl: params.provingServiceUrl,
    blockId: baseBlockNumber,
    account: relayer,
    call: {
      contractAddress: params.factRegistry,
      entrypoint: "verify_sig_and_balance",
      calldata: verifyCalldata,
    },
    chainId: chainIdHex as `0x${string}` as any,
    nonce: relayerNonce,
  });

  const payload = findMessageFrom(proof, params.factRegistry);
  if (payload.length !== 1) {
    throw new Error(
      `verify_sig_and_balance emitted ${payload.length} payload items; expected exactly 1 (the slot felt).`,
    );
  }
  const slot = payload[0];

  // Attach the proof bundle as v3 tx extras. starknet.js serializes them into
  // the envelope; the verifier reads them inside register_fact via
  // get_execution_info_v3_syscall().tx_info.proof_facts.
  const proofDetails = proof.proofFacts.length
    ? { proofFacts: proof.proofFacts, proof: proof.proof }
    : {};

  const tx = await relayer.execute(
    {
      contractAddress: params.factRegistry,
      entrypoint: "register_fact",
      calldata: [slot],
    },
    {
      tip: 0n,
      ...proofDetails,
    },
  );

  // We don't block the response on full inclusion — return the tx hash and let
  // the frontend's event poller flip the claim to "registered" when it sees
  // SolvencyFactRegistered. That keeps the API responsive (the relayer call
  // can take a couple of seconds once the network is busy).
  void provider
    .waitForTransaction(tx.transaction_hash, {
      successStates: [TransactionFinalityStatus.ACCEPTED_ON_L2],
    })
    .catch((e) => {
      console.warn(`register_fact tx wait failed for ${tx.transaction_hash}:`, e);
    });

  return {
    slot,
    txHash: tx.transaction_hash,
    baseBlockNumber,
  };
}
