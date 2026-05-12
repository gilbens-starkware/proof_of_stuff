/**
 * Hits the pool contract's IViews functions directly to confirm each of the
 * solvency account's notes exists and is unspent.
 *
 * Approach:
 *   1. Recover channel_key from SDK discovery (already decrypted via our viewing
 *      key in listPoolState.mjs).
 *   2. For each note index 1..N, recompute:
 *        note_id  = compute_note_id(channel_key, token, i)
 *        nullifier = compute_nullifier(channel_key, token, i, viewing_key)
 *   3. Call pool.get_note(note_id) → check packed_value != 0 (exists).
 *      Call pool.nullifier_exists(nullifier) → spent flag.
 */

import { RpcProvider, hash } from "/home/gil/workspace/proof_of_stuff/client/node_modules/starknet/dist/index.js";
import { createPrivateTransfers, ProvingServiceProofProvider } from "/home/gil/workspace/starknet-privacy/sdk/dist/index.js";
import { IndexerDiscoveryProvider } from "/home/gil/workspace/starknet-privacy/sdk/dist/internal/indexer-discovery.js";
import { compute_note_id, compute_nullifier } from "/home/gil/workspace/starknet-privacy/sdk/dist/utils/hashes.js";
import { Account } from "/home/gil/workspace/proof_of_stuff/client/node_modules/starknet/dist/index.js";
import { readFileSync } from "node:fs";

const RPC_URL          = "http://34.170.198.113:9545/rpc/v0_10";
const PROVING_URL      = "http://34.29.249.119:3000";
const INDEXER_URL      = "http://35.192.48.142:8080";
const POOL_ADDRESS     = "0xd894af9ed2bdede33675049ae5285df000c44258a2250b84a9c3bed0d7c233";
const STRK_ADDRESS     = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const ACCOUNT_ADDRESS  = "0x048fc73029bbdf97facb35b8b2936a2ea5f851df7acfd56cbe7dd73564911889";
const ACCOUNT_PRIV_KEY = "0x197512021a520a8477999aeef8a8287d5e4893a1a70473baf386eef05cfc9e0";
const CHAIN_ID         = "0x534e5f5345504f4c4941";

const viewingKey = BigInt(readFileSync("/home/gil/workspace/proof_of_stuff/scripts/.solvency-viewing-key", "utf8").trim());

const provider = new RpcProvider({ nodeUrl: RPC_URL });
const account = new Account({ provider, address: ACCOUNT_ADDRESS, signer: ACCOUNT_PRIV_KEY, cairoVersion: "1" });
const discovery = new IndexerDiscoveryProvider(INDEXER_URL, POOL_ADDRESS);
const provingProvider = new ProvingServiceProofProvider(PROVING_URL, CHAIN_ID);

const transfers = createPrivateTransfers({
  account,
  viewingKeyProvider: { getViewingKey: async () => viewingKey },
  provingProvider,
  discoveryProvider: discovery,
  poolContractAddress: POOL_ADDRESS,
});

// Pull the channel state to grab channel_key and the noteNonce counter.
const channelsRes = await transfers.discoverChannels([BigInt(ACCOUNT_ADDRESS)]);
const channel = channelsRes.channels?.get(BigInt(ACCOUNT_ADDRESS));
if (!channel || !channel.key) throw new Error("channel not set up");
const channelKey = channel.key;
const tokenState = channel.tokens.get(BigInt(STRK_ADDRESS));
if (!tokenState) throw new Error("no STRK channel state");

console.log("Channel key   :", "0x" + channelKey.toString(16));
console.log("STRK tokenIdx :", tokenState.tokenIndex, ", noteNonce :", tokenState.noteNonce);
console.log();

const NOTE_SELECTOR    = hash.getSelectorFromName("get_note");
const NULLIFIER_SELECTOR = hash.getSelectorFromName("nullifier_exists");

async function callPool(selector, calldata) {
  const r = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "starknet_call",
      params: { request: { contract_address: POOL_ADDRESS, entry_point_selector: selector, calldata }, block_id: "latest" },
    }),
  });
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
}

// Iterate 0..noteNonce (inclusive on both ends) to cover both 0-based and
// 1-based indexing conventions.
console.log("idx | note_id                                                            | exists | enc_packed_value (felt)                  | spent");
console.log("----+--------------------------------------------------------------------+--------+------------------------------------------+------");

for (let i = 0; i <= tokenState.noteNonce; i++) {
  const noteId = compute_note_id(channelKey, BigInt(STRK_ADDRESS), i);
  const nullifier = compute_nullifier(channelKey, BigInt(STRK_ADDRESS), i, viewingKey);

  // Note { packed_value: felt252, token: ContractAddress }
  const noteRet = await callPool(NOTE_SELECTOR, ["0x" + noteId.toString(16)]);
  const packed = BigInt(noteRet[0]);
  const tokenInNote = BigInt(noteRet[1]);
  const exists = packed !== 0n;

  const nulRet = await callPool(NULLIFIER_SELECTOR, ["0x" + nullifier.toString(16)]);
  const spent = BigInt(nulRet[0]) !== 0n;

  console.log(
    `${String(i).padStart(2)}  | 0x${noteId.toString(16).padStart(64, "0")} | ${String(exists).padStart(6)} | 0x${packed.toString(16).padStart(38, "0")} | ${spent}`,
  );
}
// Encrypted notes intentionally store token=0 on chain; the real token is
// recovered off-chain by decrypting `enc_token` with the channel key. So we
// don't bother surfacing the on-chain `token` field here.
