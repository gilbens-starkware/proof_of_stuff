// Passport age verifier for ICAO 9303 ePassports — POC stubs.
//
// Real verification chain (all crypto stubs for POC):
//   dg1_bytes -> SHA384 -> dg1_hash  (embedded in econtent at offset 31, 48 bytes)
//   econtent  -> SHA384 -> econtent_hash  (embedded in signed_attr at offset 115, 48 bytes)
//   signed_attr -> SHA384 -> m_hash  -> RSA-PSS verify  (TODO)
//   dg1_bytes[62..68] -> YYMMDD -> assert age >= 18  ← only real check
//
// SHA-384 (the algorithm used by real ePassports, OID 2.16.840.1.101.3.4.2.2)
// is not available as a Cairo builtin.  The hash chain is therefore mocked
// until a SHA-384 implementation is added.  The age assertion is real.

// ── Age claim ────────────────────────────────────────────────────────────────
// dg1_bytes[62..68] = YYMMDD as ASCII digits
// current_yymmdd: YYMMDD decimal (e.g. 260513 for 2026-05-13)

fn assert_age_over_18(dg1_bytes: Span<u8>, current_yymmdd: u32) {
    let dob_offset: usize = 62;
    let yy: u32 = parse_two_digits(dg1_bytes, dob_offset);
    let mm: u32 = parse_two_digits(dg1_bytes, dob_offset + 2);
    let dd: u32 = parse_two_digits(dg1_bytes, dob_offset + 4);

    let cur_yy: u32 = current_yymmdd / 10000;
    let cur_mm: u32 = (current_yymmdd / 100) % 100;
    let cur_dd: u32 = current_yymmdd % 100;

    // yy >= 50 → 19xx, < 50 → 20xx
    let birth_full: u32 = if yy >= 50 { 1900 + yy } else { 2000 + yy };
    let cur_full: u32 = if cur_yy >= 50 { 1900 + cur_yy } else { 2000 + cur_yy };

    let age_years = cur_full - birth_full;
    let birthday_passed: bool = (cur_mm > mm) || (cur_mm == mm && cur_dd >= dd);
    let age: u32 = if birthday_passed { age_years } else { age_years - 1 };
    assert(age >= 18, 'age below 18');
}

fn parse_two_digits(bytes: Span<u8>, offset: usize) -> u32 {
    let tens: u32 = (*bytes[offset]).into();
    let ones: u32 = (*bytes[offset + 1]).into();
    (tens - 48) * 10 + (ones - 48)
}

// ── Public entrypoint ─────────────────────────────────────────────────────────
//
// Verifies a passport identity claim: the holder is over 18.
//   dg1_bytes:        93 bytes  — raw DG1 TLV (TD3 format)
//   econtent_bytes:   variable  — ASN.1 LDSSecurityObject (SHA-384: ~370 bytes)
//   signed_attr:      variable  — CMS SignedAttributes SET (SHA-384: ~163 bytes)
//   current_yymmdd:  u32        — today as YYMMDD decimal (e.g. 260513)
//
// TODO: SHA-384 hash chain and RSA-PSS signature verification (both mocked).
// Only the age assertion from DG1 MRZ bytes[62..68] is enforced.

pub fn verify_passport_age_over_18(
    dg1_bytes: Span<u8>,
    econtent_bytes: Span<u8>,
    signed_attr: Span<u8>,
    current_yymmdd: u32,
) {
    // Hash chain (SHA-384) and RSA-PSS are mocked for POC.
    // Age assertion is real — fails for holders under 18.
    assert_age_over_18(dg1_bytes, current_yymmdd);
}
