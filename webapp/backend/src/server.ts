import "./env.ts";
import cors from "cors";
import express, { type Request, type Response, type NextFunction } from "express";
import { optional, required } from "./env.ts";
import { proveAndRegister } from "./prove.ts";
import { poolProveAndRegister } from "./poolProve.ts";
import { passportProveAndRegister } from "./passportProve.ts";

const PORT = Number(optional("PORT", "8787"));
const CORS_ORIGIN = optional("CORS_ORIGIN", "http://localhost:5173");

const app = express();
app.use(express.json({ limit: "256kb" }));
app.use(cors({ origin: CORS_ORIGIN === "*" ? true : CORS_ORIGIN.split(",") }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

// CORS-bypass proxy: forwards Starknet JSON-RPC to RPC_URL. The browser can't
// hit most public Starknet RPCs directly (they don't send Access-Control-*).
app.post("/api/rpc", async (req, res, next) => {
  try {
    const upstream = await fetch(required("RPC_URL"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req.body),
    });
    const text = await upstream.text();
    res.status(upstream.status).type("application/json").send(text);
  } catch (e) {
    next(e);
  }
});

interface ProveBody {
  account?: string;
  secret?: string;
  signature?: string[];
  min_balance?: string;
  token?: string;
  fact_registry?: string;
}

app.post("/api/prove", async (req: Request<unknown, unknown, ProveBody>, res, next) => {
  try {
    const body = req.body ?? {};
    const account = expect(body.account, "account");
    const secret = expect(body.secret, "secret");
    const minBalance = parseBigIntStrict(expect(body.min_balance, "min_balance"));
    const token = expect(body.token, "token");
    const factRegistry = expect(body.fact_registry, "fact_registry");
    const signature = expectSignature(body.signature);

    if (minBalance <= 0n) {
      return res.status(400).json({ error: "min_balance must be > 0" });
    }

    const result = await proveAndRegister({
      rpcUrl: required("RPC_URL"),
      provingServiceUrl: required("PROVING_SERVICE_URL"),
      relayerAddress: required("RELAYER_ADDRESS"),
      relayerPrivateKey: required("RELAYER_PRIVATE_KEY"),
      blockOffset: Number(optional("PROVING_BLOCK_OFFSET", "10")),
      account,
      secret,
      signature,
      minBalance,
      token,
      factRegistry,
    });

    res.json({
      slot: result.slot,
      tx_hash: result.txHash,
      base_block_number: result.baseBlockNumber,
    });
  } catch (e) {
    next(e);
  }
});

interface PoolProveBody {
  account?: string;
  secret?: string;
  signature?: string[];
  min_balance?: string;
  token?: string;
  fact_registry?: string;
  pool?: string;
  channel_key?: string;
  viewing_key?: string;
  token_index?: number;
  note_indices?: number[];
}

app.post("/api/pool-prove", async (req: Request<unknown, unknown, PoolProveBody>, res, next) => {
  try {
    const body = req.body ?? {};
    const account = expect(body.account, "account");
    const secret = expect(body.secret, "secret");
    const minBalance = parseBigIntStrict(expect(body.min_balance, "min_balance"));
    const token = expect(body.token, "token");
    const factRegistry = expect(body.fact_registry, "fact_registry");
    const signature = expectSignature(body.signature);
    const pool = expect(body.pool, "pool");
    const channelKey = expect(body.channel_key, "channel_key");
    const viewingKey = expect(body.viewing_key, "viewing_key");
    const tokenIndex = body.token_index;
    if (typeof tokenIndex !== "number" || !Number.isInteger(tokenIndex) || tokenIndex < 0) {
      return res.status(400).json({ error: "token_index must be a non-negative integer" });
    }
    const noteIndices = Array.isArray(body.note_indices) ? body.note_indices : [];
    if (noteIndices.length === 0) {
      return res.status(400).json({ error: "note_indices must be a non-empty array" });
    }
    if (!noteIndices.every((n) => Number.isInteger(n) && n >= 0)) {
      return res.status(400).json({ error: "note_indices entries must be non-negative integers" });
    }

    if (minBalance <= 0n) {
      return res.status(400).json({ error: "min_balance must be > 0" });
    }

    const result = await poolProveAndRegister({
      rpcUrl: required("RPC_URL"),
      provingServiceUrl: required("PROVING_SERVICE_URL"),
      relayerAddress: required("RELAYER_ADDRESS"),
      relayerPrivateKey: required("RELAYER_PRIVATE_KEY"),
      blockOffset: Number(optional("PROVING_BLOCK_OFFSET", "10")),
      account,
      secret,
      signature,
      minBalance,
      token,
      factRegistry,
      pool,
      channelKey,
      viewingKey,
      tokenIndex,
      noteIndices,
    });

    res.json({
      slot: result.slot,
      tx_hash: result.txHash,
      base_block_number: result.baseBlockNumber,
    });
  } catch (e) {
    next(e);
  }
});

interface PassportProveBody {
  account?: string;
  secret?: string;
  dg1_bytes?: number[];
  econtent_bytes?: number[];
  signed_attr?: number[];
  current_yymmdd?: number;
  fact_registry?: string;
}

app.post(
  "/api/passport-prove",
  async (req: Request<unknown, unknown, PassportProveBody>, res, next) => {
    try {
      const body = req.body ?? {};
      const account = expect(body.account, "account");
      const secret = expect(body.secret, "secret");
      const factRegistry = expect(body.fact_registry, "fact_registry");
      const dg1Bytes = expectByteArray(body.dg1_bytes, "dg1_bytes");
      const econtentBytes = expectByteArray(body.econtent_bytes, "econtent_bytes");
      const signedAttr = expectByteArray(body.signed_attr, "signed_attr");

      // current_yymmdd: use client-supplied value if valid, else today's date.
      const currentYymmdd =
        typeof body.current_yymmdd === "number" && body.current_yymmdd > 0
          ? body.current_yymmdd
          : todayYymmdd();

      const result = await passportProveAndRegister({
        rpcUrl: required("RPC_URL"),
        provingServiceUrl: required("PROVING_SERVICE_URL"),
        relayerAddress: required("RELAYER_ADDRESS"),
        relayerPrivateKey: required("RELAYER_PRIVATE_KEY"),
        blockOffset: Number(optional("PROVING_BLOCK_OFFSET", "10")),
        account,
        secret,
        dg1Bytes,
        econtentBytes,
        signedAttr,
        currentYymmdd,
        factRegistry,
      });

      res.json({
        slot: result.slot,
        tx_hash: result.txHash,
        base_block_number: result.baseBlockNumber,
      });
    } catch (e) {
      next(e);
    }
  },
);

// Surface error messages back to the frontend so it can show them in the UI
// instead of failing silently. We don't dump stack traces to clients, just
// the message — the full error stays in the server logs.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = (err as Error)?.message ?? String(err);
  console.error("[api error]", err);
  res.status(400).json({ error: message });
});

app.listen(PORT, () => {
  console.log(`proof-of-solvency backend listening on http://localhost:${PORT}`);
  console.log(`  CORS origin: ${CORS_ORIGIN}`);
});

function expect<T>(value: T | undefined, name: string): T {
  if (value === undefined || value === null || value === "") {
    throw new Error(`Missing field: ${name}`);
  }
  return value;
}

function expectSignature(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 2) {
    throw new Error("signature must be an array of at least 2 felts");
  }
  return value.map((v) => String(v));
}

function parseBigIntStrict(s: string): bigint {
  if (!/^[0-9]+$/.test(s)) {
    throw new Error(`expected decimal integer string, got: ${s}`);
  }
  return BigInt(s);
}

function expectByteArray(value: unknown, name: string): number[] {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array of bytes`);
  }
  if (!value.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
    throw new Error(`${name} contains non-byte values`);
  }
  return value as number[];
}

function todayYymmdd(): number {
  const d = new Date();
  const yy = d.getUTCFullYear() % 100;
  const mm = d.getUTCMonth() + 1;
  const dd = d.getUTCDate();
  return yy * 10000 + mm * 100 + dd;
}
