/**
 * Proving service wrapper for the passport age-claim flow.
 *
 * Calls `verify_passport_age` virtually (SHA256 chain + age assertion;
 * RSA is mocked for POC) then submits `register_fact` with the proof.
 *
 * Slot formula (mirrors lib.cairo):
 *   slot = poseidon(poseidon(secret), block_number, 'age_over_18', account)
 */
import { Account, CallData, RpcProvider, TransactionFinalityStatus } from "starknet";
import {
  findMessageFrom,
  proveContractCall,
} from "../../../client/src/proveContractCall.ts";

export interface PassportProveParams {
  rpcUrl: string;
  provingServiceUrl: string;
  relayerAddress: string;
  relayerPrivateKey: string;
  blockOffset: number;
  account: string;
  secret: string;
  dg1Bytes: number[];
  econtentBytes: number[];
  signedAttr: number[];
  currentYymmdd: number;
  factRegistry: string;
}

export interface PassportProveResult {
  slot: string;
  txHash: string;
  baseBlockNumber: number;
}

export async function passportProveAndRegister(
  params: PassportProveParams,
): Promise<PassportProveResult> {
  const provider = new RpcProvider({ nodeUrl: params.rpcUrl });
  const relayer = new Account({
    provider,
    address: params.relayerAddress,
    signer: params.relayerPrivateKey,
    cairoVersion: "1",
  });

  const currentBlock = await provider.getBlockNumber();
  const baseBlockNumber = Math.max(0, currentBlock - params.blockOffset);
  const relayerNonce = BigInt(
    await provider.getNonceForAddress(params.relayerAddress, "latest"),
  );

  // Span<u8> encodes as [length, b0, b1, …] — starknet.js handles this
  // automatically when you pass a JS array to CallData.compile.
  const verifyCalldata = CallData.compile([
    params.account,
    params.secret,
    params.dg1Bytes,
    params.econtentBytes,
    params.signedAttr,
    params.currentYymmdd,
  ]);

  const chainIdHex = await provider.getChainId();

  const proof = await proveContractCall({
    provingServiceUrl: params.provingServiceUrl,
    blockId: baseBlockNumber,
    account: relayer,
    call: {
      contractAddress: params.factRegistry,
      entrypoint: "verify_passport_age",
      calldata: verifyCalldata,
    },
    chainId: chainIdHex as `0x${string}` as any,
    nonce: relayerNonce,
  });

  const payload = findMessageFrom(proof, params.factRegistry);
  if (payload.length !== 1) {
    throw new Error(
      `verify_passport_age emitted ${payload.length} payload items; expected 1 (the slot).`,
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
    { tip: 0n, ...proofDetails },
  );

  void provider
    .waitForTransaction(tx.transaction_hash, {
      successStates: [TransactionFinalityStatus.ACCEPTED_ON_L2],
    })
    .catch((e) => {
      console.warn(`register_fact tx wait failed for ${tx.transaction_hash}:`, e);
    });

  return { slot, txHash: tx.transaction_hash, baseBlockNumber };
}
