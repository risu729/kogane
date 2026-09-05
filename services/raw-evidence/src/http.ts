import type { JsonValue } from "./canonical";

export interface WorkerEnv extends Env {
  INGEST_CLIENT_KEYS: string;
  MAX_OBJECT_BYTES?: string;
}

export type RecordValue = Record<string, unknown>;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export const ID = /^[a-z0-9-]{1,100}$/;
export const OPAQUE = /^[A-Za-z0-9._:/-]{1,500}$/;
export const SHA256 = /^[0-9a-f]{64}$/;
const MAX_JSON_BYTES = 256 * 1024;

export function json(data: JsonValue, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export function object(value: unknown): RecordValue {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new ApiError(400, "invalid_json_shape");
  }
  return value as RecordValue;
}

export function exactKeys(value: RecordValue, allowed: readonly string[]): void {
  const allow = new Set(allowed);
  if (Object.keys(value).some((key) => !allow.has(key))) {
    throw new ApiError(400, "unknown_field");
  }
}

export function stringValue(
  value: unknown,
  field: string,
  options: { optional?: boolean; max?: number; pattern?: RegExp } = {},
): string | null {
  if (value === undefined || value === null) {
    if (options.optional) return null;
    throw new ApiError(400, `invalid_${field}`);
  }
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > (options.max ?? 500) ||
    (options.pattern && !options.pattern.test(value))
  ) {
    throw new ApiError(400, `invalid_${field}`);
  }
  return value;
}

export function enumValue<T extends string>(
  value: unknown,
  field: string,
  choices: readonly T[],
  optional = false,
): T | null {
  if ((value === undefined || value === null) && optional) return null;
  if (typeof value !== "string" || !choices.includes(value as T)) {
    throw new ApiError(400, `invalid_${field}`);
  }
  return value as T;
}

export function integerValue(value: unknown, field: string, optional = false): number | null {
  if ((value === undefined || value === null) && optional) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ApiError(400, `invalid_${field}`);
  }
  return value as number;
}

export function arrayValue(value: unknown, field: string, max = 1_000): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) {
    throw new ApiError(400, `invalid_${field}`);
  }
  return value;
}

export async function readJson(request: Request): Promise<RecordValue> {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_JSON_BYTES)) {
    throw new ApiError(413, "json_too_large");
  }
  if (!request.body) throw new ApiError(400, "invalid_json");
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
        throw new ApiError(413, "json_too_large");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "invalid_json_encoding");
  }
  try {
    return object(JSON.parse(text));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "invalid_json");
  }
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

export async function authenticate(request: Request, env: WorkerEnv): Promise<string> {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([a-z0-9-]{1,100})\.([^\s]{20,})$/.exec(authorization);
  let keys: RecordValue;
  try {
    keys = object(JSON.parse(env.INGEST_CLIENT_KEYS));
  } catch {
    throw new ApiError(503, "auth_configuration_invalid");
  }
  const expected = match ? keys[match[1]] : undefined;
  if (!match || typeof expected !== "string" || !(await equalSecret(match[2], expected))) {
    throw new ApiError(401, "unauthorized");
  }
  const active = await env.DB.prepare(
    "SELECT 1 AS ok FROM ingest_clients WHERE id = ? AND active = 1",
  )
    .bind(match[1])
    .first<{ ok: number }>();
  if (!active) throw new ApiError(403, "inactive_ingest_client");
  return match[1];
}

export async function requireRoute(
  env: WorkerEnv,
  clientId: string,
  producerId: string,
  sourceId: string,
): Promise<void> {
  const route = await env.DB.prepare(`
    SELECT 1 AS ok FROM active_ingest_routes
    WHERE ingest_client_id = ? AND producer_id = ? AND source_id = ?
  `)
    .bind(clientId, producerId, sourceId)
    .first<{ ok: number }>();
  if (!route) throw new ApiError(403, "inactive_ingest_route");
}

export async function loadRun(
  env: WorkerEnv,
  clientId: string,
  runId: number,
): Promise<{ id: number; producer_id: string; source_id: string }> {
  const run = await env.DB.prepare(`
    SELECT id, producer_id, source_id FROM fetch_runs WHERE id = ?
  `)
    .bind(runId)
    .first<{ id: number; producer_id: string; source_id: string }>();
  if (!run) throw new ApiError(404, "run_not_found");
  await requireRoute(env, clientId, run.producer_id, run.source_id);
  return run;
}

export function assertSame(row: RecordValue | null, expected: RecordValue, code: string): void {
  if (!row) throw new ApiError(500, "write_not_visible");
  for (const [key, value] of Object.entries(expected)) {
    if (row[key] !== value) throw new ApiError(409, code);
  }
}
