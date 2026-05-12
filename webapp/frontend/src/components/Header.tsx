import { shortHex } from "../lib/utils.ts";
import type { ConnectedWallet } from "../lib/wallet.ts";
import { Logo } from "./Logo.tsx";

interface HeaderProps {
  connected: ConnectedWallet | null;
  onConnectClick: () => void;
  onDisconnectClick: () => void;
}

export function Header({ connected, onConnectClick, onDisconnectClick }: HeaderProps) {
  return (
    <header className="flex items-center justify-between gap-4 px-6 py-5 sm:px-10">
      <div className="flex items-center gap-3">
        <Logo className="h-9 w-9" />
        <div className="leading-tight">
          <div className="text-sm font-semibold tracking-tight text-ink-100">
            Proof of Solvency
          </div>
          <div className="text-[11px] uppercase tracking-[0.18em] text-ink-400">
            Starknet · ZK
          </div>
        </div>
      </div>
      <div className="flex items-center gap-3">
        {connected ? (
          <div className="flex items-center gap-2">
            <div className="hidden sm:flex items-center gap-2 rounded-xl border border-ink-700 bg-ink-900/60 px-3 py-1.5">
              <span className="h-2 w-2 rounded-full bg-success-400 shadow-[0_0_8px] shadow-success-400/80" />
              <span className="text-xs text-ink-300">
                {connected.wallet.name ?? "Wallet"}
              </span>
              <span className="mono text-xs text-ink-200">
                {shortHex(connected.address)}
              </span>
            </div>
            <button className="btn-ghost" onClick={onDisconnectClick}>
              Disconnect
            </button>
          </div>
        ) : (
          <button className="btn-primary" onClick={onConnectClick}>
            Connect wallet
          </button>
        )}
      </div>
    </header>
  );
}
