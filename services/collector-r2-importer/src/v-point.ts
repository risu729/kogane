import { CentralClient } from "./central";
import { ImportError } from "./error";
import type { CentralInventoryItem } from "./types";

const SOURCE = "v-point" as const;
const PRODUCER = "collector-r2-importer";
const V1 = "vpoint-worker-poc-v1" as const;
const V2 = "vpoint-worker-poc-v2" as const;
const INGEST_CONTRACT_VERSION = "vpoint-r2-v2";
const CENTRAL_CLIENT_ID = "collector-r2-v-point";
const STORAGE_CONTAINER = "kogane-vpoint-collector-poc";
const STORAGE_TEMPLATE = "raw/v-point/{date}/{run-id}/{artifact}.json";
const RECONCILIATION_CONTAINER = "kogane-vpoint-pay-collector-poc";
const RECONCILIATION_TEMPLATE =
  "derived/v-point-pay-email-reconciliation/{date}/{run-id}.json";
const FINGERPRINT_VERSION = "collector-r2-v1";
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
const MAX_HISTORY_PAGES = 200;
const PAGE_SIZE = 30;
// 2n + 9 <= 32, where n includes every data artifact (including the
// optional reconciliation report) but excludes the collector manifest.
const MAX_SYNCHRONOUS_DATA_ARTIFACTS = 11;
export const VPOINT_TRANSFER_CHUNK_SIZE = 8;
const MANIFEST_KEY =
  /^raw\/v-point\/(\d{4})\/(\d{2})\/(\d{2})\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/manifest\.json$/u;
const HISTORY_DATASET = /^history-page-(\d{4})$/u;
const VMONEY_DATASET = /^vmoney-history-page-(\d{4})$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_ERROR_TYPE = /^[A-Za-z][A-Za-z0-9]{0,79}$/u;
const RECONCILIATION_MATCH_POLICIES = [
  "exact JST date and explicit V Point amount",
  "exact JST date and explicit V Point amount, including an explicitly V Point-funded charge",
] as const;

type JsonObject = Record<string, unknown>;
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type SchemaVersion = typeof V1 | typeof V2;
type Status = "success" | "partial" | "failed";

interface ArtifactManifest {
  dataset: string;
  key: string;
  mediaType: "application/json";
  sha256: string;
  bytes: number;
}

interface Failure {
  operation: "collect" | "r2" | "reconcile";
  errorType: string;
  artifactDataset?: string;
}

interface ReconciliationSummary {
  reportKey: string;
  emailEventCount: number;
  comparableCount: number;
  matchedCount: number;
  ambiguousCount: number;
  unmatchedCount: number;
  notComparableCount: number;
  appLedgerStatus:
    | "unavailable-no-live-snapshot"
    | "available-not-compared";
}

interface Manifest {
  schemaVersion: SchemaVersion;
  source: typeof SOURCE;
  runId: string;
  startedAt: string;
  completedAt: string;
  status: Status;
  historyTotal: number;
  historyPageCount: number;
  vMoneyHistoryTotal: number;
  vMoneyHistoryPageCount: number;
  artifacts: ArtifactManifest[];
  failures: Failure[];
  emailReconciliation?: ReconciliationSummary;
}

interface PageInfo {
  group: "history" | "vmoney-history";
  index: number;
  rowCount: number;
  total: number;
}

interface VerifiedArtifact {
  artifact: ArtifactManifest;
  page?: PageInfo;
  historyRows?: JsonObject[];
  summary?: SummaryInfo;
}

interface SummaryInfo {
  version: "vpoint-collection-summary-v1" | "vpoint-collection-summary-v2";
  historyTotal: number;
  historyPageCount: number;
  vMoneyHistoryTotal: number;
  vMoneyHistoryPageCount: number;
}

interface VerifiedReport {
  key: string;
  bytes: Uint8Array;
  sha256: string;
}

type ArtifactPlanSource =
  | { kind: "data"; artifact: ArtifactManifest }
  | { kind: "reconciliation"; summary: ReconciliationSummary }
  | { kind: "manifest" };

interface ArtifactPlan {
  source: ArtifactPlanSource;
  byteSize: number;
  sha256: string;
  descriptor: JsonObject;
  inventory: CentralInventoryItem;
}

export type ImportVPointResult = ImportVPointDeferred | ImportVPointSealed;

export interface ImportVPointDeferred {
  source: typeof SOURCE;
  manifestKey: string;
  status: "deferred";
  reason: "worker_invocation_limit";
  artifactCount: number;
  nextOffset: number;
}

export interface ImportVPointSealed {
  source: typeof SOURCE;
  manifestKey: string;
  status: "sealed";
  centralRunId: number;
  artifactCount: number;
  sealed: true;
  allObjectsReused: boolean;
}

interface ImportVPointOptions {
  bucket: R2Bucket;
  reconciliationBucket: R2Bucket;
  centralService: Fetcher;
  centralToken: string;
  fingerprintKey: string;
  importerVersion: string;
  manifestKey: string;
  offset?: number;
  immediate?: boolean;
}

export interface AuditVPointResult {
  source: typeof SOURCE;
  schemaVersion: SchemaVersion;
  status: Status;
  artifactCount: number;
  hasReconciliation: boolean;
}

/** Read-only contract audit used before enabling a new importer revision. */
export async function auditVPointRun(options: {
  bucket: R2Bucket;
  reconciliationBucket: R2Bucket;
  manifestKey: string;
}): Promise<AuditVPointResult> {
  const loaded = await readManifest(options.bucket, options.manifestKey);
  const manifest = loaded.manifest;
  const prefix = options.manifestKey.slice(0, -"manifest.json".length);
  await assertExactPrefix(options.bucket, prefix, [
    ...manifest.artifacts.map((artifact) => artifact.key),
    options.manifestKey,
  ]);
  const verified: VerifiedArtifact[] = [];
  for (const artifact of manifest.artifacts) {
    const bytes = await readVerifiedArtifact(options.bucket, artifact);
    verified.push({ artifact, ...validateArtifactPayload(artifact.dataset, bytes) });
  }
  validateSemantics(manifest, verified);
  if (manifest.emailReconciliation) {
    await readVerifiedReport(
      options.reconciliationBucket,
      manifest,
      manifest.emailReconciliation,
      verified,
    );
  }
  await assertExactPrefix(options.bucket, prefix, [
    ...manifest.artifacts.map((artifact) => artifact.key),
    options.manifestKey,
  ]);
  return {
    source: SOURCE,
    schemaVersion: manifest.schemaVersion,
    status: manifest.status,
    artifactCount: manifest.artifacts.length,
    hasReconciliation: manifest.emailReconciliation !== undefined,
  };
}

export async function importVPointRun(options: ImportVPointOptions): Promise<ImportVPointResult> {
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
    expectedArtifactCount = manifest.artifacts.length +
      (manifest.emailReconciliation ? 1 : 0) + 1;
    const offset = options.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= expectedArtifactCount ||
        (options.immediate !== false && offset !== 0)) {
      throw new ImportError(400, "transfer_offset_invalid");
    }

    phase = "prefix_validation";
    await assertExactPrefix(options.bucket, prefix, [
      ...manifest.artifacts.map((artifact) => artifact.key),
      options.manifestKey,
    ]);

    phase = "artifact_validation";
    const verified: VerifiedArtifact[] = [];
    for (const artifact of manifest.artifacts) {
      const bytes = await readVerifiedArtifact(options.bucket, artifact);
      verified.push({ artifact, ...validateArtifactPayload(artifact.dataset, bytes) });
    }
    validateSemantics(manifest, verified);

    const report = manifest.emailReconciliation
      ? await readVerifiedReport(
          options.reconciliationBucket,
          manifest,
          manifest.emailReconciliation,
          verified,
        )
      : undefined;
    await assertExactPrefix(options.bucket, prefix, [
      ...manifest.artifacts.map((artifact) => artifact.key),
      options.manifestKey,
    ]);

    const dataArtifactCount = verified.length + (report ? 1 : 0);
    if (options.immediate !== false && dataArtifactCount > MAX_SYNCHRONOUS_DATA_ARTIFACTS) {
      return deferredVPoint(options.manifestKey, expectedArtifactCount, 0);
    }

    const centralManifestBytes = sanitizeManifest(loaded.bytes, manifest);
    const centralManifestSha256 = await sha256Hex(centralManifestBytes);

    phase = "central_create";
    const central = new CentralClient(
      options.centralService,
      options.centralToken,
      CENTRAL_CLIENT_ID,
    );
    centralRunId = await central.createRun({
      producerId: PRODUCER,
      sourceId: SOURCE,
      externalIdNamespace: manifest.schemaVersion,
      externalSessionId: manifest.runId,
      sourceRunKey: `full-snapshot-${INGEST_CONTRACT_VERSION}`,
    });
    const unitId = await central.addUnit(centralRunId, {
      unitKind: "collection",
      unitKey: "account",
      terminalReportRequired: true,
    });
    const historyGroupId = manifest.historyPageCount > 0
      ? await central.addPageGroup(centralRunId, {
          pageGroupKey: "point-history",
          declaredPageCount: manifest.historyPageCount,
        })
      : undefined;
    const vMoneyGroupId = manifest.vMoneyHistoryPageCount > 0
      ? await central.addPageGroup(centralRunId, {
          pageGroupKey: "vmoney-history",
          declaredPageCount: manifest.vMoneyHistoryPageCount,
        })
      : undefined;

    phase = "inventory_plan";
    const plans = await artifactPlans({
      verified,
      ...(report ? { report } : {}),
      centralManifestBytes,
      centralManifestSha256,
      manifest,
      manifestKey: options.manifestKey,
      unitId,
      ...(historyGroupId === undefined ? {} : { historyGroupId }),
      ...(vMoneyGroupId === undefined ? {} : { vMoneyGroupId }),
      fingerprintKey: options.fingerprintKey,
    });

    if (options.immediate === false) {
      const inventory = plans.map((plan) => plan.inventory).sort((left, right) =>
        binaryCompare(left.artifactKey, right.artifactKey)
      );
      const inventorySha256 = await sha256Hex(
        new TextEncoder().encode(canonicalJson(inventory as unknown as JsonValue)),
      );
      const inventoryId = await central.beginInventory(
        centralRunId,
        inventorySha256,
        inventory.length,
      );
      const end = Math.min(offset + VPOINT_TRANSFER_CHUNK_SIZE, plans.length);
      const chunkInventory: CentralInventoryItem[] = [];
      for (const plan of plans.slice(offset, end)) {
        const current = await currentPlanBytes(options, plan, manifest, verified);
        phase = "object_upload";
        const reused = await central.uploadObject(centralRunId, plan.sha256, current);
        if (reused) reusedArtifactCount += 1;
        else acceptedArtifactCount += 1;
        phase = "artifact_catalogue";
        const descriptorSha256 = await central.addArtifact(centralRunId, plan.descriptor);
        if (descriptorSha256 !== plan.inventory.descriptorSha256) {
          throw new Error("central_descriptor_mismatch");
        }
        chunkInventory.push(plan.inventory);
      }
      if (chunkInventory.length > 0) {
        phase = "inventory_catalogue";
        await central.addInventoryItems(centralRunId, inventoryId, chunkInventory);
      }
      if (end < plans.length) {
        return deferredVPoint(options.manifestKey, plans.length, end);
      }
      phase = "terminal_reports";
      await addTerminalReports(
        central,
        centralRunId,
        unitId,
        manifest,
        dataArtifactCount,
        plans.length,
      );
      phase = "seal";
      await central.sealStagedInventory(centralRunId, inventoryId, attemptId, startedAtMs);
      return sealedVPoint(
        options.manifestKey,
        centralRunId,
        plans.length,
        acceptedArtifactCount === 0,
      );
    }

    const inventory: CentralInventoryItem[] = [];
    for (const plan of plans) {
      const current = await currentPlanBytes(options, plan, manifest, verified);
      phase = "object_upload";
      const reused = await central.uploadObject(centralRunId, plan.sha256, current);
      if (reused) reusedArtifactCount += 1;
      else acceptedArtifactCount += 1;
      phase = "artifact_catalogue";
      const descriptorSha256 = await central.addArtifact(centralRunId, plan.descriptor);
      if (descriptorSha256 !== plan.inventory.descriptorSha256) {
        throw new Error("central_descriptor_mismatch");
      }
      inventory.push(plan.inventory);
    }
    phase = "terminal_reports";
    await addTerminalReports(
      central,
      centralRunId,
      unitId,
      manifest,
      dataArtifactCount,
      plans.length,
    );
    phase = "seal";
    await central.seal(centralRunId, inventory, attemptId, startedAtMs);
    return sealedVPoint(
      options.manifestKey,
      centralRunId,
      inventory.length,
      acceptedArtifactCount === 0,
    );
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
        // Attempt reporting is best effort; preserve the original failure.
      }
    }
    throw error;
  }
}

async function artifactPlans(options: {
  verified: VerifiedArtifact[];
  report?: VerifiedReport;
  centralManifestBytes: Uint8Array;
  centralManifestSha256: string;
  manifest: Manifest;
  manifestKey: string;
  unitId: number;
  historyGroupId?: number;
  vMoneyGroupId?: number;
  fingerprintKey: string;
}): Promise<ArtifactPlan[]> {
  const plans: ArtifactPlan[] = [];
  for (const [sequence, entry] of options.verified.entries()) {
    const descriptor = await dataDescriptor({
      artifact: entry.artifact,
      sequence,
      fetchUnitId: options.unitId,
      completedAt: options.manifest.completedAt,
      schemaVersion: options.manifest.schemaVersion,
      fingerprintKey: options.fingerprintKey,
      ...(entry.page ? { page: entry.page } : {}),
      ...(options.historyGroupId === undefined ? {} : { historyGroupId: options.historyGroupId }),
      ...(options.vMoneyGroupId === undefined ? {} : { vMoneyGroupId: options.vMoneyGroupId }),
    });
    plans.push({
      source: { kind: "data", artifact: entry.artifact },
      byteSize: entry.artifact.bytes,
      sha256: entry.artifact.sha256,
      descriptor,
      inventory: {
        artifactKey: filename(entry.artifact.key),
        sha256: entry.artifact.sha256,
        descriptorSha256: await descriptorSha256(descriptor),
      },
    });
  }
  if (options.report && options.manifest.emailReconciliation) {
    const descriptor = await reconciliationDescriptor({
      report: options.report,
      sequence: plans.length,
      fetchUnitId: options.unitId,
      completedAt: options.manifest.completedAt,
      fingerprintKey: options.fingerprintKey,
    });
    plans.push({
      source: { kind: "reconciliation", summary: options.manifest.emailReconciliation },
      byteSize: options.report.bytes.byteLength,
      sha256: options.report.sha256,
      descriptor,
      inventory: {
        artifactKey: "vpoint-pay-email-reconciliation.json",
        sha256: options.report.sha256,
        descriptorSha256: await descriptorSha256(descriptor),
      },
    });
  }
  const manifestDescriptorValue = await manifestDescriptor({
    bytes: options.centralManifestBytes.byteLength,
    sha256: options.centralManifestSha256,
    sequence: plans.length,
    key: options.manifestKey,
    completedAt: options.manifest.completedAt,
    schemaVersion: options.manifest.schemaVersion,
    fingerprintKey: options.fingerprintKey,
  });
  plans.push({
    source: { kind: "manifest" },
    byteSize: options.centralManifestBytes.byteLength,
    sha256: options.centralManifestSha256,
    descriptor: manifestDescriptorValue,
    inventory: {
      artifactKey: "manifest.json",
      sha256: options.centralManifestSha256,
      descriptorSha256: await descriptorSha256(manifestDescriptorValue),
    },
  });
  return plans;
}

async function currentPlanBytes(
  options: ImportVPointOptions,
  plan: ArtifactPlan,
  manifest: Manifest,
  verified: VerifiedArtifact[],
): Promise<Uint8Array> {
  let current: Uint8Array;
  if (plan.source.kind === "data") {
    current = await readVerifiedArtifact(options.bucket, plan.source.artifact);
    validateArtifactPayload(plan.source.artifact.dataset, current);
  } else if (plan.source.kind === "reconciliation") {
    current = (await readVerifiedReport(
      options.reconciliationBucket,
      manifest,
      plan.source.summary,
      verified,
    )).bytes;
  } else {
    const loaded = await readManifest(options.bucket, options.manifestKey);
    current = sanitizeManifest(loaded.bytes, loaded.manifest);
  }
  if (current.byteLength !== plan.byteSize || await sha256Hex(current) !== plan.sha256) {
    throw new ImportError(409, "artifact_changed_during_import");
  }
  return current;
}

async function addTerminalReports(
  central: CentralClient,
  centralRunId: number,
  unitId: number,
  manifest: Manifest,
  directArtifactCount: number,
  allArtifactCount: number,
): Promise<void> {
  await central.addUnitReport(unitId, {
    reportKey: "terminal",
    reportKind: "terminal",
    producerStatus: manifest.status,
    normalizedOutcome: manifest.status,
    startedAtMs: Date.parse(manifest.startedAt),
    startedAtBasis: "manifest",
    completedAtMs: Date.parse(manifest.completedAt),
    completedAtBasis: "manifest",
    declaredArtifactCount: directArtifactCount,
    artifactCountScope: "direct",
    ...(manifest.failures.length > 0
      ? { safeFailureCode: safeFailureCode(manifest.failures) }
      : {}),
  });
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
    declaredArtifactCount: allArtifactCount,
    artifactCountScope: "all_catalogued",
  });
}

function deferredVPoint(
  manifestKey: string,
  artifactCount: number,
  nextOffset: number,
): ImportVPointDeferred {
  return {
    source: SOURCE,
    manifestKey,
    status: "deferred",
    reason: "worker_invocation_limit",
    artifactCount,
    nextOffset,
  };
}

function sealedVPoint(
  manifestKey: string,
  centralRunId: number,
  artifactCount: number,
  allObjectsReused: boolean,
): ImportVPointSealed {
  return {
    source: SOURCE,
    manifestKey,
    status: "sealed",
    centralRunId,
    artifactCount,
    sealed: true,
    allObjectsReused,
  };
}

export function parseVPointManifest(bytes: Uint8Array, manifestKey: string): Manifest {
  const keyMatch = MANIFEST_KEY.exec(manifestKey);
  if (!keyMatch) invalid("manifest_key_invalid");
  const input = parseJson(bytes, "manifest_json_invalid");
  const schemaVersion = oneOf(input.schemaVersion, [V1, V2] as const, "manifest_schema_invalid");
  exactShape(input, [
    "schemaVersion", "source", "runId", "startedAt", "completedAt", "status",
    "historyTotal", "historyPageCount",
    ...(schemaVersion === V2 ? ["vMoneyHistoryTotal", "vMoneyHistoryPageCount"] : []),
    "artifacts", "failures", ...(schemaVersion === V2 ? ["emailReconciliation"] : []),
  ], schemaVersion === V2 ? ["emailReconciliation"] : []);
  if (input.source !== SOURCE || input.runId !== keyMatch[4]) {
    invalid("manifest_identity_mismatch");
  }
  const startedAt = instant(input.startedAt, "manifest_started_at_invalid");
  const completedAt = instant(input.completedAt, "manifest_completed_at_invalid");
  if (completedAt < startedAt ||
      startedAt.slice(0, 10) !== `${keyMatch[1]}-${keyMatch[2]}-${keyMatch[3]}`) {
    invalid("manifest_time_invalid");
  }
  const status = oneOf(input.status, ["success", "partial", "failed"] as const, "manifest_status_invalid");
  const historyTotal = count(input.historyTotal, 1_000_000, "manifest_history_total_invalid");
  const historyPageCount = count(input.historyPageCount, MAX_HISTORY_PAGES, "manifest_history_pages_invalid");
  const vMoneyHistoryTotal = schemaVersion === V2
    ? count(input.vMoneyHistoryTotal, 1_000_000, "manifest_vmoney_total_invalid")
    : 0;
  const vMoneyHistoryPageCount = schemaVersion === V2
    ? count(input.vMoneyHistoryPageCount, MAX_HISTORY_PAGES, "manifest_vmoney_pages_invalid")
    : 0;
  if (!Array.isArray(input.artifacts) || input.artifacts.length > 403) {
    invalid("manifest_artifacts_invalid");
  }
  if (!Array.isArray(input.failures) || input.failures.length > 405) {
    invalid("manifest_failures_invalid");
  }
  const prefix = manifestKey.slice(0, -"manifest.json".length);
  const artifacts = input.artifacts.map((value) => parseArtifact(value, prefix, schemaVersion));
  const failures = input.failures.map((value) => parseFailure(value, schemaVersion));
  const emailReconciliation = input.emailReconciliation === undefined
    ? undefined
    : parseReconciliationSummary(input.emailReconciliation, keyMatch[4]!, completedAt);
  validateManifestContract({
    schemaVersion,
    status,
    historyTotal,
    historyPageCount,
    vMoneyHistoryTotal,
    vMoneyHistoryPageCount,
    artifacts,
    failures,
    ...(emailReconciliation ? { emailReconciliation } : {}),
  });
  return {
    schemaVersion,
    source: SOURCE,
    runId: input.runId as string,
    startedAt,
    completedAt,
    status,
    historyTotal,
    historyPageCount,
    vMoneyHistoryTotal,
    vMoneyHistoryPageCount,
    artifacts,
    failures,
    ...(emailReconciliation ? { emailReconciliation } : {}),
  };
}

function parseArtifact(value: unknown, prefix: string, version: SchemaVersion): ArtifactManifest {
  const input = record(value, "manifest_artifact_invalid");
  exactShape(input, ["dataset", "key", "mediaType", "sha256", "bytes"]);
  if (typeof input.dataset !== "string" || !validDataset(input.dataset, version)) {
    invalid("manifest_dataset_invalid");
  }
  if (input.key !== `${prefix}${input.dataset}.json`) {
    invalid("manifest_artifact_key_mismatch");
  }
  if (input.mediaType !== "application/json") invalid("manifest_media_type_invalid");
  if (typeof input.sha256 !== "string" || !SHA256.test(input.sha256)) {
    invalid("manifest_sha256_invalid");
  }
  const bytes = count(input.bytes, MAX_ARTIFACT_BYTES, "manifest_bytes_invalid", 1);
  return {
    dataset: input.dataset,
    key: input.key as string,
    mediaType: "application/json",
    sha256: input.sha256,
    bytes,
  };
}

function parseFailure(value: unknown, version: SchemaVersion): Failure {
  const input = record(value, "manifest_failure_invalid");
  exactShape(input, ["operation", "errorType", "message"]);
  if (typeof input.errorType !== "string" || !SAFE_ERROR_TYPE.test(input.errorType)) {
    invalid("manifest_failure_type_invalid");
  }
  if (typeof input.message !== "string" || input.message.length < 1 || input.message.length > 300 ||
      /[\r\n\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(input.message)) {
    invalid("manifest_failure_message_invalid");
  }
  if (input.operation === "collect") {
    return { operation: "collect", errorType: input.errorType };
  }
  if (input.operation === "reconcile:vpoint-pay-email") {
    return { operation: "reconcile", errorType: input.errorType };
  }
  if (typeof input.operation === "string" && input.operation.startsWith("r2:")) {
    const artifactDataset = input.operation.slice(3);
    if (!validDataset(artifactDataset, version)) invalid("manifest_failure_operation_invalid");
    return { operation: "r2", errorType: input.errorType, artifactDataset };
  }
  invalid("manifest_failure_operation_invalid");
}

function parseReconciliationSummary(
  value: unknown,
  runId: string,
  _completedAt: string,
): ReconciliationSummary {
  const input = record(value, "manifest_reconciliation_invalid");
  exactShape(input, [
    "reportKey", "emailEventCount", "comparableCount", "matchedCount",
    "ambiguousCount", "unmatchedCount", "notComparableCount", "appLedgerStatus",
  ]);
  const escapedRunId = runId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  if (typeof input.reportKey !== "string" ||
      !new RegExp(`^derived/v-point-pay-email-reconciliation/20\\d{2}/(?:0[1-9]|1[0-2])/(?:0[1-9]|[12]\\d|3[01])/${escapedRunId}\\.json$`, "u")
        .test(input.reportKey)) {
    invalid("manifest_reconciliation_key_invalid");
  }
  const result: ReconciliationSummary = {
    reportKey: input.reportKey as string,
    emailEventCount: count(input.emailEventCount, 100_000, "manifest_reconciliation_count_invalid"),
    comparableCount: count(input.comparableCount, 100_000, "manifest_reconciliation_count_invalid"),
    matchedCount: count(input.matchedCount, 100_000, "manifest_reconciliation_count_invalid"),
    ambiguousCount: count(input.ambiguousCount, 100_000, "manifest_reconciliation_count_invalid"),
    unmatchedCount: count(input.unmatchedCount, 100_000, "manifest_reconciliation_count_invalid"),
    notComparableCount: count(input.notComparableCount, 100_000, "manifest_reconciliation_count_invalid"),
    appLedgerStatus: oneOf(
      input.appLedgerStatus,
      ["unavailable-no-live-snapshot", "available-not-compared"] as const,
      "manifest_reconciliation_status_invalid",
    ),
  };
  if (result.comparableCount !== result.matchedCount + result.ambiguousCount + result.unmatchedCount ||
      result.emailEventCount !== result.comparableCount + result.notComparableCount) {
    invalid("manifest_reconciliation_count_mismatch");
  }
  return result;
}

function validateManifestContract(input: {
  schemaVersion: SchemaVersion;
  status: Status;
  historyTotal: number;
  historyPageCount: number;
  vMoneyHistoryTotal: number;
  vMoneyHistoryPageCount: number;
  artifacts: ArtifactManifest[];
  failures: Failure[];
  emailReconciliation?: ReconciliationSummary;
}): void {
  const collectFailures = input.failures.filter((failure) => failure.operation === "collect");
  if (collectFailures.length > 0) {
    if (collectFailures.length !== 1 || input.failures.length !== 1 || input.status !== "failed" ||
        input.artifacts.length !== 0 || input.historyTotal !== 0 || input.historyPageCount !== 0 ||
        input.vMoneyHistoryTotal !== 0 || input.vMoneyHistoryPageCount !== 0 || input.emailReconciliation) {
      invalid("manifest_collect_failure_invalid");
    }
    return;
  }
  if (input.historyPageCount < 1 ||
      input.historyPageCount !== Math.max(1, Math.ceil(input.historyTotal / PAGE_SIZE))) {
    invalid("manifest_history_pagination_invalid");
  }
  if (input.schemaVersion === V2 &&
      (input.vMoneyHistoryPageCount !== 1 || input.vMoneyHistoryTotal !== 0)) {
    // V Money is explicitly outside the V Point source boundary. The live
    // account has only the observed empty page; non-empty data requires a
    // separately reviewed source contract instead of silent attribution.
    invalid("manifest_vmoney_nonempty_unsupported");
  }
  const expected = expectedDatasets(input.schemaVersion, input.historyPageCount, input.vMoneyHistoryPageCount);
  const actual = input.artifacts.map((artifact) => artifact.dataset);
  if (new Set(actual).size !== actual.length || !isOrderedSubset(actual, expected)) {
    invalid("manifest_dataset_order_invalid");
  }
  const r2Failures = input.failures.filter((failure) => failure.operation === "r2");
  const missing = expected.filter((dataset) => !actual.includes(dataset));
  const failedDatasets = r2Failures.map((failure) => failure.artifactDataset!);
  if (!sameStrings([...missing].sort(), [...failedDatasets].sort()) ||
      new Set(failedDatasets).size !== failedDatasets.length) {
    invalid("manifest_failure_complement_mismatch");
  }
  const reconcileFailures = input.failures.filter((failure) => failure.operation === "reconcile");
  if (reconcileFailures.length > 1 || (reconcileFailures.length === 1 && input.emailReconciliation)) {
    invalid("manifest_reconciliation_state_invalid");
  }
  const expectedStatus = input.failures.length === 0
    ? "success"
    : input.artifacts.length === 0 ? "failed" : "partial";
  if (input.status !== expectedStatus) invalid("manifest_status_mismatch");
}

function validateArtifactPayload(
  dataset: string,
  bytes: Uint8Array,
): { page?: PageInfo; historyRows?: JsonObject[]; summary?: SummaryInfo } {
  const input = parseJsonConflict(bytes, "artifact_json_invalid");
  if (dataset === "collection-summary") {
    return { summary: validateSummary(input) };
  }
  validateApiStatus(input);
  if (dataset === "balance-info") {
    validateBalance(input);
    return {};
  }
  if (dataset === "smfg-point") {
    validateSmfg(input);
    return {};
  }
  const history = HISTORY_DATASET.exec(dataset);
  if (history) return validateHistory(input, "history", Number(history[1]));
  const vMoney = VMONEY_DATASET.exec(dataset);
  if (vMoney) return validateHistory(input, "vmoney-history", Number(vMoney[1]));
  throw new ImportError(409, "artifact_dataset_invalid");
}

function validateApiStatus(input: JsonObject): void {
  exactShapeConflict(input, ["status", "results"], "artifact_envelope_invalid");
  const status = recordConflict(input.status, "artifact_status_invalid");
  exactShapeConflict(status, ["code", "response"], "artifact_status_invalid");
  if (status.code !== "0000" || typeof status.response !== "string" || status.response.length > 1_000) {
    throw new ImportError(409, "artifact_status_invalid");
  }
}

function validateBalance(input: JsonObject): void {
  const results = recordConflict(input.results, "balance_results_invalid");
  exactShapeConflict(results, ["common", "get_month", "store", "tmoney"], "balance_results_invalid");
  if (!Array.isArray(results.common) || results.common.length > 100 ||
      !Array.isArray(results.store) || results.store.length > 1_000 ||
      !nonNegativeInteger(results.get_month) || !isRecord(results.tmoney) ||
      Object.keys(results.tmoney).length !== 0) {
    throw new ImportError(409, "balance_results_invalid");
  }
  for (const value of results.common) {
    const row = recordConflict(value, "balance_common_invalid");
    exactShapeConflict(row, ["expiration", "point", "point_type"], "balance_common_invalid");
    if (!safeText(row.expiration, 100) || !integer(row.point) || !nonNegativeInteger(row.point_type)) {
      throw new ImportError(409, "balance_common_invalid");
    }
  }
  for (const value of results.store) {
    const row = recordConflict(value, "balance_store_invalid");
    exactShapeConflict(row, ["alliance_name", "items"], "balance_store_invalid");
    if (!safeText(row.alliance_name, 500) || !Array.isArray(row.items) || row.items.length > 1_000) {
      throw new ImportError(409, "balance_store_invalid");
    }
    for (const itemValue of row.items) {
      const item = recordConflict(itemValue, "balance_store_item_invalid");
      exactShapeConflict(item, ["expiration", "point"], "balance_store_item_invalid");
      if (!safeText(item.expiration, 100) || !integer(item.point)) {
        throw new ImportError(409, "balance_store_item_invalid");
      }
    }
  }
}

function validateSmfg(input: JsonObject): void {
  const results = recordConflict(input.results, "smfg_results_invalid");
  exactShapeConflict(results, ["get_point"], "smfg_results_invalid");
  const points = recordConflict(results.get_point, "smfg_points_invalid");
  exactShapeConflict(points, ["point_smbc", "point_smcc"], "smfg_points_invalid");
  if (!integer(points.point_smbc) || !integer(points.point_smcc)) {
    throw new ImportError(409, "smfg_points_invalid");
  }
}

function validateHistory(
  input: JsonObject,
  group: PageInfo["group"],
  index: number,
): { page: PageInfo; historyRows?: JsonObject[] } {
  const results = recordConflict(input.results, "history_results_invalid");
  const pointHistory = group === "history";
  exactShapeConflict(
    results,
    pointHistory ? ["graph", "history", "total"] : ["history", "total"],
    "history_results_invalid",
  );
  if (!Array.isArray(results.history) || results.history.length > PAGE_SIZE ||
      !nonNegativeInteger(results.total)) {
    throw new ImportError(409, "history_results_invalid");
  }
  if (!pointHistory && (results.total !== 0 || results.history.length !== 0 || index !== 1)) {
    throw new ImportError(409, "vmoney_nonempty_unsupported");
  }
  if (pointHistory) {
    const graph = recordConflict(results.graph, "history_graph_invalid");
    exactShapeConflict(graph, ["monthly", "yearly"], "history_graph_invalid");
    for (const series of [graph.monthly, graph.yearly]) {
      if (!Array.isArray(series) || series.length > 120) {
        throw new ImportError(409, "history_graph_invalid");
      }
      for (const value of series) {
        const row = recordConflict(value, "history_graph_invalid");
        exactShapeConflict(row, ["label", "point"], "history_graph_invalid");
        if (!safeText(row.label, 100) || !integer(row.point)) {
          throw new ImportError(409, "history_graph_invalid");
        }
      }
    }
    const historyRows = results.history.map(validateHistoryRow);
    return {
      page: { group, index, rowCount: historyRows.length, total: results.total },
      historyRows,
    };
  }
  return {
    page: { group, index, rowCount: results.history.length, total: results.total },
  };
}

function validateHistoryRow(value: unknown): JsonObject {
  const row = recordConflict(value, "history_row_invalid");
  exactShapeConflict(row, [
    "date_reflect", "date_use", "is_use_mbo", "point", "point_div",
    "point_type", "reason", "store_alliance_name", "store_category",
    "store_company", "store_name",
  ], "history_row_invalid");
  if (!dateText(row.date_reflect) || !dateText(row.date_use) ||
      typeof row.is_use_mbo !== "boolean" || !integer(row.point) ||
      !nonNegativeInteger(row.point_div) || !nonNegativeInteger(row.point_type) ||
      !safeText(row.reason, 2_000) || !safeText(row.store_alliance_name, 2_000) ||
      !safeText(row.store_category, 2_000) || !safeText(row.store_company, 2_000) ||
      !safeText(row.store_name, 2_000)) {
    throw new ImportError(409, "history_row_invalid");
  }
  return row;
}

function validateSummary(input: JsonObject): SummaryInfo {
  const version = oneOfConflict(
    input.schemaVersion,
    ["vpoint-collection-summary-v1", "vpoint-collection-summary-v2"] as const,
    "summary_schema_invalid",
  );
  exactShapeConflict(input, [
    "schemaVersion", "historyTotal", "historyPageCount",
    ...(version.endsWith("v2") ? ["vMoneyHistoryTotal", "vMoneyHistoryPageCount"] : []),
  ], "summary_shape_invalid");
  if (!nonNegativeInteger(input.historyTotal) || !nonNegativeInteger(input.historyPageCount) ||
      (version.endsWith("v2") &&
        (!nonNegativeInteger(input.vMoneyHistoryTotal) || !nonNegativeInteger(input.vMoneyHistoryPageCount)))) {
    throw new ImportError(409, "summary_count_invalid");
  }
  return {
    version,
    historyTotal: input.historyTotal,
    historyPageCount: input.historyPageCount,
    vMoneyHistoryTotal: version.endsWith("v2") ? input.vMoneyHistoryTotal as number : 0,
    vMoneyHistoryPageCount: version.endsWith("v2") ? input.vMoneyHistoryPageCount as number : 0,
  };
}

function validateSemantics(manifest: Manifest, artifacts: VerifiedArtifact[]): void {
  const pointPages = artifacts.flatMap((entry) => entry.page?.group === "history" ? [entry.page] : []);
  const vMoneyPages = artifacts.flatMap((entry) => entry.page?.group === "vmoney-history" ? [entry.page] : []);
  validatePageSubset(pointPages, manifest.historyTotal, manifest.historyPageCount, "history");
  validatePageSubset(vMoneyPages, manifest.vMoneyHistoryTotal, manifest.vMoneyHistoryPageCount, "vmoney-history");
  const summaryEntry = artifacts.find((entry) => entry.artifact.dataset === "collection-summary");
  if (summaryEntry?.summary) {
    const expectedVersion = manifest.schemaVersion === V1
      ? "vpoint-collection-summary-v1"
      : "vpoint-collection-summary-v2";
    if (summaryEntry.summary.version !== expectedVersion ||
        summaryEntry.summary.historyTotal !== manifest.historyTotal ||
        summaryEntry.summary.historyPageCount !== manifest.historyPageCount ||
        summaryEntry.summary.vMoneyHistoryTotal !== manifest.vMoneyHistoryTotal ||
        summaryEntry.summary.vMoneyHistoryPageCount !== manifest.vMoneyHistoryPageCount) {
      invalid("summary_manifest_mismatch");
    }
  }
}

function validatePageSubset(
  pages: PageInfo[],
  total: number,
  declaredPages: number,
  group: PageInfo["group"],
): void {
  for (const page of pages) {
    if (page.group !== group || page.total !== total || page.index < 1 || page.index > declaredPages) {
      invalid("artifact_pagination_mismatch");
    }
    const expectedRows = Math.min(PAGE_SIZE, Math.max(total - (page.index - 1) * PAGE_SIZE, 0));
    if (page.rowCount !== expectedRows) invalid("artifact_pagination_mismatch");
  }
}

async function readManifest(bucket: R2Bucket, manifestKey: string): Promise<{
  manifest: Manifest;
  bytes: Uint8Array;
}> {
  if (!MANIFEST_KEY.test(manifestKey)) invalid("manifest_key_invalid");
  const object = await bucket.get(manifestKey);
  if (!object) throw new ImportError(404, "manifest_not_found");
  if (object.size < 1 || object.size > MAX_MANIFEST_BYTES) {
    throw new ImportError(413, "manifest_size_invalid");
  }
  assertJsonContentType(object, "manifest_content_type_mismatch");
  const bytes = new Uint8Array(await object.arrayBuffer());
  assertNativeSha256(object, await sha256Hex(bytes));
  const manifest = parseVPointManifest(bytes, manifestKey);
  assertExactMetadata(object.customMetadata, {
    source: SOURCE,
    status: manifest.status,
    runId: manifest.runId,
  }, "manifest_metadata_mismatch");
  return { manifest, bytes };
}

async function readVerifiedArtifact(
  bucket: R2Bucket,
  artifact: ArtifactManifest,
): Promise<Uint8Array> {
  const object = await bucket.get(artifact.key);
  if (!object) throw new ImportError(409, "artifact_missing");
  if (object.size !== artifact.bytes || object.size < 1 || object.size > MAX_ARTIFACT_BYTES) {
    throw new ImportError(409, "artifact_size_mismatch");
  }
  assertJsonContentType(object, "artifact_content_type_mismatch");
  assertExactMetadata(object.customMetadata, {
    dataset: artifact.dataset,
    sha256: artifact.sha256,
  }, "artifact_metadata_mismatch");
  const bytes = new Uint8Array(await object.arrayBuffer());
  assertNativeSha256(object, artifact.sha256);
  if (await sha256Hex(bytes) !== artifact.sha256) {
    throw new ImportError(409, "artifact_checksum_mismatch");
  }
  return bytes;
}

async function readVerifiedReport(
  bucket: R2Bucket,
  manifest: Manifest,
  summary: ReconciliationSummary,
  verified: VerifiedArtifact[],
): Promise<VerifiedReport> {
  const object = await bucket.get(summary.reportKey);
  if (!object) throw new ImportError(409, "reconciliation_report_missing");
  if (object.size < 1 || object.size > MAX_ARTIFACT_BYTES) {
    throw new ImportError(409, "reconciliation_report_size_invalid");
  }
  assertJsonContentType(object, "reconciliation_report_content_type_mismatch");
  assertExactMetadata(object.customMetadata, {
    source: "v-point-pay-email-reconciliation",
    runId: manifest.runId,
  }, "reconciliation_report_metadata_mismatch");
  const bytes = new Uint8Array(await object.arrayBuffer());
  const sha256 = await sha256Hex(bytes);
  assertNativeSha256(object, sha256);
  await validateReconciliationReport(
    parseJsonConflict(bytes, "reconciliation_report_json_invalid"),
    manifest,
    summary,
    verified,
  );
  return { key: summary.reportKey, bytes, sha256 };
}

async function validateReconciliationReport(
  input: JsonObject,
  manifest: Manifest,
  summary: ReconciliationSummary,
  verified: VerifiedArtifact[],
): Promise<void> {
  exactShapeConflict(input, ["schemaVersion", "runId", "completedAt", "policy", "sources", "entries"],
    "reconciliation_report_shape_invalid");
  if (input.schemaVersion !== "vpoint-pay-email-reconciliation-v1" ||
      input.runId !== manifest.runId) {
    throw new ImportError(409, "reconciliation_report_identity_mismatch");
  }
  let reportCompletedAt: string;
  try {
    reportCompletedAt = instant(input.completedAt, "reconciliation_report_time_invalid");
  } catch {
    throw new ImportError(409, "reconciliation_report_time_invalid");
  }
  const reportDate = reportCompletedAt.slice(0, 10).replaceAll("-", "/");
  if (!summary.reportKey.includes(`/${reportDate}/${manifest.runId}.json`) ||
      reportCompletedAt < manifest.startedAt || reportCompletedAt > manifest.completedAt) {
    throw new ImportError(409, "reconciliation_report_time_mismatch");
  }
  const policy = recordConflict(input.policy, "reconciliation_policy_invalid");
  exactShapeConflict(policy, ["match", "mutation", "ambiguousMatchesRemainUnresolved"],
    "reconciliation_policy_invalid");
  if (typeof policy.match !== "string" ||
      !RECONCILIATION_MATCH_POLICIES.includes(
        policy.match as typeof RECONCILIATION_MATCH_POLICIES[number],
      ) ||
      policy.mutation !== "none" || policy.ambiguousMatchesRemainUnresolved !== true) {
    throw new ImportError(409, "reconciliation_policy_invalid");
  }
  const sources = recordConflict(input.sources, "reconciliation_sources_invalid");
  exactShapeConflict(sources, ["vPointHistory", "vPointPayEmail", "vPointPayApp"],
    "reconciliation_sources_invalid");
  if (sources.vPointHistory !== "current collector run" ||
      sources.vPointPayEmail !== "all normalized archived notifications" ||
      sources.vPointPayApp !== summary.appLedgerStatus) {
    throw new ImportError(409, "reconciliation_sources_invalid");
  }
  if (!Array.isArray(input.entries) || input.entries.length !== summary.emailEventCount ||
      input.entries.length > 100_000) {
    throw new ImportError(409, "reconciliation_entries_invalid");
  }
  const counts = { matched: 0, ambiguous: 0, unmatched: 0, "not-comparable": 0 };
  const ids = new Set<string>();
  const historyFiles = new Map(verified.flatMap((entry) =>
    entry.page?.group === "history" && entry.historyRows
      ? [[filename(entry.artifact.key), entry.historyRows] as const]
      : []));
  for (const value of input.entries) {
    const entry = recordConflict(value, "reconciliation_entry_invalid");
    exactShapeConflict(entry, ["emailEventId", "status", "candidateRows"], "reconciliation_entry_invalid");
    if (typeof entry.emailEventId !== "string" || !SHA256.test(entry.emailEventId) ||
        ids.has(entry.emailEventId) || !Array.isArray(entry.candidateRows) || entry.candidateRows.length > 100) {
      throw new ImportError(409, "reconciliation_entry_invalid");
    }
    ids.add(entry.emailEventId);
    const status = oneOfConflict(entry.status,
      ["matched", "ambiguous", "unmatched", "not-comparable"] as const,
      "reconciliation_entry_status_invalid");
    counts[status] += 1;
    if ((status === "matched" && entry.candidateRows.length !== 1) ||
        (status === "ambiguous" && entry.candidateRows.length < 2) ||
        ((status === "unmatched" || status === "not-comparable") && entry.candidateRows.length !== 0)) {
      throw new ImportError(409, "reconciliation_candidate_count_invalid");
    }
    const candidateIdentities = new Set<string>();
    for (const candidateValue of entry.candidateRows) {
      const candidate = recordConflict(candidateValue, "reconciliation_candidate_invalid");
      exactShapeConflict(candidate, ["source", "index", "fingerprint"], "reconciliation_candidate_invalid");
      const rows = typeof candidate.source === "string"
        ? historyFiles.get(candidate.source)
        : undefined;
      if (!rows || !nonNegativeInteger(candidate.index) || candidate.index >= rows.length ||
          typeof candidate.fingerprint !== "string" || !SHA256.test(candidate.fingerprint)) {
        throw new ImportError(409, "reconciliation_candidate_invalid");
      }
      const identity = `${candidate.source}\u0000${candidate.index}`;
      if (candidateIdentities.has(identity)) {
        throw new ImportError(409, "reconciliation_candidate_duplicate");
      }
      candidateIdentities.add(identity);
      const expectedFingerprint = await sha256Hex(
        new TextEncoder().encode(JSON.stringify(rows[candidate.index])),
      );
      if (candidate.fingerprint !== expectedFingerprint) {
        throw new ImportError(409, "reconciliation_candidate_fingerprint_mismatch");
      }
    }
  }
  if (counts.matched !== summary.matchedCount || counts.ambiguous !== summary.ambiguousCount ||
      counts.unmatched !== summary.unmatchedCount ||
      counts["not-comparable"] !== summary.notComparableCount) {
    throw new ImportError(409, "reconciliation_report_count_mismatch");
  }
}

function sanitizeManifest(bytes: Uint8Array, manifest: Manifest): Uint8Array {
  if (manifest.failures.length === 0) return bytes;
  const input = parseJson(bytes, "manifest_json_invalid");
  const failures = (input.failures as JsonObject[]).map((failure) => ({
    ...failure,
    message: "failure_redacted",
  }));
  return new TextEncoder().encode(JSON.stringify({ ...input, failures }));
}

async function dataDescriptor(options: {
  artifact: ArtifactManifest;
  page?: PageInfo;
  sequence: number;
  fetchUnitId: number;
  historyGroupId?: number;
  vMoneyGroupId?: number;
  completedAt: string;
  schemaVersion: SchemaVersion;
  fingerprintKey: string;
}): Promise<JsonObject> {
  const summary = options.artifact.dataset === "collection-summary";
  const pageGroupId = options.page?.group === "history"
    ? options.historyGroupId
    : options.page?.group === "vmoney-history" ? options.vMoneyGroupId : undefined;
  return {
    artifactKey: filename(options.artifact.key),
    artifactRole: summary ? "collector_summary" : "collector_derived",
    payloadFidelity: summary ? "generated" : "transformed",
    containerKind: "single",
    lineageDisposition: summary ? "not_applicable" : "source_bytes_not_available",
    dataset: options.artifact.dataset,
    formatId: `vpoint-${options.artifact.dataset}-json`,
    formatVersion: options.schemaVersion,
    declaredMediaType: "application/json",
    mediaTypeBasis: "operator",
    fetchedAtMs: Date.parse(options.completedAt),
    fetchedAtBasis: "manifest",
    fetchUnitId: options.fetchUnitId,
    ...(pageGroupId === undefined ? {} : {
      pageGroupId,
      pageIndex: (options.page?.index ?? 1) - 1,
    }),
    sequence: options.sequence,
    sha256: options.artifact.sha256,
    byteSize: options.artifact.bytes,
    storage: await storageOrigin(
      options.artifact.key,
      STORAGE_CONTAINER,
      STORAGE_TEMPLATE,
      options.fingerprintKey,
    ),
    ...(summary ? {} : {
      transformSteps: ["transport_decoded", "reencoded"].map((stepKind, stepIndex) => ({
        stepIndex,
        stepKind,
        transformerId: "vpoint-worker",
        transformerVersion: options.schemaVersion,
      })),
    }),
  };
}

async function reconciliationDescriptor(options: {
  report: VerifiedReport;
  sequence: number;
  fetchUnitId: number;
  completedAt: string;
  fingerprintKey: string;
}): Promise<JsonObject> {
  return {
    artifactKey: "vpoint-pay-email-reconciliation.json",
    artifactRole: "collector_summary",
    payloadFidelity: "generated",
    containerKind: "single",
    lineageDisposition: "not_applicable",
    dataset: "v-point-pay-email-reconciliation",
    formatId: "vpoint-pay-email-reconciliation-json",
    formatVersion: "vpoint-pay-email-reconciliation-v1",
    declaredMediaType: "application/json",
    mediaTypeBasis: "operator",
    fetchedAtMs: Date.parse(options.completedAt),
    fetchedAtBasis: "manifest",
    fetchUnitId: options.fetchUnitId,
    sequence: options.sequence,
    sha256: options.report.sha256,
    byteSize: options.report.bytes.byteLength,
    storage: await storageOrigin(
      options.report.key,
      RECONCILIATION_CONTAINER,
      RECONCILIATION_TEMPLATE,
      options.fingerprintKey,
    ),
  };
}

async function manifestDescriptor(options: {
  bytes: number;
  sha256: string;
  sequence: number;
  key: string;
  completedAt: string;
  schemaVersion: SchemaVersion;
  fingerprintKey: string;
}): Promise<JsonObject> {
  return {
    artifactKey: "manifest.json",
    artifactRole: "collector_manifest",
    payloadFidelity: "generated",
    containerKind: "single",
    lineageDisposition: "source_bytes_not_available",
    dataset: "collector-manifest",
    formatId: "vpoint-collector-manifest-json",
    formatVersion: "vpoint-central-manifest-v2",
    declaredMediaType: "application/json",
    mediaTypeBasis: "operator",
    fetchedAtMs: Date.parse(options.completedAt),
    fetchedAtBasis: "manifest",
    sequence: options.sequence,
    sha256: options.sha256,
    byteSize: options.bytes,
    storage: await storageOrigin(
      options.key,
      STORAGE_CONTAINER,
      STORAGE_TEMPLATE,
      options.fingerprintKey,
    ),
  };
}

async function storageOrigin(
  key: string,
  containerName: string,
  objectKeyTemplate: string,
  fingerprintKey: string,
): Promise<JsonObject> {
  if (!SHA256.test(fingerprintKey)) {
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
    containerName,
    objectKeyTemplate,
    objectKeyFingerprint: bytesHex(new Uint8Array(signature)),
    fingerprintKeyVersion: FINGERPRINT_VERSION,
    redactionVersion: "v1",
  };
}

function safeFailureCode(failures: Failure[]): string {
  if (failures.length !== 1) return "multiple-collector-failures";
  const failure = failures[0]!;
  if (failure.operation === "r2") return "staging-write-failed";
  if (failure.operation === "reconcile") return "reconciliation-failed";
  if (failure.errorType === "VPointReauthenticationPendingError") return "reauthentication-pending";
  if (failure.errorType === "VPointSessionExpiredError") return "session-expired";
  return "collector-request-failed";
}

function expectedDatasets(version: SchemaVersion, historyPages: number, vMoneyPages: number): string[] {
  return [
    "balance-info",
    "smfg-point",
    ...Array.from({ length: historyPages }, (_, index) =>
      `history-page-${String(index + 1).padStart(4, "0")}`),
    ...(version === V2
      ? Array.from({ length: vMoneyPages }, (_, index) =>
          `vmoney-history-page-${String(index + 1).padStart(4, "0")}`)
      : []),
    "collection-summary",
  ];
}

function validDataset(value: string, version: SchemaVersion): boolean {
  if (["balance-info", "smfg-point", "collection-summary"].includes(value)) return true;
  const history = HISTORY_DATASET.exec(value);
  if (history) return Number(history[1]) >= 1 && Number(history[1]) <= MAX_HISTORY_PAGES;
  const vMoney = VMONEY_DATASET.exec(value);
  return version === V2 && vMoney !== null && Number(vMoney[1]) >= 1 &&
    Number(vMoney[1]) <= MAX_HISTORY_PAGES;
}

function isOrderedSubset(actual: string[], expected: string[]): boolean {
  let index = 0;
  for (const value of actual) {
    while (index < expected.length && expected[index] !== value) index += 1;
    if (index >= expected.length) return false;
    index += 1;
  }
  return true;
}

async function assertExactPrefix(bucket: R2Bucket, prefix: string, expectedKeys: string[]): Promise<void> {
  const actual: string[] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  do {
    const remaining = expectedKeys.length + 1 - actual.length;
    if (remaining <= 0) throw new ImportError(409, "prefix_inventory_mismatch");
    const listed = await bucket.list({
      prefix,
      limit: Math.min(1_000, remaining),
      ...(cursor ? { cursor } : {}),
    });
    actual.push(...listed.objects.map((object) => object.key));
    if (actual.length > expectedKeys.length) {
      throw new ImportError(409, "prefix_inventory_mismatch");
    }
    if (!listed.truncated) {
      cursor = undefined;
      continue;
    }
    const nextCursor = listed.cursor;
    if (!nextCursor) throw new ImportError(409, "prefix_cursor_missing");
    if (nextCursor === cursor || seenCursors.has(nextCursor)) {
      throw new ImportError(409, "prefix_cursor_stalled");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor);
  actual.sort();
  const expected = [...expectedKeys].sort();
  if (!sameStrings(actual, expected)) throw new ImportError(409, "prefix_inventory_mismatch");
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

function assertJsonContentType(object: R2ObjectBody, code: string): void {
  if (object.httpMetadata?.contentType !== "application/json") throw new ImportError(409, code);
}

function assertNativeSha256(object: R2ObjectBody, expected: string): void {
  const native = object.checksums.sha256;
  if (native && bytesHex(new Uint8Array(native)) !== expected) {
    throw new ImportError(409, "artifact_native_checksum_mismatch");
  }
}

function parseJson(bytes: Uint8Array, code: string): JsonObject {
  try {
    return record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), code);
  } catch (error) {
    if (error instanceof ImportError) throw error;
    invalid(code);
  }
}

function parseJsonConflict(bytes: Uint8Array, code: string): JsonObject {
  try {
    return recordConflict(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), code);
  } catch (error) {
    if (error instanceof ImportError) throw error;
    throw new ImportError(409, code);
  }
}

function record(value: unknown, code: string): JsonObject {
  if (!isRecord(value)) invalid(code);
  return value;
}

function recordConflict(value: unknown, code: string): JsonObject {
  if (!isRecord(value)) throw new ImportError(409, code);
  return value;
}

function exactShape(value: JsonObject, keys: string[], optional: string[] = []): void {
  const actual = Object.keys(value).sort();
  const allowed = [...keys].sort();
  if (actual.some((key) => !allowed.includes(key)) || keys.some((key) =>
    !optional.includes(key) && !Object.hasOwn(value, key))) invalid("manifest_unknown_field");
}

function exactShapeConflict(value: JsonObject, keys: string[], code: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (!sameStrings(actual, expected)) throw new ImportError(409, code);
}

function oneOf<const T extends readonly string[]>(value: unknown, choices: T, code: string): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) invalid(code);
  return value as T[number];
}

function oneOfConflict<const T extends readonly string[]>(
  value: unknown,
  choices: T,
  code: string,
): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) throw new ImportError(409, code);
  return value as T[number];
}

function count(value: unknown, max: number, code: string, min = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) invalid(code);
  return value as number;
}

function instant(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length > 35) invalid(code);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) invalid(code);
  return value;
}

function safeText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max &&
    !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value);
}

function dateText(value: unknown): value is string {
  return safeText(value, 32) && (value === "" || /^20\d{6}$/u.test(value));
}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return integer(value) && value >= 0;
}

function isRecord(value: unknown): value is JsonObject {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

function filename(key: string): string {
  return key.split("/").at(-1) ?? "";
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function invalid(code: string): never {
  throw new ImportError(400, code);
}

function binaryCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: JsonValue): string {
  return JSON.stringify(canonical(value));
}

function canonical(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => binaryCompare(left, right))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new TypeError("canonical numbers must be safe integers");
  }
  return value;
}

async function descriptorSha256(descriptor: JsonObject): Promise<string> {
  const { http, storage, file, email, ...fields } = descriptor;
  const normalized = {
    ...fields,
    origins: {
      http: http ?? null,
      storage: storage ?? null,
      file: file ?? null,
      email: email ?? null,
    },
  };
  return sha256Hex(new TextEncoder().encode(canonicalJson(normalized as JsonValue)));
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
