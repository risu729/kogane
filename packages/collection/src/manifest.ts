// `terminal-v1`: the record a collector writes last to say "this run finished
// persisting the set of bytes it decided to keep" (unified plan 03 §2, §3).
//
// It is deliberately *not* a second copy of the ingest descriptor contract in
// `packages/evidence-contract`: it names the run, the stored objects and the
// provider outcome, and the Processor derives descriptors from it. What it
// must never do is turn a `partial` or `failed` acquisition into a `success`,
// or claim complete coverage for either, so the validator refuses those
// combinations instead of leaving them to a caller.
//
// Validation is hand-written, exactly like `packages/evidence-contract`: no
// schema library, no new dependency, stable error codes.
import { binaryCompare, isRecord } from "../../evidence-contract/src/json";
import {
  assertRef,
  assertRelativePath,
  assertRunId,
  assertSha256Hex,
  assertSource,
  objectKey,
  REPORT_PREFIX,
} from "./keys";

export const TERMINAL_MANIFEST_VERSION = "terminal-v1";

export class TerminalManifestError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "TerminalManifestError";
  }
}

/** Never widened silently: a collector that cannot tell must say `failed`. */
export const PROVIDER_OUTCOMES = ["success", "partial", "failed"] as const;
export type ProviderOutcome = (typeof PROVIDER_OUTCOMES)[number];

/** The same three words `packages/domain` uses for completeness claims. */
export const COVERAGE_STATUSES = ["complete", "partial", "unknown"] as const;
export type CoverageStatus = (typeof COVERAGE_STATUSES)[number];

export const SCOPE_KINDS = ["full_snapshot", "date_range", "month_range", "unspecified"] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];

export const ARTIFACT_STORES = ["DATA"] as const;
export type ArtifactStore = (typeof ARTIFACT_STORES)[number];

export const RANGE_KINDS = ["requested", "declared_coverage", "selector"] as const;
export type RangeKind = (typeof RANGE_KINDS)[number];
export const RANGE_BASES = ["source", "request", "manifest", "operator"] as const;
export type RangeBasis = (typeof RANGE_BASES)[number];
export const RANGE_PRECISIONS = ["instant", "date", "month"] as const;
export type RangePrecision = (typeof RANGE_PRECISIONS)[number];

export const REPORT_SCOPES = ["run", "unit"] as const;
export type ReportScope = (typeof REPORT_SCOPES)[number];

export const TRANSFORM_STEP_KINDS = [
  "transport_decoded",
  "decrypted",
  "redacted",
  "reencoded",
  "bundled",
  "rendered",
  "extracted",
  "generated",
] as const;
export type TransformStepKind = (typeof TRANSFORM_STEP_KINDS)[number];

export interface StorageRef {
  readonly store: ArtifactStore;
  readonly key: string;
}

export interface TerminalArtifact {
  /** Stable name of the artifact inside the run; unique per terminal. */
  readonly artifactKey: string;
  readonly storageRef: StorageRef;
  readonly sha256: string;
  readonly byteSize: number;
  /** What the bytes are, as declared by the collector; the stored object itself is opaque. */
  readonly mediaType: string;
  readonly role: string;
  readonly unitKey?: string;
}

export interface TerminalUnit {
  /** Account, card, container: whatever the source's smallest addressable unit is. */
  readonly unitKey: string;
  readonly unitKind: string;
  readonly artifactCount: number;
  readonly coverageStatus: CoverageStatus;
  readonly safeErrorCode?: string;
}

export interface TerminalRange {
  readonly rangeKey: string;
  readonly rangeKind: RangeKind;
  readonly precision: RangePrecision;
  readonly basis: RangeBasis;
  readonly startValue: string | null;
  readonly endValue: string | null;
  readonly unitKey?: string;
}

export interface TerminalReport {
  readonly reportRef: string;
  readonly reportKind: string;
  readonly scope: ReportScope;
  readonly outcome: ProviderOutcome;
  readonly unitKey?: string;
  readonly storageRef?: StorageRef;
  readonly safeErrorCode?: string;
}

export interface TerminalTransformation {
  readonly transformationId: string;
  readonly stepKind: TransformStepKind;
  readonly transformerId: string;
  readonly transformerVersion: string;
  readonly inputArtifactKeys: readonly string[];
  readonly outputArtifactKey: string;
}

export interface RequestedScope {
  readonly scopeKind: ScopeKind;
  readonly startValue: string | null;
  readonly endValue: string | null;
  readonly unitKeys: readonly string[];
}

export interface TerminalManifest {
  readonly manifestVersion: typeof TERMINAL_MANIFEST_VERSION;
  readonly source: string;
  readonly producer: string;
  readonly producerVersion: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly operationId?: string;
  /**
   * One acquisition session that touched several sources keeps its own ref on
   * every per-source run, so the sources stay separate runs and separate
   * terminals while their provenance still links (plan 03 §3).
   */
  readonly acquisitionSessionRef?: string;
  readonly requestedScope: RequestedScope;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly providerOutcome: ProviderOutcome;
  readonly coverageStatus: CoverageStatus;
  /** Always true in a written terminal: the terminal *is* the persistence claim. */
  readonly persistenceComplete: true;
  readonly safeErrorCode?: string;
  readonly artifacts: readonly TerminalArtifact[];
  readonly units: readonly TerminalUnit[];
  readonly ranges: readonly TerminalRange[];
  readonly reports: readonly TerminalReport[];
  readonly transformations: readonly TerminalTransformation[];
}

/** Everything a `persistRun` caller states about the run except the stored artifacts. */
export type TerminalRunFields = Omit<TerminalManifest, "manifestVersion" | "artifacts">;

const MANIFEST_KEYS = [
  "manifestVersion",
  "source",
  "producer",
  "producerVersion",
  "runId",
  "attemptId",
  "operationId",
  "acquisitionSessionRef",
  "requestedScope",
  "startedAt",
  "completedAt",
  "providerOutcome",
  "coverageStatus",
  "persistenceComplete",
  "safeErrorCode",
  "artifacts",
  "units",
  "ranges",
  "reports",
  "transformations",
] as const;

const MAX_ARTIFACTS = 10_000;
const MAX_UNITS = 1_000;
const MAX_RANGES = 1_000;
const MAX_REPORTS = 1_000;
const MAX_TRANSFORMATIONS = 1_000;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
/** Safe error codes are enumerable machine codes, never provider text. */
const SAFE_CODE = /^[a-z0-9][a-z0-9_-]{0,99}$/u;
const IDENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/u;
const ARTIFACT_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,299}$/u;

function fail(code: string): never {
  throw new TerminalManifestError(code);
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!isRecord(value)) fail(code);
  return value;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], code: string): void {
  const allow = new Set(allowed);
  if (Object.keys(value).some((key) => !allow.has(key))) fail(code);
}

function text(value: unknown, code: string, pattern = IDENT): string {
  if (typeof value !== "string" || !pattern.test(value)) fail(code);
  return value;
}

function optionalText(value: unknown, code: string, pattern = IDENT): string | undefined {
  if (value === undefined) return undefined;
  return text(value, code, pattern);
}

function instant(value: unknown, code: string): string {
  if (typeof value !== "string" || !ISO_INSTANT.test(value)) fail(code);
  // `Date.parse` rolls an impossible day over into the next month, so the
  // instant must survive a round trip unchanged to count as a calendar date.
  const parsed = Date.parse(value);
  const normalized = value.length === 20 ? `${value.slice(0, 19)}.000Z` : value;
  if (Number.isNaN(parsed) || new Date(parsed).toISOString() !== normalized) fail(code);
  return value;
}

function choice<T extends string>(value: unknown, choices: readonly T[], code: string): T {
  if (typeof value !== "string" || !choices.includes(value as T)) fail(code);
  return value as T;
}

function count(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(code);
  return value as number;
}

function list(value: unknown, max: number, code: string): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail(code);
  return value;
}

function nullableValue(value: unknown, code: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > 64) fail(code);
  return value;
}

function storageRef(value: unknown, code: string): StorageRef {
  const ref = record(value, code);
  exactKeys(ref, ["store", "key"], code);
  const store = choice(ref.store, ARTIFACT_STORES, code);
  if (typeof ref.key !== "string" || ref.key.length === 0 || ref.key.length > 1024) fail(code);
  return { store, key: ref.key };
}

function parseRequestedScope(value: unknown): RequestedScope {
  const scope = record(value, "invalid_requested_scope");
  exactKeys(scope, ["scopeKind", "startValue", "endValue", "unitKeys"], "invalid_requested_scope");
  const unitKeys = list(scope.unitKeys ?? [], MAX_UNITS, "invalid_requested_scope").map((entry) =>
    text(entry, "invalid_requested_scope"),
  );
  if (new Set(unitKeys).size !== unitKeys.length) fail("duplicate_requested_unit_key");
  return {
    scopeKind: choice(scope.scopeKind, SCOPE_KINDS, "invalid_scope_kind"),
    startValue: nullableValue(scope.startValue, "invalid_requested_scope"),
    endValue: nullableValue(scope.endValue, "invalid_requested_scope"),
    unitKeys: [...unitKeys].sort(binaryCompare),
  };
}

function parseArtifact(value: unknown): TerminalArtifact {
  const entry = record(value, "invalid_artifact");
  exactKeys(
    entry,
    ["artifactKey", "storageRef", "sha256", "byteSize", "mediaType", "role", "unitKey"],
    "invalid_artifact",
  );
  const sha256 = assertSha256Hex(entry.sha256);
  const ref = storageRef(entry.storageRef, "invalid_artifact_storage_ref");
  // Content-addressed: the manifest may not point a digest at another key.
  if (ref.key !== objectKey(sha256)) fail("artifact_storage_ref_mismatch");
  const unitKey = optionalText(entry.unitKey, "invalid_artifact_unit_key");
  return {
    artifactKey: text(entry.artifactKey, "invalid_artifact_key", ARTIFACT_KEY),
    storageRef: ref,
    sha256,
    byteSize: count(entry.byteSize, "invalid_artifact_byte_size"),
    mediaType: text(entry.mediaType, "invalid_artifact_media_type", MEDIA_TYPE),
    role: text(entry.role, "invalid_artifact_role", SAFE_CODE),
    ...(unitKey === undefined ? {} : { unitKey }),
  };
}

function parseUnit(value: unknown): TerminalUnit {
  const entry = record(value, "invalid_unit");
  exactKeys(
    entry,
    ["unitKey", "unitKind", "artifactCount", "coverageStatus", "safeErrorCode"],
    "invalid_unit",
  );
  const safeErrorCode = optionalText(
    entry.safeErrorCode,
    "invalid_unit_safe_error_code",
    SAFE_CODE,
  );
  return {
    unitKey: text(entry.unitKey, "invalid_unit_key"),
    unitKind: text(entry.unitKind, "invalid_unit_kind", SAFE_CODE),
    artifactCount: count(entry.artifactCount, "invalid_unit_artifact_count"),
    coverageStatus: choice(entry.coverageStatus, COVERAGE_STATUSES, "invalid_unit_coverage_status"),
    ...(safeErrorCode === undefined ? {} : { safeErrorCode }),
  };
}

function parseRange(value: unknown): TerminalRange {
  const entry = record(value, "invalid_range");
  exactKeys(
    entry,
    ["rangeKey", "rangeKind", "precision", "basis", "startValue", "endValue", "unitKey"],
    "invalid_range",
  );
  const startValue = nullableValue(entry.startValue, "invalid_range_start_value");
  const endValue = nullableValue(entry.endValue, "invalid_range_end_value");
  if (startValue === null && endValue === null) fail("empty_range");
  if (startValue !== null && endValue !== null && startValue > endValue) fail("reversed_range");
  const unitKey = optionalText(entry.unitKey, "invalid_range_unit_key");
  return {
    rangeKey: text(entry.rangeKey, "invalid_range_key"),
    rangeKind: choice(entry.rangeKind, RANGE_KINDS, "invalid_range_kind"),
    precision: choice(entry.precision, RANGE_PRECISIONS, "invalid_range_precision"),
    basis: choice(entry.basis, RANGE_BASES, "invalid_range_basis"),
    startValue,
    endValue,
    ...(unitKey === undefined ? {} : { unitKey }),
  };
}

function parseReport(value: unknown): TerminalReport {
  const entry = record(value, "invalid_report");
  exactKeys(
    entry,
    ["reportRef", "reportKind", "scope", "outcome", "unitKey", "storageRef", "safeErrorCode"],
    "invalid_report",
  );
  const unitKey = optionalText(entry.unitKey, "invalid_report_unit_key");
  const safeErrorCode = optionalText(
    entry.safeErrorCode,
    "invalid_report_safe_error_code",
    SAFE_CODE,
  );
  const scope = choice(entry.scope, REPORT_SCOPES, "invalid_report_scope");
  if (scope === "unit" && unitKey === undefined) fail("report_unit_key_required");
  const reportRef = assertRef(entry.reportRef, "invalid_report_ref");
  const ref =
    entry.storageRef === undefined
      ? undefined
      : reportStorageRef(reportRef, storageRef(entry.storageRef, "invalid_report_storage_ref"));
  return {
    reportRef,
    reportKind: text(entry.reportKind, "invalid_report_kind", SAFE_CODE),
    scope,
    outcome: choice(entry.outcome, PROVIDER_OUTCOMES, "invalid_report_outcome"),
    ...(unitKey === undefined ? {} : { unitKey }),
    ...(ref === undefined ? {} : { storageRef: ref }),
    ...(safeErrorCode === undefined ? {} : { safeErrorCode }),
  };
}

/** A report lives under its own `reports/<reportRef>/` prefix and nowhere else. */
function reportStorageRef(reportRef: string, ref: StorageRef): StorageRef {
  const prefix = `${REPORT_PREFIX}${reportRef}/`;
  if (!ref.key.startsWith(prefix)) fail("report_storage_ref_mismatch");
  try {
    assertRelativePath(ref.key.slice(prefix.length));
  } catch {
    fail("report_storage_ref_mismatch");
  }
  return ref;
}

function parseTransformation(value: unknown): TerminalTransformation {
  const entry = record(value, "invalid_transformation");
  exactKeys(
    entry,
    [
      "transformationId",
      "stepKind",
      "transformerId",
      "transformerVersion",
      "inputArtifactKeys",
      "outputArtifactKey",
    ],
    "invalid_transformation",
  );
  const inputArtifactKeys = list(
    entry.inputArtifactKeys,
    MAX_ARTIFACTS,
    "invalid_transformation_inputs",
  ).map((input) => text(input, "invalid_transformation_inputs", ARTIFACT_KEY));
  if (new Set(inputArtifactKeys).size !== inputArtifactKeys.length) {
    fail("duplicate_transformation_input");
  }
  return {
    transformationId: text(entry.transformationId, "invalid_transformation_id"),
    stepKind: choice(entry.stepKind, TRANSFORM_STEP_KINDS, "invalid_transformation_step_kind"),
    transformerId: text(entry.transformerId, "invalid_transformer_id"),
    transformerVersion: text(entry.transformerVersion, "invalid_transformer_version"),
    inputArtifactKeys,
    outputArtifactKey: text(entry.outputArtifactKey, "invalid_transformation_output", ARTIFACT_KEY),
  };
}

/**
 * Strict runtime validation of a `terminal-v1` manifest. Unknown keys are
 * rejected; arrays come back in binary key order so two callers that state the
 * same run produce the same digest. Throws {@link TerminalManifestError}.
 */
export function parseTerminalManifest(input: unknown): TerminalManifest {
  const body = record(input, "invalid_manifest");
  exactKeys(body, MANIFEST_KEYS, "unknown_field");
  if (body.manifestVersion !== TERMINAL_MANIFEST_VERSION) fail("invalid_manifest_version");
  if (body.persistenceComplete !== true) fail("invalid_persistence_complete");

  const startedAt = instant(body.startedAt, "invalid_started_at");
  const completedAt = instant(body.completedAt, "invalid_completed_at");
  if (Date.parse(completedAt) < Date.parse(startedAt)) fail("reversed_run_window");

  const artifacts = list(body.artifacts, MAX_ARTIFACTS, "invalid_artifacts").map(parseArtifact);
  if (new Set(artifacts.map((entry) => entry.artifactKey)).size !== artifacts.length) {
    fail("duplicate_artifact_key");
  }
  artifacts.sort((left, right) => binaryCompare(left.artifactKey, right.artifactKey));
  // Two artifact keys may share a digest (the same bytes acquired twice), but a
  // single key may not claim two digests; the uniqueness check above covers it.

  const units = list(body.units, MAX_UNITS, "invalid_units").map(parseUnit);
  if (new Set(units.map((entry) => entry.unitKey)).size !== units.length)
    fail("duplicate_unit_key");
  units.sort((left, right) => binaryCompare(left.unitKey, right.unitKey));
  const unitKeys = new Set(units.map((entry) => entry.unitKey));
  for (const artifact of artifacts) {
    if (artifact.unitKey !== undefined && !unitKeys.has(artifact.unitKey)) {
      fail("artifact_unit_key_unknown");
    }
  }

  const ranges = list(body.ranges, MAX_RANGES, "invalid_ranges").map(parseRange);
  if (new Set(ranges.map((entry) => entry.rangeKey)).size !== ranges.length) {
    fail("duplicate_range_key");
  }
  ranges.sort((left, right) => binaryCompare(left.rangeKey, right.rangeKey));
  for (const range of ranges) {
    if (range.unitKey !== undefined && !unitKeys.has(range.unitKey)) fail("range_unit_key_unknown");
  }

  const reports = list(body.reports, MAX_REPORTS, "invalid_reports").map(parseReport);
  if (new Set(reports.map((entry) => entry.reportRef)).size !== reports.length) {
    fail("duplicate_report_ref");
  }
  reports.sort((left, right) => binaryCompare(left.reportRef, right.reportRef));
  for (const report of reports) {
    if (report.unitKey !== undefined && !unitKeys.has(report.unitKey)) {
      fail("report_unit_key_unknown");
    }
  }

  const transformations = list(
    body.transformations,
    MAX_TRANSFORMATIONS,
    "invalid_transformations",
  ).map(parseTransformation);
  if (
    new Set(transformations.map((entry) => entry.transformationId)).size !== transformations.length
  ) {
    fail("duplicate_transformation_id");
  }
  transformations.sort((left, right) =>
    binaryCompare(left.transformationId, right.transformationId),
  );
  const artifactKeys = new Set(artifacts.map((entry) => entry.artifactKey));
  for (const transformation of transformations) {
    if (!artifactKeys.has(transformation.outputArtifactKey)) fail("transformation_output_unknown");
    for (const input of transformation.inputArtifactKeys) {
      // Inputs may legitimately be absent: source bytes that carried
      // credentials are not retained, and the transformation still says so.
      if (input === transformation.outputArtifactKey) fail("transformation_self_reference");
    }
  }

  const providerOutcome = choice(
    body.providerOutcome,
    PROVIDER_OUTCOMES,
    "invalid_provider_outcome",
  );
  const coverageStatus = choice(body.coverageStatus, COVERAGE_STATUSES, "invalid_coverage_status");
  const safeErrorCode = optionalText(body.safeErrorCode, "invalid_safe_error_code", SAFE_CODE);
  // A run that did not fully succeed may never claim complete coverage, and
  // must carry a machine-readable reason. This is the rule that stops a
  // `partial` acquisition from reading like a `success` downstream.
  if (providerOutcome !== "success") {
    if (coverageStatus === "complete") fail("incomplete_run_claims_complete_coverage");
    if (safeErrorCode === undefined) fail("safe_error_code_required");
  }
  if (providerOutcome === "success" && safeErrorCode !== undefined) {
    fail("safe_error_code_on_success");
  }

  const operationId = optionalText(body.operationId, "invalid_operation_id");
  const acquisitionSessionRef = optionalText(
    body.acquisitionSessionRef,
    "invalid_acquisition_session_ref",
  );
  return {
    manifestVersion: TERMINAL_MANIFEST_VERSION,
    source: assertSource(body.source),
    producer: text(body.producer, "invalid_producer", SAFE_CODE),
    producerVersion: text(body.producerVersion, "invalid_producer_version"),
    runId: assertRunId(body.runId),
    attemptId: text(body.attemptId, "invalid_attempt_id"),
    ...(operationId === undefined ? {} : { operationId }),
    ...(acquisitionSessionRef === undefined ? {} : { acquisitionSessionRef }),
    requestedScope: parseRequestedScope(body.requestedScope),
    startedAt,
    completedAt,
    providerOutcome,
    coverageStatus,
    persistenceComplete: true,
    ...(safeErrorCode === undefined ? {} : { safeErrorCode }),
    artifacts,
    units,
    ranges,
    reports,
    transformations,
  };
}

/** Non-throwing form for scans that must keep going past a bad terminal. */
export function tryParseTerminalManifest(
  input: unknown,
): { ok: true; manifest: TerminalManifest } | { ok: false; code: string } {
  try {
    return { ok: true, manifest: parseTerminalManifest(input) };
  } catch (error) {
    if (error instanceof TerminalManifestError) return { ok: false, code: error.code };
    if (error instanceof Error && error.name === "CollectionKeyError") {
      return { ok: false, code: error.message };
    }
    throw error;
  }
}
