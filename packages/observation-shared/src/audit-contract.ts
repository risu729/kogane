// The wire shape of `GET /api/v2/audit` (ADR 0064, "Reading";
// docs/audit-log.md), checked by the browser before the 監査ログ page renders
// a page of it.
//
// Every value of a record is a closed code, a bounded identifier, a digest, a
// count or a canonical time. The closed lists below are the ones the record
// builder (`packages/application/src/audit/vocabulary.ts` and `diff.ts`) and
// the table's CHECK constraints admit; this package may not import the
// application layer, so they are restated here and
// `apps/web/test/audit-contract.test.ts` asserts they are the same lists. A
// record outside them — an unknown result, a diff of a kind the builder does
// not write, a pairing the table refuses — fails the whole page rather than
// being shown as something it is not.

/** The operator's read of the whole store. */
export const AUDIT_PAGE_PATH = "/api/v2/audit";
const AUDIT_PAGE_SCHEMA_VERSION = "kogane-audit-page-v1";
/** Records per page, as the server pages them. */
export const AUDIT_PAGE_LIMIT = 50;

export const AUDIT_PATH_VALUES = ["ui", "agent-http", "mcp", "alarm", "lane"] as const;
export const AUDIT_PRINCIPAL_KIND_VALUES = ["human", "agent", "delegated", "automatic"] as const;
export const AUDIT_RESULT_VALUES = [
  "applied",
  "accepted",
  "prepared",
  "read",
  "replayed",
  "refused",
  "failed",
  "overflow",
] as const;
export const AUDIT_STEP_VALUES = ["call", "prepare", "confirm"] as const;
export const AUDIT_RISK_CLASS_VALUES = ["R0", "R1", "R2", "R3", "R4"] as const;
export const AUDIT_SCOPE_NAMESPACE_VALUES = ["core-source", "schedule-source"] as const;
/** The field names a revision diff may name (`REVISION_FIELDS`). */
export const AUDIT_REVISION_FIELD_VALUES = [
  "enabled",
  "timezone",
  "pattern",
  "scope",
  "source",
  "reference_url",
  "verified_at",
] as const;
/** The counts a decision diff may carry (`DECISION_COUNTS`). */
export const AUDIT_DECISION_COUNT_VALUES = [
  "targets",
  "attributedObservationsBefore",
  "attributedObservationsAfter",
  "relationsBefore",
  "relationsAfter",
  "affectedScopes",
  "affectedParseRuns",
  "invalidations",
  "outboxTargets",
] as const;
/** An operations request's status (`OPERATION_STATUSES`). */
export const AUDIT_REQUEST_STATUS_VALUES = [
  "accepted",
  "waiting_for_human",
  "running",
  "completed",
  "failed",
  "blocked",
] as const;
/** The capped results and their daily caps (`AUDIT_DAILY_CAPS`). */
export const AUDIT_OVERFLOW_CAPS = { read: 2000, refused: 500 } as const;
/** The filters the server accepts besides `cursor`, each at most once. */
export const AUDIT_FILTER_KEYS = [
  "operation",
  "path",
  "principalKind",
  "result",
  "from",
  "to",
] as const;

type AuditPathValue = (typeof AUDIT_PATH_VALUES)[number];
type AuditPrincipalKindValue = (typeof AUDIT_PRINCIPAL_KIND_VALUES)[number];
type AuditResultValue = (typeof AUDIT_RESULT_VALUES)[number];
export type AuditFilterKey = (typeof AUDIT_FILTER_KEYS)[number];

export type AuditDiffView =
  | {
      kind: "revision";
      from: number;
      to: number;
      fields: (typeof AUDIT_REVISION_FIELD_VALUES)[number][];
    }
  | {
      kind: "decision";
      decisionRevisions: number;
      commitSeq: string | null;
      counts: Partial<Record<(typeof AUDIT_DECISION_COUNT_VALUES)[number], number>>;
    }
  | { kind: "request"; status: (typeof AUDIT_REQUEST_STATUS_VALUES)[number] }
  | { kind: "read"; rows: number; truncated: boolean }
  | { kind: "release"; released: true }
  | { kind: "overflow"; of: "read" | "refused"; count: number; cap: number }
  | { kind: "none" };

/** One record as `GET /api/v2/audit` returns it (`AuditRecordView`). */
export interface AuditRecordWire {
  auditId: string;
  recordedAt: string;
  path: AuditPathValue;
  subject: string | null;
  principal: string;
  principalKind: AuditPrincipalKindValue;
  delegationRef: string | null;
  operation: string;
  riskClass: (typeof AUDIT_RISK_CLASS_VALUES)[number];
  step: (typeof AUDIT_STEP_VALUES)[number];
  scope: { namespace: (typeof AUDIT_SCOPE_NAMESPACE_VALUES)[number]; source: string } | null;
  targetRef: string | null;
  result: AuditResultValue;
  resultCode: string | null;
  reasonCode: string | null;
  correlationId: string;
  idempotencyKey: string | null;
  payloadDigest: string | null;
  confirmationDigest: string | null;
  confirmExpiresAt: string | null;
  confirmsAuditId: string | null;
  revertsAuditId: string | null;
  refs: string[];
  diff: AuditDiffView;
}

export interface AuditPageWire {
  schemaVersion: typeof AUDIT_PAGE_SCHEMA_VERSION;
  records: AuditRecordWire[];
  /** Opaque; null on the last page. Bound by the server to the filters it was issued under. */
  cursor: string | null;
}

// ── patterns (vocabulary.ts and the table's CHECK constraints) ─────────────

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const AUDIT_PATTERNS = {
  auditId: new RegExp(`^aud_${UUID}$`, "u"),
  correlationId: new RegExp(`^${UUID}$`, "u"),
  instant: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
  subject: /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u,
  principal: /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u,
  operation: /^[a-z][a-z0-9.-]{0,63}$/u,
  resultCode: /^[a-z][a-z0-9_]{0,63}$/u,
  reasonCode: /^[a-z][a-z0-9_-]{0,63}$/u,
  idempotencyKey: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u,
  digest: /^[0-9a-f]{64}$/u,
  delegationRef: /^dlg_[0-9a-f]{64}$/u,
  confirmationDigest: /^cfm_[0-9a-f]{64}$/u,
  scopeSource: /^[a-z0-9-]{1,100}$/u,
  commitSeq: /^commit-seq:[a-z0-9.-]{1,64}:[1-9][0-9]{0,15}$/u,
  /** The server's cursor text. */
  cursor: /^[A-Za-z0-9_-]{1,400}$/u,
  /** A UTC day filter. */
  day: /^\d{4}-\d{2}-\d{2}$/u,
} as const;

const SOURCE_ID = "[a-z0-9-]{1,100}";
const HEX64 = "[0-9a-f]{64}";
const FIELD_PATH = "(?:body|[a-z][A-Za-z]{0,31}(?:\\.(?:[a-z][A-Za-z]{0,31}|[0-9]{1,3})){0,3})";
/**
 * The references a record may carry in `targetRef` or `refs`
 * (`AUDIT_REF_PATTERNS`): identifiers the existing logs already hold, never a
 * URL or a value a caller sent.
 */
export const AUDIT_REFERENCE_PATTERNS: readonly RegExp[] = [
  new RegExp(`^plan:${HEX64}$`, "u"),
  new RegExp(`^approval:ap_${HEX64}$`, "u"),
  /^operation:[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u,
  new RegExp(`^op_${HEX64}$`, "u"),
  /^decision:[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u,
  /^proposal:[0-9a-f]{32}$/u,
  new RegExp(`^schedule:${SOURCE_ID}(?:@[1-9][0-9]{0,8})?$`, "u"),
  new RegExp(`^maintenance-rule:${SOURCE_ID}(?:@[1-9][0-9]{0,8})?$`, "u"),
  /^maintenance-survey-proposal:[1-9][0-9]{0,15}$/u,
  new RegExp(`^collection-lease:${SOURCE_ID}$`, "u"),
  new RegExp(`^source:${SOURCE_ID}$`, "u"),
  new RegExp(`^field:${FIELD_PATH}$`, "u"),
];
const reference = (value: unknown): boolean =>
  typeof value === "string" &&
  value.length <= 300 &&
  AUDIT_REFERENCE_PATTERNS.some((pattern) => pattern.test(value));

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const matches = (pattern: RegExp) => (value: unknown) =>
  typeof value === "string" && pattern.test(value);
const nullOr = (check: (value: unknown) => boolean) => (value: unknown) =>
  value === null || check(value);
const oneOf = (values: readonly string[]) => (value: unknown) =>
  typeof value === "string" && values.includes(value);
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const instant = (value: unknown): boolean =>
  matches(AUDIT_PATTERNS.instant)(value) &&
  new Date(value as string).toISOString() === (value as string);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key)) &&
  keys.every((key) => Object.hasOwn(value, key));

/** A UTC day the server's filter accepts (a real calendar day). */
export function validAuditDay(value: string): boolean {
  return (
    AUDIT_PATTERNS.day.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)) &&
    new Date(`${value}T00:00:00.000Z`).toISOString().startsWith(value)
  );
}

/** One strict shape per diff kind, as the builder's strict schemas are. */
function validDiff(value: unknown): boolean {
  if (!record(value)) return false;
  switch (value["kind"]) {
    case "revision":
      return (
        exactKeys(value, ["kind", "from", "to", "fields"]) &&
        count(value["from"]) &&
        count(value["to"]) &&
        value["to"] > 0 &&
        Array.isArray(value["fields"]) &&
        value["fields"].length <= AUDIT_REVISION_FIELD_VALUES.length &&
        value["fields"].every(oneOf(AUDIT_REVISION_FIELD_VALUES))
      );
    case "decision": {
      const counts = value["counts"];
      return (
        exactKeys(value, ["kind", "decisionRevisions", "commitSeq", "counts"]) &&
        count(value["decisionRevisions"]) &&
        nullOr(matches(AUDIT_PATTERNS.commitSeq))(value["commitSeq"]) &&
        record(counts) &&
        Object.entries(counts).every(
          ([key, n]) =>
            (AUDIT_DECISION_COUNT_VALUES as readonly string[]).includes(key) && count(n),
        )
      );
    }
    case "request":
      return (
        exactKeys(value, ["kind", "status"]) && oneOf(AUDIT_REQUEST_STATUS_VALUES)(value["status"])
      );
    case "read":
      return (
        exactKeys(value, ["kind", "rows", "truncated"]) &&
        count(value["rows"]) &&
        typeof value["truncated"] === "boolean"
      );
    case "release":
      return exactKeys(value, ["kind", "released"]) && value["released"] === true;
    case "overflow":
      return (
        exactKeys(value, ["kind", "of", "count", "cap"]) &&
        (value["of"] === "read" || value["of"] === "refused") &&
        count(value["count"]) &&
        value["count"] > 0 &&
        (value["cap"] === AUDIT_OVERFLOW_CAPS.read || value["cap"] === AUDIT_OVERFLOW_CAPS.refused)
      );
    case "none":
      return exactKeys(value, ["kind"]);
    default:
      return false;
  }
}

const RECORD_KEYS = [
  "auditId",
  "recordedAt",
  "path",
  "subject",
  "principal",
  "principalKind",
  "delegationRef",
  "operation",
  "riskClass",
  "step",
  "scope",
  "targetRef",
  "result",
  "resultCode",
  "reasonCode",
  "correlationId",
  "idempotencyKey",
  "payloadDigest",
  "confirmationDigest",
  "confirmExpiresAt",
  "confirmsAuditId",
  "revertsAuditId",
  "refs",
  "diff",
] as const satisfies readonly (keyof AuditRecordWire)[];

function validAuditRecord(value: unknown): value is AuditRecordWire {
  if (!record(value) || !RECORD_KEYS.every((key) => Object.hasOwn(value, key))) return false;
  const v = value as Record<(typeof RECORD_KEYS)[number], unknown>;
  const automatic = v.path === "alarm" || v.path === "lane";
  const scope = v.scope;
  const diff = v.diff as Record<string, unknown> | undefined;
  return (
    matches(AUDIT_PATTERNS.auditId)(v.auditId) &&
    instant(v.recordedAt) &&
    oneOf(AUDIT_PATH_VALUES)(v.path) &&
    (automatic ? v.subject === null : matches(AUDIT_PATTERNS.subject)(v.subject)) &&
    matches(AUDIT_PATTERNS.principal)(v.principal) &&
    oneOf(AUDIT_PRINCIPAL_KIND_VALUES)(v.principalKind) &&
    (v.principalKind === "automatic") === automatic &&
    (v.principalKind === "delegated"
      ? matches(AUDIT_PATTERNS.delegationRef)(v.delegationRef)
      : v.delegationRef === null) &&
    matches(AUDIT_PATTERNS.operation)(v.operation) &&
    oneOf(AUDIT_RISK_CLASS_VALUES)(v.riskClass) &&
    oneOf(AUDIT_STEP_VALUES)(v.step) &&
    (scope === null ||
      (record(scope) &&
        exactKeys(scope, ["namespace", "source"]) &&
        oneOf(AUDIT_SCOPE_NAMESPACE_VALUES)(scope["namespace"]) &&
        matches(AUDIT_PATTERNS.scopeSource)(scope["source"]))) &&
    nullOr(reference)(v.targetRef) &&
    oneOf(AUDIT_RESULT_VALUES)(v.result) &&
    // A refusal or failure carries its closed code; nothing else does.
    (v.result === "refused" || v.result === "failed"
      ? matches(AUDIT_PATTERNS.resultCode)(v.resultCode)
      : v.resultCode === null) &&
    nullOr(matches(AUDIT_PATTERNS.reasonCode))(v.reasonCode) &&
    matches(AUDIT_PATTERNS.correlationId)(v.correlationId) &&
    nullOr(matches(AUDIT_PATTERNS.idempotencyKey))(v.idempotencyKey) &&
    nullOr(matches(AUDIT_PATTERNS.digest))(v.payloadDigest) &&
    // A preparation, and only a preparation, carries its digest and expiry.
    (v.result === "prepared"
      ? v.step === "prepare" &&
        matches(AUDIT_PATTERNS.confirmationDigest)(v.confirmationDigest) &&
        instant(v.confirmExpiresAt)
      : v.confirmationDigest === null && v.confirmExpiresAt === null) &&
    nullOr(matches(AUDIT_PATTERNS.auditId))(v.confirmsAuditId) &&
    (v.confirmsAuditId === null || v.step === "confirm") &&
    nullOr(matches(AUDIT_PATTERNS.auditId))(v.revertsAuditId) &&
    Array.isArray(v.refs) &&
    v.refs.length <= 16 &&
    v.refs.every(reference) &&
    validDiff(diff) &&
    // An overflow result is exactly an overflow diff.
    (v.result === "overflow") === (diff?.["kind"] === "overflow")
  );
}

/**
 * A page: the schema version, at most 50 records, newest first with no
 * repeated id, and an opaque cursor or null. As elsewhere in the shared
 * contract, an additive field is tolerated and never read; a diff is the
 * exception, strict like the builder's schemas, since it is shown field by
 * field.
 */
export function validAuditPage(value: unknown): value is AuditPageWire {
  if (
    !record(value) ||
    !Object.hasOwn(value, "cursor") ||
    value["schemaVersion"] !== AUDIT_PAGE_SCHEMA_VERSION ||
    !Array.isArray(value["records"]) ||
    value["records"].length > AUDIT_PAGE_LIMIT ||
    !nullOr(matches(AUDIT_PATTERNS.cursor))(value["cursor"]) ||
    !value["records"].every(validAuditRecord)
  )
    return false;
  const records = value["records"] as AuditRecordWire[];
  return records.every((row, index) => {
    const previous = records[index - 1];
    return (
      previous === undefined ||
      previous.recordedAt > row.recordedAt ||
      (previous.recordedAt === row.recordedAt && previous.auditId > row.auditId)
    );
  });
}
