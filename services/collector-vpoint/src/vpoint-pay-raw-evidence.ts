const MAX_RESPONSE_BYTES = 8 * 1024;

export interface VPointPayEmailImportResult {
  source: "v-point-pay-email";
  status: "sealed";
  centralRunId: number;
  artifactCount: 2;
  sealed: true;
  allObjectsReused: boolean;
}

export interface VPointPayEmailBackfillResult {
  source: "v-point-pay-email";
  scannedObjectCount: 0 | 1;
  importedPairCount: 0 | 1;
  skippedObjectCount: 0 | 1;
  failedPairCount: 0 | 1;
  nextCursor: string | null;
  truncated: boolean;
  failureCode?: string;
  result?: VPointPayEmailImportResult;
}

export async function importStoredVPointPayEmail(
  importer: Fetcher,
  normalizedKey: string,
): Promise<VPointPayEmailImportResult> {
  const value = await importerRequest(importer, "/v1/v-point-pay-email/import-run", {
    normalizedKey,
  });
  return validateImportResult(value);
}

export async function backfillStoredVPointPayEmails(
  importer: Fetcher,
  cursor?: string,
): Promise<VPointPayEmailBackfillResult> {
  const value = await importerRequest(importer, "/v1/v-point-pay-email/backfill-page", {
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
    throw new Error("vpoint_pay_email_importer_invalid_response");
  }
  if (!response.ok) throw new Error("vpoint_pay_email_importer_request_failed");
  return parsed;
}

function validateImportResult(value: unknown): VPointPayEmailImportResult {
  const input = exactRecord(value, [
    "source",
    "status",
    "centralRunId",
    "artifactCount",
    "sealed",
    "allObjectsReused",
  ]);
  if (
    input.source !== "v-point-pay-email" ||
    input.status !== "sealed" ||
    !positiveInteger(input.centralRunId) ||
    input.artifactCount !== 2 ||
    input.sealed !== true ||
    typeof input.allObjectsReused !== "boolean"
  ) {
    throw new Error("vpoint_pay_email_importer_invalid_response");
  }
  return {
    source: "v-point-pay-email",
    status: "sealed",
    centralRunId: input.centralRunId,
    artifactCount: 2,
    sealed: true,
    allObjectsReused: input.allObjectsReused,
  };
}

function validateBackfillResult(value: unknown): VPointPayEmailBackfillResult {
  const input = exactRecord(
    value,
    [
      "source",
      "scannedObjectCount",
      "importedPairCount",
      "skippedObjectCount",
      "failedPairCount",
      "nextCursor",
      "truncated",
      "failureCode",
      "result",
    ],
    ["failureCode", "result"],
  );
  if (
    input.source !== "v-point-pay-email" ||
    !zeroOrOne(input.scannedObjectCount) ||
    !zeroOrOne(input.importedPairCount) ||
    !zeroOrOne(input.skippedObjectCount) ||
    !zeroOrOne(input.failedPairCount) ||
    !(input.nextCursor === null || safeOpaque(input.nextCursor)) ||
    typeof input.truncated !== "boolean" ||
    !(input.failureCode === undefined || safeCode(input.failureCode))
  ) {
    throw new Error("vpoint_pay_email_importer_invalid_response");
  }
  const result = input.result === undefined ? undefined : validateImportResult(input.result);
  const outcomes = input.importedPairCount + input.skippedObjectCount + input.failedPairCount;
  if (
    outcomes !== input.scannedObjectCount ||
    (input.importedPairCount === 1) !== (result !== undefined) ||
    (input.failedPairCount === 1) !== (input.failureCode !== undefined) ||
    input.truncated !== (input.nextCursor !== null)
  ) {
    throw new Error("vpoint_pay_email_importer_invalid_response");
  }
  return {
    source: "v-point-pay-email",
    scannedObjectCount: input.scannedObjectCount,
    importedPairCount: input.importedPairCount,
    skippedObjectCount: input.skippedObjectCount,
    failedPairCount: input.failedPairCount,
    nextCursor: input.nextCursor,
    truncated: input.truncated,
    ...(input.failureCode === undefined ? {} : { failureCode: input.failureCode }),
    ...(result === undefined ? {} : { result }),
  };
}

function exactRecord(
  value: unknown,
  allowed: string[],
  optional: string[] = [],
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("vpoint_pay_email_importer_invalid_response");
  const keys = Object.keys(value);
  if (
    keys.some((key) => !allowed.includes(key)) ||
    allowed.some((key) => !optional.includes(key) && !Object.hasOwn(value, key))
  )
    throw new Error("vpoint_pay_email_importer_invalid_response");
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
    value.length <= 4_096 &&
    !/[\x00-\x20\x7f]/u.test(value)
  );
}

function safeCode(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9_-]{1,100}$/u.test(value);
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
      throw new Error("vpoint_pay_email_importer_response_too_large");
    }
    output += decoder.decode(value, { stream: true });
  }
  return output + decoder.decode();
}
