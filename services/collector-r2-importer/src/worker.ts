import { ImportError } from "./error";
import { importSbiRun } from "./sbi";
import { importSbiVcRun } from "./sbi-vc";
import { importSonyRun } from "./sony";

type JsonObject = Record<string, unknown>;

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health" && url.search === "") {
      return json({
        ok: true,
        service: "collector-r2-importer",
        version: env.IMPORTER_VERSION,
      });
    }
    if (request.method === "POST" && url.pathname === "/v1/sbi-securities/import-run" &&
        url.search === "") {
      try {
        const input = await readJson(request);
        exactKeys(input, ["manifestKey"]);
        const manifestKey = requiredString(input.manifestKey, "manifest_key_invalid", 500);
        return json(await importOne(env, manifestKey));
      } catch (error) {
        return errorResponse(error);
      }
    }
    if (request.method === "POST" && url.pathname === "/v1/sbi-securities/backfill-page" &&
        url.search === "") {
      try {
        const input = await readJson(request);
        exactKeys(input, ["cursor", "limit"]);
        const cursor = input.cursor === undefined
          ? undefined
          : requiredString(input.cursor, "cursor_invalid", 4_096);
        if (input.limit !== undefined && input.limit !== 1) {
          throw new ImportError(400, "backfill_limit_must_be_one");
        }
        const listed = await env.SBI_SNAPSHOTS.list({
          prefix: "raw/sbi-securities/",
          limit: 1,
          ...(cursor ? { cursor } : {}),
        });
        const object = listed.objects[0];
        let importedManifestCount = 0;
        let skippedManifestCount = 0;
        let failedManifestCount = 0;
        let failureCode: string | undefined;
        let result: Awaited<ReturnType<typeof importOne>> | undefined;
        if (object?.key.endsWith("/manifest.json")) {
          try {
            result = await importOne(env, object.key);
            importedManifestCount = 1;
          } catch (error) {
            failedManifestCount = 1;
            failureCode = safeCode(error);
          }
        } else if (object) {
          skippedManifestCount = 1;
        }
        return json({
          source: "sbi-securities",
          scannedObjectCount: listed.objects.length,
          importedManifestCount,
          skippedManifestCount,
          failedManifestCount,
          nextCursor: listed.truncated ? listed.cursor ?? null : null,
          truncated: listed.truncated,
          ...(failureCode ? { failureCode } : {}),
          ...(result ? { result } : {}),
        });
      } catch (error) {
        return errorResponse(error);
      }
    }
    if (request.method === "POST" && url.pathname === "/v1/sbi-vc-trade/import-run" &&
        url.search === "") {
      try {
        const input = await readJson(request);
        exactKeys(input, ["manifestKey"]);
        const manifestKey = requiredString(input.manifestKey, "manifest_key_invalid", 500);
        return json(await importOneSbiVc(env, manifestKey));
      } catch (error) {
        return errorResponse(error);
      }
    }
    if (request.method === "POST" && url.pathname === "/v1/sbi-vc-trade/backfill-page" &&
        url.search === "") {
      try {
        const input = await readJson(request);
        exactKeys(input, ["cursor", "limit"]);
        const cursor = input.cursor === undefined
          ? undefined
          : requiredString(input.cursor, "cursor_invalid", 4_096);
        if (input.limit !== undefined && input.limit !== 1) {
          throw new ImportError(400, "backfill_limit_must_be_one");
        }
        const listed = await env.SBI_VC_SNAPSHOTS.list({
          prefix: "raw/sbi-vc-trade/",
          limit: 1,
          ...(cursor ? { cursor } : {}),
        });
        const object = listed.objects[0];
        let importedManifestCount = 0;
        let skippedManifestCount = 0;
        let deferredManifestCount = 0;
        let failedManifestCount = 0;
        let failureCode: string | undefined;
        let deferredReason: string | undefined;
        let result: Awaited<ReturnType<typeof importOneSbiVc>> | undefined;
        if (object?.key.endsWith("/manifest.json")) {
          try {
            result = await importOneSbiVc(env, object.key);
            importedManifestCount = 1;
          } catch (error) {
            const classification = classifySbiVcBackfillError(error);
            if (classification.deferred) {
              deferredManifestCount = 1;
              deferredReason = classification.code;
            } else {
              failedManifestCount = 1;
              failureCode = classification.code;
            }
          }
        } else if (object) {
          skippedManifestCount = 1;
        }
        return json({
          source: "sbi-vc-trade",
          scannedObjectCount: listed.objects.length,
          importedManifestCount,
          skippedManifestCount,
          deferredManifestCount,
          failedManifestCount,
          nextCursor: listed.truncated ? listed.cursor ?? null : null,
          truncated: listed.truncated,
          ...(failureCode ? { failureCode } : {}),
          ...(deferredReason ? { deferredReason } : {}),
          ...(result ? { result } : {}),
        });
      } catch (error) {
        return errorResponse(error);
      }
    }
    if (request.method === "POST" && url.pathname === "/v1/sony-bank/import-run" &&
        url.search === "") {
      try {
        const input = await readJson(request);
        exactKeys(input, ["manifestKey"]);
        const manifestKey = requiredString(input.manifestKey, "manifest_key_invalid", 500);
        const result = await importOneSony(env, manifestKey, 0, true);
        return json(result, result.status === "deferred" ? 202 : 200);
      } catch (error) {
        return errorResponse(error);
      }
    }
    if (request.method === "POST" && url.pathname === "/v1/sony-bank/backfill-page" &&
        url.search === "") {
      try {
        const input = await readJson(request);
        exactKeys(input, ["cursor", "limit"]);
        const cursor = input.cursor === undefined
          ? undefined
          : requiredString(input.cursor, "cursor_invalid", 12_000);
        if (input.limit !== undefined && input.limit !== 1) {
          throw new ImportError(400, "backfill_limit_must_be_one");
        }
        return json(await backfillSony(env, cursor));
      } catch (error) {
        return errorResponse(error);
      }
    }
    return json({ error: "not_found" }, 404);
  },
} satisfies ExportedHandler<Env>;

function importOne(env: Env, manifestKey: string) {
  return importSbiRun({
    bucket: env.SBI_SNAPSHOTS,
    centralService: env.RAW_EVIDENCE,
    centralToken: env.RAW_EVIDENCE_TOKEN,
    fingerprintKey: env.ORIGIN_FINGERPRINT_KEY,
    importerVersion: env.IMPORTER_VERSION,
    manifestKey,
  });
}

function importOneSbiVc(env: Env, manifestKey: string) {
  return importSbiVcRun({
    bucket: env.SBI_VC_SNAPSHOTS,
    centralService: env.RAW_EVIDENCE,
    centralToken: env.RAW_EVIDENCE_TOKEN_SBI_VC,
    fingerprintKey: env.ORIGIN_FINGERPRINT_KEY,
    importerVersion: env.IMPORTER_VERSION,
    manifestKey,
  });
}

function importOneSony(
  env: Env,
  manifestKey: string,
  offset: number,
  immediate: boolean,
) {
  return importSonyRun({
    bucket: env.SONY_SNAPSHOTS,
    centralService: env.RAW_EVIDENCE,
    centralToken: env.RAW_EVIDENCE_TOKEN_SONY,
    fingerprintKey: env.ORIGIN_FINGERPRINT_KEY,
    importerVersion: env.IMPORTER_VERSION,
    manifestKey,
    offset,
    immediate,
  });
}

interface SonyBackfillCursor {
  v: 1;
  scanCursor: string | null;
  scanDone: boolean;
  manifestKey?: string;
  offset?: number;
}

async function backfillSony(env: Env, encodedCursor: string | undefined): Promise<JsonObject> {
  const state = encodedCursor ? decodeSonyCursor(encodedCursor) : null;
  if (state?.manifestKey !== undefined) {
    const offset = state.offset ?? 0;
    const result = await importOneSony(env, state.manifestKey, offset, false);
    if (result.status === "deferred") {
      if (result.reason === "central_inventory_limit" || result.nextOffset <= offset) {
        throw new ImportError(409, result.reason);
      }
      return sonyBackfillResponse({
        scannedObjectCount: 0,
        deferredManifestCount: 1,
        nextCursor: encodeSonyCursor({
          ...state,
          offset: result.nextOffset,
        }),
        result,
      });
    }
    return sonyBackfillResponse({
      scannedObjectCount: 0,
      importedManifestCount: 1,
      nextCursor: nextSonyScanCursor(state),
      result,
    });
  }

  const listed = await env.SONY_SNAPSHOTS.list({
    prefix: "raw/sony-bank/",
    limit: 1,
    ...(state?.scanCursor ? { cursor: state.scanCursor } : {}),
  });
  const object = listed.objects[0];
  const scanDone = !listed.truncated;
  const scanCursor = listed.truncated ? listed.cursor : undefined;
  if (listed.truncated && !scanCursor) throw new ImportError(409, "prefix_cursor_missing");
  const continuation: SonyBackfillCursor = {
    v: 1,
    scanCursor: scanCursor ?? null,
    scanDone,
  };
  if (!object) {
    return sonyBackfillResponse({ scannedObjectCount: 0, nextCursor: null });
  }
  if (!object.key.endsWith("/manifest.json")) {
    return sonyBackfillResponse({
      scannedObjectCount: 1,
      skippedManifestCount: 1,
      nextCursor: nextSonyScanCursor(continuation),
    });
  }
  try {
    const result = await importOneSony(env, object.key, 0, false);
    if (result.status === "deferred") {
      if (result.reason === "central_inventory_limit" || result.nextOffset <= 0) {
        throw new ImportError(409, result.reason);
      }
      return sonyBackfillResponse({
        scannedObjectCount: 1,
        deferredManifestCount: 1,
        nextCursor: encodeSonyCursor({
          ...continuation,
          manifestKey: object.key,
          offset: result.nextOffset,
        }),
        result,
      });
    }
    return sonyBackfillResponse({
      scannedObjectCount: 1,
      importedManifestCount: 1,
      nextCursor: nextSonyScanCursor(continuation),
      result,
    });
  } catch (error) {
    return sonyBackfillResponse({
      scannedObjectCount: 1,
      failedManifestCount: 1,
      failureCode: safeCode(error),
      failedManifestKey: object.key,
      nextCursor: nextSonyScanCursor(continuation),
    });
  }
}

function sonyBackfillResponse(input: {
  scannedObjectCount: number;
  importedManifestCount?: number;
  skippedManifestCount?: number;
  deferredManifestCount?: number;
  failedManifestCount?: number;
  failureCode?: string;
  failedManifestKey?: string;
  nextCursor: string | null;
  result?: unknown;
}): JsonObject {
  return {
    source: "sony-bank",
    scannedObjectCount: input.scannedObjectCount,
    importedManifestCount: input.importedManifestCount ?? 0,
    skippedManifestCount: input.skippedManifestCount ?? 0,
    deferredManifestCount: input.deferredManifestCount ?? 0,
    failedManifestCount: input.failedManifestCount ?? 0,
    nextCursor: input.nextCursor,
    truncated: input.nextCursor !== null,
    ...(input.failureCode ? { failureCode: input.failureCode } : {}),
    ...(input.failedManifestKey ? { failedManifestKey: input.failedManifestKey } : {}),
    ...(input.result ? { result: input.result } : {}),
  };
}

function nextSonyScanCursor(state: SonyBackfillCursor): string | null {
  return state.scanDone ? null : encodeSonyCursor({
    v: 1,
    scanCursor: state.scanCursor,
    scanDone: false,
  });
}

function encodeSonyCursor(value: SonyBackfillCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `sony-v1.${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")}`;
}

function decodeSonyCursor(value: string): SonyBackfillCursor {
  if (!value.startsWith("sony-v1.")) throw new ImportError(400, "cursor_invalid");
  const encoded = value.slice("sony-v1.".length).replaceAll("-", "+").replaceAll("_", "/");
  const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=");
  let parsed: unknown;
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ImportError(400, "cursor_invalid");
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new ImportError(400, "cursor_invalid");
  }
  const input = parsed as JsonObject;
  exactKeys(input, ["v", "scanCursor", "scanDone", "manifestKey", "offset"]);
  if (input.v !== 1 || typeof input.scanDone !== "boolean" ||
      !(input.scanCursor === null || typeof input.scanCursor === "string") ||
      (typeof input.scanCursor === "string" && input.scanCursor.length > 4_096) ||
      (input.manifestKey !== undefined &&
        (typeof input.manifestKey !== "string" || input.manifestKey.length > 500)) ||
      (input.offset !== undefined &&
        (!Number.isSafeInteger(input.offset) || (input.offset as number) < 0)) ||
      ((input.manifestKey === undefined) !== (input.offset === undefined))) {
    throw new ImportError(400, "cursor_invalid");
  }
  return input as unknown as SonyBackfillCursor;
}

async function readJson(request: Request): Promise<JsonObject> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > 64 * 1024)) {
    throw new ImportError(413, "json_too_large");
  }
  if (!request.body) throw new ImportError(400, "json_invalid");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > 64 * 1024) {
      await reader.cancel("json_too_large");
      throw new ImportError(413, "json_too_large");
    }
    chunks.push(value);
  }
  if (total === 0) throw new ImportError(400, "json_invalid");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (value === null || Array.isArray(value) || typeof value !== "object") {
      throw new ImportError(400, "json_shape_invalid");
    }
    return value as JsonObject;
  } catch (error) {
    if (error instanceof ImportError) throw error;
    throw new ImportError(400, "json_invalid");
  }
}

function exactKeys(value: JsonObject, allowed: readonly string[]): void {
  const set = new Set(allowed);
  if (Object.keys(value).some((key) => !set.has(key))) {
    throw new ImportError(400, "unknown_field");
  }
}

function requiredString(value: unknown, code: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new ImportError(400, code);
  }
  return value;
}

function errorResponse(error: unknown): Response {
  return json(
    { error: safeCode(error) },
    error instanceof ImportError ? error.status : 502,
  );
}

function safeCode(error: unknown): string {
  const candidate = error instanceof ImportError
    ? error.code
    : error instanceof Error ? error.message : "request_failed";
  return /^[a-z0-9_-]{1,100}$/u.test(candidate) ? candidate : "request_failed";
}

export function classifySbiVcBackfillError(error: unknown): {
  deferred: boolean;
  code: string;
} {
  const code = safeCode(error);
  return { deferred: code === "sync_import_worker_chain_limit", code };
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
