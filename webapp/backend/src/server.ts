import "./env.ts";
import cors from "cors";
import express, { type Request, type Response, type NextFunction } from "express";
import { optional, required } from "./env.ts";
import { proveAndRegister } from "./prove.ts";

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
