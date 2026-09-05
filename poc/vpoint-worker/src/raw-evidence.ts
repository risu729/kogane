import type { RawEvidenceBackfillPageResult, RawEvidenceImportResult } from "./types";

const MAX_RESPONSE_BYTES = 8 * 1024;

export async function importStoredRun(
  importer: Fetcher,
  manifestKey: string,
): Promise<RawEvidenceImportResult> {
  const value = await importerRequest(importer, "/v1/v-point/import-run", { manifestKey });
  return validateImportResult(value, manifestKey);
}

export async function backfillStoredRuns(
  importer: Fetcher,
  cursor?: string,
): Promise<RawEvidenceBackfillPageResult> {
  const value = await importerRequest(importer, "/v1/v-point/backfill-page", {
    ...(cursor ? { cursor } : {}),
    limit: 1,
  });
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
    "source", "manifestKey", "centralRunId", "artifactCount", "sealed", "allObjectsReused",
  ]);
  if (input.source !== "v-point" || input.manifestKey !== expectedManifestKey ||
      !positiveInteger(input.centralRunId) || !positiveInteger(input.artifactCount) ||
      input.sealed !== true || typeof input.allObjectsReused !== "boolean") {
    throw new Error("raw_evidence_importer_invalid_response");
  }
  return input as unknown as RawEvidenceImportResult;
}

function validateBackfillResult(value: unknown): RawEvidenceBackfillPageResult {
  const input = exactRecord(value, [
    "source", "scannedObjectCount", "importedManifestCount", "skippedManifestCount",
    "deferredManifestCount", "failedManifestCount", "nextCursor", "truncated",
    "failureCode", "result",
  ], ["failureCode", "result"]);
  if (input.source !== "v-point" || !nonNegativeInteger(input.scannedObjectCount) ||
      !nonNegativeInteger(input.importedManifestCount) || !nonNegativeInteger(input.skippedManifestCount) ||
      !nonNegativeInteger(input.deferredManifestCount) || !nonNegativeInteger(input.failedManifestCount) ||
      !(input.nextCursor === null || safeOpaque(input.nextCursor)) || typeof input.truncated !== "boolean" ||
      !(input.failureCode === undefined || safeCode(input.failureCode))) {
    throw new Error("raw_evidence_importer_invalid_response");
  }
  const result = input.result === undefined
    ? undefined
    : validateImportResult(input.result, manifestKeyFromResult(input.result));
  return {
    source: "v-point",
    scannedObjectCount: input.scannedObjectCount,
    importedManifestCount: input.importedManifestCount,
    skippedManifestCount: input.skippedManifestCount,
    deferredManifestCount: input.deferredManifestCount,
    failedManifestCount: input.failedManifestCount,
    nextCursor: input.nextCursor,
    truncated: input.truncated,
    ...(input.failureCode === undefined ? {} : { failureCode: input.failureCode }),
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
  )) throw new Error("raw_evidence_importer_invalid_response");
  return value;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function safeOpaque(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096 &&
    !/[\x00-\x20\x7f]/u.test(value);
}

function safeCode(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9_-]{1,100}$/u.test(value);
}

function safeManifestKey(value: unknown): value is string {
  return typeof value === "string" &&
    /^raw\/v-point\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f-]{36}\/manifest\.json$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function boundedText(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
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
