#!/usr/bin/env bash
set -e

RPC="http://34.170.198.113:9545/rpc/v0_10"
ACCOUNT="0x048fc73029bbdf97facb35b8b2936a2ea5f851df7acfd56cbe7dd73564911889"
PRIVATE_KEY="0x197512021a520a8477999aeef8a8287d5e4893a1a70473baf386eef05cfc9e0"
REGISTRY="0x0661d41d6495fa422105e5c1e3954f343a292fa0e824cd6a03cdc0794afd0777"
ARTIFACT="target/dev/proof_of_solvency_FactRegistry.contract_class.json"

cd "$(dirname "$0")/.."

echo "==> Declaring new class..."
NEW_CLASS=$(starkli declare "$ARTIFACT" \
  --rpc "$RPC" \
  --account "$ACCOUNT" \
  --private-key "$PRIVATE_KEY" \
  --watch 2>&1 | tee /dev/stderr | grep "^0x" | tail -1)

echo "New class hash: $NEW_CLASS"

echo "==> Upgrading FactRegistry at $REGISTRY..."
starkli invoke "$REGISTRY" upgrade "$NEW_CLASS" \
  --rpc "$RPC" \
  --account "$ACCOUNT" \
  --private-key "$PRIVATE_KEY" \
  --watch

echo "==> Done."
