import { useEffect, useState } from "react";
import { getAvailableWallets } from "../lib/wallet.ts";
import type { StarknetWindowObject } from "get-starknet-core";

interface WalletPickerProps {
  open: boolean;
  onClose: () => void;
  onSelect: (wallet: StarknetWindowObject) => void;
}

export function WalletPicker({ open, onClose, onSelect }: WalletPickerProps) {
  const [wallets, setWallets] = useState<StarknetWindowObject[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setWallets(null);
    setError(null);
    getAvailableWallets()
      .then(setWallets)
      .catch((e) => setError(e.message ?? "Failed to load wallets"));
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-ink-950/80 backdrop-blur-sm" />
      <div
        className="card relative w-full max-w-md animate-fade-in p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <div>
            <div className="text-lg font-semibold tracking-tight">Connect a wallet</div>
            <div className="text-xs text-ink-400">
              Argent X, Braavos, and other Starknet wallets.
            </div>
          </div>
          <button className="btn-ghost px-2" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {error && (
          <div className="rounded-xl border border-danger-500/30 bg-danger-500/10 px-3 py-2 text-sm text-danger-400">
            {error}
          </div>
        )}

        {!wallets && !error && (
          <div className="space-y-2">
            <WalletRowSkeleton />
            <WalletRowSkeleton />
          </div>
        )}

        {wallets && wallets.length === 0 && (
          <div className="rounded-xl border border-ink-700 bg-ink-800/40 px-4 py-6 text-center text-sm text-ink-300">
            No Starknet wallets detected. Install{" "}
            <a
              className="text-accent-400 underline-offset-4 hover:underline"
              href="https://www.argent.xyz/argent-x/"
              target="_blank"
              rel="noreferrer"
            >
              Argent X
            </a>{" "}
            or{" "}
            <a
              className="text-accent-400 underline-offset-4 hover:underline"
              href="https://braavos.app/"
              target="_blank"
              rel="noreferrer"
            >
              Braavos
            </a>{" "}
            to continue.
          </div>
        )}

        <div className="space-y-2">
          {wallets?.map((w) => (
            <button
              key={w.id}
              className="flex w-full items-center gap-3 rounded-xl border border-ink-700 bg-ink-900/60 px-3 py-3 text-left transition-colors hover:border-accent-500/60 hover:bg-ink-800/60"
              onClick={() => onSelect(w)}
            >
              {w.icon ? (
                <img
                  src={typeof w.icon === "string" ? w.icon : w.icon.light}
                  alt=""
                  className="h-9 w-9 rounded-lg bg-ink-800"
                />
              ) : (
                <div className="h-9 w-9 rounded-lg bg-ink-700" />
              )}
              <div className="flex-1">
                <div className="text-sm font-semibold">{w.name}</div>
                <div className="text-[11px] text-ink-400">{w.id}</div>
              </div>
              <span className="text-ink-400">→</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function WalletRowSkeleton() {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-ink-700 bg-ink-900/60 px-3 py-3">
      <div className="h-9 w-9 rounded-lg bg-ink-800 shimmer-bg" />
      <div className="flex-1 space-y-2">
        <div className="h-3 w-1/3 rounded bg-ink-800 shimmer-bg" />
        <div className="h-2.5 w-1/4 rounded bg-ink-800 shimmer-bg" />
      </div>
    </div>
  );
}
