// Date-only columns ⇄ `CivilDate`.
//
// A statement date, a value date or a period bound is a calendar date, not an
// instant: storing it as epoch milliseconds would attach a timezone nobody
// declared and shift the date for half the world. CORE stores it as the exact
// text `YYYY-MM-DD`, which also sorts and compares correctly in SQLite.
import { formatLocalDate, parseLocalDate, type CivilDate } from "../../../domain/src/time.ts";

/** The text a date column holds, or null. */
export function encodeDateOnly(date: CivilDate | null): string | null {
  return date === null ? null : formatLocalDate(date);
}

/**
 * The date a column holds. A malformed or impossible date (2026-02-30) reads
 * back as null rather than being rounded into a neighbouring day.
 */
export function decodeDateOnly(value: unknown): CivilDate | null {
  return typeof value === "string" ? parseLocalDate(value) : null;
}

/** Whether a column value is a well-formed, existing calendar date. */
export function isDateOnly(value: unknown): value is string {
  return decodeDateOnly(value) !== null;
}
