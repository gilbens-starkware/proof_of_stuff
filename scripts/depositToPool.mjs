/**
 * One-off script: deposit STRK from the `solvency` account into the
 * starknet-privacy pool, registering the account + viewing key on first use.
 *
 * Reads the SDK directly from the local clone at
 * /home/gil/workspace/starknet-privacy/sdk/dist (which we built earlier).
 *
 * Run with:
 *   node /home/gil/workspace/proof_of_stuff/scripts/depositToPool.mjs
 */

import {
  Account,
  CallData,
  RpcProvider,
  TransactionFinalityStatus,
} from "/home/anat/hackathon/proof_of_stuff/client/node_modules/starknet/dist/index.js";
import {
  createPrivateTransfers,
  ProvingServiceProofProvider,
} from "/home/anat/hackathon/starknet-privacy/sdk/dist/index.js";
import { IndexerDiscoveryProvider } from "/home/anat/hackathon/starknet-privacy/sdk/dist/internal/indexer-discovery.js";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";

// ───── config ────────────────────────────────────────────────────────────────
const RPC_URL          = "http://34.170.198.113:9545/rpc/v0_10";
const PROVING_URL      = "http://34.29.249.119:3000";
const INDEXER_URL      = "http://35.192.48.142:8080";
const POOL_ADDRESS     = "0xd894af9ed2bdede33675049ae5285df000c44258a2250b84a9c3bed0d7c233";
const STRK_ADDRESS     = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const ACCOUNT_ADDRESS  = "0x048fc73029bbdf97facb35b8b2936a2ea5f851df7acfd56cbe7dd73564911889";
const ACCOUNT_PRIV_KEY = "0x197512021a520a8477999aeef8a8287d5e4893a1a70473baf386eef05cfc9e0";
const CHAIN_ID         = "0x534e5f5345504f4c4941"; // SN_SEPOLIA

// Amount in STRK base units (10^18). 1 STRK = 1_000_000_000_000_000_000n.
const DEPOSIT_AMOUNT   = 10_000_000_000_000_000_000n; // 10 STRK

// Persist the viewing key — if we lose it, we can't decrypt the notes we
// created with it. Stored alongside this script.
const VIEWING_KEY_PATH = "/home/anat/hackathon/proof_of_stuff/scripts/.solvency-viewing-key";

function getViewingKey() {
  if (existsSync(VIEWING_KEY_PATH)) {
    return BigInt(readFileSync(VIEWING_KEY_PATH, "utf8").trim());
  }
  // Random felt252-safe value (top byte clipped so we stay below the field prime).
  const buf = randomBytes(31);
  const vk = "0x" + buf.toString("hex");
  writeFileSync(VIEWING_KEY_PATH, vk, "utf8");
  return BigInt(vk);
}

async function main() {
  const provider = new RpcProvider({ nodeUrl: RPC_URL });
  const account = new Account({
    provider,
    address: ACCOUNT_ADDRESS,
    signer: ACCOUNT_PRIV_KEY,
    cairoVersion: "1",
  });

  const viewingKey = getViewingKey();
  console.log(`Viewing key (kept in ${VIEWING_KEY_PATH}): 0x${viewingKey.toString(16)}`);

  const discovery = new IndexerDiscoveryProvider(INDEXER_URL, POOL_ADDRESS);
  const provingProvider = new ProvingServiceProofProvider(PROVING_URL, CHAIN_ID);

  const transfers = createPrivateTransfers({
    account,
    viewingKeyProvider: { getViewingKey: async () => viewingKey },
    provingProvider,
    discoveryProvider: discovery,
    poolContractAddress: POOL_ADDRESS,
  });

  const provingBlockId = (await provider.getBlockNumber()) - 10;
  console.log(`Proving against block ${provingBlockId}.`);

  // Build the deposit. autoRegister + autoSetup take care of the one-time
  // SetViewingKey + OpenChannel actions if this account hasn't used the pool yet.
  console.log(`Building deposit of ${DEPOSIT_AMOUNT} (${Number(DEPOSIT_AMOUNT) / 1e18} STRK)…`);
  const { callAndProof } = await transfers
    .build({
      autoRegister: true,
      autoSetup: true,
      autoDiscover: { notes: "refresh", channels: "refresh" },
    })
    .with(STRK_ADDRESS, (t) => t.deposit({ amount: DEPOSIT_AMOUNT }))
    .execute({ provingBlockId });

  console.log(`Got proof (${callAndProof.proof.data.length} chars), submitting…`);

  // Pool pulls funds via transferFrom — approve first, atomically in the same tx.
  const approveCall = {
    contractAddress: STRK_ADDRESS,
    entrypoint: "approve",
    calldata: CallData.compile({
      spender: POOL_ADDRESS,
      amount: { low: DEPOSIT_AMOUNT, high: 0n },
    }),
  };

  const proofDetails = callAndProof.proof.proofFacts?.length
    ? { proofFacts: callAndProof.proof.proofFacts, proof: callAndProof.proof.data }
    : {};

  const tx = await account.execute([approveCall, callAndProof.call], {
    tip: 0n,
    ...proofDetails,
  });
  console.log(`Tx hash: ${tx.transaction_hash}`);

  const receipt = await provider.waitForTransaction(tx.transaction_hash, {
    successStates: [TransactionFinalityStatus.ACCEPTED_ON_L2],
  });
  console.log(`Deposit confirmed. Receipt: ${receipt.statusReceipt ?? "ok"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
