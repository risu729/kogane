// Role-typed time. A date is never promoted to an instant, an instant carries
// its own offset, and period arithmetic works on civil days so it is free of
// DST and leap-second surprises. Zones are named for deadline resolution and
// display; this module does not embed a time-zone database.
import { hasExactKeys, isOneOf, isRecord, isText } from "./guards.ts";

export const TEMPORAL_BASES = ["provider", "collector", "derived"] as const;
export type TemporalBasis = (typeof TEMPORAL_BASES)[number];
export const PERIOD_GRANULARITIES = ["day", "month", "year"] as const;
export type PeriodGranularity = (typeof PERIOD_GRANULARITIES)[number];

export interface InstantValue {
  kind: "instant";
  /** RFC 3339 with an explicit offset or `Z`. */
  value: string;
  zone: string;
  basis: TemporalBasis;
}
export interface LocalDateValue {
  kind: "local-date";
  /** `YYYY-MM-DD`; there is deliberately no time-of-day. */
  value: string;
  zone: string | null;
  basis: TemporalBasis;
}
export interface PeriodValue {
  kind: "period";
  start: string;
  end: string;
  endExclusive: boolean;
  zone: string | null;
  granularity: PeriodGranularity;
}
export interface UnknownTime {
  kind: "unknown";
  reasonCode: string;
}
export type TemporalValue = InstantValue | LocalDateValue | PeriodValue | UnknownTime;

export const TEMPORAL_ROLES = [
  "effective",
  "recorded",
  "fetched",
  "observed",
  "trade",
  "settlement",
  "value-date",
  "authorized",
  "posted",
  "statement",
  "due",
  "expiry",
  "requested",
  "proposed",
  "accepted",
  "superseded",
] as const;
export type TemporalRole = (typeof TEMPORAL_ROLES)[number];
export interface TemporalReference {
  role: TemporalRole;
  time: TemporalValue;
}

export interface CivilDate {
  year: number;
  month: number;
  day: number;
}

export const TEMPORAL_INCOMPARABLE_REASONS = [
  "unknown_time",
  "zone_mismatch",
  "within_day",
  "within_period",
  "overlap",
] as const;
export type TemporalIncomparableReason = (typeof TEMPORAL_INCOMPARABLE_REASONS)[number];
export type TemporalOrder =
  | { kind: "ordered"; order: -1 | 0 | 1 }
  | { kind: "incomparable"; reasonCode: TemporalIncomparableReason };

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const MONTH = /^(\d{4})-(\d{2})$/u;
const YEAR = /^(\d{4})$/u;
const INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/u;
const ZONE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/u;

export function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function civil(year: number, month: number, day: number): CivilDate | null {
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

export function parseLocalDate(text: string): CivilDate | null {
  const match = LOCAL_DATE.exec(text);
  if (!match) return null;
  return civil(Number(match[1]), Number(match[2]), Number(match[3]));
}

export function formatLocalDate(date: CivilDate): string {
  const pad = (n: number, width: number) => String(n).padStart(width, "0");
  return `${pad(date.year, 4)}-${pad(date.month, 2)}-${pad(date.day, 2)}`;
}

/** Days since 1970-01-01 in the proleptic Gregorian calendar (no time zone involved). */
export function daysFromCivil(date: CivilDate): number {
  const y = date.month <= 2 ? date.year - 1 : date.year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (date.month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + date.day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function civilFromDays(days: number): CivilDate {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day };
}

export function addDays(date: CivilDate, days: number): CivilDate {
  return civilFromDays(daysFromCivil(date) + days);
}

/** `b − a` in civil days. */
export function daysBetween(a: CivilDate, b: CivilDate): number {
  return daysFromCivil(b) - daysFromCivil(a);
}

export type EndOfMonthPolicy = "clamp" | "preserve-end-of-month";

/**
 * Month arithmetic on civil dates. `clamp` keeps the day-of-month when it
 * exists and otherwise uses the last day (2024-01-31 + 1 → 2024-02-29).
 * `preserve-end-of-month` additionally maps a month-end input to the month
 * end of the result (2024-02-29 + 1 → 2024-03-31), the rule some programs use
 * for deadlines. Neither policy is a fixed number of seconds.
 */
export function addMonths(date: CivilDate, months: number, policy: EndOfMonthPolicy): CivilDate {
  const index = date.year * 12 + (date.month - 1) + months;
  const year = Math.floor(index / 12);
  const month = index - year * 12 + 1;
  const last = daysInMonth(year, month);
  const atEnd = date.day === daysInMonth(date.year, date.month);
  const day = policy === "preserve-end-of-month" && atEnd ? last : Math.min(date.day, last);
  return { year, month, day };
}

export interface ParsedInstant {
  /** Seconds since the Unix epoch, offset applied. */
  epochSeconds: number;
  nanoseconds: number;
  /** Calendar date of the instant in its own offset, never re-projected. */
  localDate: string;
}

export function parseInstant(text: string): ParsedInstant | null {
  const match = INSTANT.exec(text);
  if (!match) return null;
  const date = civil(Number(match[1]), Number(match[2]), Number(match[3]));
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (!date || hour > 23 || minute > 59 || second > 59) return null;
  const offset = match[8]!;
  let offsetSeconds = 0;
  if (offset !== "Z") {
    const sign = offset.startsWith("-") ? -1 : 1;
    const offsetHours = Number(offset.slice(1, 3));
    const offsetMinutes = Number(offset.slice(4, 6));
    if (offsetHours > 18 || offsetMinutes > 59) return null;
    offsetSeconds = sign * (offsetHours * 3600 + offsetMinutes * 60);
  }
  return {
    epochSeconds: daysFromCivil(date) * 86400 + hour * 3600 + minute * 60 + second - offsetSeconds,
    nanoseconds: Number((match[7] ?? "").padEnd(9, "0")),
    localDate: formatLocalDate(date),
  };
}

export function validInstantText(value: unknown): value is string {
  return typeof value === "string" && parseInstant(value) !== null;
}

export function validLocalDateText(value: unknown): value is string {
  return typeof value === "string" && parseLocalDate(value) !== null;
}

export function validZone(value: unknown): value is string {
  return isText(value, 64) && ZONE.test(value);
}

function unitStart(text: string, granularity: PeriodGranularity): CivilDate | null {
  if (granularity === "day") return parseLocalDate(text);
  if (granularity === "month") {
    const match = MONTH.exec(text);
    return match ? civil(Number(match[1]), Number(match[2]), 1) : null;
  }
  const match = YEAR.exec(text);
  return match ? civil(Number(match[1]), 1, 1) : null;
}

function nextUnit(date: CivilDate, granularity: PeriodGranularity): CivilDate {
  if (granularity === "day") return addDays(date, 1);
  if (granularity === "month") return addMonths(date, 1, "clamp");
  return { year: date.year + 1, month: 1, day: 1 };
}

/** Half-open civil-day bounds `[start, endExclusive)` regardless of how the period was written. */
export function periodBounds(
  period: PeriodValue,
): { start: CivilDate; endExclusive: CivilDate } | null {
  const start = unitStart(period.start, period.granularity);
  const end = unitStart(period.end, period.granularity);
  if (!start || !end) return null;
  const endExclusive = period.endExclusive ? end : nextUnit(end, period.granularity);
  if (daysFromCivil(endExclusive) <= daysFromCivil(start)) return null;
  return { start, endExclusive };
}

export function periodDays(period: PeriodValue): number | null {
  const bounds = periodBounds(period);
  return bounds ? daysBetween(bounds.start, bounds.endExclusive) : null;
}

export function periodContainsDate(period: PeriodValue, date: CivilDate): boolean {
  const bounds = periodBounds(period);
  if (!bounds) return false;
  const day = daysFromCivil(date);
  return day >= daysFromCivil(bounds.start) && day < daysFromCivil(bounds.endExclusive);
}

export function monthPeriod(year: number, month: number, zone: string | null): PeriodValue {
  const text = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
  return {
    kind: "period",
    start: text,
    end: text,
    endExclusive: false,
    zone,
    granularity: "month",
  };
}

export function validPeriodValue(value: unknown): value is PeriodValue {
  if (
    !isRecord(value) ||
    value.kind !== "period" ||
    !hasExactKeys(value, ["kind", "start", "end", "endExclusive", "zone", "granularity"]) ||
    !isText(value.start, 10) ||
    !isText(value.end, 10) ||
    typeof value.endExclusive !== "boolean" ||
    !(value.zone === null || validZone(value.zone)) ||
    !isOneOf(PERIOD_GRANULARITIES)(value.granularity)
  )
    return false;
  return (
    periodBounds({
      kind: "period",
      start: value.start,
      end: value.end,
      endExclusive: value.endExclusive,
      zone: value.zone,
      granularity: value.granularity,
    }) !== null
  );
}

export function validTemporalValue(value: unknown): value is TemporalValue {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "instant":
      return (
        hasExactKeys(value, ["kind", "value", "zone", "basis"]) &&
        validInstantText(value.value) &&
        validZone(value.zone) &&
        isOneOf(TEMPORAL_BASES)(value.basis)
      );
    case "local-date":
      return (
        hasExactKeys(value, ["kind", "value", "zone", "basis"]) &&
        validLocalDateText(value.value) &&
        (value.zone === null || validZone(value.zone)) &&
        isOneOf(TEMPORAL_BASES)(value.basis)
      );
    case "period":
      return validPeriodValue(value);
    case "unknown":
      return hasExactKeys(value, ["kind", "reasonCode"]) && isText(value.reasonCode, 128);
    default:
      return false;
  }
}

export function validTemporalReference(value: unknown): value is TemporalReference {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["role", "time"]) &&
    isOneOf(TEMPORAL_ROLES)(value.role) &&
    validTemporalValue(value.time)
  );
}

interface DayInterval {
  start: number;
  endExclusive: number;
  zone: string | null;
}

function dayInterval(value: LocalDateValue | PeriodValue): DayInterval | null {
  if (value.kind === "local-date") {
    const date = parseLocalDate(value.value);
    if (!date) return null;
    const start = daysFromCivil(date);
    return { start, endExclusive: start + 1, zone: value.zone };
  }
  const bounds = periodBounds(value);
  if (!bounds) return null;
  return {
    start: daysFromCivil(bounds.start),
    endExclusive: daysFromCivil(bounds.endExclusive),
    zone: value.zone,
  };
}

function zonesCompatible(a: string | null, b: string | null): boolean {
  return a === null || b === null || a === b;
}

/**
 * Semantic comparison. Instants compare by their absolute time. Dates and
 * periods compare as civil-day intervals in a compatible zone. An instant is
 * only ordered against a date or period when its own calendar date lies wholly
 * before or after the interval; a date is never given a time-of-day (INV05).
 */
export function compareTemporal(a: TemporalValue, b: TemporalValue): TemporalOrder {
  if (a.kind === "unknown" || b.kind === "unknown")
    return { kind: "incomparable", reasonCode: "unknown_time" };
  if (a.kind === "instant" && b.kind === "instant") {
    const x = parseInstant(a.value);
    const y = parseInstant(b.value);
    if (!x || !y) return { kind: "incomparable", reasonCode: "unknown_time" };
    const order =
      x.epochSeconds !== y.epochSeconds
        ? x.epochSeconds < y.epochSeconds
          ? -1
          : 1
        : x.nanoseconds !== y.nanoseconds
          ? x.nanoseconds < y.nanoseconds
            ? -1
            : 1
          : 0;
    return { kind: "ordered", order };
  }
  if (a.kind === "instant" || b.kind === "instant") {
    const flipped = a.kind !== "instant";
    const instant = (flipped ? b : a) as InstantValue;
    const other = (flipped ? a : b) as LocalDateValue | PeriodValue;
    if (!zonesCompatible(instant.zone, other.zone))
      return { kind: "incomparable", reasonCode: "zone_mismatch" };
    const parsed = parseInstant(instant.value);
    const interval = dayInterval(other);
    if (!parsed || !interval) return { kind: "incomparable", reasonCode: "unknown_time" };
    const day = daysFromCivil(parseLocalDate(parsed.localDate)!);
    if (day < interval.start) return { kind: "ordered", order: flipped ? 1 : -1 };
    if (day >= interval.endExclusive) return { kind: "ordered", order: flipped ? -1 : 1 };
    return {
      kind: "incomparable",
      reasonCode: other.kind === "local-date" ? "within_day" : "within_period",
    };
  }
  const x = dayInterval(a);
  const y = dayInterval(b);
  if (!x || !y) return { kind: "incomparable", reasonCode: "unknown_time" };
  if (!zonesCompatible(x.zone, y.zone))
    return { kind: "incomparable", reasonCode: "zone_mismatch" };
  if (x.start === y.start && x.endExclusive === y.endExclusive)
    return { kind: "ordered", order: 0 };
  if (x.endExclusive <= y.start) return { kind: "ordered", order: -1 };
  if (y.endExclusive <= x.start) return { kind: "ordered", order: 1 };
  return { kind: "incomparable", reasonCode: "overlap" };
}

/**
 * Total, deterministic ordering key for paging and tie-breaks only. It is not
 * a semantic comparison: unknown times sort last by reason code, and a date
 * sorts by its calendar day without pretending to be an instant.
 */
export function temporalOrderingKey(value: TemporalValue): string {
  switch (value.kind) {
    case "instant": {
      const parsed = parseInstant(value.value);
      if (!parsed) return `3:invalid_instant`;
      const seconds = parsed.epochSeconds + 2 ** 40;
      return `0:${String(seconds).padStart(13, "0")}:${String(parsed.nanoseconds).padStart(9, "0")}`;
    }
    case "local-date":
      return `1:${value.value}`;
    case "period": {
      const bounds = periodBounds(value);
      return bounds
        ? `2:${formatLocalDate(bounds.start)}:${formatLocalDate(bounds.endExclusive)}`
        : "3:invalid_period";
    }
    case "unknown":
      return `3:${value.reasonCode}`;
  }
}
