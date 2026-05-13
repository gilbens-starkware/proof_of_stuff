/**
 * Self-channel key derivation, ported from the privacy SDK
 * (sdk/src/utils/{crypto,hashes}.ts in starkware-libs/starknet-privacy).
 *
 *   channel_key = Poseidon(
 *     CHANNEL_KEY_TAG,
 *     sender_addr,
 *     sender_private_viewing_key,
 *     recipient_addr,
 *     recipient_public_viewing_key,
 *   )
 *
 * For a *self-channel* (the one solvency proofs spend through), sender and
 * recipient are the same account, so the only inputs we need from the user
 * are their address and viewing key. The public viewing key is derived
 * deterministically as the x-coordinate of viewingKey·G on the STARK curve.
 */
import { ec, hash, shortString } from "starknet";

const CHANNEL_KEY_TAG = BigInt(shortString.encodeShortString("CHANNEL_KEY_TAG:V1"));

/** x-coordinate of `privateKey * G` on the STARK curve. */
export function derivePublicViewingKey(privateKey: bigint): bigint {
  const sk = "0x" + privateKey.toString(16).padStart(64, "0");
  const pubBytes = ec.starkCurve.getPublicKey(sk);
  // 33-byte compressed (prefix + 32-byte x) or 65-byte uncompressed (prefix + 32+32).
  const start = pubBytes.length === 33 || pubBytes.length === 65 ? 1 : 0;
  const xBytes = pubBytes.slice(start, start + 32);
  let x = 0n;
  for (const b of xBytes) x = (x << 8n) | BigInt(b);
  return x;
}

export function deriveSelfChannelKey(accountAddress: string, viewingKey: string): bigint {
  const addr = BigInt(accountAddress);
  const vk = BigInt(viewingKey);
  const pub = derivePublicViewingKey(vk);
  return BigInt(
    hash.computePoseidonHashOnElements([CHANNEL_KEY_TAG, addr, vk, addr, pub]),
  );
}
