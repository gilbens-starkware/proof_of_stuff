/**
 * Pretty-printer for revert reasons coming back from the proving service.
 *
 * The proving service surfaces failed virtual executions as
 * "Internal error: Reverted transactions are not supported; …revert reason:
 * …Failure reason: …0xHEX ('cairo short string')". We pull the
 * single-quoted short string out and look it up in a small table of asserts
 * the FactRegistry / its helpers can raise.
 */

export interface FriendlyError {
  /** Short, headline-style label for the error box. */
  title: string;
  /** Optional one-liner explaining the cause. */
  detail?: string;
  /** The raw assert string we matched, if any — useful for support. */
  cairoAssert?: string;
}

const ASSERT_MAP: Record<string, FriendlyError> = {
  // verify_sig_and_balance / verify_sig_and_pool_balance shared
  "balance below min": {
    title: "Balance below threshold",
    detail:
      "The total of the selected notes is less than the minimum amount you asked to prove. " +
      "Tick more notes or lower the threshold.",
  },
  "invalid signature": {
    title: "Signature didn't validate",
    detail:
      "The signature doesn't match the account at this address. Check the private key " +
      "and the account address.",
  },
  "zero account": { title: "Account is empty" },
  "zero secret": { title: "Secret is empty" },
  "zero min_balance": { title: "Threshold must be greater than zero" },
  "zero token": { title: "Token address is empty" },

  // pool-specific
  "wrong privacy pool": {
    title: "Wrong pool address",
    detail: "This FactRegistry was pinned to a different pool at deploy time.",
  },
  "zero channel_key": { title: "Channel key is empty" },
  "zero viewing_key": { title: "Viewing key is empty" },
  "no note indices": { title: "No notes selected" },
  "subchannel not setup": {
    title: "Subchannel not set up",
    detail:
      "The pool has no subchannel for this (channel key, token, token index). " +
      "Make sure the token index matches the channel's tokenIndex.",
  },
  "token mismatch": {
    title: "Token doesn't match the channel",
    detail:
      "The token you typed isn't the one encrypted in this channel's subchannel. " +
      "Double-check the channel key + token pair.",
  },
  "note missing": {
    title: "Selected note doesn't exist",
    detail:
      "One of the picked indices isn't a real note in the pool. Re-run Discover and " +
      "only tick rows the table shows.",
  },
  "note already spent": {
    title: "Selected note is already spent",
    detail:
      "One of the picked notes was already nullified. The table marks spent notes — " +
      "re-run Discover and skip those rows.",
  },
  "indices not sorted": {
    title: "Duplicate or out-of-order notes",
    detail:
      "Note indices must be strictly increasing. The picker should always send a sorted list — " +
      "if you're seeing this from the UI, please report it.",
  },

  // register_fact-side asserts (after the proof is built, when submitting)
  "invalid program hash": {
    title: "Proof program hash isn't accepted",
    detail: "The proving service produced a proof under a program the registry hasn't whitelisted.",
  },
  "invalid variant": { title: "Proof program variant is wrong" },
  "invalid output version": { title: "Proof output version is wrong" },
  "invalid base block": { title: "Proof block is in the future" },
  "proof expired": {
    title: "Proof expired",
    detail: "The proof was generated too long ago; rerun to pin against a fresher block.",
  },
  "invalid message hash": {
    title: "Slot message hash mismatch",
    detail: "Internal mismatch between the proof's L1 message and the slot we tried to register.",
  },
  "empty proof facts": { title: "Proof facts missing from tx" },
};

const ASSERT_RE = /0x[0-9a-fA-F]+\s*\(\s*'([^']+)'\s*\)/;

/**
 * Extract the assert short-string from a revert reason, if present.
 * Returns null if no match.
 */
export function extractCairoAssert(message: string): string | null {
  const m = message.match(ASSERT_RE);
  return m ? m[1] : null;
}

/**
 * Translate a raw error message into something we can show to the user. Falls
 * back to the original message if nothing matches.
 */
export function friendlyError(raw: unknown): FriendlyError {
  const message = (raw as Error)?.message ?? String(raw ?? "");
  const assert = extractCairoAssert(message);
  if (assert && ASSERT_MAP[assert]) {
    return { ...ASSERT_MAP[assert], cairoAssert: assert };
  }
  if (assert) {
    return { title: `Contract assertion failed: ${assert}`, cairoAssert: assert };
  }
  // Network / non-revert errors fall through to the raw text.
  return { title: "Something went wrong", detail: message };
}
