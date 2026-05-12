import { useState } from "react";
import { classNames, copyToClipboard, shortHex } from "../lib/utils.ts";
import type { Claim, ClaimStatus } from "../types.ts";

interface ClaimsListProps {
  claims: Claim[];
  onForget: (slot: string) => void;
}

export function ClaimsList({ claims, onForget }: ClaimsListProps) {
  return (
    <div className="card-glow p-6 sm:p-7">
      <div className="mb-5 flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold tracking-tight text-ink-100">
          Your on-chain claims
        </h2>
        <span className="text-[11px] uppercase tracking-[0.18em] text-ink-400">
          {claims.length} {claims.length === 1 ? "claim" : "claims"}
        </span>
      </div>

      {claims.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="space-y-3">
          {claims.map((c) => (
            <ClaimCard key={c.slot} claim={c} onForget={() => onForget(c.slot)} />
          ))}
        </ul>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-dashed border-ink-700 bg-ink-900/30 px-4 py-10 text-center">
      <div className="mx-auto mb-3 h-9 w-9 rounded-full border border-ink-700 bg-ink-800/70" />
      <div className="text-sm text-ink-200">No claims registered yet.</div>
      <div className="mt-1 text-xs text-ink-400">
        Prove solvency for a token and your fact will appear here.
      </div>
    </div>
  );
}

function ClaimCard({ claim, onForget }: { claim: Claim; onForget: () => void }) {
  const [copied, setCopied] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  async function handleCopy() {
    // The bundle is everything a verifier needs to recompute the slot and
    // call `is_fact_registered(slot)` themselves — without learning the
    // secret of any other claim of yours.
    const bundle = {
      kind: "starknet-proof-of-solvency-v1",
      chain_id: claim.chainId,
      fact_registry: claim.factRegistry,
      account: claim.account,
      secret: claim.secret,
      min_balance: claim.minBalance,
      token: claim.token,
      base_block_number: claim.baseBlockNumber,
      slot: claim.slot,
      verify: {
        method: "is_fact_registered",
        calldata: [claim.slot],
      },
    };
    await copyToClipboard(JSON.stringify(bundle, null, 2));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <li className="rounded-xl border border-ink-700/80 bg-ink-900/40 p-4 transition-colors hover:border-ink-600">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-base font-semibold tracking-tight text-ink-100">
              ≥ {claim.minBalanceDisplay}
            </span>
            <span className="text-sm text-ink-300">{claim.tokenSymbol}</span>
          </div>
          <div className="mt-0.5 text-[11px] text-ink-400">
            at block <span className="mono text-ink-300">#{claim.baseBlockNumber}</span>{" "}
            · token{" "}
            <span className="mono text-ink-300">{shortHex(claim.token, 6, 4)}</span>
          </div>
        </div>
        <StatusPill status={claim.status} />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
        <KV label="slot" value={shortHex(claim.slot, 10, 6)} />
        <KV label="tx" value={shortHex(claim.txHash, 10, 6)} />
      </div>

      <div className="mt-4 flex items-center justify-between gap-2">
        <button
          className={classNames(
            "btn-secondary flex-1 transition-colors",
            copied && "border-success-500/40 bg-success-500/10 text-success-400",
          )}
          onClick={handleCopy}
        >
          {copied ? "Copied ✓" : "Export claim bundle"}
        </button>
        {confirmingDelete ? (
          <button
            className="btn-ghost text-danger-400 hover:bg-danger-500/10 hover:text-danger-400"
            onClick={onForget}
          >
            Confirm forget
          </button>
        ) : (
          <button
            className="btn-ghost"
            onClick={() => {
              setConfirmingDelete(true);
              window.setTimeout(() => setConfirmingDelete(false), 3000);
            }}
            title="Forget locally — on-chain fact stays registered"
          >
            Forget
          </button>
        )}
      </div>
    </li>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-ink-400">{label}</span>
      <span className="mono text-ink-200">{value}</span>
    </div>
  );
}

function StatusPill({ status }: { status: ClaimStatus }) {
  if (status === "registered") {
    return (
      <span className="pill border border-success-500/30 bg-success-500/10 text-success-400">
        <span className="h-1.5 w-1.5 rounded-full bg-success-400" />
        Registered
      </span>
    );
  }
  if (status === "pending") {
    return (
      <span className="pill border border-accent-500/30 bg-accent-500/10 text-accent-400">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent-400" />
        Pending
      </span>
    );
  }
  return (
    <span className="pill border border-danger-500/30 bg-danger-500/10 text-danger-400">
      <span className="h-1.5 w-1.5 rounded-full bg-danger-400" />
      Failed
    </span>
  );
}
