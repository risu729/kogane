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
}
export interface ScheduleOccurrence {
  id: string;
  scheduleId: string;
  nominalAt: string;
  startedAt: string;
  finishedAt: string | null;
  status: "started" | "completed" | "failed" | "uncertain";
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
    for (let date = localDate(from, rule.timezone) - DAY; date <= from + horizon; date += DAY) {
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
