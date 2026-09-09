// Request schemas for the remaining kogane-ingest v1 endpoints. None of these
// bodies is hashed into a descriptor; the inventory item list is hashed into
// the inventory digest (inventory_digest_version v1) after sorting.
import { binaryCompare } from "./json";
import {
  parseRangeFields,
  RANGE_FIELD_KEYS,
  type RangeFields,
  type RangeFieldsRequest,
  type WireBoolean,
} from "./ranges";
import {
  ContractError,
  ID,
  OPAQUE,
  SHA256,
  arrayValue,
  boolInteger,
  enumValue,
  exactKeys,
  integerValue,
  object,
  rejectDuplicate,
  requiredEnum,
  requiredInteger,
  requiredString,
  stringValue,
} from "./validate";

// --- POST /v1/runs -----------------------------------------------------------

export interface CreateRunRequest {
  producerId: string;
  sourceId: string;
  externalIdNamespace: string;
  externalSessionId: string;
  /** Omitted means "default". */
  sourceRunKey?: string | null;
}

export interface ValidatedCreateRunRequest {
  producerId: string;
  sourceId: string;
  externalIdNamespace: string;
  externalSessionId: string;
  sourceRunKey: string;
}

export function parseCreateRunRequest(input: unknown): ValidatedCreateRunRequest {
  const body = object(input);
  exactKeys(body, [
    "producerId",
    "sourceId",
    "externalIdNamespace",
    "externalSessionId",
    "sourceRunKey",
  ]);
  return {
    producerId: requiredString(body.producerId, "producer_id", { pattern: ID }),
    sourceId: requiredString(body.sourceId, "source_id", { pattern: ID }),
    externalIdNamespace: requiredString(body.externalIdNamespace, "external_id_namespace", {
      pattern: ID,
    }),
    externalSessionId: requiredString(body.externalSessionId, "external_session_id", {
      pattern: OPAQUE,
    }),
    sourceRunKey: requiredString(body.sourceRunKey ?? "default", "source_run_key", {
      pattern: OPAQUE,
    }),
  };
}

// --- POST /v1/runs/{runId}/units ------------------------------------------------

export interface AddUnitRequest {
  parentUnitId?: number | null;
  unitKind: string;
  unitKey: string;
  /** Omitted means false. */
  terminalReportRequired?: WireBoolean;
}

export interface ValidatedAddUnitRequest {
  parentUnitId: number | null;
  unitKind: string;
  unitKey: string;
  terminalReportRequired: 0 | 1;
}

export function parseAddUnitRequest(input: unknown): ValidatedAddUnitRequest {
  const body = object(input);
  exactKeys(body, ["parentUnitId", "unitKind", "unitKey", "terminalReportRequired"]);
  return {
    parentUnitId: integerValue(body.parentUnitId, "parent_unit_id", true),
    unitKind: requiredString(body.unitKind, "unit_kind", { max: 100 }),
    unitKey: requiredString(body.unitKey, "unit_key", { pattern: OPAQUE }),
    terminalReportRequired: boolInteger(body.terminalReportRequired, "terminal_report_required", 0),
  };
}

// --- POST /v1/runs/{runId}/ranges -----------------------------------------------

export interface AddRunRangeRequest extends RangeFieldsRequest {
  rangeKey: string;
}

export interface ValidatedAddRunRangeRequest extends RangeFields {
  rangeKey: string;
}

export function parseAddRunRangeRequest(input: unknown): ValidatedAddRunRangeRequest {
  const body = object(input);
  exactKeys(body, ["rangeKey", ...RANGE_FIELD_KEYS]);
  return {
    rangeKey: requiredString(body.rangeKey, "range_key", { max: 200, pattern: OPAQUE }),
    ...parseRangeFields(body),
  };
}

// --- POST /v1/runs/{runId}/page-groups ------------------------------------------

export interface AddPageGroupRequest {
  pageGroupKey: string;
  declaredPageCount?: number | null;
}

export interface ValidatedAddPageGroupRequest {
  pageGroupKey: string;
  declaredPageCount: number | null;
}

export function parseAddPageGroupRequest(input: unknown): ValidatedAddPageGroupRequest {
  const body = object(input);
  exactKeys(body, ["pageGroupKey", "declaredPageCount"]);
  return {
    pageGroupKey: requiredString(body.pageGroupKey, "page_group_key", { pattern: OPAQUE }),
    declaredPageCount: integerValue(body.declaredPageCount, "declared_page_count", true),
  };
}

// --- Reports --------------------------------------------------------------------

export type ReportKind = "progress" | "terminal";
export type NormalizedOutcome =
  | "success"
  | "partial"
  | "failed"
  | "running"
  | "human_required"
  | "cancelled"
  | "unknown";
export type ReportTimeBasis =
  | "source"
  | "manifest"
  | "schedule"
  | "file_metadata"
  | "email"
  | "operator"
  | "unknown";
export type UnitArtifactCountScope = "direct" | "subtree" | "producer_defined";
export type RunArtifactCountScope = "all_catalogued" | "provider_artifacts" | "producer_defined";

const OUTCOMES = [
  "success",
  "partial",
  "failed",
  "running",
  "human_required",
  "cancelled",
  "unknown",
] as const;
const TIME_BASES = [
  "source",
  "manifest",
  "schedule",
  "file_metadata",
  "email",
  "operator",
  "unknown",
] as const;

export interface AddUnitReportRequest {
  reportKey: string;
  reportKind: ReportKind;
  producerStatus?: string | null;
  /** Omitted means "unknown". */
  normalizedOutcome?: NormalizedOutcome | null;
  startedAtMs?: number | null;
  startedAtBasis?: ReportTimeBasis | null;
  completedAtMs?: number | null;
  completedAtBasis?: ReportTimeBasis | null;
  declaredArtifactCount?: number | null;
  artifactCountScope?: UnitArtifactCountScope | null;
  safeFailureCode?: string | null;
}

export interface ValidatedAddUnitReportRequest {
  reportKey: string;
  reportKind: ReportKind;
  producerStatus: string | null;
  normalizedOutcome: NormalizedOutcome;
  startedAtMs: number | null;
  startedAtBasis: ReportTimeBasis | null;
  completedAtMs: number | null;
  completedAtBasis: ReportTimeBasis | null;
  declaredArtifactCount: number | null;
  artifactCountScope: UnitArtifactCountScope | null;
  safeFailureCode: string | null;
}

export function parseAddUnitReportRequest(input: unknown): ValidatedAddUnitReportRequest {
  const body = object(input);
  exactKeys(body, [
    "reportKey",
    "reportKind",
    "producerStatus",
    "normalizedOutcome",
    "startedAtMs",
    "startedAtBasis",
    "completedAtMs",
    "completedAtBasis",
    "declaredArtifactCount",
    "artifactCountScope",
    "safeFailureCode",
  ]);
  const parsed: ValidatedAddUnitReportRequest = {
    reportKey: requiredString(body.reportKey, "report_key", { pattern: OPAQUE }),
    reportKind: requiredEnum(body.reportKind, "report_kind", ["progress", "terminal"] as const),
    producerStatus: stringValue(body.producerStatus, "producer_status", {
      optional: true,
      max: 100,
    }),
    normalizedOutcome: requiredEnum(
      body.normalizedOutcome ?? "unknown",
      "normalized_outcome",
      OUTCOMES,
    ),
    startedAtMs: integerValue(body.startedAtMs, "started_at_ms", true),
    startedAtBasis: enumValue(body.startedAtBasis, "started_at_basis", TIME_BASES, true),
    completedAtMs: integerValue(body.completedAtMs, "completed_at_ms", true),
    completedAtBasis: enumValue(body.completedAtBasis, "completed_at_basis", TIME_BASES, true),
    declaredArtifactCount: integerValue(
      body.declaredArtifactCount,
      "declared_artifact_count",
      true,
    ),
    artifactCountScope: enumValue(
      body.artifactCountScope,
      "artifact_count_scope",
      ["direct", "subtree", "producer_defined"] as const,
      true,
    ),
    safeFailureCode: stringValue(body.safeFailureCode, "safe_failure_code", {
      optional: true,
      max: 100,
    }),
  };
  if (
    (parsed.startedAtMs === null) !== (parsed.startedAtBasis === null) ||
    (parsed.completedAtMs === null) !== (parsed.completedAtBasis === null) ||
    (parsed.declaredArtifactCount === null) !== (parsed.artifactCountScope === null)
  ) {
    throw new ContractError("unit_report_field_pair_mismatch");
  }
  return parsed;
}

export interface AddRunReportRequest {
  reportKey: string;
  reportKind: ReportKind;
  producerVersion?: string | null;
  producerRevision?: string | null;
  manifestSchemaVersion?: string | null;
  producerStatus?: string | null;
  /** Omitted means "unknown". */
  normalizedOutcome?: NormalizedOutcome | null;
  startedAtMs?: number | null;
  startedAtBasis?: ReportTimeBasis | null;
  completedAtMs?: number | null;
  completedAtBasis?: ReportTimeBasis | null;
  declaredArtifactCount?: number | null;
  artifactCountScope?: RunArtifactCountScope | null;
}

export interface ValidatedAddRunReportRequest {
  reportKey: string;
  reportKind: ReportKind;
  producerVersion: string | null;
  producerRevision: string | null;
  manifestSchemaVersion: string | null;
  producerStatus: string | null;
  normalizedOutcome: NormalizedOutcome;
  startedAtMs: number | null;
  startedAtBasis: ReportTimeBasis | null;
  completedAtMs: number | null;
  completedAtBasis: ReportTimeBasis | null;
  declaredArtifactCount: number | null;
  artifactCountScope: RunArtifactCountScope | null;
}

export function parseAddRunReportRequest(input: unknown): ValidatedAddRunReportRequest {
  const body = object(input);
  exactKeys(body, [
    "reportKey",
    "reportKind",
    "producerVersion",
    "producerRevision",
    "manifestSchemaVersion",
    "producerStatus",
    "normalizedOutcome",
    "startedAtMs",
    "startedAtBasis",
    "completedAtMs",
    "completedAtBasis",
    "declaredArtifactCount",
    "artifactCountScope",
  ]);
  const parsed: ValidatedAddRunReportRequest = {
    reportKey: requiredString(body.reportKey, "report_key", { pattern: OPAQUE }),
    reportKind: requiredEnum(body.reportKind, "report_kind", ["progress", "terminal"] as const),
    producerVersion: stringValue(body.producerVersion, "producer_version", {
      optional: true,
      max: 200,
    }),
    producerRevision: stringValue(body.producerRevision, "producer_revision", {
      optional: true,
      max: 200,
    }),
    manifestSchemaVersion: stringValue(body.manifestSchemaVersion, "manifest_schema_version", {
      optional: true,
      max: 200,
    }),
    producerStatus: stringValue(body.producerStatus, "producer_status", {
      optional: true,
      max: 100,
    }),
    normalizedOutcome: requiredEnum(
      body.normalizedOutcome ?? "unknown",
      "normalized_outcome",
      OUTCOMES,
    ),
    startedAtMs: integerValue(body.startedAtMs, "started_at_ms", true),
    startedAtBasis: enumValue(body.startedAtBasis, "started_at_basis", TIME_BASES, true),
    completedAtMs: integerValue(body.completedAtMs, "completed_at_ms", true),
    completedAtBasis: enumValue(body.completedAtBasis, "completed_at_basis", TIME_BASES, true),
    declaredArtifactCount: integerValue(
      body.declaredArtifactCount,
      "declared_artifact_count",
      true,
    ),
    artifactCountScope: enumValue(
      body.artifactCountScope,
      "artifact_count_scope",
      ["all_catalogued", "provider_artifacts", "producer_defined"] as const,
      true,
    ),
  };
  if (
    (parsed.startedAtMs === null) !== (parsed.startedAtBasis === null) ||
    (parsed.completedAtMs === null) !== (parsed.completedAtBasis === null) ||
    (parsed.declaredArtifactCount === null) !== (parsed.artifactCountScope === null)
  ) {
    throw new ContractError("report_field_pair_mismatch");
  }
  return parsed;
}

// --- Inventories and seals ------------------------------------------------------

export type DeclarationBasis =
  | "producer_manifest"
  | "directory_scan"
  | "capture_index"
  | "file_receipt"
  | "email_batch"
  | "operator";

const DECLARATION_BASES = [
  "producer_manifest",
  "directory_scan",
  "capture_index",
  "file_receipt",
  "email_batch",
  "operator",
] as const;

export interface InventoryItem {
  artifactKey: string;
  sha256: string;
  descriptorSha256: string;
}

/**
 * Validate an inventory item list, reject duplicate keys, and sort by
 * artifactKey in binary order. The sorted list is what the inventory digest
 * (inventory_digest_version v1) is computed over.
 */
export function parseInventoryItems(value: unknown, field: string, max: number): InventoryItem[] {
  const items = arrayValue(value, field, max).map((entry): InventoryItem => {
    const item = object(entry);
    exactKeys(item, ["artifactKey", "sha256", "descriptorSha256"]);
    return {
      artifactKey: requiredString(item.artifactKey, "artifact_key", { pattern: OPAQUE }),
      sha256: requiredString(item.sha256, "sha256", { pattern: SHA256 }),
      descriptorSha256: requiredString(item.descriptorSha256, "descriptor_sha256", {
        pattern: SHA256,
      }),
    };
  });
  rejectDuplicate(items, (item) => item.artifactKey, "duplicate_inventory_key");
  return items.sort((left, right) => binaryCompare(left.artifactKey, right.artifactKey));
}

export interface BeginInventoryRequest {
  inventorySha256: string;
  expectedArtifactCount: number;
  declarationBasis: DeclarationBasis;
}

export type ValidatedBeginInventoryRequest = BeginInventoryRequest;

export function parseBeginInventoryRequest(input: unknown): ValidatedBeginInventoryRequest {
  const body = object(input);
  exactKeys(body, ["inventorySha256", "expectedArtifactCount", "declarationBasis"]);
  const inventorySha256 = requiredString(body.inventorySha256, "inventory_sha256", {
    pattern: SHA256,
  });
  const expectedArtifactCount = requiredInteger(
    body.expectedArtifactCount,
    "expected_artifact_count",
  );
  if (expectedArtifactCount > 10_000) throw new ContractError("inventory_too_large");
  return {
    inventorySha256,
    expectedArtifactCount,
    declarationBasis: requiredEnum(body.declarationBasis, "declaration_basis", DECLARATION_BASES),
  };
}

export interface AddInventoryItemsRequest {
  items: InventoryItem[];
}

export interface ValidatedAddInventoryItemsRequest {
  /** Sorted by artifactKey; at least one and at most thirty items. */
  items: InventoryItem[];
}

export function parseAddInventoryItemsRequest(input: unknown): ValidatedAddInventoryItemsRequest {
  const body = object(input);
  exactKeys(body, ["items"]);
  const items = parseInventoryItems(body.items, "items", 30);
  if (items.length === 0) throw new ContractError("empty_inventory_chunk");
  return { items };
}

export interface SealStagedInventoryRequest {
  externalAttemptId: string;
  startedAtMs?: number | null;
}

export interface ValidatedSealStagedInventoryRequest {
  externalAttemptId: string;
  startedAtMs: number | null;
}

export function parseSealStagedInventoryRequest(
  input: unknown,
): ValidatedSealStagedInventoryRequest {
  const body = object(input);
  exactKeys(body, ["externalAttemptId", "startedAtMs"]);
  return {
    externalAttemptId: requiredString(body.externalAttemptId, "external_attempt_id", {
      pattern: OPAQUE,
    }),
    startedAtMs: integerValue(body.startedAtMs, "started_at_ms", true),
  };
}

export interface SealRunRequest {
  artifacts: InventoryItem[];
  declarationBasis: DeclarationBasis;
  externalAttemptId: string;
  startedAtMs?: number | null;
}

export interface ValidatedSealRunRequest {
  /** Sorted by artifactKey. */
  artifacts: InventoryItem[];
  declarationBasis: DeclarationBasis;
  externalAttemptId: string;
  startedAtMs: number | null;
}

export function parseSealRunRequest(input: unknown): ValidatedSealRunRequest {
  const body = object(input);
  exactKeys(body, ["artifacts", "declarationBasis", "externalAttemptId", "startedAtMs"]);
  return {
    artifacts: parseInventoryItems(body.artifacts, "artifacts", 1_000),
    declarationBasis: requiredEnum(body.declarationBasis, "declaration_basis", DECLARATION_BASES),
    externalAttemptId: requiredString(body.externalAttemptId, "external_attempt_id", {
      pattern: OPAQUE,
    }),
    startedAtMs: integerValue(body.startedAtMs, "started_at_ms", true),
  };
}

// --- POST /v1/runs/{runId}/attempts ---------------------------------------------

export type FailedAttemptOutcome = "incomplete" | "failed";

export interface RecordAttemptRequest {
  externalAttemptId: string;
  outcome: FailedAttemptOutcome;
  startedAtMs?: number | null;
  completedAtMs: number;
  expectedArtifactCount?: number | null;
  observedArtifactCount: number;
  acceptedArtifactCount: number;
  reusedArtifactCount: number;
  rejectedArtifactCount: number;
  /** Required when outcome is "failed". */
  errorCode?: string | null;
  ingestClientVersion?: string | null;
}

export interface ValidatedRecordAttemptRequest {
  externalAttemptId: string;
  outcome: FailedAttemptOutcome;
  startedAtMs: number | null;
  completedAtMs: number;
  expectedArtifactCount: number | null;
  observedArtifactCount: number;
  acceptedArtifactCount: number;
  reusedArtifactCount: number;
  rejectedArtifactCount: number;
  errorCode: string | null;
  ingestClientVersion: string | null;
}

export function parseRecordAttemptRequest(input: unknown): ValidatedRecordAttemptRequest {
  const body = object(input);
  exactKeys(body, [
    "externalAttemptId",
    "outcome",
    "startedAtMs",
    "completedAtMs",
    "expectedArtifactCount",
    "observedArtifactCount",
    "acceptedArtifactCount",
    "reusedArtifactCount",
    "rejectedArtifactCount",
    "errorCode",
    "ingestClientVersion",
  ]);
  const parsed: ValidatedRecordAttemptRequest = {
    ingestClientVersion: stringValue(body.ingestClientVersion, "ingest_client_version", {
      optional: true,
      max: 200,
    }),
    externalAttemptId: requiredString(body.externalAttemptId, "external_attempt_id", {
      pattern: OPAQUE,
    }),
    startedAtMs: integerValue(body.startedAtMs, "started_at_ms", true),
    completedAtMs: requiredInteger(body.completedAtMs, "completed_at_ms"),
    expectedArtifactCount: integerValue(
      body.expectedArtifactCount,
      "expected_artifact_count",
      true,
    ),
    observedArtifactCount: requiredInteger(body.observedArtifactCount, "observed_artifact_count"),
    acceptedArtifactCount: requiredInteger(body.acceptedArtifactCount, "accepted_artifact_count"),
    reusedArtifactCount: requiredInteger(body.reusedArtifactCount, "reused_artifact_count"),
    rejectedArtifactCount: requiredInteger(body.rejectedArtifactCount, "rejected_artifact_count"),
    outcome: requiredEnum(body.outcome, "outcome", ["incomplete", "failed"] as const),
    errorCode: stringValue(body.errorCode, "error_code", { optional: true, max: 100 }),
  };
  if (parsed.startedAtMs !== null && parsed.completedAtMs < parsed.startedAtMs) {
    throw new ContractError("attempt_time_order_invalid");
  }
  if (
    parsed.acceptedArtifactCount + parsed.reusedArtifactCount + parsed.rejectedArtifactCount >
    parsed.observedArtifactCount
  ) {
    throw new ContractError("attempt_count_invalid");
  }
  if (parsed.outcome === "failed" && parsed.errorCode === null) {
    throw new ContractError("failed_attempt_error_required");
  }
  return parsed;
}
