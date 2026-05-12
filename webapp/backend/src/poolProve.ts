/**
 * Server-side wrapper around the prover for the pool-balance solvency flow.
 *
 * Mirrors prove.ts but calls `verify_sig_and_pool_balance` instead of
 * `verify_sig_and_balance`. The Cairo function reads the pool's encrypted
 * notes via view calls during virtual execution, so the proving service has
 * to run it against a real block where the notes already exist (= now - 10
 * blocks, the SDK's default for L2-reorg safety).
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

export interface PoolProveAndRegisterParams {
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
  pool: string;
  channelKey: string;
  viewingKey: string;
  tokenIndex: number;
  noteIndices: number[];
}

export interface PoolProveAndRegisterResult {
  slot: string;
  txHash: string;
  baseBlockNumber: number;
}

export async function poolProveAndRegister(
  params: PoolProveAndRegisterParams,
): Promise<PoolProveAndRegisterResult> {
  const provider = new RpcProvider({ nodeUrl: params.rpcUrl });
  const relayer = new Account({
    provider,
    address: params.relayerAddress,
    signer: params.relayerPrivateKey,
    cairoVersion: "1",
  });

  const currentBlock = await provider.getBlockNumber();
  const baseBlockNumber = Math.max(0, currentBlock - params.blockOffset);

  const u256MinBalance = cairo.uint256(params.minBalance);
  // verify_sig_and_pool_balance(
  //   account, secret, signature, min_balance, token,
  //   pool, channel_key, viewing_key, token_index, note_indices,
  // )
  const verifyCalldata = CallData.compile([
    params.account,
    params.secret,
    params.signature.map(String),
    u256MinBalance,
    params.token,
    params.pool,
    params.channelKey,
    params.viewingKey,
    params.tokenIndex,
    params.noteIndices,
  ]);

  // Virtual INVOKE is sent from the registry itself (see prove.ts for why).
  const proof = await proveContractCall({
    provingServiceUrl: params.provingServiceUrl,
    blockId: baseBlockNumber,
    senderAddress: params.factRegistry,
    call: {
      contractAddress: params.factRegistry,
      entrypoint: "verify_sig_and_pool_balance",
      calldata: verifyCalldata,
    },
    nonce: 0n,
  });

  const payload = findMessageFrom(proof, params.factRegistry);
  if (payload.length !== 1) {
    throw new Error(
      `verify_sig_and_pool_balance emitted ${payload.length} payload items; expected exactly 1 (the slot felt).`,
    );
  }
  const slot = payload[0];

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
