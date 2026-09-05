import { decode, encode } from "iconv-lite";
import { CentralClient } from "./central";
import { ImportError } from "./error";
import type { CentralInventoryItem } from "./types";

const SOURCE = "mobile-suica" as const;
const PRODUCER = "collector-r2-importer";
const V1 = "mobile-suica-worker-poc-v1" as const;
const V2 = "mobile-suica-worker-poc-v2" as const;
const INGEST_CONTRACT_VERSION = "mobile-suica-r2-v1";
const CENTRAL_CLIENT_ID = "collector-r2-mobile-suica";
const STORAGE_CONTAINER = "kogane-mobile-suica-collector-poc";
const STORAGE_TEMPLATE = "raw/mobile-suica/{date}/{run-id}/{artifact}";
const FINGERPRINT_VERSION = "collector-r2-v1";
const REDACTION_SENTINEL = "__KOGANE_REDACTED_BASE_VARIABLE__";
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
const MANIFEST_KEY = /^raw\/mobile-suica\/(\d{4})\/(\d{2})\/(\d{2})\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/manifest\.json$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_CODE = /^[a-z][a-z0-9_]{0,99}$/u;
const SAFE_ERROR_TYPE = /^[A-Za-z][A-Za-z0-9]{0,79}$/u;

type JsonObject = Record<string, unknown>;
type SchemaVersion = typeof V1 | typeof V2;
type Status = "success" | "partial" | "failed";
type Dataset = "sf-history-html" | "sf-history" | "collection-summary";

interface ArtifactManifest {
  dataset: Dataset;
  key: string;
  mediaType: string;
  sha256: string;
  bytes: number;
}

interface Failure {
  operation: "collect" | "pagination" | "r2";
  errorType: string;
  errorCode: string;
  artifactKey?: string;
  legacyMessage?: string;
}

interface Manifest {
  schemaVersion: SchemaVersion;
  source: typeof SOURCE;
  runId: string;
  startedAt: string;
  completedAt: string;
  status: Status;
  asOfDateJst: string;
  capturedSessionAt?: string;
  transactionCount: number;
  pageCount: number;
  complete: boolean;
  artifacts: ArtifactManifest[];
  failures: Failure[];
}

interface HistoryRow {
  date: string;
  typeFrom: string;
  placeFrom: string;
  typeTo: string;
  placeTo: string;
  balanceText: string;
  amountText: string;
  balance: number | null;
  amount: number | null;
  kind: "rail" | "bus" | "payment" | "charge" | "carryover" | "other";
}

interface VerifiedArtifact {
  manifest: ArtifactManifest;
  centralBytes: Uint8Array;
  centralSha256: string;
  semantic?: JsonObject | HistoryRow[];
}

export interface ImportMobileSuicaResult {
  source: typeof SOURCE;
  manifestKey: string;
  status: "sealed";
  centralRunId: number;
  artifactCount: number;
  sealed: true;
  finalChunkAllObjectsReused: boolean;
}

export async function importMobileSuicaRun(options: {
  bucket: R2Bucket;
  centralService: Fetcher;
  centralToken: string;
  fingerprintKey: string;
  importerVersion: string;
  manifestKey: string;
}): Promise<ImportMobileSuicaResult> {
  const startedAtMs = Date.now();
  const attemptId = `attempt-${crypto.randomUUID()}`;
  let centralRunId: number | undefined;
  let acceptedArtifactCount = 0;
  let reusedArtifactCount = 0;
  let expectedArtifactCount = 0;
  let phase = "manifest_validation";

  try {
    const loaded = await readManifest(options.bucket, options.manifestKey);
    const manifest = loaded.manifest;
    const prefix = options.manifestKey.slice(0, -"manifest.json".length);
    expectedArtifactCount = manifest.artifacts.length + 1;

    phase = "prefix_validation";
    await assertExactPrefix(options.bucket, prefix, [
      ...manifest.artifacts.map((artifact) => artifact.key),
      options.manifestKey,
    ]);

    phase = "artifact_validation";
    const verified: VerifiedArtifact[] = [];
    for (const artifact of manifest.artifacts) {
      const sourceBytes = await readVerifiedArtifact(options.bucket, artifact, manifest);
      const centralBytes = artifact.dataset === "sf-history-html"
        ? sanitizeHistoryHtml(sourceBytes, manifest.schemaVersion)
        : sourceBytes;
      const entry: VerifiedArtifact = {
        manifest: artifact,
        centralBytes,
        centralSha256: await sha256Hex(centralBytes),
      };
      if (artifact.dataset === "sf-history-html") {
        entry.semantic = parseHistoryRows(decode(centralBytes, "shift_jis"), manifest.asOfDateJst);
      } else {
        entry.semantic = parseJson(centralBytes, "artifact_json_invalid");
      }
      verified.push(entry);
    }
    validateSemantics(manifest, verified);
    await assertExactPrefix(options.bucket, prefix, [
      ...manifest.artifacts.map((artifact) => artifact.key),
      options.manifestKey,
    ]);

    const centralManifestBytes = manifest.schemaVersion === V1
      ? sanitizeLegacyManifest(manifest)
      : loaded.bytes;
    const centralManifestSha256 = await sha256Hex(centralManifestBytes);

    phase = "central_create";
    const central = new CentralClient(options.centralService, options.centralToken, CENTRAL_CLIENT_ID);
    centralRunId = await central.createRun({
      producerId: PRODUCER,
      sourceId: SOURCE,
      externalIdNamespace: manifest.schemaVersion,
      externalSessionId: manifest.runId,
      sourceRunKey: `sf-history-${INGEST_CONTRACT_VERSION}`,
    });
    await central.addRunRange(centralRunId, {
      rangeKey: "as-of-selector",
      rangeKind: "selector",
      precision: "date",
      startValue: manifest.asOfDateJst,
      endValue: manifest.asOfDateJst,
      startInclusive: 1,
      endInclusive: 1,
      basis: "request",
    });
    const unitId = await central.addUnit(centralRunId, {
      unitKind: "collection",
      unitKey: "account",
      terminalReportRequired: true,
    });
    const pageGroupId = manifest.pageCount === 1 &&
        verified.some((entry) => entry.manifest.dataset === "sf-history-html")
      ? await central.addPageGroup(centralRunId, {
          pageGroupKey: "sf-history",
          declaredPageCount: 1,
        })
      : undefined;

    const inventory: CentralInventoryItem[] = [];
    const htmlAvailable = verified.some((entry) => entry.manifest.dataset === "sf-history-html");
    for (const [sequence, entry] of verified.entries()) {
      phase = "object_upload";
      const sourceBytes = await readVerifiedArtifact(options.bucket, entry.manifest, manifest);
      const centralBytes = entry.manifest.dataset === "sf-history-html"
        ? sanitizeHistoryHtml(sourceBytes, manifest.schemaVersion)
        : sourceBytes;
      if (centralBytes.byteLength !== entry.centralBytes.byteLength ||
          await sha256Hex(centralBytes) !== entry.centralSha256) {
        throw new ImportError(409, "artifact_changed_during_import");
      }
      const reused = await central.uploadObject(centralRunId, entry.centralSha256, centralBytes);
      if (reused) reusedArtifactCount += 1;
      else acceptedArtifactCount += 1;

      phase = "artifact_catalogue";
      const descriptorSha256 = await central.addArtifact(
        centralRunId,
        await dataDescriptor({
          entry,
          sequence,
          unitId,
          ...(pageGroupId === undefined ? {} : { pageGroupId }),
          htmlAvailable,
          manifest,
          fingerprintKey: options.fingerprintKey,
        }),
      );
      inventory.push({
        artifactKey: filename(entry.manifest.key),
        sha256: entry.centralSha256,
        descriptorSha256,
      });
    }

    phase = "manifest_upload";
    const manifestReused = await central.uploadObject(
      centralRunId,
      centralManifestSha256,
      centralManifestBytes,
    );
    if (manifestReused) reusedArtifactCount += 1;
    else acceptedArtifactCount += 1;
    const manifestDescriptorSha256 = await central.addArtifact(
      centralRunId,
      await manifestDescriptor({
        manifest,
        bytes: centralManifestBytes.byteLength,
        sha256: centralManifestSha256,
        sequence: verified.length,
        key: options.manifestKey,
        fingerprintKey: options.fingerprintKey,
      }),
    );
    inventory.push({
      artifactKey: "manifest.json",
      sha256: centralManifestSha256,
      descriptorSha256: manifestDescriptorSha256,
    });

    phase = "terminal_reports";
    await central.addUnitReport(unitId, {
      reportKey: "terminal",
      reportKind: "terminal",
      producerStatus: manifest.status,
      normalizedOutcome: manifest.status,
      startedAtMs: Date.parse(manifest.startedAt),
      startedAtBasis: "manifest",
      completedAtMs: Date.parse(manifest.completedAt),
      completedAtBasis: "manifest",
      declaredArtifactCount: verified.length,
      artifactCountScope: "direct",
      ...(manifest.failures.length > 0 ? { safeFailureCode: safeFailureCode(manifest.failures) } : {}),
    });
    await central.addRunReport(centralRunId, {
      reportKey: "terminal",
      reportKind: "terminal",
      producerVersion: options.importerVersion,
      manifestSchemaVersion: manifest.schemaVersion,
      producerStatus: manifest.status,
      normalizedOutcome: manifest.status,
      startedAtMs: Date.parse(manifest.startedAt),
      startedAtBasis: "manifest",
      completedAtMs: Date.parse(manifest.completedAt),
      completedAtBasis: "manifest",
      declaredArtifactCount: inventory.length,
      artifactCountScope: "all_catalogued",
    });
    phase = "seal";
    await central.seal(centralRunId, inventory, attemptId, startedAtMs);
    return {
      source: SOURCE,
      manifestKey: options.manifestKey,
      status: "sealed",
      centralRunId,
      artifactCount: inventory.length,
      sealed: true,
      finalChunkAllObjectsReused: acceptedArtifactCount === 0,
    };
  } catch (error) {
    if (centralRunId !== undefined) {
      try {
        const central = new CentralClient(options.centralService, options.centralToken, CENTRAL_CLIENT_ID);
        const transferred = acceptedArtifactCount + reusedArtifactCount;
        await central.recordAttempt(centralRunId, {
          externalAttemptId: attemptId,
          outcome: transferred > 0 ? "incomplete" : "failed",
          startedAtMs,
          completedAtMs: Date.now(),
          expectedArtifactCount,
          observedArtifactCount: transferred,
          acceptedArtifactCount,
          reusedArtifactCount,
          rejectedArtifactCount: Math.max(expectedArtifactCount - transferred, 0),
          errorCode: `${phase}_failed`,
          ingestClientVersion: options.importerVersion,
        });
      } catch {
        // Best effort only; never replace the original failure.
      }
    }
    throw error;
  }
}

export function parseMobileSuicaManifest(bytes: Uint8Array, manifestKey: string): Manifest {
  const match = MANIFEST_KEY.exec(manifestKey);
  if (!match) invalid("manifest_key_invalid");
  const input = parseJson(bytes, "manifest_json_invalid");
  const version = oneOf(input.schemaVersion, [V1, V2] as const, "manifest_schema_invalid");
  const v2 = version === V2;
  exactShape(input, [
    "schemaVersion", "source", "runId", "startedAt", "completedAt", "status",
    "asOfDateJst", "capturedSessionAt", "transactionCount", "pageCount",
    ...(v2 ? ["complete"] : []), "artifacts", "failures",
  ]);
  if (input.source !== SOURCE || input.runId !== match[4]) invalid("manifest_identity_mismatch");
  const startedAt = instant(input.startedAt, "manifest_started_at_invalid");
  const completedAt = instant(input.completedAt, "manifest_completed_at_invalid");
  if (completedAt < startedAt || startedAt.slice(0, 10) !== `${match[1]}-${match[2]}-${match[3]}`) {
    invalid("manifest_time_invalid");
  }
  const capturedSessionAt = input.capturedSessionAt === undefined
    ? undefined
    : instant(input.capturedSessionAt, "manifest_captured_at_invalid");
  if (capturedSessionAt && capturedSessionAt > completedAt) {
    invalid("manifest_captured_at_invalid");
  }
  const status = oneOf(input.status, ["success", "partial", "failed"] as const, "manifest_status_invalid");
  const asOfDateJst = date(input.asOfDateJst, "manifest_as_of_invalid");
  const transactionCount = count(input.transactionCount, 100, "manifest_count_invalid");
  const pageCount = count(input.pageCount, 1, "manifest_page_count_invalid");
  if (!Array.isArray(input.artifacts) || input.artifacts.length > 3) invalid("manifest_artifacts_invalid");
  if (!Array.isArray(input.failures) || input.failures.length > 4) invalid("manifest_failures_invalid");
  const prefix = manifestKey.slice(0, -"manifest.json".length);
  const artifacts = input.artifacts.map((value) => parseArtifact(value, prefix));
  const failures = input.failures.map((value) => v2 ? parseV2Failure(value) : parseV1Failure(value));
  const complete = v2
    ? boolean(input.complete, "manifest_complete_invalid")
    : pageCount === 1 && transactionCount < 100 && failures.every((failure) => failure.operation !== "collect");
  validateManifestContract({ version, status, complete, pageCount, transactionCount, artifacts, failures });
  return {
    schemaVersion: version,
    source: SOURCE,
    runId: input.runId as string,
    startedAt,
    completedAt,
    status,
    asOfDateJst,
    ...(capturedSessionAt ? { capturedSessionAt } : {}),
    transactionCount,
    pageCount,
    complete,
    artifacts,
    failures,
  };
}

export function sanitizeHistoryHtml(bytes: Uint8Array, version: SchemaVersion): Uint8Array {
  const html = decode(bytes, "shift_jis");
  const inputs = [...html.matchAll(/<input\b[^>]*>/giu)].filter((match) =>
    attributeMatches(match[0], "name").some((attribute) => attributeValue(attribute).toLowerCase() === "basevariable")
  );
  if (inputs.length !== 1) {
    invalid("html_base_variable_invalid");
  }
  const tag = inputs[0]![0];
  const nameMatches = attributeMatches(tag, "name");
  const typeMatches = attributeMatches(tag, "type");
  const valueMatches = attributeMatches(tag, "value");
  if (nameMatches.length !== 1 || attributeValue(nameMatches[0]!).toLowerCase() !== "basevariable" ||
      typeMatches.length !== 1 || attributeValue(typeMatches[0]!).toLowerCase() !== "hidden" ||
      valueMatches.length !== 1 || attributeValue(valueMatches[0]!).length === 0) {
    invalid("html_base_variable_invalid");
  }
  const valueMatch = valueMatches[0]!;
  const originalValue = attributeValue(valueMatch);
  if (version === V2) {
    if (originalValue !== REDACTION_SENTINEL) invalid("html_base_variable_not_redacted");
    const roundTrip = new Uint8Array(encode(html, "shift_jis"));
    if (roundTrip.byteLength !== bytes.byteLength || roundTrip.some((value, index) => value !== bytes[index])) {
      invalid("html_cp932_round_trip_failed");
    }
    return bytes;
  }
  if (originalValue === REDACTION_SENTINEL) invalid("legacy_html_unexpected_redaction");
  const tagStart = inputs[0]!.index!;
  const valueStart = tagStart + valueMatch.index! + valueMatch[0].indexOf(originalValue);
  const sanitized = `${html.slice(0, valueStart)}${REDACTION_SENTINEL}${html.slice(valueStart + originalValue.length)}`;
  if (sanitized.includes(originalValue)) invalid("html_base_variable_redaction_incomplete");
  const result = new Uint8Array(encode(sanitized, "shift_jis"));
  if (decode(result, "shift_jis") !== sanitized) invalid("html_cp932_round_trip_failed");
  return result;
}

function parseArtifact(value: unknown, prefix: string): ArtifactManifest {
  const input = record(value, "manifest_artifact_invalid");
  exactShape(input, ["dataset", "key", "mediaType", "sha256", "bytes"]);
  const dataset = oneOf(input.dataset, [
    "sf-history-html", "sf-history", "collection-summary",
  ] as const, "manifest_dataset_invalid");
  const expectedFilename: Record<Dataset, string> = {
    "sf-history-html": "sf-history-page-0001.html",
    "sf-history": "sf-history.json",
    "collection-summary": "collection-summary.json",
  };
  if (input.key !== `${prefix}${expectedFilename[dataset]}`) invalid("manifest_artifact_key_mismatch");
  const expectedMedia = dataset === "sf-history-html"
    ? "text/html; charset=shift_jis"
    : "application/json";
  if (input.mediaType !== expectedMedia) invalid("manifest_media_type_invalid");
  if (typeof input.sha256 !== "string" || !SHA256.test(input.sha256)) invalid("manifest_sha256_invalid");
  const bytes = count(input.bytes, MAX_ARTIFACT_BYTES, "manifest_bytes_invalid", 1);
  return { dataset, key: input.key as string, mediaType: expectedMedia, sha256: input.sha256, bytes };
}

function parseV1Failure(value: unknown): Failure {
  const input = record(value, "manifest_failure_invalid");
  exactShape(input, ["operation", "errorType", "message"]);
  if (typeof input.operation !== "string" ||
      !(input.operation === "collect" || input.operation.startsWith("r2:"))) {
    invalid("manifest_failure_operation_invalid");
  }
  if (typeof input.errorType !== "string" || !SAFE_ERROR_TYPE.test(input.errorType)) {
    invalid("manifest_failure_type_invalid");
  }
  if (typeof input.message !== "string" || input.message.length < 1 || input.message.length > 300) {
    invalid("manifest_failure_message_invalid");
  }
  if (input.operation === "collect") {
    return { operation: "collect", errorType: input.errorType, errorCode: "collection_failed", legacyMessage: input.message };
  }
  const dataset = input.operation.slice(3);
  const artifactKey: Record<string, string> = {
    "sf-history-html": "sf-history-page-0001.html",
    "sf-history": "sf-history.json",
    "collection-summary": "collection-summary.json",
  };
  if (!artifactKey[dataset]) invalid("manifest_failure_operation_invalid");
  return {
    operation: "r2",
    errorType: input.errorType,
    errorCode: "artifact_store_failed",
    artifactKey: artifactKey[dataset],
    legacyMessage: input.message,
  };
}

function parseV2Failure(value: unknown): Failure {
  const input = record(value, "manifest_failure_invalid");
  exactShape(input, ["operation", "errorType", "errorCode", "artifactKey"]);
  const operation = oneOf(input.operation, ["collect", "pagination", "r2"] as const, "manifest_failure_operation_invalid");
  if (typeof input.errorType !== "string" || !SAFE_ERROR_TYPE.test(input.errorType)) invalid("manifest_failure_type_invalid");
  if (typeof input.errorCode !== "string" || !SAFE_CODE.test(input.errorCode)) invalid("manifest_failure_code_invalid");
  const artifactKey = input.artifactKey;
  if (operation === "pagination" && input.errorCode !== "history_boundary_unproven") {
    invalid("manifest_failure_code_invalid");
  }
  if (operation === "collect" && input.errorCode !== "collection_failed") {
    invalid("manifest_failure_code_invalid");
  }
  if (operation === "r2") {
    if (input.errorCode !== "artifact_store_failed" || typeof artifactKey !== "string" ||
        !expectedArtifactKeys(1).includes(artifactKey)) invalid("manifest_failure_artifact_invalid");
  } else if (artifactKey !== undefined) {
    invalid("manifest_failure_artifact_invalid");
  }
  return {
    operation,
    errorType: input.errorType,
    errorCode: input.errorCode,
    ...(typeof artifactKey === "string" ? { artifactKey } : {}),
  };
}

function validateManifestContract(input: {
  version: SchemaVersion;
  status: Status;
  complete: boolean;
  pageCount: number;
  transactionCount: number;
  artifacts: ArtifactManifest[];
  failures: Failure[];
}): void {
  const keys = input.artifacts.map((artifact) => filename(artifact.key));
  if (new Set(keys).size !== keys.length || new Set(input.artifacts.map((artifact) => artifact.dataset)).size !== input.artifacts.length) {
    invalid("manifest_duplicate_artifact");
  }
  const expected = expectedArtifactKeys(input.pageCount);
  if (keys.some((key, index) => key !== expected.filter((candidate) => keys.includes(candidate))[index])) {
    invalid("manifest_artifact_order_invalid");
  }
  const missing = expected.filter((key) => !keys.includes(key));
  const failedKeys = input.failures.filter((failure) => failure.operation === "r2").map((failure) => failure.artifactKey!);
  if (new Set(failedKeys).size !== failedKeys.length || !sameStrings(missing, failedKeys)) {
    invalid("manifest_failure_complement_mismatch");
  }
  const collect = input.failures.filter((failure) => failure.operation === "collect");
  const boundary = input.failures.filter((failure) => failure.operation === "pagination");
  if (collect.length > 1 || boundary.length > 1) invalid("manifest_duplicate_failure");
  const expectedStatus: Status = input.failures.length === 0
    ? "success"
    : input.artifacts.length === 0 ? "failed" : "partial";
  if (input.status !== expectedStatus) invalid("manifest_status_mismatch");
  if (input.pageCount === 0) {
    if (input.transactionCount !== 0 || input.complete || input.status !== "failed" || keys.length !== 0 || collect.length !== 1) {
      invalid("manifest_terminal_state_invalid");
    }
    return;
  }
  if (collect.length !== 0) invalid("manifest_terminal_state_invalid");
  if (input.transactionCount === 100) {
    if (input.version !== V2 || input.complete || boundary.length !== 1) {
      invalid("history_boundary_unproven");
    }
  } else if (!input.complete || boundary.length !== 0) {
    invalid("manifest_complete_invalid");
  }
}

function validateSemantics(manifest: Manifest, verified: VerifiedArtifact[]): void {
  const html = verified.find((entry) => entry.manifest.dataset === "sf-history-html");
  const normalized = verified.find((entry) => entry.manifest.dataset === "sf-history");
  const summary = verified.find((entry) => entry.manifest.dataset === "collection-summary");
  const htmlRows = html?.semantic as HistoryRow[] | undefined;
  const normalizedValue = normalized ? parseNormalized(normalized.semantic, manifest.schemaVersion) : undefined;
  const summaryValue = summary ? parseSummary(summary.semantic, manifest.schemaVersion) : undefined;
  if (htmlRows && htmlRows.length !== manifest.transactionCount) invalid("html_transaction_count_mismatch");
  if (normalizedValue && htmlRows && !sameJson(normalizedValue.rows, htmlRows)) invalid("normalized_payload_mismatch");
  for (const value of [normalizedValue, summaryValue]) {
    if (!value) continue;
    if (value.asOfDateJst !== manifest.asOfDateJst || value.pageCount !== manifest.pageCount ||
        value.transactionCount !== manifest.transactionCount || value.complete !== manifest.complete) {
      invalid("artifact_summary_mismatch");
    }
  }
  if (summaryValue && summaryValue.capturedSessionAt !== manifest.capturedSessionAt) {
    invalid("artifact_captured_at_mismatch");
  }
}

function parseNormalized(value: unknown, version: SchemaVersion): {
  asOfDateJst: string; pageCount: number; transactionCount: number; complete: boolean; rows: HistoryRow[];
} {
  const input = record(value, "normalized_invalid");
  exactShape(input, ["asOfDateJst", "pageCount", "transactionCount", ...(version === V2 ? ["complete"] : []), "rows"]);
  if (!Array.isArray(input.rows) || input.rows.length > 100) invalid("normalized_rows_invalid");
  const rows = input.rows.map(parseHistoryRow);
  const asOfDateJst = date(input.asOfDateJst, "normalized_as_of_invalid");
  let previousDate = asOfDateJst;
  for (const row of rows) {
    if (row.date > previousDate) invalid("normalized_row_order_invalid");
    previousDate = row.date;
  }
  const transactionCount = count(input.transactionCount, 100, "normalized_count_invalid");
  if (transactionCount !== rows.length) invalid("normalized_transaction_count_mismatch");
  return {
    asOfDateJst,
    pageCount: count(input.pageCount, 1, "normalized_count_invalid"),
    transactionCount,
    complete: version === V2 ? boolean(input.complete, "normalized_complete_invalid") : true,
    rows,
  };
}

function parseSummary(value: unknown, version: SchemaVersion): {
  asOfDateJst: string; pageCount: number; transactionCount: number; complete: boolean; capturedSessionAt?: string;
} {
  const input = record(value, "summary_invalid");
  exactShape(input, [
    "asOfDateJst", "pageCount", "transactionCount", ...(version === V2 ? ["complete"] : []),
    "cookieNames", "capturedSessionAt",
  ]);
  if (!Array.isArray(input.cookieNames) || input.cookieNames.length > 20 ||
      input.cookieNames.some((name) => typeof name !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/u.test(name)) ||
      !sameStrings(input.cookieNames as string[], [...(input.cookieNames as string[])].sort()) ||
      new Set(input.cookieNames as string[]).size !== input.cookieNames.length) invalid("summary_cookie_names_invalid");
  const capturedSessionAt = input.capturedSessionAt === undefined
    ? undefined
    : instant(input.capturedSessionAt, "summary_captured_at_invalid");
  return {
    asOfDateJst: date(input.asOfDateJst, "summary_as_of_invalid"),
    pageCount: count(input.pageCount, 1, "summary_count_invalid"),
    transactionCount: count(input.transactionCount, 100, "summary_count_invalid"),
    complete: version === V2 ? boolean(input.complete, "summary_complete_invalid") : true,
    ...(capturedSessionAt ? { capturedSessionAt } : {}),
  };
}

function parseHistoryRow(value: unknown): HistoryRow {
  const input = record(value, "history_row_invalid");
  exactShape(input, [
    "date", "typeFrom", "placeFrom", "typeTo", "placeTo", "balanceText",
    "amountText", "balance", "amount", "kind",
  ]);
  const row: HistoryRow = {
    date: date(input.date, "history_row_date_invalid"),
    typeFrom: text(input.typeFrom),
    placeFrom: text(input.placeFrom),
    typeTo: text(input.typeTo),
    placeTo: text(input.placeTo),
    balanceText: text(input.balanceText),
    amountText: text(input.amountText),
    balance: nullableInteger(input.balance),
    amount: nullableInteger(input.amount),
    kind: oneOf(input.kind, ["rail", "bus", "payment", "charge", "carryover", "other"] as const, "history_row_kind_invalid"),
  };
  if (row.balance !== parseAmount(row.balanceText) || row.amount !== parseAmount(row.amountText) ||
      row.kind !== classify(row.typeFrom, row.placeFrom, row.typeTo)) invalid("history_row_semantic_mismatch");
  return row;
}

export function parseHistoryRows(html: string, cursorDate: string): HistoryRow[] {
  if (!/name=["']baseVariable["']/iu.test(html) || !/name=["']specifyYearMonth["']/iu.test(html)) {
    invalid("html_history_page_invalid");
  }
  const rows: HistoryRow[] = [];
  let inferredYear = Number(cursorDate.slice(0, 4));
  let previousTime = Date.parse(`${cursorDate}T23:59:59+09:00`);
  for (const cells of tableRows(html)) {
    if (cells.length < 8 || !/^\d{1,2}\/\d{1,2}$/u.test(cells[1] ?? "")) continue;
    const [monthText, dayText] = (cells[1] ?? "").split("/");
    const month = Number(monthText);
    const day = Number(dayText);
    let value = `${inferredYear}-${pad(month)}-${pad(day)}`;
    let time = Date.parse(`${value}T00:00:00+09:00`);
    while (Number.isFinite(time) && time > previousTime) {
      inferredYear -= 1;
      value = `${inferredYear}-${pad(month)}-${pad(day)}`;
      time = Date.parse(`${value}T00:00:00+09:00`);
    }
    if (!Number.isFinite(time) || new Date(time + 9 * 3_600_000).toISOString().slice(0, 10) !== value || time > previousTime) {
      invalid("html_history_date_invalid");
    }
    previousTime = time;
    const typeFrom = cells[2] ?? "";
    const placeFrom = cells[3] ?? "";
    const typeTo = cells[4] ?? "";
    const balanceText = cells[6] ?? "";
    const amountText = cells[7] ?? "";
    rows.push({
      date: value,
      typeFrom,
      placeFrom,
      typeTo,
      placeTo: cells[5] ?? "",
      balanceText,
      amountText,
      balance: parseAmount(balanceText),
      amount: parseAmount(amountText),
      kind: classify(typeFrom, placeFrom, typeTo),
    });
  }
  if (rows.length > 100) invalid("html_history_count_invalid");
  return rows;
}

async function dataDescriptor(options: {
  entry: VerifiedArtifact;
  sequence: number;
  unitId: number;
  pageGroupId?: number;
  htmlAvailable: boolean;
  manifest: Manifest;
  fingerprintKey: string;
}): Promise<JsonObject> {
  const dataset = options.entry.manifest.dataset;
  const html = dataset === "sf-history-html";
  const normalized = dataset === "sf-history";
  const summary = dataset === "collection-summary";
  return {
    artifactKey: filename(options.entry.manifest.key),
    artifactRole: html ? "sanitized_provider_capture" : normalized ? "collector_derived" : "collector_summary",
    payloadFidelity: html || normalized ? "transformed" : "generated",
    containerKind: "single",
    lineageDisposition: html
      ? "source_not_retained_for_security"
      : normalized ? options.htmlAvailable ? "linked" : "source_not_retained_for_security" : "not_applicable",
    dataset,
    formatId: html
      ? "mobile-suica-sf-history-html-cp932-sanitized"
      : normalized ? "mobile-suica-sf-history-json" : "mobile-suica-collection-summary-json",
    formatVersion: options.manifest.schemaVersion,
    declaredMediaType: html ? "text/html" : options.entry.manifest.mediaType,
    mediaTypeBasis: "manifest",
    fetchedAtMs: Date.parse(options.manifest.completedAt),
    fetchedAtBasis: "manifest",
    fetchUnitId: options.unitId,
    ...(html && options.pageGroupId !== undefined ? { pageGroupId: options.pageGroupId, pageIndex: 0 } : {}),
    sequence: options.sequence,
    sha256: options.entry.centralSha256,
    byteSize: options.entry.centralBytes.byteLength,
    storage: await storageOrigin(options.entry.manifest.key, options.fingerprintKey),
    transformSteps: html ? [
      transform(0, "transport_decoded", "mobile-suica-history-sanitizer", "v1"),
      transform(1, "redacted", "mobile-suica-history-sanitizer", "v1"),
      transform(2, "reencoded", "mobile-suica-history-sanitizer", "v1"),
    ] : normalized ? [
      transform(0, "transport_decoded", "mobile-suica-history-normalizer", "v1"),
      transform(1, "extracted", "mobile-suica-history-normalizer", "v1"),
      transform(2, "reencoded", "mobile-suica-history-normalizer", "v1"),
    ] : [],
    ...(normalized && options.htmlAvailable ? {
      relations: [{
        parentArtifactKey: "sf-history-page-0001.html",
        relation: "input",
        transformerId: "mobile-suica-history-normalizer",
        transformerVersion: "v1",
      }],
    } : {}),
  };
}

async function manifestDescriptor(options: {
  manifest: Manifest; bytes: number; sha256: string; sequence: number; key: string; fingerprintKey: string;
}): Promise<JsonObject> {
  const legacy = options.manifest.schemaVersion === V1;
  return {
    artifactKey: "manifest.json",
    artifactRole: legacy ? "collector_derived" : "collector_manifest",
    payloadFidelity: legacy ? "transformed" : "generated",
    containerKind: "single",
    lineageDisposition: legacy ? "source_not_retained_for_security" : "not_applicable",
    dataset: "collector-manifest",
    formatId: "mobile-suica-collector-manifest-json",
    formatVersion: options.manifest.schemaVersion,
    declaredMediaType: "application/json",
    mediaTypeBasis: "operator",
    fetchedAtMs: Date.parse(options.manifest.completedAt),
    fetchedAtBasis: "manifest",
    sequence: options.sequence,
    sha256: options.sha256,
    byteSize: options.bytes,
    storage: await storageOrigin(options.key, options.fingerprintKey),
    transformSteps: legacy ? [
      transform(0, "transport_decoded", "mobile-suica-manifest-sanitizer", "v1"),
      transform(1, "redacted", "mobile-suica-manifest-sanitizer", "v1"),
      transform(2, "reencoded", "mobile-suica-manifest-sanitizer", "v1"),
    ] : [],
  };
}

function sanitizeLegacyManifest(manifest: Manifest): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    source: manifest.source,
    runId: manifest.runId,
    startedAt: manifest.startedAt,
    completedAt: manifest.completedAt,
    status: manifest.status,
    asOfDateJst: manifest.asOfDateJst,
    ...(manifest.capturedSessionAt ? { capturedSessionAt: manifest.capturedSessionAt } : {}),
    transactionCount: manifest.transactionCount,
    pageCount: manifest.pageCount,
    artifacts: manifest.artifacts,
    failures: manifest.failures.map((failure) => ({
      operation: failure.operation === "r2" ? `r2:${datasetForArtifact(failure.artifactKey!)}` : "collect",
      errorType: failure.errorType,
      message: failure.errorCode,
    })),
  }));
}

async function readManifest(bucket: R2Bucket, key: string): Promise<{ manifest: Manifest; bytes: Uint8Array }> {
  const object = await bucket.get(key);
  if (!object) throw new ImportError(404, "manifest_not_found");
  if (object.size > MAX_MANIFEST_BYTES) throw new ImportError(413, "manifest_too_large");
  if (object.httpMetadata?.contentType !== "application/json") invalid("manifest_content_type_mismatch");
  const bytes = new Uint8Array(await object.arrayBuffer());
  const sha256 = await sha256Hex(bytes);
  const manifest = parseMobileSuicaManifest(bytes, key);
  assertManifestMetadata(object.customMetadata, manifest);
  assertNativeSha256(object, sha256);
  return { manifest, bytes };
}

async function readVerifiedArtifact(bucket: R2Bucket, artifact: ArtifactManifest, manifest: Manifest): Promise<Uint8Array> {
  const object = await bucket.get(artifact.key);
  if (!object) invalid("artifact_missing");
  if (object.size !== artifact.bytes || object.size > MAX_ARTIFACT_BYTES) invalid("artifact_size_mismatch");
  if (object.httpMetadata?.contentType !== artifact.mediaType) invalid("artifact_content_type_mismatch");
  assertArtifactMetadata(object.customMetadata, artifact, manifest);
  assertNativeSha256(object, artifact.sha256);
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (await sha256Hex(bytes) !== artifact.sha256) invalid("artifact_checksum_mismatch");
  return bytes;
}

async function assertExactPrefix(bucket: R2Bucket, prefix: string, expected: string[]): Promise<void> {
  const actual: string[] = [];
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, limit: 1_000, ...(cursor ? { cursor } : {}) });
    actual.push(...listed.objects.map((object) => object.key));
    cursor = listed.truncated ? listed.cursor : undefined;
    if (listed.truncated && !cursor) invalid("prefix_cursor_missing");
    if (actual.length > 4) invalid("prefix_inventory_too_large");
  } while (cursor);
  if (!sameStrings(actual.sort(), [...expected].sort())) invalid("prefix_inventory_mismatch");
}

function assertArtifactMetadata(actual: Record<string, string> | undefined, artifact: ArtifactManifest, manifest: Manifest): void {
  const legacy = { dataset: artifact.dataset, sha256: artifact.sha256 };
  const current = { source: SOURCE, runId: manifest.runId, dataset: artifact.dataset, sha256: artifact.sha256 };
  if (manifest.schemaVersion === V1 ? !sameMetadata(actual, legacy) : !sameMetadata(actual, current)) {
    invalid("artifact_metadata_mismatch");
  }
}

function assertManifestMetadata(actual: Record<string, string> | undefined, manifest: Manifest): void {
  const legacy = { source: SOURCE, status: manifest.status, runId: manifest.runId };
  if (!sameMetadata(actual, legacy)) {
    invalid("manifest_metadata_mismatch");
  }
}

function assertNativeSha256(object: R2ObjectBody, expected: string): void {
  const checksum = object.checksums?.sha256;
  if (!checksum) return;
  if (bytesHex(new Uint8Array(checksum)) !== expected) invalid("native_sha256_mismatch");
}

async function storageOrigin(key: string, fingerprintKey: string): Promise<JsonObject> {
  if (!SHA256.test(fingerprintKey)) throw new ImportError(500, "fingerprint_configuration_invalid");
  const cryptoKey = await crypto.subtle.importKey(
    "raw", ownedArrayBuffer(hexBytes(fingerprintKey)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(key));
  return {
    storageKind: "r2",
    containerName: STORAGE_CONTAINER,
    objectKeyTemplate: STORAGE_TEMPLATE,
    objectKeyFingerprint: bytesHex(new Uint8Array(signature)),
    fingerprintKeyVersion: FINGERPRINT_VERSION,
    redactionVersion: "v1",
    objectVersion: null,
    etag: null,
    lastModifiedAtMs: null,
    lastModifiedAtBasis: null,
  };
}

function tableRows(html: string): string[][] {
  return [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu)].map((row) =>
    [...(row[1] ?? "").matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/giu)].map((cell) => textContent(cell[1] ?? "")),
  );
}

function textContent(html: string): string {
  return html.replace(/<[^>]+>/gu, " ").replace(/&(nbsp|amp|lt|gt|#\d+);/giu, (_match, entity: string) => {
    const value = entity.toLowerCase();
    if (value === "nbsp") return " ";
    if (value === "amp") return "&";
    if (value === "lt") return "<";
    if (value === "gt") return ">";
    return String.fromCodePoint(Number(value.slice(1)));
  }).replace(/\s+/gu, " ").trim();
}

function attributeMatches(tag: string, name: string): RegExpMatchArray[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return [...tag.matchAll(new RegExp(
    `\\b${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\u0060]+))`,
    "giu",
  ))];
}

function attributeValue(match: RegExpMatchArray): string {
  return match[1] ?? match[2] ?? match[3] ?? "";
}

function parseAmount(value: string): number | null {
  const normalized = value.replace(/[￥¥\\円,\s]/gu, "");
  return /^[+-]?\d+$/u.test(normalized) ? Number(normalized) : null;
}

function classify(typeFrom: string, placeFrom: string, typeTo: string): HistoryRow["kind"] {
  const from = typeFrom.normalize("NFKC");
  const place = placeFrom.normalize("NFKC");
  if ((from === "入" || from === "*入") && typeTo === "出") return "rail";
  if (from === "カード" && place === "モバイル") return "charge";
  if (from === "物販") return "payment";
  if (from === "バス等") return "bus";
  if (from === "繰") return "carryover";
  return "other";
}

function expectedArtifactKeys(pageCount: number): string[] {
  return pageCount === 1
    ? ["sf-history-page-0001.html", "sf-history.json", "collection-summary.json"]
    : [];
}

function datasetForArtifact(key: string): Dataset {
  if (key === "sf-history-page-0001.html") return "sf-history-html";
  if (key === "sf-history.json") return "sf-history";
  if (key === "collection-summary.json") return "collection-summary";
  invalid("manifest_failure_artifact_invalid");
}

function safeFailureCode(failures: Failure[]): string {
  if (failures.some((failure) => failure.operation === "pagination")) return "history-boundary-unproven";
  if (failures.some((failure) => failure.operation === "r2")) return "staging-write-incomplete";
  return "collection-failed";
}

function transform(stepIndex: number, stepKind: string, transformerId: string, transformerVersion: string): JsonObject {
  return { stepIndex, stepKind, transformerId, transformerVersion };
}

function parseJson(bytes: Uint8Array, code: string): JsonObject {
  try {
    return record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), code);
  } catch (error) {
    if (error instanceof ImportError) throw error;
    invalid(code);
  }
}

function record(value: unknown, code: string): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") invalid(code);
  return value as JsonObject;
}

function exactShape(value: JsonObject, keys: readonly string[]): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) invalid("manifest_shape_invalid");
}

function oneOf<const T extends readonly string[]>(value: unknown, allowed: T, code: string): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) invalid(code);
  return value as T[number];
}

function instant(value: unknown, code: string): string {
  if (typeof value !== "string") invalid(code);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) invalid(code);
  return value;
}

function date(value: unknown, code: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
      new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) invalid(code);
  return value;
}

function count(value: unknown, maximum: number, code: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) invalid(code);
  return value as number;
}

function boolean(value: unknown, code: string): boolean {
  if (typeof value !== "boolean") invalid(code);
  return value;
}

function nullableInteger(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value)) invalid("history_row_amount_invalid");
  return value as number;
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.length > 1_000) invalid("history_row_text_invalid");
  return value;
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as JsonObject).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameMetadata(actual: Record<string, string> | undefined, expected: Record<string, string>): boolean {
  return actual !== undefined && sameStrings(Object.keys(actual).sort(), Object.keys(expected).sort()) &&
    Object.entries(expected).every(([key, value]) => actual[key] === value);
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function filename(key: string): string {
  return key.split("/").at(-1)!;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function invalid(code: string): never {
  throw new ImportError(409, code);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return bytesHex(new Uint8Array(await crypto.subtle.digest("SHA-256", ownedArrayBuffer(bytes))));
}

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/gu) ?? [], (part) => Number.parseInt(part, 16));
}

function bytesHex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
