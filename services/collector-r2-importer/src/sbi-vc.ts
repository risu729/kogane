import { CentralClient } from "./central";
import { ImportError } from "./error";
import type {
  CentralInventoryItem,
  SbiVcArtifactManifest,
  SbiVcFailure,
  SbiVcManifest,
} from "./types";

const SOURCE = "sbi-vc-trade" as const;
const PRODUCER = "collector-r2-importer";
const SCHEMA_VERSION = "sbi-vc-trade-worker-poc-v1";
const INGEST_CONTRACT_VERSION = "sbi-vc-r2-v1";
const CENTRAL_CLIENT_ID = "collector-r2-sbi-vc";
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
const MAX_PAGE_COUNT = 100;
const PAGE_SIZE = 30;
// The public collector is the only caller. Its Service Binding call into this
// importer plus every importer-to-central call all share the 32 Worker
// invocation chain. 2n + 9 <= 32, where n excludes the manifest.
const MAX_SYNCHRONOUS_ARTIFACTS = 11;
const STORAGE_TEMPLATE = "raw/sbi-vc-trade/{date}/{run-id}/{artifact}.json";
const STORAGE_CONTAINER = "kogane-sbi-vc-trade-poc";
const FINGERPRINT_VERSION = "collector-r2-v1";
const MANIFEST_KEY = /^raw\/sbi-vc-trade\/(\d{4})\/(\d{2})\/(\d{2})\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/manifest\.json$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const ERROR_CODE = /^[a-z0-9_]{1,100}$/u;
const PAGINATION_EVIDENCE_ERROR = /^(?:executions_historical|cashflows_historical)_(?:invalid_pagination|pagination_total_changed|pagination_length_mismatch)$/u;
const STATIC_DATASETS = [
  "cash-balances",
  "account-margin",
  "position-summary",
  "executions-recent-page-0001",
] as const;
const HISTORICAL_EXECUTION = /^executions-historical-page-(\d{4})$/u;
const HISTORICAL_CASHFLOW = /^cashflows-historical-page-(\d{4})$/u;

type JsonObject = Record<string, unknown>;
type PageGroup = "executions-historical" | "cashflows-historical";

interface VerifiedArtifact {
  artifact: SbiVcArtifactManifest;
  page?: PageInfo;
  failureEvidence?: true;
}

interface PageInfo {
  group: PageGroup;
  index: number;
  listLength: number;
  totalSize: number;
}

export interface ImportSbiVcRunResult {
  source: typeof SOURCE;
  manifestKey: string;
  centralRunId: number;
  artifactCount: number;
  sealed: true;
  allObjectsReused: boolean;
}

export async function importSbiVcRun(options: {
  bucket: R2Bucket;
  centralService: Fetcher;
  centralToken: string;
  fingerprintKey: string;
  importerVersion: string;
  manifestKey: string;
}): Promise<ImportSbiVcRunResult> {
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
    assertNativeSha256(manifestObject, await sha256Hex(manifestBytes));
    const manifest = parseSbiVcManifest(manifestBytes, options.manifestKey);
    assertExactMetadata(manifestObject.customMetadata, {
      source: manifest.source,
      runId: manifest.runId,
      status: manifest.status,
    }, "manifest_metadata_mismatch");
    expectedArtifactCount = manifest.artifacts.length + 1;
    const prefix = options.manifestKey.slice(0, -"manifest.json".length);

    phase = "prefix_validation";
    await assertExactPrefix(options.bucket, prefix, [
      ...manifest.artifacts.map((artifact) => artifact.key),
      options.manifestKey,
    ]);

    // The largest valid run has 204 four-MiB artifacts. Validate sequentially
    // and keep only page metadata so the Worker never buffers a whole run.
    phase = "artifact_validation";
    const verifiedArtifacts: VerifiedArtifact[] = [];
    const collectFailureEvidenceIndex =
      manifest.failures.length === 1 && manifest.failures[0]?.operation === "collect" &&
        PAGINATION_EVIDENCE_ERROR.test(manifest.failures[0].errorCode) &&
        manifest.artifacts.length > 0
        ? manifest.artifacts.length - 1
        : -1;
    for (const [index, artifact] of manifest.artifacts.entries()) {
      const bytes = await readVerifiedArtifact(options.bucket, artifact);
      if (index === collectFailureEvidenceIndex) {
        assertStoredFailureEnvelope(bytes);
        verifiedArtifacts.push({ artifact, failureEvidence: true });
        continue;
      }
      verifiedArtifacts.push({
        artifact,
        ...parseStoredEnvelope(bytes, artifact.dataset),
      });
    }
    validateFailureComplement(manifest, verifiedArtifacts);

    // Repeat the inventory boundary immediately before creating central state.
    await assertExactPrefix(options.bucket, prefix, [
      ...manifest.artifacts.map((artifact) => artifact.key),
      options.manifestKey,
    ]);

    if (manifest.artifacts.length > MAX_SYNCHRONOUS_ARTIFACTS) {
      throw new ImportError(409, "sync_import_worker_chain_limit");
    }

    phase = "central_create";
    const central = new CentralClient(
      options.centralService,
      options.centralToken,
      CENTRAL_CLIENT_ID,
    );
    centralRunId = await central.createRun({
      producerId: PRODUCER,
      sourceId: SOURCE,
      externalIdNamespace: SCHEMA_VERSION,
      externalSessionId: manifest.runId,
      sourceRunKey: `full-snapshot-${INGEST_CONTRACT_VERSION}`,
    });

    phase = "unit_catalogue";
    const unitId = await central.addUnit(centralRunId, {
      unitKind: "collection",
      unitKey: "account",
      terminalReportRequired: true,
    });

    const inventory: CentralInventoryItem[] = [];
    for (const [sequence, verified] of verifiedArtifacts.entries()) {
      phase = "object_upload";
      // A second bounded read prevents validation from retaining the source
      // payload and rechecks hash/metadata immediately before upload.
      const bytes = await readVerifiedArtifact(options.bucket, verified.artifact);
      const reused = await central.uploadObject(
        centralRunId,
        verified.artifact.sha256,
        bytes,
      );
      if (reused) reusedArtifactCount += 1;
      else acceptedArtifactCount += 1;

      phase = "artifact_catalogue";
      const descriptorSha256 = await central.addArtifact(
        centralRunId,
        await dataDescriptor({
          artifact: verified.artifact,
          sequence,
          fetchUnitId: unitId,
          completedAt: manifest.completedAt,
          fingerprintKey: options.fingerprintKey,
        }),
      );
      inventory.push({
        artifactKey: `${verified.artifact.dataset}.json`,
        sha256: verified.artifact.sha256,
        descriptorSha256,
      });
    }

    phase = "manifest_upload";
    const manifestSha256 = await sha256Hex(manifestBytes);
    const manifestReused = await central.uploadObject(
      centralRunId,
      manifestSha256,
      manifestBytes,
    );
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
      ...(manifest.failures.length === 1
        ? { safeFailureCode: safeFailureCode(manifest.failures[0]!) }
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

export function parseSbiVcManifest(bytes: Uint8Array, manifestKey: string): SbiVcManifest {
  const keyMatch = MANIFEST_KEY.exec(manifestKey);
  if (!keyMatch) throw new ImportError(400, "manifest_key_invalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ImportError(400, "manifest_json_invalid");
  }
  const input = record(parsed, "manifest_shape_invalid");
  exactKeys(input, [
    "schemaVersion", "source", "runId", "startedAt", "completedAt",
    "status", "artifacts", "failures",
  ]);
  if (input.schemaVersion !== SCHEMA_VERSION) invalid("manifest_schema_invalid");
  if (input.source !== SOURCE) invalid("manifest_source_invalid");
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
  if (!Array.isArray(input.artifacts) || input.artifacts.length > 204) {
    invalid("manifest_artifacts_invalid");
  }
  if (!Array.isArray(input.failures) || input.failures.length > 1) {
    invalid("manifest_failures_invalid");
  }
  const prefix = manifestKey.slice(0, -"manifest.json".length);
  const artifacts = input.artifacts.map((entry) => parseArtifact(entry, prefix));
  const failures = input.failures.map(parseFailure);
  if (new Set(artifacts.map((artifact) => artifact.dataset)).size !== artifacts.length) {
    invalid("manifest_duplicate_dataset");
  }
  validateDatasetOrder(artifacts);
  const expectedStatus = failures.length === 0
    ? "success"
    : artifacts.length === 0 ? "failed" : "partial";
  if (status !== expectedStatus) invalid("manifest_status_mismatch");
  return {
    schemaVersion: SCHEMA_VERSION,
    source: SOURCE,
    runId: input.runId as string,
    startedAt,
    completedAt,
    status,
    artifacts,
    failures,
  };
}

function parseArtifact(value: unknown, prefix: string): SbiVcArtifactManifest {
  const input = record(value, "manifest_artifact_invalid");
  exactKeys(input, ["dataset", "key", "sha256", "bytes"]);
  if (typeof input.dataset !== "string" || !isDataset(input.dataset)) {
    invalid("manifest_dataset_invalid");
  }
  if (input.key !== `${prefix}${input.dataset}.json`) {
    invalid("manifest_artifact_key_mismatch");
  }
  if (typeof input.sha256 !== "string" || !SHA256.test(input.sha256)) {
    invalid("manifest_artifact_sha_invalid");
  }
  if (!Number.isSafeInteger(input.bytes) || (input.bytes as number) < 1 ||
      (input.bytes as number) > MAX_ARTIFACT_BYTES) {
    invalid("manifest_artifact_size_invalid");
  }
  return {
    dataset: input.dataset,
    key: input.key as string,
    sha256: input.sha256,
    bytes: input.bytes as number,
  };
}

function parseFailure(value: unknown): SbiVcFailure {
  const input = record(value, "manifest_failure_invalid");
  exactKeys(input, ["operation", "errorCode"]);
  if (typeof input.operation !== "string" ||
      !(input.operation === "load_session" || input.operation === "collect" ||
        input.operation === "persist_session" || input.operation.startsWith("r2_"))) {
    invalid("manifest_failure_operation_invalid");
  }
  if (typeof input.errorCode !== "string" || !ERROR_CODE.test(input.errorCode)) {
    invalid("manifest_failure_error_code_invalid");
  }
  return { operation: input.operation, errorCode: input.errorCode };
}

function validateDatasetOrder(artifacts: SbiVcArtifactManifest[]): void {
  let offset = 0;
  for (const dataset of STATIC_DATASETS) {
    if (offset >= artifacts.length) return;
    if (artifacts[offset]!.dataset !== dataset) invalid("manifest_dataset_order_invalid");
    offset += 1;
  }
  let expectedPage = 1;
  while (offset < artifacts.length) {
    const match = HISTORICAL_EXECUTION.exec(artifacts[offset]!.dataset);
    if (!match) break;
    if (Number(match[1]) !== expectedPage || expectedPage > MAX_PAGE_COUNT) {
      invalid("manifest_execution_page_sequence_invalid");
    }
    expectedPage += 1;
    offset += 1;
  }
  if (offset < artifacts.length && expectedPage === 1) {
    invalid("manifest_execution_page_missing");
  }
  expectedPage = 1;
  while (offset < artifacts.length) {
    const match = HISTORICAL_CASHFLOW.exec(artifacts[offset]!.dataset);
    if (!match || Number(match[1]) !== expectedPage || expectedPage > MAX_PAGE_COUNT) {
      invalid("manifest_cashflow_page_sequence_invalid");
    }
    expectedPage += 1;
    offset += 1;
  }
}

function validateFailureComplement(
  manifest: SbiVcManifest,
  artifacts: VerifiedArtifact[],
): void {
  if (manifest.failures.length === 0) {
    const nextDataset = nextExpectedDataset(artifacts);
    if (nextDataset !== null) invalid("manifest_dataset_completeness_mismatch");
    return;
  }
  const operation = manifest.failures[0]!.operation;
  const last = artifacts.at(-1);
  if (operation === "collect" &&
      PAGINATION_EVIDENCE_ERROR.test(manifest.failures[0]!.errorCode) &&
      last?.failureEvidence) {
    const expected = nextExpectedDataset(artifacts.slice(0, -1));
    if (expected !== last.artifact.dataset) {
      invalid("manifest_failure_complement_mismatch");
    }
    return;
  }
  const nextDataset = nextExpectedDataset(artifacts);
  if (nextDataset === null) invalid("manifest_failure_complement_mismatch");
  if (operation === "load_session" && artifacts.length !== 0) {
    invalid("manifest_failure_complement_mismatch");
  }
  if (operation.startsWith("r2_") && operation.slice(3) !== nextDataset) {
    invalid("manifest_failure_complement_mismatch");
  }
  if (operation.startsWith("r2_") && !isDataset(operation.slice(3))) {
    invalid("manifest_failure_complement_mismatch");
  }
}

function nextExpectedDataset(artifacts: VerifiedArtifact[]): string | null {
  if (artifacts.length < STATIC_DATASETS.length) {
    return STATIC_DATASETS[artifacts.length]!;
  }
  const executions = artifacts.filter((entry) =>
    HISTORICAL_EXECUTION.test(entry.artifact.dataset)
  );
  if (executions.length === 0) return pageDataset("executions-historical", 1);
  assertPageChain(executions);
  const lastExecution = requiredPage(executions.at(-1));
  const cashflows = artifacts.filter((entry) =>
    HISTORICAL_CASHFLOW.test(entry.artifact.dataset)
  );
  if (!pageIsTerminal(lastExecution)) {
    if (cashflows.length !== 0) invalid("manifest_execution_page_terminal_invalid");
    return pageDataset("executions-historical", lastExecution.index + 1);
  }
  if (cashflows.length === 0) return pageDataset("cashflows-historical", 1);
  assertPageChain(cashflows);
  const lastCashflow = requiredPage(cashflows.at(-1));
  return pageIsTerminal(lastCashflow)
    ? null
    : pageDataset("cashflows-historical", lastCashflow.index + 1);
}

function assertPageChain(artifacts: VerifiedArtifact[]): void {
  const pages = artifacts.map(requiredPage);
  const totalSize = pages[0]!.totalSize;
  let observed = 0;
  for (const page of pages) {
    if (page.totalSize !== totalSize) invalid("manifest_page_total_changed");
    const offset = (page.index - 1) * PAGE_SIZE;
    const expectedLength = Math.min(PAGE_SIZE, Math.max(totalSize - offset, 0));
    if (page.listLength !== expectedLength) invalid("manifest_page_length_mismatch");
    observed += page.listLength;
    if (page !== pages.at(-1) && pageIsTerminal(page)) {
      invalid("manifest_page_after_terminal");
    }
  }
  const last = pages.at(-1)!;
  if (pageIsTerminal(last) && observed !== totalSize) {
    invalid("manifest_page_total_mismatch");
  }
}

function requiredPage(artifact: VerifiedArtifact | undefined): PageInfo {
  if (!artifact?.page) invalid("artifact_page_payload_invalid");
  return artifact.page;
}

function pageIsTerminal(page: PageInfo): boolean {
  return page.listLength === 0 || page.index * PAGE_SIZE >= page.totalSize;
}

function pageDataset(group: PageGroup, index: number): string {
  return `${group}-page-${String(index).padStart(4, "0")}`;
}

function parseStoredEnvelope(
  bytes: Uint8Array,
  dataset: string,
): { page?: PageInfo } {
  const envelope = storedEnvelope(bytes);
  const group = pageGroup(dataset);
  const recentExecution = dataset === "executions-recent-page-0001";
  if (!group && !recentExecution) return {};
  const body = recordConflict(envelope.body, "artifact_page_payload_invalid");
  if (!Array.isArray(body.list) || body.list.length > PAGE_SIZE) {
    throw new ImportError(409, "artifact_page_payload_invalid");
  }
  const totalSize = nonNegativeInteger(body.totalSize);
  if (totalSize === null) throw new ImportError(409, "artifact_page_payload_invalid");
  if (recentExecution) return {};
  if (!group) return {};
  const match = (group === "executions-historical" ? HISTORICAL_EXECUTION : HISTORICAL_CASHFLOW)
    .exec(dataset);
  if (!match) throw new ImportError(409, "artifact_page_dataset_invalid");
  return {
    page: {
      group,
      index: Number(match[1]),
      listLength: body.list.length,
      totalSize,
    },
  };
}

function assertStoredFailureEnvelope(bytes: Uint8Array): void {
  storedEnvelope(bytes);
}

function storedEnvelope(bytes: Uint8Array): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ImportError(409, "artifact_json_invalid");
  }
  const envelope = recordConflict(parsed, "artifact_envelope_invalid");
  const keys = Object.keys(envelope).sort();
  if (keys.length !== 2 || keys[0] !== "body" || keys[1] !== "meta") {
    throw new ImportError(409, "artifact_envelope_invalid");
  }
  const meta = recordConflict(envelope.meta, "artifact_meta_invalid");
  if (meta.status !== "OK") {
    throw new ImportError(409, "artifact_gateway_status_invalid");
  }
  if (Object.hasOwn(meta, "secureKey")) {
    throw new ImportError(409, "artifact_secure_key_present");
  }
  return envelope;
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
  } while (cursor);
  actual.sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new ImportError(409, "prefix_inventory_mismatch");
  }
}

async function readVerifiedArtifact(
  bucket: R2Bucket,
  artifact: SbiVcArtifactManifest,
): Promise<Uint8Array> {
  const object = await bucket.get(artifact.key);
  if (!object) throw new ImportError(409, "artifact_missing");
  if (object.size !== artifact.bytes || object.size > MAX_ARTIFACT_BYTES) {
    throw new ImportError(409, "artifact_size_mismatch");
  }
  assertArtifactMetadata(object.customMetadata, artifact);
  assertJsonContentType(object, "artifact_content_type_mismatch");
  const bytes = new Uint8Array(await object.arrayBuffer());
  assertNativeSha256(object, artifact.sha256);
  if (await sha256Hex(bytes) !== artifact.sha256) {
    throw new ImportError(409, "artifact_checksum_mismatch");
  }
  return bytes;
}

function assertNativeSha256(object: R2ObjectBody, expected: string): void {
  const native = object.checksums.sha256;
  if (native && bytesHex(new Uint8Array(native)) !== expected) {
    throw new ImportError(409, "artifact_native_checksum_mismatch");
  }
}

async function dataDescriptor(options: {
  artifact: SbiVcArtifactManifest;
  sequence: number;
  fetchUnitId: number;
  completedAt: string;
  fingerprintKey: string;
}): Promise<JsonObject> {
  return {
    artifactKey: `${options.artifact.dataset}.json`,
    artifactRole: "collector_derived",
    payloadFidelity: "transformed",
    containerKind: "single",
    lineageDisposition: "source_bytes_not_available",
    dataset: options.artifact.dataset,
    formatId: `sbi-vc-${options.artifact.dataset}-json`,
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
    transformSteps: ["transport_decoded", "redacted", "reencoded"].map(
      (stepKind, stepIndex) => ({
        stepIndex,
        stepKind,
        transformerId: "sbi-vc-trade-worker",
        transformerVersion: SCHEMA_VERSION,
      }),
    ),
  };
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
    formatId: "sbi-vc-collector-manifest-json",
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

function safeFailureCode(failure: SbiVcFailure): string {
  if (failure.operation === "load_session") return "session-load-failed";
  if (failure.operation === "persist_session") return "session-persist-failed";
  if (failure.operation.startsWith("r2_")) return "staging-write-failed";
  return "collector-request-failed";
}

function isDataset(value: string): boolean {
  if ((STATIC_DATASETS as readonly string[]).includes(value)) return true;
  const match = HISTORICAL_EXECUTION.exec(value) ?? HISTORICAL_CASHFLOW.exec(value);
  return match !== null && Number(match[1]) >= 1 && Number(match[1]) <= MAX_PAGE_COUNT;
}

function pageGroup(value: string): PageGroup | null {
  if (HISTORICAL_EXECUTION.test(value)) return "executions-historical";
  if (HISTORICAL_CASHFLOW.test(value)) return "cashflows-historical";
  return null;
}

function nonNegativeInteger(value: unknown): number | null {
  const number = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number) && number >= 0
    ? number
    : null;
}

function assertExactMetadata(
  actual: Record<string, string> | undefined,
  expected: Record<string, string>,
  code: string,
): void {
  if (!actual) throw new ImportError(409, code);
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (actualKeys.length !== expectedKeys.length ||
      actualKeys.some((key, index) => key !== expectedKeys[index] || actual[key] !== expected[key])) {
    throw new ImportError(409, code);
  }
}

function assertArtifactMetadata(
  actual: Record<string, string> | undefined,
  artifact: SbiVcArtifactManifest,
): void {
  if (!actual) throw new ImportError(409, "artifact_metadata_mismatch");
  const legacy = { dataset: artifact.dataset, sha256: artifact.sha256 };
  const current = {
    source: SOURCE,
    runId: artifact.key.split("/").at(-2)!,
    ...legacy,
  };
  const matches = (expected: Record<string, string>) => {
    const actualKeys = Object.keys(actual).sort();
    const expectedKeys = Object.keys(expected).sort();
    return actualKeys.length === expectedKeys.length &&
      actualKeys.every((key, index) =>
        key === expectedKeys[index] && actual[key] === expected[key]
      );
  };
  if (!matches(legacy) && !matches(current)) {
    throw new ImportError(409, "artifact_metadata_mismatch");
  }
}

function assertJsonContentType(object: R2ObjectBody, code: string): void {
  if (object.httpMetadata?.contentType !== "application/json") {
    throw new ImportError(409, code);
  }
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
