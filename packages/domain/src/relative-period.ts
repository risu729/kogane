// Relative statement labels, resolved from the capture time (docs/observations.md,
// "Relative period labels are resolved from the capture time").
//
// Some providers name a statement month only by its position on the day it is
// shown: MyJCB's `detailMonth-N`, which the collector stores for every month
// the past-months API does not label. The label is raw evidence and is never
// resolved at collection time or rewritten afterwards. Its calendar month is an
// interpretation, derived here from the capture time of the artifact that
// carries the label plus the relative index, so it stays reproducible from the
// evidence. The rule is versioned like any other: a corrected rule is a new
// version, re-derived from the same captures, never an edit of a stored label,
// a parser version or an observation digest.
//
// Nothing here reads storage or a clock: the capture time is an input.
import { addMonths, civilFromDays, parseInstant, type CivilDate } from "./time.ts";

/** The version of the derivation below; a changed rule is a new version. */
export const RELATIVE_PERIOD_RULE = "relative-statement-period-v1";
/** A relative label names a position on a Japanese civil day. */
export const RELATIVE_PERIOD_ZONE = "Asia/Tokyo";

/** Fixed offsets of the zones a rule names. Japan has kept +09:00, without DST, since 1951. */
const ZONE_OFFSET_SECONDS: Readonly<Record<string, number>> = { "Asia/Tokyo": 9 * 3600 };

/**
 * The civil date of an instant (`2026-09-15T15:00:00.000Z`, or with an explicit
 * offset) in `zone`. Null for text that is not an instant, and for a zone
 * without a fixed offset here: a guessed offset would move captures near
 * midnight into the wrong day.
 */
export function civilDateInZone(instant: string, zone: string): CivilDate | null {
  const offset = ZONE_OFFSET_SECONDS[zone];
  const parsed = parseInstant(instant);
  if (offset === undefined || parsed === null) return null;
  return civilFromDays(Math.floor((parsed.epochSeconds + offset) / 86_400));
}

/**
 * JCB closes a billing cycle on the 15th and collects it in the following
 * month (docs/sources/myjcb.md), so usage on day d of month m is paid in m + 1
 * when d is at most 15 and in m + 2 after it. That position 0 moves to the new
 * cycle on the 16th follows this published schedule and is not verified: no
 * production capture falls on days 12–30 yet (docs/observations.md).
 */
export const MYJCB_CLOSING_DAY = 15;
/** The collector's relative fallback: `detailMonth-0` … `detailMonth-17`. */
const MYJCB_LABEL = /^detailMonth-(0|[1-9]|1[0-7])$/u;
/**
 * Positions below this are resolved: 0, the statement still accumulating, and
 * 1, the newest closed one. The production captures place exactly these two
 * (every row of each falls in the cycle the rule names, on both sides of a
 * month boundary). They place nothing beyond: menu months 2–8 carried no row,
 * and the past-months API's absolutely labelled N = 10 and 13 are two months
 * off `P0 − N`, so the provider's numbering is not one uniform month offset
 * and a longer reach would be a guess.
 */
const MYJCB_RESOLVED_POSITIONS = 2;

const yearMonth = (date: CivilDate): string =>
  `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}`;

/**
 * The absolute statement month (`YYYY-MM`) a relative label names, resolved
 * from the capture time of the artifact that carries it
 * (`relative-statement-period-v1`), or null when the rule does not place it.
 *
 * MyJCB `detailMonth-N`: let d be the capture's civil date in Asia/Tokyo and
 * P0 the payment month of the statement usage on d is billed to, the month of
 * d plus 1 on the 1st–15th and plus 2 from the 16th. `detailMonth-0` is P0 and
 * `detailMonth-1` is P0 − 1: payment months, the meaning
 * `card_statement_facts.period` has for the same provider (the statement
 * parser takes it from the payment date). Every other position, source or
 * shape, and an unreadable capture time, is null.
 */
export function resolveRelativePeriod(input: {
  sourceId: string;
  label: string | null;
  /** The `fetched_at` of the artifact the label was read from. */
  fetchedAt: string | null;
}): string | null {
  if (input.sourceId !== "myjcb" || input.label === null || input.fetchedAt === null) return null;
  const match = MYJCB_LABEL.exec(input.label);
  const position = match ? Number(match[1]) : Number.NaN;
  if (!(position < MYJCB_RESOLVED_POSITIONS)) return null;
  const captured = civilDateInZone(input.fetchedAt, RELATIVE_PERIOD_ZONE);
  if (captured === null) return null;
  const months = (captured.day <= MYJCB_CLOSING_DAY ? 1 : 2) - position;
  return yearMonth(
    addMonths({ year: captured.year, month: captured.month, day: 1 }, months, "clamp"),
  );
}
