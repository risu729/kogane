import jobs from "../../../config/alarm-jobs.json";
import {
  afterMaintenance,
  nextNominal,
  validPattern,
  validMaintenance,
  validInstant,
  ZONES,
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
  type RevisionResult,
  type RevisionWrite,
  type SavedRevision,
} from "./maintenance-survey/decisions.ts";
import {
  AUDIT_RECORDED_HEADER,
  changedFields,
  type OperationCall,
  type OperationName,
  parseAuditEnvelope,
  processorCall,
  type RevisionField,
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
/** One validated maintenance revision, as statements not yet sent. */
interface PreparedMaintenance {
  /** The version-checked revision insert, then the provenance update guarded on that row. */
  statements: D1PreparedStatement[];
  id: string;
  source: string;
  previous: number;
  revision: number;
  fields: RevisionField[];
  payloadDigest: string;
  /** True exactly when the batch wrote this revision row. */
  guard: SqlWrite;
}
/**
 * Validates one maintenance revision and builds its statements: the
 * version-checked insert and the reference confirmation, which is guarded on
 * the row the insert wrote so the two are one effect. The caller sends them in
 * one batch with whatever it appends (its audit record, a survey decision).
 */
async function prepareMaintenanceRevision(
  env: Env,
  value: unknown,
  actor: string,
): Promise<PreparedMaintenance> {
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
  if (
    typeof v.id !== "string" ||
    !/^[a-z0-9-]{1,100}$/u.test(v.id) ||
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
  const url = new URL(v.referenceUrl);
  const approved = await env.DB.prepare(
    "SELECT reference_url FROM provider_maintenance_references WHERE source=?",
  )
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
  const previous = await env.DB.prepare(
    "SELECT revision,source,timezone,pattern_json,enabled,reference_url,verified_at,scope FROM provider_maintenance_rules WHERE id=? ORDER BY revision DESC LIMIT 1",
  )
    .bind(v.id)
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
  if ((previous?.revision ?? 0) !== v.revision || (previous && previous.source !== v.source))
    throw new ScheduleError("revision_conflict", 409);
  const now = new Date().toISOString();
  const revision = Number(v.revision) + 1;
  const guard: SqlWrite = {
    sql: "EXISTS(SELECT 1 FROM provider_maintenance_rules WHERE id=? AND revision=? AND actor=? AND created_at=?)",
    binds: [v.id, revision, actor, now],
  };
  const after = {
    source: v.source,
    timezone: v.timezone,
    pattern: v.pattern,
    enabled: v.enabled,
    reference_url: v.referenceUrl,
    verified_at: v.verifiedAt,
    scope: v.scope,
  };
  return {
    statements: [
      env.DB.prepare(`INSERT OR IGNORE INTO provider_maintenance_rules(id,revision,source,timezone,pattern_json,enabled,reference_url,verified_at,scope,actor,created_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE COALESCE((SELECT MAX(revision) FROM provider_maintenance_rules WHERE id=?),0)=?`).bind(
        v.id,
        revision,
        v.source,
        v.timezone,
        JSON.stringify(v.pattern),
        Number(v.enabled),
        v.referenceUrl,
        v.verifiedAt,
        v.scope,
        actor,
        now,
        v.id,
        v.revision,
      ),
      env.DB.prepare(
        `UPDATE provider_maintenance_references SET status='confirmed',reference_url=?,verified_at=? WHERE source=? AND ${guard.sql}`,
      ).bind(v.referenceUrl, v.verifiedAt, v.source, ...guard.binds),
    ],
    id: v.id,
    source: v.source,
    previous: Number(v.revision),
    revision,
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
    payloadDigest: await canonicalDigest({ id: v.id, revision: v.revision, ...after }),
    guard,
  };
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
/**
 * The operator's maintenance edit: the revision, its provenance and its
 * `applied` audit record (ADR 0064) are one batch. Alarm reconciliation stays
 * outside it, as before.
 */
export async function updateMaintenance(
  env: Env,
  value: unknown,
  actor: string,
  audit: OperationCall,
) {
  const prepared = await prepareMaintenanceRevision(env, value, actor);
  const ref = `maintenance-rule:${prepared.id}@${prepared.revision}`;
  const record = audit.effect(
    {
      targetRef: `maintenance-rule:${prepared.id}`,
      refs: [ref],
      scope: { namespace: "schedule-source", source: prepared.source },
      payloadDigest: prepared.payloadDigest,
      diff: {
        kind: "revision",
        from: prepared.previous,
        to: prepared.revision,
        fields: prepared.fields,
      },
    },
    prepared.guard,
    { kind: "target-ref", ref },
  );
  const results = await env.DB.batch([...prepared.statements, statement(env.DB, record)]);
  if (results[0]?.meta.changes !== 1) throw new ScheduleError("revision_conflict", 409);
  audit.settle(results[prepared.statements.length]?.meta.changes);
  const pending = await reconcileSource(env, prepared.source);
  return {
    saved: true,
    revision: prepared.revision,
    reservation: pending ? "pending" : "armed",
  };
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
      reservation:
        row.enabled === 0
          ? actualAlarmAt === null
            ? "disabled"
            : "pending"
          : actualAlarmAt === row.next_run_at && actualAlarmAt !== null
            ? "armed"
            : "pending",
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
    if (path === "/bootstrap") {
      // This closed refusal is exclusively prewrite, after binding auth. Capture
      // the serving Processor identity before any reservation/bookkeeping write.
      const releaseSha = env.RELEASE_SHA;
      const expectedSha = request.headers.get("x-kogane-release-sha");
      if (
        typeof releaseSha !== "string" ||
        !/^[0-9a-f]{40}$/u.test(releaseSha) ||
        expectedSha === null ||
        !/^[0-9a-f]{40}$/u.test(expectedSha)
      )
        throw new ScheduleError("scheduling_unavailable", 503);
      if (expectedSha !== releaseSha) throw new ScheduleError("release_mismatch", 503);
      return Response.json({ ...(await bootstrapSchedules(env)), releaseSha });
    }
    const actor = request.headers.get("x-kogane-operator");
    if (!actor || !/^[A-Za-z0-9._:@-]{1,200}$/u.test(actor))
      throw new ScheduleError("operator_required", 403);
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
          surveyRevisionWriter,
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
/**
 * The writer an accepted maintenance-survey proposal goes through (ADR 0050):
 * the operator route's own version-checked revision, so a proposal is adopted
 * exactly as an operator's edit is. What the decision appends (its decision
 * row and its audit record) is sent in the revision's own batch, so the
 * revision, the decision and the record exist together or not at all (ADR
 * 0064). #560's `writeMaintenanceRevision` takes this write as it is; when it
 * merges it replaces this adapter, and the revision then also carries the
 * proposal as its decision reference.
 */
async function surveyRevisionWriter(
  env: Env,
  write: RevisionWrite,
  append: (saved: SavedRevision) => RevisionAppend,
): Promise<RevisionResult> {
  let prepared: PreparedMaintenance;
  try {
    prepared = await prepareMaintenanceRevision(
      env,
      {
        id: write.ruleId,
        revision: write.expectedRevision,
        source: write.source,
        timezone: write.change.timezone,
        pattern: write.change.pattern,
        enabled: write.change.enabled,
        scope: write.change.scope,
        referenceUrl: write.provenance.referenceUrl,
        verifiedAt: write.provenance.verifiedAt,
      },
      write.actor.id,
    );
  } catch (error) {
    if (error instanceof ScheduleError)
      return { ok: false, code: error.code, status: error.status };
    throw error;
  }
  const appended = append({
    ruleId: prepared.id,
    revision: prepared.revision,
    previous: prepared.previous,
    fields: prepared.fields,
    guard: prepared.guard,
  });
  const results = await env.DB.batch([...prepared.statements, ...appended.statements]);
  if (results[0]?.meta.changes !== 1) return { ok: false, code: "revision_conflict", status: 409 };
  appended.settle(results.slice(prepared.statements.length));
  const pending = await reconcileSource(env, prepared.source);
  return {
    ok: true,
    ruleId: prepared.id,
    revision: prepared.revision,
    reconciled: pending === 0,
  };
}
