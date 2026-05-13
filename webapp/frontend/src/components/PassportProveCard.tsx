import { useState } from "react";
import { postPassportProve } from "../lib/api.ts";
import { computeAgeClaimSlot } from "../lib/slot.ts";
import { classNames, randomSecret, shortHex } from "../lib/utils.ts";
import type { ConnectedWallet } from "../lib/wallet.ts";
import type { Claim, ConfigEnv, ProveResponse } from "../types.ts";
import { friendlyError } from "../lib/errors.ts";

// Test vectors from scripts/passport/test_vectors.json (mock SHA-256 passport, DOB 1995-01-01)
// Real ePassports use SHA-384 and will have larger econtentBytes (~370 B) and signedAttr (~163 B).
const TEST_DG1: number[] = [
  97, 91, 95, 31, 88, 80, 60, 73, 83, 82, 67, 79, 72, 69, 78, 60, 60, 65, 77, 79, 83, 60, 60, 60,
  60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60,
  60, 65, 66, 49, 50, 51, 52, 53, 54, 55, 49, 73, 83, 82, 57, 53, 48, 49, 48, 49, 54, 77, 51, 53,
  48, 49, 48, 49, 52, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 48, 50,
];
const TEST_ECONTENT: number[] = [
  48, 57, 2, 1, 0, 48, 11, 6, 9, 96, 134, 72, 1, 101, 3, 4, 2, 1, 48, 39, 48, 37, 2, 1, 1, 4, 32,
  231, 239, 203, 91, 13, 179, 78, 132, 19, 108, 254, 172, 59, 190, 20, 215, 120, 65, 153, 241, 207,
  47, 28, 204, 12, 161, 146, 24, 56, 150, 195, 147,
];
const TEST_SIGNED_ATTR: number[] = [
  49, 102, 48, 21, 6, 9, 42, 134, 72, 134, 247, 13, 1, 9, 3, 49, 8, 6, 6, 103, 129, 8, 1, 1, 1,
  48, 28, 6, 9, 42, 134, 72, 134, 247, 13, 1, 9, 5, 49, 15, 23, 13, 49, 57, 49, 50, 49, 54, 49,
  55, 50, 50, 51, 56, 90, 48, 47, 6, 9, 42, 134, 72, 134, 247, 13, 1, 9, 4, 49, 34, 4, 32, 120,
  82, 54, 94, 125, 117, 231, 116, 39, 136, 191, 216, 127, 152, 163, 24, 121, 180, 216, 119, 229,
  78, 154, 228, 175, 109, 158, 105, 229, 62, 209, 240,
];

type ProveStep =
  | { kind: "idle" }
  | { kind: "proving" }
  | { kind: "registering" }
  | { kind: "done"; slot: string; txHash: string }
  | { kind: "error"; message: string };

interface PassportProveCardProps {
  connected: ConnectedWallet;
  config: ConfigEnv;
  onClaim: (claim: Claim) => void;
}

export function PassportProveCard({ connected, config, onClaim }: PassportProveCardProps) {
  const [secret] = useState<bigint>(() => randomSecret());
  const [rawJson, setRawJson] = useState<string>("");
  const [parseError, setParseError] = useState<string | null>(null);
  const [step, setStep] = useState<ProveStep>({ kind: "idle" });

  // Parsed passport data — null means empty / invalid
  const passportData = (() => {
    if (!rawJson.trim()) return null;
    try {
      const obj = JSON.parse(sanitize(rawJson));
      if (
        !Array.isArray(obj.dg1Bytes) ||
        !Array.isArray(obj.econtentBytes) ||
        !Array.isArray(obj.signedAttr)
      ) {
        return null;
      }
      return {
        dg1Bytes: obj.dg1Bytes as number[],
        econtentBytes: obj.econtentBytes as number[],
        signedAttr: obj.signedAttr as number[],
      };
    } catch {
      return null;
    }
  })();

  function loadTestData() {
    setParseError(null);
    setRawJson(
      JSON.stringify(
        { dg1Bytes: TEST_DG1, econtentBytes: TEST_ECONTENT, signedAttr: TEST_SIGNED_ATTR },
        null,
        2,
      ),
    );
  }

  function sanitize(val: string): string {
    // Strip BOM (﻿) and zero-width chars that Android clipboard sometimes prepends/injects.
    return val.replace(/^﻿/, "").replace(/[​-‍﻿]/g, "");
  }

  function handleJsonChange(val: string) {
    setRawJson(val);
    setParseError(null);
    if (!val.trim()) return;
    try {
      const obj = JSON.parse(sanitize(val));
      if (!Array.isArray(obj.dg1Bytes) || !Array.isArray(obj.econtentBytes) || !Array.isArray(obj.signedAttr)) {
        setParseError('JSON must contain "dg1Bytes", "econtentBytes", and "signedAttr" arrays.');
      }
    } catch (e) {
      setParseError(`Invalid JSON: ${(e as SyntaxError).message}`);
    }
  }

  const canSubmit = passportData !== null && parseError === null && step.kind === "idle";

  async function handleSubmit() {
    if (!passportData) return;
    try {
      setStep({ kind: "proving" });
      const body = {
        account: connected.address,
        secret: "0x" + secret.toString(16),
        dg1_bytes: passportData.dg1Bytes,
        econtent_bytes: passportData.econtentBytes,
        signed_attr: passportData.signedAttr,
        fact_registry: config.factRegistry,
      };
      const result: ProveResponse = await postPassportProve(body);

      setStep({ kind: "registering" });
      const expectedSlot = computeAgeClaimSlot({
        secret,
        baseBlockNumber: result.base_block_number,
        account: connected.address,
      });
      if (BigInt(result.slot) !== BigInt(expectedSlot)) {
        console.warn("Age-claim slot mismatch", { backend: result.slot, expected: expectedSlot });
      }

      const claim: Claim = {
        slot: result.slot,
        secret: "0x" + secret.toString(16),
        token: "age_over_18",
        tokenSymbol: "Age ≥ 18",
        tokenDecimals: 0,
        minBalance: "0",
        minBalanceDisplay: "age ≥ 18",
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
    } catch (e) {
      setStep({ kind: "error", message: (e as Error)?.message ?? String(e) });
    }
  }

  const isWorking = step.kind === "proving" || step.kind === "registering";

  return (
    <div className="card-glow p-6 sm:p-7">
      <div className="mb-5 flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold tracking-tight text-ink-100">
          Prove age ≥ 18
        </h2>
        <span className="text-[11px] uppercase tracking-[0.18em] text-ink-400">
          step 1 · prove · 2 · register
        </span>
      </div>

      <p className="mb-5 text-sm text-ink-400">
        Paste the NFC data from your passport (DG1, eContent, SignedAttributes) or
        load the mock test vectors to try the flow end-to-end.
      </p>

      <div className="mb-3 flex items-center justify-between">
        <span className="label">Passport data (JSON)</span>
        <button
          type="button"
          className="rounded-full border border-ink-600 px-3 py-0.5 text-[11px] text-ink-300 hover:border-ink-400 hover:text-ink-100 transition"
          onClick={loadTestData}
        >
          Load test data
        </button>
      </div>

      <textarea
        className={classNames(
          "w-full rounded-xl border bg-ink-900 px-3 py-2.5 font-mono text-[11px] leading-relaxed text-ink-200 placeholder:text-ink-600 focus:outline-none focus:ring-1 transition",
          parseError
            ? "border-danger-500/60 focus:ring-danger-500/40"
            : "border-ink-700 focus:ring-accent-500/40",
        )}
        rows={6}
        value={rawJson}
        onChange={(e) => handleJsonChange(e.target.value)}
        placeholder={'{ "dg1Bytes": [...], "econtentBytes": [...], "signedAttr": [...] }'}
        spellCheck={false}
      />
      {parseError && (
        <p className="mt-1 text-xs text-danger-400">{parseError}</p>
      )}
      {passportData && !parseError && (
        <p className="mt-1 text-xs text-ink-400">
          DG1 {passportData.dg1Bytes.length}B · eContent {passportData.econtentBytes.length}B ·
          SignedAttr {passportData.signedAttr.length}B
        </p>
      )}

      <div className="mt-5">
        <span className="label">Secret</span>
        <p className="mt-1 text-[11px] text-ink-400">
          Auto-generated — never leaves your browser.
        </p>
        <input
          className="input-mono mt-1.5"
          value={"0x" + secret.toString(16)}
          readOnly
        />
      </div>

      <button
        className="btn-primary mt-5 w-full"
        disabled={!canSubmit || isWorking}
        onClick={handleSubmit}
      >
        {submitLabel(step)}
      </button>

      <ProgressPanel step={step} />
    </div>
  );
}

function ProgressPanel({ step }: { step: ProveStep }) {
  if (step.kind === "idle") return null;

  const steps: { key: ProveStep["kind"]; label: string }[] = [
    { key: "proving", label: "Generate ZK proof" },
    { key: "registering", label: "Register on Starknet" },
    { key: "done", label: "Registered" },
  ];

  return (
    <div className="mt-5 rounded-xl border border-ink-700 bg-ink-800/40 p-4">
      {step.kind === "error" ? (
        (() => {
          const fe = friendlyError(step.message);
          return (
            <div className="text-sm">
              <div className="font-medium text-danger-400">{fe.title}</div>
              {fe.detail && (
                <div className="mt-1 break-words text-xs text-ink-300">{fe.detail}</div>
              )}
              <details className="mt-2 text-[11px] text-ink-400">
                <summary className="cursor-pointer hover:text-ink-300">Raw error</summary>
                <div className="mt-1 break-all font-mono">{step.message}</div>
              </details>
            </div>
          );
        })()
      ) : (
        <>
          <ol className="space-y-2">
            {steps.map((s, i) => {
              const state = stepState(step.kind, s.key);
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
                      state === "done" &&
                        "border-success-500/60 bg-success-500/20 text-success-400",
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
          {step.kind === "done" && (
            <div className="mt-3 flex items-center justify-between text-xs">
              <div className="text-ink-300">
                slot{" "}
                <span className="mono text-ink-200">{shortHex(step.slot, 8, 6)}</span>
              </div>
              <div className="text-ink-300">
                tx{" "}
                <span className="mono text-ink-200">{shortHex(step.txHash, 8, 6)}</span>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function stepState(
  current: ProveStep["kind"],
  target: ProveStep["kind"],
): "pending" | "active" | "done" {
  const order: ProveStep["kind"][] = ["proving", "registering", "done"];
  const ci = order.indexOf(current);
  const ti = order.indexOf(target);
  if (ci < 0 || ti < 0) return "pending";
  if (ci > ti) return "done";
  if (ci === ti) return current === "done" ? "done" : "active";
  return "pending";
}

function submitLabel(step: ProveStep): string {
  switch (step.kind) {
    case "proving":
      return "Proving…";
    case "registering":
      return "Registering…";
    case "done":
      return "Fact registered ✓";
    case "error":
      return "Try again";
    default:
      return "Prove age ≥ 18";
  }
}
