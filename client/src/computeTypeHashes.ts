/**
 * One-shot helper: prints the SNIP-12 revision-1 type hashes and a sample
 * message hash for the typed-data schema the FactRegistry expects.
 *
 * Run: npx tsx src/computeTypeHashes.ts
 *
 * The constants printed here are pasted into the Cairo contract so that the
 * Cairo `signed_hash` matches what Argent/Braavos sign via `wallet_signTypedData`.
 */
import { hash, typedData } from "starknet";

const TYPES = {
  StarknetDomain: [
    { name: "name", type: "shortstring" },
    { name: "version", type: "shortstring" },
    { name: "chainId", type: "shortstring" },
    { name: "revision", type: "shortstring" },
  ],
  Consent: [
    { name: "secret", type: "felt" },
    { name: "min_balance", type: "u256" },
    { name: "token", type: "ContractAddress" },
  ],
} as const;

const REVISION = "1" as const;

const domainTypeHash = typedData.getTypeHash(TYPES as any, "StarknetDomain", REVISION);
const consentTypeHash = typedData.getTypeHash(TYPES as any, "Consent", REVISION);
// u256 is a preset/built-in type in rev 1. starknet.js will accept it as a
// type name and look it up from its presets. We compute the hash by passing
// it through getTypeHash directly; the function looks up presetTypes when the
// user types do not include the requested name.
const u256TypeHash = typedData.getTypeHash(
  { ...(TYPES as any), u256: [{ name: "low", type: "u128" }, { name: "high", type: "u128" }] } as any,
  "u256",
  REVISION,
);

console.log("// === SNIP-12 rev-1 type hashes for Consent schema ===");
console.log(`StarknetDomain type hash: ${domainTypeHash}`);
console.log(`Consent type hash:        ${consentTypeHash}`);
console.log(`u256 type hash:           ${u256TypeHash}`);

// Encode 'StarkNet Message' the way starknet.js does and the way Cairo's
// shortstring literal would, so we can double-check the constant we paste.
const SN_MESSAGE_FELT = "0x" + Buffer.from("StarkNet Message", "ascii").toString("hex");
console.log(`StarkNet Message felt:    ${SN_MESSAGE_FELT}`);

// Shortstring felts for the domain fields.
const toShortstringFelt = (s: string): string =>
  "0x" + Buffer.from(s, "ascii").toString("hex");
console.log(`name felt:                ${toShortstringFelt("ProofOfSolvency")}`);
console.log(`version felt:             ${toShortstringFelt("1")}`);
console.log(`revision felt:            ${toShortstringFelt("1")}`);
console.log(`chainId (SN_SEPOLIA):     ${toShortstringFelt("SN_SEPOLIA")}`);

// Sanity: round-trip a known message and print the message hash so we can
// regression-test the Cairo implementation against this exact value.
const SAMPLE = {
  domain: {
    name: "ProofOfSolvency",
    version: "1",
    chainId: "SN_SEPOLIA",
    revision: REVISION,
  },
  primaryType: "Consent",
  types: TYPES,
  message: {
    secret: "0x1337beef",
    min_balance: { low: "0x64", high: "0x0" },          // 100
    token: "0x049d17a6307cd2c0e174ebbb812aaae0e5d5f5dcb50f7f5cd61b7c98a8d6f0a1",
  },
} as const;
const SAMPLE_ACCOUNT =
  "0x07b1b2e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7f8f9fafbfcfd";

const messageHash = typedData.getMessageHash(SAMPLE as any, SAMPLE_ACCOUNT);
console.log("\n// Sample input:");
console.log(`account      = ${SAMPLE_ACCOUNT}`);
console.log(`secret       = ${SAMPLE.message.secret}`);
console.log(`min_balance  = low=${SAMPLE.message.min_balance.low} high=${SAMPLE.message.min_balance.high}`);
console.log(`token        = ${SAMPLE.message.token}`);
console.log(`chainId      = ${SAMPLE.domain.chainId} (shortstring)`);
console.log(`\nfinal message hash (starknet.js) = ${messageHash}`);

// Recompute the same hash from raw constants — exactly the way the Cairo
// contract will do it. If this matches, the Cairo logic is correct.
const SN_MESSAGE = 0x537461726b4e6574204d657373616765n;
const DOMAIN_TYPE = 0x1ff2f602e42168014d405a94f75e8a93d640751d71d16311266e140d8b0a210n;
const CONSENT_TYPE = 0x101811b9e19f67cce7ea03842506512df607f343c9277b692470897e58093b4n;
const U256_TYPE = BigInt(u256TypeHash);
const NAME = 0x50726f6f664f66536f6c76656e6379n;       // shortstring "ProofOfSolvency"
// Quirk: starknet.js getHex() parses pure-digit strings as decimals, not as
// shortstrings. So version "1" → 0x1, revision "1" → 0x1. The Cairo contract
// must use the same felts that the wallet actually signs.
const VERSION = 0x1n;
const REVISION_F = 0x1n;
const CHAIN_ID = 0x534e5f5345504f4c4941n;               // "SN_SEPOLIA"

const account = BigInt(SAMPLE_ACCOUNT);
const secret = BigInt(SAMPLE.message.secret);
const mbLow = BigInt(SAMPLE.message.min_balance.low);
const mbHigh = BigInt(SAMPLE.message.min_balance.high);
const token = BigInt(SAMPLE.message.token);

const dh = hash.computePoseidonHashOnElements([DOMAIN_TYPE, NAME, VERSION, CHAIN_ID, REVISION_F]);
const u256h = hash.computePoseidonHashOnElements([U256_TYPE, mbLow, mbHigh]);
const ch = hash.computePoseidonHashOnElements([CONSENT_TYPE, secret, BigInt(u256h), token]);
const sh = hash.computePoseidonHashOnElements([SN_MESSAGE, BigInt(dh), account, BigInt(ch)]);
console.log(`final message hash (manual)      = ${sh}`);
console.log(`match: ${BigInt(messageHash) === BigInt(sh)}`);

// Spot-check the intermediate hashes via starknet.js itself.
const sjDomainHash = typedData.getStructHash(SAMPLE.types as any, "StarknetDomain", SAMPLE.domain as any, REVISION);
const sjConsentHash = typedData.getStructHash(SAMPLE.types as any, "Consent", SAMPLE.message as any, REVISION);
console.log(`\nstarknet.js domain struct hash   = ${sjDomainHash}`);
console.log(`manual domain struct hash         = ${dh}`);
console.log(`starknet.js consent struct hash   = ${sjConsentHash}`);
console.log(`manual consent struct hash        = ${ch}`);
