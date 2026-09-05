import { CentralClient } from "./central";
import { ImportError } from "./error";
import type { CentralInventoryItem } from "./types";

const EXTERNAL_SOURCE = "prestia-globalpass" as const;
const CENTRAL_SOURCE = "global-pass";
const PRODUCER = "collector-r2-importer";
const V1 = "globalpass-browser-poc-v1" as const;
const V2 = "globalpass-browser-poc-v2" as const;
const CENTRAL_CLIENT_ID = "collector-r2-global-pass";
const INGEST_CONTRACT_VERSION = "global-pass-r2-v2";
const STORAGE_CONTAINER = "kogane-globalpass-collector-poc";
const STORAGE_TEMPLATE = "raw/prestia-globalpass/{date}/{run-id}/{artifact}";
const FINGERPRINT_VERSION = "collector-r2-v1";
const DATASET = "globalpass-activity" as const;
const SENTINEL = "__KOGANE_REDACTED_DYNAMIC_VALUE__";
const STATIC_FORM_ACTION =
  "https://www.debit.vpass.ne.jp/p/statementInquiry/RW1313010301";
const SAME_HOST = "https://www.debit.vpass.ne.jp";
const ALLOWED_LINK_HREF_PATHS = new Set([
  "/en//01006/css/master.css",
  "/en//01006/css/nablarch.css",
  "/en//01006/css/normalize.css",
  "/en//01006/img/favicon.ico",
]);
const ALLOWED_ANCHOR_HREF_PATHS = new Set([
  "/p/cashBackInquiry/RW1322010101",
  "/p/chgAccountSetting/RW1315000101",
  "/p/chgAccountSetting/RW1315000102",
  "/p/chgControlRule/RW1315KY0101",
  "/p/chgIdPass/RW1315010101",
  "/p/chgLimit/RW1315030101",
  "/p/chgStopRelease/RW1315040101",
  "/p/contact/RW13K1010101",
  "/p/login/RW1312010201",
  "/p/login/RW1312010301",
  "/p/statementInquiry/RW1313010101",
  "/p/statementInquiry/RW1313010201",
]);
const ALLOWED_IMG_SRC_PATHS = new Set([
  "/en/01006/img/logo.jpg",
]);
const ALLOWED_SCRIPT_SRC_PATHS = new Set([
  "/js/jquery.js",
  "/js/run.js",
  "/js/TabindexOrder.js",
  "/js/W131301.js",
]);
const BLOCKED_NETWORK_ELEMENTS = new Set([
  "applet", "audio", "base", "embed", "fencedframe", "frame", "frameset",
  "iframe", "object", "portal", "source", "svg", "track", "video",
]);
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_MONTHS = 15;
export const GLOBAL_PASS_TRANSFER_CHUNK_SIZE = 10;
const GLOBAL_PASS_DIRECT_ARTIFACT_LIMIT = 12;
const MANIFEST_KEY = /^raw\/prestia-globalpass\/(\d{4})\/(\d{2})\/(\d{2})\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/manifest\.json$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_ERROR_TYPE = /^[A-Za-z][A-Za-z0-9]{0,79}$/u;
const SAFE_CODE = /^[a-z][a-z0-9_]{0,99}$/u;
const ACTIVITY_MARKER = /(?:ご利用明細|利用明細)/u;
const FORBIDDEN_INLINE = /(?:;jsessionid|token|csrf|turnstile|session|localStorage)/iu;

type JsonObject = Record<string, unknown>;
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type SchemaVersion = typeof V1 | typeof V2;
type Status = "success" | "partial" | "failed";
type Mode = "daily" | "backfill";

interface Artifact {
  dataset: typeof DATASET;
  month: string;
  key: string;
  mediaType: "text/html";
  bytes: number;
  sha256: string;
}

interface Failure {
  operation: "browser-collection" | "contract" | "sanitization" | "r2";
  errorType: string;
  errorCode: "browser_collection_failed" | "container_contract_invalid" |
    "html_sanitization_failed" | "artifact_store_failed" | "selected_month_missing";
  artifactKey?: string;
}

interface Manifest {
  schemaVersion: SchemaVersion;
  source: typeof EXTERNAL_SOURCE;
  runtimeRevision?: string;
  runId: string;
  mode: Mode;
  startedAt: string;
  completedAt: string;
  status: Status;
  availableMonths: string[];
  selectedMonths: string[];
  captureComplete: boolean;
  paginationStatus: "unproven";
  artifacts: Artifact[];
  failures: Failure[];
}

interface LoadedManifest {
  manifest: Manifest;
  centralBytes: Uint8Array;
  centralSha256: string;
}

interface VerifiedArtifact {
  artifact: Artifact;
  centralBytes: Uint8Array;
  centralSha256: string;
}

interface ArtifactPlan {
  source: Artifact | null;
  centralBytes: Uint8Array;
  sha256: string;
  descriptor: JsonObject;
  inventory: CentralInventoryItem;
}

export type ImportGlobalPassResult = ImportGlobalPassDeferred | ImportGlobalPassSealed;

export interface ImportGlobalPassDeferred {
  source: typeof EXTERNAL_SOURCE;
  manifestKey: string;
  status: "deferred";
  reason: "worker_invocation_limit";
  artifactCount: number;
  nextOffset: number;
}

export interface ImportGlobalPassSealed {
  source: typeof EXTERNAL_SOURCE;
  manifestKey: string;
  status: "sealed";
  centralRunId: number;
  artifactCount: number;
  sealed: true;
  finalChunkAllObjectsReused: boolean;
}

export async function importGlobalPassRun(options: {
  bucket: R2Bucket;
  centralService: Fetcher;
  centralToken: string;
  fingerprintKey: string;
  importerVersion: string;
  manifestKey: string;
  offset?: number;
  immediate?: boolean;
}): Promise<ImportGlobalPassResult> {
  const startedAtMs = Date.now();
  const attemptId = `attempt-${crypto.randomUUID()}`;
  let centralRunId: number | undefined;
  let acceptedArtifactCount = 0;
  let reusedArtifactCount = 0;
  let expectedArtifactCount = 0;
  let phase = "manifest_validation";
  try {
    const loaded = await loadManifest(options.bucket, options.manifestKey);
    const manifest = loaded.manifest;
    const prefix = options.manifestKey.slice(0, -"manifest.json".length);
    expectedArtifactCount = manifest.artifacts.length + 1;
    const offset = options.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > expectedArtifactCount) {
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
      const sourceBytes = await readVerifiedArtifact(
        options.bucket,
        artifact,
        manifest,
      );
      const centralBytes = sanitizeGlobalPassHtml(sourceBytes, manifest.schemaVersion);
      verified.push({
        artifact,
        centralBytes,
        centralSha256: await sha256Hex(centralBytes),
      });
    }
    await assertExactPrefix(options.bucket, prefix, [
      ...manifest.artifacts.map((artifact) => artifact.key),
      options.manifestKey,
    ]);

    if (options.immediate !== false && offset === 0 &&
        expectedArtifactCount > GLOBAL_PASS_DIRECT_ARTIFACT_LIMIT) {
      return deferredResult(options.manifestKey, expectedArtifactCount, 0);
    }

    phase = "central_create";
    const central = new CentralClient(
      options.centralService,
      options.centralToken,
      CENTRAL_CLIENT_ID,
    );
    centralRunId = await central.createRun({
      producerId: PRODUCER,
      sourceId: CENTRAL_SOURCE,
      externalIdNamespace: manifest.schemaVersion,
      externalSessionId: manifest.runId,
      sourceRunKey: `activity-${INGEST_CONTRACT_VERSION}`,
    });
    const unitId = await central.addUnit(centralRunId, {
      unitKind: "collection",
      unitKey: "account",
      terminalReportRequired: true,
    });

    phase = "inventory_plan";
    const plans = await artifactPlans(
      verified,
      loaded,
      unitId,
      manifest,
      options.manifestKey,
      options.fingerprintKey,
    );
    const staged = options.immediate === false;
    if (staged) {
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
      const end = Math.min(offset + GLOBAL_PASS_TRANSFER_CHUNK_SIZE, plans.length);
      const chunkInventory: CentralInventoryItem[] = [];
      for (const plan of plans.slice(offset, end)) {
        const centralBytes = await currentCentralBytes(options.bucket, plan, manifest);
        phase = "object_upload";
        const reused = await central.uploadObject(centralRunId, plan.sha256, centralBytes);
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
        return deferredResult(options.manifestKey, plans.length, end);
      }
      await addTerminalReports(central, centralRunId, unitId, manifest, plans.length,
        options.importerVersion);
      phase = "seal";
      await central.sealStagedInventory(centralRunId, inventoryId, attemptId, startedAtMs);
      return sealedResult(
        options.manifestKey,
        centralRunId,
        plans.length,
        acceptedArtifactCount === 0,
      );
    }

    const inventory: CentralInventoryItem[] = [];
    for (const plan of plans) {
      phase = "object_upload";
      const centralBytes = await currentCentralBytes(options.bucket, plan, manifest);
      const reused = await central.uploadObject(centralRunId, plan.sha256, centralBytes);
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
    await addTerminalReports(central, centralRunId, unitId, manifest, plans.length,
      options.importerVersion);
    phase = "seal";
    await central.seal(centralRunId, inventory, attemptId, startedAtMs);
    return sealedResult(options.manifestKey, centralRunId, inventory.length,
      acceptedArtifactCount === 0);
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
        // Best effort only; preserve the original failure.
      }
    }
    throw error;
  }
}

function deferredResult(
  manifestKey: string,
  artifactCount: number,
  nextOffset: number,
): ImportGlobalPassDeferred {
  return {
    source: EXTERNAL_SOURCE,
    manifestKey,
    status: "deferred",
    reason: "worker_invocation_limit",
    artifactCount,
    nextOffset,
  };
}

function sealedResult(
  manifestKey: string,
  centralRunId: number,
  artifactCount: number,
  finalChunkAllObjectsReused: boolean,
): ImportGlobalPassSealed {
  return {
    source: EXTERNAL_SOURCE,
    manifestKey,
    status: "sealed",
    centralRunId,
    artifactCount,
    sealed: true,
    finalChunkAllObjectsReused,
  };
}

async function addTerminalReports(
  central: CentralClient,
  centralRunId: number,
  unitId: number,
  manifest: Manifest,
  artifactCount: number,
  importerVersion: string,
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
    declaredArtifactCount: manifest.artifacts.length,
    artifactCountScope: "direct",
    ...(manifest.failures.length > 0
      ? { safeFailureCode: safeFailureCode(manifest.failures) }
      : {}),
  });
  await central.addRunReport(centralRunId, {
    reportKey: "terminal",
    reportKind: "terminal",
    producerVersion: importerVersion,
    manifestSchemaVersion: manifest.schemaVersion,
    producerStatus: manifest.status,
    normalizedOutcome: manifest.status,
    startedAtMs: Date.parse(manifest.startedAt),
    startedAtBasis: "manifest",
    completedAtMs: Date.parse(manifest.completedAt),
    completedAtBasis: "manifest",
    declaredArtifactCount: artifactCount,
    artifactCountScope: "all_catalogued",
  });
}

async function loadManifest(bucket: R2Bucket, manifestKey: string): Promise<LoadedManifest> {
  const object = await bucket.get(manifestKey);
  if (!object) throw new ImportError(404, "manifest_not_found");
  if (object.size > MAX_MANIFEST_BYTES) throw new ImportError(413, "manifest_too_large");
  if (mediaTypeBase(object.httpMetadata?.contentType) !== "application/json") {
    throw new ImportError(409, "manifest_content_type_mismatch");
  }
  const sourceBytes = new Uint8Array(await object.arrayBuffer());
  const sourceSha256 = await sha256Hex(sourceBytes);
  assertNativeSha256(object, sourceSha256);
  const manifest = parseGlobalPassManifest(sourceBytes, manifestKey);
  assertExactMetadata(object.customMetadata, {
    source: EXTERNAL_SOURCE,
    status: manifest.status,
    runId: manifest.runId,
  }, "manifest_metadata_mismatch");
  const centralBytes = manifest.schemaVersion === V1
    ? sanitizeLegacyManifest(manifest)
    : sourceBytes;
  return {
    manifest,
    centralBytes,
    centralSha256: await sha256Hex(centralBytes),
  };
}

export function parseGlobalPassManifest(bytes: Uint8Array, manifestKey: string): Manifest {
  const key = MANIFEST_KEY.exec(manifestKey);
  if (!key) invalid("manifest_key_invalid");
  const input = parseJson(bytes, "manifest_json_invalid");
  const version = oneOf(input.schemaVersion, [V1, V2] as const, "manifest_schema_invalid");
  const v2 = version === V2;
  exactShape(input, [
    "schemaVersion", "source", "runtimeRevision", "runId", "mode",
    "startedAt", "completedAt", "status", "availableMonths",
    ...(v2 ? ["selectedMonths", "captureComplete", "paginationStatus"] : []),
    "artifacts", "failures",
  ], ["runtimeRevision"]);
  if (input.source !== EXTERNAL_SOURCE || input.runId !== key[4]) {
    invalid("manifest_identity_mismatch");
  }
  const startedAt = instant(input.startedAt, "manifest_started_at_invalid");
  const completedAt = instant(input.completedAt, "manifest_completed_at_invalid");
  if (completedAt < startedAt || startedAt.slice(0, 10) !== `${key[1]}-${key[2]}-${key[3]}`) {
    invalid("manifest_time_invalid");
  }
  const runtimeRevision = input.runtimeRevision === undefined
    ? undefined
    : safeRuntime(input.runtimeRevision);
  const mode = oneOf(input.mode, ["daily", "backfill"] as const, "manifest_mode_invalid");
  const status = oneOf(input.status, ["success", "partial", "failed"] as const, "manifest_status_invalid");
  const availableMonths = months(input.availableMonths, true, "manifest_available_months_invalid");
  const selectedMonths = v2
    ? months(input.selectedMonths, true, "manifest_selected_months_invalid")
    : expectedSelectedMonths(mode, availableMonths);
  const captureComplete = v2
    ? requiredBoolean(input.captureComplete, "manifest_capture_complete_invalid")
    : status === "success";
  if (v2 && input.paginationStatus !== "unproven") invalid("manifest_pagination_status_invalid");
  if (!Array.isArray(input.artifacts) || input.artifacts.length > MAX_MONTHS) {
    invalid("manifest_artifacts_invalid");
  }
  if (!Array.isArray(input.failures) || input.failures.length > MAX_MONTHS + 2) {
    invalid("manifest_failures_invalid");
  }
  const prefix = manifestKey.slice(0, -"manifest.json".length);
  const artifacts = input.artifacts.map((value) => parseArtifact(value, prefix, version));
  const failures = input.failures.map((value) => v2
    ? parseV2Failure(value)
    : parseV1Failure(value));
  validateManifestContract({
    version,
    mode,
    status,
    availableMonths,
    selectedMonths,
    captureComplete,
    artifacts,
    failures,
  });
  return {
    schemaVersion: version,
    source: EXTERNAL_SOURCE,
    ...(runtimeRevision ? { runtimeRevision } : {}),
    runId: input.runId as string,
    mode,
    startedAt,
    completedAt,
    status,
    availableMonths,
    selectedMonths,
    captureComplete,
    paginationStatus: "unproven",
    artifacts,
    failures,
  };
}

function parseArtifact(value: unknown, prefix: string, version: SchemaVersion): Artifact {
  const input = record(value, "manifest_artifact_invalid");
  exactShape(input, version === V2
    ? ["dataset", "month", "key", "mediaType", "bytes", "sha256"]
    : ["month", "key", "bytes", "sha256"]);
  const month = safeMonth(input.month, "manifest_artifact_month_invalid");
  const key = `${prefix}activity-${month}.html`;
  if (input.key !== key) invalid("manifest_artifact_key_mismatch");
  if (version === V2 && (input.dataset !== DATASET || input.mediaType !== "text/html")) {
    invalid("manifest_artifact_contract_invalid");
  }
  if (typeof input.sha256 !== "string" || !SHA256.test(input.sha256)) {
    invalid("manifest_artifact_sha256_invalid");
  }
  const bytes = boundedInteger(input.bytes, 1, MAX_ARTIFACT_BYTES, "manifest_artifact_bytes_invalid");
  return {
    dataset: DATASET,
    month,
    key,
    mediaType: "text/html",
    bytes,
    sha256: input.sha256,
  };
}

function parseV1Failure(value: unknown): Failure {
  const input = record(value, "manifest_failure_invalid");
  exactShape(input, ["operation", "errorType", "message"]);
  if (typeof input.errorType !== "string" || !SAFE_ERROR_TYPE.test(input.errorType)) {
    invalid("manifest_failure_type_invalid");
  }
  if (typeof input.message !== "string" || input.message.length < 1 || input.message.length > 2_000) {
    invalid("manifest_failure_message_invalid");
  }
  if (input.operation === "browser-collection") {
    return {
      operation: "browser-collection",
      errorType: input.errorType,
      errorCode: "browser_collection_failed",
    };
  }
  if (typeof input.operation === "string" && /^r2:20\d{2}-(?:0[1-9]|1[0-2])$/u.test(input.operation)) {
    const month = input.operation.slice(3);
    return {
      operation: "r2",
      errorType: input.errorType,
      errorCode: "artifact_store_failed",
      artifactKey: `activity-${month}.html`,
    };
  }
  invalid("manifest_failure_operation_invalid");
}

function parseV2Failure(value: unknown): Failure {
  const input = record(value, "manifest_failure_invalid");
  exactShape(input, ["operation", "errorType", "errorCode", "artifactKey"], ["artifactKey"]);
  const operation = oneOf(
    input.operation,
    ["browser-collection", "contract", "sanitization", "r2"] as const,
    "manifest_failure_operation_invalid",
  );
  if (typeof input.errorType !== "string" || !SAFE_ERROR_TYPE.test(input.errorType)) {
    invalid("manifest_failure_type_invalid");
  }
  if (typeof input.errorCode !== "string" || !SAFE_CODE.test(input.errorCode)) {
    invalid("manifest_failure_code_invalid");
  }
  const allowed: Record<Failure["operation"], readonly Failure["errorCode"][]> = {
    "browser-collection": ["browser_collection_failed"],
    contract: ["container_contract_invalid", "selected_month_missing"],
    sanitization: ["html_sanitization_failed"],
    r2: ["artifact_store_failed"],
  };
  if (!allowed[operation].includes(input.errorCode as Failure["errorCode"])) {
    invalid("manifest_failure_code_invalid");
  }
  const requiresArtifact = operation === "sanitization" || operation === "r2" ||
    input.errorCode === "selected_month_missing";
  if (requiresArtifact) {
    if (typeof input.artifactKey !== "string" ||
        !/^activity-20\d{2}-(?:0[1-9]|1[0-2])\.html$/u.test(input.artifactKey)) {
      invalid("manifest_failure_artifact_invalid");
    }
  } else if (input.artifactKey !== undefined) {
    invalid("manifest_failure_artifact_invalid");
  }
  return {
    operation,
    errorType: input.errorType,
    errorCode: input.errorCode as Failure["errorCode"],
    ...(typeof input.artifactKey === "string" ? { artifactKey: input.artifactKey } : {}),
  };
}

function validateManifestContract(input: {
  version: SchemaVersion;
  mode: Mode;
  status: Status;
  availableMonths: string[];
  selectedMonths: string[];
  captureComplete: boolean;
  artifacts: Artifact[];
  failures: Failure[];
}): void {
  if (input.availableMonths.length === 0) {
    if (input.selectedMonths.length !== 0 || input.artifacts.length !== 0 ||
        input.status !== "failed" || input.captureComplete || input.failures.length === 0) {
      invalid("manifest_terminal_state_invalid");
    }
    if (input.version === V2 &&
        (input.failures.length !== 1 || input.failures[0]!.artifactKey !== undefined ||
          (input.failures[0]!.operation !== "browser-collection" &&
            input.failures[0]!.operation !== "contract"))) {
      invalid("manifest_empty_available_failure_invalid");
    }
    return;
  }
  const expectedSelected = expectedSelectedMonths(input.mode, input.availableMonths);
  if (!sameStrings(input.selectedMonths, expectedSelected)) {
    invalid("manifest_selected_months_mismatch");
  }
  const artifactMonths = input.artifacts.map((artifact) => artifact.month);
  if (new Set(artifactMonths).size !== artifactMonths.length ||
      artifactMonths.some((month) => !input.selectedMonths.includes(month))) {
    invalid("manifest_artifact_months_invalid");
  }
  const expectedStoredOrder = input.selectedMonths.filter((month) => artifactMonths.includes(month));
  if (!sameStrings(artifactMonths, expectedStoredOrder)) {
    invalid("manifest_artifact_order_invalid");
  }
  const missingKeys = input.selectedMonths
    .filter((month) => !artifactMonths.includes(month))
    .map((month) => `activity-${month}.html`);
  const failedKeys = input.failures.flatMap((failure) => failure.artifactKey ? [failure.artifactKey] : []);
  if (new Set(failedKeys).size !== failedKeys.length ||
      failedKeys.some((key) => !missingKeys.includes(key))) {
    invalid("manifest_failure_artifact_mismatch");
  }
  if (input.version === V2 && !sameStringSet(missingKeys, failedKeys)) {
    invalid("manifest_failure_complement_mismatch");
  }
  const expectedStatus: Status = input.failures.length === 0
    ? "success"
    : input.artifacts.length === 0 ? "failed" : "partial";
  if (input.status !== expectedStatus) invalid("manifest_status_mismatch");
  const expectedComplete = expectedStatus === "success" &&
    sameStrings(artifactMonths, input.selectedMonths);
  if (input.captureComplete !== expectedComplete) invalid("manifest_capture_complete_mismatch");
  if (input.version === V1 && input.status !== "success" && input.failures.length === 0) {
    invalid("manifest_failure_missing");
  }
}

export function sanitizeGlobalPassHtml(
  bytes: Uint8Array,
  schemaVersion: SchemaVersion,
): Uint8Array {
  let html: string;
  try {
    html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ImportError(409, "html_utf8_invalid");
  }
  if (html.length === 0 || html.length > MAX_ARTIFACT_BYTES ||
      !/^\s*<!doctype\s+html(?:\s[^>]*)?>/iu.test(html) ||
      !ACTIVITY_MARKER.test(html)) {
    throw new ImportError(409, "html_activity_contract_invalid");
  }
  if (FORBIDDEN_INLINE.test(html) || countInputs(html, (tag) =>
    attribute(tag, "type").toLowerCase() === "password") !== 0 ||
      countInputs(html, (tag) => /^(?:usrid|loginid|user(?:name|id))$/iu.test(attribute(tag, "name")) ||
        /^(?:usrid|loginid|user(?:name|id))$/iu.test(attribute(tag, "id"))) !== 0) {
    throw new ImportError(409, "html_secret_marker_present");
  }

  for (const tag of inputTags(html)) {
    assertNoDuplicateAttributes(tag, ["id", "name", "type", "value"],
      "html_input_attribute_duplicate");
  }
  for (const tag of formTags(html)) {
    assertNoDuplicateAttributes(tag, ["action"], "html_form_attribute_duplicate");
  }
  assertUrlAndEventContract(html, schemaVersion === V2);

  const nablarchTags = inputTags(html).filter((tag) =>
    attribute(tag, "name").toLowerCase() === "nablarch_hidden");
  const hiddenTags = inputTags(html).filter((tag) =>
    attribute(tag, "type").toLowerCase() === "hidden");
  if (hiddenTags.some((tag) => {
    const name = attribute(tag, "name").toLowerCase();
    return name !== "cc" && name !== "enguseflg" && name !== "nablarch_hidden" &&
      name !== "nablarch_needs_hidden_encryption" && name !== "nablarch_submit" &&
      name !== "w131301.referencedate";
  })) {
    throw new ImportError(409, "html_hidden_field_inventory_invalid");
  }
  const counts = {
    cc: hiddenTags.filter((tag) => attribute(tag, "name").toLowerCase() === "cc").length,
    eng: hiddenTags.filter((tag) => attribute(tag, "name").toLowerCase() === "enguseflg").length,
    nablarch: nablarchTags.length,
    nonempty: nablarchTags.filter((tag) => attribute(tag, "value") !== "").length,
    needs: hiddenTags.filter((tag) =>
      attribute(tag, "name").toLowerCase() === "nablarch_needs_hidden_encryption").length,
    submit: hiddenTags.filter((tag) =>
      attribute(tag, "name").toLowerCase() === "nablarch_submit").length,
    referenceDate: hiddenTags.filter((tag) =>
      attribute(tag, "name").toLowerCase() === "w131301.referencedate").length,
  };
  const forms = formTags(html);
  const actions = forms.map((tag) => attribute(tag, "action")).filter((value) => value !== "");
  if (actions.some((value) => value !== STATIC_FORM_ACTION)) {
    throw new ImportError(409, "html_form_action_invalid");
  }
  const variantA = counts.cc === 1 && counts.eng === 1 && counts.nablarch === 6 &&
    counts.nonempty === 4 && counts.needs === 1 && counts.submit === 6 &&
    counts.referenceDate === 1 && forms.length === 6 && actions.length === 1;
  const variantB = counts.cc === 1 && counts.eng === 1 && counts.nablarch === 4 &&
    counts.nonempty === 3 && counts.needs === 1 && counts.submit === 4 &&
    counts.referenceDate === 0 && forms.length === 5 && actions.length === 0;
  if (!variantA && !variantB) throw new ImportError(409, "html_variant_invalid");

  const originals: string[] = [];
  let output = html.replace(/<input\b[^>]*>/giu, (tag) => {
    if (attribute(tag, "name").toLowerCase() !== "nablarch_hidden") return tag;
    if (attribute(tag, "type").toLowerCase() !== "hidden") {
      throw new ImportError(409, "html_nablarch_hidden_invalid");
    }
    const valueMatch = uniqueAttribute(tag, "value");
    if (!valueMatch) throw new ImportError(409, "html_nablarch_hidden_invalid");
    if (valueMatch.value === "") return tag;
    if (schemaVersion === V2) {
      if (valueMatch.value !== SENTINEL) {
        throw new ImportError(409, "html_nablarch_hidden_not_redacted");
      }
      return tag;
    }
    if (valueMatch.value === SENTINEL) {
      throw new ImportError(409, "legacy_html_unexpected_redaction");
    }
    originals.push(valueMatch.value);
    return tag.slice(0, valueMatch.valueStart) + SENTINEL + tag.slice(valueMatch.valueEnd);
  });
  if (schemaVersion === V1) output = canonicalizeInteractiveAttributes(output);
  assertUrlAndEventContract(output, true);
  for (const original of originals) {
    if (output.includes(original)) throw new ImportError(409, "html_redaction_incomplete");
  }
  const after = inputTags(output).filter((tag) =>
    attribute(tag, "name").toLowerCase() === "nablarch_hidden");
  if (after.filter((tag) => attribute(tag, "value") === SENTINEL).length !== counts.nonempty ||
      after.filter((tag) => attribute(tag, "value") === "").length !== counts.nablarch - counts.nonempty) {
    throw new ImportError(409, "html_redaction_incomplete");
  }
  const encoded = new TextEncoder().encode(output);
  if (new TextDecoder("utf-8", { fatal: true }).decode(encoded) !== output) {
    throw new ImportError(409, "html_utf8_round_trip_failed");
  }
  if (schemaVersion === V2 &&
      (encoded.byteLength !== bytes.byteLength || encoded.some((value, index) => value !== bytes[index]))) {
    throw new ImportError(409, "html_v2_not_canonical_utf8");
  }
  return encoded;
}

async function readVerifiedArtifact(
  bucket: R2Bucket,
  artifact: Artifact,
  manifest: Manifest,
): Promise<Uint8Array> {
  const object = await bucket.get(artifact.key);
  if (!object) throw new ImportError(409, "artifact_missing");
  if (object.size !== artifact.bytes || object.size > MAX_ARTIFACT_BYTES) {
    throw new ImportError(409, "artifact_size_mismatch");
  }
  const legacyMetadata = {
    dataset: DATASET,
    month: artifact.month,
    sha256: artifact.sha256,
  };
  const v2Metadata = {
    source: EXTERNAL_SOURCE,
    runId: manifest.runId,
    dataset: DATASET,
    sha256: artifact.sha256,
  };
  assertExactMetadata(
    object.customMetadata,
    manifest.schemaVersion === V1 ? legacyMetadata : v2Metadata,
    "artifact_metadata_mismatch",
  );
  if (mediaTypeBase(object.httpMetadata?.contentType) !== "text/html") {
    throw new ImportError(409, "artifact_content_type_mismatch");
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  assertNativeSha256(object, artifact.sha256);
  if (await sha256Hex(bytes) !== artifact.sha256) {
    throw new ImportError(409, "artifact_checksum_mismatch");
  }
  return bytes;
}

async function artifactPlans(
  verified: VerifiedArtifact[],
  loaded: LoadedManifest,
  unitId: number,
  manifest: Manifest,
  manifestKey: string,
  fingerprintKey: string,
): Promise<ArtifactPlan[]> {
  const plans: ArtifactPlan[] = [];
  for (const [sequence, item] of verified.entries()) {
    const descriptor = await dataDescriptor({
      artifact: item.artifact,
      centralSha256: item.centralSha256,
      centralBytes: item.centralBytes.byteLength,
      sequence,
      unitId,
      completedAt: manifest.completedAt,
      schemaVersion: manifest.schemaVersion,
      fingerprintKey,
    });
    plans.push({
      source: item.artifact,
      centralBytes: item.centralBytes,
      sha256: item.centralSha256,
      descriptor,
      inventory: {
        artifactKey: filename(item.artifact.key),
        sha256: item.centralSha256,
        descriptorSha256: await descriptorSha256(descriptor),
      },
    });
  }
  const descriptor = await manifestDescriptor({
    manifest,
    key: manifestKey,
    bytes: loaded.centralBytes.byteLength,
    sha256: loaded.centralSha256,
    sequence: verified.length,
    fingerprintKey,
  });
  plans.push({
    source: null,
    centralBytes: loaded.centralBytes,
    sha256: loaded.centralSha256,
    descriptor,
    inventory: {
      artifactKey: "manifest.json",
      sha256: loaded.centralSha256,
      descriptorSha256: await descriptorSha256(descriptor),
    },
  });
  return plans;
}

async function currentCentralBytes(
  bucket: R2Bucket,
  plan: ArtifactPlan,
  manifest: Manifest,
): Promise<Uint8Array> {
  const current = plan.source
    ? sanitizeGlobalPassHtml(
      await readVerifiedArtifact(bucket, plan.source, manifest),
      manifest.schemaVersion,
    )
    : plan.centralBytes;
  if (current.byteLength !== plan.centralBytes.byteLength ||
      await sha256Hex(current) !== plan.sha256) {
    throw new ImportError(409, "artifact_changed_during_import");
  }
  return current;
}

async function dataDescriptor(options: {
  artifact: Artifact;
  centralSha256: string;
  centralBytes: number;
  sequence: number;
  unitId: number;
  completedAt: string;
  schemaVersion: SchemaVersion;
  fingerprintKey: string;
}): Promise<JsonObject> {
  return normalizedDescriptor({
    artifactKey: filename(options.artifact.key),
    artifactRole: "sanitized_provider_capture",
    payloadFidelity: "transformed",
    lineageDisposition: "source_not_retained_for_security",
    dataset: DATASET,
    formatId: "global-pass-activity-html-utf8-sanitized",
    formatVersion: options.schemaVersion,
    declaredMediaType: "text/html",
    mediaTypeBasis: "manifest",
    fetchedAtMs: Date.parse(options.completedAt),
    fetchedAtBasis: "manifest",
    fetchUnitId: options.unitId,
    sequence: options.sequence,
    sha256: options.centralSha256,
    byteSize: options.centralBytes,
    storage: await storageOrigin(options.artifact.key, options.fingerprintKey),
    ranges: [],
    transformSteps: [
      {
        stepIndex: 0,
        stepKind: "redacted",
        transformerId: "global-pass-html-sanitizer",
        transformerVersion: "v1",
      },
      {
        stepIndex: 1,
        stepKind: "reencoded",
        transformerId: "global-pass-html-sanitizer",
        transformerVersion: "v1",
      },
    ],
  });
}

async function manifestDescriptor(options: {
  manifest: Manifest;
  key: string;
  bytes: number;
  sha256: string;
  sequence: number;
  fingerprintKey: string;
}): Promise<JsonObject> {
  const legacy = options.manifest.schemaVersion === V1;
  return normalizedDescriptor({
    artifactKey: "manifest.json",
    artifactRole: legacy ? "collector_derived" : "collector_manifest",
    payloadFidelity: legacy ? "transformed" : "generated",
    lineageDisposition: legacy ? "source_not_retained_for_security" : "not_applicable",
    dataset: "collector-manifest",
    formatId: "global-pass-collector-manifest-json",
    formatVersion: options.manifest.schemaVersion,
    declaredMediaType: "application/json",
    mediaTypeBasis: "operator",
    fetchedAtMs: Date.parse(options.manifest.completedAt),
    fetchedAtBasis: "manifest",
    fetchUnitId: null,
    sequence: options.sequence,
    sha256: options.sha256,
    byteSize: options.bytes,
    storage: await storageOrigin(options.key, options.fingerprintKey),
    ranges: [],
    transformSteps: legacy ? [
      {
        stepIndex: 0,
        stepKind: "redacted",
        transformerId: "global-pass-manifest-sanitizer",
        transformerVersion: "v1",
      },
      {
        stepIndex: 1,
        stepKind: "reencoded",
        transformerId: "global-pass-manifest-sanitizer",
        transformerVersion: "v1",
      },
    ] : [],
  });
}

function normalizedDescriptor(input: {
  artifactKey: string;
  artifactRole: string;
  payloadFidelity: string;
  lineageDisposition: string;
  dataset: string;
  formatId: string;
  formatVersion: SchemaVersion;
  declaredMediaType: string;
  mediaTypeBasis: string;
  fetchedAtMs: number;
  fetchedAtBasis: string;
  fetchUnitId: number | null;
  sequence: number;
  sha256: string;
  byteSize: number;
  storage: JsonObject;
  ranges: JsonObject[];
  transformSteps: JsonObject[];
}): JsonObject {
  return {
    artifactKey: input.artifactKey,
    artifactRole: input.artifactRole,
    payloadFidelity: input.payloadFidelity,
    containerKind: "single",
    lineageDisposition: input.lineageDisposition,
    dataset: input.dataset,
    formatId: input.formatId,
    formatVersion: input.formatVersion,
    declaredMediaType: input.declaredMediaType,
    mediaTypeBasis: input.mediaTypeBasis,
    fetchedAtMs: input.fetchedAtMs,
    fetchedAtBasis: input.fetchedAtBasis,
    fetchUnitId: input.fetchUnitId,
    pageGroupId: null,
    pageIndex: null,
    sequence: input.sequence,
    sha256: input.sha256,
    byteSize: input.byteSize,
    http: null,
    storage: input.storage,
    file: null,
    email: null,
    ranges: input.ranges,
    transformSteps: input.transformSteps,
    relations: [],
  };
}

function sanitizeLegacyManifest(manifest: Manifest): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    source: manifest.source,
    ...(manifest.runtimeRevision ? { runtimeRevision: manifest.runtimeRevision } : {}),
    runId: manifest.runId,
    mode: manifest.mode,
    startedAt: manifest.startedAt,
    completedAt: manifest.completedAt,
    status: manifest.status,
    availableMonths: manifest.availableMonths,
    artifacts: manifest.artifacts.map((artifact) => ({
      month: artifact.month,
      key: artifact.key,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
    })),
    failures: manifest.failures.map((failure) => ({
      operation: failure.operation === "r2" && failure.artifactKey
        ? `r2:${failure.artifactKey.slice("activity-".length, -".html".length)}`
        : "browser-collection",
      errorType: failure.errorType,
      message: failure.errorCode,
    })),
  }));
}

async function storageOrigin(key: string, fingerprintKey: string): Promise<JsonObject> {
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

async function assertExactPrefix(
  bucket: R2Bucket,
  prefix: string,
  expectedKeys: string[],
): Promise<void> {
  const actual: string[] = [];
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({
      prefix,
      limit: 1_000,
      ...(cursor ? { cursor } : {}),
    });
    actual.push(...listed.objects.map((object) => object.key));
    cursor = listed.truncated ? listed.cursor : undefined;
    if (listed.truncated && !cursor) throw new ImportError(409, "prefix_cursor_missing");
    if (actual.length > MAX_MONTHS + 1) throw new ImportError(409, "prefix_inventory_too_large");
  } while (cursor);
  actual.sort();
  const expected = [...expectedKeys].sort();
  if (!sameStrings(actual, expected)) throw new ImportError(409, "prefix_inventory_mismatch");
}

function safeFailureCode(failures: Failure[]): string {
  if (failures.some((failure) => failure.operation === "browser-collection")) {
    return "browser-collection-failed";
  }
  if (failures.some((failure) => failure.operation === "sanitization")) {
    return "html-sanitization-failed";
  }
  if (failures.some((failure) => failure.operation === "r2")) {
    return "staging-write-failed";
  }
  return "collector-contract-incomplete";
}

function inputTags(html: string): string[] {
  return html.match(/<input\b[^>]*>/giu) ?? [];
}

function formTags(html: string): string[] {
  return html.match(/<form\b[^>]*>/giu) ?? [];
}

function startTags(html: string): string[] {
  return html.match(/<[A-Za-z][^>]*>/gu) ?? [];
}

interface ParsedAttribute {
  name: string;
  value: string | undefined;
}

function parsedAttributes(tag: string): ParsedAttribute[] {
  const attributes: ParsedAttribute[] = [];
  const regex = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;
  const firstSpace = tag.search(/\s/u);
  regex.lastIndex = firstSpace < 0 ? tag.length : firstSpace;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(tag)) !== null) {
    attributes.push({
      name: match[1]!.toLowerCase(),
      value: match[2] ?? match[3] ?? match[4],
    });
  }
  return attributes;
}

function assertNoDuplicateAttributes(
  tag: string,
  names: readonly string[],
  code: string,
): void {
  const attributes = parsedAttributes(tag);
  for (const name of names) {
    if (attributes.filter((attribute) => attribute.name === name).length > 1) {
      throw new ImportError(409, code);
    }
  }
}

function assertUrlAndEventContract(html: string, canonical: boolean): void {
  if (/\burl\s*\(|@import\b/iu.test(html)) {
    throw new ImportError(409, "html_css_url_sink_invalid");
  }
  const extraUrlAttributes = new Set([
    "archive", "background", "cite", "code", "codebase", "data", "datasrc",
    "dynsrc", "formaction", "icon", "imagesrcset", "longdesc", "lowsrc",
    "manifest", "ping", "poster", "profile", "srcdoc", "srcset", "usemap",
    "xlink:href", "xmlns", "xmlns:xlink",
  ]);
  for (const tag of startTags(html)) {
    const attributes = parsedAttributes(tag);
    const element = tagName(tag);
    if (BLOCKED_NETWORK_ELEMENTS.has(element)) {
      throw new ImportError(409, "html_network_element_invalid");
    }
    const sensitiveNames = new Set(
      attributes.map((attribute) => attribute.name).filter((name) =>
        name === "href" || name === "src" || name === "action" ||
        name === "http-equiv" || extraUrlAttributes.has(name) || name.startsWith("on")),
    );
    for (const name of sensitiveNames) {
      if (attributes.filter((attribute) => attribute.name === name).length !== 1) {
        throw new ImportError(409, "html_security_attribute_duplicate");
      }
    }
    const httpEquiv = attributes.find((attribute) => attribute.name === "http-equiv");
    if (httpEquiv) {
      const allowed = new Set([
        "cache-control", "content-language", "content-script-type",
        "content-style-type", "content-type", "expires", "pragma", "x-ua-compatible",
      ]);
      if (element !== "meta" || httpEquiv.value === undefined ||
          !allowed.has(httpEquiv.value.trim().toLowerCase())) {
        throw new ImportError(409, "html_meta_refresh_invalid");
      }
    }
    for (const attribute of attributes) {
      const value = attribute.value;
      if (extraUrlAttributes.has(attribute.name)) {
        throw new ImportError(409, "html_url_attribute_invalid");
      }
      if (attribute.name === "action") {
        if (element !== "form" || value !== "" && value !== STATIC_FORM_ACTION) {
          throw new ImportError(409, "html_url_attribute_invalid");
        }
      } else if (attribute.name === "href") {
        if (value === undefined || !allowedHref(element, value, canonical)) {
          throw new ImportError(409, "html_url_attribute_invalid");
        }
      } else if (attribute.name === "src") {
        const allowed = element === "img"
          ? ALLOWED_IMG_SRC_PATHS
          : element === "script" ? ALLOWED_SCRIPT_SRC_PATHS : null;
        if (value === undefined || allowed === null || !allowedSameHostPath(value, allowed)) {
          throw new ImportError(409, "html_url_attribute_invalid");
        }
      } else if (attribute.name.startsWith("on")) {
        if (value === undefined || !allowedEventHandler(attribute.name, value, canonical)) {
          throw new ImportError(409, "html_event_handler_invalid");
        }
      }
    }
  }
}

function tagName(tag: string): string {
  return /^<([A-Za-z][A-Za-z0-9:-]*)/u.exec(tag)?.[1]?.toLowerCase() ?? "";
}

function canonicalizeInteractiveAttributes(html: string): string {
  return html.replace(/<[A-Za-z][^>]*>/gu, (tag) => {
    const replacements: Array<{ start: number; end: number; value: string }> = [];
    for (const attribute of parsedAttributes(tag)) {
      const match = uniqueAttribute(tag, attribute.name);
      if (!match) continue;
      if (attribute.name === "href" && match.value.startsWith("#")) {
        replacements.push({ start: match.valueStart, end: match.valueEnd, value: "#" });
      } else if (attribute.name === "onclick" || attribute.name === "onchange") {
        replacements.push({
          start: match.valueStart,
          end: match.valueEnd,
          value: "return false;",
        });
      }
    }
    let output = tag;
    for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
      output = output.slice(0, replacement.start) + replacement.value +
        output.slice(replacement.end);
    }
    return output;
  });
}

function allowedHref(element: string, value: string, canonical: boolean): boolean {
  if (element === "link") return allowedSameHostPath(value, ALLOWED_LINK_HREF_PATHS);
  if (element !== "a") return false;
  return value === "https://www.smbctb.co.jp/" ||
    (canonical ? value === "#" : /^#[A-Za-z0-9._:-]*$/u.test(value)) ||
    /^javascript:void\(0\);?$/u.test(value) ||
    allowedSameHostPath(value, ALLOWED_ANCHOR_HREF_PATHS);
}

function allowedSameHostPath(value: string, allowed: ReadonlySet<string>): boolean {
  if (value.includes("?") || value.includes("#") || /;jsessionid/iu.test(value)) return false;
  if (value.startsWith("/")) return allowed.has(value);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.origin === SAME_HOST && parsed.username === "" && parsed.password === "" &&
    parsed.search === "" && parsed.hash === "" && allowed.has(parsed.pathname);
}

function allowedEventHandler(name: string, value: string, canonical: boolean): boolean {
  if (canonical) {
    return (name === "onclick" || name === "onchange") && value === "return false;";
  }
  if (/https?:|javascript:|data:|fetch|xmlhttprequest|document|cookie|storage|eval|function|=>/iu
      .test(value)) return false;
  const functionNames = [...value.matchAll(
    /\b(?:window\.)?[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*(?=\s*\()/gu,
  )].map((match) => match[0]!);
  const allowedFunctions = name === "onchange"
    ? new Set(["sel_submit"])
    : name === "onclick"
    ? new Set(["click", "toggleClass", "window.nablarch_submit"])
    : null;
  if (!allowedFunctions || functionNames.length === 0 ||
      functionNames.some((functionName) => !allowedFunctions.has(functionName))) return false;
  const withoutStrings = value.replace(/"[^"]*"|'[^']*'/gu, "");
  const identifiers = withoutStrings.match(/[A-Za-z_$][A-Za-z0-9_$]*/gu) ?? [];
  const allowedIdentifiers = new Set([
    "click", "event", "false", "nablarch_submit", "return", "sel_submit",
    "this", "toggleClass", "true", "window",
  ]);
  return identifiers.every((identifier) => allowedIdentifiers.has(identifier));
}

function countInputs(html: string, predicate: (tag: string) => boolean): number {
  return inputTags(html).filter(predicate).length;
}

function countSubmitControls(html: string): number {
  const inputs = countInputs(html, (tag) =>
    attribute(tag, "type").toLowerCase() === "submit");
  const buttons = (html.match(/<button\b[^>]*>/giu) ?? []).filter((tag) => {
    const type = attribute(tag, "type").toLowerCase();
    return type === "" || type === "submit";
  }).length;
  return inputs + buttons;
}

interface AttributeMatch {
  value: string;
  valueStart: number;
  valueEnd: number;
}

function uniqueAttribute(tag: string, name: string): AttributeMatch | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const regex = new RegExp(
    "(?:^|\\s)" + escaped +
      "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'=<>`]+))",
    "giu",
  );
  const matches = [...tag.matchAll(regex)];
  if (matches.length !== 1) return null;
  const match = matches[0]!;
  const value = match[1] ?? match[2] ?? match[3] ?? "";
  const relative = match[0].indexOf(value);
  return {
    value,
    valueStart: match.index! + relative,
    valueEnd: match.index! + relative + value.length,
  };
}

function attribute(tag: string, name: string): string {
  return uniqueAttribute(tag, name)?.value ?? "";
}

function mediaTypeBase(value: string | undefined): string {
  return (value ?? "").split(";", 1)[0]!.trim().toLowerCase();
}

function assertNativeSha256(object: R2ObjectBody, expected: string): void {
  const native = object.checksums.sha256;
  if (native && bytesHex(new Uint8Array(native)) !== expected) {
    throw new ImportError(409, "artifact_native_checksum_mismatch");
  }
}

function assertExactMetadata(
  actual: Record<string, string> | undefined,
  expected: Record<string, string>,
  code: string,
): void {
  const actualKeys = Object.keys(actual ?? {}).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (actualKeys.length !== expectedKeys.length ||
      actualKeys.some((key, index) => key !== expectedKeys[index] || actual?.[key] !== expected[key])) {
    throw new ImportError(409, code);
  }
}

function parseJson(bytes: Uint8Array, code: string): JsonObject {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed: unknown = JSON.parse(text);
    return record(parsed, code);
  } catch (error) {
    if (error instanceof ImportError) throw error;
    invalid(code);
  }
}

function record(value: unknown, code: string): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") invalid(code);
  return value as JsonObject;
}

function exactShape(
  value: JsonObject,
  allowed: readonly string[],
  optional: readonly string[] = [],
): void {
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key)) ||
      allowed.some((key) => !optional.includes(key) && !Object.hasOwn(value, key))) {
    invalid("manifest_unknown_field");
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

function safeRuntime(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9-]{1,64}$/u.test(value)) {
    invalid("manifest_runtime_revision_invalid");
  }
  return value;
}

function safeMonth(value: unknown, code: string): string {
  if (typeof value !== "string" || !/^20\d{2}-(?:0[1-9]|1[0-2])$/u.test(value)) {
    invalid(code);
  }
  return value;
}

function months(value: unknown, allowEmpty: boolean, code: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_MONTHS || (!allowEmpty && value.length === 0)) {
    invalid(code);
  }
  const parsed = value.map((month) => safeMonth(month, code));
  if (new Set(parsed).size !== parsed.length ||
      !sameStrings(parsed, [...parsed].sort().reverse())) {
    invalid(code);
  }
  for (let index = 1; index < parsed.length; index += 1) {
    if (previousMonth(parsed[index - 1]!) !== parsed[index]) invalid(code);
  }
  return parsed;
}

function expectedSelectedMonths(mode: Mode, availableMonths: string[]): string[] {
  return mode === "backfill" ? [...availableMonths] : availableMonths.slice(0, 2);
}

function previousMonth(value: string): string {
  const [year, month] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 2, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function requiredBoolean(value: unknown, code: string): boolean {
  if (typeof value !== "boolean") invalid(code);
  return value;
}

function boundedInteger(value: unknown, min: number, max: number, code: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    invalid(code);
  }
  return value;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return sameStrings([...left].sort(), [...right].sort());
}

function filename(key: string): string {
  return key.slice(key.lastIndexOf("/") + 1);
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

async function sha256Hex(value: Uint8Array): Promise<string> {
  return bytesHex(new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    ownedArrayBuffer(value),
  )));
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
