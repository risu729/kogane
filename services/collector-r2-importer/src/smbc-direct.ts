import { decode, encode } from "iconv-lite";
import { CentralClient } from "./central";
import { ImportError } from "./error";
import type { CentralInventoryItem } from "./types";

const EXTERNAL_SOURCE = "smbc-direct" as const;
const CENTRAL_SOURCE = "smbc-bank";
const PRODUCER = "collector-r2-importer";
const SCHEMA_VERSION = "smbc-direct-backfill-worker-poc-v1";
const INGEST_CONTRACT_VERSION = "smbc-direct-r2-v1";
const CENTRAL_CLIENT_ID = "collector-r2-smbc-direct";
const STORAGE_CONTAINER = "kogane-smbc-direct-backfill-poc";
const STORAGE_TEMPLATE = "raw/smbc-direct/{date}/{run-id}/{artifact}";
const FINGERPRINT_VERSION = "collector-r2-v1";
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_ARTIFACTS = 9_999;
export const SMBC_DIRECT_TRANSFER_CHUNK_SIZE = 10;
const DIRECT_ARTIFACT_LIMIT = 12;
const MANIFEST_KEY = /^raw\/smbc-direct\/(\d{4})\/(\d{2})\/(\d{2})\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/manifest\.json$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const FIXED_FAILURE_CODES = new Set([
  "_formid_field_missing",
  "_token_field_missing",
  "account_detail_body_missing",
  "account_detail_body_too_large",
  "aifcdt3_form_missing",
  "aifcdtl_form_missing",
  "balance_body_missing",
  "balance_body_too_large",
  "balance_invalid",
  "balance_value_missing",
  "continue_session_body_missing",
  "continue_session_body_too_large",
  "crypto_error",
  "deposits_total_invalid",
  "directheaderform_form_missing",
  "json_parse_failed",
  "logout_failed",
  "session_missing",
  "tpaltop_form_missing",
  "transaction_amount_invalid",
  "transaction_balance_invalid",
  "transaction_count_invalid",
  "transaction_date_invalid",
  "transaction_direction_invalid",
  "transactions_body_missing",
  "transactions_body_too_large",
  "transactions_json_invalid",
  "transactions_rejected",
  "transactions_service_time_unavailable",
  "transactions_stop_flag_invalid",
  "type_error",
  "unexpected_error",
  "withdrawals_total_invalid",
]);
const HTTP_FAILURE_CODE = /^(?:account_detail|balance|continue_session|transactions)_http_[1-5][0-9]{2}$/u;
const RAW_MEDIA_TYPE = "application/json;charset=Shift_JIS";
const JSON_MEDIA_TYPE = "application/json; charset=utf-8";
const BALANCE_RESPONSE_KEYS = [
  "ajaxGaikaAccountBalance",
  "ajaxGaikaFutsuAccountBalance",
  "ajaxGaikaFutsuStartFlag",
  "ajaxGaikaStartFlag",
  "ajaxHighCouponBalanceEUR",
  "ajaxHighCouponBalanceUSD",
  "ajaxHighCouponStartFlag",
  "ajaxJuLoanAccountBalanceNcsstyFlag",
  "ajaxJuLoanBonusMonRepaymentAmount",
  "ajaxJuLoanBonusMonthRepayment",
  "ajaxJuLoanKouZaBalance",
  "ajaxJuLoanRepaymentAmount",
  "ajaxJuLoanRepaymentKbn",
  "ajaxPremiumYenAccountBalance",
  "ajaxPremiumYenStartFlag",
  "ajaxRyudoAccountBalance",
  "ajaxRyudoAccountPayableBalance",
  "ajaxRyudoStartFlag",
  "ajaxSaikenAccountBalance",
  "ajaxSaikenStartFlag",
  "ajaxSavingAccountBalance",
  "ajaxSavingStartFlag",
  "ajaxToshinAccountBalance",
  "ajaxToshinCurrency",
  "ajaxToshinStartFlag",
  "ajaxYenTeikiAccountBalance",
  "ajaxYenTeikiStartFlag",
  "ajaxZaikeAccountBalance",
  "ajaxZaikeStartFlag",
] as const;

type JsonObject = Record<string, unknown>;
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type Status = "success" | "partial" | "failed";
type Dataset =
  | "balance-raw"
  | "balance-normalized"
  | "transactions-raw"
  | "transactions-normalized";

interface DateRange {
  start: string;
  end: string;
}

interface Artifact {
  dataset: Dataset;
  key: string;
  mediaType: string;
  bytes: number;
  sha256: string;
  range?: DateRange;
  transactionCount?: number;
}

interface Manifest {
  schemaVersion: typeof SCHEMA_VERSION;
  source: typeof EXTERNAL_SOURCE;
  runId: string;
  startedAt: string;
  completedAt: string;
  status: Status;
  requestedRange: DateRange;
  completedChunks: number;
  totalChunks: number;
  transactionCount: number;
  artifacts: Artifact[];
  failureCodes: string[];
  logoutSucceeded: boolean;
}

interface LoadedManifest {
  manifest: Manifest;
  bytes: Uint8Array;
  sha256: string;
}

interface NormalizedTransaction {
  id: string;
  date: string;
  amount: number;
  balanceAfter: number;
  description: string;
  direction: "credit" | "debit";
}

interface BalancePayload {
  kind: "balance-raw" | "balance-normalized";
  amount: number;
}

interface TransactionPayload {
  kind: "transactions-raw" | "transactions-normalized";
  range: DateRange;
  depositsTotal: number;
  withdrawalsTotal: number;
  transactions: NormalizedTransaction[];
}

type VerifiedPayload = BalancePayload | TransactionPayload;

interface VerifiedArtifact {
  artifact: Artifact;
  bytes: Uint8Array;
  payload: VerifiedPayload;
}

interface ValidatedRun {
  manifest: Manifest;
  manifestBytes: Uint8Array;
  manifestSha256: string;
  artifacts: VerifiedArtifact[];
}

interface ArtifactPlan {
  source: Artifact | null;
  sha256: string;
  descriptor: JsonObject;
  inventory: CentralInventoryItem;
}

export type ImportSmbcDirectResult = ImportSmbcDirectDeferred | ImportSmbcDirectSealed;

export interface ImportSmbcDirectDeferred {
  source: typeof EXTERNAL_SOURCE;
  manifestKey: string;
  status: "deferred";
  reason: "worker_invocation_limit" | "central_inventory_limit";
  artifactCount: number;
  nextOffset: number;
}

export interface ImportSmbcDirectSealed {
  source: typeof EXTERNAL_SOURCE;
  manifestKey: string;
  status: "sealed";
  centralRunId: number;
  artifactCount: number;
  sealed: true;
  finalChunkAllObjectsReused: boolean;
}

export async function importSmbcDirectRun(options: {
  bucket: R2Bucket;
  centralService: Fetcher;
  centralToken: string;
  fingerprintKey: string;
  importerVersion: string;
  manifestKey: string;
  offset?: number;
  immediate?: boolean;
}): Promise<ImportSmbcDirectResult> {
  const startedAtMs = Date.now();
  const attemptId = "attempt-" + crypto.randomUUID();
  let centralRunId: number | undefined;
  let acceptedArtifactCount = 0;
  let reusedArtifactCount = 0;
  let expectedArtifactCount = 0;
  let phase = "source_validation";
  const runId = options.manifestKey.match(MANIFEST_KEY)?.[4];
  const log = (
    outcome: "started" | "deferred" | "sealed" | "failed",
    nextOffset?: number,
    reason?: ImportSmbcDirectDeferred["reason"],
  ) => {
    try {
      console[outcome === "failed" ? "error" : "log"](JSON.stringify({
        event: "smbc-direct-import-diagnostic",
        source: EXTERNAL_SOURCE,
        attemptId,
        ...(runId ? { runId } : {}),
        phase,
        outcome,
        durationMs: Math.max(0, Date.now() - startedAtMs),
        expectedArtifactCount,
        acceptedArtifactCount,
        reusedArtifactCount,
        ...(centralRunId === undefined ? {} : { centralRunId }),
        ...(nextOffset === undefined ? {} : { nextOffset }),
        ...(reason === undefined ? {} : { reason }),
        ...(outcome === "failed" ? { errorCode: phase + "_failed" } : {}),
      }));
    } catch {
      // Diagnostics must not interrupt evidence transfer.
    }
  };
  log("started");

  try {
    const validated = await validateSmbcDirectRun(options.bucket, options.manifestKey);
    expectedArtifactCount = validated.artifacts.length + 1;
    const offset = options.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 ||
        (offset !== 0 && (
          options.immediate !== false ||
          offset % SMBC_DIRECT_TRANSFER_CHUNK_SIZE !== 0 ||
          offset >= expectedArtifactCount
        ))) {
      throw new ImportError(400, "transfer_offset_invalid");
    }
    if (expectedArtifactCount > 10_000) {
      log("deferred", offset, "central_inventory_limit");
      return deferred(options.manifestKey, expectedArtifactCount, "central_inventory_limit", offset);
    }
    if (options.immediate !== false && offset === 0 &&
        expectedArtifactCount > DIRECT_ARTIFACT_LIMIT) {
      log("deferred", 0, "worker_invocation_limit");
      return deferred(options.manifestKey, expectedArtifactCount, "worker_invocation_limit", 0);
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
      externalIdNamespace: validated.manifest.schemaVersion,
      externalSessionId: validated.manifest.runId,
      sourceRunKey: "account-history-" + INGEST_CONTRACT_VERSION,
    });
    await central.addRunRange(centralRunId, {
      rangeKey: "request-window",
      rangeKind: "requested",
      precision: "date",
      startValue: validated.manifest.requestedRange.start,
      endValue: validated.manifest.requestedRange.end,
      startInclusive: 1,
      endInclusive: 1,
      basis: "manifest",
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

    const end = Math.min(
      options.immediate === false ? offset + SMBC_DIRECT_TRANSFER_CHUNK_SIZE : plans.length,
      plans.length,
    );
    const chunkInventory: CentralInventoryItem[] = [];
    for (const plan of plans.slice(offset, end)) {
      const bytes = plan.source
        ? await readVerifiedArtifact(options.bucket, plan.source, validated.manifest)
        : validated.manifestBytes;
      if (await sha256Hex(bytes) !== plan.sha256) {
        throw new ImportError(409, "artifact_changed_during_import");
      }
      phase = "object_upload";
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
      return deferred(
        options.manifestKey,
        plans.length,
        "worker_invocation_limit",
        end,
      );
    }

    phase = "terminal_reports";
    await addTerminalReports(
      central,
      centralRunId,
      unitId,
      validated.manifest,
      plans.length,
    );
    phase = "seal";
    await central.sealStagedInventory(
      centralRunId,
      inventoryId,
      attemptId,
      startedAtMs,
    );
    log("sealed");
    return {
      source: EXTERNAL_SOURCE,
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
          errorCode: phase + "_failed",
          ingestClientVersion: options.importerVersion,
        });
      } catch {
        // Attempt reporting is best effort and cannot replace the source failure.
      }
    }
    throw error;
  }
}

function deferred(
  manifestKey: string,
  artifactCount: number,
  reason: ImportSmbcDirectDeferred["reason"],
  nextOffset: number,
): ImportSmbcDirectDeferred {
  return {
    source: EXTERNAL_SOURCE,
    manifestKey,
    status: "deferred",
    reason,
    artifactCount,
    nextOffset,
  };
}

async function addTerminalReports(
  central: CentralClient,
  centralRunId: number,
  unitId: number,
  manifest: Manifest,
  artifactCount: number,
): Promise<void> {
  const safeFailure = manifest.status === "success"
    ? {}
    : { safeFailureCode: manifest.status === "partial" ? "source-run-partial" : "source-run-failed" };
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
    ...safeFailure,
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
    declaredArtifactCount: artifactCount,
    artifactCountScope: "all_catalogued",
    ...safeFailure,
  });
}

export async function validateSmbcDirectRun(
  bucket: R2Bucket,
  manifestKey: string,
): Promise<ValidatedRun> {
  const loaded = await loadManifest(bucket, manifestKey);
  const prefix = manifestKey.slice(0, -"manifest.json".length);
  const expectedKeys = [
    ...loaded.manifest.artifacts.map((artifact) => artifact.key),
    manifestKey,
  ];
  await assertExactPrefix(bucket, prefix, expectedKeys);
  const artifacts: VerifiedArtifact[] = [];
  for (const artifact of loaded.manifest.artifacts) {
    const bytes = await readVerifiedArtifact(bucket, artifact, loaded.manifest);
    artifacts.push({
      artifact,
      bytes,
      payload: parsePayload(artifact, bytes, loaded.manifest),
    });
  }
  validateCompleteness(loaded.manifest, artifacts, prefix);
  await assertExactPrefix(bucket, prefix, expectedKeys);
  return {
    manifest: loaded.manifest,
    manifestBytes: loaded.bytes,
    manifestSha256: loaded.sha256,
    artifacts,
  };
}

async function loadManifest(bucket: R2Bucket, manifestKey: string): Promise<LoadedManifest> {
  const object = await bucket.get(manifestKey);
  if (!object) throw new ImportError(404, "manifest_not_found");
  if (object.size > MAX_MANIFEST_BYTES) throw new ImportError(413, "manifest_too_large");
  if (object.httpMetadata?.contentType !== JSON_MEDIA_TYPE) {
    throw new ImportError(409, "manifest_content_type_mismatch");
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  const sha256 = await sha256Hex(bytes);
  assertNativeSha256(object, sha256);
  assertExactMetadata(object.customMetadata, { sha256 }, "manifest_metadata_mismatch");
  return { manifest: parseSmbcDirectManifest(bytes, manifestKey), bytes, sha256 };
}

export function parseSmbcDirectManifest(bytes: Uint8Array, manifestKey: string): Manifest {
  const key = MANIFEST_KEY.exec(manifestKey);
  if (!key) invalid("manifest_key_invalid");
  const input = parseJson(bytes, "manifest_json_invalid", 400);
  exactShape(input, [
    "schemaVersion",
    "source",
    "runId",
    "startedAt",
    "completedAt",
    "status",
    "requestedRange",
    "completedChunks",
    "totalChunks",
    "transactionCount",
    "artifacts",
    "failureCodes",
    "logoutSucceeded",
  ], "manifest_shape_invalid", 400);
  if (input.schemaVersion !== SCHEMA_VERSION) invalid("manifest_schema_invalid");
  if (input.source !== EXTERNAL_SOURCE || input.runId !== key[4]) {
    invalid("manifest_identity_mismatch");
  }
  const startedAt = instant(input.startedAt, "manifest_started_at_invalid", 400);
  if (startedAt.slice(0, 10) !== key[1] + "-" + key[2] + "-" + key[3]) {
    invalid("manifest_date_mismatch");
  }
  if (input.completedAt === null || input.status === "running") {
    throw new ImportError(409, "manifest_not_terminal");
  }
  const completedAt = instant(input.completedAt, "manifest_completed_at_invalid", 400);
  if (completedAt < startedAt) invalid("manifest_time_reversed");
  const status = oneOf(
    input.status,
    ["success", "partial", "failed"] as const,
    "manifest_status_invalid",
    400,
  );
  const requestedRange = parseRange(input.requestedRange, "manifest_range_invalid", 400);
  const monthCount = monthRanges(requestedRange).length;
  const completedChunks = count(
    input.completedChunks,
    monthCount,
    "manifest_completed_chunks_invalid",
    400,
  );
  const totalChunks = count(
    input.totalChunks,
    MAX_SOURCE_ARTIFACTS / 2,
    "manifest_total_chunks_invalid",
    400,
    1,
  );
  if (totalChunks !== monthCount || completedChunks > totalChunks) {
    invalid("manifest_chunk_count_mismatch");
  }
  const transactionCount = count(
    input.transactionCount,
    10_000_000,
    "manifest_transaction_count_invalid",
    400,
  );
  if (!Array.isArray(input.artifacts) || input.artifacts.length > MAX_SOURCE_ARTIFACTS) {
    invalid("manifest_artifacts_invalid");
  }
  const prefix = manifestKey.slice(0, -"manifest.json".length);
  const artifacts = input.artifacts.map((value) => parseArtifact(value, prefix));
  if (!Array.isArray(input.failureCodes) || input.failureCodes.length > 20 ||
      input.failureCodes.some((value) => typeof value !== "string" || !validFailureCode(value)) ||
      new Set(input.failureCodes as string[]).size !== input.failureCodes.length) {
    invalid("manifest_failure_codes_invalid");
  }
  if (typeof input.logoutSucceeded !== "boolean") {
    invalid("manifest_logout_status_invalid");
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    source: EXTERNAL_SOURCE,
    runId: input.runId as string,
    startedAt,
    completedAt,
    status,
    requestedRange,
    completedChunks,
    totalChunks,
    transactionCount,
    artifacts,
    failureCodes: input.failureCodes as string[],
    logoutSucceeded: input.logoutSucceeded,
  };
}

function parseArtifact(value: unknown, prefix: string): Artifact {
  const input = record(value, "manifest_artifact_invalid", 400);
  const dataset = oneOf(
    input.dataset,
    [
      "balance-raw",
      "balance-normalized",
      "transactions-raw",
      "transactions-normalized",
    ] as const,
    "manifest_dataset_invalid",
    400,
  );
  const transaction = dataset.startsWith("transactions-");
  exactShape(
    input,
    transaction
      ? ["dataset", "key", "mediaType", "bytes", "sha256", "range", "transactionCount"]
      : ["dataset", "key", "mediaType", "bytes", "sha256"],
    "manifest_artifact_shape_invalid",
    400,
  );
  const range = transaction
    ? parseRange(input.range, "manifest_artifact_range_invalid", 400)
    : undefined;
  const expectedKey = transaction
    ? prefix + "transactions/" + compact(range!.start) + "-" + compact(range!.end) +
      (dataset === "transactions-raw" ? ".raw.json.sjis" : ".normalized.json")
    : prefix + (dataset === "balance-raw" ? "balance.raw.json.sjis" : "balance.normalized.json");
  if (input.key !== expectedKey) invalid("manifest_artifact_key_mismatch");
  const mediaType = dataset.endsWith("-raw") ? RAW_MEDIA_TYPE : JSON_MEDIA_TYPE;
  if (input.mediaType !== mediaType) invalid("manifest_media_type_invalid");
  if (typeof input.sha256 !== "string" || !SHA256.test(input.sha256)) {
    invalid("manifest_sha256_invalid");
  }
  const bytes = count(input.bytes, MAX_ARTIFACT_BYTES, "manifest_bytes_invalid", 400, 1);
  const transactionCount = transaction
    ? count(input.transactionCount, 100_000, "manifest_artifact_count_invalid", 400)
    : undefined;
  return {
    dataset,
    key: input.key as string,
    mediaType,
    bytes,
    sha256: input.sha256,
    ...(range ? { range } : {}),
    ...(transactionCount === undefined ? {} : { transactionCount }),
  };
}

function parsePayload(
  artifact: Artifact,
  bytes: Uint8Array,
  manifest: Manifest,
): VerifiedPayload {
  if (artifact.dataset.endsWith("-raw")) {
    const text = decode(bytes, "shift_jis");
    const roundTrip = new Uint8Array(encode(text, "shift_jis"));
    if (!sameBytes(roundTrip, bytes)) {
      throw new ImportError(409, "artifact_shift_jis_round_trip_failed");
    }
    const value = parseJsonText(text, "artifact_json_invalid");
    return artifact.dataset === "balance-raw"
      ? parseRawBalance(value)
      : parseRawTransactions(value, artifact);
  }
  const value = parseJson(bytes, "artifact_json_invalid", 409);
  return artifact.dataset === "balance-normalized"
    ? parseNormalizedBalance(value, manifest)
    : parseNormalizedTransactions(value, artifact);
}

function parseRawBalance(input: JsonObject): BalancePayload {
  exactShape(input, ["response", "success"], "balance_raw_shape_invalid", 409);
  if (input.success !== true) throw new ImportError(409, "balance_raw_unsuccessful");
  const response = record(input.response, "balance_raw_response_invalid", 409);
  exactShape(response, BALANCE_RESPONSE_KEYS, "balance_raw_response_shape_invalid", 409);
  for (const key of BALANCE_RESPONSE_KEYS) scalar(response[key], "balance_raw_scalar_invalid");
  return {
    kind: "balance-raw",
    amount: parseYen(response.ajaxSavingAccountBalance, "balance_raw_amount_invalid"),
  };
}

function parseNormalizedBalance(input: JsonObject, manifest: Manifest): BalancePayload {
  exactShape(input, ["amount", "currency", "observedAt"], "balance_normalized_shape_invalid", 409);
  if (input.currency !== "JPY" || input.observedAt !== manifest.startedAt) {
    throw new ImportError(409, "balance_normalized_identity_mismatch");
  }
  return {
    kind: "balance-normalized",
    amount: integer(input.amount, "balance_normalized_amount_invalid"),
  };
}

function parseRawTransactions(input: JsonObject, artifact: Artifact): TransactionPayload {
  exactShape(input, ["response", "success"], "transactions_raw_shape_invalid", 409);
  if (input.success !== true) throw new ImportError(409, "transactions_raw_unsuccessful");
  const response = record(input.response, "transactions_raw_response_invalid", 409);
  exactShape(response, [
    "accntHstCount",
    "currentDate",
    "mEndYmd",
    "mStartYmd",
    "meisai",
    "nyukinGoukei",
    "shoukaiServerStopFlag",
    "syukkinGoukei",
  ], "transactions_raw_response_shape_invalid", 409);
  for (const key of [
    "accntHstCount",
    "currentDate",
    "mEndYmd",
    "mStartYmd",
    "nyukinGoukei",
    "shoukaiServerStopFlag",
    "syukkinGoukei",
  ]) {
    scalar(response[key], "transactions_raw_scalar_invalid");
  }
  if (responseBoundaryDate(response.mStartYmd) !== artifact.range!.start ||
      responseBoundaryDate(response.mEndYmd) !== artifact.range!.end) {
    throw new ImportError(409, "transactions_raw_range_mismatch");
  }
  if (!Array.isArray(response.meisai) || response.meisai.length > 100_000) {
    throw new ImportError(409, "transactions_raw_rows_invalid");
  }
  const declaredCount = observedCount(response.accntHstCount, "transactions_raw_count_invalid");
  if (declaredCount !== response.meisai.length || declaredCount !== artifact.transactionCount) {
    throw new ImportError(409, "transactions_raw_count_mismatch");
  }
  if (response.shoukaiServerStopFlag !== "0") {
    throw new ImportError(409, "transactions_raw_stop_flag_invalid");
  }
  const transactions = response.meisai.map((value) => {
    const entry = record(value, "transactions_raw_row_invalid", 409);
    exactShape(entry, [
      "amount",
      "comment",
      "depositWithdrawTypeFlag",
      "detailIndex",
      "dispDate",
      "meisaiColorDisp",
      "meisaiId",
      "meisaiMemoDisp",
      "torihikigobalance",
    ], "transactions_raw_row_shape_invalid", 409);
    for (const key of Object.keys(entry)) scalar(entry[key], "transactions_raw_row_scalar_invalid");
    const direction = oneOf(
      entry.depositWithdrawTypeFlag,
      ["1", "2"] as const,
      "transactions_raw_direction_invalid",
      409,
    );
    return {
      id: boundedString(String(entry.meisaiId ?? ""), "transactions_raw_id_invalid"),
      date: transactionDate(entry.dispDate, compact(artifact.range!.end)),
      amount: Math.abs(parseYen(entry.amount, "transactions_raw_amount_invalid")),
      balanceAfter: parseYen(entry.torihikigobalance, "transactions_raw_balance_invalid"),
      description: boundedString(String(entry.comment ?? ""), "transactions_raw_description_invalid"),
      direction: direction === "1"
        ? "debit" as const
        : "credit" as const,
    };
  });
  if (transactions.length !== artifact.transactionCount) {
    throw new ImportError(409, "transactions_raw_count_mismatch");
  }
  return {
    kind: "transactions-raw",
    range: artifact.range!,
    depositsTotal: parseYen(response.nyukinGoukei, "transactions_raw_total_invalid"),
    withdrawalsTotal: parseYen(response.syukkinGoukei, "transactions_raw_total_invalid"),
    transactions,
  };
}

function parseNormalizedTransactions(
  input: JsonObject,
  artifact: Artifact,
): TransactionPayload {
  exactShape(input, [
    "depositsTotal",
    "range",
    "transactions",
    "withdrawalsTotal",
  ], "transactions_normalized_shape_invalid", 409);
  const range = parseRange(input.range, "transactions_normalized_range_invalid", 409);
  if (!sameRange(range, artifact.range!)) {
    throw new ImportError(409, "transactions_normalized_range_mismatch");
  }
  if (!Array.isArray(input.transactions) || input.transactions.length > 100_000) {
    throw new ImportError(409, "transactions_normalized_rows_invalid");
  }
  const transactions = input.transactions.map((value) => {
    const row = record(value, "transactions_normalized_row_invalid", 409);
    exactShape(row, [
      "amount",
      "balanceAfter",
      "date",
      "description",
      "direction",
      "id",
    ], "transactions_normalized_row_shape_invalid", 409);
    const dateValue = instantOffset(row.date, "transactions_normalized_date_invalid");
    return {
      id: boundedString(row.id, "transactions_normalized_id_invalid"),
      date: dateValue,
      amount: nonNegativeInteger(row.amount, "transactions_normalized_amount_invalid"),
      balanceAfter: integer(row.balanceAfter, "transactions_normalized_balance_invalid"),
      description: boundedString(row.description, "transactions_normalized_description_invalid"),
      direction: oneOf(
        row.direction,
        ["credit", "debit"] as const,
        "transactions_normalized_direction_invalid",
        409,
      ),
    };
  });
  if (transactions.length !== artifact.transactionCount) {
    throw new ImportError(409, "transactions_normalized_count_mismatch");
  }
  return {
    kind: "transactions-normalized",
    range,
    depositsTotal: integer(input.depositsTotal, "transactions_normalized_total_invalid"),
    withdrawalsTotal: integer(input.withdrawalsTotal, "transactions_normalized_total_invalid"),
    transactions,
  };
}

function validateCompleteness(
  manifest: Manifest,
  verified: VerifiedArtifact[],
  prefix: string,
): void {
  const artifacts = verified.map((entry) => entry.artifact);
  const keys = artifacts.map((artifact) => artifact.key);
  if (new Set(keys).size !== keys.length) {
    throw new ImportError(409, "manifest_duplicate_artifact");
  }
  const ranges = monthRanges(manifest.requestedRange);
  const expected: string[] = [];
  const balanceRaw = prefix + "balance.raw.json.sjis";
  const balanceNormalized = prefix + "balance.normalized.json";
  if (keys[0] === balanceRaw) expected.push(balanceRaw);
  if (keys[1] === balanceNormalized && expected.length === 1) {
    expected.push(balanceNormalized);
  }
  if (manifest.completedChunks > 0 && expected.length !== 2) {
    throw new ImportError(409, "manifest_balance_complement_mismatch");
  }
  if (keys.some((key) => key.startsWith(prefix + "transactions/")) && expected.length !== 2) {
    throw new ImportError(409, "manifest_balance_complement_mismatch");
  }
  for (let index = 0; index < manifest.completedChunks; index += 1) {
    const range = ranges[index]!;
    expected.push(transactionKey(prefix, range, true));
    expected.push(transactionKey(prefix, range, false));
  }
  const nextRange = ranges[manifest.completedChunks];
  if (nextRange && keys[expected.length] === transactionKey(prefix, nextRange, true)) {
    expected.push(transactionKey(prefix, nextRange, true));
  }
  if (!sameStrings(keys, expected)) {
    throw new ImportError(409, "manifest_failure_complement_mismatch");
  }

  const expectedStatus: Status = manifest.failureCodes.length === 0
    ? "success"
    : artifacts.length > 2 ? "partial" : "failed";
  if (manifest.status !== expectedStatus) {
    throw new ImportError(409, "manifest_status_mismatch");
  }
  if (manifest.status === "success") {
    if (manifest.completedChunks !== manifest.totalChunks ||
        expected.length !== 2 + manifest.totalChunks * 2 ||
        !manifest.logoutSucceeded) {
      throw new ImportError(409, "manifest_success_complement_mismatch");
    }
  } else {
    if (manifest.failureCodes.length === 0) {
      throw new ImportError(409, "manifest_failure_code_missing");
    }
    if (manifest.status === "failed" &&
        (manifest.completedChunks !== 0 || manifest.transactionCount !== 0)) {
      throw new ImportError(409, "manifest_failed_progress_mismatch");
    }
    if (manifest.completedChunks === manifest.totalChunks &&
        !manifest.failureCodes.includes("logout_failed")) {
      throw new ImportError(409, "manifest_terminal_failure_mismatch");
    }
  }

  const entries = new Map(verified.map((entry) => [entry.artifact.key, entry]));
  const rawBalance = entries.get(balanceRaw)?.payload;
  const normalizedBalance = entries.get(balanceNormalized)?.payload;
  if (rawBalance && normalizedBalance) {
    if (!isBalance(rawBalance) || !isBalance(normalizedBalance) ||
        rawBalance.kind !== "balance-raw" ||
        normalizedBalance.kind !== "balance-normalized" ||
        rawBalance.amount !== normalizedBalance.amount) {
      throw new ImportError(409, "balance_payload_mismatch");
    }
  }

  let transactionCount = 0;
  for (let index = 0; index < manifest.completedChunks; index += 1) {
    const range = ranges[index]!;
    const raw = entries.get(transactionKey(prefix, range, true))?.payload;
    const normalized = entries.get(transactionKey(prefix, range, false))?.payload;
    if (!raw || !normalized || !isTransactions(raw) || !isTransactions(normalized) ||
        raw.kind !== "transactions-raw" ||
        normalized.kind !== "transactions-normalized" ||
        !sameTransactionPayload(raw, normalized)) {
      throw new ImportError(409, "transactions_payload_mismatch");
    }
    transactionCount += normalized.transactions.length;
  }
  if (manifest.transactionCount !== transactionCount) {
    throw new ImportError(409, "manifest_transaction_count_mismatch");
  }
}

function isBalance(value: VerifiedPayload): value is BalancePayload {
  return value.kind === "balance-raw" || value.kind === "balance-normalized";
}

function isTransactions(value: VerifiedPayload): value is TransactionPayload {
  return value.kind === "transactions-raw" || value.kind === "transactions-normalized";
}

function sameTransactionPayload(left: TransactionPayload, right: TransactionPayload): boolean {
  return sameRange(left.range, right.range) &&
    left.depositsTotal === right.depositsTotal &&
    left.withdrawalsTotal === right.withdrawalsTotal &&
    canonicalJson(left.transactions as unknown as JsonValue) ===
      canonicalJson(right.transactions as unknown as JsonValue);
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
      manifestKey,
    );
    const artifactKey = relativeArtifactKey(verified.artifact.key, manifestKey);
    plans.push({
      source: verified.artifact,
      sha256: verified.artifact.sha256,
      descriptor,
      inventory: {
        artifactKey,
        sha256: verified.artifact.sha256,
        descriptorSha256: await descriptorSha256(descriptor),
      },
    });
  }
  const descriptor = await manifestDescriptor(
    validated,
    manifestKey,
    fingerprintKey,
  );
  plans.push({
    source: null,
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
  manifest: Manifest,
  fingerprintKey: string,
  manifestKey: string,
): Promise<JsonObject> {
  const normalized = verified.artifact.dataset.endsWith("-normalized");
  const artifactKey = relativeArtifactKey(verified.artifact.key, manifestKey);
  const rawParent = normalized
    ? artifactKey.replace(".normalized.json", ".raw.json.sjis")
    : null;
  return normalizedDescriptor({
    artifactKey,
    artifactRole: normalized ? "collector_derived" : "provider_response",
    payloadFidelity: normalized ? "transformed" : "exact",
    lineageDisposition: normalized ? "linked" : "not_applicable",
    dataset: verified.artifact.dataset,
    formatId: formatId(verified.artifact.dataset),
    formatVersion: manifest.schemaVersion,
    declaredMediaType: verified.artifact.mediaType,
    fetchedAtMs: Date.parse(manifest.completedAt),
    fetchUnitId: unitId,
    sequence,
    sha256: verified.artifact.sha256,
    byteSize: verified.artifact.bytes,
    storage: await storageOrigin(verified.artifact.key, fingerprintKey),
    ranges: verified.artifact.range ? [artifactRange(verified.artifact.range)] : [],
    transformSteps: normalized ? [{
      stepIndex: 0,
      stepKind: "generated",
      transformerId: "smbc-direct-backfill-worker",
      transformerVersion: manifest.schemaVersion,
    }] : [],
    relations: rawParent ? [{
      parentArtifactKey: rawParent,
      relation: "input",
      transformerId: "smbc-direct-backfill-worker",
      transformerVersion: manifest.schemaVersion,
    }] : [],
  });
}

async function manifestDescriptor(
  validated: ValidatedRun,
  key: string,
  fingerprintKey: string,
): Promise<JsonObject> {
  return normalizedDescriptor({
    artifactKey: "manifest.json",
    artifactRole: "collector_manifest",
    payloadFidelity: "generated",
    lineageDisposition: "not_applicable",
    dataset: "collector-manifest",
    formatId: "smbc-direct-collector-manifest-json",
    formatVersion: validated.manifest.schemaVersion,
    declaredMediaType: "application/json",
    fetchedAtMs: Date.parse(validated.manifest.completedAt),
    fetchUnitId: null,
    sequence: validated.artifacts.length,
    sha256: validated.manifestSha256,
    byteSize: validated.manifestBytes.byteLength,
    storage: await storageOrigin(key, fingerprintKey),
    ranges: [],
    transformSteps: [],
    relations: [],
  });
}

function normalizedDescriptor(input: {
  artifactKey: string;
  artifactRole: string;
  payloadFidelity: string;
  lineageDisposition: string;
  dataset: string;
  formatId: string;
  formatVersion: string;
  declaredMediaType: string;
  fetchedAtMs: number;
  fetchUnitId: number | null;
  sequence: number;
  sha256: string;
  byteSize: number;
  storage: JsonObject;
  ranges: JsonObject[];
  transformSteps: JsonObject[];
  relations: JsonObject[];
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
    declaredMediaType: mediaTypeBase(input.declaredMediaType),
    mediaTypeBasis: "manifest",
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
    relations: input.relations,
  };
}

function artifactRange(range: DateRange): JsonObject {
  return {
    rangeKey: "request-window",
    rangeKind: "requested",
    precision: "date",
    startValue: range.start,
    endValue: range.end,
    startInclusive: 1,
    endInclusive: 1,
    basis: "manifest",
  };
}

async function readVerifiedArtifact(
  bucket: R2Bucket,
  artifact: Artifact,
  _manifest: Manifest,
): Promise<Uint8Array> {
  const object = await bucket.get(artifact.key);
  if (!object) throw new ImportError(409, "artifact_missing");
  if (object.size !== artifact.bytes || object.size > MAX_ARTIFACT_BYTES) {
    throw new ImportError(409, "artifact_size_mismatch");
  }
  if (object.httpMetadata?.contentType !== artifact.mediaType) {
    throw new ImportError(409, "artifact_content_type_mismatch");
  }
  assertExactMetadata(
    object.customMetadata,
    { sha256: artifact.sha256 },
    "artifact_metadata_mismatch",
  );
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
    const listed = await bucket.list({
      prefix,
      limit: 1_000,
      ...(cursor ? { cursor } : {}),
    });
    actual.push(...listed.objects.map((object) => object.key));
    const next = listed.truncated ? listed.cursor : undefined;
    if (listed.truncated && !next) {
      throw new ImportError(409, "prefix_cursor_missing");
    }
    if (listed.truncated && next === cursor) {
      throw new ImportError(409, "prefix_cursor_did_not_advance");
    }
    cursor = next;
    if (actual.length > MAX_SOURCE_ARTIFACTS + 1) {
      throw new ImportError(409, "prefix_inventory_too_large");
    }
  } while (cursor);
  actual.sort();
  const expected = [...expectedKeys].sort();
  if (!sameStrings(actual, expected)) {
    throw new ImportError(409, "prefix_inventory_mismatch");
  }
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

async function descriptorSha256(descriptor: JsonObject): Promise<string> {
  const { http, storage, file, email, ...fields } = descriptor;
  return sha256Hex(new TextEncoder().encode(canonicalJson({
    ...fields,
    origins: {
      http: http ?? null,
      storage: storage ?? null,
      file: file ?? null,
      email: email ?? null,
    },
  } as unknown as JsonValue)));
}

function formatId(dataset: Dataset): string {
  if (dataset === "balance-raw") return "smbc-direct-balance-json-shift-jis";
  if (dataset === "balance-normalized") return "smbc-direct-balance-normalized-json";
  if (dataset === "transactions-raw") return "smbc-direct-transactions-json-shift-jis";
  return "smbc-direct-transactions-normalized-json";
}

function relativeArtifactKey(key: string, manifestKey: string): string {
  const prefix = manifestKey.slice(0, -"manifest.json".length);
  if (!key.startsWith(prefix)) {
    throw new ImportError(409, "artifact_prefix_mismatch");
  }
  const relative = key.slice(prefix.length);
  if (relative.length === 0 || relative === "manifest.json" ||
      relative.startsWith("/") || relative.includes("..") ||
      /[\x00-\x20\x7f]/u.test(relative)) {
    throw new ImportError(409, "artifact_relative_key_invalid");
  }
  return relative;
}

function transactionKey(prefix: string, range: DateRange, raw: boolean): string {
  return prefix + "transactions/" + compact(range.start) + "-" + compact(range.end) +
    (raw ? ".raw.json.sjis" : ".normalized.json");
}

function monthRanges(range: DateRange): DateRange[] {
  const result: DateRange[] = [];
  let cursor = range.start;
  while (cursor <= range.end) {
    const year = Number(cursor.slice(0, 4));
    const month = Number(cursor.slice(5, 7));
    const nextMonth = new Date(Date.UTC(year, month, 1));
    const monthEnd = new Date(nextMonth.getTime() - 86_400_000).toISOString().slice(0, 10);
    const end = monthEnd < range.end ? monthEnd : range.end;
    result.push({ start: cursor, end });
    if (result.length > MAX_SOURCE_ARTIFACTS / 2) {
      throw new ImportError(400, "manifest_range_too_large");
    }
    cursor = nextMonth.toISOString().slice(0, 10);
  }
  return result;
}

function parseRange(value: unknown, code: string, status: number): DateRange {
  const input = record(value, code, status);
  exactShape(input, ["start", "end"], code, status);
  const start = date(input.start, code, status);
  const end = date(input.end, code, status);
  if (start > end) throw new ImportError(status, code);
  return { start, end };
}

function transactionDate(value: unknown, referenceDate: string): string {
  if (typeof value !== "string" || value.length > 100) {
    throw new ImportError(409, "transactions_raw_date_invalid");
  }
  const match = /^(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日$/u.exec(value.trim());
  if (!match?.[2] || !match[3]) {
    throw new ImportError(409, "transactions_raw_date_invalid");
  }
  const month = Number(match[2]);
  const day = Number(match[3]);
  let year = match[1] ? Number(match[1]) : Number(referenceDate.slice(0, 4));
  let timestamp = Date.UTC(year, month - 1, day);
  const referenceTimestamp = Date.UTC(
    Number(referenceDate.slice(0, 4)),
    Number(referenceDate.slice(4, 6)) - 1,
    Number(referenceDate.slice(6, 8)),
  );
  if (!match[1] && timestamp > referenceTimestamp) {
    year -= 1;
    timestamp = Date.UTC(year, month - 1, day);
  }
  const parsed = new Date(timestamp);
  if (parsed.getUTCFullYear() !== year ||
      parsed.getUTCMonth() !== month - 1 ||
      parsed.getUTCDate() !== day) {
    throw new ImportError(409, "transactions_raw_date_invalid");
  }
  return String(year).padStart(4, "0") + "-" +
    String(month).padStart(2, "0") + "-" +
    String(day).padStart(2, "0") + "T00:00:00+09:00";
}

function responseBoundaryDate(value: unknown): string {
  if (typeof value !== "string") {
    throw new ImportError(409, "transactions_raw_range_mismatch");
  }
  const compactMatch = /^(\d{4})(\d{2})(\d{2})$/u.exec(value);
  const japaneseMatch = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/u.exec(value);
  const match = compactMatch ?? japaneseMatch;
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new ImportError(409, "transactions_raw_range_mismatch");
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 ||
      parsed.getUTCDate() !== day) {
    throw new ImportError(409, "transactions_raw_range_mismatch");
  }
  return parsed.toISOString().slice(0, 10);
}

function parseYen(value: unknown, code: string): number {
  if (typeof value !== "string" || value.length > 100) {
    throw new ImportError(409, code);
  }
  const normalized = value.replace(/[￥円,\s]/gu, "");
  if (!/^-?\d+$/u.test(normalized)) throw new ImportError(409, code);
  const amount = Number(normalized);
  if (!Number.isSafeInteger(amount)) throw new ImportError(409, code);
  return amount;
}

function observedCount(value: unknown, code: string): number {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,5})$/u.test(value)) {
    throw new ImportError(409, code);
  }
  return Number(value);
}

function validFailureCode(value: string): boolean {
  return FIXED_FAILURE_CODES.has(value) || HTTP_FAILURE_CODE.test(value);
}

function scalar(value: unknown, code: string): void {
  if (value !== null && typeof value !== "string" &&
      typeof value !== "number" && typeof value !== "boolean") {
    throw new ImportError(409, code);
  }
  if (typeof value === "string" && value.length > 100_000) {
    throw new ImportError(409, code);
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new ImportError(409, code);
  }
}

function boundedString(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length > 100_000) {
    throw new ImportError(409, code);
  }
  return value;
}

function integer(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value)) throw new ImportError(409, code);
  return value as number;
}

function nonNegativeInteger(value: unknown, code: string): number {
  const result = integer(value, code);
  if (result < 0) throw new ImportError(409, code);
  return result;
}

function parseJson(bytes: Uint8Array, code: string, status: number): JsonObject {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ImportError(status, code);
  }
  return parseJsonText(text, code, status);
}

function parseJsonText(text: string, code: string, status = 409): JsonObject {
  try {
    return record(JSON.parse(text) as unknown, code, status);
  } catch (error) {
    if (error instanceof ImportError) throw error;
    throw new ImportError(status, code);
  }
}

function record(value: unknown, code: string, status: number): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new ImportError(status, code);
  }
  return value as JsonObject;
}

function exactShape(
  value: JsonObject,
  keys: readonly string[],
  code: string,
  status: number,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (!sameStrings(actual, expected)) throw new ImportError(status, code);
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  choices: T,
  code: string,
  status: number,
): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) {
    throw new ImportError(status, code);
  }
  return value as T[number];
}

function instant(value: unknown, code: string, status: number): string {
  if (typeof value !== "string" || value.length > 35) {
    throw new ImportError(status, code);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new ImportError(status, code);
  }
  return value;
}

function instantOffset(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length > 35 ||
      !/^\d{4}-\d{2}-\d{2}T00:00:00\+09:00$/u.test(value) ||
      Number.isNaN(Date.parse(value))) {
    throw new ImportError(409, code);
  }
  return value;
}

function date(value: unknown, code: string, status: number): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new ImportError(status, code);
  }
  const parsed = new Date(value + "T00:00:00.000Z");
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ImportError(status, code);
  }
  return value;
}

function count(
  value: unknown,
  maximum: number,
  code: string,
  status: number,
  minimum = 0,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum ||
      (value as number) > maximum) {
    throw new ImportError(status, code);
  }
  return value as number;
}

function compact(value: string): string {
  return value.replaceAll("-", "");
}

function sameRange(left: DateRange, right: DateRange): boolean {
  return left.start === right.start && left.end === right.end;
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index]);
}

function assertExactMetadata(
  actual: Record<string, string> | undefined,
  expected: Record<string, string>,
  code: string,
): void {
  if (!actual || !sameStrings(Object.keys(actual).sort(), Object.keys(expected).sort()) ||
      Object.entries(expected).some(([key, value]) => actual[key] !== value)) {
    throw new ImportError(409, code);
  }
}

function assertNativeSha256(object: R2ObjectBody, expected: string): void {
  const checksum = object.checksums?.sha256;
  if (checksum && bytesHex(new Uint8Array(checksum)) !== expected) {
    throw new ImportError(409, "native_sha256_mismatch");
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return bytesHex(new Uint8Array(
    await crypto.subtle.digest("SHA-256", ownedArrayBuffer(bytes)),
  ));
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  if (value !== null && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((key) =>
      JSON.stringify(key) + ":" + canonicalJson(value[key]!)
    ).join(",") + "}";
  }
  return JSON.stringify(value);
}

function binaryCompare(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  for (let index = 0; index < Math.min(leftBytes.length, rightBytes.length); index += 1) {
    if (leftBytes[index] !== rightBytes[index]) {
      return leftBytes[index]! - rightBytes[index]!;
    }
  }
  return leftBytes.length - rightBytes.length;
}

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/gu) ?? [], (part) => Number.parseInt(part, 16));
}

function bytesHex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function mediaTypeBase(value: string): string {
  return value.split(";", 1)[0]!.trim().toLowerCase();
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function invalid(code: string): never {
  throw new ImportError(400, code);
}
