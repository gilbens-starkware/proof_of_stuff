/**
 * Read-only ERC-20 helpers. We never write to the token contract; this is
 * strictly the pre-flight balance check + decimals/symbol lookup so the user
 * sees a meaningful amount before signing.
 */
import { CallData, type ProviderInterface, uint256 } from "starknet";

export interface TokenInfo {
  address: string;
  decimals: number;
  symbol: string;
}

export async function fetchTokenInfo(
  provider: ProviderInterface,
  address: string,
): Promise<TokenInfo> {
  const [decimalsRes, symbolRes] = await Promise.all([
    provider
      .callContract({ contractAddress: address, entrypoint: "decimals", calldata: [] }, "latest")
      .catch(() => null),
    provider
      .callContract({ contractAddress: address, entrypoint: "symbol", calldata: [] }, "latest")
      .catch(() => null),
  ]);

  const decimals = decimalsRes ? Number(BigInt(decimalsRes[0])) : 18;
  const symbol = symbolRes ? decodeShortstring(symbolRes[0]) : "TOKEN";

  return { address, decimals, symbol };
}

export async function balanceOf(
  provider: ProviderInterface,
  token: string,
  account: string,
): Promise<bigint> {
  const result = await provider.callContract(
    {
      contractAddress: token,
      entrypoint: "balanceOf",
      calldata: CallData.compile({ account }),
    },
    "latest",
  );
  // Two felts: low, high.
  return uint256.uint256ToBN({ low: result[0], high: result[1] });
}

export function parseAmount(input: string, decimals: number): bigint {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Enter an amount");
  if (!/^[0-9]+(\.[0-9]+)?$/.test(trimmed)) throw new Error("Invalid amount");
  const [whole, fractionRaw = ""] = trimmed.split(".");
  const fraction = (fractionRaw + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction || "0");
}

export function formatAmount(raw: bigint, decimals: number, maxFractionDigits = 4): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fraction = abs % base;
  if (fraction === 0n) return (negative ? "-" : "") + whole.toString();
  let fracStr = fraction.toString().padStart(decimals, "0");
  fracStr = fracStr.slice(0, maxFractionDigits).replace(/0+$/, "");
  return (negative ? "-" : "") + whole.toString() + (fracStr ? "." + fracStr : "");
}

function decodeShortstring(felt: string): string {
  // ERC-20 `symbol` on Starknet is conventionally a felt holding ASCII bytes.
  // Newer contracts return a ByteArray; in that case the call returns >1 felt
  // and the first is the data length. We handle the simple felt case here and
  // fall back to a string representation otherwise.
  try {
    const big = BigInt(felt);
    if (big === 0n) return "TOKEN";
    let hex = big.toString(16);
    if (hex.length % 2 === 1) hex = "0" + hex;
    const buf: number[] = [];
    for (let i = 0; i < hex.length; i += 2) buf.push(parseInt(hex.slice(i, i + 2), 16));
    const s = String.fromCharCode(...buf);
    return s.replace(/\0/g, "").trim() || "TOKEN";
  } catch {
    return "TOKEN";
  }
}
