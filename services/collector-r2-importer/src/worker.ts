import { ImportError, importSbiRun } from "./sbi";

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

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
