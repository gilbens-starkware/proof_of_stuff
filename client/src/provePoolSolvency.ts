/**
 * End-to-end example: prove that the caller controls a balance >= THRESHOLD
 * inside the Starknet privacy pool, then register the resulting fact on the
 * `FactRegistry` contract (../src/lib.cairo).
 *
 * Flow:
 *   1. Use the privacy SDK to assemble a virtual block:
 *        UseNote(s) -> Withdraw(amount -> anonymizer)
 *        -> InvokeExternal(PoolSolvencyAnonymizer.privacy_invoke)
 *        -> CreateOpenNote (re-deposited back via OpenNoteDeposit).
 *      Net token movement: zero.
 *   2. Send the assembled tx to the proving service. The anonymizer asserts
 *      `amount >= threshold` and emits an L2->L1 message containing the slot.
 *      Slot shape is identical to the ERC-20 variant in `example.ts`:
 *        slot = Poseidon(H(secret), block, threshold.lo, threshold.hi, token).
 *   3. Extract the slot from the L1 messages the proving service returned.
 *   4. Submit `register_fact(slot, anonymizer)` on-chain with the proof
 *      attached as extras. FactRegistry validates the proof and stores the
 *      slot.
 *
 * After step 4, anyone can call `is_fact_registered(slot)` to confirm that
 * the prover controlled >= THRESHOLD of TOKEN in the pool at block N. The
 * exact balance, the spent note, and the new note are not revealed.
 */

import {
  Account,
  CallData,
  RpcProvider,
  TransactionFinalityStatus,
  cairo,
  constants,
} from "starknet";
import {
  createPrivateTransfers,
  type Proof,
  type ProofInvocation,
  type ProofProviderInterface,
  type ProvingBlockId,
  type StarknetAddress,
} from "starknet-sdk";
// Both deep imports mirror the escrow starter kit — the SDK exposes these
// pieces only via its internal dist paths.
// @ts-expect-error — deep import not in the declared exports
import { IndexerDiscoveryProvider } from "starknet-sdk/dist/internal/indexer-discovery.js";
// @ts-expect-error — deep import not in the declared exports
import { Open } from "starknet-sdk/dist/interfaces.js";
// @ts-expect-error — deep import not in the declared exports
import { ProvingService } from "starknet-sdk/dist/internal/proving-service.js";

interface MessageToL1 {
  from_address: string;
  to_address: string;
  payload: string[];
}

// --- env ---
const RPC_URL = required("RPC_URL");
const PROVING_SERVICE_URL = required("PROVING_SERVICE_URL");
const INDEXER_URL = required("INDEXER_URL");
const ACCOUNT_ADDRESS = required("ACCOUNT_ADDRESS");
const ACCOUNT_PRIVATE_KEY = required("ACCOUNT_PRIVATE_KEY");
const VIEWING_KEY = BigInt(required("VIEWING_KEY"));
const POOL_ADDRESS = required("POOL_ADDRESS");
const ANONYMIZER_ADDRESS = required("ANONYMIZER_ADDRESS");
const FACT_REGISTRY_ADDRESS = required("FACT_REGISTRY_ADDRESS");
const TOKEN_ADDRESS = required("TOKEN_ADDRESS");
const THRESHOLD = BigInt(required("THRESHOLD"));
const AMOUNT = BigInt(required("AMOUNT")); // how much to spend from notes; must be >= THRESHOLD
const SECRET = BigInt(required("SECRET"));

/**
 * Wraps the SDK's stock ProvingServiceProofProvider to keep the full proving
 * response around. The SDK's default implementation only surfaces the pool's
 * own L1 message; we also need the anonymizer's L1 message (the slot).
 */
class RecordingProofProvider implements ProofProviderInterface {
  lastMessages: MessageToL1[] = [];
  private provingService: any;

  constructor(
    baseUrl: string,
    private readonly chainId: constants.StarknetChainId,
  ) {
    this.provingService = new ProvingService({ baseUrl });
  }

  async prove(invocation: ProofInvocation, blockIdentifier?: ProvingBlockId): Promise<Proof> {
    const result = await this.provingService.proveTransaction(
      blockIdentifier ?? "latest",
      invocation,
    );

    this.lastMessages = result.l2_to_l1_messages ?? [];

    // Pool's own L1 message — payload = [class_hash, ...server_actions]. The
    // SDK consumer downstream strips the class_hash and applies the rest.
    const poolMessage = this.lastMessages.find(
      (m) => bigIntEq(m.from_address, invocation.sender_address),
    );

    return {
      data: result.proof,
      output: poolMessage?.payload ?? [],
      proofFacts: result.proof_facts ?? [],
    };
  }

  async getDefaultDetails(): Promise<any> {
    // The SDK calls this to fill in default invocation details. We don't need
    // any customization — return an empty object and let the SDK use its
    // built-in defaults.
    return {};
  }
}

async function main() {
  const provider = new RpcProvider({ nodeUrl: RPC_URL });
  const account = new Account({
    provider,
    address: ACCOUNT_ADDRESS,
    signer: ACCOUNT_PRIVATE_KEY,
    cairoVersion: "1",
  });

  const chainId = (await provider.getChainId()) as constants.StarknetChainId;

  const discovery = new IndexerDiscoveryProvider(INDEXER_URL, POOL_ADDRESS);
  const provingProvider = new RecordingProofProvider(PROVING_SERVICE_URL, chainId);

  // The SDK pins its own (older beta) `starknet` version, so `Account` types
  // don't structurally match. Cast — the runtime shape is identical.
  const transfers = createPrivateTransfers({
    account: account as never,
    viewingKeyProvider: { getViewingKey: async () => VIEWING_KEY },
    provingProvider: provingProvider as never,
    discoveryProvider: discovery as never,
    poolContractAddress: POOL_ADDRESS as StarknetAddress,
  });

  // The proving service runs against a slightly stale block, same convention as
  // the privacy SDK's escrow demo. Gives a margin against L2 reorgs and stays
  // well inside the FactRegistry's `proof_validity_blocks` window.
  const provingBlockId = (await provider.getBlockNumber()) - 10;
  console.log(`Proving against block ${provingBlockId}.`);
  console.log(
    `Will withdraw ${AMOUNT} (>= threshold ${THRESHOLD}) of ${TOKEN_ADDRESS} to anonymizer.`,
  );

  // Build the pool tx. Same-token withdraw+transfer pattern: the user's note(s)
  // are consumed, AMOUNT is withdrawn to the anonymizer, the anonymizer asserts
  // AMOUNT >= THRESHOLD, emits the slot, and approves the pool to pull AMOUNT
  // back into a freshly created open note.
  const { callAndProof } = await transfers
    .build({
      autoRegister: true,
      autoSetup: true,
      autoDiscover: { notes: "refresh", channels: "refresh" },
      autoSelectNotes: "all",
    })
    .with(TOKEN_ADDRESS as StarknetAddress, (t: any) =>
      t
        .withdraw({
          recipient: ANONYMIZER_ADDRESS as StarknetAddress,
          amount: AMOUNT,
        })
        .transfer({
          recipient: ACCOUNT_ADDRESS as StarknetAddress,
          amount: Open as never,
        }),
    )
    .invoke(({ openNotes, withdrawals }) => {
      const tokenBn = BigInt(TOKEN_ADDRESS);
      const note = openNotes.find((n) => BigInt(n.token) === tokenBn);
      const wd = withdrawals.find((w) => BigInt(w.token) === tokenBn);
      if (!note) throw new Error("anonymizer call: no matching open note");
      if (!wd) throw new Error("anonymizer call: no matching withdrawal");

      // `privacy_invoke(threshold: u128, token: ContractAddress, amount: u128,
      //  note_id: felt252, secret: felt252)` — see `PoolSolvencyAnonymizer` in
      // ../src/lib.cairo. The SDK passes `withdrawals[].amount` as bigint and
      // `openNotes[].noteId` as a felt; CallData handles serialization.
      return {
        contractAddress: ANONYMIZER_ADDRESS,
        calldata: CallData.compile([
          THRESHOLD,
          TOKEN_ADDRESS,
          wd.amount,
          note.noteId,
          SECRET,
        ]),
      };
    })
    .execute({ provingBlockId });

  // `execute` invoked `prove` internally; RecordingProofProvider stashed the
  // full L1 message list during that call.
  const anonymizerMessages = provingProvider.lastMessages.filter(
    (m) => bigIntEq(m.from_address, ANONYMIZER_ADDRESS),
  );
  if (anonymizerMessages.length !== 1) {
    throw new Error(
      `Expected exactly 1 L1 message from anonymizer, got ${anonymizerMessages.length}: ${JSON.stringify(
        provingProvider.lastMessages,
        null,
        2,
      )}`,
    );
  }
  const payload = anonymizerMessages[0].payload;
  if (payload.length !== 1) {
    throw new Error(`Expected single-felt slot payload, got ${payload.length}`);
  }
  const slot = payload[0];
  console.log(`Pool solvency slot: ${slot}`);

  // Register on-chain. FactRegistry asserts the L1 message [slot] came from
  // the anonymizer address (which it does — we pass it as `sender`), and that
  // the proving service's program hash is in the allowed set.
  const proofDetails = callAndProof.proof.proofFacts?.length
    ? { proofFacts: callAndProof.proof.proofFacts, proof: callAndProof.proof.data }
    : {};

  const tx = await account.execute(
    {
      contractAddress: FACT_REGISTRY_ADDRESS,
      entrypoint: "register_fact",
      calldata: [slot, ANONYMIZER_ADDRESS],
    },
    {
      tip: 0n,
      ...proofDetails,
    },
  );
  console.log(`register_fact submitted: ${tx.transaction_hash}`);

  await provider.waitForTransaction(tx.transaction_hash, {
    successStates: [TransactionFinalityStatus.ACCEPTED_ON_L2],
  });
  console.log(`Pool solvency fact registered at slot ${slot}.`);
}

function bigIntEq(a: string | bigint, b: string | bigint): boolean {
  return BigInt(a) === BigInt(b);
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

// Cairo's u256 helper kept around in case callers want to pre-format threshold.
export { cairo };
