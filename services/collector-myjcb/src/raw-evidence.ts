const MAX_RESPONSE_BYTES = 32 * 1024;

export interface RawEvidenceBackfillPageResult {
  source: "myjcb";
  scannedObjectCount: number;
  importedManifestCount: number;
  skippedManifestCount: number;
  deferredManifestCount: number;
  failedManifestCount: number;
  nextCursor: string | null;
  truncated: boolean;
  failureCode?: string;
  failedManifestKey?: string;
}

export async function backfillStoredRuns(
  importer: Fetcher,
  cursor?: string,
): Promise<RawEvidenceBackfillPageResult> {
  const response = await importer.fetch(
    new Request("https://kogane-collector-r2-importer.internal/v1/myjcb/backfill-page", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...(cursor ? { cursor } : {}), limit: 1 }),
    }),
  );
  if (
    response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
    "application/json"
  ) {
    throw new Error("raw_evidence_importer_invalid_response");
  }
  const body = await boundedText(response, MAX_RESPONSE_BYTES);
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new Error("raw_evidence_importer_invalid_response");
  }
  if (!response.ok) throw new Error("raw_evidence_importer_request_failed");
  return validateBackfillResult(value);
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
    input.source !== "myjcb" ||
    !boundedInteger(input.scannedObjectCount, 1) ||
    !boundedInteger(input.importedManifestCount, 1) ||
    !boundedInteger(input.skippedManifestCount, 1) ||
    !boundedInteger(input.deferredManifestCount, 1) ||
    !boundedInteger(input.failedManifestCount, 1) ||
    !(input.nextCursor === null || safeOpaque(input.nextCursor)) ||
    typeof input.truncated !== "boolean" ||
    !(input.failureCode === undefined || safeCode(input.failureCode)) ||
    !(input.failedManifestKey === undefined || safeManifestKey(input.failedManifestKey))
  ) {
    throw new Error("raw_evidence_importer_invalid_response");
  }
  const outcomes =
    input.importedManifestCount +
    input.skippedManifestCount +
    input.deferredManifestCount +
    input.failedManifestCount;
  const resultStatus = input.result === undefined ? undefined : validateImportResult(input.result);
  if (
    outcomes > 1 ||
    (input.scannedObjectCount === 1 && outcomes !== 1) ||
    (input.scannedObjectCount === 0 &&
      (resultStatus === undefined
        ? outcomes !== 0 || input.nextCursor !== null
        : outcomes !== 1 || input.skippedManifestCount !== 0 || input.failedManifestCount !== 0)) ||
    (input.importedManifestCount === 1) !== (resultStatus === "sealed") ||
    (input.deferredManifestCount === 1) !== (resultStatus === "deferred") ||
    input.truncated !== (input.nextCursor !== null) ||
    (input.failureCode === undefined) !== (input.failedManifestKey === undefined) ||
    (input.failedManifestCount === 1) !== (input.failureCode !== undefined)
  ) {
    throw new Error("raw_evidence_importer_invalid_response");
  }
  return {
    source: "myjcb",
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
  };
}

function validateImportResult(value: unknown): "sealed" | "deferred" {
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
          "continuation",
        ]);
  if (
    input.source !== "myjcb" ||
    !safeManifestKey(input.manifestKey) ||
    !boundedPositiveInteger(input.artifactCount, 513)
  ) {
    throw new Error("raw_evidence_importer_invalid_response");
  }
  if (input.status === "sealed") {
    if (
      input.sealed !== true ||
      !boundedPositiveInteger(input.centralRunId, Number.MAX_SAFE_INTEGER) ||
      typeof input.finalChunkAllObjectsReused !== "boolean"
    ) {
      throw new Error("raw_evidence_importer_invalid_response");
    }
    return "sealed";
  }
  if (
    input.reason !== "worker_invocation_limit" ||
    !boundedPositiveInteger(input.nextOffset, input.artifactCount as number) ||
    !safeTransfer(input.continuation)
  ) {
    throw new Error("raw_evidence_importer_invalid_response");
  }
  return "deferred";
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

function boundedInteger(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function boundedPositiveInteger(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function safeOpaque(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 16_000 &&
    !/[\x00-\x20\x7f]/u.test(value)
  );
}

function safeTransfer(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("myjcb-transfer-v1.") &&
    value.length <= 8_000 &&
    !/[\x00-\x20\x7f]/u.test(value)
  );
}

function safeCode(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9_-]{1,100}$/u.test(value);
}

function safeManifestKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^raw\/myjcb\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/manifest\.json$/u.test(
      value,
    )
  );
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
