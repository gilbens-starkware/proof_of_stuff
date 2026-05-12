/**
 * Thin client for the relay backend. The backend POSTs to the proving service
 * and submits `register_fact` from a funded account so the user wallet only
 * needs to sign the consent typed data — never attach v3 proof extras.
 */
import type { ProveResponse } from "../types.ts";

export interface ProveRequestBody {
  account: string;
  secret: string; // hex
  signature: [string, string]; // (r, s) as decimal strings
  min_balance: string; // base-10 string of the raw u256 (e.g. 1000000000000000000)
  token: string;
  fact_registry: string;
}

export async function postProve(body: ProveRequestBody): Promise<ProveResponse> {
  const res = await fetch("/api/prove", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Backend returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const message =
      (payload as { error?: string })?.error ??
      `Backend error (${res.status})`;
    throw new Error(message);
  }
  return payload as ProveResponse;
}
