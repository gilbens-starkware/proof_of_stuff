/**
 * Browser-side enumeration of a user's notes in the privacy pool, using only
 * the public view functions (`get_note`, `nullifier_exists`). Does NOT call
 * the discovery/indexer service — anything we need is on chain plus the
 * viewing key & channel key the user types in.
 *
 * The encrypted-amount unpacking mirrors what `verify_sig_and_pool_balance`
 * does in Cairo: salt = packed.high, enc_amount = packed.low, amount =
 * (enc_amount - h(ENC_AMOUNT_TAG, channel_key, token, index, 0, salt).low128)
 * mod 2^128.
 */
import { hash, shortString, type ProviderInterface } from "starknet";

const NOTE_ID_TAG = shortString.encodeShortString("NOTE_ID_TAG:V1");
const ENC_AMOUNT_TAG = shortString.encodeShortString("ENC_AMOUNT_TAG:V1");
const NULLIFIER_TAG = shortString.encodeShortString("NULLIFIER_TAG:V1");

const TWO_POW_128 = 1n << 128n;
const LOW_128_MASK = TWO_POW_128 - 1n;

export interface DiscoveredNote {
  index: number;
  noteId: string;
  amount: bigint;
  spent: boolean;
}

export interface DiscoverParams {
  provider: ProviderInterface;
  pool: string;
  token: string;
  channelKey: string;
  viewingKey: string;
  /** Hard cap on indices to probe — avoids infinite scan if the chain is busted. */
  maxIndices?: number;
  /** Stop after this many consecutive missing slots — channel doesn't extend past a gap. */
  stopAfterMissing?: number;
}

export async function discoverNotes(params: DiscoverParams): Promise<DiscoveredNote[]> {
  const max = params.maxIndices ?? 64;
  const stopAfter = params.stopAfterMissing ?? 3;

  const ck = BigInt(params.channelKey);
  const tk = BigInt(params.token);
  const vk = BigInt(params.viewingKey);

  const found: DiscoveredNote[] = [];
  let consecutiveMissing = 0;

  for (let i = 0; i < max; i++) {
    const noteId = hash.computePoseidonHashOnElements([
      BigInt(NOTE_ID_TAG),
      ck,
      tk,
      BigInt(i),
      0n,
    ]);

    const noteRes = await params.provider.callContract(
      {
        contractAddress: params.pool,
        entrypoint: "get_note",
        calldata: [noteId],
      },
      "latest",
    );
    const packed = BigInt(noteRes[0]);

    if (packed === 0n) {
      consecutiveMissing += 1;
      if (consecutiveMissing >= stopAfter) break;
      continue;
    }
    consecutiveMissing = 0;

    // unpack(packed_value) -> (salt: u128 high, enc_amount: u128 low)
    const salt = (packed >> 128n) & LOW_128_MASK;
    const encAmount = packed & LOW_128_MASK;

    const maskFull = BigInt(
      hash.computePoseidonHashOnElements([
        BigInt(ENC_AMOUNT_TAG),
        ck,
        tk,
        BigInt(i),
        0n,
        salt,
      ]),
    );
    const maskLow = maskFull & LOW_128_MASK;
    // (enc_amount - mask_low) mod 2^128, written without a negative intermediate.
    const amount = (encAmount + TWO_POW_128 - maskLow) & LOW_128_MASK;

    const nullifier = hash.computePoseidonHashOnElements([
      BigInt(NULLIFIER_TAG),
      ck,
      tk,
      BigInt(i),
      0n,
      vk,
    ]);
    const nulRes = await params.provider.callContract(
      {
        contractAddress: params.pool,
        entrypoint: "nullifier_exists",
        calldata: [nullifier],
      },
      "latest",
    );
    const spent = BigInt(nulRes[0]) !== 0n;

    found.push({ index: i, noteId, amount, spent });
  }

  return found;
}
