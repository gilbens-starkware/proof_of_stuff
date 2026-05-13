import { useCallback, useEffect, useMemo, useState } from "react";
import { RpcProvider } from "starknet";
import { ClaimsList } from "./components/ClaimsList.tsx";
import { Header } from "./components/Header.tsx";
import { PassportProveCard } from "./components/PassportProveCard.tsx";
import { PoolProveCard } from "./components/PoolProveCard.tsx";
import { ProveCard } from "./components/ProveCard.tsx";
import { WalletPicker } from "./components/WalletPicker.tsx";
import {
  isFactRegistered,
  normalizeSlot,
  scanRegisteredSlots,
} from "./lib/factRegistry.ts";
import {
  deleteClaim as storageDeleteClaim,
  loadClaims,
  patchClaim,
  upsertClaim,
} from "./lib/storage.ts";
import type { StarknetWindowObject } from "get-starknet-core";
import {
  connectWallet,
  disconnectWallet,
  getLastConnectedWallet,
  type ConnectedWallet,
} from "./lib/wallet.ts";
import type { Claim, ConfigEnv } from "./types.ts";

export default function App() {
  const config: ConfigEnv = useMemo(
    () => ({
      rpcUrl:
        import.meta.env.VITE_RPC_URL ??
        "https://starknet-sepolia.public.blastapi.io",
      factRegistry: import.meta.env.VITE_FACT_REGISTRY_ADDRESS ?? "",
    }),
    [],
  );

  const provider = useMemo(
    () => new RpcProvider({ nodeUrl: config.rpcUrl }),
    [config.rpcUrl],
  );

  const [pickerOpen, setPickerOpen] = useState(false);
  const [connected, setConnected] = useState<ConnectedWallet | null>(null);
  const [tab, setTab] = useState<"public" | "private" | "identity">("public");
  // The pool tab works without a wallet; its claims are stored under the
  // user-typed account address. We lift that address up so the claim list +
  // event poller can switch which bucket they're watching.
  const [pendingPoolAccount, setPendingPoolAccount] = useState<string>("");
  const [claims, setClaims] = useState<Claim[]>([]);

  // The address whose claims show in the side list. Public tab = connected
  // wallet; private tab = whatever account the user typed in (or the
  // connected wallet, if they're proving for themselves).
  const activeAddress = useMemo<string | null>(() => {
    if (tab === "public" || tab === "identity") return connected?.address ?? null;
    if (pendingPoolAccount && isLikelyAddress(pendingPoolAccount)) return pendingPoolAccount;
    return connected?.address ?? null;
  }, [tab, connected?.address, pendingPoolAccount]);

  // Re-load claims whenever the active address changes.
  useEffect(() => {
    if (!activeAddress) {
      setClaims([]);
      return;
    }
    setClaims(loadClaims(activeAddress));
  }, [activeAddress]);

  // Silent reconnect on first paint, so users don't need to re-pick the wallet.
  useEffect(() => {
    let cancelled = false;
    getLastConnectedWallet().then(async (wallet) => {
      if (cancelled || !wallet) return;
      try {
        const c = await connectWallet(wallet, config.rpcUrl);
        if (!cancelled) setConnected(c);
      } catch {
        // ignore — user can click Connect explicitly.
      }
    });
    return () => {
      cancelled = true;
    };
  }, [config.rpcUrl]);

  // Watch the FactRegistry for new events that match any pending claim. We
  // poll on a slow cadence — the RPC providers we point at are public and we
  // don't want to hammer them.
  useEffect(() => {
    if (!activeAddress || !config.factRegistry) return;
    const pending = claims.filter((c) => c.status === "pending");
    if (pending.length === 0) return;

    let cancelled = false;
    const pendingSlots = new Set(pending.map((c) => normalizeSlot(c.slot)));
    const fromBlock = Math.max(
      0,
      Math.min(...pending.map((c) => c.baseBlockNumber)) - 1,
    );

    async function tick() {
      try {
        // Cheap path: poll is_fact_registered for each pending slot in parallel.
        const results = await Promise.all(
          pending.map((c) =>
            isFactRegistered(provider, config.factRegistry, c.slot).then(
              (r) => [c.slot, r] as const,
            ),
          ),
        );
        if (cancelled) return;
        let updated = false;
        for (const [slot, registered] of results) {
          if (registered && pendingSlots.has(normalizeSlot(slot))) {
            const next = patchClaim(activeAddress!, slot, { status: "registered" });
            setClaims(next);
            pendingSlots.delete(normalizeSlot(slot));
            updated = true;
          }
        }
        // Fallback: a wider event scan in case the slot encoding diverged
        // — runs only if direct read didn't resolve anything this tick.
        if (!updated) {
          const slots = await scanRegisteredSlots(
            provider,
            config.factRegistry,
            fromBlock,
          );
          if (cancelled) return;
          for (const seen of slots) {
            if (pendingSlots.has(seen)) {
              const next = patchClaim(activeAddress!, seen, {
                status: "registered",
              });
              setClaims(next);
              pendingSlots.delete(seen);
            }
          }
        }
      } catch (e) {
        console.warn("fact polling failed", e);
      }
    }

    void tick();
    const id = window.setInterval(tick, 8_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [claims, activeAddress, config.factRegistry, provider]);

  const handleSelectWallet = useCallback(
    async (wallet: StarknetWindowObject) => {
      setPickerOpen(false);
      try {
        const c = await connectWallet(wallet, config.rpcUrl);
        setConnected(c);
      } catch (e) {
        console.error(e);
        alert(`Could not connect: ${(e as Error).message}`);
      }
    },
    [config.rpcUrl],
  );

  const handleDisconnect = useCallback(async () => {
    await disconnectWallet();
    setConnected(null);
  }, []);

  const handleClaim = useCallback(
    (claim: Claim) => {
      // The pool flow may produce claims for an address that isn't the
      // currently connected wallet — store them under the claim's own
      // `account`, not whatever wallet is connected.
      const list = upsertClaim(claim.account, claim);
      if (claim.account.toLowerCase() === (activeAddress ?? "").toLowerCase()) {
        setClaims(list);
      } else if (claim.account.toLowerCase() === pendingPoolAccount.toLowerCase()) {
        setClaims(list);
      }
    },
    [activeAddress, pendingPoolAccount],
  );

  const handleForget = useCallback(
    (slot: string) => {
      if (!activeAddress) return;
      const list = storageDeleteClaim(activeAddress, slot);
      setClaims(list);
    },
    [activeAddress],
  );

  return (
    <div className="mx-auto flex min-h-full max-w-6xl flex-col">
      <Header
        connected={connected}
        onConnectClick={() => setPickerOpen(true)}
        onDisconnectClick={handleDisconnect}
      />

      <main className="flex-1 px-6 pb-16 pt-6 sm:px-10">
        <Hero />

        {!config.factRegistry ? (
          <MissingConfigCard />
        ) : (
          <>
            <Tabs tab={tab} onChange={setTab} />
            <div className="grid gap-6 lg:grid-cols-[1.05fr_0.95fr]">
              {tab === "public" ? (
                connected ? (
                  <ProveCard
                    connected={connected}
                    provider={provider}
                    config={config}
                    onClaim={handleClaim}
                  />
                ) : (
                  <NotConnectedCard onConnectClick={() => setPickerOpen(true)} />
                )
              ) : tab === "identity" ? (
                connected ? (
                  <PassportProveCard
                    connected={connected}
                    config={config}
                    onClaim={handleClaim}
                  />
                ) : (
                  <NotConnectedCard onConnectClick={() => setPickerOpen(true)} />
                )
              ) : (
                <PoolProveCard
                  provider={provider}
                  config={config}
                  onClaim={handleClaim}
                  onAccountChange={setPendingPoolAccount}
                />
              )}
              <ClaimsList claims={claims} onForget={handleForget} />
            </div>
          </>
        )}
      </main>

      <Footer factRegistry={config.factRegistry} />

      <WalletPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={handleSelectWallet}
      />
    </div>
  );
}

function Tabs({
  tab,
  onChange,
}: {
  tab: "public" | "private" | "identity";
  onChange: (t: "public" | "private" | "identity") => void;
}) {
  return (
    <div className="mb-6 inline-flex rounded-xl border border-ink-700 bg-ink-800/40 p-1 text-xs">
      <TabButton active={tab === "public"} onClick={() => onChange("public")}>
        Public balance
      </TabButton>
      <TabButton active={tab === "private"} onClick={() => onChange("private")}>
        Private balance
      </TabButton>
      <TabButton active={tab === "identity"} onClick={() => onChange("identity")}>
        Identity
      </TabButton>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        active
          ? "rounded-lg bg-accent-500/15 px-4 py-1.5 font-medium text-accent-300"
          : "rounded-lg px-4 py-1.5 font-medium text-ink-300 hover:text-ink-100"
      }
    >
      {children}
    </button>
  );
}

function isLikelyAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{50,66}$/.test(s.trim());
}

function Hero() {
  return (
    <section className="mb-10 max-w-3xl">
      <span className="pill border border-accent-500/30 bg-accent-500/5 text-accent-400">
        <span className="h-1.5 w-1.5 rounded-full bg-accent-400" />
        Starknet · Virtual block prover
      </span>
      <h1 className="mt-4 text-3xl font-semibold tracking-tight text-ink-100 sm:text-4xl">
        Prove you hold a balance without revealing it.
      </h1>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-300 sm:text-base">
        Sign a single typed-data message and we generate a STARK proof that
        your address held at least the chosen balance at a specific block.
        The fact lands on Starknet under a secret-derived slot — share it with
        whoever needs to verify, nobody else sees a thing.
      </p>
    </section>
  );
}

function NotConnectedCard({ onConnectClick }: { onConnectClick: () => void }) {
  return (
    <div className="card-glow flex flex-col items-start gap-4 p-8 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <div className="text-base font-semibold text-ink-100">Connect to begin</div>
        <div className="mt-1 max-w-md text-sm text-ink-300">
          You'll sign a SNIP-12 typed message authorising a single solvency
          claim. No transactions are submitted from your wallet for proof
          generation.
        </div>
      </div>
      <button className="btn-primary" onClick={onConnectClick}>
        Connect wallet
      </button>
    </div>
  );
}

function MissingConfigCard() {
  return (
    <div className="card-glow p-6">
      <div className="text-base font-semibold text-ink-100">
        Missing FactRegistry address
      </div>
      <p className="mt-2 text-sm text-ink-300">
        Set{" "}
        <code className="mono rounded bg-ink-800 px-1.5 py-0.5 text-xs">
          VITE_FACT_REGISTRY_ADDRESS
        </code>{" "}
        in <code className="mono rounded bg-ink-800 px-1.5 py-0.5 text-xs">.env</code> and
        restart the dev server.
      </p>
    </div>
  );
}

function Footer({ factRegistry }: { factRegistry: string }) {
  return (
    <footer className="border-t border-ink-800/80 px-6 py-6 text-xs text-ink-400 sm:px-10">
      <div className="flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-center">
        <div>
          Powered by the privacy pool proving service. SNIP-12 signing via
          Argent X · Braavos.
        </div>
        <div className="mono">
          {factRegistry ? `registry ${factRegistry.slice(0, 8)}…${factRegistry.slice(-6)}` : ""}
        </div>
      </div>
    </footer>
  );
}
