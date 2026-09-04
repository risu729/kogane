import { CentralClient } from "./central";
import { ImportError } from "./error";
import { validateSbiShinseiResponse } from "./sbi-shinsei-schema";
import type {
  CentralInventoryItem,
  SbiShinseiArtifactManifest,
  SbiShinseiFailure,
  SbiShinseiManifest,
} from "./types";

const EXTERNAL_SOURCE = "sbi-shinsei" as const;
const CENTRAL_SOURCE = "sbi-shinsei-bank";
const PRODUCER = "collector-r2-importer";
const SCHEMA_VERSION = "sbi-shinsei-worker-poc-v1";
const INGEST_CONTRACT_VERSION = "sbi-shinsei-r2-v1";
const CENTRAL_CLIENT_ID = "collector-r2-sbi-shinsei";
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
const STORAGE_TEMPLATE = "raw/sbi-shinsei/{date}/{run-id}/{artifact}";
const STORAGE_CONTAINER = "kogane-sbi-shinsei-collector-poc";
const FINGERPRINT_VERSION = "collector-r2-v1";
const MANIFEST_KEY = /^raw\/sbi-shinsei\/(\d{4})\/(\d{2})\/(\d{2})\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/manifest\.json$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const DATASETS = [
  "top-accounts-balance-and-activity",
  "balance-summary-and-stage",
  "exchange-rate",
  "yen-deposit-account",
  "normalized",
] as const;
const FILENAMES: Record<(typeof DATASETS)[number], string> = {
  "top-accounts-balance-and-activity": "raw-top-accounts-balance-and-activity.json",
  "balance-summary-and-stage": "raw-balance-summary-and-stage.json",
  "exchange-rate": "raw-exchange-rate.json",
  "yen-deposit-account": "raw-yen-deposit-account.json",
  normalized: "normalized.json",
};
const RAW_SCHEMAS = {
  "top-accounts-balance-and-activity": "sbi-shinsei-top-balances-v1",
  "balance-summary-and-stage": "sbi-shinsei-balance-summary-v1",
  "exchange-rate": "sbi-shinsei-exchange-rate-v1",
  "yen-deposit-account": "sbi-shinsei-yen-deposit-account-v1",
} as const;

type JsonObject = Record<string, unknown>;
type Dataset = (typeof DATASETS)[number];

interface VerifiedArtifact {
  manifest: SbiShinseiArtifactManifest;
  centralSha256: string;
  centralByteSize: number;
  semantic?: JsonObject;
}

interface NormalizedSnapshot extends JsonObject {
  schemaVersion: "sbi-shinsei-v1";
  capturedAt: string;
  balances: JsonObject[];
  transactions: JsonObject[];
}

export interface ImportSbiShinseiRunResult {
  source: typeof EXTERNAL_SOURCE;
  manifestKey: string;
  centralRunId: number;
  artifactCount: number;
  sealed: true;
  allObjectsReused: boolean;
}

export async function importSbiShinseiRun(options: {
  bucket: R2Bucket;
  centralService: Fetcher;
  centralToken: string;
  fingerprintKey: string;
  importerVersion: string;
  manifestKey: string;
}): Promise<ImportSbiShinseiRunResult> {
  const startedAtMs = Date.now();
  const attemptId = `attempt-${crypto.randomUUID()}`;
  let centralRunId: number | undefined;
  let acceptedArtifactCount = 0;
  let reusedArtifactCount = 0;
  let expectedArtifactCount = 0;
  let phase = "manifest_validation";

  try {
    const manifestObject = await options.bucket.get(options.manifestKey);
    if (!manifestObject) throw new ImportError(404, "manifest_not_found");
    if (manifestObject.size > MAX_MANIFEST_BYTES) {
      throw new ImportError(413, "manifest_too_large");
    }
    assertJsonContentType(manifestObject, "manifest_content_type_mismatch");
    const manifestBytes = new Uint8Array(await manifestObject.arrayBuffer());
    const sourceManifestSha256 = await sha256Hex(manifestBytes);
    assertNativeSha256(manifestObject, sourceManifestSha256);
    const manifest = parseSbiShinseiManifest(manifestBytes, options.manifestKey);
    assertManifestMetadata(manifestObject.customMetadata, manifest, sourceManifestSha256);
    const centralManifestBytes = sanitizeManifest(manifest);
    const centralManifestSha256 = await sha256Hex(centralManifestBytes);
    expectedArtifactCount = manifest.artifacts.length + 1;
    const prefix = options.manifestKey.slice(0, -"manifest.json".length);

    phase = "prefix_validation";
    await assertExactPrefix(options.bucket, prefix, [
      ...manifest.artifacts.map((artifact) => artifact.key),
      options.manifestKey,
    ]);

    phase = "artifact_validation";
    const verified: VerifiedArtifact[] = [];
    for (const artifact of manifest.artifacts) {
      const bytes = await readVerifiedArtifact(options.bucket, artifact, manifest.runId);
      const parsed = parseJson(bytes, "artifact_json_invalid");
      validateDatasetPayload(artifact.dataset as Dataset, parsed);
      const centralBytes = artifact.dataset === "normalized"
        ? bytes
        : sanitizeProviderResponse(parsed);
      verified.push({
        manifest: artifact,
        centralSha256: await sha256Hex(centralBytes),
        centralByteSize: centralBytes.byteLength,
        ...(
          artifact.dataset === "top-accounts-balance-and-activity" ||
          artifact.dataset === "normalized"
            ? { semantic: parsed }
            : {}
        ),
      });
    }
    validateCrossArtifactMeaning(manifest, verified);
    for (const artifact of verified) delete artifact.semantic;
    await assertExactPrefix(options.bucket, prefix, [
      ...manifest.artifacts.map((artifact) => artifact.key),
      options.manifestKey,
    ]);

    phase = "central_create";
    const central = new CentralClient(
      options.centralService,
      options.centralToken,
      CENTRAL_CLIENT_ID,
    );
    centralRunId = await central.createRun({
      producerId: PRODUCER,
      sourceId: CENTRAL_SOURCE,
      externalIdNamespace: manifest.legacyWindow
        ? `${SCHEMA_VERSION}-legacy-window`
        : SCHEMA_VERSION,
      externalSessionId: manifest.runId,
      sourceRunKey: `current-snapshot-${INGEST_CONTRACT_VERSION}`,
    });

    phase = "unit_catalogue";
    const unitId = await central.addUnit(centralRunId, {
      unitKind: "account",
      unitKey: "primary",
      terminalReportRequired: true,
    });

    const inventory: CentralInventoryItem[] = [];
    const hasRawParent = verified.some((entry) =>
      entry.manifest.dataset === "top-accounts-balance-and-activity"
    );
    for (const [sequence, item] of verified.entries()) {
      phase = "object_upload";
      const sourceBytes = await readVerifiedArtifact(
        options.bucket,
        item.manifest,
        manifest.runId,
      );
      const parsed = parseJson(sourceBytes, "artifact_json_invalid");
      validateDatasetPayload(item.manifest.dataset as Dataset, parsed);
      const centralBytes = item.manifest.dataset === "normalized"
        ? sourceBytes
        : sanitizeProviderResponse(parsed);
      if (centralBytes.byteLength !== item.centralByteSize ||
          await sha256Hex(centralBytes) !== item.centralSha256) {
        throw new ImportError(409, "artifact_changed_during_import");
      }
      const reused = await central.uploadObject(
        centralRunId,
        item.centralSha256,
        centralBytes,
      );
      if (reused) reusedArtifactCount += 1;
      else acceptedArtifactCount += 1;

      phase = "artifact_catalogue";
      const descriptorSha256 = await central.addArtifact(
        centralRunId,
        await dataDescriptor({
          artifact: item.manifest,
          centralSha256: item.centralSha256,
          centralBytes: item.centralByteSize,
          sequence,
          fetchUnitId: unitId,
          completedAt: manifest.completedAt,
          fingerprintKey: options.fingerprintKey,
          linkNormalized: item.manifest.dataset === "normalized" && hasRawParent,
        }),
      );
      inventory.push({
        artifactKey: item.manifest.key.split("/").at(-1)!,
        sha256: item.centralSha256,
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

    phase = "manifest_catalogue";
    const manifestDescriptorSha256 = await central.addArtifact(
      centralRunId,
      await manifestDescriptor({
        bytes: centralManifestBytes.byteLength,
        sha256: centralManifestSha256,
        sequence: manifest.artifacts.length,
        key: options.manifestKey,
        completedAt: manifest.completedAt,
        fingerprintKey: options.fingerprintKey,
        formatVersion: manifest.legacyWindow
          ? `${SCHEMA_VERSION}-legacy-window`
          : SCHEMA_VERSION,
      }),
    );
    inventory.push({
      artifactKey: "manifest.json",
      sha256: centralManifestSha256,
      descriptorSha256: manifestDescriptorSha256,
    });

    phase = "unit_report";
    await central.addUnitReport(unitId, {
      reportKey: "terminal",
      reportKind: "terminal",
      producerStatus: manifest.status,
      normalizedOutcome: manifest.status,
      startedAtMs: Date.parse(manifest.startedAt),
      startedAtBasis: "manifest",
      completedAtMs: Date.parse(manifest.completedAt),
      completedAtBasis: "manifest",
      declaredArtifactCount: manifest.artifacts.length,
      artifactCountScope: "direct",
      ...(manifest.failures.length > 0
        ? { safeFailureCode: safeFailureCode(manifest.failures) }
        : {}),
    });

    phase = "run_report";
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
      source: EXTERNAL_SOURCE,
      manifestKey: options.manifestKey,
      centralRunId,
      artifactCount: inventory.length,
      sealed: true,
      allObjectsReused: acceptedArtifactCount === 0,
    };
  } catch (error) {
    if (centralRunId !== undefined) {
      try {
        const central = new CentralClient(
          options.centralService,
          options.centralToken,
          CENTRAL_CLIENT_ID,
        );
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
        // Attempt reporting is best effort; preserve the original error.
      }
    }
    throw error;
  }
}

export function parseSbiShinseiManifest(
  bytes: Uint8Array,
  manifestKey: string,
): SbiShinseiManifest {
  const keyMatch = MANIFEST_KEY.exec(manifestKey);
  if (!keyMatch) invalid("manifest_key_invalid");
  const input = parseJson(bytes, "manifest_json_invalid", 400);
  const hasWindow = Object.hasOwn(input, "window");
  exactShape(input, hasWindow
    ? ["schemaVersion", "source", "runId", "startedAt", "completedAt", "status",
      "liveReadsEnabled", "artifacts", "failures", "window"]
    : ["schemaVersion", "source", "runId", "startedAt", "completedAt", "status",
      "liveReadsEnabled", "artifacts", "failures"]);
  if (input.schemaVersion !== SCHEMA_VERSION) invalid("manifest_schema_invalid");
  if (input.source !== EXTERNAL_SOURCE) invalid("manifest_source_invalid");
  if (input.runId !== keyMatch[4]) invalid("manifest_run_id_mismatch");
  const startedAt = instant(input.startedAt, "manifest_started_at_invalid");
  const completedAt = instant(input.completedAt, "manifest_completed_at_invalid");
  if (completedAt < startedAt) invalid("manifest_time_reversed");
  if (startedAt.slice(0, 10) !== `${keyMatch[1]}-${keyMatch[2]}-${keyMatch[3]}`) {
    invalid("manifest_date_mismatch");
  }
  const status = oneOf(
    input.status,
    ["success", "partial", "failed"] as const,
    "manifest_status_invalid",
  );
  if (typeof input.liveReadsEnabled !== "boolean") {
    invalid("manifest_live_reads_invalid");
  }
  if (!Array.isArray(input.artifacts) || input.artifacts.length > DATASETS.length) {
    invalid("manifest_artifacts_invalid");
  }
  if (!Array.isArray(input.failures) || input.failures.length > DATASETS.length) {
    invalid("manifest_failures_invalid");
  }
  const prefix = manifestKey.slice(0, -"manifest.json".length);
  const artifacts = input.artifacts.map((entry) => parseArtifact(entry, prefix));
  const failures = input.failures.map(parseFailure);
  if (new Set(artifacts.map((artifact) => artifact.dataset)).size !== artifacts.length) {
    invalid("manifest_duplicate_dataset");
  }
  validateCompleteness(status, artifacts, failures);
  const legacyWindow = hasWindow ? parseWindow(input.window) : undefined;
  return {
    schemaVersion: SCHEMA_VERSION,
    source: EXTERNAL_SOURCE,
    runId: input.runId as string,
    startedAt,
    completedAt,
    status,
    liveReadsEnabled: input.liveReadsEnabled,
    artifacts,
    failures,
    ...(legacyWindow ? { legacyWindow } : {}),
  };
}

function parseArtifact(value: unknown, prefix: string): SbiShinseiArtifactManifest {
  const input = record(value, "manifest_artifact_invalid");
  exactShape(input, ["dataset", "key", "mediaType", "sha256", "bytes"]);
  if (typeof input.dataset !== "string" || !isDataset(input.dataset)) {
    invalid("manifest_dataset_invalid");
  }
  const dataset = input.dataset as Dataset;
  if (input.key !== `${prefix}${FILENAMES[dataset]}`) {
    invalid("manifest_artifact_key_mismatch");
  }
  if (input.mediaType !== "application/json") {
    invalid("manifest_artifact_media_type_invalid");
  }
  if (typeof input.sha256 !== "string" || !SHA256.test(input.sha256)) {
    invalid("manifest_artifact_sha_invalid");
  }
  if (!Number.isSafeInteger(input.bytes) || (input.bytes as number) < 1 ||
      (input.bytes as number) > MAX_ARTIFACT_BYTES) {
    invalid("manifest_artifact_size_invalid");
  }
  return {
    dataset,
    key: input.key as string,
    mediaType: "application/json",
    sha256: input.sha256,
    bytes: input.bytes as number,
  };
}

function parseFailure(value: unknown): SbiShinseiFailure {
  const input = record(value, "manifest_failure_invalid");
  exactShape(input, ["operation", "errorType", "message"]);
  if (typeof input.operation !== "string" ||
      !(input.operation === "collect" ||
        input.operation === "derive:normalized" ||
        (input.operation.startsWith("r2:") && isDataset(input.operation.slice(3))) ||
        (input.operation.startsWith("read:") &&
          input.operation !== "read:normalized" &&
          isDataset(input.operation.slice(5))))) {
    invalid("manifest_failure_operation_invalid");
  }
  if (typeof input.errorType !== "string" || !/^[A-Za-z][A-Za-z0-9]{0,79}$/u.test(input.errorType)) {
    invalid("manifest_failure_type_invalid");
  }
  if (typeof input.message !== "string" || input.message.length < 1 || input.message.length > 300 ||
      /Bearer\s+(?!\[redacted\])\S+|(?:password|accountNumber|branchNumber|cookie|csrf|token)\s*=\s*(?!\[redacted\])[^\s,;]+/iu
        .test(input.message)) {
    invalid("manifest_failure_message_invalid");
  }
  return {
    operation: input.operation,
    errorType: input.errorType,
    message: input.message,
  };
}

function validateCompleteness(
  status: SbiShinseiManifest["status"],
  artifacts: SbiShinseiArtifactManifest[],
  failures: SbiShinseiFailure[],
): void {
  const present = new Set(artifacts.map((artifact) => artifact.dataset));
  const datasetFailures = new Set<string>();
  const collectFailures = failures.filter((failure) => failure.operation === "collect");
  for (const failure of failures) {
    if (failure.operation.startsWith("r2:") ||
        failure.operation.startsWith("read:") ||
        failure.operation === "derive:normalized") {
      const dataset = failure.operation.slice(failure.operation.indexOf(":") + 1);
      if (datasetFailures.has(dataset)) invalid("manifest_duplicate_failure");
      datasetFailures.add(dataset);
    }
  }
  if (collectFailures.length > 0) {
    if (failures.length !== 1 || artifacts.length !== 0 || status !== "failed") {
      invalid("manifest_failure_complement_mismatch");
    }
    return;
  }
  for (const dataset of DATASETS) {
    if (present.has(dataset) === datasetFailures.has(dataset)) {
      invalid("manifest_failure_complement_mismatch");
    }
  }
  const expectedArtifactOrder = DATASETS.filter((dataset) => present.has(dataset));
  if (artifacts.some((artifact, index) => artifact.dataset !== expectedArtifactOrder[index])) {
    invalid("manifest_dataset_order_invalid");
  }
  const expectedStatus = failures.length === 0
    ? "success"
    : artifacts.length === 0 ? "failed" : "partial";
  if (status !== expectedStatus) invalid("manifest_status_mismatch");
}

function validateDatasetPayload(dataset: Dataset, value: JsonObject): void {
  if (dataset === "normalized") {
    parseNormalized(value);
    return;
  }
  validateSbiShinseiResponse(RAW_SCHEMAS[dataset], value);
}

function validateCrossArtifactMeaning(
  manifest: SbiShinseiManifest,
  artifacts: VerifiedArtifact[],
): void {
  const top = artifacts.find((entry) =>
    entry.manifest.dataset === "top-accounts-balance-and-activity"
  )?.semantic;
  const normalizedValue = artifacts.find((entry) =>
    entry.manifest.dataset === "normalized"
  )?.semantic;
  if (normalizedValue) {
    const normalized = parseNormalized(normalizedValue);
    if (normalized.capturedAt < manifest.startedAt || normalized.capturedAt > manifest.completedAt) {
      throw new ImportError(409, "normalized_capture_time_mismatch");
    }
    if (top && canonical(normalized) !== canonical(normalizeTop(top, normalized.capturedAt))) {
      throw new ImportError(409, "normalized_payload_mismatch");
    }
  }
  const legacyWindow = manifest.legacyWindow;
  if (legacyWindow) {
    if (top) {
      validateLegacyWindow(manifest, legacyWindow, top);
    }
  }
}

function validateLegacyWindow(
  manifest: SbiShinseiManifest,
  legacyWindow: { from: string; to: string },
  top: JsonObject,
): void {
  const actual = topWindow(top);
  if (actual.to !== null) {
    if (actual.from !== legacyWindow.from || actual.to !== legacyWindow.to) {
      throw new ImportError(409, "manifest_window_payload_mismatch");
    }
    return;
  }

  const startedDate = manifest.startedAt.slice(0, 10);
  const completedDate = manifest.completedAt.slice(0, 10);
  if (
    legacyWindow.to !== startedDate ||
    legacyWindow.to !== completedDate ||
    actual.from > legacyWindow.from
  ) {
    throw new ImportError(409, "manifest_window_payload_mismatch");
  }

  for (const value of actual.activityDetails) {
    const item = recordConflict(value, "artifact_schema_invalid");
    const postingDate = compactDate(item.postingDate);
    if (postingDate < actual.from || postingDate > legacyWindow.to) {
      throw new ImportError(409, "manifest_window_payload_mismatch");
    }
  }
}

function parseNormalized(value: unknown): NormalizedSnapshot {
  const root = recordConflict(value, "normalized_schema_invalid");
  exactShapeConflict(root, ["schemaVersion", "capturedAt", "balances", "transactions"],
    "normalized_schema_invalid");
  if (root.schemaVersion !== "sbi-shinsei-v1") {
    throw new ImportError(409, "normalized_schema_invalid");
  }
  const capturedAt = instantConflict(root.capturedAt, "normalized_schema_invalid");
  if (!Array.isArray(root.balances) || root.balances.length > 100 ||
      !Array.isArray(root.transactions) || root.transactions.length > 1_000) {
    throw new ImportError(409, "normalized_schema_invalid");
  }
  const balances = root.balances.map((entry) => normalizedBalance(entry));
  const transactions = root.transactions.map((entry) => normalizedTransaction(entry));
  if (balances.some((balance) => balance.asOf !== capturedAt)) {
    throw new ImportError(409, "normalized_capture_time_mismatch");
  }
  return { schemaVersion: "sbi-shinsei-v1", capturedAt, balances, transactions };
}

function normalizedBalance(value: unknown): JsonObject {
  const item = recordConflict(value, "normalized_schema_invalid");
  exactShapeConflict(item, ["accountKey", "product", "currency", "balance", "yenEquivalent", "asOf"],
    "normalized_schema_invalid");
  nonEmpty(item.accountKey);
  if (!["yen-savings", "hyper-yokin", "foreign-savings", "term-deposit"].includes(String(item.product))) {
    throw new ImportError(409, "normalized_schema_invalid");
  }
  isoCurrency(item.currency);
  decimal(item.balance);
  if (item.yenEquivalent !== null) decimal(item.yenEquivalent);
  instantConflict(item.asOf, "normalized_schema_invalid");
  return item;
}

function normalizedTransaction(value: unknown): JsonObject {
  const item = recordConflict(value, "normalized_schema_invalid");
  exactShapeConflict(item, ["accountKey", "transactionDate", "description", "debit", "credit", "balance", "currency"],
    "normalized_schema_invalid");
  nonEmpty(item.accountKey);
  date(item.transactionDate, "normalized_schema_invalid");
  nonEmpty(item.description);
  if ((item.debit === null) === (item.credit === null)) {
    throw new ImportError(409, "normalized_schema_invalid");
  }
  if (item.debit !== null) decimal(item.debit);
  if (item.credit !== null) decimal(item.credit);
  decimal(item.balance);
  isoCurrency(item.currency);
  return item;
}

function normalizeTop(top: JsonObject, capturedAt: string): NormalizedSnapshot {
  const response = recordConflict(top.responseParam, "artifact_schema_invalid");
  const overview = recordConflict(response.overview, "artifact_schema_invalid");
  const overviewResponse = recordConflict(overview.responseParam, "artifact_schema_invalid");
  const savings = overviewResponse.savingsDetails as unknown[];
  const balances = savings.map((value) => {
    const item = recordConflict(value, "artifact_schema_invalid");
    const currency = String(item.currency);
    const productCode = String(item.productCode);
    return {
      accountKey: String(item.accountNo),
      product: currency !== "JPY" ? "foreign-savings" : productCode === "603" ? "hyper-yokin" : "yen-savings",
      currency,
      balance: decimalFromScalar(item.balance),
      yenEquivalent: nullableDecimalFromScalar(item.yenEqui),
      asOf: capturedAt,
    };
  });
  const activity = recordConflict(response.activity, "artifact_schema_invalid");
  const activityResponse = recordConflict(activity.responseParam, "artifact_schema_invalid");
  const transactions = (activityResponse.activityDetails as unknown[]).map((value) => {
    const item = recordConflict(value, "artifact_schema_invalid");
    return {
      accountKey: String(activityResponse.accountNo),
      transactionDate: compactDate(item.postingDate),
      description: String(item.description),
      debit: nullableDecimalFromScalar(item.debit),
      credit: nullableDecimalFromScalar(item.credit),
      balance: decimalFromScalar(item.balance),
      currency: String(activityResponse.currency),
    };
  });
  return { schemaVersion: "sbi-shinsei-v1", capturedAt, balances, transactions };
}

function topWindow(top: JsonObject): {
  from: string;
  to: string | null;
  activityDetails: unknown[];
} {
  const response = recordConflict(top.responseParam, "artifact_schema_invalid");
  const activity = recordConflict(response.activity, "artifact_schema_invalid");
  const detail = recordConflict(activity.responseParam, "artifact_schema_invalid");
  return {
    from: compactDate(detail.fromDate),
    to: detail.toDate === "" ? null : compactDate(detail.toDate),
    activityDetails: detail.activityDetails as unknown[],
  };
}

async function readVerifiedArtifact(
  bucket: R2Bucket,
  artifact: SbiShinseiArtifactManifest,
  runId: string,
): Promise<Uint8Array> {
  const object = await bucket.get(artifact.key);
  if (!object) throw new ImportError(409, "artifact_missing");
  if (object.size !== artifact.bytes || object.size > MAX_ARTIFACT_BYTES) {
    throw new ImportError(409, "artifact_size_mismatch");
  }
  assertArtifactMetadata(object.customMetadata, artifact, runId);
  assertJsonContentType(object, "artifact_content_type_mismatch");
  const bytes = new Uint8Array(await object.arrayBuffer());
  assertNativeSha256(object, artifact.sha256);
  if (await sha256Hex(bytes) !== artifact.sha256) {
    throw new ImportError(409, "artifact_checksum_mismatch");
  }
  return bytes;
}

async function assertExactPrefix(
  bucket: R2Bucket,
  prefix: string,
  expectedKeys: string[],
): Promise<void> {
  const actual: string[] = [];
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, limit: 1_000, ...(cursor ? { cursor } : {}) });
    actual.push(...listed.objects.map((object) => object.key));
    cursor = listed.truncated ? listed.cursor : undefined;
    if (listed.truncated && !cursor) throw new ImportError(409, "prefix_cursor_missing");
    if (actual.length > DATASETS.length + 1) {
      throw new ImportError(409, "prefix_inventory_too_large");
    }
  } while (cursor);
  actual.sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new ImportError(409, "prefix_inventory_mismatch");
  }
}

async function dataDescriptor(options: {
  artifact: SbiShinseiArtifactManifest;
  centralSha256: string;
  centralBytes: number;
  sequence: number;
  fetchUnitId: number;
  completedAt: string;
  fingerprintKey: string;
  linkNormalized: boolean;
}): Promise<JsonObject> {
  const filename = options.artifact.key.split("/").at(-1)!;
  const normalized = options.artifact.dataset === "normalized";
  return {
    artifactKey: filename,
    artifactRole: normalized ? "collector_derived" : "sanitized_provider_capture",
    payloadFidelity: "transformed",
    containerKind: "single",
    lineageDisposition: normalized
      ? options.linkNormalized ? "linked" : "source_bytes_not_available"
      : "source_not_retained_for_security",
    dataset: options.artifact.dataset,
    formatId: `sbi-shinsei-${options.artifact.dataset}-json`,
    formatVersion: SCHEMA_VERSION,
    declaredMediaType: "application/json",
    mediaTypeBasis: "manifest",
    fetchedAtMs: Date.parse(options.completedAt),
    fetchedAtBasis: "manifest",
    fetchUnitId: options.fetchUnitId,
    sequence: options.sequence,
    sha256: options.centralSha256,
    byteSize: options.centralBytes,
    storage: await storageOrigin(options.artifact.key, options.fingerprintKey),
    transformSteps: normalized ? [{
      stepIndex: 0,
      stepKind: "extracted",
      transformerId: "sbi-shinsei-normalizer",
      transformerVersion: "sbi-shinsei-v1",
    }] : [
      {
        stepIndex: 0,
        stepKind: "transport_decoded",
        transformerId: "sbi-shinsei-browser-capture",
        transformerVersion: SCHEMA_VERSION,
      },
      {
        stepIndex: 1,
        stepKind: "redacted",
        transformerId: "sbi-shinsei-token-sanitizer",
        transformerVersion: "v1",
      },
      {
        stepIndex: 2,
        stepKind: "reencoded",
        transformerId: "sbi-shinsei-token-sanitizer",
        transformerVersion: "v1",
      },
    ],
    ...(normalized ? {
      ...(options.linkNormalized ? {
        relations: [{
          parentArtifactKey: FILENAMES["top-accounts-balance-and-activity"],
          relation: "input",
          transformerId: "sbi-shinsei-normalizer",
          transformerVersion: "sbi-shinsei-v1",
        }],
      } : {}),
    } : {}),
  };
}

function sanitizeProviderResponse(value: JsonObject): Uint8Array {
  const clean: JsonObject = { ...value };
  if (value.header !== null && typeof value.header === "object" &&
      !Array.isArray(value.header)) {
    const header = { ...(value.header as JsonObject) };
    delete header.newToken;
    clean.header = header;
  }
  return new TextEncoder().encode(JSON.stringify(clean));
}

function sanitizeManifest(manifest: SbiShinseiManifest): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    source: manifest.source,
    runId: manifest.runId,
    startedAt: manifest.startedAt,
    completedAt: manifest.completedAt,
    status: manifest.status,
    liveReadsEnabled: manifest.liveReadsEnabled,
    artifacts: manifest.artifacts,
    failures: manifest.failures.map((failure) => ({
      operation: failure.operation,
      errorType: failure.errorType,
      message: sanitizedFailureMessage(failure),
    })),
    ...(manifest.legacyWindow ? { window: manifest.legacyWindow } : {}),
  }));
}

function sanitizedFailureMessage(failure: SbiShinseiFailure): string {
  if (failure.operation === "collect") return "collector_request_failed";
  if (failure.operation.startsWith("r2:")) return "staging_write_failed";
  if (failure.operation === "derive:normalized") {
    return failure.errorType === "DependencyInvalid"
      ? "normalized_source_invalid"
      : "normalized_derivation_failed";
  }
  if (failure.errorType === "ResponseSchemaError") return "provider_response_invalid";
  if (failure.errorType === "NotAttempted") return "provider_read_not_attempted";
  return "provider_read_failed";
}

async function manifestDescriptor(options: {
  bytes: number;
  sha256: string;
  sequence: number;
  key: string;
  completedAt: string;
  fingerprintKey: string;
  formatVersion: string;
}): Promise<JsonObject> {
  return {
    artifactKey: "manifest.json",
    artifactRole: "collector_derived",
    payloadFidelity: "transformed",
    containerKind: "single",
    lineageDisposition: "source_not_retained_for_security",
    dataset: "collector-manifest",
    formatId: "sbi-shinsei-collector-manifest-json",
    formatVersion: options.formatVersion,
    declaredMediaType: "application/json",
    mediaTypeBasis: "operator",
    fetchedAtMs: Date.parse(options.completedAt),
    fetchedAtBasis: "manifest",
    sequence: options.sequence,
    sha256: options.sha256,
    byteSize: options.bytes,
    storage: await storageOrigin(options.key, options.fingerprintKey),
    transformSteps: [
      {
        stepIndex: 0,
        stepKind: "transport_decoded",
        transformerId: "sbi-shinsei-manifest-sanitizer",
        transformerVersion: "v1",
      },
      {
        stepIndex: 1,
        stepKind: "redacted",
        transformerId: "sbi-shinsei-manifest-sanitizer",
        transformerVersion: "v1",
      },
      {
        stepIndex: 2,
        stepKind: "reencoded",
        transformerId: "sbi-shinsei-manifest-sanitizer",
        transformerVersion: "v1",
      },
    ],
  };
}

async function storageOrigin(key: string, fingerprintKey: string): Promise<JsonObject> {
  if (!/^[0-9a-f]{64}$/u.test(fingerprintKey)) {
    throw new ImportError(500, "fingerprint_configuration_invalid");
  }
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    ownedArrayBuffer(hexBytes(fingerprintKey)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(key),
  );
  return {
    storageKind: "r2",
    containerName: STORAGE_CONTAINER,
    objectKeyTemplate: STORAGE_TEMPLATE,
    objectKeyFingerprint: bytesHex(new Uint8Array(signature)),
    fingerprintKeyVersion: FINGERPRINT_VERSION,
    redactionVersion: "v1",
  };
}

function assertManifestMetadata(
  actual: Record<string, string> | undefined,
  manifest: SbiShinseiManifest,
  sha256: string,
): void {
  const legacy = { source: manifest.source, status: manifest.status, runId: manifest.runId };
  if (sameMetadata(actual, legacy)) return;
  assertExactMetadata(actual, { ...legacy, sha256 }, "manifest_metadata_mismatch");
}

function assertArtifactMetadata(
  actual: Record<string, string> | undefined,
  artifact: SbiShinseiArtifactManifest,
  runId: string,
): void {
  const legacy = { dataset: artifact.dataset, sha256: artifact.sha256 };
  if (sameMetadata(actual, legacy)) return;
  assertExactMetadata(actual, {
    source: EXTERNAL_SOURCE,
    runId,
    dataset: artifact.dataset,
    sha256: artifact.sha256,
  }, "artifact_metadata_mismatch");
}

function assertNativeSha256(object: R2ObjectBody, expected: string): void {
  const native = object.checksums.sha256;
  if (native && bytesHex(new Uint8Array(native)) !== expected) {
    throw new ImportError(409, "artifact_native_checksum_mismatch");
  }
}

function assertJsonContentType(object: R2ObjectBody, code: string): void {
  if (object.httpMetadata?.contentType !== "application/json") {
    throw new ImportError(409, code);
  }
}

function safeFailureCode(failures: SbiShinseiFailure[]): string {
  if (failures.some((failure) => failure.operation.startsWith("read:"))) {
    return "provider-read-incomplete";
  }
  if (failures.some((failure) => failure.operation === "derive:normalized")) {
    return "normalized-derivation-failed";
  }
  if (failures.length > 1) return "multiple-staging-write-failures";
  return failures[0]?.operation === "collect"
    ? "collector-browser-failed"
    : "staging-write-failed";
}

function isDataset(value: string): value is Dataset {
  return (DATASETS as readonly string[]).includes(value);
}

function parseWindow(value: unknown): { from: string; to: string } {
  const input = record(value, "manifest_window_invalid");
  exactShape(input, ["from", "to"]);
  const from = date(input.from, "manifest_window_invalid");
  const to = date(input.to, "manifest_window_invalid");
  if (from > to) invalid("manifest_window_reversed");
  return { from, to };
}

function parseJson(bytes: Uint8Array, code: string, status = 409): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ImportError(status, code);
  }
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new ImportError(status, code);
  }
  return value as JsonObject;
}

function record(value: unknown, code: string): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") invalid(code);
  return value as JsonObject;
}

function recordConflict(value: unknown, code: string): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new ImportError(409, code);
  }
  return value as JsonObject;
}

function exactShape(value: JsonObject, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalid("manifest_unknown_field");
  }
}

function exactShapeConflict(value: JsonObject, keys: readonly string[], code: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new ImportError(409, code);
  }
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  choices: T,
  code: string,
): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) invalid(code);
  return value as T[number];
}

function instant(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length > 35) invalid(code);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) invalid(code);
  return value;
}

function instantConflict(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length > 35) throw new ImportError(409, code);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new ImportError(409, code);
  }
  return value;
}

function date(value: unknown, code: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new ImportError(code.startsWith("manifest_") ? 400 : 409, code);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ImportError(code.startsWith("manifest_") ? 400 : 409, code);
  }
  return value;
}

function compactDate(value: unknown): string {
  if (typeof value !== "string") throw new ImportError(409, "artifact_schema_invalid");
  const normalized = /^\d{8}$/u.test(value)
    ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
    : value.replaceAll("/", "-");
  return date(normalized, "artifact_schema_invalid");
}

function decimal(value: unknown): string {
  if (typeof value !== "string" || !/^-?\d+(?:\.\d+)?$/u.test(value)) {
    throw new ImportError(409, "normalized_schema_invalid");
  }
  return value;
}

function decimalFromScalar(value: unknown): string {
  if (typeof value !== "string" && (typeof value !== "number" || !Number.isFinite(value))) {
    throw new ImportError(409, "artifact_schema_invalid");
  }
  const normalized = String(value).replaceAll(",", "").trim();
  if (!/^-?\d+(?:\.\d+)?$/u.test(normalized)) {
    throw new ImportError(409, "artifact_schema_invalid");
  }
  return normalized;
}

function nullableDecimalFromScalar(value: unknown): string | null {
  return value === null || value === undefined || value === ""
    ? null
    : decimalFromScalar(value);
}

function nonEmpty(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ImportError(409, "normalized_schema_invalid");
  }
  return value;
}

function isoCurrency(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Z]{3}$/u.test(value)) {
    throw new ImportError(409, "normalized_schema_invalid");
  }
  return value;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const input = value as JsonObject;
    return `{${Object.keys(input).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(input[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertExactMetadata(
  actual: Record<string, string> | undefined,
  expected: Record<string, string>,
  code: string,
): void {
  if (!sameMetadata(actual, expected)) throw new ImportError(409, code);
}

function sameMetadata(
  actual: Record<string, string> | undefined,
  expected: Record<string, string>,
): boolean {
  if (!actual) return false;
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index] && actual[key] === expected[key]);
}

function invalid(code: string): never {
  throw new ImportError(400, code);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return bytesHex(new Uint8Array(
    await crypto.subtle.digest("SHA-256", ownedArrayBuffer(bytes)),
  ));
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
