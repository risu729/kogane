// Public scheduling contract. No credentials, bank values or provider response text.
import type { MaintenanceSurveyView } from "./maintenance-survey-model";
export type SchedulePattern =
  | { kind: "daily"; time: string; weekdays: number[] }
  | { kind: "interval"; minutes: number };
export type MaintenancePattern =
  | { kind: "weekly"; weekdays: number[]; start: string; end: string }
  | {
      kind: "monthly";
      weekday: number;
      nth: number;
      offsetDays: number;
      start: string;
      end: string;
    }
  | { kind: "once"; from: string; to: string };
export interface MaintenanceRule {
  id: string;
  source: string;
  timezone: string;
  pattern: MaintenancePattern;
  enabled: boolean;
  referenceUrl: string;
  verifiedAt: string;
  scope: "collection" | "session" | "feature-only";
  revision: number;
}
/**
 * Why a maintenance revision was written, as a closed code (ADR 0046 as
 * amended by ADR 0063, item 8). CORE 0078's CHECK on
 * `provider_maintenance_rules.change_reason` holds the same list; a revision
 * never carries free text. `operator-edit` is the operator page's own edit;
 * `maintenance-survey-proposal-accepted` is an accepted re-survey proposal
 * (ADR 0050); the others are what a delegated principal may choose
 * (`DELEGATED_MAINTENANCE_REASONS`).
 */
export const MAINTENANCE_CHANGE_REASONS = [
  "official-notice-added",
  "official-notice-changed",
  "official-notice-withdrawn",
  "outage-observed",
  "owner-instructed",
  "correction",
  "operator-edit",
  "maintenance-survey-proposal-accepted",
] as const;
export type MaintenanceChangeReason = (typeof MAINTENANCE_CHANGE_REASONS)[number];
/**
 * The reasons a delegated maintenance revision may give: neither the
 * operator's nor a survey's. A delegated survey acceptance gives the survey's
 * reason, which only the private survey route's trusted writer option admits
 * (ADR 0050, 2026-11-07 amendment).
 */
export const DELEGATED_MAINTENANCE_REASONS = [
  "official-notice-added",
  "official-notice-changed",
  "official-notice-withdrawn",
  "outage-observed",
  "owner-instructed",
  "correction",
] as const satisfies readonly MaintenanceChangeReason[];
export type DelegatedMaintenanceReason = (typeof DELEGATED_MAINTENANCE_REASONS)[number];
export interface ScheduleView {
  id: string;
  source: string | null;
  kind: "collection" | "keepalive" | "processor" | "manual" | "email";
  enabled: boolean;
  supported: boolean;
  timezone: string;
  pattern: SchedulePattern;
  revision: number;
  nextNominalAt: string | null;
  nextRunAt: string | null;
  actualAlarmAt: string | null;
  reservation: "armed" | "disabled" | "pending";
  maintenance: {
    status: "confirmed" | "no-applicable-rule" | "not-found";
    referenceUrl: string;
    verifiedAt: string;
  };
  latest: ScheduleOccurrence | null;
  /**
   * How this job can be asked to collect now (ADR 0048): the CORE source a
   * `POST /api/ops/v1/collections` names, and whether the Processor's dispatch
   * lane would start it. Null when no collector connection serves a request
   * for this job; absent from a Processor that predates it.
   */
  collectionRequest?: ScheduleCollectionRequest | null;
}
export interface ScheduleCollectionRequest {
  source: string;
  dispatch: "enabled" | "lane_disabled" | "connection_disabled";
}
export interface ScheduleOccurrence {
  id: string;
  scheduleId: string;
  nominalAt: string;
  startedAt: string;
  finishedAt: string | null;
  status: "started" | "completed" | "failed" | "uncertain" | "not_dispatched";
  runIds: string[];
  runLinks: { runId: string; evidenceId: string | null }[];
  failureCode: string | null;
}
export interface ScheduleSnapshot {
  schedules: ScheduleView[];
  maintenance: MaintenanceRule[];
  occurrences: ScheduleOccurrence[];
  leases: { source: string; leaseRef: string; startedAt: string }[];
  /** The official-site re-survey (ADR 0050); absent from a Processor that predates it. */
  survey?: MaintenanceSurveyView;
}
/**
 * The schedules page in one line per job (ADR 0123): the `summary` detail of
 * `GET /api/ops/v1/schedules` and `kogane.schedules.read`. Each job keeps its
 * closed states (kind, enabled, supported, reservation, and whether a
 * collection request for it would be dispatched, absent where the snapshot
 * has none) and its newest occurrence (its status and closed failure code),
 * each source its maintenance reference status and how many maintenance
 * rules it has, and every held lease is listed. The occurrence list, the
 * rules' patterns and the re-survey are in the `full` detail only.
 */
export interface ScheduleSummary {
  detail: "summary";
  schedules: {
    id: string;
    source: string | null;
    kind: ScheduleView["kind"];
    enabled: boolean;
    supported: boolean;
    nextRunAt: string | null;
    reservation: ScheduleView["reservation"];
    /**
     * `collectionRequest.dispatch`: null when no collector serves a request
     * for the job, absent when the snapshot does not say (an older Processor).
     */
    dispatch?: ScheduleCollectionRequest["dispatch"] | null;
    latest: Pick<ScheduleOccurrence, "nominalAt" | "status" | "failureCode"> | null;
  }[];
  maintenance: { source: string; status: ScheduleView["maintenance"]["status"]; rules: number }[];
  leases: ScheduleSnapshot["leases"];
}
/** The summary of one schedules snapshot; derived from it alone, so it says nothing the snapshot does not. */
export function scheduleSnapshotSummary(snapshot: ScheduleSnapshot): ScheduleSummary {
  const maintenance = new Map<string, ScheduleSummary["maintenance"][number]>();
  for (const schedule of snapshot.schedules)
    if (schedule.source !== null && !maintenance.has(schedule.source))
      maintenance.set(schedule.source, {
        source: schedule.source,
        status: schedule.maintenance.status,
        rules: snapshot.maintenance.filter((rule) => rule.source === schedule.source).length,
      });
  return {
    detail: "summary",
    schedules: snapshot.schedules.map((schedule) => ({
      id: schedule.id,
      source: schedule.source,
      kind: schedule.kind,
      enabled: schedule.enabled,
      supported: schedule.supported,
      nextRunAt: schedule.nextRunAt,
      reservation: schedule.reservation,
      ...(schedule.collectionRequest === undefined
        ? {}
        : { dispatch: schedule.collectionRequest?.dispatch ?? null }),
      latest:
        schedule.latest === null
          ? null
          : {
              nominalAt: schedule.latest.nominalAt,
              status: schedule.latest.status,
              failureCode: schedule.latest.failureCode,
            },
    })),
    maintenance: [...maintenance.values()],
    leases: snapshot.leases,
  };
}
/**
 * `kogane.schedules.maintenance.read` in full (ADR 0046): the Processor's
 * agent read of the granted sources, each with its registered maintenance
 * reference, its jobs and its rules' newest revisions (at most 20 a rule,
 * newest first), and the writer's limits on a delegated principal.
 */
export interface MaintenanceRead {
  sources: MaintenanceReadSource[];
  limits: { maxDeferralHours: number; writesPerDay: number; writesUsedToday: number };
}
export interface MaintenanceReadSource {
  source: string;
  reference: {
    status: ScheduleView["maintenance"]["status"];
    referenceUrl: string;
    verifiedAt: string;
  } | null;
  schedules: (Pick<
    ScheduleView,
    | "id"
    | "source"
    | "kind"
    | "enabled"
    | "supported"
    | "timezone"
    | "pattern"
    | "revision"
    | "nextNominalAt"
    | "nextRunAt"
    | "actualAlarmAt"
    | "reservation"
  > & {
    latest: Pick<
      ScheduleOccurrence,
      "nominalAt" | "startedAt" | "finishedAt" | "status" | "failureCode"
    > | null;
  })[];
  rules: { id: string; revisions: MaintenanceReadRevision[] }[];
}
export interface MaintenanceReadRevision {
  revision: number;
  timezone: string;
  pattern: MaintenancePattern;
  enabled: boolean;
  scope: MaintenanceRule["scope"];
  referenceUrl: string;
  verifiedAt: string;
  createdAt: string;
  /** `null` for revisions written before CORE 0078 recorded it. */
  actorKind: "operator" | "delegated" | null;
  /** A closed code (`MAINTENANCE_CHANGE_REASONS`), or `null` before CORE 0078. */
  changeReason: MaintenanceChangeReason | null;
  /** Whether the reading principal wrote it as a delegated principal. */
  byCaller: boolean;
}
/**
 * How many lines one page of the maintenance summary holds: each job and
 * each rule is a line, and so is a source with neither.
 */
export const MAINTENANCE_SUMMARY_LINES = 16;
/**
 * The maintenance read in short (ADR 0123, amendment 2026-11-19): the
 * `summary` detail of `kogane.schedules.maintenance.read`. Per source its
 * maintenance reference status and how many jobs and rules it has; per job
 * its closed states, revision, next nominal and maintenance-adjusted run
 * times, and its newest receipt's status and failure code; per rule its
 * current revision in full (timezone, pattern, enabled, scope) with how many
 * revisions the full read lists, the distinct actor kinds and change reasons
 * among them, and how many the reader wrote. Paged by line (`offset` counts
 * lines, in the read's order: a source's jobs, then its rules): a source
 * whose lines continue on the next page is listed on both, each with the
 * lines that page holds, and its `scheduleCount` and `ruleCount` say how
 * many it has in all.
 */
export interface MaintenanceSummary {
  detail: "summary";
  sources: {
    source: string;
    reference: ScheduleView["maintenance"]["status"] | null;
    /** The source's jobs and rules in the whole read, on this page or another. */
    scheduleCount: number;
    ruleCount: number;
    schedules: (Pick<
      ScheduleView,
      | "id"
      | "kind"
      | "enabled"
      | "supported"
      | "revision"
      | "nextNominalAt"
      | "nextRunAt"
      | "reservation"
    > & { latest: Pick<ScheduleOccurrence, "nominalAt" | "status" | "failureCode"> | null })[];
    rules: {
      id: string;
      revision: number;
      timezone: string;
      pattern: MaintenancePattern;
      enabled: boolean;
      scope: MaintenanceRule["scope"];
      /** How many revisions the full read lists for the rule (at most 20, the current one included). */
      revisions: number;
      /** The distinct actor kinds of those revisions, newest first; `null` is one recorded before CORE 0078. */
      actorKinds: MaintenanceReadRevision["actorKind"][];
      /** The distinct change reasons of those revisions, newest first; `null` is one recorded before CORE 0078. */
      changeReasons: MaintenanceReadRevision["changeReason"][];
      /** How many of those revisions the reading principal wrote. */
      byCaller: number;
    }[];
  }[];
  limits: MaintenanceRead["limits"];
  coverage: {
    /** Every source the read answers, and every job and rule line of them. */
    sources: number;
    lines: number;
    limit: number;
    offset: number;
    /** The offset of the next page's first line, or null on the last page. */
    nextOffset: number | null;
  };
}
type MaintenanceSummarySource = MaintenanceSummary["sources"][number];
function distinctValues<T>(values: readonly T[]): T[] {
  const out: T[] = [];
  for (const value of values) if (!out.includes(value)) out.push(value);
  return out;
}
/** One source in short, all its lines; a page keeps the slice of them it holds. */
function maintenanceSourceSummary(source: MaintenanceReadSource): MaintenanceSummarySource {
  return {
    source: source.source,
    reference: source.reference?.status ?? null,
    scheduleCount: source.schedules.length,
    ruleCount: source.rules.length,
    schedules: source.schedules.map((schedule) => ({
      id: schedule.id,
      kind: schedule.kind,
      enabled: schedule.enabled,
      supported: schedule.supported,
      revision: schedule.revision,
      nextNominalAt: schedule.nextNominalAt,
      nextRunAt: schedule.nextRunAt,
      reservation: schedule.reservation,
      latest:
        schedule.latest === null
          ? null
          : {
              nominalAt: schedule.latest.nominalAt,
              status: schedule.latest.status,
              failureCode: schedule.latest.failureCode,
            },
    })),
    rules: source.rules.map((rule) => {
      const current = rule.revisions[0];
      // The read lists a rule only with a revision; one without is not a rule to summarize.
      if (current === undefined) throw new Error("maintenance_rule_without_revision");
      return {
        id: rule.id,
        revision: current.revision,
        timezone: current.timezone,
        pattern: current.pattern,
        enabled: current.enabled,
        scope: current.scope,
        revisions: rule.revisions.length,
        actorKinds: distinctValues(rule.revisions.map((revision) => revision.actorKind)),
        changeReasons: distinctValues(rule.revisions.map((revision) => revision.changeReason)),
        byCaller: rule.revisions.filter((revision) => revision.byCaller).length,
      };
    }),
  };
}
/**
 * One page of the maintenance summary from the full read; derived from it
 * alone, so it says nothing the read does not. `offset` counts lines; an
 * offset past the last line answers a page with no source.
 */
export function maintenanceReadSummary(read: MaintenanceRead, offset = 0): MaintenanceSummary {
  const end = offset + MAINTENANCE_SUMMARY_LINES;
  const page: MaintenanceSummarySource[] = [];
  let first = 0;
  for (const source of read.sources) {
    const whole = maintenanceSourceSummary(source);
    // A source with neither a job nor a rule is still one line, never left out.
    const count = Math.max(1, whole.schedules.length + whole.rules.length);
    const from = Math.max(offset, first) - first;
    const to = Math.min(end, first + count) - first;
    first += count;
    if (from >= to) continue;
    const schedules = whole.schedules.length;
    page.push({
      ...whole,
      schedules: whole.schedules.slice(from, to),
      rules: whole.rules.slice(Math.max(0, from - schedules), Math.max(0, to - schedules)),
    });
  }
  return {
    detail: "summary",
    sources: page,
    limits: read.limits,
    coverage: {
      sources: read.sources.length,
      lines: first,
      limit: MAINTENANCE_SUMMARY_LINES,
      offset,
      nextOffset: end < first ? end : null,
    },
  };
}
export const TIME = /^([01]\d|2[0-3]):[0-5]\d$/u;
export const ZONES = ["Asia/Tokyo", "UTC", "Australia/Sydney"] as const;
const DAY = 86_400_000;
export function validPattern(value: unknown): value is SchedulePattern {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.kind === "interval")
    return (
      Object.keys(v).length === 2 &&
      Number.isInteger(v.minutes) &&
      Number(v.minutes) >= 5 &&
      Number(v.minutes) <= 1440
    );
  return (
    v.kind === "daily" &&
    Object.keys(v).length === 3 &&
    typeof v.time === "string" &&
    TIME.test(v.time) &&
    validWeekdays(v.weekdays)
  );
}
function validWeekdays(v: unknown): v is number[] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.length <= 7 &&
    new Set(v).size === v.length &&
    v.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)
  );
}
export function validMaintenance(v: unknown): v is MaintenancePattern {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const p = v as Record<string, unknown>;
  if (p.kind === "once")
    return (
      Object.keys(p).length === 3 &&
      typeof p.from === "string" &&
      typeof p.to === "string" &&
      validInstant(p.from) &&
      validInstant(p.to) &&
      p.from < p.to
    );
  if (
    typeof p.start !== "string" ||
    typeof p.end !== "string" ||
    !TIME.test(p.start) ||
    !TIME.test(p.end) ||
    p.start === p.end
  )
    return false;
  if (p.kind === "weekly") return Object.keys(p).length === 4 && validWeekdays(p.weekdays);
  return (
    p.kind === "monthly" &&
    Object.keys(p).length === 6 &&
    Number.isInteger(p.weekday) &&
    Number(p.weekday) >= 0 &&
    Number(p.weekday) <= 6 &&
    Number.isInteger(p.nth) &&
    Number(p.nth) >= 1 &&
    Number(p.nth) <= 5 &&
    Number.isInteger(p.offsetDays) &&
    Number(p.offsetDays) >= 0 &&
    Number(p.offsetDays) <= 6
  );
}
export function validInstant(v: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(v) &&
    Number.isFinite(Date.parse(v)) &&
    new Date(v).toISOString() === v
  );
}
// One formatter per zone: constructing one costs far more than formatting with it.
const formatters = new Map<string, Intl.DateTimeFormat>();
function parts(ms: number, timezone: string): number[] {
  let format = formatters.get(timezone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timezone, format);
  }
  const p = format.formatToParts(ms);
  return ["year", "month", "day", "hour", "minute"].map((k) =>
    Number(p.find((v) => v.type === k)?.value),
  );
}
function localDate(ms: number, timezone: string): number {
  const [y, m, d] = parts(ms, timezone);
  return Date.UTC(y!, m! - 1, d!);
}
function at(date: number, time: string, timezone: string): number | null {
  const [h, m] = time.split(":").map(Number);
  const target = date + h! * 3_600_000 + m! * 60_000;
  const offsets = new Set<number>();
  for (const delta of [-DAY, 0, DAY]) {
    const t = target + delta;
    const [y, mo, d, hh, mm] = parts(t, timezone);
    offsets.add(Date.UTC(y!, mo! - 1, d!, hh!, mm!) - t);
  }
  const candidates = [...offsets]
    .map((o) => target - o)
    .filter((t) => {
      const [y, mo, d, hh, mm] = parts(t, timezone);
      return Date.UTC(y!, mo! - 1, d!, hh!, mm!) === target;
    });
  // A missing DST wall time is skipped; the earlier repeated wall time is used once.
  return candidates.length ? Math.min(...candidates) : null;
}
/** The local date of an instant in `timezone`, as the UTC midnight of that date. */
export function localCalendarDate(ms: number, timezone: string): number {
  return localDate(ms, timezone);
}
/**
 * The instant of wall time `time` (HH:MM) on a local date given as its UTC
 * midnight, in `timezone`; null for a malformed time or one DST skips. The
 * maintenance survey places dated windows with it (ADR 0050).
 */
export function wallTimeInstant(date: number, time: string, timezone: string): number | null {
  return TIME.test(time) && (ZONES as readonly string[]).includes(timezone)
    ? at(date, time, timezone)
    : null;
}
export function nextNominal(pattern: SchedulePattern, timezone: string, after: number): number {
  if (
    !validPattern(pattern) ||
    !(ZONES as readonly string[]).includes(timezone) ||
    !Number.isFinite(after)
  )
    throw new Error("invalid_schedule");
  if (pattern.kind === "interval") {
    const step = pattern.minutes * 60_000;
    return (Math.floor(after / step) + 1) * step;
  }
  const date = localDate(after, timezone);
  for (let i = 0; i < 15; i++) {
    const day = date + i * DAY;
    if (!pattern.weekdays.includes(new Date(day).getUTCDay())) continue;
    const t = at(day, pattern.time, timezone);
    if (t !== null && t > after) return t;
  }
  throw new Error("schedule_unavailable");
}
/** Whether a recurring window starts on this local date (UTC midnight of it). */
function startsOn(p: Exclude<MaintenancePattern, { kind: "once" }>, startDate: number): boolean {
  if (p.kind === "weekly") return p.weekdays.includes(new Date(startDate).getUTCDay());
  const base = new Date(startDate - p.offsetDays * DAY);
  return base.getUTCDay() === p.weekday && Math.ceil(base.getUTCDate() / 7) === p.nth;
}
function windowEnd(t: number, rule: MaintenanceRule): number | null {
  if (!rule.enabled || rule.scope === "feature-only") return null;
  const p = rule.pattern;
  if (p.kind === "once")
    return t >= Date.parse(p.from) && t < Date.parse(p.to) ? Date.parse(p.to) : null;
  const date = localDate(t, rule.timezone);
  for (let back = 0; back <= 7; back++) {
    const startDate = date - back * DAY;
    if (!startsOn(p, startDate)) continue;
    const start = at(startDate, p.start, rule.timezone),
      end = at(startDate + (p.end < p.start ? DAY : 0), p.end, rule.timezone);
    if (start !== null && end !== null && t >= start && t < end) return end;
  }
  return null;
}
export function afterMaintenance(t: number, rules: readonly MaintenanceRule[]): number {
  // Re-evaluate adjacent/overlapping windows to their full union's end.
  let result = t;
  for (let i = 0; i < 1000; i++) {
    const ends = rules.map((r) => windowEnd(result, r)).filter((e): e is number => e !== null);
    if (!ends.length) return result;
    const end = Math.max(...ends);
    if (end <= result) throw new Error("maintenance_unavailable");
    result = end;
  }
  throw new Error("maintenance_unavailable");
}

/** One joined deferral: the union's start, and where collection may run again. */
export interface DeferralUnion {
  start: number;
  end: number;
}

/**
 * The joined deferrals these rules cause from `from` onward, in order, each
 * measured from the start of its union: the remaining deferral at `from`,
 * every dated window starting after it, and every recurring window starting
 * within `horizon` milliseconds. A chain is followed for at most `cap`
 * milliseconds, so a union's end is exact up to `cap` past its start and
 * otherwise only "more than `cap`" — windows that chain without end are just
 * that, not an error.
 */
function* joinedDeferrals(
  rules: readonly MaintenanceRule[],
  from: number,
  horizon: number,
  cap: number,
): Generator<DeferralUnion> {
  const starts = new Set<number>([from]);
  for (const rule of rules) {
    if (!rule.enabled || rule.scope === "feature-only") continue;
    const p = rule.pattern;
    if (p.kind === "once") {
      if (Date.parse(p.from) > from) starts.add(Date.parse(p.from));
      continue;
    }
    // One day before `from` covers a window that starts on the previous local date.
    // The last date is the horizon's end in the rule's zone: ahead of UTC, that
    // local date begins before the instant, and a window on it can start in time.
    const last = localDate(from + horizon, rule.timezone);
    for (let date = localDate(from, rule.timezone) - DAY; date <= last; date += DAY) {
      if (!startsOn(p, date)) continue;
      const start = at(date, p.start, rule.timezone);
      if (start !== null && start > from && start < from + horizon) starts.add(start);
    }
  }
  let reach = Number.NEGATIVE_INFINITY;
  for (const start of [...starts].sort((a, b) => a - b)) {
    // A start inside a union already followed defers less than the union's own start.
    if (start < reach) continue;
    let t = start;
    while (t - start <= cap) {
      const ends = rules.map((r) => windowEnd(t, r)).filter((e): e is number => e !== null);
      if (!ends.length) break;
      const end = Math.max(...ends);
      if (end <= t) throw new Error("maintenance_unavailable");
      t = end;
    }
    reach = t;
    if (t > start) yield { start, end: t };
  }
}

/** Every joined deferral these rules cause (see `joinedDeferrals`). */
export function deferralUnions(
  rules: readonly MaintenanceRule[],
  from: number,
  horizon: number,
  cap: number,
): DeferralUnion[] {
  return [...joinedDeferrals(rules, from, horizon, cap)];
}

/**
 * The longest joined deferral these rules cause from `from` onward (see
 * `joinedDeferrals`): exact up to `cap`, otherwise only "more than `cap`".
 */
export function longestDeferral(
  rules: readonly MaintenanceRule[],
  from: number,
  horizon: number,
  cap: number,
): number {
  let longest = 0;
  for (const union of joinedDeferrals(rules, from, horizon, cap)) {
    longest = Math.max(longest, union.end - union.start);
    if (longest > cap) break;
  }
  return longest;
}
