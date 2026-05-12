import { useEffect, useMemo, useState } from "react";
import { RpcProvider, uint256 } from "starknet";
import { postProve } from "../lib/api.ts";
import { balanceOf, fetchTokenInfo, formatAmount, parseAmount } from "../lib/erc20.ts";
import { computeSlot } from "../lib/slot.ts";
import { buildConsentTypedData } from "../lib/typedData.ts";
import { classNames, randomSecret, shortHex } from "../lib/utils.ts";
import type { ConnectedWallet } from "../lib/wallet.ts";
import { signTypedData } from "../lib/wallet.ts";
import type { Claim, ConfigEnv, ProveResponse } from "../types.ts";
import type { TokenInfo } from "../lib/erc20.ts";

type ProveStep =
  | { kind: "idle" }
  | { kind: "checking-balance" }
  | { kind: "balance-ok"; balance: bigint }
  | { kind: "insufficient"; balance: bigint }
  | { kind: "signing" }
  | { kind: "proving" }
  | { kind: "registering" }
  | { kind: "done"; slot: string; txHash: string }
  | { kind: "error"; message: string };

interface ProveCardProps {
  connected: ConnectedWallet;
  provider: RpcProvider;
  config: ConfigEnv;
  onClaim: (claim: Claim) => void;
}

// Common Sepolia tokens. Pre-filled as quick-pick chips above the address
// input; users can still paste any ERC-20 manually.
const TOKEN_PRESETS: { symbol: string; address: string }[] = [
  { symbol: "STRK", address: "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d" },
  { symbol: "ETH", address: "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7" },
];
const STARK_TOKEN_SEPOLIA = TOKEN_PRESETS[0].address;

export function ProveCard({ connected, provider, config, onClaim }: ProveCardProps) {
  const [tokenAddress, setTokenAddress] = useState<string>(STARK_TOKEN_SEPOLIA);
  const [amount, setAmount] = useState<string>("1");
  const [tokenInfo, setTokenInfo] = useState<TokenInfo | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [secret, setSecret] = useState<bigint>(() => randomSecret());
  const [step, setStep] = useState<ProveStep>({ kind: "idle" });

  // Look up token info whenever the token address changes (debounced).
  useEffect(() => {
    setTokenInfo(null);
    setTokenError(null);
    if (!isLikelyAddress(tokenAddress)) return;
    const handle = window.setTimeout(() => {
      fetchTokenInfo(provider, tokenAddress)
        .then(setTokenInfo)
        .catch((e) => setTokenError(e?.message ?? "Could not read token contract"));
    }, 300);
    return () => window.clearTimeout(handle);
  }, [tokenAddress, provider]);

  // Parse the entered amount the way the contract will see it (raw u256).
  const minBalance = useMemo<{ raw: bigint; error: string | null }>(() => {
    if (!tokenInfo) return { raw: 0n, error: null };
    try {
      const raw = parseAmount(amount, tokenInfo.decimals);
      if (raw === 0n) return { raw: 0n, error: "Amount must be greater than zero" };
      return { raw, error: null };
    } catch (e) {
      return { raw: 0n, error: (e as Error).message };
    }
  }, [amount, tokenInfo]);

  // Run the vanilla balance check before the user even hits submit so the
  // button reflects feasibility. This prevents the wallet popup from firing
  // for impossible claims.
  useEffect(() => {
    if (!tokenInfo || minBalance.error || minBalance.raw === 0n) {
      // Reset any prior balance step when inputs change.
      setStep((s) =>
        s.kind === "checking-balance" || s.kind === "balance-ok" || s.kind === "insufficient"
          ? { kind: "idle" }
          : s,
      );
      return;
    }
    let cancelled = false;
    setStep({ kind: "checking-balance" });
    balanceOf(provider, tokenInfo.address, connected.address)
      .then((balance) => {
        if (cancelled) return;
        if (balance < minBalance.raw) {
          setStep({ kind: "insufficient", balance });
        } else {
          setStep({ kind: "balance-ok", balance });
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setStep({ kind: "error", message: e?.message ?? "balanceOf call failed" });
      });
    return () => {
      cancelled = true;
    };
  }, [tokenInfo, minBalance.raw, minBalance.error, connected.address, provider]);

  const canSubmit =
    tokenInfo != null &&
    !minBalance.error &&
    minBalance.raw > 0n &&
    step.kind === "balance-ok";

  async function handleSubmit() {
    if (!tokenInfo || minBalance.raw === 0n) return;
    try {
      // 1. Wallet popup: sign the SNIP-12 typed data.
      setStep({ kind: "signing" });
      const u256 = uint256.bnToUint256(minBalance.raw);
      const typedData = buildConsentTypedData({
        chainId: connected.chainId,
        secret,
        minBalance: { low: BigInt(u256.low), high: BigInt(u256.high) },
        token: tokenInfo.address,
      });
      const signature = await signTypedData(connected.account, typedData);

      // 2. Backend computes the proof and submits register_fact with extras.
      setStep({ kind: "proving" });
      const body = {
        account: connected.address,
        secret: "0x" + secret.toString(16),
        signature,
        min_balance: minBalance.raw.toString(),
        token: tokenInfo.address,
        fact_registry: config.factRegistry,
      };
      const result: ProveResponse = await postProve(body);

      // 3. We don't have to do anything else — the relay already submitted
      //    register_fact. Persist the claim as pending and let the event
      //    listener flip it to "registered" once we see the on-chain event.
      setStep({ kind: "registering" });
      const expectedSlot = computeSlot({
        secret,
        baseBlockNumber: result.base_block_number,
        minBalance: minBalance.raw,
        token: tokenInfo.address,
      });
      // Sanity: the backend's slot should match the one we derive locally.
      if (BigInt(result.slot) !== BigInt(expectedSlot)) {
        console.warn("Slot mismatch", { backend: result.slot, expected: expectedSlot });
      }

      const claim: Claim = {
        slot: result.slot,
        secret: "0x" + secret.toString(16),
        token: tokenInfo.address,
        tokenSymbol: tokenInfo.symbol,
        tokenDecimals: tokenInfo.decimals,
        minBalance: minBalance.raw.toString(),
        minBalanceDisplay: formatAmount(minBalance.raw, tokenInfo.decimals),
        baseBlockNumber: result.base_block_number,
        txHash: result.tx_hash,
        chainId: connected.chainId,
        factRegistry: config.factRegistry,
        account: connected.address,
        status: "pending",
        createdAt: Date.now(),
      };
      onClaim(claim);

      setStep({ kind: "done", slot: result.slot, txHash: result.tx_hash });
      // After a short pause, rotate to a fresh secret so the user can prove
      // a second claim without leaking the previous one.
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
          Prove solvency
        </h2>
        <span className="text-[11px] uppercase tracking-[0.18em] text-ink-400">
          step 1 · sign · 2 · prove · 3 · register
        </span>
      </div>

      <div className="space-y-5">
        <Field
          label="Token"
          hint="ERC-20 contract address whose balance you want to attest"
        >
          <div className="mb-2 flex flex-wrap gap-2">
            {TOKEN_PRESETS.map((preset) => {
              const selected =
                isLikelyAddress(tokenAddress) &&
                BigInt(tokenAddress) === BigInt(preset.address);
              return (
                <button
                  key={preset.symbol}
                  type="button"
                  onClick={() => setTokenAddress(preset.address)}
                  className={classNames(
                    "rounded-full border px-3 py-1 text-xs font-medium transition",
                    selected
                      ? "border-accent-500 bg-accent-500/15 text-accent-300"
                      : "border-ink-700 bg-ink-800/40 text-ink-300 hover:border-ink-500 hover:text-ink-100",
                  )}
                >
                  {preset.symbol}
                </button>
              );
            })}
          </div>
          <input
            className="input-mono"
            value={tokenAddress}
            onChange={(e) => setTokenAddress(e.target.value.trim())}
            placeholder="0x…"
            spellCheck={false}
          />
          <TokenStatus info={tokenInfo} error={tokenError} address={tokenAddress} />
        </Field>

        <Field
          label="Minimum balance"
          hint={
            tokenInfo
              ? `Will attest balance ≥ this amount, in ${tokenInfo.symbol}`
              : "Will attest balance is at least this amount"
          }
        >
          <div className="relative">
            <input
              className="input pr-16"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              placeholder="1.0"
            />
            <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-ink-400">
              {tokenInfo?.symbol ?? "—"}
            </span>
          </div>
          {minBalance.error && (
            <p className="mt-1 text-xs text-danger-400">{minBalance.error}</p>
          )}
        </Field>

        <Field
          label="Secret"
          hint="Auto-generated, never leaves your browser unless you export it"
        >
          <div className="flex items-center gap-2">
            <input
              className="input-mono"
              value={"0x" + secret.toString(16)}
              readOnly
            />
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setSecret(randomSecret())}
            >
              ⟳ New
            </button>
          </div>
        </Field>
      </div>

      <BalanceBanner
        step={step}
        minBalance={minBalance.raw}
        tokenInfo={tokenInfo}
      />

      <button
        className="btn-primary mt-5 w-full"
        disabled={!canSubmit || isWorking(step)}
        onClick={handleSubmit}
      >
        {submitLabel(step)}
      </button>

      <ProgressTimeline step={step} />
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
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

function TokenStatus({
  info,
  error,
  address,
}: {
  info: TokenInfo | null;
  error: string | null;
  address: string;
}) {
  if (!isLikelyAddress(address)) return null;
  if (error) {
    return (
      <p className="mt-1 text-xs text-danger-400">{error}</p>
    );
  }
  if (!info) {
    return (
      <p className="mt-1 text-xs text-ink-400">Reading contract…</p>
    );
  }
  return (
    <p className="mt-1 text-xs text-ink-300">
      <span className="mono text-ink-200">{info.symbol}</span>{" "}
      <span className="text-ink-400">· decimals {info.decimals}</span>
    </p>
  );
}

function BalanceBanner({
  step,
  minBalance,
  tokenInfo,
}: {
  step: ProveStep;
  minBalance: bigint;
  tokenInfo: TokenInfo | null;
}) {
  if (!tokenInfo) return null;
  if (minBalance === 0n) return null;

  if (step.kind === "checking-balance") {
    return (
      <div className="mt-5 rounded-xl border border-ink-700 bg-ink-800/40 px-4 py-3 text-xs text-ink-300">
        Checking on-chain balance…
      </div>
    );
  }
  if (step.kind === "balance-ok") {
    return (
      <div className="mt-5 flex items-center justify-between rounded-xl border border-success-500/30 bg-success-500/10 px-4 py-3 text-xs">
        <span className="text-success-400">Sufficient balance</span>
        <span className="mono text-ink-200">
          {formatAmount(step.balance, tokenInfo.decimals)} {tokenInfo.symbol}
        </span>
      </div>
    );
  }
  if (step.kind === "insufficient") {
    return (
      <div className="mt-5 rounded-xl border border-danger-500/30 bg-danger-500/10 px-4 py-3 text-xs">
        <div className="flex items-center justify-between">
          <span className="text-danger-400">
            Balance is below the requested minimum
          </span>
          <span className="mono text-ink-200">
            {formatAmount(step.balance, tokenInfo.decimals)} {tokenInfo.symbol}
          </span>
        </div>
        <div className="mt-1 text-ink-400">
          Deposit more {tokenInfo.symbol}, lower the minimum, or pick a different token.
        </div>
      </div>
    );
  }
  return null;
}

function ProgressTimeline({ step }: { step: ProveStep }) {
  const steps: { key: ProveStep["kind"]; label: string }[] = [
    { key: "signing", label: "Sign in wallet" },
    { key: "proving", label: "Generate ZK proof" },
    { key: "registering", label: "Register on Starknet" },
    { key: "done", label: "Registered" },
  ];

  if (step.kind === "idle" || step.kind === "checking-balance" || step.kind === "balance-ok" || step.kind === "insufficient") {
    return null;
  }

  return (
    <div className="mt-5 rounded-xl border border-ink-700 bg-ink-800/40 p-4">
      {step.kind === "error" ? (
        <div className="text-sm">
          <div className="font-medium text-danger-400">Something went wrong</div>
          <div className="mt-1 break-words text-xs text-ink-300">{step.message}</div>
        </div>
      ) : (
        <ol className="space-y-2">
          {steps.map((s, i) => {
            const state = stepStateFor(step.kind, s.key);
            return (
              <li
                key={s.key}
                className={classNames(
                  "flex items-center gap-3 text-xs",
                  state === "pending" && "text-ink-400",
                  state === "active" && "text-ink-100",
                  state === "done" && "text-ink-200",
                )}
              >
                <span
                  className={classNames(
                    "flex h-5 w-5 items-center justify-center rounded-full border text-[10px]",
                    state === "pending" && "border-ink-600 bg-ink-900",
                    state === "active" &&
                      "border-accent-500/80 bg-accent-500/20 text-accent-400 animate-pulse",
                    state === "done" && "border-success-500/60 bg-success-500/20 text-success-400",
                  )}
                >
                  {state === "done" ? "✓" : i + 1}
                </span>
                <span className="flex-1">{s.label}</span>
                {state === "active" && (
                  <span className="text-[11px] uppercase tracking-wider text-ink-400">
                    working
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {step.kind === "done" && (
        <div className="mt-3 flex items-center justify-between text-xs">
          <div className="text-ink-300">
            slot <span className="mono text-ink-200">{shortHex(step.slot, 8, 6)}</span>
          </div>
          <div className="text-ink-300">
            tx <span className="mono text-ink-200">{shortHex(step.txHash, 8, 6)}</span>
          </div>
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
  return (
    step.kind === "signing" ||
    step.kind === "proving" ||
    step.kind === "registering" ||
    step.kind === "checking-balance"
  );
}

function submitLabel(step: ProveStep): string {
  switch (step.kind) {
    case "checking-balance":
      return "Checking balance…";
    case "insufficient":
      return "Insufficient balance";
    case "signing":
      return "Waiting for wallet…";
    case "proving":
      return "Proving…";
    case "registering":
      return "Registering…";
    case "done":
      return "Fact registered ✓";
    case "error":
      return "Try again";
    default:
      return "Prove and register";
  }
}

function isLikelyAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{50,66}$/.test(s.trim());
}
