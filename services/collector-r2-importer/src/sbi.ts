import { CentralClient } from "./central";
import { ImportError } from "./error";
import type { CentralInventoryItem, SbiArtifactManifest, SbiFailure, SbiManifest } from "./types";

const SOURCE = "sbi-securities" as const;
const PRODUCER = "collector-r2-importer";
const SCHEMA_VERSION = "sbi-worker-poc-v1";
const INGEST_CONTRACT_VERSION = "sbi-r2-v3";
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const STORAGE_TEMPLATE = "raw/sbi-securities/{date}/{run-id}/{artifact}.json";
const STORAGE_CONTAINER = "kogane-sbi-collector-poc";
const FINGERPRINT_VERSION = "collector-r2-v1";
const CENTRAL_CLIENT_ID = "collector-r2-sbi";
const MANIFEST_KEY =
  /^raw\/sbi-securities\/(\d{4})\/(\d{2})\/(\d{2})\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/manifest\.json$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_TEXT = /^[A-Za-z0-9._:/-]{1,200}$/u;
const DATASETS = new Set([
  "domestic-cash-positions",
  "account-assets-current",
  "yen-detail-history",
  "domestic-trade-records",
  "foreign-cash-positions",
  "foreign-cash-balances",
  "foreign-trade-records",
]);
const EXPECTED_DATASETS: Record<Scope, readonly string[]> = {
  domestic: [
    "domestic-cash-positions",
    "account-assets-current",
    "yen-detail-history",
    "domestic-trade-records",
  ],
  foreign: ["foreign-cash-positions", "foreign-cash-balances", "foreign-trade-records"],
};

type Scope = "domestic" | "foreign";
type JsonObject = Record<string, unknown>;

export { ImportError } from "./error";

export interface ImportRunResult {
  source: typeof SOURCE;
  manifestKey: string;
  centralRunId: number;
  artifactCount: number;
  sealed: true;
  allObjectsReused: boolean;
}

export async function importSbiRun(options: {
  bucket: R2Bucket;
  centralService: Fetcher;
  centralToken: string;
  fingerprintKey: string;
  importerVersion: string;
  manifestKey: string;
}): Promise<ImportRunResult> {
  const startedAtMs = Date.now();
  const attemptId = `attempt-${crypto.randomUUID()}`;
  let centralRunId: number | undefined;
  let acceptedArtifactCount = 0;
  let reusedArtifactCount = 0;
  let phase = "manifest_validation";
  let expectedArtifactCount = 0;

  try {
    const manifestObject = await options.bucket.get(options.manifestKey);
    if (!manifestObject) throw new ImportError(404, "manifest_not_found");
    if (manifestObject.size > MAX_MANIFEST_BYTES) {
      throw new ImportError(413, "manifest_too_large");
    }
    const manifestBytes = new Uint8Array(await manifestObject.arrayBuffer());
    const manifest = parseSbiManifest(manifestBytes, options.manifestKey);
    if (
      manifestObject.customMetadata?.source !== manifest.source ||
      manifestObject.customMetadata?.status !== manifest.status ||
      manifestObject.customMetadata?.runId !== manifest.runId
    ) {
      throw new ImportError(409, "manifest_metadata_mismatch");
    }
    expectedArtifactCount = manifest.artifacts.length + 1;
    const prefix = options.manifestKey.slice(0, -"manifest.json".length);

    phase = "prefix_validation";
    await assertExactPrefix(options.bucket, prefix, [
      ...manifest.artifacts.map((artifact) => artifact.key),
      options.manifestKey,
    ]);

    // Validate every source object before creating immutable central state.
    const verifiedArtifacts = await Promise.all(
      manifest.artifacts.map(async (artifact) => ({
        artifact,
        bytes: await readVerifiedArtifact(options.bucket, artifact),
      })),
    );

    phase = "central_create";
    const central = new CentralClient(
      options.centralService,
      options.centralToken,
      CENTRAL_CLIENT_ID,
    );
    centralRunId = await central.createRun({
      producerId: PRODUCER,
      sourceId: SOURCE,
      externalIdNamespace: "sbi-worker-poc-v1",
      externalSessionId: manifest.runId,
      sourceRunKey: `${manifest.scope}-${INGEST_CONTRACT_VERSION}`,
    });

    const units = new Map<Scope, number>();
    for (const scope of scopesFor(manifest.scope)) {
      phase = "unit_catalogue";
      units.set(
        scope,
        await central.addUnit(centralRunId, {
          unitKind: "scope",
          unitKey: scope,
          terminalReportRequired: true,
        }),
      );
    }

    const inventory: CentralInventoryItem[] = [];
    for (const [sequence, verified] of verifiedArtifacts.entries()) {
      const { artifact, bytes } = verified;
      phase = "object_upload";
      const reused = await central.uploadObject(centralRunId, artifact.sha256, bytes);
      if (reused) reusedArtifactCount += 1;
      else acceptedArtifactCount += 1;

      phase = "artifact_catalogue";
      const descriptorSha256 = await central.addArtifact(
        centralRunId,
        await dataDescriptor({
          artifact,
          sequence,
          fetchUnitId: requiredUnit(units, datasetScope(artifact.dataset)),
          completedAt: manifest.completedAt,
          fingerprintKey: options.fingerprintKey,
        }),
      );
      inventory.push({
        artifactKey: `${artifact.dataset}.json`,
        sha256: artifact.sha256,
        descriptorSha256,
      });
    }

    phase = "manifest_upload";
    const manifestSha256 = await sha256Hex(manifestBytes);
    const manifestReused = await central.uploadObject(centralRunId, manifestSha256, manifestBytes);
    if (manifestReused) reusedArtifactCount += 1;
    else acceptedArtifactCount += 1;

    phase = "manifest_catalogue";
    const manifestDescriptorSha256 = await central.addArtifact(
      centralRunId,
      await manifestDescriptor({
        bytes: manifestBytes.byteLength,
        sha256: manifestSha256,
        sequence: manifest.artifacts.length,
        key: options.manifestKey,
        completedAt: manifest.completedAt,
        fingerprintKey: options.fingerprintKey,
      }),
    );
    inventory.push({
      artifactKey: "manifest.json",
      sha256: manifestSha256,
      descriptorSha256: manifestDescriptorSha256,
    });

    for (const scope of scopesFor(manifest.scope)) {
      phase = "unit_report";
      const failures = manifest.failures.filter((failure) => failure.scope === scope);
      const artifactCount = manifest.artifacts.filter(
        (artifact) => datasetScope(artifact.dataset) === scope,
      ).length;
      const outcome =
        failures.length === 0 ? "success" : artifactCount === 0 ? "failed" : "partial";
      await central.addUnitReport(requiredUnit(units, scope), {
        reportKey: "terminal",
        reportKind: "terminal",
        producerStatus: outcome,
        normalizedOutcome: outcome,
        startedAtMs: Date.parse(manifest.startedAt),
        startedAtBasis: "manifest",
        completedAtMs: Date.parse(manifest.completedAt),
        completedAtBasis: "manifest",
        declaredArtifactCount: artifactCount,
        artifactCountScope: "direct",
        ...(failures.length > 0 ? { safeFailureCode: safeFailureCode(failures) } : {}),
      });
    }

    phase = "run_report";
    await central.addRunReport(centralRunId, {
      reportKey: "terminal",
      reportKind: "terminal",
      producerVersion: INGEST_CONTRACT_VERSION,
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

export function parseSbiManifest(bytes: Uint8Array, manifestKey: string): SbiManifest {
  const keyMatch = MANIFEST_KEY.exec(manifestKey);
  if (!keyMatch) throw new ImportError(400, "manifest_key_invalid");
  let input: unknown;
  try {
    input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ImportError(400, "manifest_json_invalid");
  }
  const value = record(input, "manifest_shape_invalid");
  exactKeys(value, [
    "schemaVersion",
    "source",
    "runId",
    "scope",
    "startedAt",
    "completedAt",
    "status",
    "artifacts",
    "failures",
  ]);
  if (value.schemaVersion !== SCHEMA_VERSION) invalid("manifest_schema_invalid");
  if (value.source !== SOURCE) invalid("manifest_source_invalid");
  if (value.runId !== keyMatch[4]) invalid("manifest_run_id_mismatch");
  const scope = oneOf(
    value.scope,
    ["all", "domestic", "foreign"] as const,
    "manifest_scope_invalid",
  );
  const startedAt = instant(value.startedAt, "manifest_started_at_invalid");
  const completedAt = instant(value.completedAt, "manifest_completed_at_invalid");
  if (completedAt < startedAt) invalid("manifest_time_reversed");
  const expectedDate = `${keyMatch[1]}-${keyMatch[2]}-${keyMatch[3]}`;
  if (startedAt.slice(0, 10) !== expectedDate) invalid("manifest_date_mismatch");
  const status = oneOf(
    value.status,
    ["success", "partial", "failed"] as const,
    "manifest_status_invalid",
  );
  if (!Array.isArray(value.artifacts) || value.artifacts.length > DATASETS.size) {
    invalid("manifest_artifacts_invalid");
  }
  if (!Array.isArray(value.failures) || value.failures.length > 20) {
    invalid("manifest_failures_invalid");
  }
  const prefix = manifestKey.slice(0, -"manifest.json".length);
  const artifacts = value.artifacts.map((entry) => parseArtifact(entry, prefix, scope));
  const failures = value.failures.map((entry) => parseFailure(entry, scope));
  if (new Set(artifacts.map((artifact) => artifact.dataset)).size !== artifacts.length) {
    invalid("manifest_duplicate_dataset");
  }
  if (
    new Set(failures.map((failure) => `${failure.scope}:${failure.operation}`)).size !==
    failures.length
  ) {
    invalid("manifest_duplicate_failure");
  }
  const expectedStatus =
    failures.length === 0 ? "success" : artifacts.length === 0 ? "failed" : "partial";
  if (status !== expectedStatus) invalid("manifest_status_mismatch");
  validateCompleteness(scope, artifacts, failures);
  return {
    schemaVersion: SCHEMA_VERSION,
    source: SOURCE,
    runId: value.runId as string,
    scope,
    startedAt,
    completedAt,
    status,
    artifacts,
    failures,
  };
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
    if (listed.truncated && !cursor) {
      throw new ImportError(409, "prefix_cursor_missing");
    }
  } while (cursor);
  actual.sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new ImportError(409, "prefix_inventory_mismatch");
  }
}

async function readVerifiedArtifact(
  bucket: R2Bucket,
  artifact: SbiArtifactManifest,
): Promise<Uint8Array> {
  const object = await bucket.get(artifact.key);
  if (!object) throw new ImportError(409, "artifact_missing");
  if (object.size !== artifact.bytes || object.size > MAX_ARTIFACT_BYTES) {
    throw new ImportError(409, "artifact_size_mismatch");
  }
  if (
    object.customMetadata?.sha256 !== artifact.sha256 ||
    object.customMetadata?.dataset !== artifact.dataset
  ) {
    throw new ImportError(409, "artifact_metadata_mismatch");
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if ((await sha256Hex(bytes)) !== artifact.sha256) {
    throw new ImportError(409, "artifact_checksum_mismatch");
  }
  return bytes;
}

function parseArtifact(
  value: unknown,
  prefix: string,
  scope: SbiManifest["scope"],
): SbiArtifactManifest {
  const input = record(value, "manifest_artifact_invalid");
  exactKeys(input, ["dataset", "key", "sha256", "bytes", "window"]);
  if (typeof input.dataset !== "string" || !DATASETS.has(input.dataset)) {
    invalid("manifest_dataset_invalid");
  }
  const dataset = input.dataset as string;
  if (scope !== "all" && datasetScope(dataset) !== scope) {
    invalid("manifest_artifact_scope_mismatch");
  }
  if (input.key !== `${prefix}${dataset}.json`) invalid("manifest_artifact_key_mismatch");
  if (typeof input.sha256 !== "string" || !SHA256.test(input.sha256)) {
    invalid("manifest_artifact_sha_invalid");
  }
  if (
    !Number.isSafeInteger(input.bytes) ||
    (input.bytes as number) < 0 ||
    (input.bytes as number) > MAX_ARTIFACT_BYTES
  ) {
    invalid("manifest_artifact_size_invalid");
  }
  const window = input.window === undefined ? undefined : parseWindow(input.window);
  const historyDataset =
    dataset === "domestic-trade-records" || dataset === "foreign-trade-records";
  if (historyDataset !== (window !== undefined)) {
    invalid("manifest_artifact_window_mismatch");
  }
  return {
    dataset,
    key: input.key as string,
    sha256: input.sha256,
    bytes: input.bytes as number,
    ...(window ? { window } : {}),
  };
}

function parseFailure(value: unknown, scope: SbiManifest["scope"]): SbiFailure {
  const input = record(value, "manifest_failure_invalid");
  exactKeys(input, ["scope", "operation", "errorType", "message"]);
  const failureScope = oneOf(
    input.scope,
    ["domestic", "foreign"] as const,
    "manifest_failure_scope_invalid",
  );
  if (scope !== "all" && failureScope !== scope) invalid("manifest_failure_scope_mismatch");
  for (const [field, item] of [
    ["operation", input.operation],
    ["error_type", input.errorType],
  ] as const) {
    if (typeof item !== "string" || !SAFE_TEXT.test(item))
      invalid(`manifest_failure_${field}_invalid`);
  }
  if (typeof input.message !== "string" || input.message.length > 300) {
    invalid("manifest_failure_message_invalid");
  }
  const operation = input.operation as string;
  const known =
    (failureScope === "domestic" && (operation === "passkey-mts" || operation === "main-site")) ||
    (failureScope === "foreign" && operation === "passkey-graphql") ||
    operation.startsWith("r2:");
  if (!known) invalid("manifest_failure_operation_invalid");
  if (operation.startsWith("r2:")) {
    const dataset = operation.slice(3);
    if (!DATASETS.has(dataset) || datasetScope(dataset) !== failureScope) {
      invalid("manifest_failure_operation_invalid");
    }
  }
  return {
    scope: failureScope,
    operation,
    errorType: input.errorType as string,
    message: input.message,
  };
}

function parseWindow(value: unknown): { from: string; to: string } {
  const input = record(value, "manifest_window_invalid");
  exactKeys(input, ["from", "to"]);
  const from = date(input.from, "manifest_window_invalid");
  const to = date(input.to, "manifest_window_invalid");
  if (from > to) invalid("manifest_window_reversed");
  const days =
    Math.floor(
      (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000,
    ) + 1;
  if (days > 90) invalid("manifest_window_too_large");
  return { from, to };
}

async function dataDescriptor(options: {
  artifact: SbiArtifactManifest;
  sequence: number;
  fetchUnitId: number;
  completedAt: string;
  fingerprintKey: string;
}): Promise<JsonObject> {
  return {
    artifactKey: `${options.artifact.dataset}.json`,
    artifactRole: "collector_derived",
    payloadFidelity: "transformed",
    containerKind: options.artifact.dataset === "foreign-trade-records" ? "bundle" : "single",
    lineageDisposition: "source_bytes_not_available",
    dataset: options.artifact.dataset,
    formatId: `sbi-${options.artifact.dataset}-json`,
    formatVersion: SCHEMA_VERSION,
    declaredMediaType: "application/json",
    mediaTypeBasis: "operator",
    fetchedAtMs: Date.parse(options.completedAt),
    fetchedAtBasis: "manifest",
    fetchUnitId: options.fetchUnitId,
    sequence: options.sequence,
    sha256: options.artifact.sha256,
    byteSize: options.artifact.bytes,
    storage: await storageOrigin(options.artifact.key, options.fingerprintKey),
    ...(options.artifact.window
      ? {
          ranges: [
            {
              rangeKey: "requested-window",
              rangeKind: "requested",
              precision: "date",
              startValue: options.artifact.window.from,
              endValue: options.artifact.window.to,
              startInclusive: true,
              endInclusive: true,
              basis: "manifest",
            },
          ],
        }
      : {}),
    transformSteps: [
      "transport_decoded",
      "extracted",
      ...(options.artifact.dataset === "foreign-trade-records" ? ["bundled"] : []),
      "reencoded",
    ].map((stepKind, stepIndex) => ({
      stepIndex,
      stepKind,
      transformerId: "sbi-securities-worker",
      transformerVersion: SCHEMA_VERSION,
    })),
  };
}

function validateCompleteness(
  scope: SbiManifest["scope"],
  artifacts: SbiArtifactManifest[],
  failures: SbiFailure[],
): void {
  const present = new Set(artifacts.map((artifact) => artifact.dataset));
  for (const unitScope of scopesFor(scope)) {
    const requiredMissing = new Set<string>();
    const scopedFailures = failures.filter((failure) => failure.scope === unitScope);
    for (const failure of scopedFailures) {
      if (failure.operation === "passkey-mts") {
        EXPECTED_DATASETS.domestic.forEach((dataset) => requiredMissing.add(dataset));
      } else if (failure.operation === "main-site") {
        ["account-assets-current", "yen-detail-history", "domestic-trade-records"].forEach(
          (dataset) => requiredMissing.add(dataset),
        );
      } else if (failure.operation === "passkey-graphql") {
        EXPECTED_DATASETS.foreign.forEach((dataset) => requiredMissing.add(dataset));
      } else if (failure.operation.startsWith("r2:")) {
        requiredMissing.add(failure.operation.slice(3));
      }
    }
    for (const dataset of EXPECTED_DATASETS[unitScope]) {
      if (present.has(dataset) === requiredMissing.has(dataset)) {
        invalid("manifest_dataset_completeness_mismatch");
      }
    }
  }
}

async function manifestDescriptor(options: {
  bytes: number;
  sha256: string;
  sequence: number;
  key: string;
  completedAt: string;
  fingerprintKey: string;
}): Promise<JsonObject> {
  return {
    artifactKey: "manifest.json",
    artifactRole: "collector_manifest",
    payloadFidelity: "generated",
    containerKind: "single",
    lineageDisposition: "not_applicable",
    dataset: "collector-manifest",
    formatId: "sbi-collector-manifest-json",
    formatVersion: SCHEMA_VERSION,
    declaredMediaType: "application/json",
    mediaTypeBasis: "operator",
    fetchedAtMs: Date.parse(options.completedAt),
    fetchedAtBasis: "manifest",
    sequence: options.sequence,
    sha256: options.sha256,
    byteSize: options.bytes,
    storage: await storageOrigin(options.key, options.fingerprintKey),
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
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(key));
  return {
    storageKind: "r2",
    containerName: STORAGE_CONTAINER,
    objectKeyTemplate: STORAGE_TEMPLATE,
    objectKeyFingerprint: bytesHex(new Uint8Array(signature)),
    fingerprintKeyVersion: FINGERPRINT_VERSION,
    redactionVersion: "v1",
  };
}

function safeFailureCode(failures: SbiFailure[]): string {
  if (failures.length !== 1) return "multiple-collector-failures";
  const operation = failures[0]!.operation;
  if (operation === "passkey-mts") return "passkey-mts-failed";
  if (operation === "main-site") return "main-site-failed";
  if (operation === "passkey-graphql") return "passkey-graphql-failed";
  if (operation.startsWith("r2:")) return "staging-write-failed";
  return "collector-operation-failed";
}

function scopesFor(scope: SbiManifest["scope"]): Scope[] {
  return scope === "all" ? ["domestic", "foreign"] : [scope];
}

function datasetScope(dataset: string): Scope {
  return dataset.startsWith("foreign-") ? "foreign" : "domestic";
}

function requiredUnit(units: Map<Scope, number>, scope: Scope): number {
  const unitId = units.get(scope);
  if (unitId === undefined) throw new ImportError(500, "unit_mapping_missing");
  return unitId;
}

function record(value: unknown, code: string): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") invalid(code);
  return value as JsonObject;
}

function exactKeys(value: JsonObject, allowed: readonly string[]): void {
  const set = new Set(allowed);
  if (Object.keys(value).some((key) => !set.has(key))) invalid("manifest_unknown_field");
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

function date(value: unknown, code: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) invalid(code);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) invalid(code);
  return value;
}

function invalid(code: string): never {
  throw new ImportError(400, code);
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
