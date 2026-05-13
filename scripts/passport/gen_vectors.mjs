/**
 * Generates mock passport test vectors for the Cairo RSA-PSS identity claim POC.
 *
 * Chain verified in Cairo:
 *   dg1_bytes  -> SHA256 -> dg1_hash
 *   dg1_hash   -> embedded in econtent at DG1_HASH_OFFSET
 *   econtent   -> SHA256 -> econtent_hash
 *   econtent_hash -> embedded in signed_attr at SIGNED_ATTR_HASH_OFFSET (last 32 bytes)
 *   signed_attr -> RSA-PSS-SHA256 verify -> signature  (using DSC public key)
 *   dg1_bytes[MRZ_DOB_OFFSET .. +6] -> YYMMDD -> assert age >= 18
 */

import forge from 'node-forge';
import crypto from 'crypto';
import { writeFileSync } from 'fs';

// ── helpers ──────────────────────────────────────────────────────────────────

function sha256(bytes) {
  return Array.from(crypto.createHash('sha256').update(Buffer.from(bytes)).digest());
}

function toU8(signed) {
  return signed < 0 ? signed + 256 : signed;
}

// ── DG1 encoding (ICAO 9303 passport, 88-char MRZ) ──────────────────────────
// Format: [0x61, length+4, 0x5F, 0x1F, mrzLength, ...mrzBytes]
function buildDg1(mrz) {
  if (mrz.length !== 88) throw new Error('passport MRZ must be 88 chars');
  const mrzBytes = [...mrz].map(c => c.charCodeAt(0));
  // tag 0x61, then inner: tag 0x5F1F + length 0x58 (88) + mrzBytes
  return [0x61, 0x5B, 0x5F, 0x1F, 0x58, ...mrzBytes];
}

// MRZ for Israeli-like passport (Type P, 88 chars):
// Line1 (44): P<ISRSURNAME<<GIVENNAME<<<<<<<<<<<<<<<<<<<<<
// Line2 (44): DOCNUM0ISR9501011M3001015<<<<<<<<<<<<<<<<02
//                       ^DOB at line2[13..18] = full mrz[57..62]
// In dg1_bytes: DOB starts at byte 5 + 57 = 62 (YYMMDD)
const SURNAME = 'COHEN';
const GIVEN   = 'AMOS';
const DOC_NUM = 'AB1234567';
const BIRTH   = '950101';   // Jan 1 1995 → >18 years old
const EXPIRY  = '350101';
const NAT     = 'ISR';

function mrzCheckDigit(s) {
  const weights = [7, 3, 1];
  const vals = { '<': 0 };
  for (let i = 0; i < 10; i++) vals[String(i)] = i;
  for (let i = 0; i < 26; i++) vals[String.fromCharCode(65 + i)] = 10 + i;
  return [...s].reduce((sum, c, i) => sum + (vals[c] ?? 0) * weights[i % 3], 0) % 10;
}

const line1 = `P<${NAT}${SURNAME}<<${GIVEN}`.padEnd(44, '<');
const docNumField = DOC_NUM + mrzCheckDigit(DOC_NUM);
const birthField  = BIRTH   + mrzCheckDigit(BIRTH);
const expiryField = EXPIRY  + mrzCheckDigit(EXPIRY);
const line2 = `${docNumField}${NAT}${birthField}M${expiryField}<<<<<<<<<<<<<<02`;
if (line2.length !== 44) throw new Error(`line2 length ${line2.length}`);

const MRZ = line1 + line2;
const dg1Bytes = buildDg1(MRZ);
// DOB offset in dg1Bytes: 5 (header) + 44 (line1) + 13 (line2 prefix) = 62
const DOB_OFFSET_IN_DG1 = 62;
console.log(`MRZ line1: ${line1}`);
console.log(`MRZ line2: ${line2}`);
console.log(`DOB bytes in dg1[${DOB_OFFSET_IN_DG1}..${DOB_OFFSET_IN_DG1+5}]: ${dg1Bytes.slice(DOB_OFFSET_IN_DG1, DOB_OFFSET_IN_DG1+6).map(b=>String.fromCharCode(b)).join('')}`);

// ── eContent (LDSSecurityObject) ─────────────────────────────────────────────
// Real ASN.1 structure (minimal, one DG):
// SEQUENCE {
//   INTEGER 0                              (LDS version)
//   SEQUENCE { OID sha-256 }              (hash algorithm)
//   SEQUENCE {                            (data group hash values)
//     SEQUENCE { INTEGER 1, OCTET_STRING dg1_hash }
//   }
// }
function buildEContent(dg1Hash) {
  // sha-256 OID: 2.16.840.1.101.3.4.2.1 → bytes 60 86 48 01 65 03 04 02 01
  const shaOid = [0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01];
  // SEQUENCE { INTEGER 1, OCTET_STRING(32) dg1_hash }
  //   02 01 01  04 20 [32 bytes]
  const dgEntry = [0x30, 0x25, 0x02, 0x01, 0x01, 0x04, 0x20, ...dg1Hash];
  // SEQUENCE { OID sha256 } → 30 0B 06 09 [shaOid]
  const algoId  = [0x30, 0x0B, 0x06, 0x09, ...shaOid];
  // SEQUENCE { dgEntry }
  const dgList  = [0x30, dgEntry.length, ...dgEntry];
  // INTEGER 0
  const version = [0x02, 0x01, 0x00];
  // Outer SEQUENCE
  const inner   = [...version, ...algoId, ...dgList];
  const econtent = [0x30, inner.length, ...inner];
  return econtent;
}

const dg1Hash   = sha256(dg1Bytes);
const econtent  = buildEContent(dg1Hash);

// The DG1 hash offset inside econtent:
// outer SEQUENCE header: 2 bytes
// INTEGER 0: 3 bytes         → total 5
// algoId SEQUENCE: 2+2+11 = 13 bytes? let's just find it
const DG1_HASH_OFFSET = econtent.indexOf(dg1Hash[0], 10); // approximate; verify below
// More reliable: known fixed position in our deterministic structure
// version(3) + algoId(13) + dgList header(2) + dgEntry header(2) + 02 01 01 04 20 (5) = 28
// But outer SEQUENCE adds 2 bytes → total offset = 2+3+13+2+2+5 = 27? Let's just confirm:
function findOffset(haystack, needle) {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i+j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}
const dg1HashOffset = findOffset(econtent, dg1Hash);
console.log(`dg1Hash offset in econtent: ${dg1HashOffset}`);

// ── SignedAttributes ──────────────────────────────────────────────────────────
// Fixed structure from Self project's generateSignedAttr():
function buildSignedAttr(econtentHash) {
  const b = [];
  b.push(0x31, 0x66);                                    // SET, length 102
  // content-type OID attribute
  b.push(0x30, 0x15, 0x06, 0x09, 0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x09, 0x03);
  b.push(0x31, 0x08, 0x06, 0x06, 0x67, 0x81, 0x08, 0x01, 0x01, 0x01);
  // signing-time attribute
  b.push(0x30, 0x1C, 0x06, 0x09, 0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x09, 0x05);
  b.push(0x31, 0x0F, 0x17, 0x0D, 0x31, 0x39, 0x31, 0x32, 0x31, 0x36, 0x31, 0x37, 0x32, 0x32, 0x33, 0x38, 0x5A);
  // message-digest attribute
  b.push(0x30, 0x2F, 0x06, 0x09, 0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x09, 0x04);
  b.push(0x31, 0x22, 0x04, 0x20);
  b.push(...econtentHash);                               // 32 bytes
  return b;
}

const econtentHash   = sha256(econtent);
const signedAttr     = buildSignedAttr(econtentHash);
const SIGNED_ATTR_HASH_OFFSET = signedAttr.length - 32;
console.log(`signedAttr length: ${signedAttr.length}, econtent hash at offset: ${SIGNED_ATTR_HASH_OFFSET}`);

// ── RSA-PSS key generation and signing ───────────────────────────────────────
console.log('Generating RSA-2048 key pair (may take a moment)...');
const keypair = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 65537 });
const privKey  = keypair.privateKey;
const pubKey   = keypair.publicKey;

// RSA-PSS sign: hash = SHA256(signedAttr), saltLength = 32
const md = forge.md.sha256.create();
md.update(forge.util.binary.raw.encode(new Uint8Array(signedAttr)));
const pss = forge.pss.create({
  md: forge.md.sha256.create(),
  mgf: forge.mgf.mgf1.create(forge.md.sha256.create()),
  saltLength: 32,
});
const sigForge  = privKey.sign(md, pss);
const sigBytes  = Array.from(sigForge, c => c.charCodeAt(0));

// Extract RSA modulus n as bytes (big-endian, 256 bytes)
const nHex      = pubKey.n.toString(16).padStart(512, '0');
const nBytes    = Array.from({ length: 256 }, (_, i) => parseInt(nHex.slice(i*2, i*2+2), 16));
const eVal      = pubKey.e.toNumber ? pubKey.e.toNumber() : Number(pubKey.e);

console.log(`RSA exponent e: ${eVal}`);
console.log(`Signature length: ${sigBytes.length} bytes`);

// ── Verify with node-forge to confirm correctness ─────────────────────────────
const verifyMd = forge.md.sha256.create();
verifyMd.update(forge.util.binary.raw.encode(new Uint8Array(signedAttr)));
const verifyPss = forge.pss.create({
  md: forge.md.sha256.create(),
  mgf: forge.mgf.mgf1.create(forge.md.sha256.create()),
  saltLength: 32,
});
const valid = pubKey.verify(verifyMd.digest().bytes(), sigForge, verifyPss);
console.log(`Self-verification: ${valid ? 'PASS ✓' : 'FAIL ✗'}`);

// ── Little-endian u128 limbs (limb[0] = LSB, what Cairo arithmetic expects) ──
function bytesToBigInt(bytes) {
  return bytes.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
}

function bigIntToLimbsLE(x, numLimbs = 16) {
  const mask = (1n << 128n) - 1n;
  const limbs = [];
  for (let i = 0; i < numLimbs; i++) {
    limbs.push('0x' + (x & mask).toString(16).padStart(32, '0'));
    x >>= 128n;
  }
  return limbs;
}

const nBigInt  = bytesToBigInt(nBytes);
const sigBigInt = bytesToBigInt(sigBytes);

const nLimbs_LE = bigIntToLimbsLE(nBigInt);
const sigLimbs_LE = bigIntToLimbsLE(sigBigInt);

// ── Compute RSA quotient hints for e=65537 = 2^16 + 1 ────────────────────────
// 16 squarings + 1 final multiplication, each step: x^2 = q*n + r
// Cairo uses these quotients to verify the modular reduction without division.
console.log('Computing RSA exponentiation quotient hints...');
const quotients = [];
let x = sigBigInt;
for (let k = 0; k < 16; k++) {
  const sq = x * x;
  const q  = sq / nBigInt;
  x        = sq % nBigInt;
  quotients.push(bigIntToLimbsLE(q));
}
// Final: x * sig mod n  (x = sig^(2^16), multiply by sig to get sig^65537)
const lastSq = x * sigBigInt;
const qFinal = lastSq / nBigInt;
const emBigInt = lastSq % nBigInt;
quotients.push(bigIntToLimbsLE(qFinal));

// EM bytes (big-endian, 256 bytes) — the decoded RSA message
const emHex   = emBigInt.toString(16).padStart(512, '0');
const emBytes = Array.from({length: 256}, (_, i) => parseInt(emHex.slice(i*2, i*2+2), 16));

console.log(`EM[0]:   0x${emBytes[0].toString(16).padStart(2,'0')} (expect < 0x80)`);
console.log(`EM[255]: 0x${emBytes[255].toString(16).padStart(2,'0')} (expect 0xBC)`);

// Flatten quotients to a single array (272 limbs = 17 × 16)
const quotients_flat = quotients.flat();

// ── Output ────────────────────────────────────────────────────────────────────
const vectors = {
  nBytes:          nBytes,
  metadata: {
    mrz: MRZ,
    birthDate: BIRTH,
    dobOffsetInDg1: DOB_OFFSET_IN_DG1,
    dg1HashOffsetInEcontent: dg1HashOffset,
    econtentHashOffsetInSignedAttr: SIGNED_ATTR_HASH_OFFSET,
    rsaExponent: eVal,
    saltLength: 32,
    noteForCairo: [
      'All limb arrays are LITTLE-ENDIAN (limb[0] = LSB)',
      'dg1Bytes[62..68] = YYMMDD birth date ASCII',
      'econtent[27..59] = SHA256(dg1Bytes)',
      'signedAttr[72..104] = SHA256(econtent)',
      'RSA: sig^65537 mod n = EM; verify PSS(EM, SHA256(signedAttr))',
      'quotients_flat: 272 limbs = 17 quotients × 16 limbs each (LE)',
    ],
  },
  dg1Bytes:        dg1Bytes,
  econtentBytes:   econtent,
  signedAttr:      signedAttr,
  signatureBytes:  sigBytes,
  rsaN_limbs_LE:   nLimbs_LE,
  sig_limbs_LE:    sigLimbs_LE,
  quotients_flat:  quotients_flat,
  emBytes:         emBytes,
  rsaE:            eVal,
};

writeFileSync('test_vectors.json', JSON.stringify(vectors, null, 2));
console.log('\nWrote test_vectors.json');
console.log(`dg1Bytes length:          ${dg1Bytes.length}`);
console.log(`econtentBytes length:     ${econtent.length}`);
console.log(`signedAttr length:        ${signedAttr.length}`);
console.log(`quotients count:          ${quotients.length} (each 16 limbs LE)`);
