/**
 * Wallet integration. Uses get-starknet-core to enumerate injected wallets
 * (Argent X, Braavos, Argent Mobile, etc.), then wraps the chosen wallet in
 * starknet.js's `WalletAccount` so we can `signMessage(typedData)` and read
 * the wallet's address + chain id without ever holding a private key.
 *
 * Communication with the wallet is per the Starknet wallet RPC spec
 * (starknet-specs/wallet-api/wallet_rpc.json) — get-starknet-core handles the
 * picker + injection, WalletAccount handles the protocol calls.
 */
import sn, { type StarknetWindowObject } from "get-starknet-core";
import {
  RpcProvider,
  WalletAccount,
  type TypedData,
  type WeierstrassSignatureType,
} from "starknet";

export interface ConnectedWallet {
  wallet: StarknetWindowObject;
  account: WalletAccount;
  address: string;
  chainId: string;
}

export async function getAvailableWallets(): Promise<StarknetWindowObject[]> {
  // Only return wallets that are actually injected into the page. The picker
  // shows an install hint when this list is empty — the discovery list is a
  // different type (WalletProvider) and can't be connected directly.
  return sn.getAvailableWallets();
}

export async function getLastConnectedWallet(): Promise<StarknetWindowObject | null> {
  const wallet = await sn.getLastConnectedWallet();
  return wallet ?? null;
}

/**
 * Open the chosen wallet's connect flow and produce a ConnectedWallet handle.
 *
 * The RpcProvider is used by WalletAccount internally for any read calls that
 * need a node URL (e.g., nonce lookups). It is NOT used for signing — that
 * always goes through the injected wallet via wallet_signTypedData.
 */
export async function connectWallet(
  wallet: StarknetWindowObject,
  rpcUrl: string,
): Promise<ConnectedWallet> {
  await sn.enable(wallet);

  const provider = new RpcProvider({ nodeUrl: rpcUrl });
  // `WalletAccount.connect` is the preferred entry point in starknet.js v6
  // (constructor is deprecated). It pulls the connected address out of the
  // wallet via `wallet_requestAccounts` and configures the RPC envelope.
  const account = await WalletAccount.connect(provider, wallet);

  const address = normalizeHex(account.address);
  // The wallet's chain id (as a felt hex) is what we'll pass into the SNIP-12
  // typed-data builder — starknet.js encodes either the felt hex or the
  // human-readable shortstring identically for the shortstring field, but the
  // wallet itself signs whatever string we hand back so we keep it consistent.
  const chainId = await account.getChainId();

  return { wallet, account, address, chainId };
}

export async function disconnectWallet(): Promise<void> {
  await sn.disconnect({ clearLastWallet: true });
}

/** Returns (r, s) as decimal strings — the format starknet.js expects on the wire. */
export async function signTypedDataAsRS(
  account: WalletAccount,
  typedData: TypedData,
): Promise<[string, string]> {
  const raw = await account.signMessage(typedData);
  return formatSignatureRS(raw);
}

function formatSignatureRS(raw: unknown): [string, string] {
  // starknet.js wallets return either WeierstrassSignatureType { r, s } or a
  // tuple of decimal-or-hex strings, depending on version. Normalize both.
  if (Array.isArray(raw)) {
    if (raw.length < 2) throw new Error("Wallet returned a malformed signature");
    return [BigInt(raw[0] as string).toString(), BigInt(raw[1] as string).toString()];
  }
  const sig = raw as WeierstrassSignatureType;
  if (typeof sig.r === "bigint" && typeof sig.s === "bigint") {
    return [sig.r.toString(), sig.s.toString()];
  }
  throw new Error("Wallet returned a signature in an unrecognized shape");
}

function normalizeHex(addr: string): string {
  if (!addr) return addr;
  const hex = BigInt(addr).toString(16);
  return "0x" + hex.padStart(64, "0");
}
