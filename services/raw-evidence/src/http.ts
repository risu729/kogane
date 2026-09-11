// The HTTP half of the legacy ingest adapter: reading a request, proving the
// caller holds a client's secret, and writing a response. Everything the
// registration itself does — authorization, guards, conflicts — lives in
// `packages/application/src/ingest` since U05, so the Processor performs the
// same registration without an HTTP hop (unified plan 02 §3, decision D2).
import {
  IngestError,
  requireActiveClient,
  type IngestEnv,
  type RecordValue,
} from "../../../packages/application/src/ingest/index.ts";
import type { JsonValue } from "./canonical";
import { object } from "../../../packages/evidence-contract/src/validate";

export interface WorkerEnv extends Env {
  INGEST_CLIENT_KEYS: string;
  MAX_OBJECT_BYTES?: string;
}

// The Worker's generated bindings must keep satisfying what the use cases
// need; if a binding is renamed or retyped this stops compiling here rather
// than at the first request.
const _envIsIngestEnv: (env: WorkerEnv) => IngestEnv = (env) => env;
void _envIsIngestEnv;

export type { RecordValue };

/** The refusal type of the registration use cases, under its historical name. */
export { IngestError as ApiError };
export { assertSame, loadRun, requireRoute, SHA256 } from "../../../packages/application/src/ingest/index.ts";

const MAX_JSON_BYTES = 256 * 1024;

export function json(data: JsonValue, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export async function readJson(request: Request): Promise<RecordValue> {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_JSON_BYTES)) {
    throw new IngestError(413, "json_too_large");
  }
  if (!request.body) throw new IngestError(400, "invalid_json");
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let byteLength = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_JSON_BYTES) {
        await reader.cancel("json_too_large");
        throw new IngestError(413, "json_too_large");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof IngestError) throw error;
    throw new IngestError(400, "invalid_json_encoding");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new IngestError(400, "invalid_json");
  }
  return object(parsed);
}

async function equalSecret(left: string, right: string): Promise<boolean> {
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(left)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(right)),
  ]);
  const a = new Uint8Array(leftHash);
  const b = new Uint8Array(rightHash);
  let mismatch = a.length ^ b.length;
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    mismatch |= a[index] ^ b[index];
  }
  return mismatch === 0;
}

/**
 * Proving the caller holds a client's secret is the transport's job and stays
 * here; whether that client may still record is a CORE fact and is checked by
 * the shared `requireActiveClient`.
 */
export async function authenticate(request: Request, env: WorkerEnv): Promise<string> {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([a-z0-9-]{1,100})\.([^\s]{20,})$/.exec(authorization);
  let keys: RecordValue;
  try {
    keys = object(JSON.parse(env.INGEST_CLIENT_KEYS));
  } catch {
    throw new IngestError(503, "auth_configuration_invalid");
  }
  const expected = match ? keys[match[1]] : undefined;
  if (!match || typeof expected !== "string" || !(await equalSecret(match[2], expected))) {
    throw new IngestError(401, "unauthorized");
  }
  await requireActiveClient(env, match[1]);
  return match[1];
}
