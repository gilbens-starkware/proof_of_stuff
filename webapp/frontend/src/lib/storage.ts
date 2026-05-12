/**
 * localStorage persistence for solvency claims. Keyed by wallet address so
 * each connected account sees its own list. The claim metadata never leaves
 * the browser unless the user explicitly exports it via the share button.
 */
import type { Claim } from "../types.ts";

const KEY_PREFIX = "pos:claims:";

function key(address: string): string {
  return KEY_PREFIX + address.toLowerCase();
}

export function loadClaims(address: string): Claim[] {
  try {
    const raw = localStorage.getItem(key(address));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as Claim[];
  } catch {
    return [];
  }
}

export function saveClaims(address: string, claims: Claim[]): void {
  localStorage.setItem(key(address), JSON.stringify(claims));
}

export function upsertClaim(address: string, claim: Claim): Claim[] {
  const list = loadClaims(address);
  const idx = list.findIndex((c) => c.slot === claim.slot);
  if (idx >= 0) list[idx] = { ...list[idx], ...claim };
  else list.unshift(claim);
  saveClaims(address, list);
  return list;
}

export function patchClaim(
  address: string,
  slot: string,
  patch: Partial<Claim>,
): Claim[] {
  const list = loadClaims(address);
  const idx = list.findIndex((c) => c.slot === slot);
  if (idx < 0) return list;
  list[idx] = { ...list[idx], ...patch };
  saveClaims(address, list);
  return list;
}

export function deleteClaim(address: string, slot: string): Claim[] {
  const list = loadClaims(address).filter((c) => c.slot !== slot);
  saveClaims(address, list);
  return list;
}
