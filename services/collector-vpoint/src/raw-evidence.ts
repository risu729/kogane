import type {
  RawEvidenceBackfillPageResult,
  RawEvidenceDeferredResult,
  RawEvidenceImportResult,
} from "./types";

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
  const response = await importer.fetch(
    new Request(`https://collector-r2-importer.internal${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
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
  const input = exactRecord(value, [
    "source",
    "manifestKey",
    "status",
    "centralRunId",
    "artifactCount",
    "sealed",
    "allObjectsReused",
  ]);
  if (
    input.source !== "v-point" ||
    input.manifestKey !== expectedManifestKey ||
    input.status !== "sealed" ||
    !positiveInteger(input.centralRunId) ||
    !positiveInteger(input.artifactCount) ||
    input.sealed !== true ||
    typeof input.allObjectsReused !== "boolean"
  ) {
    throw new Error("raw_evidence_importer_invalid_response");
  }
  return input as unknown as RawEvidenceImportResult;
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
      "result",
    ],
    ["failureCode", "result"],
  );
  if (
    input.source !== "v-point" ||
    !zeroOrOne(input.scannedObjectCount) ||
    !zeroOrOne(input.importedManifestCount) ||
    !zeroOrOne(input.skippedManifestCount) ||
    !zeroOrOne(input.deferredManifestCount) ||
    !zeroOrOne(input.failedManifestCount) ||
    !(input.nextCursor === null || safeOpaque(input.nextCursor)) ||
    typeof input.truncated !== "boolean" ||
    !(input.failureCode === undefined || safeCode(input.failureCode))
  ) {
    throw new Error("raw_evidence_importer_invalid_response");
  }
  const result =
    input.result === undefined ? undefined : validateBackfillImportResult(input.result);
  const outcomeCount =
    input.importedManifestCount +
    input.skippedManifestCount +
    input.deferredManifestCount +
    input.failedManifestCount;
  const resumedOutcome = input.scannedObjectCount === 0 && result !== undefined ? 1 : 0;
  const resultMatchesOutcome =
    result === undefined
      ? input.importedManifestCount === 0 && input.deferredManifestCount === 0
      : result.status === "sealed"
        ? input.importedManifestCount === 1 && input.deferredManifestCount === 0
        : input.importedManifestCount === 0 && input.deferredManifestCount === 1;
  if (
    outcomeCount !== input.scannedObjectCount + resumedOutcome ||
    !resultMatchesOutcome ||
    (input.failedManifestCount === 1) !== (input.failureCode !== undefined) ||
    (input.failedManifestCount === 1 && result !== undefined) ||
    input.truncated !== (input.nextCursor !== null) ||
    (input.deferredManifestCount === 1 && !input.truncated)
  ) {
    throw new Error("raw_evidence_importer_invalid_response");
  }
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

function validateBackfillImportResult(
  value: unknown,
): RawEvidenceImportResult | RawEvidenceDeferredResult {
  const manifestKey = manifestKeyFromResult(value);
  if (!isRecord(value)) throw new Error("raw_evidence_importer_invalid_response");
  if (value.status === "sealed") return validateImportResult(value, manifestKey);
  const input = exactRecord(value, [
    "source",
    "manifestKey",
    "status",
    "reason",
    "artifactCount",
    "nextOffset",
  ]);
  if (
    input.source !== "v-point" ||
    input.manifestKey !== manifestKey ||
    input.status !== "deferred" ||
    input.reason !== "worker_invocation_limit" ||
    !positiveInteger(input.artifactCount) ||
    !positiveInteger(input.nextOffset) ||
    input.nextOffset >= input.artifactCount
  ) {
    throw new Error("raw_evidence_importer_invalid_response");
  }
  return input as unknown as RawEvidenceDeferredResult;
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
  )
    throw new Error("raw_evidence_importer_invalid_response");
  return value;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function zeroOrOne(value: unknown): value is 0 | 1 {
  return value === 0 || value === 1;
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
  return typeof value === "string" && /^[a-z0-9_-]{1,100}$/u.test(value);
}

function safeManifestKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^raw\/v-point\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f-]{36}\/manifest\.json$/u.test(value)
  );
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
