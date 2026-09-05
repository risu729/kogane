import { CentralClient } from "./central";
import { ImportError } from "./error";
import type {
  CentralInventoryItem,
  SonyArtifactManifest,
  SonyFailure,
  SonyManifest,
} from "./types";

const SOURCE = "sony-bank" as const;
const PRODUCER = "collector-r2-importer";
const SCHEMA_VERSION = "sony-bank-worker-poc-v2";
const LEGACY_SCHEMA_VERSION = "sony-bank-worker-poc-v1";
const SUMMARY_VERSION = "sony-bank-collection-summary-v2";
const LEGACY_SUMMARY_VERSION = "sony-bank-collection-summary-v1";
const INGEST_CONTRACT_VERSION = "sony-bank-r2-v2";
const CENTRAL_CLIENT_ID = "collector-r2-sony-bank";
const STORAGE_CONTAINER = "kogane-sony-bank-collector-poc";
const STORAGE_TEMPLATE = "raw/sony-bank/{date}/{run-id}/{artifact}";
const FINGERPRINT_VERSION = "collector-r2-v1";
const PAGE_SIZE = 3;
const MAX_HISTORY_PAGES = 1_000;
const MAX_SOURCE_ARTIFACTS = 11_028;
const MAX_CENTRAL_ARTIFACTS = 10_000;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
export const SONY_TRANSFER_CHUNK_SIZE = 10;
const CURRENCIES = ["usd", "eur", "gbp", "aud", "nzd", "cad", "chf", "hkd", "zar", "sek"] as const;
const MANIFEST_KEY =
  /^raw\/sony-bank\/(\d{4})\/(\d{2})\/(\d{2})\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/manifest\.json$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const DATASET = /^[a-z0-9-]{1,200}$/u;
const COOKIE_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/u;
const CSV_MEDIA = new Set([
  "application/csv",
  "application/octet-stream",
  "application/x-csv",
  "text/csv",
  "text/plain",
]);

type JsonObject = Record<string, unknown>;
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface Summary {
  window: { from: string; to: string };
  transactionCount: number;
  pageCount: number;
  foreignCurrencyCount: number;
  foreignTransactionCount: number;
  foreignPageCount: number;
  walletMonthCount: number;
  cookieNames: string[];
}

interface PageInfo {
  group: string;
  index: number;
  rowCount: number;
  declaredTotal: number | null;
}

interface VerifiedArtifact {
  artifact: SonyArtifactManifest;
  filename: string;
  page?: PageInfo;
  summary?: Summary;
  walletMonths?: string[];
  walletSelectedMonth?: string;
}

interface ValidatedRun {
  manifest: SonyManifest;
  manifestBytes: Uint8Array;
  manifestSha256: string;
  artifacts: VerifiedArtifact[];
}

interface LoadedManifest {
  manifest: SonyManifest;
  manifestBytes: Uint8Array;
  manifestSha256: string;
}

interface ArtifactPlan {
  source: SonyArtifactManifest | null;
  bytes: number;
  sha256: string;
  descriptor: JsonObject;
  inventory: CentralInventoryItem;
}

export type SonyImportResult = SonyImportDeferred | SonyImportSealed;

export interface SonyImportDeferred {
  source: typeof SOURCE;
  manifestKey: string;
  status: "deferred";
  reason: "worker_invocation_limit" | "central_inventory_limit";
  artifactCount: number;
  nextOffset: number;
}

export interface SonyImportSealed {
  source: typeof SOURCE;
  manifestKey: string;
  status: "sealed";
  centralRunId: number;
  artifactCount: number;
  sealed: true;
  finalChunkAllObjectsReused: boolean;
}

export async function importSonyRun(options: {
  bucket: R2Bucket;
  centralService: Fetcher;
  centralToken: string;
  fingerprintKey: string;
  importerVersion: string;
  manifestKey: string;
  offset?: number;
  immediate?: boolean;
}): Promise<SonyImportResult> {
  const startedAtMs = Date.now();
  const attemptId = `attempt-${crypto.randomUUID()}`;
  let centralRunId: number | undefined;
  let acceptedArtifactCount = 0;
  let reusedArtifactCount = 0;
  let expectedArtifactCount = 0;
  let phase = "source_validation";
  const runId = options.manifestKey.match(MANIFEST_KEY)?.[4];
  const log = (
    outcome: "started" | "deferred" | "sealed" | "failed",
    nextOffset?: number,
    reason?: SonyImportDeferred["reason"],
  ) => {
    try {
      console[outcome === "failed" ? "error" : "log"](
        JSON.stringify({
          event: "sony-bank-import-diagnostic",
          source: SOURCE,
          attemptId,
          ...(runId ? { runId } : {}),
          phase,
          outcome,
          durationMs: Math.max(0, Date.now() - startedAtMs),
          expectedArtifactCount,
          acceptedArtifactCount,
          reusedArtifactCount,
          ...(centralRunId !== undefined ? { centralRunId } : {}),
          ...(nextOffset !== undefined ? { nextOffset } : {}),
          ...(reason ? { reason } : {}),
          ...(outcome === "failed" ? { errorCode: `${phase}_failed` } : {}),
        }),
      );
    } catch {
      // Logging must never interrupt evidence transfer or replace its failure.
    }
  };
  log("started");

  try {
    const loaded = await loadSonyManifest(options.bucket, options.manifestKey);
    expectedArtifactCount = loaded.manifest.artifacts.length + 1;
    const offset = options.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > expectedArtifactCount) {
      throw new ImportError(400, "transfer_offset_invalid");
    }
    if (expectedArtifactCount > MAX_CENTRAL_ARTIFACTS) {
      log("deferred", offset, "central_inventory_limit");
      return deferred(
        expectedArtifactCount,
        options.manifestKey,
        "central_inventory_limit",
        offset,
      );
    }
    const validated = await validateLoadedSonyRun(options.bucket, options.manifestKey, loaded);
    if (
      options.immediate !== false &&
      offset === 0 &&
      expectedArtifactCount > SONY_TRANSFER_CHUNK_SIZE
    ) {
      log("deferred", 0, "worker_invocation_limit");
      return deferred(expectedArtifactCount, options.manifestKey, "worker_invocation_limit", 0);
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
      externalIdNamespace: validated.manifest.schemaVersion,
      externalSessionId: validated.manifest.runId,
      sourceRunKey: `full-snapshot-${INGEST_CONTRACT_VERSION}`,
    });
    const unitId = await central.addUnit(centralRunId, {
      unitKind: "collection",
      unitKey: "account",
      terminalReportRequired: true,
    });

    phase = "inventory_plan";
    const plans = await artifactPlans(
      validated,
      unitId,
      options.fingerprintKey,
      options.manifestKey,
    );
    const inventory = plans
      .map((plan) => plan.inventory)
      .sort((left, right) => binaryCompare(left.artifactKey, right.artifactKey));
    const inventorySha256 = await sha256Hex(canonicalJson(inventory as unknown as JsonValue));
    const inventoryId = await central.beginInventory(
      centralRunId,
      inventorySha256,
      inventory.length,
    );

    const end = Math.min(offset + SONY_TRANSFER_CHUNK_SIZE, plans.length);
    const chunkInventory: CentralInventoryItem[] = [];
    for (const plan of plans.slice(offset, end)) {
      phase = "object_upload";
      const bytes = plan.source
        ? await readVerifiedArtifact(options.bucket, plan.source, validated.manifest.runId)
        : validated.manifestBytes;
      const reused = await central.uploadObject(centralRunId, plan.sha256, bytes);
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
      log("deferred", end, "worker_invocation_limit");
      return {
        source: SOURCE,
        manifestKey: options.manifestKey,
        status: "deferred",
        reason: "worker_invocation_limit",
        artifactCount: plans.length,
        nextOffset: end,
      };
    }

    phase = "unit_report";
    await central.addUnitReport(unitId, {
      reportKey: "terminal",
      reportKind: "terminal",
      producerStatus: validated.manifest.status,
      normalizedOutcome: validated.manifest.status,
      startedAtMs: Date.parse(validated.manifest.startedAt),
      startedAtBasis: "manifest",
      completedAtMs: Date.parse(validated.manifest.completedAt),
      completedAtBasis: "manifest",
      declaredArtifactCount: plans.length,
      artifactCountScope: "direct",
      ...(validated.manifest.failures.length > 0
        ? { safeFailureCode: safeFailureCode(validated.manifest.failures) }
        : {}),
    });
    phase = "run_report";
    await central.addRunReport(centralRunId, {
      reportKey: "terminal",
      reportKind: "terminal",
      producerVersion: INGEST_CONTRACT_VERSION,
      manifestSchemaVersion: validated.manifest.schemaVersion,
      producerStatus: validated.manifest.status,
      normalizedOutcome: validated.manifest.status,
      startedAtMs: Date.parse(validated.manifest.startedAt),
      startedAtBasis: "manifest",
      completedAtMs: Date.parse(validated.manifest.completedAt),
      completedAtBasis: "manifest",
      declaredArtifactCount: plans.length,
      artifactCountScope: "all_catalogued",
    });
    phase = "seal";
    await central.sealStagedInventory(centralRunId, inventoryId, attemptId, startedAtMs);
    log("sealed");
    return {
      source: SOURCE,
      manifestKey: options.manifestKey,
      status: "sealed",
      centralRunId,
      artifactCount: plans.length,
      sealed: true,
      finalChunkAllObjectsReused: acceptedArtifactCount === 0,
    };
  } catch (error) {
    log("failed");
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
        // Attempt reporting is best effort and must not replace the original failure.
      }
    }
    throw error;
  }
}

function deferred(
  artifactCount: number,
  manifestKey: string,
  reason: SonyImportDeferred["reason"],
  nextOffset: number,
): SonyImportDeferred {
  return {
    source: SOURCE,
    manifestKey,
    status: "deferred",
    reason,
    artifactCount,
    nextOffset,
  };
}

export async function validateSonyRun(
  bucket: R2Bucket,
  manifestKey: string,
): Promise<ValidatedRun> {
  return validateLoadedSonyRun(bucket, manifestKey, await loadSonyManifest(bucket, manifestKey));
}

async function loadSonyManifest(bucket: R2Bucket, manifestKey: string): Promise<LoadedManifest> {
  const manifestObject = await bucket.get(manifestKey);
  if (!manifestObject) throw new ImportError(404, "manifest_not_found");
  if (manifestObject.size > MAX_MANIFEST_BYTES) throw new ImportError(413, "manifest_too_large");
  if (manifestObject.httpMetadata?.contentType !== "application/json") {
    throw new ImportError(409, "manifest_content_type_mismatch");
  }
  const manifestBytes = new Uint8Array(await manifestObject.arrayBuffer());
  const manifestSha256 = await sha256Hex(manifestBytes);
  assertNativeSha256(manifestObject, manifestSha256);
  const manifest = parseSonyManifest(manifestBytes, manifestKey);
  assertManifestMetadata(manifestObject.customMetadata, manifest, manifestSha256);
  return { manifest, manifestBytes, manifestSha256 };
}

async function validateLoadedSonyRun(
  bucket: R2Bucket,
  manifestKey: string,
  loaded: LoadedManifest,
): Promise<ValidatedRun> {
  const { manifest, manifestBytes, manifestSha256 } = loaded;
  const prefix = manifestKey.slice(0, -"manifest.json".length);
  const expectedKeys = [...manifest.artifacts.map((artifact) => artifact.key), manifestKey];
  await assertExactPrefix(bucket, prefix, expectedKeys);

  const artifacts: VerifiedArtifact[] = [];
  for (const artifact of manifest.artifacts) {
    const bytes = await readVerifiedArtifact(bucket, artifact, manifest.runId);
    artifacts.push(parseArtifactPayload(artifact, bytes, manifest.schemaVersion));
  }
  validateCompleteness(manifest, artifacts);
  await assertExactPrefix(bucket, prefix, expectedKeys);
  return { manifest, manifestBytes, manifestSha256, artifacts };
}

export function parseSonyManifest(bytes: Uint8Array, manifestKey: string): SonyManifest {
  const key = MANIFEST_KEY.exec(manifestKey);
  if (!key) invalid("manifest_key_invalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    invalid("manifest_json_invalid");
  }
  const input = record(parsed, "manifest_shape_invalid");
  exactKeys(input, [
    "schemaVersion",
    "source",
    "runId",
    "startedAt",
    "completedAt",
    "status",
    "window",
    "transactionCount",
    "artifacts",
    "failures",
  ]);
  if (input.schemaVersion !== SCHEMA_VERSION && input.schemaVersion !== LEGACY_SCHEMA_VERSION) {
    invalid("manifest_schema_invalid");
  }
  if (input.source !== SOURCE) invalid("manifest_source_invalid");
  if (input.runId !== key[4]) invalid("manifest_run_id_mismatch");
  const startedAt = instant(input.startedAt, "manifest_started_at_invalid");
  const completedAt = instant(input.completedAt, "manifest_completed_at_invalid");
  if (completedAt < startedAt) invalid("manifest_time_reversed");
  if (startedAt.slice(0, 10) !== `${key[1]}-${key[2]}-${key[3]}`) {
    invalid("manifest_date_mismatch");
  }
  const window = parseWindow(input.window);
  const transactionCount = nonNegativeInteger(input.transactionCount);
  if (transactionCount === null) invalid("manifest_transaction_count_invalid");
  const status = oneOf(
    input.status,
    ["success", "partial", "failed"] as const,
    "manifest_status_invalid",
  );
  if (!Array.isArray(input.artifacts) || input.artifacts.length > MAX_SOURCE_ARTIFACTS) {
    invalid("manifest_artifacts_invalid");
  }
  if (!Array.isArray(input.failures) || input.failures.length > MAX_SOURCE_ARTIFACTS) {
    invalid("manifest_failures_invalid");
  }
  const prefix = manifestKey.slice(0, -"manifest.json".length);
  const artifacts = input.artifacts.map((value) => parseArtifact(value, prefix));
  const failures = input.failures.map(parseFailure);
  const artifactNames = artifacts.map((artifact) => artifact.dataset);
  if (new Set(artifactNames).size !== artifactNames.length) invalid("manifest_duplicate_dataset");
  const r2Names = failures
    .filter((failure) => failure.operation.startsWith("r2:"))
    .map((failure) => failure.operation.slice(3));
  if (
    new Set(r2Names).size !== r2Names.length ||
    r2Names.some((name) => artifactNames.includes(name))
  ) {
    invalid("manifest_failure_dataset_conflict");
  }
  const expectedStatus =
    failures.length === 0 ? "success" : artifacts.length === 0 ? "failed" : "partial";
  if (status !== expectedStatus) invalid("manifest_status_mismatch");
  return {
    schemaVersion: input.schemaVersion as SonyManifest["schemaVersion"],
    source: SOURCE,
    runId: input.runId as string,
    startedAt,
    completedAt,
    status,
    window,
    transactionCount,
    artifacts,
    failures,
  };
}

function parseWindow(value: unknown): { from: string; to: string } {
  const input = record(value, "manifest_window_invalid");
  exactKeys(input, ["from", "to"]);
  const from = date(input.from, "manifest_window_invalid");
  const to = date(input.to, "manifest_window_invalid");
  const days =
    Math.floor(
      (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000,
    ) + 1;
  if (days < 1 || days > 366) invalid("manifest_window_invalid");
  return { from, to };
}

function parseArtifact(value: unknown, prefix: string): SonyArtifactManifest {
  const input = record(value, "manifest_artifact_invalid");
  exactKeys(input, ["dataset", "key", "mediaType", "sha256", "bytes"]);
  if (typeof input.dataset !== "string" || !DATASET.test(input.dataset)) {
    invalid("manifest_dataset_invalid");
  }
  const filename = filenameFor(input.dataset);
  if (!filename || input.key !== `${prefix}${filename}`) invalid("manifest_artifact_key_mismatch");
  if (typeof input.mediaType !== "string" || !validMediaType(input.dataset, input.mediaType)) {
    invalid("manifest_media_type_invalid");
  }
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
  return {
    dataset: input.dataset,
    key: input.key as string,
    mediaType: input.mediaType,
    sha256: input.sha256,
    bytes: input.bytes as number,
  };
}

function parseFailure(value: unknown): SonyFailure {
  const input = record(value, "manifest_failure_invalid");
  exactKeys(input, ["operation", "errorType", "message"]);
  if (
    typeof input.operation !== "string" ||
    !(
      input.operation === "collect" ||
      (input.operation.startsWith("r2:") && DATASET.test(input.operation.slice(3)))
    )
  ) {
    invalid("manifest_failure_operation_invalid");
  }
  if (
    typeof input.errorType !== "string" ||
    !/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/u.test(input.errorType)
  ) {
    invalid("manifest_failure_type_invalid");
  }
  if (
    typeof input.message !== "string" ||
    input.message.length > 300 ||
    secretText(input.message)
  ) {
    invalid("manifest_failure_message_invalid");
  }
  return { operation: input.operation, errorType: input.errorType, message: input.message };
}

function validateCompleteness(manifest: SonyManifest, artifacts: VerifiedArtifact[]): void {
  const collectFailures = manifest.failures.filter((failure) => failure.operation === "collect");
  if (collectFailures.length > 0) {
    if (
      collectFailures.length !== 1 ||
      manifest.failures.length !== 1 ||
      artifacts.length !== 0 ||
      manifest.transactionCount !== 0 ||
      manifest.status !== "failed"
    ) {
      invalid("manifest_collect_failure_mismatch");
    }
    return;
  }
  if (manifest.failures.some((failure) => !failure.operation.startsWith("r2:"))) {
    invalid("manifest_failure_operation_invalid");
  }
  const present = new Map(artifacts.map((artifact) => [artifact.artifact.dataset, artifact]));
  const failed = manifest.failures.map((failure) => failure.operation.slice(3));
  const declared = new Set([...present.keys(), ...failed]);
  const legacy = manifest.schemaVersion === LEGACY_SCHEMA_VERSION;

  const yenPages = pageNames(declared, /^yen-history-page-(\d{4})$/u, "yen-history-page");
  const foreignPages = new Map<string, string[]>();
  if (!legacy) {
    for (const currency of CURRENCIES) {
      foreignPages.set(
        currency,
        pageNames(
          declared,
          new RegExp(`^foreign-history-${currency}-page-(\\d{4})$`, "u"),
          `foreign-history-${currency}-page`,
        ),
      );
    }
  }
  const walletNames = [...declared].filter((name) => /^wallet-history-\d{6}$/u.test(name));
  walletNames.sort((left, right) => right.localeCompare(left));
  if (
    (!legacy && walletNames.length < 1) ||
    walletNames.length > 15 ||
    new Set(walletNames).size !== walletNames.length ||
    walletNames.some((name) => !validMonth(name.slice(-6)))
  ) {
    invalid("manifest_wallet_months_invalid");
  }
  const expected = ["gross-balance", ...yenPages];
  // Sony's UI offers CSV only for non-empty history. Preserve acceptance of
  // older captures containing an empty CSV, but permit omission only when the
  // verified source JSON proves there are no JPY transactions. A manifest's
  // count alone is not evidence (including when the JSON failed to persist).
  const yenFirst = present.get(yenPages[0] ?? "")?.page;
  if (legacy || declared.has("yen-history-csv") || yenFirst?.declaredTotal !== 0) {
    expected.push("yen-history-csv");
  }
  if (!legacy) {
    for (const currency of CURRENCIES) {
      const pages = foreignPages.get(currency)!;
      expected.push(...pages);
      const first = present.get(pages[0] ?? "")?.page;
      const csv = `foreign-history-${currency}-csv`;
      if (first?.declaredTotal !== null && first?.declaredTotal !== undefined) {
        const shouldExist = first.declaredTotal > 0;
        if (declared.has(csv) !== shouldExist) invalid("manifest_foreign_csv_condition_mismatch");
      }
      if (declared.has(csv)) expected.push(csv);
    }
  }
  expected.push(...walletNames, "collection-summary");
  if (expected.length !== declared.size || expected.some((name) => !declared.has(name))) {
    invalid("manifest_dataset_completeness_mismatch");
  }
  const expectedPresent = expected.filter((name) => present.has(name));
  if (
    !sameStrings(
      expectedPresent,
      artifacts.map((artifact) => artifact.artifact.dataset),
    )
  ) {
    invalid("manifest_dataset_order_invalid");
  }
  const expectedFailed = expected.filter((name) => !present.has(name));
  if (!sameStrings(expectedFailed, failed)) invalid("manifest_failure_order_invalid");

  validatePageGroup(yenPages, present, manifest.transactionCount, "yen");
  if (!legacy) {
    for (const currency of CURRENCIES) {
      validatePageGroup(foreignPages.get(currency)!, present, null, currency);
    }
  }

  const summaries = artifacts.filter((artifact) => artifact.summary);
  if (summaries.length > 1) invalid("summary_duplicate");
  const summary = summaries[0]?.summary;
  if (summary) {
    if (
      !sameWindow(summary.window, manifest.window) ||
      summary.transactionCount !== manifest.transactionCount ||
      summary.pageCount !== yenPages.length ||
      (!legacy && summary.foreignCurrencyCount !== CURRENCIES.length) ||
      (!legacy &&
        summary.foreignPageCount !==
          [...foreignPages.values()].reduce((sum, pages) => sum + pages.length, 0)) ||
      (!legacy && summary.walletMonthCount !== walletNames.length)
    ) {
      invalid("summary_manifest_mismatch");
    }
    if (!legacy) {
      const totals = CURRENCIES.map(
        (currency) =>
          present.get(foreignPages.get(currency)![0] ?? "")?.page?.declaredTotal ?? null,
      );
      if (
        totals.every((value): value is number => value !== null) &&
        totals.reduce((sum, value) => sum + value, 0) !== summary.foreignTransactionCount
      ) {
        invalid("summary_foreign_count_mismatch");
      }
    }
  }

  const selectorSets = artifacts.flatMap((artifact) =>
    artifact.walletMonths ? [artifact.walletMonths] : [],
  );
  for (const set of selectorSets) {
    if (!sameStrings(set, walletNames)) invalid("wallet_selector_mismatch");
  }
  for (const artifact of artifacts) {
    if (
      artifact.walletSelectedMonth !== undefined &&
      artifact.walletSelectedMonth !== artifact.artifact.dataset.slice(-6)
    ) {
      invalid("wallet_selected_month_mismatch");
    }
  }
}

function pageNames(declared: Set<string>, pattern: RegExp, prefix: string): string[] {
  const indices = [...declared]
    .flatMap((name) => {
      const match = pattern.exec(name);
      return match ? [Number(match[1])] : [];
    })
    .sort((left, right) => left - right);
  if (
    indices.length < 1 ||
    indices.length > MAX_HISTORY_PAGES ||
    indices.some((value, index) => value !== index + 1)
  ) {
    invalid("manifest_page_sequence_invalid");
  }
  return indices.map((index) => `${prefix}-${String(index).padStart(4, "0")}`);
}

function validatePageGroup(
  names: string[],
  present: Map<string, VerifiedArtifact>,
  manifestTotal: number | null,
  _group: string,
): void {
  const parsed = names.flatMap((name) =>
    present.get(name)?.page ? [present.get(name)!.page!] : [],
  );
  const totals = parsed.flatMap((page) =>
    page.declaredTotal === null ? [] : [page.declaredTotal],
  );
  if (new Set(totals).size > 1) invalid("artifact_page_total_mismatch");
  const declaredTotal = totals[0] ?? null;
  if (manifestTotal !== null && declaredTotal !== null && manifestTotal !== declaredTotal) {
    invalid("manifest_transaction_count_mismatch");
  }
  const effectiveTotal = declaredTotal ?? manifestTotal;
  if (effectiveTotal !== null) {
    const expectedPages = Math.max(1, Math.ceil(effectiveTotal / PAGE_SIZE));
    if (names.length !== expectedPages) invalid("artifact_page_count_mismatch");
    for (const page of parsed) {
      const expectedRows = Math.max(
        0,
        Math.min(PAGE_SIZE, effectiveTotal - (page.index - 1) * PAGE_SIZE),
      );
      if (page.rowCount !== expectedRows) invalid("artifact_page_rows_mismatch");
    }
  }
}

function parseArtifactPayload(
  artifact: SonyArtifactManifest,
  bytes: Uint8Array,
  schemaVersion: SonyManifest["schemaVersion"],
): VerifiedArtifact {
  const filename = filenameFor(artifact.dataset)!;
  if (artifact.dataset.endsWith("-csv")) return { artifact, filename };
  if (artifact.dataset.startsWith("wallet-history-")) {
    let html: string;
    try {
      html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new ImportError(409, "wallet_html_encoding_invalid");
    }
    if (/;jsessionid=/iu.test(html) || unsafeHiddenInput(html)) {
      throw new ImportError(409, "wallet_html_not_sanitized");
    }
    const months = walletMonths(html);
    const selectedMonth = walletSelectedMonth(html);
    if (months.length < 1 || months.length > 15) {
      throw new ImportError(409, "wallet_selector_invalid");
    }
    if (!selectedMonth) throw new ImportError(409, "wallet_selected_month_invalid");
    return { artifact, filename, walletMonths: months, walletSelectedMonth: selectedMonth };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ImportError(409, "artifact_json_invalid");
  }
  if (containsSecretField(parsed)) throw new ImportError(409, "artifact_secret_field_present");
  if (artifact.dataset === "collection-summary") {
    return { artifact, filename, summary: parseSummary(parsed, schemaVersion) };
  }
  const pageMatch = /^(yen-history|foreign-history-[a-z]{3})-page-(\d{4})$/u.exec(artifact.dataset);
  if (pageMatch) {
    const body = conflictRecord(parsed, "artifact_page_payload_invalid");
    if (!Array.isArray(body.transactionHistInfo) || body.transactionHistInfo.length > PAGE_SIZE) {
      throw new ImportError(409, "artifact_page_payload_invalid");
    }
    const count = body.countCnt === undefined ? null : nonNegativeInteger(body.countCnt);
    if (body.countCnt !== undefined && count === null) {
      throw new ImportError(409, "artifact_page_payload_invalid");
    }
    return {
      artifact,
      filename,
      page: {
        group: pageMatch[1]!,
        index: Number(pageMatch[2]),
        rowCount: body.transactionHistInfo.length,
        declaredTotal: count,
      },
    };
  }
  if (artifact.dataset === "gross-balance") {
    conflictRecord(parsed, "artifact_gross_balance_invalid");
    return { artifact, filename };
  }
  throw new ImportError(409, "artifact_dataset_payload_invalid");
}

function parseSummary(value: unknown, schemaVersion: SonyManifest["schemaVersion"]): Summary {
  const input = conflictRecord(value, "summary_invalid");
  const legacy = schemaVersion === LEGACY_SCHEMA_VERSION;
  conflictExactKeys(
    input,
    legacy
      ? ["schemaVersion", "window", "transactionCount", "pageCount", "cookieNames"]
      : [
          "schemaVersion",
          "window",
          "transactionCount",
          "pageCount",
          "foreignCurrencyCount",
          "foreignTransactionCount",
          "foreignPageCount",
          "walletMonthCount",
          "cookieNames",
        ],
    "summary_invalid",
  );
  const expectedSummaryVersion = legacy ? LEGACY_SUMMARY_VERSION : SUMMARY_VERSION;
  if (input.schemaVersion !== expectedSummaryVersion) {
    throw new ImportError(409, "summary_schema_invalid");
  }
  const window = conflictWindow(input.window);
  const transactionCount = requiredCount(input.transactionCount, "summary_count_invalid");
  const pageCount = requiredCount(input.pageCount, "summary_count_invalid");
  const foreignCurrencyCount = legacy
    ? 0
    : requiredCount(input.foreignCurrencyCount, "summary_count_invalid");
  const foreignTransactionCount = legacy
    ? 0
    : requiredCount(input.foreignTransactionCount, "summary_count_invalid");
  const foreignPageCount = legacy
    ? 0
    : requiredCount(input.foreignPageCount, "summary_count_invalid");
  const walletMonthCount = legacy
    ? 0
    : requiredCount(input.walletMonthCount, "summary_count_invalid");
  if (
    !Array.isArray(input.cookieNames) ||
    input.cookieNames.length > 100 ||
    input.cookieNames.some((name) => typeof name !== "string" || !COOKIE_NAME.test(name)) ||
    !sameStrings(input.cookieNames as string[], [...(input.cookieNames as string[])].sort()) ||
    new Set(input.cookieNames as string[]).size !== input.cookieNames.length
  ) {
    throw new ImportError(409, "summary_cookie_names_invalid");
  }
  return {
    window,
    transactionCount,
    pageCount,
    foreignCurrencyCount,
    foreignTransactionCount,
    foreignPageCount,
    walletMonthCount,
    cookieNames: input.cookieNames as string[],
  };
}

async function artifactPlans(
  validated: ValidatedRun,
  unitId: number,
  fingerprintKey: string,
  manifestKey: string,
): Promise<ArtifactPlan[]> {
  const plans: ArtifactPlan[] = [];
  for (const [sequence, verified] of validated.artifacts.entries()) {
    const descriptor = await dataDescriptor(
      verified,
      sequence,
      unitId,
      validated.manifest,
      fingerprintKey,
    );
    plans.push({
      source: verified.artifact,
      bytes: verified.artifact.bytes,
      sha256: verified.artifact.sha256,
      descriptor,
      inventory: {
        artifactKey: verified.filename,
        sha256: verified.artifact.sha256,
        descriptorSha256: await descriptorSha256(descriptor),
      },
    });
  }
  const descriptor = await manifestDescriptor(validated, manifestKey, unitId, fingerprintKey);
  plans.push({
    source: null,
    bytes: validated.manifestBytes.byteLength,
    sha256: validated.manifestSha256,
    descriptor,
    inventory: {
      artifactKey: "manifest.json",
      sha256: validated.manifestSha256,
      descriptorSha256: await descriptorSha256(descriptor),
    },
  });
  return plans;
}

async function dataDescriptor(
  verified: VerifiedArtifact,
  sequence: number,
  unitId: number,
  manifest: SonyManifest,
  fingerprintKey: string,
): Promise<JsonObject> {
  const dataset = verified.artifact.dataset;
  const csv = dataset.endsWith("-csv");
  const wallet = dataset.startsWith("wallet-history-");
  const summary = dataset === "collection-summary";
  const role = summary
    ? "collector_summary"
    : wallet
      ? "sanitized_provider_capture"
      : csv
        ? "provider_export"
        : "provider_response";
  const fidelity = summary
    ? "generated"
    : wallet
      ? "transformed"
      : csv
        ? "exact"
        : "transport_decoded";
  const lineage = wallet ? "source_not_retained_for_security" : "not_applicable";
  const ranges = wallet
    ? [
        {
          rangeKey: "statement-month",
          rangeKind: "selector",
          precision: "month",
          startValue: `${dataset.slice(-6, -2)}-${dataset.slice(-2)}`,
          endValue: `${dataset.slice(-6, -2)}-${dataset.slice(-2)}`,
          startInclusive: 1,
          endInclusive: 1,
          basis: "source",
        },
      ]
    : dataset.includes("history") || summary
      ? [
          {
            rangeKey: "request-window",
            rangeKind: "requested",
            precision: "date",
            startValue: manifest.window.from,
            endValue: manifest.window.to,
            startInclusive: 1,
            endInclusive: 1,
            basis: "manifest",
          },
        ]
      : [];
  const transformSteps = wallet
    ? ["transport_decoded", "redacted", "reencoded"].map((stepKind, stepIndex) => ({
        stepIndex,
        stepKind,
        transformerId: "sony-bank-worker",
        transformerVersion: manifest.schemaVersion,
      }))
    : [];
  return normalizedDescriptor({
    artifactKey: verified.filename,
    artifactRole: role,
    payloadFidelity: fidelity,
    lineageDisposition: lineage,
    dataset,
    formatId: formatId(dataset),
    formatVersion: manifest.schemaVersion,
    declaredMediaType: mediaTypeBase(verified.artifact.mediaType),
    mediaTypeBasis: "manifest",
    fetchedAtMs: Date.parse(manifest.completedAt),
    fetchUnitId: unitId,
    sequence,
    sha256: verified.artifact.sha256,
    byteSize: verified.artifact.bytes,
    storage: await storageOrigin(verified.artifact.key, fingerprintKey),
    ranges,
    transformSteps,
  });
}

async function manifestDescriptor(
  validated: ValidatedRun,
  key: string,
  unitId: number,
  fingerprintKey: string,
): Promise<JsonObject> {
  return normalizedDescriptor({
    artifactKey: "manifest.json",
    artifactRole: "collector_manifest",
    payloadFidelity: "generated",
    lineageDisposition: "not_applicable",
    dataset: "collector-manifest",
    formatId: "sony-bank-collector-manifest-json",
    formatVersion: validated.manifest.schemaVersion,
    declaredMediaType: "application/json",
    mediaTypeBasis: "operator",
    fetchedAtMs: Date.parse(validated.manifest.completedAt),
    fetchUnitId: unitId,
    sequence: validated.artifacts.length,
    sha256: validated.manifestSha256,
    byteSize: validated.manifestBytes.byteLength,
    storage: await storageOrigin(key, fingerprintKey),
    ranges: [],
    transformSteps: [],
  });
}

function normalizedDescriptor(input: {
  artifactKey: string;
  artifactRole: string;
  payloadFidelity: string;
  lineageDisposition: string;
  dataset: string;
  formatId: string;
  formatVersion: SonyManifest["schemaVersion"];
  declaredMediaType: string;
  mediaTypeBasis: string;
  fetchedAtMs: number;
  fetchUnitId: number;
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
    fetchedAtBasis: "manifest",
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

async function storageOrigin(key: string, fingerprintKey: string): Promise<JsonObject> {
  if (!SHA256.test(fingerprintKey)) throw new ImportError(500, "fingerprint_configuration_invalid");
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
    objectVersion: null,
    etag: null,
    lastModifiedAtMs: null,
    lastModifiedAtBasis: null,
  };
}

async function readVerifiedArtifact(
  bucket: R2Bucket,
  artifact: SonyArtifactManifest,
  runId: string,
): Promise<Uint8Array> {
  const object = await bucket.get(artifact.key);
  if (!object) throw new ImportError(409, "artifact_missing");
  if (object.size !== artifact.bytes || object.size > MAX_ARTIFACT_BYTES) {
    throw new ImportError(409, "artifact_size_mismatch");
  }
  assertArtifactMetadata(object.customMetadata, artifact, runId);
  if (object.httpMetadata?.contentType !== artifact.mediaType) {
    throw new ImportError(409, "artifact_content_type_mismatch");
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  assertNativeSha256(object, artifact.sha256);
  if ((await sha256Hex(bytes)) !== artifact.sha256)
    throw new ImportError(409, "artifact_checksum_mismatch");
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
    if (actual.length > MAX_SOURCE_ARTIFACTS + 1)
      throw new ImportError(409, "prefix_inventory_too_large");
  } while (cursor);
  actual.sort();
  const expected = [...expectedKeys].sort();
  if (!sameStrings(actual, expected)) throw new ImportError(409, "prefix_inventory_mismatch");
}

function filenameFor(dataset: string): string | null {
  if (
    dataset === "gross-balance" ||
    dataset === "collection-summary" ||
    /-page-\d{4}$/u.test(dataset)
  ) {
    return `${dataset}.json`;
  }
  if (dataset === "yen-history-csv") return "yen-history.csv";
  const foreignCsv = /^foreign-history-([a-z]{3})-csv$/u.exec(dataset);
  if (foreignCsv && (CURRENCIES as readonly string[]).includes(foreignCsv[1]!)) {
    return `foreign-history-${foreignCsv[1]}.csv`;
  }
  const wallet = /^wallet-history-(\d{4})(\d{2})$/u.exec(dataset);
  if (wallet && validMonth(`${wallet[1]}${wallet[2]}`))
    return `wallet-history-${wallet[1]}-${wallet[2]}.html`;
  return null;
}

function validMediaType(dataset: string, value: string): boolean {
  if (
    /^(gross-balance|collection-summary|(yen-history|foreign-history-[a-z]{3})-page-\d{4})$/u.test(
      dataset,
    )
  ) {
    return value === "application/json";
  }
  if (dataset.startsWith("wallet-history-")) return value === "text/html; charset=UTF-8";
  if (dataset.endsWith("-csv")) return CSV_MEDIA.has(mediaTypeBase(value)) && safeMediaType(value);
  return false;
}

function safeMediaType(value: string): boolean {
  return (
    value.length <= 255 &&
    /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:\s*;\s*charset=(?:[a-z0-9._-]+|"[a-z0-9._-]+"))?$/iu.test(
      value,
    )
  );
}

function mediaTypeBase(value: string): string {
  return value.split(";", 1)[0]!.trim().toLowerCase();
}

function formatId(dataset: string): string {
  if (dataset === "gross-balance") return "sony-bank-gross-balance-json";
  if (dataset === "collection-summary") return "sony-bank-collection-summary-json";
  if (dataset.startsWith("wallet-history-")) return "sony-bank-wallet-history-html";
  if (dataset.endsWith("-csv")) return "sony-bank-transaction-history-csv";
  return "sony-bank-transaction-history-json";
}

function walletMonths(html: string): string[] {
  const select = html.match(
    /<select\b[^>]*\bname\s*=\s*["']W131301\.referenceDate["'][^>]*>([\s\S]*?)<\/select>/iu,
  )?.[1];
  if (!select) return [];
  const months: string[] = [];
  for (const match of select.matchAll(/<option\b[^>]*\bvalue\s*=\s*["'](\d{8})["'][^>]*>/giu)) {
    const month = match[1]!.slice(0, 6);
    if (!validMonth(month) || months.includes(`wallet-history-${month}`)) return [];
    months.push(`wallet-history-${month}`);
  }
  return months;
}

function walletSelectedMonth(html: string): string | null {
  const select = html.match(
    /<select\b[^>]*\bname\s*=\s*["']W131301\.referenceDate["'][^>]*>([\s\S]*?)<\/select>/iu,
  )?.[1];
  if (!select) return null;
  const options = [
    ...select.matchAll(/<option\b([^>]*)\bvalue\s*=\s*["'](\d{8})["']([^>]*)>/giu),
  ].map((match) => ({
    month: match[2]!.slice(0, 6),
    selected: /(?:^|\s)selected(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?(?=\s|$)/iu.test(
      `${match[1] ?? ""} ${match[3] ?? ""}`,
    ),
  }));
  const selected = options.filter((option) => option.selected);
  if (selected.length > 1) return null;
  return (selected[0] ?? options[0])?.month ?? null;
}

function unsafeHiddenInput(html: string): boolean {
  for (const match of html.matchAll(/<input\b[^>]*>/giu)) {
    const tag = match[0];
    const type = attribute(tag, "type").toLowerCase();
    const name = attribute(tag, "name").toLowerCase();
    if ((type === "hidden" || name === "cc") && attribute(tag, "value") !== "") return true;
  }
  return false;
}

function attribute(tag: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = tag.match(
    new RegExp(`\\b${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "iu"),
  );
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
}

function containsSecretField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSecretField);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value as JsonObject).some(
    ([key, child]) =>
      /^(loginpwd|password|csrf|debitssobindat|messagecheck)$/iu.test(key) ||
      containsSecretField(child),
  );
}

function secretText(value: string): boolean {
  return (
    /Bearer\s+(?!\[redacted\])\S+/iu.test(value) ||
    /(?:password|loginPwd|cookie|csrf|token)\s*=\s*(?!\[redacted\])\S+/iu.test(value)
  );
}

function assertManifestMetadata(
  actual: Record<string, string> | undefined,
  manifest: SonyManifest,
  sha256: string,
): void {
  const legacy = { source: manifest.source, status: manifest.status, runId: manifest.runId };
  if (sameMetadata(actual, legacy)) return;
  assertExactMetadata(actual, { ...legacy, sha256 }, "manifest_metadata_mismatch");
}

function assertArtifactMetadata(
  actual: Record<string, string> | undefined,
  artifact: SonyArtifactManifest,
  runId: string,
): void {
  const legacy = { dataset: artifact.dataset, sha256: artifact.sha256 };
  if (sameMetadata(actual, legacy)) return;
  assertExactMetadata(
    actual,
    {
      source: SOURCE,
      runId,
      dataset: artifact.dataset,
      sha256: artifact.sha256,
    },
    "artifact_metadata_mismatch",
  );
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
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index] && actual[key] === expected[key])
  );
}

function assertNativeSha256(object: R2ObjectBody, expected: string): void {
  const native = object.checksums.sha256;
  if (native && bytesHex(new Uint8Array(native)) !== expected) {
    throw new ImportError(409, "artifact_native_checksum_mismatch");
  }
}

function parseSummaryCount(value: unknown): number | null {
  return nonNegativeInteger(value);
}

function requiredCount(value: unknown, code: string): number {
  const parsed = parseSummaryCount(value);
  if (parsed === null) throw new ImportError(409, code);
  return parsed;
}

function conflictWindow(value: unknown): { from: string; to: string } {
  try {
    return parseWindow(value);
  } catch {
    throw new ImportError(409, "summary_window_invalid");
  }
}

function sameWindow(
  left: { from: string; to: string },
  right: { from: string; to: string },
): boolean {
  return left.from === right.from && left.to === right.to;
}

function safeFailureCode(failures: SonyFailure[]): string {
  if (failures.some((failure) => failure.operation === "collect"))
    return "collector-request-failed";
  return "staging-write-failed";
}

function validMonth(value: string): boolean {
  if (!/^\d{6}$/u.test(value)) return false;
  const month = Number(value.slice(4));
  return month >= 1 && month <= 12;
}

function date(value: unknown, code: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value
  )
    invalid(code);
  return value;
}

function instant(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length > 35) invalid(code);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) invalid(code);
  return value;
}

function nonNegativeInteger(value: unknown): number | null {
  const parsed = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function record(value: unknown, code: string): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") invalid(code);
  return value as JsonObject;
}

function conflictRecord(value: unknown, code: string): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object")
    throw new ImportError(409, code);
  return value as JsonObject;
}

function exactKeys(value: JsonObject, allowed: readonly string[]): void {
  const set = new Set(allowed);
  if (Object.keys(value).some((key) => !set.has(key))) invalid("manifest_unknown_field");
}

function conflictExactKeys(value: JsonObject, allowed: readonly string[], code: string): void {
  const set = new Set(allowed);
  if (
    Object.keys(value).some((key) => !set.has(key)) ||
    Object.keys(value).length !== allowed.length
  ) {
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

function invalid(code: string): never {
  throw new ImportError(400, code);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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
      Object.entries(value)
        .sort(([left], [right]) => binaryCompare(left, right))
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
  return sha256Hex(canonicalJson(normalized as JsonValue));
}

async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
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
