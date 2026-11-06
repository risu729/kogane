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
 * The paths a verified Access subject stands behind. `alarm` and `lane` are
 * the Processor's own paths (plan slice S7): no subject, an `automatic`
 * principal, effect and failure records only, never capped.
 */
export const SUBJECT_PATHS = ["ui", "agent-http", "mcp"] as const;
export type SubjectPath = (typeof SUBJECT_PATHS)[number];
/** The Processor's own paths, and the prefix of the principal each one records. */
export const AUTOMATIC_PATHS = ["alarm", "lane"] as const;
export type AutomaticPath = (typeof AUTOMATIC_PATHS)[number];

/**
 * How the principal was graded: `human` (the operator), `agent`, `delegated`
 * (with a `delegation_ref`, the delegated MCP principal of ADR 0063), and
 * `automatic`, the Processor's own principal on its `alarm` and `lane` paths
 * (`alarm:<job id>`, `lane:<lane>`).
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
/**
 * The Processor's own principals: `alarm:<job id>` for an alarm job of
 * `config/alarm-jobs.json`, `lane:<lane>` for a scheduled lane, its name with
 * hyphens for underscores (the principal's character set has no underscore).
 */
export const AUTOMATIC_PRINCIPAL = {
  alarm: /^alarm:[a-z0-9-]{1,100}$/u,
  lane: /^lane:[a-z0-9-]{1,64}$/u,
} as const satisfies Record<AutomaticPath, RegExp>;

/**
 * The kinds of proposal a lane writes, as a lane record names them (plan
 * slice S7): the reconciliation proposal kinds of migration 0032 (stage A
 * pairs of the reconciliation sweep, the pending-to-posted candidates of the
 * purchase recognition lane), the card settlement candidates of migration 0044,
 * and the maintenance re-survey proposal kinds of migration 0069. Hyphenated,
 * since neither a reference nor a diff value admits an underscore.
 */
export const LANE_PROPOSAL_KINDS = [
  "reconciliation-provider-same",
  "reconciliation-pending-to-posted",
  "reconciliation-supersedes",
  "reconciliation-supports",
  "reconciliation-contradicts",
  "reconciliation-funded-by",
  "reconciliation-statement-covers",
  "card-settlement-candidate",
  "maintenance-survey-new",
  "maintenance-survey-changed",
  "maintenance-survey-absent",
] as const;
export type LaneProposalKind = (typeof LANE_PROPOSAL_KINDS)[number];
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
/** A row position: a rowid, an integer key or a commit sequence number. */
const POSITION = "[1-9][0-9]{0,18}";
const RANGE = `${POSITION}-${POSITION}`;
/** A field path of a refused request: schema keys only, never a value. */
const FIELD_PATH = "(?:body|[a-z][A-Za-z]{0,31}(?:\\.(?:[a-z][A-Za-z]{0,31}|[0-9]{1,3})){0,3})";

/**
 * Every reference a record may carry, in `target_ref` or `refs_json`. Each is
 * an identifier the existing logs already hold — never a value a caller sent
 * that was refused, and never provider text. A `field:` reference names the
 * field of a refused request by its schema path.
 */
export const AUDIT_REF_PATTERNS: readonly RegExp[] = [
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
  // An alarm occurrence (`collection_schedule_occurrences.id`): its job and
  // nominal instant in epoch milliseconds.
  new RegExp(`^occurrence:scheduled:${SOURCE_ID}:[0-9]{1,16}$`, "u"),
  // The ranges a lane record names (plan slice S7): the rows of one table
  // between two positions, inclusive, that the record's lane wrote. The
  // writer's own predicate (its actor, principal or method; `LANE_AUDIT` in
  // services/processor/src/lane-audit.ts) selects them inside the range, so a
  // row another writer added in between is not named.
  new RegExp(`^decision-revisions:${RANGE}$`, "u"),
  new RegExp(`^commit-seq:[a-z0-9.-]{1,64}:${RANGE}$`, "u"),
  new RegExp(`^proposals:(?:${LANE_PROPOSAL_KINDS.join("|")}):${RANGE}$`, "u"),
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
