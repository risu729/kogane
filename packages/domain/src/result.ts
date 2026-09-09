// The shared response contract for UI and agent adapters (INV12). A total is a
// Quantity with a unit and a value state, coverage is defined inside the
// authorised scope, and business states that are not failures (unknown
// accounts, missing prices) are `partial`, not an empty array.
import {
  hasExactKeys,
  isOneOf,
  isRecord,
  isRefList,
  isSafeInt,
  isText,
  isTextOrNull,
} from "./guards.ts";
import { validTemporalValue, type TemporalValue } from "./time.ts";

export const QUERY_INTENTS = [
  "holdings",
  "reported-state",
  "net-worth",
  "liquidity",
  "cash-flow",
  "obligations",
  "activity",
  "income",
  "performance",
  "reward-forecast",
] as const;
export type QueryIntent = (typeof QUERY_INTENTS)[number];

/** Server-resolved query; never an LLM paraphrase. */
export interface QuerySpec {
  schemaVersion: "query-spec-v1";
  intent: QueryIntent;
  perimeterRef: string;
  effectiveTime: TemporalValue;
  /** Named bases the intent needs (execution vs settlement, valuation policy, ...). */
  basisRefs: Record<string, string>;
  filters: Record<string, string>;
  limit: number | null;
}

export const QUALITY_STATES = [
  "verified",
  "partial",
  "unresolved",
  "conflict",
  "not-applicable",
] as const;
export type QualityState = (typeof QUALITY_STATES)[number];
export interface QualityDimension {
  state: QualityState;
  reasonCodes: string[];
  evidenceRefs: string[];
}

export const COMPLETENESS_STATES = ["complete", "partial", "unavailable"] as const;
export type CompletenessState = (typeof COMPLETENESS_STATES)[number];
export const WARNING_SEVERITIES = ["info", "warning", "blocking"] as const;
export type WarningSeverity = (typeof WARNING_SEVERITIES)[number];

export interface DataCoverage {
  scopeRef: string;
  coveredRef: string;
  gaps: { reasonCode: string; scopeRef: string | null }[];
  truncated: boolean;
}

export interface FinancialResult<T> {
  schemaVersion: "financial-result-v1";
  contextId: string;
  resolvedQuery: QuerySpec;
  completeness: CompletenessState;
  data: T;
  coverage: DataCoverage;
  quality: {
    identity: QualityDimension;
    freshness: QualityDimension;
    numeric: QualityDimension;
    reconciliation: QualityDimension;
    valuation: QualityDimension;
  };
  nextCursor: string | null;
  explanationRefs: string[];
  warnings: { code: string; severity: WarningSeverity }[];
}

export interface Page<T> {
  items: T[];
  /** Cursor bound to context, query digest, sort key and tie-break id; opaque to callers. */
  nextCursor: string | null;
  dataCoverage: DataCoverage;
}

export const FINANCIAL_ERROR_CODES = [
  "needs_scope_resolution",
  "incomplete_evidence",
  "unsupported_semantics",
  "needs_rule_verification",
  "stale_context",
  "approval_required",
  "idempotency_conflict",
  "budget_exceeded",
  "evidence_restricted",
  "context_expired",
  "unauthorized",
  "invalid_query",
] as const;
export type FinancialErrorCode = (typeof FINANCIAL_ERROR_CODES)[number];

/** Machine-useful error; the message never carries provider content, tokens or raw exceptions. */
export interface FinancialError {
  schemaVersion: "financial-error-v1";
  code: FinancialErrorCode;
  requestId: string;
  message: string;
  /** Safe references the caller may act on (candidate scopes, context ids). */
  refs: string[];
}

export type FinancialOutcome<T> =
  | { ok: true; result: FinancialResult<T> }
  | { ok: false; error: FinancialError };

export function validQuerySpec(value: unknown): value is QuerySpec {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "schemaVersion",
      "intent",
      "perimeterRef",
      "effectiveTime",
      "basisRefs",
      "filters",
      "limit",
    ]) &&
    value.schemaVersion === "query-spec-v1" &&
    isOneOf(QUERY_INTENTS)(value.intent) &&
    isText(value.perimeterRef, 256) &&
    validTemporalValue(value.effectiveTime) &&
    stringRecord(value.basisRefs) &&
    stringRecord(value.filters) &&
    (value.limit === null || isSafeInt(value.limit, 1, 100_000))
  );
}

function stringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.entries(value).every(([key, item]) => isText(key, 128) && isText(item, 1024))
  );
}

export function validQualityDimension(value: unknown): value is QualityDimension {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["state", "reasonCodes", "evidenceRefs"]) &&
    isOneOf(QUALITY_STATES)(value.state) &&
    Array.isArray(value.reasonCodes) &&
    value.reasonCodes.every((code) => isText(code, 128)) &&
    isRefList(value.evidenceRefs)
  );
}

export function validDataCoverage(value: unknown): value is DataCoverage {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["scopeRef", "coveredRef", "gaps", "truncated"]) &&
    isText(value.scopeRef, 512) &&
    isText(value.coveredRef, 512) &&
    Array.isArray(value.gaps) &&
    value.gaps.every(
      (gap) =>
        isRecord(gap) &&
        hasExactKeys(gap, ["reasonCode", "scopeRef"]) &&
        isText(gap.reasonCode, 128) &&
        isTextOrNull(gap.scopeRef, 512),
    ) &&
    typeof value.truncated === "boolean"
  );
}

export function validFinancialResult<T>(
  value: unknown,
  data: (candidate: unknown) => candidate is T,
): value is FinancialResult<T> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "contextId",
      "resolvedQuery",
      "completeness",
      "data",
      "coverage",
      "quality",
      "nextCursor",
      "explanationRefs",
      "warnings",
    ]) ||
    value.schemaVersion !== "financial-result-v1" ||
    !isText(value.contextId, 256) ||
    !validQuerySpec(value.resolvedQuery) ||
    !isOneOf(COMPLETENESS_STATES)(value.completeness) ||
    !data(value.data) ||
    !validDataCoverage(value.coverage) ||
    !isRecord(value.quality) ||
    !hasExactKeys(value.quality, [
      "identity",
      "freshness",
      "numeric",
      "reconciliation",
      "valuation",
    ]) ||
    !Object.values(value.quality).every(validQualityDimension) ||
    !isTextOrNull(value.nextCursor, 2048) ||
    !isRefList(value.explanationRefs) ||
    !Array.isArray(value.warnings)
  )
    return false;
  return value.warnings.every(
    (warning) =>
      isRecord(warning) &&
      hasExactKeys(warning, ["code", "severity"]) &&
      isText(warning.code, 128) &&
      isOneOf(WARNING_SEVERITIES)(warning.severity),
  );
}

export function validPage<T>(
  value: unknown,
  item: (candidate: unknown) => candidate is T,
): value is Page<T> {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["items", "nextCursor", "dataCoverage"]) &&
    Array.isArray(value.items) &&
    value.items.every(item) &&
    isTextOrNull(value.nextCursor, 2048) &&
    validDataCoverage(value.dataCoverage)
  );
}

export function validFinancialError(value: unknown): value is FinancialError {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["schemaVersion", "code", "requestId", "message", "refs"]) &&
    value.schemaVersion === "financial-error-v1" &&
    isOneOf(FINANCIAL_ERROR_CODES)(value.code) &&
    isText(value.requestId, 128) &&
    isText(value.message, 512) &&
    isRefList(value.refs, 100)
  );
}
