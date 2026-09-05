const MAX_RESPONSE_BYTES = 64 * 1024;

export interface RawEvidenceBackfillPageResult {
  source: "vpass";
  scannedObjectCount: number;
  importedRecordCount: number;
  skippedRecordCount: number;
  deferredRecordCount: number;
  failedRecordCount: number;
  nextCursor: string | null;
  truncated: boolean;
  failureCode?: string;
}

export interface VpassImportJob {
  v: 1;
  recordKey: string;
  continuation?: string;
}

export type RawEvidenceImportResult =
  | { status: "sealed" }
  | { status: "deferred"; continuation: string };

export async function enqueueStoredRecord(
  queue: Queue<VpassImportJob>,
  recordKey: string,
): Promise<void> {
  if (!safeRecordKey(recordKey)) throw new Error("raw_evidence_import_job_invalid");
  await queue.send({ v: 1, recordKey });
}

export async function continueStoredRecord(
  importer: Fetcher,
  queue: Queue<VpassImportJob>,
  value: unknown,
): Promise<"sealed" | "requeued"> {
  const job = validateImportJob(value);
  const result = await importStoredRecord(importer, job.recordKey, job.continuation);
  if (result.status === "sealed") return "sealed";
  await queue.send({
    v: 1,
    recordKey: job.recordKey,
    continuation: result.continuation,
  });
  return "requeued";
}

export async function importStoredRecord(
  importer: Fetcher,
  recordKey: string,
  continuation?: string,
): Promise<RawEvidenceImportResult> {
  if (
    !safeRecordKey(recordKey) ||
    !(
      continuation === undefined ||
      (safeOpaque(continuation, 16_000) && continuation.startsWith("vpass-transfer-v1."))
    )
  ) {
    throw new Error("raw_evidence_import_job_invalid");
  }
  const response = await importer.fetch(
    new Request("https://kogane-collector-r2-importer.internal/v1/vpass/import-run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recordKey, ...(continuation ? { continuation } : {}) }),
    }),
  );
  const value = await responseJson(response);
  if (!response.ok) throw new Error("raw_evidence_importer_request_failed");
  return validateImportResult(value);
}

export async function backfillStoredRuns(
  importer: Fetcher,
  cursor?: string,
): Promise<RawEvidenceBackfillPageResult> {
  const response = await importer.fetch(
    new Request("https://kogane-collector-r2-importer.internal/v1/vpass/backfill-page", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...(cursor ? { cursor } : {}), limit: 1 }),
    }),
  );
  const value = await responseJson(response);
  if (!response.ok) throw new Error("raw_evidence_importer_request_failed");
  return validateBackfillResult(value);
}

function validateBackfillResult(value: unknown): RawEvidenceBackfillPageResult {
  const input = exactRecord(
    value,
    [
      "source",
      "scannedObjectCount",
      "importedRecordCount",
      "skippedRecordCount",
      "deferredRecordCount",
      "failedRecordCount",
      "nextCursor",
      "truncated",
      "failureCode",
      "result",
    ],
    ["failureCode", "result"],
  );
  if (
    input.source !== "vpass" ||
    !boundedInteger(input.scannedObjectCount, 1) ||
    !boundedInteger(input.importedRecordCount, 1) ||
    !boundedInteger(input.skippedRecordCount, 1) ||
    !boundedInteger(input.deferredRecordCount, 1) ||
    !boundedInteger(input.failedRecordCount, 1) ||
    !(input.nextCursor === null || safeOpaque(input.nextCursor, 24_000)) ||
    typeof input.truncated !== "boolean" ||
    !(input.failureCode === undefined || safeCode(input.failureCode))
  )
    throw new Error("raw_evidence_importer_invalid_response");
  const outcomes =
    input.importedRecordCount +
    input.skippedRecordCount +
    input.deferredRecordCount +
    input.failedRecordCount;
  const resultStatus =
    input.result === undefined ? undefined : validateImportResult(input.result).status;
  if (
    outcomes > 1 ||
    (input.scannedObjectCount === 1 && outcomes !== 1) ||
    (input.scannedObjectCount === 0 &&
      (resultStatus === undefined
        ? outcomes !== 0 || input.nextCursor !== null
        : outcomes !== 1 || input.skippedRecordCount !== 0 || input.failedRecordCount !== 0)) ||
    (input.importedRecordCount === 1) !== (resultStatus === "sealed") ||
    (input.deferredRecordCount === 1) !== (resultStatus === "deferred") ||
    input.truncated !== (input.nextCursor !== null) ||
    (input.failedRecordCount === 1) !== (input.failureCode !== undefined)
  )
    throw new Error("raw_evidence_importer_invalid_response");
  return {
    source: "vpass",
    scannedObjectCount: input.scannedObjectCount,
    importedRecordCount: input.importedRecordCount,
    skippedRecordCount: input.skippedRecordCount,
    deferredRecordCount: input.deferredRecordCount,
    failedRecordCount: input.failedRecordCount,
    nextCursor: input.nextCursor,
    truncated: input.truncated,
    ...(input.failureCode === undefined ? {} : { failureCode: input.failureCode }),
  };
}

function validateImportResult(value: unknown): RawEvidenceImportResult {
  if (!isRecord(value) || (value.status !== "sealed" && value.status !== "deferred")) {
    throw new Error("raw_evidence_importer_invalid_response");
  }
  const input =
    value.status === "sealed"
      ? exactRecord(value, [
          "source",
          "recordKey",
          "status",
          "centralRunId",
          "artifactCount",
          "sealed",
          "finalChunkAllObjectsReused",
        ])
      : exactRecord(value, [
          "source",
          "recordKey",
          "status",
          "reason",
          "artifactCount",
          "nextOffset",
          "continuation",
        ]);
  if (
    input.source !== "vpass" ||
    !safeRecordKey(input.recordKey) ||
    !boundedPositiveInteger(input.artifactCount, 512)
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
    return { status: "sealed" };
  }
  if (
    input.reason !== "worker_invocation_limit" ||
    !boundedPositiveInteger(input.nextOffset, input.artifactCount as number) ||
    !safeOpaque(input.continuation, 16_000) ||
    !input.continuation.startsWith("vpass-transfer-v1.")
  ) {
    throw new Error("raw_evidence_importer_invalid_response");
  }
  return { status: "deferred", continuation: input.continuation as string };
}

function validateImportJob(value: unknown): VpassImportJob {
  const input = exactRecord(value, ["v", "recordKey", "continuation"], ["continuation"]);
  if (
    input.v !== 1 ||
    !safeRecordKey(input.recordKey) ||
    !(
      input.continuation === undefined ||
      (safeOpaque(input.continuation, 16_000) &&
        input.continuation.startsWith("vpass-transfer-v1."))
    )
  )
    throw new Error("raw_evidence_import_job_invalid");
  return {
    v: 1,
    recordKey: input.recordKey,
    ...(input.continuation === undefined ? {} : { continuation: input.continuation as string }),
  };
}

async function responseJson(response: Response): Promise<unknown> {
  if (
    response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
    "application/json"
  )
    throw new Error("raw_evidence_importer_invalid_response");
  const body = await boundedText(response, MAX_RESPONSE_BYTES);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("raw_evidence_importer_invalid_response");
  }
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

function boundedInteger(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function boundedPositiveInteger(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function safeOpaque(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\x00-\x20\x7f]/u.test(value)
  );
}

function safeCode(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9_-]{1,100}$/u.test(value);
}

function safeRecordKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^vpass\/\d{4}\/\d{2}\/\d{2}\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:\/card-\d{3})?\/(?:manifest|error)\.json$/u.test(
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
