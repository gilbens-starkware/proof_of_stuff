export function shortHex(value: string, head = 6, tail = 4): string {
  if (!value) return "";
  const v = value.toLowerCase();
  if (v.length <= head + tail + 2) return v;
  return `${v.slice(0, head + 2)}…${v.slice(-tail)}`;
}

export function randomSecret(): bigint {
  // 248-bit random felt — safely below the Stark prime (~252 bits) and
  // big enough that brute-forcing the secret from `poseidon(secret)` is
  // computationally infeasible.
  const bytes = new Uint8Array(31);
  crypto.getRandomValues(bytes);
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  if (v === 0n) v = 1n;
  return v;
}

export function classNames(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for older browsers / non-secure contexts.
    const el = document.createElement("textarea");
    el.value = text;
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    document.execCommand("copy");
    document.body.removeChild(el);
  }
}
