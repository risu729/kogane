// The closed vocabulary of the common audit record (ADR 0064, CORE 0075).
//
// Every value an audit record can hold is named here: the paths, the
// principal kinds, the results, the steps and risk classes, the reference and
// code patterns, and the daily caps. The migration's CHECK constraints and its
// trigger state the same sets in SQL; this module is what the builder
// (`record.ts`) validates against before anything is written, so a record that
// the table would refuse is refused here first, with a code and never with the
// value that failed.

/** The operation paths of ADR 0064. */
export const AUDIT_PATHS = ["ui", "agent-http", "mcp", "alarm", "lane"] as const;
export type AuditPath = (typeof AUDIT_PATHS)[number];

/**
 * The paths a verified Access subject stands behind, and the only ones this
 * slice writes. `alarm` and `lane` are the Processor's own paths; their
 * writers are a later slice (plan S7), and until then the log records
 * subject-originated operations only.
 */
export const SUBJECT_PATHS = ["ui", "agent-http", "mcp"] as const;
export type SubjectPath = (typeof SUBJECT_PATHS)[number];

/**
 * How the principal was graded. The table also admits `delegated` (with a
 * `delegation_ref`) for the delegated MCP principal of ADR 0063; the
 * declaration core resolves one, but nothing executes under it yet, so this
 * builder refuses it, and `automatic` is the Processor's own principal on its
 * `alarm` and `lane` paths.
 */
export const AUDIT_PRINCIPAL_KINDS = ["human", "agent", "delegated", "automatic"] as const;
export type AuditPrincipalKind = (typeof AUDIT_PRINCIPAL_KINDS)[number];
/** The kinds a subject on `ui`, `agent-http` or `mcp` is graded as today. */
export type SubjectPrincipalKind = Exclude<AuditPrincipalKind, "automatic">;

export const AUDIT_RESULTS = [
  "applied",
  "accepted",
  "prepared",
  "read",
  "replayed",
  "refused",
  "failed",
  "overflow",
] as const;
export type AuditResult = (typeof AUDIT_RESULTS)[number];

// A writer records `applied` and `accepted`, as the last statement of its own
// batch, so the effect exists exactly when its record does; the App adapter
// records `read`, `replayed`, `refused` and `failed` after the answer, never
// inside a writer's batch; the Processor's daily aggregate is `overflow`.

export const AUDIT_DELEGATION_REF = /^dlg_[0-9a-f]{64}$/u;
export const AUDIT_CONFIRMATION_DIGEST = /^cfm_[0-9a-f]{64}$/u;
export const AUDIT_STEPS = ["call", "prepare", "confirm"] as const;
export type AuditStep = (typeof AUDIT_STEPS)[number];

/** ADR 0063's risk classes; the catalogue gives each operation its own. */
export const RISK_CLASSES = ["R0", "R1", "R2", "R3", "R4"] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];

/** Which grant axis a scoped reader of the record checks the source against. */
export const SCOPE_NAMESPACES = ["core-source", "schedule-source"] as const;
export type ScopeNamespace = (typeof SCOPE_NAMESPACES)[number];

/**
 * Per principal and UTC day (ADR 0064, "Daily caps"). `applied` and
 * `accepted` records are never capped: no effect is applied without its
 * record. Past the `prepared` cap a prepare is refused; past the `read` and
 * `refused` caps the event is still served and answered, and only counted.
 */
export const AUDIT_DAILY_CAPS = { prepared: 200, read: 2000, refused: 500 } as const;
/** The capped results that overflow into a counter rather than refusing. */
export const OVERFLOW_RESULTS = ["read", "refused"] as const;
export type OverflowResult = (typeof OVERFLOW_RESULTS)[number];

/** The refusal of a prepare past its principal's daily `prepared` cap. */
export const AUDIT_CAP_REACHED = "audit_cap_reached";
/** What the request log carries when a record could not be written. */
export const AUDIT_WRITE_FAILED = "audit_write_failed";

// ── patterns ─────────────────────────────────────────────────────────────

/** A verified Access subject; the change lifecycle's actor shape (ACTOR_PATTERN). */
export const AUDIT_SUBJECT = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;
/** `<sub>` or `mcp-client:<sub>` (ADR 0047), or the Processor's own principal. */
export const AUDIT_PRINCIPAL = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
/** An operation name; the closed list is `OPERATION_CATALOGUE`. */
export const AUDIT_OPERATION = /^[a-z][a-z0-9.-]{0,63}$/u;
/** A closed result code of the command, operations, schedule or agent API vocabularies. */
export const AUDIT_RESULT_CODE = /^[a-z][a-z0-9_]{0,63}$/u;
/** A closed reason code of one operation family (for example the survey decision's). */
export const AUDIT_REASON_CODE = /^[a-z][a-z0-9_-]{0,63}$/u;
/** The operations API's idempotency key pattern (ADR 0063, section 4.3). */
export const AUDIT_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
export const AUDIT_DIGEST = /^[0-9a-f]{64}$/u;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const AUDIT_ID = new RegExp(`^aud_${UUID}$`, "u");
export const AUDIT_CORRELATION_ID = new RegExp(`^${UUID}$`, "u");
export const AUDIT_SCOPE_SOURCE = /^[a-z0-9-]{1,100}$/u;
/** Canonical UTC milliseconds, the `economic_commit_log.known_at` shape. */
export const AUDIT_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const SOURCE_ID = "[a-z0-9-]{1,100}";
const HEX64 = "[0-9a-f]{64}";
/** A field path of a refused request: schema keys only, never a value. */
const FIELD_PATH = "(?:body|[a-z][A-Za-z]{0,31}(?:\\.(?:[a-z][A-Za-z]{0,31}|[0-9]{1,3})){0,3})";

/**
 * Every reference a record may carry, in `target_ref` or `refs_json`. Each is
 * an identifier the existing logs already hold — never a value a caller sent
 * that was refused, and never provider text. A `field:` reference names the
 * field of a refused request by its schema path.
 */
const AUDIT_REF_PATTERNS: readonly RegExp[] = [
  new RegExp(`^plan:${HEX64}$`, "u"),
  new RegExp(`^approval:ap_${HEX64}$`, "u"),
  // A commit's operation id is the caller's own idempotency key (A09).
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

export function isAuditRef(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 300 &&
    AUDIT_REF_PATTERNS.some((pattern) => pattern.test(value))
  );
}

/** At most this many references per record. */
export const AUDIT_MAX_REFS = 16;
/** Largest `diff_json`, in bytes of its JSON text. */
export const AUDIT_MAX_DIFF_BYTES = 2048;
