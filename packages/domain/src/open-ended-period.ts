// A period with a known first day and no end. Kept out of `time.ts` and out
// of `TemporalValue`: only fields that say so (an offer's validity) accept it.
import { hasExactKeys, isRecord } from "./guards.ts";
import {
  daysFromCivil,
  parseInstant,
  parseLocalDate,
  periodBounds,
  validLocalDateText,
  validZone,
  type TemporalOrder,
  type TemporalValue,
} from "./time.ts";

/** The provider announces no end date, so the value holds from `start` on. */
export interface OpenEndedPeriodValue {
  kind: "open-ended";
  /** First valid civil day, `YYYY-MM-DD`. */
  start: string;
  zone: string | null;
}

export function validOpenEndedPeriodValue(value: unknown): value is OpenEndedPeriodValue {
  return (
    isRecord(value) &&
    value.kind === "open-ended" &&
    hasExactKeys(value, ["kind", "start", "zone"]) &&
    validLocalDateText(value.start) &&
    (value.zone === null || validZone(value.zone))
  );
}

/** Civil-day interval `[start, endExclusive)` of a known value; an instant counts by its own date. */
function days(value: Exclude<TemporalValue, { kind: "unknown" }>): {
  start: number;
  endExclusive: number;
} | null {
  if (value.kind === "period") {
    const bounds = periodBounds(value);
    return bounds
      ? { start: daysFromCivil(bounds.start), endExclusive: daysFromCivil(bounds.endExclusive) }
      : null;
  }
  const text = value.kind === "instant" ? parseInstant(value.value)?.localDate : value.value;
  const date = text === undefined ? null : parseLocalDate(text);
  return date ? { start: daysFromCivil(date), endExclusive: daysFromCivil(date) + 1 } : null;
}

/**
 * `a` against an open-ended period: `-1` when it lies wholly before the first
 * day, `0` when it lies wholly on or after it. A value straddling the first
 * day is `overlap`; zone mismatch and unknown time stay incomparable, with the
 * zone rule of `compareTemporal` (`null` is compatible with any zone).
 */
export function compareToOpenEnded(a: TemporalValue, b: OpenEndedPeriodValue): TemporalOrder {
  if (a.kind === "unknown") return { kind: "incomparable", reasonCode: "unknown_time" };
  const startDate = parseLocalDate(b.start);
  if (!startDate) return { kind: "incomparable", reasonCode: "unknown_time" };
  if (a.zone !== null && b.zone !== null && a.zone !== b.zone)
    return { kind: "incomparable", reasonCode: "zone_mismatch" };
  const interval = days(a);
  if (!interval) return { kind: "incomparable", reasonCode: "unknown_time" };
  const start = daysFromCivil(startDate);
  if (interval.start >= start) return { kind: "ordered", order: 0 };
  if (interval.endExclusive <= start) return { kind: "ordered", order: -1 };
  return { kind: "incomparable", reasonCode: "overlap" };
}
