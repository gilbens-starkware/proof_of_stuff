package com.starkware.passportreader

import android.app.PendingIntent
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.nfc.NfcAdapter
import android.nfc.Tag
import android.nfc.tech.IsoDep
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.google.android.material.textfield.TextInputEditText
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

class MainActivity : AppCompatActivity() {

    private lateinit var etDocNumber: TextInputEditText
    private lateinit var etDob: TextInputEditText
    private lateinit var etExpiry: TextInputEditText
    private lateinit var tvStatus: TextView
    private lateinit var tvOutput: TextView
    private lateinit var btnCopy: Button

    private var nfcAdapter: NfcAdapter? = null
    private var lastJson: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        etDocNumber = findViewById(R.id.etDocNumber)
        etDob       = findViewById(R.id.etDob)
        etExpiry    = findViewById(R.id.etExpiry)
        tvStatus    = findViewById(R.id.tvStatus)
        tvOutput    = findViewById(R.id.tvOutput)
        btnCopy     = findViewById(R.id.btnCopy)

        nfcAdapter = NfcAdapter.getDefaultAdapter(this)
        if (nfcAdapter == null) {
            tvStatus.text = "ERROR: This device has no NFC."
        }

        btnCopy.setOnClickListener {
            lastJson?.let { json ->
                val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                cm.setPrimaryClip(ClipData.newPlainText("passport_data", json))
                tvStatus.text = "Copied to clipboard."
            }
        }
    }

    override fun onResume() {
        super.onResume()
        enableNfcForegroundDispatch()
    }

    override fun onPause() {
        super.onPause()
        nfcAdapter?.disableForegroundDispatch(this)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (NfcAdapter.ACTION_TECH_DISCOVERED == intent.action) {
            val tag: Tag? = intent.getParcelableExtra(NfcAdapter.EXTRA_TAG)
            tag?.let { handleTag(it) }
        }
    }

    private fun enableNfcForegroundDispatch() {
        val adapter = nfcAdapter ?: return
        val pi = PendingIntent.getActivity(
            this, 0,
            Intent(this, javaClass).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_MUTABLE,
        )
        val techLists = arrayOf(arrayOf(IsoDep::class.java.name))
        adapter.enableForegroundDispatch(this, pi, null, techLists)
    }

    private fun handleTag(tag: Tag) {
        val docNumber = etDocNumber.text?.toString()?.trim()?.uppercase() ?: ""
        val dob       = etDob.text?.toString()?.trim() ?: ""
        val expiry    = etExpiry.text?.toString()?.trim() ?: ""

        if (docNumber.isEmpty() || dob.length != 6 || expiry.length != 6) {
            tvStatus.text = "Fill in document number, DOB (YYMMDD), and expiry (YYMMDD) first."
            return
        }

        val isoDep = IsoDep.get(tag) ?: run {
            tvStatus.text = "ERROR: Not an ISO-DEP tag."
            return
        }

        tvStatus.text = "Reading passport…"
        btnCopy.visibility = View.GONE
        tvOutput.text = ""

        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching { PassportReader.read(isoDep, docNumber, dob, expiry) }
            }

            result.onSuccess { data ->
                val json = buildJson(data)
                lastJson = json
                tvOutput.text = json
                btnCopy.visibility = View.VISIBLE
                tvStatus.text = "Done. JSON shown below (also auto-copied to clipboard)."
                val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                cm.setPrimaryClip(ClipData.newPlainText("passport_data", json))
            }.onFailure { e ->
                tvStatus.text = "ERROR: ${e.message}"
                tvOutput.text = e.stackTraceToString()
            }
        }
    }

    private fun buildJson(data: PassportData): String {
        val obj = JSONObject()
        obj.put("dg1Bytes",      data.dg1Bytes.toJsonArray())
        obj.put("econtentBytes", data.econtentBytes.toJsonArray())
        obj.put("signedAttr",    data.signedAttr.toJsonArray())
        return obj.toString(2)
    }

    private fun ByteArray.toJsonArray(): JSONArray {
        val arr = JSONArray()
        forEach { b -> arr.put(b.toInt() and 0xFF) }
        return arr
    }
}
