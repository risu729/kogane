// `collection-freshness-v1` (ADR 0045, amendment of 2026-11-08): how old the
// data a source or a collection-quality cell stands on is, in Asia/Tokyo
// civil days, and a closed state for it. The thresholds are those of
// `dated-state-freshness-v1` (reported-state.ts): `same-day` (age 0),
// `recent` (1 to 3 days), `stale` (more). A capture that is not fresh is
// further explained by what its source waits on, when its stored settings or
// receipts say so: `human-required` (collection is by hand, or the last
// attempt stopped on a "a person must act" code) or `disabled` (no
// collection job of the source is enabled). `no-capture` is no capture at all
// (or, for a cell, no current one) with nothing stored that explains it.
//
// The age is a count of civil days between two dates; nothing here reads an
// amount, and nothing is inferred from a provider's schedule.
import {
  civilFromDays,
  daysBetween,
  formatLocalDate,
  parseInstant,
  parseLocalDate,
} from "./time.ts";

export const COLLECTION_FRESHNESS_POLICY = "collection-freshness-v1";
/** Same as `dated-state-freshness-v1`. */
const RECENT_DAYS = 3;

export const COLLECTION_FRESHNESS_STATES = [
  "same-day",
  "recent",
  "stale",
  "human-required",
  "disabled",
  "no-capture",
] as const;
export type CollectionFreshnessState = (typeof COLLECTION_FRESHNESS_STATES)[number];

/** What a source waits on, from its stored settings and receipts; null when nothing. */
export type CollectionWait = "human-required" | "disabled" | null;

export interface CollectionFreshness {
  state: CollectionFreshnessState;
  /** Civil days (Asia/Tokyo) from the capture's date to the as-of date; null with no capture. */
  ageDays: number | null;
}

/** Asia/Tokyo is UTC+9 with no daylight saving time. */
const TOKYO_OFFSET_SECONDS = 9 * 3600;

/** The Asia/Tokyo civil date of an instant (any offset), or null when it is not one. */
export function tokyoDate(instant: string): string | null {
  const parsed = parseInstant(instant);
  if (parsed === null) return null;
  return formatLocalDate(
    civilFromDays(Math.floor((parsed.epochSeconds + TOKYO_OFFSET_SECONDS) / 86400)),
  );
}

function ageState(ageDays: number): "same-day" | "recent" | "stale" {
  return ageDays === 0 ? "same-day" : ageDays <= RECENT_DAYS ? "recent" : "stale";
}

/**
 * The freshness of data captured at `capturedAt` (null: none) on `asOfDate`.
 * A fresh capture is `same-day` or `recent` whatever the source waits on; a
 * stale or missing one is explained by the wait when there is one. A capture
 * dated after the as-of date (a collector clock ahead of the reader's) is age
 * 0, never a negative age.
 */
export function collectionFreshness(
  capturedAt: string | null,
  asOfDate: string,
  wait: CollectionWait,
): CollectionFreshness {
  const asked = parseLocalDate(asOfDate);
  if (asked === null) throw new Error("invalid_as_of");
  if (capturedAt === null) return { state: wait ?? "no-capture", ageDays: null };
  const captured = tokyoDate(capturedAt);
  if (captured === null) throw new Error("invalid_capture_time");
  const ageDays = Math.max(0, daysBetween(parseLocalDate(captured)!, asked));
  const byAge = ageState(ageDays);
  return { state: byAge === "stale" && wait !== null ? wait : byAge, ageDays };
}

/** Whether a state and an age can come from `collectionFreshness`. */
export function consistentFreshness(value: CollectionFreshness): boolean {
  const { state, ageDays } = value;
  if (ageDays === null)
    return state === "no-capture" || state === "human-required" || state === "disabled";
  if (!Number.isInteger(ageDays) || ageDays < 0) return false;
  const byAge = ageState(ageDays);
  return byAge === "stale"
    ? state !== "no-capture" && state !== "same-day" && state !== "recent"
    : state === byAge;
}
