# Deployment

## Prerequisites

`snfoundry.toml` has a `solvency` profile pointing at the devnet RPC with the relayer account.

## Full redeploy (new contract instance)

Use this when the contract has no `upgrade` function (fresh start).

```bash
# 1. Build
scarb build

# 2. Declare the new class
sncast --profile solvency declare --contract-name FactRegistry
# → prints: Class Hash: 0x...

# 3. Deploy a new instance
sncast --profile solvency deploy \
  --class-hash <CLASS_HASH_FROM_STEP_2> \
  --arguments '<PROGRAM_HASH>, <PROOF_VALIDITY_BLOCKS>, <PRIVACY_POOL>'
# → prints: Contract Address: 0x...
```

### Known constructor argument values

| Argument | Value |
|---|---|
| `expected_program_hash` | `0x3e98c2d7703b03a7edb73ed7f075f97f1dcbaa8f717cdf6e1a57bf058265473` |
| `proof_validity_blocks` | `1000` |
| `privacy_pool` | `0xd894af9ed2bdede33675049ae5285df000c44258a2250b84a9c3bed0d7c233` |

`expected_program_hash` is the `VIRTUAL_PROGRAM_HASH` from the starknet-privacy SDK
(`starknet-privacy/sdk/src/utils/proof-facts.ts`). Update it if the proving service
is redeployed.

```bash
# Example with current values:
sncast --profile solvency deploy \
  --class-hash <CLASS_HASH> \
  --arguments '0x3e98c2d7703b03a7edb73ed7f075f97f1dcbaa8f717cdf6e1a57bf058265473, 1000, 0xd894af9ed2bdede33675049ae5285df000c44258a2250b84a9c3bed0d7c233'
```

## Upgrade existing contract

Use this when the deployed contract already has an `upgrade` function (added in
`IFactRegistry` — see `src/lib.cairo`).

```bash
# 1. Build
scarb build

# 2. Declare the new class
sncast --profile solvency declare --contract-name FactRegistry
# → prints: Class Hash: 0x...

# 3. Invoke upgrade on the existing contract
sncast --profile solvency invoke \
  --contract-address <CURRENT_REGISTRY_ADDRESS> \
  --function upgrade \
  --calldata <CLASS_HASH_FROM_STEP_2>
```

## After deploying

Update `webapp/frontend/.env` with the new address:

```
VITE_FACT_REGISTRY_ADDRESS=<NEW_CONTRACT_ADDRESS>
```

Then restart the frontend dev server (Vite doesn't hot-reload `.env`):

```bash
pkill -f vite
cd webapp/frontend && npm run dev
```

The backend reads `FACT_REGISTRY` only from the request body (passed by the
frontend), so it does **not** need restarting after a redeploy.
