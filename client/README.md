# Proving arbitrary Cairo calls with the virtual-block prover

A minimal client for the same proving service the Starknet privacy pool uses,
but pointed at **your own Cairo contract** instead of the pool's `apply_actions`.
You hand it a function call and a block; it hands you back a STARK proof you
can attach to a follow-up on-chain transaction, where a verifier contract
checks the proof facts and accepts the result as truth.

This directory contains:

- [`src/proveContractCall.ts`](src/proveContractCall.ts) — the wrapper, including
  an inlined JSON-RPC client for the proving service. Self-contained; depends
  only on `starknet`.
- [`src/example.ts`](src/example.ts) — an end-to-end run against the
  `FactRegistry` contract in [`../src/lib.cairo`](../src/lib.cairo).
- `package.json` / `tsconfig.json` — minimal Node/TS setup.

If you've used `@starkware-libs/starknet-privacy-sdk`, the JSON-RPC client is
ported from `dist/internal/proving-service.js` (MIT) — same wire protocol,
trimmed of the OHTTP envelope, zod validation, and health-check helpers we
don't need. The pool-specific glue (action serialization, message-source
filtering by pool address) is gone.

---

## The two-block model

Every proof in this system involves two blocks and two distinct executions of
your contract logic:

```
   ┌──────────────────────────┐         ┌──────────────────────────┐
   │   Virtual block (N)      │         │   Real block (N+k)        │
   │                          │         │                          │
   │   Proving service runs   │  STARK  │   Real chain executes    │
   │   `verify_sig_and_bal`   │ ──────► │   `register_fact(slot)`  │
   │   over Starknet state    │  proof  │   verifier consumes      │
   │   at block N             │  facts  │   proof_facts            │
   │                          │         │                          │
   └──────────────────────────┘         └──────────────────────────┘
```

1. **Virtual execution (the "prover" function).** The proving service spins up
   a sandboxed Starknet block at base block N and runs your function. It reads
   real chain state at block N (storage, balances, foreign-contract calls — all
   the usual syscalls work), produces a STARK proof of that execution, and
   records its outputs as L2→L1 messages. The proof binds to:
   - the program hash (`virtual_program_hash`)
   - the program variant (`VIRTUAL_SNOS` — the "virtual Starknet OS")
   - the base block (`base_block_number`, `base_block_hash`)
   - the hashes of every L2→L1 message the virtual execution emitted

2. **On-chain verification (the "registrar" function).** A separate transaction
   submitted at block N+k carries the proof as a v3 transaction extra. Your
   verifier contract reads `tx_info.proof_facts` via
   `get_execution_info_v3_syscall`, checks the program hash matches what it
   expects, checks the base block is recent (`N+k - N <= proof_validity_blocks`),
   recomputes the expected message hash from its own arguments, and asserts it
   matches the proven one. If everything lines up, the verifier commits a fact
   to storage.

The proving service knows nothing about your contract beyond what's encoded in
the program hash. The verifier contract knows nothing about the proving
service beyond the layout of `ProofFacts`. They communicate via the message
hashes — the prover hashes whatever the virtual execution emitted, the
verifier reconstructs the expected hash from its own inputs, and the match (or
mismatch) is the verdict.

---

## The example contract: `FactRegistry`

[`../src/lib.cairo`](../src/lib.cairo) is a small contract that proves balance
solvency. Two entrypoints:

### `verify_sig_and_balance` — runs **inside the virtual block**

```cairo
fn verify_sig_and_balance(
    ref self: ContractState,
    account: ContractAddress,
    secret: felt252,
    signature: Array<felt252>,
    min_balance: u256,
    token: ContractAddress,
);
```

Inside the virtual execution at base block N, this function:

1. Computes a domain-separated **consent hash** over `(secret, min_balance,
   token)` and asserts the user's account signed it. Without this step, anyone
   knowing your address could generate fake solvency facts about you.
2. Calls the ERC-20 at `token` and asserts `balance_of(account) >= min_balance`.
3. Emits **one L2→L1 message** with `to_address = 0` and a single-felt payload:
   ```
   slot = poseidon(poseidon(secret), N, min_balance.lo, min_balance.hi, token)
   ```

That slot is the "fact". `secret` is the user's private nonce — `poseidon(secret)`
is what gets bound publicly, while `secret` itself stays in the prover's
witness. Two different users (or two facts from the same user) using different
secrets produce different slots, so facts can't be linked by inspection.

### `register_fact` — runs on the **real chain**

```cairo
fn register_fact(ref self: ContractState, slot: felt252);
```

When called as a regular Starknet transaction with the proof bundle attached,
this function:

1. Deserializes `tx_info.proof_facts` into the `ProofFacts` struct.
2. Asserts `program_variant == VIRTUAL_SNOS` (right program family).
3. Asserts `virtual_program_hash == self.expected_program_hash` (right
   program — pinned at deploy time, this is what binds proofs to "the
   `verify_sig_and_balance` we know").
4. Asserts `current_block - proof_facts.base_block_number <= proof_validity_blocks`
   (proof isn't ancient).
5. Computes `expected_msg_hash = poseidon(this_contract, 0, [1, slot])` —
   the same hash the L2→L1 syscall produced inside the virtual block — and
   asserts it appears in `proof_facts.message_to_l1_hashes`.
6. Writes `facts[slot] = true`.

Anyone can later call `is_fact_registered(slot)` to confirm the fact stands.

The trust path: if `expected_program_hash` is wrong, `register_fact` is
worthless (anyone could deploy a fake "verifier" that emits anything and
register its slot). Set it to the program hash of the exact
`verify_sig_and_balance` you intend to honor, computed when the contract is
deployed.

---

## The wrapper API

```ts
import { proveContractCall, findMessageFrom } from "./proveContractCall.ts";

const result = await proveContractCall({
  provingServiceUrl: "https://prover.example.com:3000",
  blockId: (await provider.getBlockNumber()) - 10,
  account,
  call: {
    contractAddress: factRegistryAddress,
    entrypoint: "verify_sig_and_balance",
    calldata: CallData.compile([
      userAddress,
      secret,
      [r, s],
      cairo.uint256(minBalance),
      tokenAddress,
    ]),
  },
  chainId: constants.StarknetChainId.SN_SEPOLIA,
});

// → { proof: string, proofFacts: string[], messages: MessageToL1[] }
```

`result.proof` and `result.proofFacts` plug straight into `account.execute`:

```ts
const tx = await account.execute(
  { contractAddress: factRegistryAddress, entrypoint: "register_fact", calldata: [slot] },
  { tip: 0n, proof: result.proof, proofFacts: result.proofFacts },
);
```

The wrapper does four things behind the scenes:

1. **Wraps your call in `__execute__`**. Every Starknet v3 INVOKE flows through
   the sender account's `__execute__` entrypoint; the prover expects that
   shape. We hand-roll the layout `[1, to, selector, inner_len, ...inner]`
   instead of pulling in the account ABI.
2. **Builds the V3 envelope**: nonce, resource bounds, DA modes, tip. We mirror
   the privacy SDK's defaults exactly: high `l2_gas.max_amount`, zero prices
   (the prover doesn't charge), L1 DA modes, `nonce = 0`.
3. **Signs the transaction** with the account's signer. The privacy SDK passes
   `skipValidate: true` server-side, so the signature is mostly cosmetic — but
   the JSON-RPC schema still wants a populated `signature` field. Using the
   account's real signer is the path of least resistance.
4. **POSTs `starknet_proveTransaction`** through the inlined JSON-RPC client
   at the bottom of the file — plain `fetch`, no external dependencies beyond
   `starknet`.

---

## End-to-end example

[`src/example.ts`](src/example.ts) wires the whole flow against the
`FactRegistry` contract. Set the env vars and run.

```bash
cd proof_of_stuff/client
npm install

# Required env. Put these in a local .env or export inline.
export RPC_URL="https://starknet-sepolia.public.blastapi.io"
export PROVING_SERVICE_URL="https://prover.your-deployment.example/v1"
export ACCOUNT_ADDRESS="0x..."         # the user whose balance is being proven
export ACCOUNT_PRIVATE_KEY="0x..."     # their signer key
export FACT_REGISTRY_ADDRESS="0x..."   # deployed FactRegistry
export TOKEN_ADDRESS="0x049d..."       # ERC-20 to read balance from
export MIN_BALANCE="1000000000000000000"   # 1.0, scaled by token decimals
export SECRET="0x1337beef"             # user-chosen, must be non-zero

npm run example
```

What the script does, in the same order the comments lay it out:

```
1. Sign poseidon(DOMAIN_TAG, secret, min_balance.lo, min_balance.hi, token)
   with the user's account key. Sent into the prover as `signature`.

2. Call proveContractCall({ blockId: currentBlock - 10, ... }).
   The prover runs verify_sig_and_balance at block N:
     - verifies the consent signature against the user's account
     - reads balance_of(account) at block N
     - emits L2→L1 message with payload=[slot]
   Returns { proof, proofFacts, messages }.

3. Read slot from result.messages — the single felt in the payload of
   the message whose from_address is FactRegistry.

4. account.execute({ entrypoint: "register_fact", calldata: [slot] },
                   { proof, proofFacts, tip: 0n })
   The contract verifies proof_facts and writes facts[slot] = true.
```

Once step 4 confirms, `is_fact_registered(slot)` returns true, and the fact
that `account` had ≥ `min_balance` of `token` at block N is public knowledge.
Nobody learns `secret`, and nobody learns the exact balance.

---

## Adapting the wrapper to a different contract

The wrapper itself is contract-agnostic — anything you can express as a
`Call` works. To adapt the recipe:

1. **Write the prover function.** Standard Cairo. It can read any chain state
   at the base block (`get_block_number()`, foreign dispatchers, storage), and
   it should emit one or more L2→L1 messages whose payloads encode the public
   output you want to commit to. Domain-tag your hashes — the prover function
   is callable by anyone, so anything you'd be uncomfortable with someone
   else triggering needs explicit consent (a signature, a stored permission,
   etc).

2. **Write the verifier function.** Mirror `register_fact`'s pattern: pin the
   expected program hash at deploy, validate `program_variant`,
   `virtual_program_hash`, base-block age, and recompute the expected message
   hash from the verifier's own inputs. Do not trust anything from
   `proof_facts.message_to_l1_hashes` except as a target to match.

3. **Compute the program hash.** This is the hash of the Cairo program as
   compiled for the virtual-Starknet-OS variant. The pool's deploy story
   bakes it in as a constructor argument; do the same.

4. **Match `proof_validity_blocks` to your tolerance.** The privacy pool uses
   450 blocks (~1 hour on Sepolia). Picking that bound is a tradeoff between
   the staleness you tolerate and the proof-replay window you accept.

5. **Choose `blockId`.** `currentBlock - 10` is a safe default for two reasons:
   - **L2 reorg buffer.** Running against the chain head means a reorg can
     invalidate the base block before your `register_fact` tx lands.
   - **State freshness.** If the action being proven depends on state that
     was modified in the very recent past (e.g. a deposit you just made),
     you may need to wait *more* than 10 blocks to be confident the state at
     `currentBlock - 10` includes it. Re-fetch `currentBlock` after any
     preparatory transaction.

The wrapper takes anything for `blockId` that the JSON-RPC schema accepts:
a block number, `{ block_hash: "0x..." }`, or `"latest"` (avoid `latest` in
practice — see above).

---

## Gotchas

- **`proofFacts: []` must be omitted, not passed as an empty array.** The
  example does this conditionally:
  ```ts
  const proofDetails = result.proofFacts.length
    ? { proofFacts: result.proofFacts, proof: result.proof }
    : {};
  ```
  If the prover returns no facts (test mode, mock provider), passing
  `proofFacts: []` makes starknet.js serialize a malformed v3 envelope.

- **`tip: 0n` is required.** starknet.js v6+ throws
  `Cannot mix BigInt and other types` if you omit it. Pass `0n` even when not
  actually tipping.

- **`skipValidate` and signatures.** The privacy SDK defaults to
  `skipValidate: true`, which tells the prover not to run `__validate__` on
  the sender. We follow that pattern, but starknet.js's V3 envelope still
  requires a populated signature, so the wrapper signs with the account's
  real signer. If you're proving against an infrastructure that *doesn't*
  set `skipValidate`, replace the dummy sender with the user's real account
  (already the case here) and ensure the nonce matches reality.

- **`nonce: 0n`.** Same justification — with `skipValidate`, the prover
  doesn't check it. If you ever turn off `skipValidate`, fetch the real nonce
  for the sender via `provider.getNonceForAddress(sender, "latest")`.

- **Message order.** `proof_facts.message_to_l1_hashes` preserves the order
  the L2→L1 syscalls were emitted in. If your prover function emits more than
  one message, the verifier must compare hashes positionally, not as a set.

- **`current_block > base_block_number`.** The verifier asserts strict
  inequality (`<`), so a proof at block N cannot be registered in the same
  block N. If your test setup is fast enough to hit that, the verifier will
  revert with `'invalid base block'`. The `-10` offset takes care of this in
  practice.

---

## How this differs from the privacy-pool flow

The privacy SDK does everything this wrapper does, plus:

- Serializes a typed action set (deposits, transfers, withdrawals) into
  calldata for the pool's `compile_actions` entrypoint, using the pool ABI.
- Filters L2-to-L1 messages by `from_address == pool` (the pool emits its
  serialized server actions to L1 as a single message). `findMessageFrom`
  here mirrors that pattern for an arbitrary contract.
- Caches the pool nonce, supplies discovery, manages the action lifecycle
  (channel setup, note maturity, surplus routing).

If you only need "prove this Cairo call", none of that is in your way — the
proving service itself is generic, and the privacy-pool glue lives entirely
in the SDK's `ProofInvocationFactory` and `ProvingServiceProofProvider`. This
wrapper is the smallest TypeScript surface that talks to the same backend
without going through the pool-specific factory.
