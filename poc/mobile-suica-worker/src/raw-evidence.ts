import type { RawEvidenceBackfillPageResult, RawEvidenceImportResult } from "./types";

const MAX_RESPONSE_BYTES = 8 * 1024;

export async function importStoredRun(
  importer: Fetcher,
  manifestKey: string,
): Promise<RawEvidenceImportResult> {
  const value = await importerRequest(
    importer,
    "/v1/mobile-suica/import-run",
    { manifestKey },
  );
  return validateImportResult(value, manifestKey);
}

export async function backfillStoredRuns(
  importer: Fetcher,
  cursor?: string,
): Promise<RawEvidenceBackfillPageResult> {
  const value = await importerRequest(
    importer,
    "/v1/mobile-suica/backfill-page",
    { ...(cursor ? { cursor } : {}), limit: 1 },
  );
  return validateBackfillResult(value);
}

async function importerRequest(importer: Fetcher, path: string, body: unknown): Promise<unknown> {
  const response = await importer.fetch(new Request(`https://collector-r2-importer.internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  const responseText = await boundedText(response, MAX_RESPONSE_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    throw new Error("raw_evidence_importer_invalid_response");
  }
  if (!response.ok) throw new Error("raw_evidence_importer_request_failed");
  return parsed;
}

function validateImportResult(value: unknown, expectedManifestKey: string): RawEvidenceImportResult {
  const input = exactRecord(value, [
    "source", "manifestKey", "status", "centralRunId", "artifactCount", "sealed",
    "finalChunkAllObjectsReused",
  ]);
  if (
    input.source !== "mobile-suica" ||
    input.manifestKey !== expectedManifestKey ||
    input.status !== "sealed" ||
    input.sealed !== true ||
    !positiveInteger(input.centralRunId) ||
    !positiveInteger(input.artifactCount) ||
    typeof input.finalChunkAllObjectsReused !== "boolean"
  ) {
    throw new Error("raw_evidence_importer_invalid_response");
  }
  return {
    source: input.source,
    manifestKey: input.manifestKey,
    status: input.status,
    centralRunId: input.centralRunId,
    artifactCount: input.artifactCount,
    sealed: input.sealed,
    finalChunkAllObjectsReused: input.finalChunkAllObjectsReused,
  };
}

function validateBackfillResult(value: unknown): RawEvidenceBackfillPageResult {
  const input = exactRecord(value, [
    "source", "scannedObjectCount", "importedManifestCount", "skippedManifestCount",
    "deferredManifestCount", "failedManifestCount", "nextCursor", "truncated",
    "failureCode", "failedManifestKey", "result",
  ], ["failureCode", "failedManifestKey", "result"]);
  if (
    input.source !== "mobile-suica" ||
    !nonNegativeInteger(input.scannedObjectCount) ||
    !nonNegativeInteger(input.importedManifestCount) ||
    !nonNegativeInteger(input.skippedManifestCount) ||
    !nonNegativeInteger(input.deferredManifestCount) ||
    !nonNegativeInteger(input.failedManifestCount) ||
    !(input.nextCursor === null || safeOpaque(input.nextCursor)) ||
    typeof input.truncated !== "boolean" ||
    !(input.failureCode === undefined || safeCode(input.failureCode)) ||
    !(input.failedManifestKey === undefined || safeManifestKey(input.failedManifestKey))
  ) {
    throw new Error("raw_evidence_importer_invalid_response");
  }
  const result = input.result === undefined
    ? undefined
    : validateImportResult(input.result, manifestKeyFromResult(input.result));
  return {
    source: input.source,
    scannedObjectCount: input.scannedObjectCount,
    importedManifestCount: input.importedManifestCount,
    skippedManifestCount: input.skippedManifestCount,
    deferredManifestCount: input.deferredManifestCount,
    failedManifestCount: input.failedManifestCount,
    nextCursor: input.nextCursor,
    truncated: input.truncated,
    ...(input.failureCode === undefined ? {} : { failureCode: input.failureCode }),
    ...(input.failedManifestKey === undefined ? {} : { failedManifestKey: input.failedManifestKey }),
    ...(result === undefined ? {} : { result }),
  };
}

function manifestKeyFromResult(value: unknown): string {
  if (!isRecord(value) || !safeManifestKey(value.manifestKey)) {
    throw new Error("raw_evidence_importer_invalid_response");
  }
  return value.manifestKey;
}

function exactRecord(
  value: unknown,
  allowed: string[],
  optional: string[] = [],
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("raw_evidence_importer_invalid_response");
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key)) || allowed.some(
    (key) => !optional.includes(key) && !Object.hasOwn(value, key),
  )) {
    throw new Error("raw_evidence_importer_invalid_response");
  }
  return value;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

function safeOpaque(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 500 && !/[\x00-\x20\x7f]/u.test(value);
}

function safeCode(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9_]{1,100}$/u.test(value);
}

function safeManifestKey(value: unknown): value is string {
  return typeof value === "string" &&
    /^raw\/mobile-suica\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f-]{36}\/manifest\.json$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function boundedText(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let output = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel("response_too_large");
      throw new Error("raw_evidence_importer_response_too_large");
    }
    output += decoder.decode(value, { stream: true });
  }
  return output + decoder.decode();
}
