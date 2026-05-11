# Track 07 — Proof of Solvency / Identity / Eligibility

ZK proofs that let users prove facts about themselves (solvency, identity, eligibility) without revealing the underlying data — built on top of the new Starknet privacy pool.

**Suggested deliverables:**
- Demo: verify a specific claim without revealing underlying data.
- At least one working proof type (we're aiming at **solvency** first).

## Resources

| Resource | What it is |
|---|---|
| [starkware-libs/starknet-privacy](https://github.com/starkware-libs/starknet-privacy) | The privacy pool monorepo. Cairo pool contract, TS SDK, discovery + proving services. Auth: needs `gh auth refresh -s read:packages` for the npm package. |
| [Akashneelesh/starknet-privacy-starter-kit](https://github.com/Akashneelesh/starknet-privacy-starter-kit) | Clone-and-go template. Working escrow demo wired to hosted Sepolia, escrow Cairo contract (uses `privacy_invoke`), deploy script. Expects `starknet-privacy/` as a sibling clone. |
| Privacy SDK deck (Ittay Dror) | TS SDK overview: builder pattern over deposit/transfer/withdraw + `.invoke()` for custom anonymizers. Setup needs Node 24, `read:packages` GitHub token. |

## Hosted Sepolia endpoints

- Prover: `http://34.29.249.119:30001`
- Discovery: `http://35.192.48.142:8080/`
- Pool: `0x254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d911`

## Architecture recap

```
Wallet → SDK → Proving Service (virtual block + ZK proof)
                                      ↓
              Starknet ← Pool Contract ← Anonymizer (privacy_invoke)
                            ↑
                       Discovery Service (indexes encrypted storage)
```

- **Notes** are UTXO-style with nullifiers and Poseidon commitments. Organized in channels/subchannels. Encrypted or open.
- **Action phases** (enforced order in a tx): `SetViewingKey` → `OpenChannel` → `OpenSubchannel` → `Deposit` → `UseNote` → `CreateEncNote` / `CreateOpenNote` → `Withdraw` → `InvokeExternal` (≤1 per tx).
- **Anonymizers** are external Cairo contracts called via the `privacy_invoke` selector. They receive typed args + (optionally) tokens withdrawn by the pool, run arbitrary Cairo logic, emit events, and return `Span<OpenNoteDeposit>` for the pool to apply.

## Why this fits Track 07

`privacy_invoke` is a natural predicate hook. We write a Cairo contract whose body asserts the claim, and the proving service produces a ZK proof of the whole virtual block — so any predicate that holds inside `privacy_invoke` is implicitly proven, with the public inputs (threshold, claim tag, token) exposed on-chain as an event.

The reference example in the starter kit is the **escrow** contract: ~150 lines of Cairo + a small React UI. Our solvency anonymizer is the same shape, different predicate.

## Proposed proof type — Solvency

Prove "address X holds ≥ T in token Y in the pool" without revealing balance or note structure.

**Anonymizer signature (sketch):**

```cairo
fn privacy_invoke(
    ref self: T,
    threshold: u128,
    claim_tag: felt252,       // public binding (e.g. recipient or Poseidon(addr, salt))
    token: ContractAddress,
    amount: u128,             // attested amount (pool guarantees it matches the on-chain action)
    note_id: felt252,         // re-deposit target so funds stay in pool
) -> Span<OpenNoteDeposit>
```

**Tx flow inside the pool:** `UseNote → Withdraw(amount → anonymizer) → InvokeExternal → CreateOpenNote`.

The anonymizer asserts `amount >= threshold`, emits `SolvencyProven { claim_tag, threshold, token, block }`, approves the pool to pull tokens back, and returns one `OpenNoteDeposit` so the same amount lands in a fresh note. Net token movement: zero. Output: a verifiable on-chain claim.

Eligibility ("I hold a note with property P") is the same shape with a different predicate. Identity needs an external attestation issuer, so we're skipping it unless someone has a source in mind.
