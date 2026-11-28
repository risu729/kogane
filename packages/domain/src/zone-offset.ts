// The UTC offsets time zones use. Kept apart from time.ts, which deployed
// parsers import: their code digests cover time.ts, and the same parser
// version may not carry a second digest (migration 0028).
import { validInstantText } from "./time.ts";

/** The UTC offsets, in minutes, that time zones use: -12:00 to +14:00. */
const ZONE_OFFSET_MINUTES = { min: -12 * 60, max: 14 * 60 } as const;

/**
 * An instant whose UTC offset is one a time zone uses, from -12:00 to +14:00
 * (the span of the IANA fixed-offset zones `Etc/GMT+12` to `Etc/GMT-14`).
 * `parseInstant` reads offsets up to ±18:59; a reader that names the offset's
 * zone, or that hands the instant to SQLite's `julianday` (which reads offsets
 * up to ±14:59 and returns NULL for any larger one), refuses one outside this
 * span rather than name a zone that does not exist or compare against nothing.
 */
export function validZoneOffsetInstantText(value: unknown): value is string {
  if (!validInstantText(value)) return false;
  if (value.endsWith("Z")) return true;
  const sign = value.at(-6) === "-" ? -1 : 1;
  const minutes = sign * (Number(value.slice(-5, -3)) * 60 + Number(value.slice(-2)));
  return minutes >= ZONE_OFFSET_MINUTES.min && minutes <= ZONE_OFFSET_MINUTES.max;
}
