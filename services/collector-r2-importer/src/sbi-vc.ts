import { CentralClient, centralDescriptorSha256 } from "./central";
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
export const INGEST_CONTRACT_VERSION = "sbi-vc-r2-v2";
const CENTRAL_CLIENT_ID = "collector-r2-sbi-vc";
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
const MAX_PAGE_COUNT = 100;
const PAGE_SIZE = 30;
const MAX_SYNCHRONOUS_ARTIFACTS = 11;
export const SBI_VC_TRANSFER_CHUNK_SIZE = 8;
const TRANSFER_TOKEN_PREFIX = "sbi-vc-transfer-v1";
const TRANSFER_TOKEN_AAD = new TextEncoder().encode(TRANSFER_TOKEN_PREFIX);
const STORAGE_TEMPLATE = "raw/sbi-vc-trade/{date}/{run-id}/{artifact}.json";
const STORAGE_CONTAINER = "kogane-sbi-vc-trade-poc";
const FINGERPRINT_VERSION = "collector-r2-v1";
const MANIFEST_KEY =
  /^raw\/sbi-vc-trade\/(\d{4})\/(\d{2})\/(\d{2})\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/manifest\.json$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const ERROR_CODE = /^[a-z0-9_]{1,100}$/u;
const PAGINATION_EVIDENCE_ERROR =
  /^(?:executions_recent_(?:invalid_pagination|page_limit_exceeded|pagination_length_mismatch)|(?:executions_historical|cashflows_historical)_(?:invalid_pagination|pagination_total_changed|pagination_length_mismatch))$/u;
const STATIC_DATASETS = [
  "cash-balances",
  "account-margin",
  "position-summary",
  "executions-recent-page-0001",
] as const;
const HISTORICAL_EXECUTION = /^executions-historical-page-(\d{4})$/u;
const HISTORICAL_CASHFLOW = /^cashflows-historical-page-(\d{4})$/u;

type JsonObject = Record<string, unknown>;
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type PageGroup = "executions-historical" | "cashflows-historical";
type IdentityGroup =
  | "position-summary"
  | "executions-recent"
  | "executions-historical"
  | "cashflows-historical";

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

interface ArtifactPlan {
  source: SbiVcArtifactManifest | null;
  bytes: Uint8Array | null;
  sha256: string;
  descriptor: JsonObject;
  inventory: CentralInventoryItem;
}

interface TransferState {
  v: 1;
  manifestKey: string;
  sourceManifestSha256: string;
  centralRunId: number;
  unitId: number;
  inventoryId: number;
  inventorySha256: string;
  offset: number;
  allObjectsReused: boolean;
}

export type ImportSbiVcRunResult = ImportSbiVcRunDeferred | ImportSbiVcRunSealed;

export interface ImportSbiVcRunDeferred {
  source: typeof SOURCE;
  manifestKey: string;
  status: "deferred";
  reason: "worker_invocation_limit";
  artifactCount: number;
  nextOffset: number;
  continuation: string;
  allObjectsReused?: never;
}

export interface ImportSbiVcRunSealed {
  source: typeof SOURCE;
  manifestKey: string;
  status: "sealed";
  centralRunId: number;
  artifactCount: number;
  sealed: true;
  allObjectsReused: boolean;
  finalChunkAllObjectsReused: boolean;
}

export async function importSbiVcRun(options: {
  bucket: R2Bucket;
  centralService: Fetcher;
  centralToken: string;
  fingerprintKey: string;
  importerVersion: string;
  manifestKey: string;
  continuation?: string;
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
    assertExactMetadata(
      manifestObject.customMetadata,
      {
        source: manifest.source,
        runId: manifest.runId,
        status: manifest.status,
      },
      "manifest_metadata_mismatch",
    );
    expectedArtifactCount = manifest.artifacts.length + 1;
    const prefix = options.manifestKey.slice(0, -"manifest.json".length);

    phase = "prefix_validation";
    await assertExactPrefix(options.bucket, prefix, [
      ...manifest.artifacts.map((artifact) => artifact.key),
      options.manifestKey,
    ]);

    // The largest valid run has 204 four-MiB artifacts. Validate sequentially
    // and retain only bounded page metadata and provider identities so the
    // Worker never buffers a whole run of source bytes.
    phase = "artifact_validation";
    const verifiedArtifacts: VerifiedArtifact[] = [];
    const providerIdentityDigests = new Map<IdentityGroup, Set<string>>();
    const collectFailureEvidenceIndex =
      manifest.failures.length === 1 &&
      manifest.failures[0]?.operation === "collect" &&
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
        ...(await parseStoredEnvelope(bytes, artifact.dataset, providerIdentityDigests)),
      });
    }
    validateFailureComplement(manifest, verifiedArtifacts);

    // Repeat the inventory boundary immediately before creating central state.
    await assertExactPrefix(options.bucket, prefix, [
      ...manifest.artifacts.map((artifact) => artifact.key),
      options.manifestKey,
    ]);

    const central = new CentralClient(
      options.centralService,
      options.centralToken,
      CENTRAL_CLIENT_ID,
    );
    const manifestSha256 = await sha256Hex(manifestBytes);
    let state: TransferState;
    if (options.continuation) {
      state = await decodeTransferState(options.continuation, options.fingerprintKey);
      validateTransferState(state, options.manifestKey, manifestSha256, expectedArtifactCount);
      centralRunId = state.centralRunId;
    } else {
      phase = "central_create";
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
      phase = "inventory_plan";
      const initialPlans = await artifactPlans(
        verifiedArtifacts,
        manifest,
        manifestBytes,
        manifestSha256,
        unitId,
        options.manifestKey,
        options.fingerprintKey,
      );
      const inventory = sortedInventory(initialPlans);
      const inventorySha256 = await sha256Hex(
        new TextEncoder().encode(canonicalJson(inventory as unknown as JsonValue)),
      );
      state = {
        v: 1,
        manifestKey: options.manifestKey,
        sourceManifestSha256: manifestSha256,
        centralRunId,
        unitId,
        inventoryId: await central.beginInventory(centralRunId, inventorySha256, inventory.length),
        inventorySha256,
        offset: 0,
        allObjectsReused: true,
      };
    }

    phase = "inventory_plan";
    const plans = await artifactPlans(
      verifiedArtifacts,
      manifest,
      manifestBytes,
      manifestSha256,
      state.unitId,
      options.manifestKey,
      options.fingerprintKey,
    );
    const inventory = sortedInventory(plans);
    const inventorySha256 = await sha256Hex(
      new TextEncoder().encode(canonicalJson(inventory as unknown as JsonValue)),
    );
    if (inventorySha256 !== state.inventorySha256) {
      throw new ImportError(409, "transfer_inventory_mismatch");
    }
    const chunkSize =
      options.continuation === undefined && manifest.artifacts.length <= MAX_SYNCHRONOUS_ARTIFACTS
        ? plans.length
        : SBI_VC_TRANSFER_CHUNK_SIZE;
    const end = Math.min(state.offset + chunkSize, plans.length);
    if (end <= state.offset) throw new ImportError(409, "transfer_cursor_did_not_advance");
    const chunkInventory: CentralInventoryItem[] = [];
    for (const plan of plans.slice(state.offset, end)) {
      phase = "object_upload";
      const bytes = plan.source
        ? await readVerifiedArtifact(options.bucket, plan.source)
        : plan.bytes!;
      const reused = await central.uploadObject(state.centralRunId, plan.sha256, bytes);
      if (reused) reusedArtifactCount += 1;
      else acceptedArtifactCount += 1;

      phase = "artifact_catalogue";
      const descriptorSha256 = await central.addArtifact(state.centralRunId, plan.descriptor);
      if (descriptorSha256 !== plan.inventory.descriptorSha256) {
        throw new Error("central_descriptor_mismatch");
      }
      chunkInventory.push(plan.inventory);
    }
    phase = "inventory_catalogue";
    await central.addInventoryItems(state.centralRunId, state.inventoryId, chunkInventory);
    if (end < plans.length) {
      return {
        source: SOURCE,
        manifestKey: options.manifestKey,
        status: "deferred",
        reason: "worker_invocation_limit",
        artifactCount: plans.length,
        nextOffset: end,
        continuation: await encodeTransferState(
          {
            ...state,
            offset: end,
            allObjectsReused: state.allObjectsReused && acceptedArtifactCount === 0,
          },
          options.fingerprintKey,
        ),
      };
    }

    phase = "unit_report";
    await central.addUnitReport(state.unitId, {
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
    await central.addRunReport(state.centralRunId, {
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
    await central.sealStagedInventory(
      state.centralRunId,
      state.inventoryId,
      attemptId,
      startedAtMs,
    );
    return {
      source: SOURCE,
      manifestKey: options.manifestKey,
      status: "sealed",
      centralRunId: state.centralRunId,
      artifactCount: inventory.length,
      sealed: true,
      allObjectsReused: state.allObjectsReused && acceptedArtifactCount === 0,
      finalChunkAllObjectsReused: acceptedArtifactCount === 0,
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
    "schemaVersion",
    "source",
    "runId",
    "startedAt",
    "completedAt",
    "status",
    "artifacts",
    "failures",
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
  const expectedStatus =
    failures.length === 0 ? "success" : artifacts.length === 0 ? "failed" : "partial";
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
  if (
    !Number.isSafeInteger(input.bytes) ||
    (input.bytes as number) < 1 ||
    (input.bytes as number) > MAX_ARTIFACT_BYTES
  ) {
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
  if (
    typeof input.operation !== "string" ||
    !(
      input.operation === "load_session" ||
      input.operation === "collect" ||
      input.operation === "persist_session" ||
      input.operation.startsWith("r2_")
    )
  ) {
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

function validateFailureComplement(manifest: SbiVcManifest, artifacts: VerifiedArtifact[]): void {
  if (manifest.failures.length === 0) {
    const nextDataset = nextExpectedDataset(artifacts);
    if (nextDataset !== null) invalid("manifest_dataset_completeness_mismatch");
    return;
  }
  const operation = manifest.failures[0]!.operation;
  const last = artifacts.at(-1);
  if (
    operation === "collect" &&
    PAGINATION_EVIDENCE_ERROR.test(manifest.failures[0]!.errorCode) &&
    last?.failureEvidence
  ) {
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
  const executions = artifacts.filter((entry) => HISTORICAL_EXECUTION.test(entry.artifact.dataset));
  if (executions.length === 0) return pageDataset("executions-historical", 1);
  assertPageChain(executions);
  const lastExecution = requiredPage(executions.at(-1));
  const cashflows = artifacts.filter((entry) => HISTORICAL_CASHFLOW.test(entry.artifact.dataset));
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

export async function parseStoredEnvelope(
  bytes: Uint8Array,
  dataset: string,
  providerIdentityDigests: Map<IdentityGroup, Set<string>>,
): Promise<{ page?: PageInfo }> {
  const envelope = storedEnvelope(bytes);
  if (dataset === "position-summary") {
    // Position summary has no page siblings. Check raw identities inside the
    // bounded 4 MiB object and discard them with the parsed envelope.
    const identities = new Set<string>();
    for (const group of Object.values(recordConflict(envelope.body, "artifact_payload_invalid"))) {
      const positions = recordConflict(group, "artifact_payload_invalid");
      for (const value of Object.values(positions)) {
        const position = recordConflict(value, "artifact_payload_invalid");
        const identity = nonEmptyString(position.productId, "artifact_provider_identity_invalid");
        if (identities.has(identity)) duplicateProviderIdentity();
        identities.add(identity);
      }
    }
    return {};
  }
  const group = pageGroup(dataset);
  const recentExecution = dataset === "executions-recent-page-0001";
  if (!group && !recentExecution) return {};
  const body = recordConflict(envelope.body, "artifact_page_payload_invalid");
  if (!Array.isArray(body.list) || body.list.length > PAGE_SIZE) {
    throw new ImportError(409, "artifact_page_payload_invalid");
  }
  const totalSize = nonNegativeInteger(body.totalSize);
  const pageNumber = nonNegativeInteger(body.pageNumber);
  const pageSize = nonNegativeInteger(body.pageSize);
  const totalNumOfPages = nonNegativeInteger(body.totalNumOfPages);
  if (
    totalSize === null ||
    pageNumber === null ||
    pageSize !== PAGE_SIZE ||
    totalNumOfPages !== Math.ceil(totalSize / PAGE_SIZE)
  ) {
    throw new ImportError(409, "artifact_page_payload_invalid");
  }
  if (recentExecution) {
    if (pageNumber !== 0 || totalSize > PAGE_SIZE || body.list.length !== totalSize) {
      throw new ImportError(409, "artifact_page_payload_invalid");
    }
    assertUniqueLocalIdentities(executionIdentities(body.list));
    return {};
  }
  if (!group) return {};
  const match = (
    group === "executions-historical" ? HISTORICAL_EXECUTION : HISTORICAL_CASHFLOW
  ).exec(dataset);
  if (!match) throw new ImportError(409, "artifact_page_dataset_invalid");
  const index = Number(match[1]);
  if (pageNumber !== index - 1) {
    throw new ImportError(409, "artifact_page_payload_invalid");
  }
  await recordProviderIdentityDigests(
    providerIdentityDigests,
    group,
    group === "executions-historical"
      ? executionIdentities(body.list)
      : cashflowIdentities(body.list),
  );
  return {
    page: {
      group,
      index,
      listLength: body.list.length,
      totalSize,
    },
  };
}

function executionIdentities(list: unknown[]): string[] {
  return list.map((value) => {
    const row = recordConflict(value, "artifact_payload_invalid");
    return JSON.stringify([
      nonEmptyString(row.CExecutionId, "artifact_provider_identity_invalid"),
      nonEmptyString(row.CExecutionIdSubNo, "artifact_provider_identity_invalid"),
    ]);
  });
}

function cashflowIdentities(list: unknown[]): string[] {
  return list.map((value) => {
    const row = recordConflict(value, "artifact_payload_invalid");
    return nonEmptyString(row.cashflowID, "artifact_provider_identity_invalid");
  });
}

function nonEmptyString(value: unknown, code: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ImportError(409, code);
  }
  return value;
}

function assertUniqueLocalIdentities(identities: string[]): void {
  const seen = new Set<string>();
  for (const identity of identities) {
    if (seen.has(identity)) duplicateProviderIdentity();
    seen.add(identity);
  }
}

async function recordProviderIdentityDigests(
  seen: Map<IdentityGroup, Set<string>>,
  group: IdentityGroup,
  identities: string[],
): Promise<void> {
  let groupDigests = seen.get(group);
  if (!groupDigests) {
    groupDigests = new Set<string>();
    seen.set(group, groupDigests);
  }
  for (const identity of identities) {
    const digest = await sha256Hex(new TextEncoder().encode(identity));
    if (groupDigests.has(digest)) duplicateProviderIdentity();
    groupDigests.add(digest);
  }
}

function duplicateProviderIdentity(): never {
  throw new ImportError(409, "artifact_duplicate_provider_identity");
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
    const previousCursor = cursor;
    const listed = await bucket.list({
      prefix,
      limit: Math.min(expectedKeys.length + 1, 1_000),
      ...(cursor ? { cursor } : {}),
    });
    if (actual.length + listed.objects.length > expectedKeys.length) {
      throw new ImportError(409, "prefix_inventory_mismatch");
    }
    actual.push(...listed.objects.map((object) => object.key));
    cursor = listed.truncated ? listed.cursor : undefined;
    if (listed.truncated && !cursor) throw new ImportError(409, "prefix_cursor_missing");
    if (cursor && cursor === previousCursor) {
      throw new ImportError(409, "prefix_cursor_did_not_advance");
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
  if ((await sha256Hex(bytes)) !== artifact.sha256) {
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

async function artifactPlans(
  artifacts: VerifiedArtifact[],
  manifest: SbiVcManifest,
  manifestBytes: Uint8Array,
  manifestSha256: string,
  unitId: number,
  manifestKey: string,
  fingerprintKey: string,
): Promise<ArtifactPlan[]> {
  const plans: ArtifactPlan[] = [];
  for (const [sequence, verified] of artifacts.entries()) {
    const descriptor = await dataDescriptor({
      artifact: verified.artifact,
      sequence,
      fetchUnitId: unitId,
      completedAt: manifest.completedAt,
      fingerprintKey,
    });
    plans.push({
      source: verified.artifact,
      bytes: null,
      sha256: verified.artifact.sha256,
      descriptor,
      inventory: {
        artifactKey: `${verified.artifact.dataset}.json`,
        sha256: verified.artifact.sha256,
        descriptorSha256: await centralDescriptorSha256(descriptor),
      },
    });
  }
  const descriptor = await manifestDescriptor({
    bytes: manifestBytes.byteLength,
    sha256: manifestSha256,
    sequence: manifest.artifacts.length,
    key: manifestKey,
    completedAt: manifest.completedAt,
    fingerprintKey,
  });
  plans.push({
    source: null,
    bytes: manifestBytes,
    sha256: manifestSha256,
    descriptor,
    inventory: {
      artifactKey: "manifest.json",
      sha256: manifestSha256,
      descriptorSha256: await centralDescriptorSha256(descriptor),
    },
  });
  return plans;
}

function sortedInventory(plans: ArtifactPlan[]): CentralInventoryItem[] {
  return plans
    .map((plan) => plan.inventory)
    .sort((left, right) =>
      left.artifactKey < right.artifactKey ? -1 : left.artifactKey > right.artifactKey ? 1 : 0,
    );
}

async function encodeTransferState(state: TransferState, keyHex: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(canonicalJson(state as unknown as JsonValue));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: ownedArrayBuffer(iv),
      additionalData: ownedArrayBuffer(TRANSFER_TOKEN_AAD),
      tagLength: 128,
    },
    await transferEncryptionKey(keyHex),
    ownedArrayBuffer(plaintext),
  );
  return `${TRANSFER_TOKEN_PREFIX}.${base64Url(iv)}.${base64Url(new Uint8Array(ciphertext))}`;
}

async function decodeTransferState(token: string, keyHex: string): Promise<TransferState> {
  if (token.length > 8_000) throw new ImportError(400, "transfer_token_invalid");
  const parts = token.split(".");
  if (
    parts.length !== 3 ||
    parts[0] !== TRANSFER_TOKEN_PREFIX ||
    !/^[A-Za-z0-9_-]{16}$/u.test(parts[1]!) ||
    !/^[A-Za-z0-9_-]{22,7900}$/u.test(parts[2]!)
  ) {
    throw new ImportError(400, "transfer_token_invalid");
  }
  let parsed: unknown;
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: ownedArrayBuffer(fromBase64Url(parts[1]!)),
        additionalData: ownedArrayBuffer(TRANSFER_TOKEN_AAD),
        tagLength: 128,
      },
      await transferEncryptionKey(keyHex),
      ownedArrayBuffer(fromBase64Url(parts[2]!)),
    );
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
  } catch {
    throw new ImportError(400, "transfer_token_invalid");
  }
  const input = record(parsed, "transfer_token_invalid");
  const allowed = [
    "v",
    "manifestKey",
    "sourceManifestSha256",
    "centralRunId",
    "unitId",
    "inventoryId",
    "inventorySha256",
    "offset",
    "allObjectsReused",
  ];
  if (Object.keys(input).length !== allowed.length) {
    throw new ImportError(400, "transfer_token_invalid");
  }
  exactKeys(input, allowed);
  if (
    input.v !== 1 ||
    typeof input.manifestKey !== "string" ||
    !MANIFEST_KEY.test(input.manifestKey) ||
    typeof input.sourceManifestSha256 !== "string" ||
    !SHA256.test(input.sourceManifestSha256) ||
    !positiveInteger(input.centralRunId) ||
    !positiveInteger(input.unitId) ||
    !positiveInteger(input.inventoryId) ||
    typeof input.inventorySha256 !== "string" ||
    !SHA256.test(input.inventorySha256) ||
    !positiveInteger(input.offset) ||
    (input.offset as number) > 205 ||
    typeof input.allObjectsReused !== "boolean"
  ) {
    throw new ImportError(400, "transfer_token_invalid");
  }
  return input as unknown as TransferState;
}

function validateTransferState(
  state: TransferState,
  manifestKey: string,
  sourceManifestSha256: string,
  expectedArtifactCount: number,
): void {
  if (
    state.manifestKey !== manifestKey ||
    state.sourceManifestSha256 !== sourceManifestSha256 ||
    state.offset >= expectedArtifactCount
  ) {
    throw new ImportError(400, "transfer_state_mismatch");
  }
}

async function transferEncryptionKey(keyHex: string): Promise<CryptoKey> {
  if (!SHA256.test(keyHex)) throw new ImportError(500, "fingerprint_configuration_invalid");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${TRANSFER_TOKEN_PREFIX}\0${keyHex}`),
  );
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("base64url_invalid");
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, "="));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (base64Url(bytes) !== value) throw new Error("base64url_invalid");
  return bytes;
}

function positiveInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function canonicalJson(value: JsonValue): string {
  return JSON.stringify(canonical(value));
}

function canonical(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new TypeError("canonical numbers must be safe integers");
  }
  return value;
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
    transformSteps: ["transport_decoded", "redacted", "reencoded"].map((stepKind, stepIndex) => ({
      stepIndex,
      stepKind,
      transformerId: "sbi-vc-trade-worker",
      transformerVersion: SCHEMA_VERSION,
    })),
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
  return typeof number === "number" && Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function assertExactMetadata(
  actual: Record<string, string> | undefined,
  expected: Record<string, string>,
  code: string,
): void {
  if (!actual) throw new ImportError(409, code);
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index] || actual[key] !== expected[key])
  ) {
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
    return (
      actualKeys.length === expectedKeys.length &&
      actualKeys.every((key, index) => key === expectedKeys[index] && actual[key] === expected[key])
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
