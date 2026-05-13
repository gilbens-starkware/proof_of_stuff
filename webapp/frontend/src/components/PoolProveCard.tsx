/**
 * No-wallet variant of ProveCard for the privacy-pool flow.
 *
 * The user pastes everything the contract needs into form fields, including
 * the private key used to sign the SNIP-12 consent. We sign client-side via
 * starknet.js `ec.starkCurve.sign` so the key never leaves the browser. The
 * backend then runs the same prove + relay pattern as `/api/prove`, but with
 * `verify_sig_and_pool_balance` as the proven entrypoint.
 *
 * The "pool address" is baked in as a default (it's pinned in the new
 * FactRegistry's storage), but the field is editable in case someone wants to
 * point at a different deployment.
 */
import { useEffect, useMemo, useState } from "react";
import { ec, RpcProvider, typedData as snTypedData, uint256 } from "starknet";
import { postPoolProve } from "../lib/api.ts";
import { deriveSelfChannelKey } from "../lib/channelKey.ts";
import { fetchTokenInfo, formatAmount, parseAmount } from "../lib/erc20.ts";
import type { TokenInfo } from "../lib/erc20.ts";
import { friendlyError } from "../lib/errors.ts";
import { discoverNotes, type DiscoveredNote } from "../lib/poolDiscovery.ts";
import { computeSlot } from "../lib/slot.ts";
import { buildConsentTypedData } from "../lib/typedData.ts";
import { classNames, randomSecret, shortHex } from "../lib/utils.ts";
import type { Claim, ConfigEnv, ProveResponse } from "../types.ts";

const DEFAULT_POOL = "0xd894af9ed2bdede33675049ae5285df000c44258a2250b84a9c3bed0d7c233";
const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

// SN_SEPOLIA — used by the typed-data domain when we sign client-side. The
// contract derives the same chain id from get_tx_info() during virtual exec.
const CHAIN_ID = "0x534e5f5345504f4c4941";

// DEMO ONLY — do not commit. Pre-fills for the hackathon "solvency" account
// so the flow runs end-to-end without manual paste. Strip this block before
// pushing.
const DEMO_ACCOUNT = "0x048fc73029bbdf97facb35b8b2936a2ea5f851df7acfd56cbe7dd73564911889";
const DEMO_PRIVATE_KEY = "0x197512021a520a8477999aeef8a8287d5e4893a1a70473baf386eef05cfc9e0";
const DEMO_VIEWING_KEY = "0x0cbbd70290a20039b8d540f57d7b9a0bdae8c5f5b39eac6172aae9b58c719b";

type ProveStep =
  | { kind: "idle" }
  | { kind: "signing" }
  | { kind: "proving" }
  | { kind: "registering" }
  | { kind: "done"; slot: string; txHash: string }
  | { kind: "error"; message: string };

interface PoolProveCardProps {
  provider: RpcProvider;
  config: ConfigEnv;
  onClaim: (claim: Claim) => void;
  /** Called whenever the user edits the account field — App uses it to pivot the claim list to the typed account's bucket. */
  onAccountChange?: (account: string) => void;
}

export function PoolProveCard({ provider, config, onClaim, onAccountChange }: PoolProveCardProps) {
  // DEMO ONLY — see DEMO_* constants above; reset to "" before pushing.
  const [account, setAccountState] = useState(DEMO_ACCOUNT);
  const setAccount = (v: string) => {
    setAccountState(v);
    onAccountChange?.(v);
  };
  const [privateKey, setPrivateKey] = useState(DEMO_PRIVATE_KEY);
  const [token, setToken] = useState(STRK);
  const [amount, setAmount] = useState("1");
  const [secret, setSecret] = useState<bigint>(() => randomSecret());
  const [pool, setPool] = useState(DEFAULT_POOL);
  const [viewingKey, setViewingKey] = useState(DEMO_VIEWING_KEY);
  const [tokenIndex, setTokenIndex] = useState("0");

  // Push the prefilled demo account up to App on mount so the claim list
  // pivots to the right bucket without the user editing the field.
  useEffect(() => {
    if (account) onAccountChange?.(account);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Self-channel key is `Poseidon(CHANNEL_KEY_TAG, addr, vk, addr, vk·G.x)`,
  // so we can derive it from the inputs the user already provides instead of
  // asking them to paste it. Self-channel only — a channel from someone else
  // to this user would need the *sender's* viewing key.
  const channelKey = useMemo(() => {
    if (!isLikelyAddress(account) || !isLikelyFelt(viewingKey)) return "";
    try {
      return "0x" + deriveSelfChannelKey(account, viewingKey).toString(16);
    } catch {
      return "";
    }
  }, [account, viewingKey]);

  const [tokenInfo, setTokenInfo] = useState<TokenInfo | null>(null);
  const [step, setStep] = useState<ProveStep>({ kind: "idle" });

  // Note discovery state. `discovered` is the rendered table; `selectedIndices`
  // is the set of note indices the user ticked. `discoveryStatus` tracks the
  // async fetch lifecycle.
  const [discovered, setDiscovered] = useState<DiscoveredNote[] | null>(null);
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const [discoveryStatus, setDiscoveryStatus] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "error"; message: string }
    | { kind: "loaded" }
  >({ kind: "idle" });

  // Look up token info whenever the token address changes (debounced lookup,
  // best-effort: STRK metadata is well-known).
  useMemo(() => {
    setTokenInfo(null);
    if (!isLikelyAddress(token)) return;
    fetchTokenInfo(provider, token).then(setTokenInfo).catch(() => setTokenInfo(null));
  }, [token, provider]);

  const minBalance = useMemo<{ raw: bigint; error: string | null }>(() => {
    const decimals = tokenInfo?.decimals ?? 18;
    try {
      const raw = parseAmount(amount, decimals);
      if (raw === 0n) return { raw: 0n, error: "Amount must be > 0" };
      return { raw, error: null };
    } catch (e) {
      return { raw: 0n, error: (e as Error).message };
    }
  }, [amount, tokenInfo]);

  const selectedList = useMemo(() => Array.from(selectedIndices).sort((a, b) => a - b), [selectedIndices]);

  const selectedTotal = useMemo(() => {
    if (!discovered) return 0n;
    let sum = 0n;
    for (const n of discovered) {
      if (selectedIndices.has(n.index)) sum += n.amount;
    }
    return sum;
  }, [discovered, selectedIndices]);

  const parsedIndices = useMemo<{ list: number[]; error: string | null }>(() => {
    if (selectedList.length === 0) return { list: [], error: "Select at least one note" };
    return { list: selectedList, error: null };
  }, [selectedList]);

  const canDiscover =
    isLikelyAddress(account) &&
    isLikelyAddress(token) &&
    isLikelyAddress(pool) &&
    isLikelyFelt(viewingKey) &&
    channelKey !== "" &&
    discoveryStatus.kind !== "loading";

  async function handleDiscover() {
    if (!canDiscover) return;
    setDiscoveryStatus({ kind: "loading" });
    setDiscovered(null);
    setSelectedIndices(new Set());
    try {
      const notes = await discoverNotes({
        provider,
        pool,
        token,
        channelKey,
        viewingKey,
      });
      setDiscovered(notes);
      setDiscoveryStatus({ kind: "loaded" });
    } catch (e) {
      setDiscoveryStatus({ kind: "error", message: (e as Error)?.message ?? String(e) });
    }
  }

  function toggleNote(index: number) {
    setSelectedIndices((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  const formErrors = useMemo(() => {
    const errs: string[] = [];
    if (!isLikelyAddress(account)) errs.push("account address is malformed");
    if (!isLikelyFelt(privateKey)) errs.push("private key is malformed");
    if (!isLikelyAddress(token)) errs.push("token address is malformed");
    if (!isLikelyAddress(pool)) errs.push("pool address is malformed");
    if (!isLikelyFelt(viewingKey)) errs.push("viewing key is malformed");
    if (!/^\d+$/.test(tokenIndex)) errs.push("token_index must be a non-negative integer");
    if (parsedIndices.error) errs.push(parsedIndices.error);
    if (minBalance.error) errs.push(minBalance.error);
    return errs;
  }, [account, privateKey, token, pool, viewingKey, tokenIndex, parsedIndices.error, minBalance.error]);

  const canSubmit = formErrors.length === 0 && !isWorking(step);

  async function handleSubmit() {
    if (!canSubmit) return;
    try {
      setStep({ kind: "signing" });

      const u256 = uint256.bnToUint256(minBalance.raw);
      const td = buildConsentTypedData({
        chainId: CHAIN_ID,
        secret,
        minBalance: { low: BigInt(u256.low), high: BigInt(u256.high) },
        token,
      });
      // Compute the SNIP-12 message hash bound to the user-supplied account
      // address, then sign with the pasted private key directly. starknet.js's
      // Signer abstraction would also work, but it pulls in Account; this is
      // the minimal path.
      const msgHash = snTypedData.getMessageHash(td, account);
      const sig = ec.starkCurve.sign(msgHash, privateKey);
      const signatureFelts = [sig.r.toString(), sig.s.toString()];

      setStep({ kind: "proving" });
      const result: ProveResponse = await postPoolProve({
        account,
        secret: "0x" + secret.toString(16),
        signature: signatureFelts,
        min_balance: minBalance.raw.toString(),
        token,
        fact_registry: config.factRegistry,
        pool,
        channel_key: channelKey,
        viewing_key: viewingKey,
        token_index: Number(tokenIndex),
        note_indices: parsedIndices.list,
      });

      setStep({ kind: "registering" });

      const expectedSlot = computeSlot({
        secret,
        baseBlockNumber: result.base_block_number,
        minBalance: minBalance.raw,
        token,
      });
      if (BigInt(result.slot) !== BigInt(expectedSlot)) {
        console.warn("Slot mismatch", { backend: result.slot, expected: expectedSlot });
      }

      const claim: Claim = {
        slot: result.slot,
        secret: "0x" + secret.toString(16),
        token,
        tokenSymbol: tokenInfo?.symbol ?? "TOKEN",
        tokenDecimals: tokenInfo?.decimals ?? 18,
        minBalance: minBalance.raw.toString(),
        minBalanceDisplay: formatAmount(minBalance.raw, tokenInfo?.decimals ?? 18),
        baseBlockNumber: result.base_block_number,
        txHash: result.tx_hash,
        chainId: CHAIN_ID,
        factRegistry: config.factRegistry,
        account,
        status: "pending",
        createdAt: Date.now(),
      };
      onClaim(claim);

      setStep({ kind: "done", slot: result.slot, txHash: result.tx_hash });
      window.setTimeout(() => {
        setSecret(randomSecret());
        setStep({ kind: "idle" });
      }, 2500);
    } catch (e) {
      const message = (e as Error)?.message ?? String(e);
      setStep({ kind: "error", message });
    }
  }

  return (
    <div className="card-glow p-6 sm:p-7">
      <div className="mb-5 flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold tracking-tight text-ink-100">
          Prove pool solvency
        </h2>
        <span className="text-[11px] uppercase tracking-[0.18em] text-ink-400">
          private notes · no wallet
        </span>
      </div>

      <p className="mb-5 text-xs text-ink-300">
        Verifies that you own a set of unspent privacy-pool notes whose total
        amount is ≥ the threshold, without a browser wallet. The private key
        is used in-page to sign the SNIP-12 consent and never sent to the
        backend.
      </p>

      <div className="space-y-4">
        <Field label="Account address" hint="The account whose solvency is being proven">
          <input className="input-mono" value={account} onChange={(e) => setAccount(e.target.value.trim())} placeholder="0x…" spellCheck={false} />
        </Field>

        <Field label="Private key" hint="Used in-browser to sign the SNIP-12 consent. Never sent to the backend.">
          <input className="input-mono" value={privateKey} onChange={(e) => setPrivateKey(e.target.value.trim())} placeholder="0x…" spellCheck={false} type="password" />
        </Field>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Token" hint="ERC-20 the notes are denominated in">
            <input className="input-mono" value={token} onChange={(e) => setToken(e.target.value.trim())} spellCheck={false} />
          </Field>
          <Field label={`Minimum amount${tokenInfo ? ` (${tokenInfo.symbol})` : ""}`} hint="Sum of unspent notes must be ≥ this">
            <input className="input" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
          </Field>
        </div>

        <Field label="Pool" hint="Privacy pool address (matches what the FactRegistry pinned at deploy)">
          <input className="input-mono" value={pool} onChange={(e) => setPool(e.target.value.trim())} spellCheck={false} />
        </Field>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Viewing key" hint="Used to find your notes and produce nullifiers. Channel key is derived from this.">
            <input className="input-mono" value={viewingKey} onChange={(e) => setViewingKey(e.target.value.trim())} placeholder="0x…" spellCheck={false} type="password" />
          </Field>
          <Field label="Token index" hint="Subchannel index for this token (usually 0)">
            <input className="input" value={tokenIndex} onChange={(e) => setTokenIndex(e.target.value.trim())} inputMode="numeric" />
          </Field>
        </div>

        <div>
          <div className="mb-1.5 flex items-baseline justify-between gap-3">
            <span className="label">Notes</span>
            <button
              type="button"
              className="btn-secondary text-[11px]"
              onClick={handleDiscover}
              disabled={!canDiscover}
            >
              {discoveryStatus.kind === "loading" ? "Scanning…" : discovered ? "Rescan" : "Discover notes"}
            </button>
          </div>
          <NoteTable
            status={discoveryStatus}
            notes={discovered}
            selected={selectedIndices}
            tokenInfo={tokenInfo}
            onToggle={toggleNote}
            selectedTotal={selectedTotal}
            target={minBalance.raw}
          />
        </div>

        <Field label="Secret" hint="Auto-generated, derives the public slot">
          <div className="flex items-center gap-2">
            <input className="input-mono" value={"0x" + secret.toString(16)} readOnly />
            <button type="button" className="btn-secondary" onClick={() => setSecret(randomSecret())}>⟳ New</button>
          </div>
        </Field>
      </div>

      {formErrors.length > 0 && step.kind === "idle" && (
        <ul className="mt-4 space-y-1 rounded-xl border border-ink-700 bg-ink-800/40 px-4 py-3 text-xs text-ink-400">
          {formErrors.map((e) => <li key={e}>· {e}</li>)}
        </ul>
      )}

      <button className="btn-primary mt-5 w-full" disabled={!canSubmit} onClick={handleSubmit}>
        {submitLabel(step)}
      </button>

      <ProgressTimeline step={step} />
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="label">{label}</span>
        {hint && <span className="text-[11px] text-ink-400">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function ProgressTimeline({ step }: { step: ProveStep }) {
  const steps: { key: ProveStep["kind"]; label: string }[] = [
    { key: "signing", label: "Sign consent in-browser" },
    { key: "proving", label: "Generate ZK proof" },
    { key: "registering", label: "Register on Starknet" },
    { key: "done", label: "Registered" },
  ];
  if (step.kind === "idle") return null;
  return (
    <div className="mt-5 rounded-xl border border-ink-700 bg-ink-800/40 p-4">
      {step.kind === "error" ? (
        <ErrorView raw={step.message} />
      ) : (
        <ol className="space-y-2">
          {steps.map((s, i) => {
            const state = stepStateFor(step.kind, s.key);
            return (
              <li key={s.key} className={classNames("flex items-center gap-3 text-xs", state === "pending" && "text-ink-400", state === "active" && "text-ink-100", state === "done" && "text-ink-200")}>
                <span className={classNames("flex h-5 w-5 items-center justify-center rounded-full border text-[10px]", state === "pending" && "border-ink-600 bg-ink-900", state === "active" && "border-accent-500/80 bg-accent-500/20 text-accent-400 animate-pulse", state === "done" && "border-success-500/60 bg-success-500/20 text-success-400")}>
                  {state === "done" ? "✓" : i + 1}
                </span>
                <span className="flex-1">{s.label}</span>
                {state === "active" && <span className="text-[11px] uppercase tracking-wider text-ink-400">working</span>}
              </li>
            );
          })}
        </ol>
      )}
      {step.kind === "done" && (
        <div className="mt-3 flex items-center justify-between text-xs">
          <div className="text-ink-300">slot <span className="mono text-ink-200">{shortHex(step.slot, 8, 6)}</span></div>
          <div className="text-ink-300">tx <span className="mono text-ink-200">{shortHex(step.txHash, 8, 6)}</span></div>
        </div>
      )}
    </div>
  );
}

function stepStateFor(currentKind: ProveStep["kind"], target: ProveStep["kind"]): "pending" | "active" | "done" {
  const order: ProveStep["kind"][] = ["signing", "proving", "registering", "done"];
  const currentIndex = order.indexOf(currentKind);
  const targetIndex = order.indexOf(target);
  if (currentIndex < 0 || targetIndex < 0) return "pending";
  if (currentIndex > targetIndex) return "done";
  if (currentIndex === targetIndex) return currentKind === "done" ? "done" : "active";
  return "pending";
}

function isWorking(step: ProveStep): boolean {
  return step.kind === "signing" || step.kind === "proving" || step.kind === "registering";
}

function submitLabel(step: ProveStep): string {
  switch (step.kind) {
    case "signing": return "Signing…";
    case "proving": return "Proving…";
    case "registering": return "Registering…";
    case "done": return "Fact registered ✓";
    case "error": return "Try again";
    default: return "Prove and register";
  }
}

function isLikelyAddress(s: string): boolean { return /^0x[0-9a-fA-F]{50,66}$/.test(s.trim()); }
function isLikelyFelt(s: string): boolean { return /^0x[0-9a-fA-F]{1,64}$/.test(s.trim()); }

function ErrorView({ raw }: { raw: string }) {
  const fe = friendlyError(raw);
  return (
    <div className="text-sm">
      <div className="font-medium text-danger-400">{fe.title}</div>
      {fe.detail && (
        <div className="mt-1 break-words text-xs text-ink-300">{fe.detail}</div>
      )}
      <details className="mt-2 text-[11px] text-ink-400">
        <summary className="cursor-pointer hover:text-ink-300">Raw error</summary>
        <div className="mt-1 break-all font-mono">{raw}</div>
      </details>
    </div>
  );
}

function NoteTable({
  status,
  notes,
  selected,
  tokenInfo,
  onToggle,
  selectedTotal,
  target,
}: {
  status: { kind: "idle" | "loading" | "error" | "loaded"; message?: string };
  notes: DiscoveredNote[] | null;
  selected: Set<number>;
  tokenInfo: TokenInfo | null;
  onToggle: (index: number) => void;
  selectedTotal: bigint;
  target: bigint;
}) {
  const decimals = tokenInfo?.decimals ?? 18;
  const symbol = tokenInfo?.symbol ?? "TOKEN";

  if (status.kind === "idle") {
    return (
      <div className="rounded-xl border border-dashed border-ink-700 px-4 py-3 text-xs text-ink-400">
        Enter pool / token / channel key / viewing key, then hit <strong>Discover notes</strong>.
      </div>
    );
  }
  if (status.kind === "loading") {
    return (
      <div className="rounded-xl border border-ink-700 bg-ink-800/40 px-4 py-3 text-xs text-ink-300">
        Scanning pool storage… (one round-trip per index)
      </div>
    );
  }
  if (status.kind === "error") {
    return (
      <div className="rounded-xl border border-danger-500/30 bg-danger-500/10 px-4 py-3 text-xs text-danger-400">
        Discovery error: {status.message}
      </div>
    );
  }
  if (!notes || notes.length === 0) {
    return (
      <div className="rounded-xl border border-ink-700 bg-ink-800/40 px-4 py-3 text-xs text-ink-300">
        No notes found for this (channel key, token). Double-check the keys, or
        deposit some tokens first.
      </div>
    );
  }

  const meetsTarget = target > 0n && selectedTotal >= target;

  return (
    <div className="overflow-hidden rounded-xl border border-ink-700">
      <table className="w-full text-xs">
        <thead className="bg-ink-800/60 text-ink-400">
          <tr>
            <th className="w-10 px-3 py-2 text-left font-medium"></th>
            <th className="w-12 px-3 py-2 text-left font-medium">idx</th>
            <th className="px-3 py-2 text-left font-medium">note id</th>
            <th className="px-3 py-2 text-right font-medium">amount</th>
            <th className="w-16 px-3 py-2 text-center font-medium">spent</th>
          </tr>
        </thead>
        <tbody>
          {notes.map((n) => {
            const isSelected = selected.has(n.index);
            return (
              <tr
                key={n.index}
                className={classNames(
                  "border-t border-ink-800",
                  n.spent && "opacity-50",
                  isSelected && "bg-accent-500/5",
                )}
              >
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    disabled={n.spent}
                    checked={isSelected}
                    onChange={() => onToggle(n.index)}
                    className="h-4 w-4 cursor-pointer accent-accent-500 disabled:cursor-not-allowed"
                  />
                </td>
                <td className="px-3 py-2 text-ink-300">{n.index}</td>
                <td className="px-3 py-2 mono text-ink-200">
                  {shortHex(n.noteId, 6, 4)}
                </td>
                <td className="px-3 py-2 text-right mono text-ink-200">
                  {formatAmount(n.amount, decimals)} <span className="text-ink-400">{symbol}</span>
                </td>
                <td className="px-3 py-2 text-center">
                  {n.spent ? <span className="text-danger-400">yes</span> : <span className="text-ink-400">—</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot className="bg-ink-800/40">
          <tr className="border-t border-ink-700 text-ink-300">
            <td className="px-3 py-2" colSpan={3}>
              {selected.size} selected
            </td>
            <td className="px-3 py-2 text-right mono">
              <span className={meetsTarget ? "text-success-400" : "text-ink-200"}>
                {formatAmount(selectedTotal, decimals)} {symbol}
              </span>
              {target > 0n && (
                <span className="text-ink-400">
                  {" "}/ {formatAmount(target, decimals)}
                </span>
              )}
            </td>
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
