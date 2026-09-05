import type { RawEvidenceBackfillPageResult, RawEvidenceImportResult } from "./raw-evidence-types";

const IMPORT_PATH = "/v1/prestia-globalpass/import-run";
const BACKFILL_PATH = "/v1/prestia-globalpass/backfill-page";
const MAX_RESPONSE_BYTES = 8 * 1024;

export interface RawEvidenceImporter {
  fetch(request: Request): Promise<Response>;
}

export async function importStoredRun(
  importer: RawEvidenceImporter,
  manifestKey: string,
): Promise<RawEvidenceImportResult> {
  const value = await importerRequest(importer, IMPORT_PATH, { manifestKey });
  return validateImportResult(value, manifestKey);
}

export async function backfillStoredRuns(
  importer: RawEvidenceImporter,
  cursor?: string,
): Promise<RawEvidenceBackfillPageResult> {
  const value = await importerRequest(importer, BACKFILL_PATH, {
    ...(cursor ? { cursor } : {}),
    limit: 1,
  });
  return validateBackfillResult(value);
}

async function importerRequest(
  importer: RawEvidenceImporter,
  path: string,
  body: unknown,
): Promise<unknown> {
  const response = await importer.fetch(
    new Request(`https://kogane-collector-r2-importer.internal${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  if (
    response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
    "application/json"
  ) {
    throw new Error("raw_evidence_importer_invalid_response");
  }
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

function validateImportResult(
  value: unknown,
  expectedManifestKey: string,
): RawEvidenceImportResult {
  if (!isRecord(value) || (value.status !== "sealed" && value.status !== "deferred")) {
    throw new Error("raw_evidence_importer_invalid_response");
  }
  const input =
    value.status === "sealed"
      ? exactRecord(value, [
          "source",
          "manifestKey",
          "status",
          "centralRunId",
          "artifactCount",
          "sealed",
          "finalChunkAllObjectsReused",
        ])
      : exactRecord(value, [
          "source",
          "manifestKey",
          "status",
          "reason",
          "artifactCount",
          "nextOffset",
        ]);
  if (
    input.source !== "prestia-globalpass" ||
    input.manifestKey !== expectedManifestKey ||
    !boundedPositiveInteger(input.artifactCount, 16)
  ) {
    throw new Error("raw_evidence_importer_invalid_response");
  }
  if (input.status === "deferred") {
    if (
      input.reason !== "worker_invocation_limit" ||
      !boundedNonNegativeInteger(input.nextOffset, input.artifactCount)
    ) {
      throw new Error("raw_evidence_importer_invalid_response");
    }
    return {
      source: "prestia-globalpass",
      manifestKey: expectedManifestKey,
      status: "deferred",
      reason: "worker_invocation_limit",
      artifactCount: input.artifactCount,
      nextOffset: input.nextOffset,
    };
  }
  if (
    input.sealed !== true ||
    !positiveInteger(input.centralRunId) ||
    typeof input.finalChunkAllObjectsReused !== "boolean"
  ) {
    throw new Error("raw_evidence_importer_invalid_response");
  }
  return {
    source: "prestia-globalpass",
    manifestKey: expectedManifestKey,
    status: "sealed",
    centralRunId: input.centralRunId,
    artifactCount: input.artifactCount,
    sealed: input.sealed,
    finalChunkAllObjectsReused: input.finalChunkAllObjectsReused,
  };
}

function validateBackfillResult(value: unknown): RawEvidenceBackfillPageResult {
  const input = exactRecord(
    value,
    [
      "source",
      "scannedObjectCount",
      "importedManifestCount",
      "skippedManifestCount",
      "deferredManifestCount",
      "failedManifestCount",
      "nextCursor",
      "truncated",
      "failureCode",
      "failedManifestKey",
      "result",
    ],
    ["failureCode", "failedManifestKey", "result"],
  );
  if (
    input.source !== "prestia-globalpass" ||
    !boundedNonNegativeInteger(input.scannedObjectCount, 1) ||
    !boundedNonNegativeInteger(input.importedManifestCount, 1) ||
    !boundedNonNegativeInteger(input.skippedManifestCount, 1) ||
    !boundedNonNegativeInteger(input.deferredManifestCount, 1) ||
    !boundedNonNegativeInteger(input.failedManifestCount, 1) ||
    !(input.nextCursor === null || safeOpaque(input.nextCursor)) ||
    typeof input.truncated !== "boolean" ||
    !(input.failureCode === undefined || safeCode(input.failureCode)) ||
    !(input.failedManifestKey === undefined || safeManifestKey(input.failedManifestKey))
  ) {
    throw new Error("raw_evidence_importer_invalid_response");
  }
  const result =
    input.result === undefined
      ? undefined
      : validateImportResult(input.result, manifestKeyFromResult(input.result));
  const outcomeCount =
    input.importedManifestCount +
    input.skippedManifestCount +
    input.deferredManifestCount +
    input.failedManifestCount;
  const hasFailureDetails =
    input.failureCode !== undefined && input.failedManifestKey !== undefined;
  if (
    outcomeCount > 1 ||
    (input.scannedObjectCount === 1
      ? outcomeCount !== 1
      : input.scannedObjectCount !== 0 ||
        (result === undefined
          ? outcomeCount !== 0 || input.nextCursor !== null
          : outcomeCount !== 1 ||
            input.skippedManifestCount !== 0 ||
            input.failedManifestCount !== 0)) ||
    (input.importedManifestCount === 1) !== (result?.status === "sealed") ||
    (input.deferredManifestCount === 1) !== (result?.status === "deferred") ||
    (input.failureCode === undefined) !== (input.failedManifestKey === undefined) ||
    (input.failedManifestCount === 1) !== hasFailureDetails ||
    (input.truncated ? !safeOpaque(input.nextCursor) : input.nextCursor !== null)
  ) {
    throw new Error("raw_evidence_importer_invalid_response");
  }
  const output: RawEvidenceBackfillPageResult = {
    source: "prestia-globalpass",
    scannedObjectCount: input.scannedObjectCount,
    importedManifestCount: input.importedManifestCount,
    skippedManifestCount: input.skippedManifestCount,
    deferredManifestCount: input.deferredManifestCount,
    failedManifestCount: input.failedManifestCount,
    nextCursor: input.nextCursor,
    truncated: input.truncated,
    ...(input.failureCode === undefined ? {} : { failureCode: input.failureCode }),
    ...(input.failedManifestKey === undefined
      ? {}
      : { failedManifestKey: input.failedManifestKey }),
    ...(result === undefined ? {} : { result }),
  };
  return output;
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
  if (
    keys.some((key) => !allowed.includes(key)) ||
    allowed.some((key) => !optional.includes(key) && !Object.hasOwn(value, key))
  ) {
    throw new Error("raw_evidence_importer_invalid_response");
  }
  return value;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function boundedPositiveInteger(value: unknown, maximum: number): value is number {
  return positiveInteger(value) && value <= maximum;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function boundedNonNegativeInteger(value: unknown, maximum: number): value is number {
  return nonNegativeInteger(value) && value <= maximum;
}

function safeOpaque(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 12_000 &&
    !/[\x00-\x20\x7f]/u.test(value)
  );
}

function safeCode(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9_]{1,100}$/u.test(value);
}

function safeManifestKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^raw\/prestia-globalpass\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/manifest\.json$/u.test(
      value,
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function boundedText(response: Response, limit: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > limit)) {
    throw new Error("raw_evidence_importer_response_too_large");
  }
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
