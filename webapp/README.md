# Proof of Solvency · Web app

A minimal end-to-end demo of the FactRegistry contract: connect an Argent X
or Braavos wallet, sign a SNIP-12 typed-data consent, get a ZK proof from the
hosted proving service, and have a relayer submit `register_fact` with the
proof attached on Starknet Sepolia.

```
┌────────────┐    sign      ┌─────────────────┐   POST /api/prove   ┌────────────┐
│  Frontend  │ ───────────▶ │  Wallet (Argent │ ────────────────▶  │  Backend   │
│ (Vite/React│              │   X / Braavos)  │                    │  (Node/    │
│  /Tailwind)│              └─────────────────┘                    │   Express) │
│            │                                                      └─────┬──────┘
│            │                            STARK proof + register tx        │
│            │ ◀──────────────────────────────────────────────────────────│
└─────┬──────┘                                                              │
      │ poll is_fact_registered                                              ▼
      │   + SolvencyFactRegistered events                              ┌─────────────┐
      └────────────────────────────────────────────────────────────▶   │ FactRegistry│
                                                                       │  on Starknet│
                                                                       └─────────────┘
```

## Layout

| Directory     | What                                                                 |
| ------------- | -------------------------------------------------------------------- |
| `frontend/`   | Vite + React + Tailwind UI. Wallet connect, balance check, SNIP-12 signing, claim list. |
| `backend/`    | Tiny Express service. Reuses `client/src/proveContractCall.ts` to call the prover, then submits `register_fact` from a relayer account. |

The wallet integration follows the Starknet wallet RPC spec
(`starknet-specs/wallet-api/wallet_rpc.json`) via `get-starknet-core` +
starknet.js's `WalletAccount`. The SNIP-12 typed-data schema is shared with
`client/src/consentTypedData.ts` — if you change one, edit the other and
regenerate the type-hash constants pinned in `src/lib.cairo`:

```bash
cd client && npx tsx src/computeTypeHashes.ts
```

## Quick start

```bash
# 1) deps
cd webapp/frontend && npm install
cd ../backend && npm install

# 2) configure backend relayer
cp webapp/backend/.env.example webapp/backend/.env
# fill in RELAYER_ADDRESS, RELAYER_PRIVATE_KEY (funded Sepolia account)

# 3) configure frontend
cp webapp/frontend/.env.example webapp/frontend/.env
# set VITE_FACT_REGISTRY_ADDRESS to the deployed FactRegistry

# 4) run both
cd webapp/backend && npm run dev
# (in another shell)
cd webapp/frontend && npm run dev
```

The frontend talks to `/api/prove`, which Vite proxies to the backend on
`http://localhost:8787`.

## User-facing flow

1. **Connect wallet.** Argent X / Braavos / Argent Mobile via get-starknet-core picker.
2. **Pick token + amount.** Token decimals + symbol are read live from the
   ERC-20. A vanilla `balanceOf` runs before the wallet popup — if your
   balance is below the threshold the form blocks submission with an inline
   error.
3. **Sign typed data.** The wallet shows a SNIP-12 message with the
   `(secret, min_balance, token)` consent. The secret is generated client-side
   and never leaves the browser until you export it.
4. **Backend proves + registers.** The relay calls the proving service with
   `verify_sig_and_balance` at `currentBlock - 10`, then submits
   `register_fact(slot)` with the proof attached as v3 extras.
5. **Claim appears.** The frontend polls `is_fact_registered` and scans
   `SolvencyFactRegistered` events — pending claims flip to "Registered" once
   the fact lands on chain. Each claim has an **Export claim bundle** button
   that copies a JSON blob a verifier needs (chain id, fact registry, slot,
   secret, min_balance, token, base block).

## Why a backend?

`register_fact` itself isn't authenticated — anyone can submit a valid proof.
But the transaction needs the proof attached as v3 envelope extras
(`proof_facts`, `proof`), which Argent X / Braavos don't yet expose through
`wallet_addInvokeTransaction`. Routing through a relayer side-steps that.
The user wallet only signs the SNIP-12 consent message; it never pays gas
and never has to handle proof bytes.

## Privacy properties

- The **secret** is generated in-browser via `crypto.getRandomValues` and is
  never sent to the backend, the proving service, or the chain in cleartext.
  Only `poseidon(secret)` is bound publicly (inside the slot).
- The **balance** at the base block is read by the proving service to assert
  the predicate, but only the threshold (`min_balance`) is observable on chain
  — not the exact balance.
- Two facts from the same address using different secrets produce different
  slots, so they can't be linked on chain by inspection. The user controls
  which verifier(s) they share each claim bundle with.
