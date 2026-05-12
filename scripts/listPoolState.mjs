/**
 * List the solvency account's notes + channels in the privacy pool, using the
 * viewing key persisted by depositToPool.mjs.
 *
 * Run with:
 *   node /home/gil/workspace/proof_of_stuff/scripts/listPoolState.mjs
 */

import { Account, RpcProvider } from "/home/gil/workspace/proof_of_stuff/client/node_modules/starknet/dist/index.js";
import { createPrivateTransfers, ProvingServiceProofProvider } from "/home/gil/workspace/starknet-privacy/sdk/dist/index.js";
import { IndexerDiscoveryProvider } from "/home/gil/workspace/starknet-privacy/sdk/dist/internal/indexer-discovery.js";
import { readFileSync } from "node:fs";

const RPC_URL          = "http://34.170.198.113:9545/rpc/v0_10";
const PROVING_URL      = "http://34.29.249.119:3000";
const INDEXER_URL      = "http://35.192.48.142:8080";
const POOL_ADDRESS     = "0xd894af9ed2bdede33675049ae5285df000c44258a2250b84a9c3bed0d7c233";
const STRK_ADDRESS     = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const ACCOUNT_ADDRESS  = "0x048fc73029bbdf97facb35b8b2936a2ea5f851df7acfd56cbe7dd73564911889";
const ACCOUNT_PRIV_KEY = "0x197512021a520a8477999aeef8a8287d5e4893a1a70473baf386eef05cfc9e0";
const CHAIN_ID         = "0x534e5f5345504f4c4941";
const VIEWING_KEY_PATH = "/home/gil/workspace/proof_of_stuff/scripts/.solvency-viewing-key";

const viewingKey = BigInt(readFileSync(VIEWING_KEY_PATH, "utf8").trim());

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

console.log("Account     :", ACCOUNT_ADDRESS);
console.log("Viewing key :", "0x" + viewingKey.toString(16));
console.log();

// ─── Channels ────────────────────────────────────────────────────────────────
const channelsRes = await transfers.discoverChannels([BigInt(ACCOUNT_ADDRESS)]);
console.log("=== Channels ===");
if (!channelsRes.channels || channelsRes.channels.size === 0) {
  console.log("(none)");
} else {
  for (const [recipient, channel] of channelsRes.channels) {
    console.log("recipient :", "0x" + recipient.toString(16));
    console.log("  publicKey :", "0x" + (channel.publicKey ?? 0n).toString(16));
    console.log("  channelKey:", channel.key !== undefined ? "0x" + channel.key.toString(16) : "(not setup)");
    if (channel.tokens && channel.tokens.size > 0) {
      for (const [tokenAddr, tch] of channel.tokens.entries()) {
        console.log("  token     :", "0x" + tokenAddr.toString(16));
        console.log("    tokenIndex :", tch.tokenIndex);
        console.log("    noteNonce  :", tch.noteNonce);
      }
    }
  }
}
console.log();

// ─── Notes ───────────────────────────────────────────────────────────────────
const notesRes = await transfers.discoverNotes({ tokens: [BigInt(STRK_ADDRESS)] });
console.log("=== Notes (token = STRK) ===");
const list = notesRes.notes.get(BigInt(STRK_ADDRESS)) ?? [];
if (list.length === 0) {
  console.log("(none)");
} else {
  let total = 0n;
  for (const n of list) {
    total += n.amount;
    console.log("noteId :", "0x" + BigInt(n.id).toString(16));
    console.log("  amount  :", n.amount.toString(), "(" + Number(n.amount) / 1e18 + " STRK)");
    console.log("  sender  :", n.sender ? ("0x" + BigInt(n.sender).toString(16)) : "(self)");
    if (n.created !== undefined) console.log("  created :", n.created);
    if (n.open !== undefined) console.log("  open    :", n.open);
  }
  console.log("---");
  console.log("Total   :", total.toString(), "(" + Number(total) / 1e18 + " STRK)");
}
