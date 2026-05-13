/**
 * Thin client for the relay backend. The backend POSTs to the proving service
 * and submits `register_fact` from a funded account so the user wallet only
 * needs to sign the consent typed data — never attach v3 proof extras.
 */
import type { ProveResponse } from "../types.ts";

export interface ProveRequestBody {
  account: string;
  secret: string; // hex
  signature: string[]; // full signature felts as decimal strings (length ≥ 2)
  min_balance: string; // base-10 string of the raw u256 (e.g. 1000000000000000000)
  token: string;
  fact_registry: string;
}

export interface PoolProveRequestBody extends ProveRequestBody {
  pool: string;
  channel_key: string;
  viewing_key: string;
  token_index: number;
  note_indices: number[];
}

export interface PassportProveRequestBody {
  account: string;
  secret: string; // hex
  dg1_bytes: number[];
  econtent_bytes: number[];
  signed_attr: number[];
  current_yymmdd?: number;
  fact_registry: string;
}

export async function postProve(body: ProveRequestBody): Promise<ProveResponse> {
  return postJson<ProveResponse>("/api/prove", body);
}

export async function postPoolProve(body: PoolProveRequestBody): Promise<ProveResponse> {
  return postJson<ProveResponse>("/api/pool-prove", body);
}

export async function postPassportProve(
  body: PassportProveRequestBody,
): Promise<ProveResponse> {
  return postJson<ProveResponse>("/api/passport-prove", body);
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
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
  return payload as T;
}
