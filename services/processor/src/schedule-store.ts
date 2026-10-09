import jobs from "../../../config/alarm-jobs.json";
import {
  afterMaintenance,
  deferralUnions,
  longestDeferral,
  nextNominal,
  validPattern,
  validMaintenance,
  validInstant,
  MAINTENANCE_CHANGE_REASONS,
  ZONES,
  type MaintenanceChangeReason,
  type MaintenancePattern,
  type SchedulePattern,
  type ScheduleView,
  type MaintenanceRule,
  type ScheduleOccurrence,
  type ScheduleSnapshot,
} from "../../../packages/collection/src/schedule-model";
import {
  decideSurveyProposal,
  maintenanceSurveyView,
  type RevisionAppend,
  type SavedRevision,
} from "./maintenance-survey/decisions.ts";
import {
  ACTOR_PATTERN,
  AUDIT_HEADERS,
  AUDIT_RECORDED_HEADER,
  changedFields,
  type OperationCall,
  type OperationName,
  parseAuditEnvelope,
  processorCall,
} from "../../../packages/application/src/index.ts";
import type { SqlWrite } from "../../../packages/storage-d1/src/core/operations.ts";
import { canonicalDigest } from "../../../packages/domain/src/context.ts";
export { jobs };
export interface ScheduleRow {
  id: string;
  source: string | null;
  kind: ScheduleView["kind"];
  enabled: number;
  supported: number;
  timezone: string;
  pattern_json: string;
  revision: number;
  next_nominal_at: string | null;
  next_run_at: string | null;
}
export class ScheduleError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
  ) {
    super(code);
  }
}
export function jobFor(id: string) {
  const job = jobs.find((j) => j.id === id);
  if (!job) throw new ScheduleError("schedule_not_found", 404);
  return job;
}
export async function readSchedule(db: D1Database, id: string): Promise<ScheduleRow> {
  jobFor(id);
  const row = await db
    .prepare("SELECT * FROM collection_schedules WHERE id=?")
    .bind(id)
    .first<ScheduleRow>();
  if (!row) throw new ScheduleError("schedule_not_initialized", 503);
  return row;
}
export async function maintenanceRules(
  db: D1Database,
  source?: string | null,
): Promise<MaintenanceRule[]> {
  const result = await db
    .prepare(`SELECT m.* FROM provider_maintenance_rules m
    WHERE NOT EXISTS(SELECT 1 FROM provider_maintenance_rules n WHERE n.id=m.id AND n.revision>m.revision)
    ${source ? "AND m.source=?" : ""} ORDER BY m.source,m.id`)
    .bind(...(source ? [source] : []))
    .all<{
      id: string;
      revision: number;
      source: string;
      timezone: string;
      pattern_json: string;
      enabled: number;
      reference_url: string;
      verified_at: string;
      scope: MaintenanceRule["scope"];
    }>();
  return result.results.map((r) => ({
    id: r.id,
    revision: r.revision,
    source: r.source,
    timezone: r.timezone,
    pattern: JSON.parse(r.pattern_json) as MaintenanceRule["pattern"],
    enabled: r.enabled === 1,
    referenceUrl: r.reference_url,
    verifiedAt: r.verified_at,
    scope: r.scope,
  }));
}
/** Collection-only windows must not suppress session keepalive. */
export async function maintenanceForSchedule(
  db: D1Database,
  row: Pick<ScheduleRow, "source" | "kind">,
): Promise<MaintenanceRule[]> {
  if (!row.source || !["collection", "keepalive"].includes(row.kind)) return [];
  const rules = await maintenanceRules(db, row.source);
  return rules.filter(
    (rule) =>
      rule.scope === "session" || (row.kind === "collection" && rule.scope === "collection"),
  );
}
export async function initializeSchedule(env: Env, id: string): Promise<ScheduleRow> {
  const row = await readSchedule(env.DB, id);
  if (row.enabled && row.next_nominal_at === null) {
    // Bootstrap only future occurrences after the old Cron's propagation window.
    const nominal = nextNominal(
      JSON.parse(row.pattern_json) as SchedulePattern,
      row.timezone,
      Date.now() + 20 * 60_000,
    );
    const due = afterMaintenance(nominal, await maintenanceForSchedule(env.DB, row));
    await env.DB.prepare(
      "UPDATE collection_schedules SET next_nominal_at=?,next_run_at=? WHERE id=? AND revision=? AND enabled=1 AND next_nominal_at IS NULL",
    )
      .bind(new Date(nominal).toISOString(), new Date(due).toISOString(), id, row.revision)
      .run();
  }
  return readSchedule(env.DB, id);
}
/** Classify abandoned bookkeeping only; this never releases leases or replays collection. */
export async function markAbandonedOccurrences(db: D1Database, before: string): Promise<void> {
  await db
    .prepare(
      "UPDATE collection_schedule_occurrences SET status='uncertain',failure_code='dispatch_uncertain' WHERE status='started' AND started_at<?",
    )
    .bind(before)
    .run();
}
export async function bootstrapSchedules(env: Env) {
  // A generous grace exceeds the platform alarm's 15-minute execution limit.
  // The exact finish time is unknown, so finished_at deliberately remains null.
  await markAbandonedOccurrences(env.DB, new Date(Date.now() - 60 * 60_000).toISOString());
  const reservations = [];
  for (const job of jobs) {
    const row = await initializeSchedule(env, job.id);
    const alarm = await env.SCHEDULE_ALARMS.getByName(job.id).reconcile(job.id);
    reservations.push({ id: job.id, enabled: row.enabled === 1, actualAlarmAt: alarm });
  }
  return { status: "armed", reservations };
}
function bodyObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ScheduleError("invalid_request");
  return value as Record<string, unknown>;
}
function exactKeys(v: Record<string, unknown>, keys: string[]) {
  if (Object.keys(v).some((k) => !keys.includes(k))) throw new ScheduleError("invalid_request");
}
function statement(db: D1Database, write: SqlWrite): D1PreparedStatement {
  return db.prepare(write.sql).bind(...write.binds);
}
/**
 * Saves one job revision. The `applied` audit record (ADR 0064) is the last
 * statement of the same batch, joined to the revision row this call wrote,
 * so a version check that matched nothing leaves no revision and no record.
 */
export async function updateSchedule(
  env: Env,
  id: string,
  value: unknown,
  actor: string,
  audit: OperationCall,
) {
  const v = bodyObject(value);
  exactKeys(v, ["revision", "enabled", "timezone", "pattern"]);
  const row = await readSchedule(env.DB, id);
  if (!row.supported) throw new ScheduleError("schedule_not_supported", 409);
  if (!Number.isInteger(v.revision) || v.revision !== row.revision)
    throw new ScheduleError("revision_conflict", 409);
  if (
    typeof v.enabled !== "boolean" ||
    typeof v.timezone !== "string" ||
    !(ZONES as readonly string[]).includes(v.timezone) ||
    !validPattern(v.pattern)
  )
    throw new ScheduleError("invalid_request");
  if (
    (row.kind === "collection" && v.pattern.kind !== "daily") ||
    (row.kind !== "collection" && v.pattern.kind !== "interval")
  )
    throw new ScheduleError("invalid_request");
  const nominal = v.enabled ? nextNominal(v.pattern, v.timezone, Date.now()) : null;
  const due =
    nominal === null ? null : afterMaintenance(nominal, await maintenanceForSchedule(env.DB, row));
  const now = new Date().toISOString(),
    pattern = JSON.stringify(v.pattern),
    next = row.revision + 1;
  const record = audit.effect(
    {
      targetRef: `schedule:${id}`,
      refs: [`schedule:${id}@${next}`],
      scope: row.source === null ? null : { namespace: "schedule-source", source: row.source },
      payloadDigest: await canonicalDigest({
        revision: v.revision,
        enabled: v.enabled,
        timezone: v.timezone,
        pattern: v.pattern,
      }),
      diff: {
        kind: "revision",
        from: row.revision,
        to: next,
        fields: changedFields(
          {
            enabled: row.enabled === 1,
            timezone: row.timezone,
            pattern: JSON.parse(row.pattern_json) as unknown,
          },
          { enabled: v.enabled, timezone: v.timezone, pattern: v.pattern },
        ),
      },
    },
    {
      sql: "EXISTS(SELECT 1 FROM collection_schedule_revisions WHERE schedule_id=? AND revision=? AND actor=? AND created_at=?)",
      binds: [id, next, actor, now],
    },
    { kind: "target-ref", ref: `schedule:${id}@${next}` },
  );
  const result = await env.DB.batch([
    env.DB.prepare(
      "UPDATE collection_schedules SET revision=revision+1,enabled=?,timezone=?,pattern_json=?,next_nominal_at=?,next_run_at=?,updated_at=?,updated_by=? WHERE id=? AND revision=?",
    ).bind(
      Number(v.enabled),
      v.timezone,
      pattern,
      nominal === null ? null : new Date(nominal).toISOString(),
      due === null ? null : new Date(due).toISOString(),
      now,
      actor,
      id,
      row.revision,
    ),
    env.DB.prepare(
      "INSERT OR IGNORE INTO collection_schedule_revisions(schedule_id,revision,enabled,timezone,pattern_json,actor,created_at) SELECT id,revision,enabled,timezone,pattern_json,updated_by,updated_at FROM collection_schedules WHERE id=? AND revision=? AND updated_by=? AND updated_at=?",
    ).bind(id, next, actor, now),
    statement(env.DB, record),
  ]);
  if (result[0]?.meta.changes !== 1) throw new ScheduleError("revision_conflict", 409);
  audit.settle(result[2]?.meta.changes);
  let actualAlarmAt: string | null = null,
    reservation = "pending";
  try {
    actualAlarmAt = await env.SCHEDULE_ALARMS.getByName(id).reconcile(id);
    reservation = v.enabled ? "armed" : "disabled";
  } catch {
    /* Persisted config is reported separately from arming. */
  }
  return { saved: true, reservation, actualAlarmAt, revision: next };
}
// ── The maintenance writer ─────────────────────────────────────────────
//
// `writeMaintenanceRevision` is the one place a maintenance rule revision is
// written (ADR 0046 as amended by ADR 0063, item 8). The operator route
// (`updateMaintenance`) and an accepted re-survey proposal (ADR 0050) are its
// adapters; a delegated principal reaches no route to it yet (ADR 0063 slice
// S3 connects delegated execution). It never throws for a refusal: it answers
// a closed `MaintenanceWriteCode`. What its caller appends (its audit record,
// a survey decision) is sent in the revision's own batch, so the revision, its
// provenance and what was appended exist together or not at all (ADR 0064).

/** Every refusal the writer can answer, with the HTTP status the routes use. */
export const MAINTENANCE_WRITE_CODES = {
  /** A field is missing, malformed, or outside its closed set. */
  invalid_request: 400,
  /** The reference is not https on the source's already registered host. */
  invalid_reference: 400,
  /** The reason is not a closed code this actor may give (`MAINTENANCE_CHANGE_REASONS`). */
  invalid_reason: 400,
  /** A delegated principal named a rule that is not this source's (or does not exist). */
  maintenance_rule_not_found: 404,
  /** `expectedRevision` is not the rule's current revision. */
  revision_conflict: 409,
  /**
   * A delegated revision would leave a joined deferral longer than seven days
   * that its source did not already have. Beyond that bound the revision is
   * the operator's (class R3 until the owner answers the plan's question 1).
   */
  maintenance_deferral_too_long: 422,
  /** The delegated principal's rolling daily write budget is spent. */
  maintenance_write_budget_exceeded: 429,
} as const;
export type MaintenanceWriteCode = keyof typeof MAINTENANCE_WRITE_CODES;

/** The actors a revision may name: the operator, or a principal the owner delegated. */
export type MaintenanceActor =
  /** A subject the App graded as the operator; never an `mcp-client:` name. */
  | { kind: "operator"; id: string }
  /** `mcp-client:<sub>` resolved under MCP_DELEGATIONS (ADR 0063). */
  | { kind: "delegated"; id: string };

/** One requested revision. Values are validated, never trusted, whoever calls. */
export interface MaintenanceWrite {
  /** A source id of `config/alarm-jobs.json`. */
  source: string;
  /**
   * The rule to revise, or `null` to create one under an id the writer
   * chooses. An operator may also create under its own id (expected 0); a
   * delegated principal may only name an existing rule of `source`.
   */
  ruleId: string | null;
  /** The revision the change was made against; 0 for a new rule. */
  expectedRevision: number;
  change: {
    timezone: string;
    pattern: MaintenancePattern;
    enabled: boolean;
    scope: MaintenanceRule["scope"];
  };
  provenance: {
    /** The announcement page; https on the source's registered host. Never fetched. */
    referenceUrl: string;
    /** When the announcement was checked; an ISO instant, not in the future. */
    verifiedAt: string;
    /** The re-survey proposal behind the change (`maintenance-survey:proposal:<id>`), or none. */
    decisionRef?: string | null;
  };
  actor: MaintenanceActor;
  /** Why, as a closed code; never free text. */
  reason: MaintenanceChangeReason;
}
export type MaintenanceWriteResult =
  | {
      ok: true;
      ruleId: string;
      revision: number;
      /** False when a reservation RPC failed: the revision stands, the alarm is pending. */
      reconciled: boolean;
    }
  | { ok: false; code: MaintenanceWriteCode; status: number };

/** Delegated revisions one principal may write per rolling day (ADR 0046, ADR 0063 item 8). */
export const DELEGATED_MAINTENANCE_WRITES_PER_DAY = 30;
/**
 * Longest joined deferral a delegated revision may create: the direct (R1)
 * envelope of ADR 0063 item 8. A longer one is refused; its target class is
 * R2 up to a 31-day ceiling, which needs the owner's answer to the plan's
 * question 1 and a confirmation step, so it is not built here.
 */
export const DELEGATED_MAX_DEFERRAL_MS = 7 * 86_400_000;
/** Recurring windows are checked over this horizon; dated windows at any date. */
const DEFERRAL_HORIZON_MS = 92 * 86_400_000;
const RULE_ID = /^[a-z0-9-]{1,100}$/u;
const OPERATOR_ACTOR = /^[A-Za-z0-9._:@-]{1,200}$/u;
const MCP_CLIENT_PREFIX = "mcp-client:";
const SURVEY_DECISION_REF = /^maintenance-survey:proposal:[1-9][0-9]{0,15}$/u;
const SURVEY_REASON: MaintenanceChangeReason = "maintenance-survey-proposal-accepted";
/**
 * The delegated revisions of one principal since an instant. It reads the
 * partial index `maintenance_agent_writes` (CORE 0076); the writer runs it
 * before writing and again inside its INSERT, so two concurrent writes cannot
 * both pass a spent budget.
 */
export const DELEGATED_WRITES_SINCE_SQL =
  "SELECT count(*) FROM provider_maintenance_rules WHERE actor_kind='delegated' AND actor=? AND created_at>?";

interface MaintenanceInput {
  id: string;
  revision: number;
  source: string;
  timezone: string;
  pattern: MaintenancePattern;
  enabled: boolean;
  referenceUrl: string;
  verifiedAt: string;
  scope: MaintenanceRule["scope"];
}
/** The field validation every revision passes, whoever writes it. */
async function validMaintenanceInput(
  db: D1Database,
  v: Record<string, unknown>,
): Promise<MaintenanceInput> {
  if (
    typeof v.id !== "string" ||
    !RULE_ID.test(v.id) ||
    typeof v.source !== "string" ||
    !jobs.some((j) => j.source === v.source) ||
    typeof v.timezone !== "string" ||
    !(ZONES as readonly string[]).includes(v.timezone) ||
    !validMaintenance(v.pattern) ||
    typeof v.enabled !== "boolean" ||
    !Number.isInteger(v.revision) ||
    Number(v.revision) < 0 ||
    !["collection", "session", "feature-only"].includes(String(v.scope)) ||
    typeof v.referenceUrl !== "string" ||
    typeof v.verifiedAt !== "string" ||
    !validInstant(v.verifiedAt) ||
    Date.parse(v.verifiedAt) > Date.now()
  )
    throw new ScheduleError("invalid_request");
  let url: URL;
  try {
    url = new URL(v.referenceUrl);
  } catch {
    throw new ScheduleError("invalid_reference");
  }
  const approved = await db
    .prepare("SELECT reference_url FROM provider_maintenance_references WHERE source=?")
    .bind(v.source)
    .first<{ reference_url: string }>();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !approved ||
    url.hostname !== new URL(approved.reference_url).hostname ||
    v.referenceUrl.length > 1500
  )
    throw new ScheduleError("invalid_reference");
  return {
    id: v.id,
    revision: Number(v.revision),
    source: v.source,
    timezone: v.timezone,
    pattern: v.pattern,
    enabled: v.enabled,
    referenceUrl: v.referenceUrl,
    verifiedAt: v.verifiedAt,
    scope: v.scope as MaintenanceRule["scope"],
  };
}
/** The instant a rolling day of delegated writes starts from. */
function budgetSince(now: number): string {
  return new Date(now - 86_400_000).toISOString();
}
async function delegatedWritesToday(db: D1Database, principal: string): Promise<number> {
  const row = await db
    .prepare(DELEGATED_WRITES_SINCE_SQL.replace("count(*)", "count(*) AS n"))
    .bind(principal, budgetSince(Date.now()))
    .first<{ n: number }>();
  return row?.n ?? 0;
}
/** The actor, refused unless its id has its kind's shape; an operator is never an MCP client. */
function validActor(value: unknown): MaintenanceActor {
  const actor: Record<string, unknown> = isPlainObject(value) ? value : {};
  const { kind, id } = actor;
  if (typeof id !== "string") throw new ScheduleError("invalid_request");
  if (kind === "operator" && OPERATOR_ACTOR.test(id) && !id.startsWith(MCP_CLIENT_PREFIX))
    return { kind, id };
  if (
    kind === "delegated" &&
    id.startsWith(MCP_CLIENT_PREFIX) &&
    id.length > MCP_CLIENT_PREFIX.length &&
    ACTOR_PATTERN.test(id)
  )
    return { kind, id };
  throw new ScheduleError("invalid_request");
}
/**
 * The reason and decision reference, refused unless both are closed values
 * this actor may give: `operator-edit` is the operator's own edit, and the
 * survey's acceptance reason comes with exactly its proposal reference.
 */
function validProvenance(
  actor: MaintenanceActor,
  reason: unknown,
  decisionRef: unknown,
): { reason: MaintenanceChangeReason; decisionRef: string | null } {
  if (
    typeof reason !== "string" ||
    !(MAINTENANCE_CHANGE_REASONS as readonly string[]).includes(reason) ||
    (reason === "operator-edit" && actor.kind !== "operator")
  )
    throw new ScheduleError("invalid_reason");
  const ref = decisionRef ?? null;
  if (ref !== null && (typeof ref !== "string" || !SURVEY_DECISION_REF.test(ref)))
    throw new ScheduleError("invalid_request");
  if ((reason === SURVEY_REASON) !== (ref !== null)) throw new ScheduleError("invalid_reason");
  return { reason: reason as MaintenanceChangeReason, decisionRef: ref };
}
function deferringRules(rules: readonly MaintenanceRule[]): MaintenanceRule[] {
  return rules.filter((rule) => rule.enabled && rule.scope !== "feature-only");
}
/**
 * Refuses a delegated revision that leaves a joined deferral longer than the
 * bound which the source's current rules do not already cause.
 */
function checkDelegatedDeferral(current: readonly MaintenanceRule[], candidate: MaintenanceRule) {
  // Measured from up to the bound before now, so a running union counts the
  // part already spent: a delegated principal cannot keep a window going by
  // extending it. A union that ended before now is at most the bound long, so
  // it never counts.
  const since = Date.now() - DELEGATED_MAX_DEFERRAL_MS,
    horizon = DELEGATED_MAX_DEFERRAL_MS + DEFERRAL_HORIZON_MS;
  const before = deferringRules(current),
    after = deferringRules([...current.filter((rule) => rule.id !== candidate.id), candidate]);
  try {
    if (
      longestDeferral(after, since, horizon, DELEGATED_MAX_DEFERRAL_MS) <= DELEGATED_MAX_DEFERRAL_MS
    )
      return;
  } catch {
    /* An unmeasurable chain is judged below. */
  }
  // A long union after the revision must lie within one the source already
  // had: a revision that leaves an operator's longer window as it was, or
  // shortens it, passes; one that creates, moves or lengthens a long union
  // anywhere — even while a longer one exists elsewhere — is refused. Unions
  // are followed to the horizon, so beyond it an unchanged chain compares
  // equal.
  const unions = (rules: MaintenanceRule[]) => {
    try {
      return deferralUnions(rules, since, horizon, horizon);
    } catch {
      return null;
    }
  };
  const existing = unions(before) ?? [],
    revised = unions(after);
  if (
    revised === null ||
    revised.some(
      (union) =>
        union.end - union.start > DELEGATED_MAX_DEFERRAL_MS &&
        !existing.some((known) => known.start <= union.start && union.end <= known.end),
    )
  )
    throw new ScheduleError("maintenance_deferral_too_long", 422);
}
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
async function writeRevision(
  env: Env,
  write: MaintenanceWrite,
  append: (saved: SavedRevision) => RevisionAppend,
): Promise<Extract<MaintenanceWriteResult, { ok: true }>> {
  const raw: unknown = write;
  const w: Record<string, unknown> = isPlainObject(raw) ? raw : {};
  const change: Record<string, unknown> = isPlainObject(w.change) ? w.change : {};
  const provenance: Record<string, unknown> = isPlainObject(w.provenance) ? w.provenance : {};
  const actor = validActor(w.actor);
  const delegated = actor.kind === "delegated";
  if (
    delegated &&
    (await delegatedWritesToday(env.DB, actor.id)) >= DELEGATED_MAINTENANCE_WRITES_PER_DAY
  )
    throw new ScheduleError("maintenance_write_budget_exceeded", 429);
  const { reason, decisionRef } = validProvenance(actor, w.reason, provenance.decisionRef);
  let id: unknown = w.ruleId;
  if (id === null) {
    // A new rule's id is chosen here, so a create cannot probe which ids
    // another source's rules use.
    if (w.expectedRevision !== 0 || typeof w.source !== "string" || !RULE_ID.test(w.source))
      throw new ScheduleError("invalid_request");
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    id = `${w.source}-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  }
  const input = await validMaintenanceInput(env.DB, {
    id,
    revision: w.expectedRevision,
    source: w.source,
    timezone: change.timezone,
    pattern: change.pattern,
    enabled: change.enabled,
    scope: change.scope,
    referenceUrl: provenance.referenceUrl,
    verifiedAt: provenance.verifiedAt,
  });
  const previous = await env.DB.prepare(
    "SELECT revision,source,timezone,pattern_json,enabled,reference_url,verified_at,scope FROM provider_maintenance_rules WHERE id=? ORDER BY revision DESC LIMIT 1",
  )
    .bind(input.id)
    .first<{
      revision: number;
      source: string;
      timezone: string;
      pattern_json: string;
      enabled: number;
      reference_url: string;
      verified_at: string;
      scope: string;
    }>();
  if (delegated && w.ruleId !== null && (!previous || previous.source !== input.source))
    // Another source's rule answers exactly like a rule that does not exist.
    throw new ScheduleError("maintenance_rule_not_found", 404);
  if (
    (previous?.revision ?? 0) !== input.revision ||
    (previous && previous.source !== input.source)
  )
    throw new ScheduleError("revision_conflict", 409);
  if (delegated)
    checkDelegatedDeferral(await maintenanceRules(env.DB, input.source), {
      ...input,
      revision: input.revision + 1,
    });
  const now = new Date().toISOString();
  const revision = input.revision + 1;
  const guard: SqlWrite = {
    sql: "EXISTS(SELECT 1 FROM provider_maintenance_rules WHERE id=? AND revision=? AND actor=? AND created_at=?)",
    binds: [input.id, revision, actor.id, now],
  };
  const after = {
    source: input.source,
    timezone: input.timezone,
    pattern: input.pattern,
    enabled: input.enabled,
    reference_url: input.referenceUrl,
    verified_at: input.verifiedAt,
    scope: input.scope,
  };
  // The version check and a delegated principal's budget are in the INSERT
  // itself, so two writers that read the same revision cannot both succeed.
  const statements = [
    env.DB.prepare(`INSERT OR IGNORE INTO provider_maintenance_rules(id,revision,source,timezone,pattern_json,enabled,reference_url,verified_at,scope,actor,created_at,actor_kind,change_reason,decision_ref)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE COALESCE((SELECT MAX(revision) FROM provider_maintenance_rules WHERE id=?),0)=?${
      delegated ? ` AND (${DELEGATED_WRITES_SINCE_SQL})<?` : ""
    }`).bind(
      input.id,
      revision,
      input.source,
      input.timezone,
      JSON.stringify(input.pattern),
      Number(input.enabled),
      input.referenceUrl,
      input.verifiedAt,
      input.scope,
      actor.id,
      now,
      actor.kind,
      reason,
      decisionRef,
      input.id,
      input.revision,
      ...(delegated
        ? [actor.id, budgetSince(Date.parse(now)), DELEGATED_MAINTENANCE_WRITES_PER_DAY]
        : []),
    ),
    // The provenance confirmation is guarded on the row the insert wrote, so
    // the two are one effect.
    env.DB.prepare(
      `UPDATE provider_maintenance_references SET status='confirmed',reference_url=?,verified_at=? WHERE source=? AND ${guard.sql}`,
    ).bind(input.referenceUrl, input.verifiedAt, input.source, ...guard.binds),
  ];
  const appended = append({
    ruleId: input.id,
    revision,
    previous: input.revision,
    fields: changedFields(
      previous
        ? {
            source: previous.source,
            timezone: previous.timezone,
            pattern: JSON.parse(previous.pattern_json) as unknown,
            enabled: previous.enabled === 1,
            reference_url: previous.reference_url,
            verified_at: previous.verified_at,
            scope: previous.scope,
          }
        : null,
      after,
    ),
    payloadDigest: await canonicalDigest({ id: input.id, revision: input.revision, ...after }),
    reason,
    guard,
  });
  const results = await env.DB.batch([...statements, ...appended.statements]);
  if (results[0]?.meta.changes !== 1) {
    if (
      delegated &&
      (await delegatedWritesToday(env.DB, actor.id)) >= DELEGATED_MAINTENANCE_WRITES_PER_DAY
    )
      throw new ScheduleError("maintenance_write_budget_exceeded", 429);
    throw new ScheduleError("revision_conflict", 409);
  }
  appended.settle(results.slice(statements.length));
  const pending = await reconcileSource(env, input.source);
  return { ok: true, ruleId: input.id, revision, reconciled: pending === 0 };
}
/**
 * Append one maintenance-rule revision, then reconcile the source's
 * reservations. Validates fields, the registered reference host, the expected
 * revision, the actor and its closed reason and, for a delegated principal,
 * the rule's source, the deferral bound and the daily budget. Sends the
 * revision, its provenance and what `append` returns as one batch. Never
 * edits a job, enables or disables one, releases a lease or starts
 * collection. A refusal is a closed code; an unexpected storage failure (a
 * batch that raised) still throws, and then nothing of the batch was written.
 */
export async function writeMaintenanceRevision(
  env: Env,
  write: MaintenanceWrite,
  append: (saved: SavedRevision) => RevisionAppend,
): Promise<MaintenanceWriteResult> {
  try {
    return await writeRevision(env, write, append);
  } catch (error) {
    if (error instanceof ScheduleError && Object.hasOwn(MAINTENANCE_WRITE_CODES, error.code)) {
      const code = error.code as MaintenanceWriteCode;
      return { ok: false, code, status: MAINTENANCE_WRITE_CODES[code] };
    }
    throw error;
  }
}
/** Re-arms the source's reservations after a saved revision; answers how many are pending. */
async function reconcileSource(env: Env, source: string): Promise<number> {
  let pending = 0;
  for (const job of jobs.filter((j) => j.source === source)) {
    try {
      await env.SCHEDULE_ALARMS.getByName(job.id).reconcile(job.id);
    } catch {
      pending++;
    }
  }
  return pending;
}
/** The reason the operator page's edit records: the page asks for none. */
const OPERATOR_EDIT: MaintenanceChangeReason = "operator-edit";
/**
 * The operator's maintenance edit: the revision, its provenance and its
 * `applied` audit record (ADR 0064) are one batch. Alarm reconciliation stays
 * outside it, as before. Its body, codes and answer are unchanged; the
 * revision records `operator-edit` as its reason.
 */
export async function updateMaintenance(
  env: Env,
  value: unknown,
  actor: string,
  audit: OperationCall,
) {
  const v = bodyObject(value);
  exactKeys(v, [
    "id",
    "revision",
    "source",
    "timezone",
    "pattern",
    "enabled",
    "referenceUrl",
    "verifiedAt",
    "scope",
  ]);
  // The operator names its own rule id; a missing one is invalid, not a create.
  if (typeof v.id !== "string") throw new ScheduleError("invalid_request");
  const result = await writeMaintenanceRevision(
    env,
    {
      source: v.source as string,
      ruleId: v.id,
      expectedRevision: v.revision as number,
      change: {
        timezone: v.timezone as string,
        pattern: v.pattern as MaintenancePattern,
        enabled: v.enabled as boolean,
        scope: v.scope as MaintenanceRule["scope"],
      },
      provenance: {
        referenceUrl: v.referenceUrl as string,
        verifiedAt: v.verifiedAt as string,
      },
      actor: { kind: "operator", id: actor },
      reason: OPERATOR_EDIT,
    },
    (revision) => {
      const ref = `maintenance-rule:${revision.ruleId}@${revision.revision}`;
      const record = audit.effect(
        {
          targetRef: `maintenance-rule:${revision.ruleId}`,
          refs: [ref],
          scope: { namespace: "schedule-source", source: v.source as string },
          reasonCode: revision.reason,
          payloadDigest: revision.payloadDigest,
          diff: {
            kind: "revision",
            from: revision.previous,
            to: revision.revision,
            fields: revision.fields,
          },
        },
        revision.guard,
        { kind: "target-ref", ref },
      );
      return {
        statements: [statement(env.DB, record)],
        settle: (results) => audit.settle(results[0]?.meta.changes),
      };
    },
  );
  if (!result.ok) throw new ScheduleError(result.code, result.status);
  return {
    saved: true,
    revision: result.revision,
    reservation: result.reconciled ? "armed" : "pending",
  };
}
interface RevisionRow {
  id: string;
  revision: number;
  source: string;
  timezone: string;
  pattern_json: string;
  enabled: number;
  reference_url: string;
  verified_at: string;
  scope: MaintenanceRule["scope"];
  actor: string;
  actor_kind: "operator" | "delegated" | null;
  change_reason: string | null;
  created_at: string;
}
/** Revisions shown per rule, newest first. */
const AGENT_REVISION_HISTORY = 20;
interface AgentScheduleView {
  id: string;
  source: string | null;
  kind: ScheduleView["kind"];
  enabled: boolean;
  supported: boolean;
  timezone: string;
  pattern: SchedulePattern;
  revision: number;
  /** The original next occurrence, before maintenance. */
  nextNominalAt: string | null;
  /** The maintenance-adjusted due time last saved. */
  nextRunAt: string | null;
  actualAlarmAt: string | null;
  reservation: ScheduleView["reservation"];
  latest: {
    nominalAt: string;
    startedAt: string;
    finishedAt: string | null;
    status: ScheduleOccurrence["status"];
    failureCode: string | null;
  } | null;
}
/**
 * The maintenance settings of exactly these sources, for an agent. Only the
 * named sources are queried, so nothing of another source crosses the
 * binding. No revision's actor is returned, only its kind and whether it was
 * the caller; receipts carry their outcome but not run or evidence ids.
 */
async function agentSourceViews(env: Env, sources: readonly string[], agent: string) {
  const list = JSON.stringify(sources);
  const [scheduleRows, referenceRows, revisionRows, latestRows] = await env.DB.batch<unknown>([
    env.DB.prepare(
      "SELECT * FROM collection_schedules WHERE source IN (SELECT value FROM json_each(?)) ORDER BY id",
    ).bind(list),
    env.DB.prepare(
      "SELECT * FROM provider_maintenance_references WHERE source IN (SELECT value FROM json_each(?))",
    ).bind(list),
    env.DB.prepare(
      "SELECT id,revision,source,timezone,pattern_json,enabled,reference_url,verified_at,scope,actor,actor_kind,change_reason,created_at FROM provider_maintenance_rules WHERE source IN (SELECT value FROM json_each(?)) ORDER BY source,id,revision DESC",
    ).bind(list),
    env.DB.prepare(
      "SELECT o.* FROM collection_schedules s JOIN collection_schedule_occurrences o ON o.id=(SELECT n.id FROM collection_schedule_occurrences n WHERE n.schedule_id=s.id ORDER BY n.nominal_at DESC LIMIT 1) WHERE s.source IN (SELECT value FROM json_each(?))",
    ).bind(list),
  ]);
  const schedules = (scheduleRows?.results ?? []) as ScheduleRow[];
  const references = (referenceRows?.results ?? []) as {
    source: string;
    status: ScheduleView["maintenance"]["status"];
    reference_url: string;
    verified_at: string;
  }[];
  const revisions = (revisionRows?.results ?? []) as RevisionRow[];
  const latest = (latestRows?.results ?? []) as OccurrenceRow[];
  const scheduleViews: AgentScheduleView[] = [];
  for (const row of schedules) {
    let actualAlarmAt: string | null = null;
    try {
      actualAlarmAt = await env.SCHEDULE_ALARMS.getByName(row.id).alarmTime();
    } catch {
      /* A missing reservation remains visible. */
    }
    const receipt = latest.find((o) => o.schedule_id === row.id);
    scheduleViews.push({
      id: row.id,
      source: row.source,
      kind: row.kind,
      enabled: row.enabled === 1,
      supported: row.supported === 1,
      timezone: row.timezone,
      pattern: JSON.parse(row.pattern_json) as SchedulePattern,
      revision: row.revision,
      nextNominalAt: row.next_nominal_at,
      nextRunAt: row.next_run_at,
      actualAlarmAt,
      reservation: reservationOf(row, actualAlarmAt),
      latest: receipt
        ? {
            nominalAt: receipt.nominal_at,
            startedAt: receipt.started_at,
            finishedAt: receipt.finished_at,
            status: receipt.status,
            failureCode: receipt.failure_code,
          }
        : null,
    });
  }
  return sources.map((source) => {
    const ref = references.find((r) => r.source === source);
    const rules = new Map<string, ReturnType<typeof revisionView>[]>();
    for (const row of revisions.filter((r) => r.source === source)) {
      const list = rules.get(row.id) ?? [];
      if (list.length < AGENT_REVISION_HISTORY) list.push(revisionView(row, agent));
      rules.set(row.id, list);
    }
    return {
      source,
      reference: ref
        ? { status: ref.status, referenceUrl: ref.reference_url, verifiedAt: ref.verified_at }
        : null,
      schedules: scheduleViews.filter((view) => view.source === source),
      rules: [...rules].map(([id, list]) => ({ id, revisions: list })),
    };
  });
}
function revisionView(row: RevisionRow, agent: string) {
  return {
    revision: row.revision,
    timezone: row.timezone,
    pattern: JSON.parse(row.pattern_json) as MaintenancePattern,
    enabled: row.enabled === 1,
    scope: row.scope,
    referenceUrl: row.reference_url,
    verifiedAt: row.verified_at,
    createdAt: row.created_at,
    /** `null` for revisions written before CORE 0076 recorded it. */
    actorKind: row.actor_kind,
    /** A closed code (`MAINTENANCE_CHANGE_REASONS`), or `null` before CORE 0076. */
    changeReason: row.change_reason,
    /** Whether the reading principal wrote it as a delegated principal. */
    byCaller: row.actor_kind === "delegated" && row.actor === agent,
  };
}
/** Maintenance settings of the requested sources the jobs configuration declares. */
async function agentMaintenanceRead(env: Env, value: unknown, agent: string) {
  const v = bodyObject(value);
  exactKeys(v, ["sources"]);
  const declared = [
    ...new Set(jobs.map((job) => job.source).filter((s): s is string => typeof s === "string")),
  ].sort();
  let sources: string[];
  if (v.sources === "*") sources = declared;
  else if (
    Array.isArray(v.sources) &&
    v.sources.length <= 64 &&
    v.sources.every((s) => typeof s === "string" && /^[a-z0-9-]{1,100}$/u.test(s))
  ) {
    const requested = v.sources as string[];
    sources = declared.filter((source) => requested.includes(source));
  } else throw new ScheduleError("invalid_request");
  return {
    sources: await agentSourceViews(env, sources, agent),
    // The writer's limits on a delegated principal's revisions, and how many
    // the reading principal wrote today (none unless it was delegated).
    limits: {
      maxDeferralHours: DELEGATED_MAX_DEFERRAL_MS / 3_600_000,
      writesPerDay: DELEGATED_MAINTENANCE_WRITES_PER_DAY,
      writesUsedToday: await delegatedWritesToday(env.DB, agent),
    },
  };
}
function reservationOf(
  row: Pick<ScheduleRow, "enabled" | "next_run_at">,
  actualAlarmAt: string | null,
): ScheduleView["reservation"] {
  return row.enabled === 0
    ? actualAlarmAt === null
      ? "disabled"
      : "pending"
    : actualAlarmAt === row.next_run_at && actualAlarmAt !== null
      ? "armed"
      : "pending";
}
interface OccurrenceRow {
  id: string;
  schedule_id: string;
  nominal_at: string;
  started_at: string;
  finished_at: string | null;
  status: ScheduleOccurrence["status"];
  run_ids_json: string;
  failure_code: string | null;
}
async function occurrenceViews(
  db: D1Database,
  rows: readonly OccurrenceRow[],
): Promise<ScheduleOccurrence[]> {
  const out: ScheduleOccurrence[] = [];
  for (const r of rows) {
    const runIds = JSON.parse(r.run_ids_json) as string[],
      source = jobFor(r.schedule_id).source;
    // One query for all exact run references, including Vpass's per-card runs.
    const found =
      runIds.length === 0
        ? []
        : (
            await db
              .prepare(
                "SELECT run_id,fetch_run_id FROM collection_runs WHERE source=? AND run_id IN (SELECT value FROM json_each(?)) AND fetch_run_id IS NOT NULL ORDER BY id DESC",
              )
              .bind(source, JSON.stringify(runIds))
              .all<{ run_id: string; fetch_run_id: number }>()
          ).results;
    const runLinks = runIds.map((runId) => {
      const link = found.find((row) => row.run_id === runId);
      return { runId, evidenceId: link ? `r_${link.fetch_run_id}` : null };
    });
    out.push({
      id: r.id,
      scheduleId: r.schedule_id,
      nominalAt: r.nominal_at,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      status: r.status,
      runIds,
      runLinks,
      failureCode: r.failure_code,
    });
  }
  return out;
}
/**
 * Clears a stopped execution's lease. Its `applied` audit record (ADR 0064) is
 * in the same batch, joined to the unlocked lease row, and is the only durable
 * trace of a release: the lease row itself is mutable.
 */
export async function releaseCollectionLease(
  env: Env,
  source: string,
  value: unknown,
  audit: OperationCall,
): Promise<{ released: true }> {
  if (!jobs.some((job) => job.source === source))
    throw new ScheduleError("schedule_not_found", 404);
  const v = bodyObject(value);
  exactKeys(v, ["leaseRef", "confirmedStopped"]);
  if (
    typeof v.leaseRef !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(v.leaseRef) ||
    v.confirmedStopped !== true
  )
    throw new ScheduleError("confirmation_required");
  const record = audit.effect(
    {
      targetRef: `collection-lease:${source}`,
      scope: { namespace: "schedule-source", source },
      diff: { kind: "release", released: true },
    },
    {
      sql: "EXISTS(SELECT 1 FROM collection_execution_leases WHERE source=? AND lease_ref IS NULL)",
      binds: [source],
    },
    // A repeated release while the source is unlocked releases again, and is
    // recorded again.
    { kind: "each" },
  );
  const [released, recorded] = await env.DB.batch([
    env.DB.prepare(
      // A repeated release is already satisfied while the source is unlocked.
      // Check this in the same statement as the write: a newly acquired lease
      // must never be cleared by a delayed retry of the previous reference.
      "UPDATE collection_execution_leases SET lease_ref=NULL,started_at=NULL WHERE source=? AND (lease_ref=? OR lease_ref IS NULL)",
    ).bind(source, v.leaseRef),
    statement(env.DB, record),
  ]);
  if (released?.meta.changes !== 1) throw new ScheduleError("lease_conflict", 409);
  audit.settle(recorded?.meta.changes);
  return { released: true };
}
export async function scheduleSnapshot(env: Env): Promise<ScheduleSnapshot> {
  const rows = await env.DB.prepare(
    "SELECT * FROM collection_schedules ORDER BY id",
  ).all<ScheduleRow>();
  const references = await env.DB.prepare("SELECT * FROM provider_maintenance_references").all<{
    source: string;
    status: ScheduleView["maintenance"]["status"];
    reference_url: string;
    verified_at: string;
  }>();
  const recent = await env.DB.prepare(
    "SELECT * FROM collection_schedule_occurrences ORDER BY started_at DESC LIMIT 100",
  ).all<OccurrenceRow>();
  // Preserve recent collection history even when processor/keepalive receipts
  // dominate the global feed. Each per-job input is bounded by its unique index.
  const daily = rows.results.filter((row) => row.kind === "collection");
  const dailyResults =
    daily.length === 0
      ? []
      : await env.DB.batch<OccurrenceRow>(
          daily.map((row) =>
            env.DB.prepare(
              "SELECT * FROM collection_schedule_occurrences WHERE schedule_id=? ORDER BY nominal_at DESC LIMIT 100",
            ).bind(row.id),
          ),
        );
  const dailyRows = dailyResults
    .flatMap((result) => result.results)
    .sort((a, b) => b.started_at.localeCompare(a.started_at))
    .slice(0, 100);
  const receiptRows = [
    ...new Map([...recent.results, ...dailyRows].map((row) => [row.id, row])).values(),
  ].sort((a, b) => b.started_at.localeCompare(a.started_at));
  const occurrences = await occurrenceViews(env.DB, receiptRows),
    maintenance = await maintenanceRules(env.DB);
  const latestRows = await env.DB.prepare(
    "SELECT o.* FROM collection_schedules s JOIN collection_schedule_occurrences o ON o.id=(SELECT n.id FROM collection_schedule_occurrences n WHERE n.schedule_id=s.id ORDER BY n.nominal_at DESC LIMIT 1)",
  ).all<OccurrenceRow>();
  const latest = await occurrenceViews(env.DB, latestRows.results);
  const activeLeases = await env.DB.prepare(
    "SELECT source,lease_ref,started_at FROM collection_execution_leases WHERE lease_ref IS NOT NULL ORDER BY source",
  ).all<{ source: string; lease_ref: string; started_at: string }>();
  const leases = activeLeases.results.map((row) => ({
    source: row.source,
    leaseRef: row.lease_ref,
    startedAt: row.started_at,
  }));
  const schedules: ScheduleView[] = [];
  for (const row of rows.results) {
    const ref = references.results.find((r) => r.source === row.source);
    let actualAlarmAt: string | null = null;
    try {
      actualAlarmAt = await env.SCHEDULE_ALARMS.getByName(row.id).alarmTime();
    } catch {
      /* A missing reservation remains visible. */
    }
    schedules.push({
      id: row.id,
      source: row.source,
      kind: row.kind,
      enabled: row.enabled === 1,
      supported: row.supported === 1,
      timezone: row.timezone,
      pattern: JSON.parse(row.pattern_json) as SchedulePattern,
      revision: row.revision,
      nextNominalAt: row.next_nominal_at,
      nextRunAt: row.next_run_at,
      actualAlarmAt,
      reservation: reservationOf(row, actualAlarmAt),
      maintenance: {
        status: ref?.status ?? "no-applicable-rule",
        referenceUrl: ref?.reference_url ?? "",
        verifiedAt: ref?.verified_at ?? "",
      },
      latest: latest.find((o) => o.scheduleId === row.id) ?? null,
    });
  }
  // The re-survey's freshness and proposals (ADR 0050); a read failure hides
  // only that part of the page.
  const survey = await maintenanceSurveyView(env, Date.now()).catch(() => undefined);
  return { schedules, maintenance, occurrences, leases, ...(survey ? { survey } : {}) };
}
/** Marks an answer whose batch wrote the effect's audit record; the App records everything else. */
function recorded(response: Response, audit: OperationCall): Response {
  if (audit.recorded) response.headers.set(AUDIT_RECORDED_HEADER, "1");
  return response;
}
/**
 * The agent path (ADR 0046): read the granted sources' maintenance settings.
 * The App has graded the reader's `schedules.read` grant and its schedule
 * scope; the reading principal arrives in its own header, never as an
 * operator, and no other settings function — no write of any kind — is
 * reachable from here. A delegated maintenance write has no route until ADR
 * 0063's delegated execution is connected (plan slice S3).
 */
async function agentRoute(request: Request, env: Env, path: string): Promise<unknown> {
  if (request.headers.has("x-kogane-operator") || request.headers.has(AUDIT_HEADERS.delegationRef))
    throw new ScheduleError("invalid_request");
  const agent = request.headers.get("x-kogane-agent");
  if (!agent || !ACTOR_PATTERN.test(agent)) throw new ScheduleError("agent_required", 403);
  if (path !== "/agent/read") throw new ScheduleError("not_found", 404);
  const text = await request.text();
  if (text.length > 16 * 1024) throw new ScheduleError("request_too_large", 413);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ScheduleError("invalid_request");
  }
  return agentMaintenanceRead(env, value, agent);
}
export async function scheduleRoute(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/internal/schedules")) return null;
  if (
    request.headers.has("cf-connecting-ip") ||
    request.headers.get("x-kogane-internal-caller") !== "kogane-evidence-browser" ||
    env.SCHEDULES_ENABLED !== "true"
  )
    return Response.json({ error: "service_binding_required" }, { status: 403 });
  try {
    if (url.search) throw new ScheduleError("invalid_query");
    const path = url.pathname.slice("/internal/schedules".length);
    if (request.method === "GET" && path === "") return Response.json(await scheduleSnapshot(env));
    if (request.method !== "POST") throw new ScheduleError("method_not_allowed", 405);
    if (path === "/bootstrap") return Response.json(await bootstrapSchedules(env));
    if (path.startsWith("/agent/")) return Response.json(await agentRoute(request, env, path));
    // An operator write never also claims an agent identity.
    if (request.headers.has("x-kogane-agent")) throw new ScheduleError("operator_required", 403);
    const actor = request.headers.get("x-kogane-operator");
    if (!actor || !OPERATOR_ACTOR.test(actor)) throw new ScheduleError("operator_required", 403);
    // The audit envelope (ADR 0064) travels with the operator header and is
    // refused the same way when it is missing.
    const envelope = parseAuditEnvelope(request.headers);
    if (!envelope) throw new ScheduleError("operator_required", 403);
    const call = (operation: OperationName) => processorCall(envelope, operation, actor, "human");
    const text = await request.text();
    if (text.length > 16 * 1024) throw new ScheduleError("request_too_large", 413);
    const value: unknown = JSON.parse(text);
    if (path === "/maintenance") {
      const audit = call("schedules.maintenance.update");
      return recorded(Response.json(await updateMaintenance(env, value, actor, audit)), audit);
    }
    const leaseMatch = /^\/leases\/([a-z0-9-]{1,100})$/u.exec(path);
    if (leaseMatch) {
      const audit = call("schedules.lease.release");
      return recorded(
        Response.json(await releaseCollectionLease(env, leaseMatch[1]!, value, audit)),
        audit,
      );
    }
    const proposalMatch = /^\/proposals\/([1-9][0-9]{0,15})$/u.exec(path);
    if (proposalMatch) {
      const audit = call("schedules.survey.decide");
      return recorded(
        await decideSurveyProposal(
          env,
          Number(proposalMatch[1]),
          value,
          actor,
          writeMaintenanceRevision,
          audit,
        ),
        audit,
      );
    }
    const match = /^\/([a-z0-9-]{1,100})$/u.exec(path);
    if (match) {
      const audit = call("schedules.job.update");
      return recorded(
        Response.json(await updateSchedule(env, match[1]!, value, actor, audit)),
        audit,
      );
    }
    throw new ScheduleError("not_found", 404);
  } catch (error) {
    return Response.json(
      { error: error instanceof ScheduleError ? error.code : "scheduling_unavailable" },
      { status: error instanceof ScheduleError ? error.status : 503 },
    );
  }
}
