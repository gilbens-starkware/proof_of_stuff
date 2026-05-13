package com.starkware.passportreader

import android.nfc.tech.IsoDep
import net.sf.scuba.smartcards.CardService
import org.bouncycastle.asn1.ASN1OctetString
import org.bouncycastle.asn1.cms.ContentInfo
import org.bouncycastle.asn1.cms.SignedData
import org.bouncycastle.cms.CMSSignedData
import org.jmrtd.BACKey
import org.jmrtd.PassportService

data class PassportData(
    val dg1Bytes: ByteArray,
    val econtentBytes: ByteArray,
    val signedAttr: ByteArray,
)

/**
 * Reads DG1, eContent, and signedAttr from an e-passport over NFC.
 *
 * Requires BAC keys: document number (9 chars), DOB (YYMMDD), expiry (YYMMDD).
 * Check digits are computed internally by jmrtd.
 */
object PassportReader {

    fun read(tag: IsoDep, docNumber: String, dob: String, expiry: String): PassportData {
        tag.timeout = 10_000

        val cardService = CardService.getInstance(tag)
        val service = PassportService(
            cardService,
            PassportService.NORMAL_MAX_TRANCEIVE_LENGTH,
            PassportService.DEFAULT_MAX_BLOCKSIZE,
            /* hasSFI = */ true,
            /* isMSCEnabled = */ false,
        )

        service.open()
        service.sendSelectApplet(false)

        val bacKey = BACKey(docNumber, dob, expiry)
        service.doBAC(bacKey)

        // Raw DG1 bytes (tag 0x61 + MRZ)
        val dg1Bytes = service.getInputStream(PassportService.EF_DG1).readBytes()

        // Raw EF.SOD bytes (DocumentSecurityObject wrapper + ContentInfo/SignedData)
        val sodRaw = service.getInputStream(PassportService.EF_SOD).readBytes()

        service.close()

        val (econtentBytes, signedAttrBytes) = parseSod(sodRaw)
        return PassportData(dg1Bytes, econtentBytes, signedAttrBytes)
    }

    // ── SOD parsing ───────────────────────────────────────────────────────────

    private fun parseSod(sodRaw: ByteArray): Pair<ByteArray, ByteArray> {
        // EF.SOD may be wrapped in an application tag (0x77). Strip it.
        val ciBytes = if (sodRaw[0] == 0x77.toByte()) skipTlv(sodRaw) else sodRaw

        // eContent: the LDSSecurityObject SEQUENCE bytes embedded in SignedData
        val ci = ContentInfo.getInstance(ciBytes)
        val sd = SignedData.getInstance(ci.content)
        val econtentBytes = ASN1OctetString.getInstance(sd.encapContentInfo.content).octets

        // signedAttr: DER-encoded as SET (0x31…) — this is what gets hashed for signature
        val cms = CMSSignedData(ciBytes)
        @Suppress("UNCHECKED_CAST")
        val signer = cms.signerInfos.signers.first()
        val signedAttrBytes = signer.encodedSignedAttributes

        return Pair(econtentBytes, signedAttrBytes)
    }

    /** Skips one TLV wrapper at offset 0 and returns the value bytes. */
    private fun skipTlv(bytes: ByteArray): ByteArray {
        var i = 1  // skip tag byte
        // Multi-byte tag: keep reading while bit 5 is set (not needed for 0x77)
        val lenByte = bytes[i++].toInt() and 0xFF
        val valueStart = if (lenByte <= 0x7F) {
            i  // short form
        } else {
            i + (lenByte and 0x7F)  // skip N length bytes
        }
        return bytes.copyOfRange(valueStart, bytes.size)
    }
}
