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
export async function updateSchedule(env: Env, id: string, value: unknown, actor: string) {
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
    pattern = JSON.stringify(v.pattern);
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
    ).bind(id, row.revision + 1, actor, now),
  ]);
  if (result[0]?.meta.changes !== 1) throw new ScheduleError("revision_conflict", 409);
  let actualAlarmAt: string | null = null,
    reservation = "pending";
  try {
    actualAlarmAt = await env.SCHEDULE_ALARMS.getByName(id).reconcile(id);
    reservation = v.enabled ? "armed" : "disabled";
  } catch {
    /* Persisted config is reported separately from arming. */
  }
  return { saved: true, reservation, actualAlarmAt, revision: row.revision + 1 };
}
export async function updateMaintenance(env: Env, value: unknown, actor: string) {
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
    "SELECT revision,source FROM provider_maintenance_rules WHERE id=? ORDER BY revision DESC LIMIT 1",
  )
    .bind(v.id)
    .first<{ revision: number; source: string }>();
  if ((previous?.revision ?? 0) !== v.revision || (previous && previous.source !== v.source))
    throw new ScheduleError("revision_conflict", 409);
  const now = new Date().toISOString();
  const inserted =
    await env.DB.prepare(`INSERT OR IGNORE INTO provider_maintenance_rules(id,revision,source,timezone,pattern_json,enabled,reference_url,verified_at,scope,actor,created_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE COALESCE((SELECT MAX(revision) FROM provider_maintenance_rules WHERE id=?),0)=?`)
      .bind(
        v.id,
        Number(v.revision) + 1,
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
      )
      .run();
  if (inserted.meta.changes !== 1) throw new ScheduleError("revision_conflict", 409);
  await env.DB.prepare(
    "UPDATE provider_maintenance_references SET status='confirmed',reference_url=?,verified_at=? WHERE source=?",
  )
    .bind(v.referenceUrl, v.verifiedAt, v.source)
    .run();
  const affected = jobs.filter((j) => j.source === v.source);
  let pending = 0;
  for (const job of affected) {
    try {
      await env.SCHEDULE_ALARMS.getByName(job.id).reconcile(job.id);
    } catch {
      pending++;
    }
  }
  return {
    saved: true,
    revision: Number(v.revision) + 1,
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
export async function releaseCollectionLease(
  env: Env,
  source: string,
  value: unknown,
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
  const released = await env.DB.prepare(
    // A repeated release is already satisfied while the source is unlocked.
    // Check this in the same statement as the write: a newly acquired lease
    // must never be cleared by a delayed retry of the previous reference.
    "UPDATE collection_execution_leases SET lease_ref=NULL,started_at=NULL WHERE source=? AND (lease_ref=? OR lease_ref IS NULL)",
  )
    .bind(source, v.leaseRef)
    .run();
  if (released.meta.changes !== 1) throw new ScheduleError("lease_conflict", 409);
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
  return { schedules, maintenance, occurrences, leases };
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
    const actor = request.headers.get("x-kogane-operator");
    if (!actor || !/^[A-Za-z0-9._:@-]{1,200}$/u.test(actor))
      throw new ScheduleError("operator_required", 403);
    const text = await request.text();
    if (text.length > 16 * 1024) throw new ScheduleError("request_too_large", 413);
    const value: unknown = JSON.parse(text);
    if (path === "/maintenance") return Response.json(await updateMaintenance(env, value, actor));
    const leaseMatch = /^\/leases\/([a-z0-9-]{1,100})$/u.exec(path);
    if (leaseMatch) return Response.json(await releaseCollectionLease(env, leaseMatch[1]!, value));
    const match = /^\/([a-z0-9-]{1,100})$/u.exec(path);
    if (match) return Response.json(await updateSchedule(env, match[1]!, value, actor));
    throw new ScheduleError("not_found", 404);
  } catch (error) {
    return Response.json(
      { error: error instanceof ScheduleError ? error.code : "scheduling_unavailable" },
      { status: error instanceof ScheduleError ? error.status : 503 },
    );
  }
}
