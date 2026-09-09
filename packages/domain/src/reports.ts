// Fixed report artifacts, distinct from rebuildable projections (finding
// AR03; SC16, UC59/UC60/UC66).
//
// A projection may be thrown away and rebuilt from the current rules. A report
// may not: a submitted or shared deliverable is the body that was actually
// produced, identified by the digest of that body and by the context it was
// computed from. Re-displaying it, recomputing it under today's rules and
// sharing a corrected version are three different operations, so an agent
// cannot rewrite a submission through one ambiguous "regenerate".
//
// Being able to return the stored bytes is also not the same as being able to
// recompute the number. Replayability is derived from what is still present
// and from any evidence-use restriction, and it is never claimed just because
// a digest exists (addendum 06 section 6).
import { canonicalDigest, type Replayability } from "./context.ts";
import { hasExactKeys, isOneOf, isRecord, isRefList, isText, isTextOrNull } from "./guards.ts";
import { validExactDecimal, type ExactDecimal } from "./values.ts";
import { RESULT_PARTITIONS, UNVALUED_REASONS, type ResultPartition } from "./calculation.ts";

export const REPORT_BODY_SCHEMA_VERSION = "report-holdings-v1";

/** Only the holdings view is generated today; other purposes are contract, not code. */
export const REPORT_PURPOSES = ["holdings-view"] as const;
export type ReportPurpose = (typeof REPORT_PURPOSES)[number];

export const REPORT_EVENT_KINDS = [
  "generated",
  "confirmed",
  "shared",
  "submitted",
  "corrected",
  "superseded",
] as const;
export type ReportEventKind = (typeof REPORT_EVENT_KINDS)[number];

/**
 * The three operations of addendum 09 section 9. Only `re-display` reads a
 * stored artifact; the other two are commands that produce a new run and a new
 * report, and they belong to the authenticated command boundary (A09).
 */
export const REPORT_OPERATIONS = [
  "re-display",
  "recompute-under-current-rules",
  "share-corrected-version",
] as const;
export type ReportOperation = (typeof REPORT_OPERATIONS)[number];

export interface ReportArtifact {
  reportId: string;
  contextId: string;
  purpose: ReportPurpose;
  schemaVersion: string;
  contentDigest: string;
  /** Object key of the stored body; the digest is the key under `reports/`. */
  storageRef: string;
  createdBy: string;
  createdAt: string;
}

export interface ReportEvent {
  reportId: string;
  kind: ReportEventKind;
  actor: string;
  /** Set exactly for `corrected` and `superseded`: which other report this relates to. */
  relatedReportId: string | null;
  occurredAt: string;
}

/** One line of the holdings view. A line is either valued or explicitly unvalued. */
export type ReportRow =
  | {
      subjectRef: string;
      scopeRef: string;
      metric: string;
      unitRef: string;
      valued: true;
      value: ExactDecimal;
    }
  | {
      subjectRef: string;
      scopeRef: string;
      metric: string;
      unitRef: string;
      valued: false;
      unvaluedReason: (typeof UNVALUED_REASONS)[number];
    };

/**
 * The stored body. It carries references and derived values only: no raw
 * provider bytes, no account numbers, no locators into the raw store. What it
 * does carry is enough to say which context and which policies produced it.
 */
export interface ReportBody {
  schemaVersion: typeof REPORT_BODY_SCHEMA_VERSION;
  purpose: ReportPurpose;
  contextId: string;
  calculationRunId: string;
  /** Sorted policy identifiers; the set, not "the latest". */
  policyRefs: string[];
  unitRef: string;
  partition: ResultPartition;
  subtotal: ExactDecimal | null;
  rows: ReportRow[];
  coverage: { scopeRef: string; coveredRef: string; truncated: boolean };
}

const HEX64 = /^[0-9a-f]{64}$/u;

export function validReportBody(value: unknown): value is ReportBody {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "purpose",
      "contextId",
      "calculationRunId",
      "policyRefs",
      "unitRef",
      "partition",
      "subtotal",
      "rows",
      "coverage",
    ]) ||
    value.schemaVersion !== REPORT_BODY_SCHEMA_VERSION ||
    !isOneOf(REPORT_PURPOSES)(value.purpose) ||
    !isText(value.contextId, 256) ||
    !isText(value.calculationRunId, 256) ||
    !isRefList(value.policyRefs, 100) ||
    !isText(value.unitRef, 128) ||
    !isOneOf(RESULT_PARTITIONS)(value.partition) ||
    !(value.subtotal === null || validExactDecimal(value.subtotal)) ||
    !Array.isArray(value.rows) ||
    value.rows.length > 100_000 ||
    !value.rows.every(validReportRow) ||
    !isRecord(value.coverage) ||
    !hasExactKeys(value.coverage, ["scopeRef", "coveredRef", "truncated"]) ||
    !isText(value.coverage.scopeRef, 512) ||
    !isText(value.coverage.coveredRef, 512) ||
    typeof value.coverage.truncated !== "boolean"
  )
    return false;
  // A partial or not-computable body must never present itself as a whole.
  return value.partition !== "not-computable" || value.subtotal === null;
}

export function validReportRow(value: unknown): value is ReportRow {
  if (
    !isRecord(value) ||
    !isText(value.subjectRef, 512) ||
    !isText(value.scopeRef, 512) ||
    !isText(value.metric, 128) ||
    !isText(value.unitRef, 128)
  )
    return false;
  if (value.valued === true)
    return (
      hasExactKeys(value, ["subjectRef", "scopeRef", "metric", "unitRef", "valued", "value"]) &&
      validExactDecimal(value.value)
    );
  return (
    value.valued === false &&
    hasExactKeys(value, [
      "subjectRef",
      "scopeRef",
      "metric",
      "unitRef",
      "valued",
      "unvaluedReason",
    ]) &&
    isOneOf(UNVALUED_REASONS)(value.unvaluedReason)
  );
}

export function validReportArtifact(value: unknown): value is ReportArtifact {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "reportId",
      "contextId",
      "purpose",
      "schemaVersion",
      "contentDigest",
      "storageRef",
      "createdBy",
      "createdAt",
    ]) &&
    isText(value.reportId, 256) &&
    isText(value.contextId, 256) &&
    isOneOf(REPORT_PURPOSES)(value.purpose) &&
    isText(value.schemaVersion, 64) &&
    typeof value.contentDigest === "string" &&
    HEX64.test(value.contentDigest) &&
    isText(value.storageRef, 512) &&
    value.storageRef === reportStorageRef(value.contentDigest) &&
    isText(value.createdBy, 256) &&
    isText(value.createdAt, 64)
  );
}

export function validReportEvent(value: unknown): value is ReportEvent {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["reportId", "kind", "actor", "relatedReportId", "occurredAt"]) &&
    isText(value.reportId, 256) &&
    isOneOf(REPORT_EVENT_KINDS)(value.kind) &&
    isText(value.actor, 256) &&
    isTextOrNull(value.relatedReportId, 256) &&
    (value.kind === "corrected" || value.kind === "superseded") ===
      (value.relatedReportId !== null) &&
    value.relatedReportId !== value.reportId &&
    isText(value.occurredAt, 64)
  );
}

/** The digest of the canonical body. Two runs with the same body get the same digest. */
export async function reportBodyDigest(body: ReportBody): Promise<string> {
  return canonicalDigest(body);
}

/** Object key of a stored body. The digest is the key, so the bytes are content-addressed. */
export function reportStorageRef(contentDigest: string): string {
  return `reports/${contentDigest}`;
}

export const EVIDENCE_RESTRICTIONS = ["no-reuse", "deleted", "key-destroyed"] as const;
export type EvidenceRestriction = (typeof EVIDENCE_RESTRICTIONS)[number];

export interface EvidenceUseRestriction {
  evidenceRef: string;
  restriction: EvidenceRestriction;
  since: string;
  affectedManifests: string[];
  actor: string;
  reason: string;
}

export interface ReplayabilityInputs {
  /** Every input the run named is still present and readable. */
  inputsPresent: boolean;
  /** The stored report body is still present. */
  artifactPresent: boolean;
  /** Restrictions that name this run's context or one of its manifests. */
  restrictions: readonly EvidenceUseRestriction[];
}

/**
 * A restriction always wins. Keeping the bytes of a report does not make its
 * inputs replayable, and holding a digest of deleted bytes does not make the
 * calculation reproducible (addendum 06 section 6).
 */
export function replayabilityFor(inputs: ReplayabilityInputs): Replayability {
  if (inputs.restrictions.length > 0) return "restricted";
  if (inputs.inputsPresent) return "replayable";
  if (inputs.artifactPresent) return "artifact-preserved";
  return "unavailable";
}

/**
 * What a caller may still do. A restricted or unavailable report may not be
 * explained or exported, and any cached explanation node built from the
 * restricted evidence must be purged rather than served (UC66/AT66). Returning
 * the stored artifact is a separate decision that current authorization makes.
 */
export function replayCapabilities(replayability: Replayability): {
  explain: boolean;
  export: boolean;
  recompute: boolean;
  purgeCachedExplanations: boolean;
} {
  const restricted = replayability === "restricted" || replayability === "unavailable";
  return {
    explain: !restricted,
    export: !restricted,
    recompute: replayability === "replayable",
    purgeCachedExplanations: replayability === "restricted",
  };
}
