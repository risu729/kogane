// Civil dates of instants in named zones (ADR 0056). This is the domain's
// only reader of time-zone data: `civilDateOfInstant` and `canonicalZone` ask
// the runtime's own `Intl.DateTimeFormat` for the civil date of an instant in
// a named zone and for the zone's spelling, and return null for a zone the
// runtime does not know, never UTC. Nothing here turns a date into an
// instant. It lives apart from time.ts, which embeds no zone data and is part
// of the parser digest closure (packages/parsers/src/parsers/digests.ts).
import { daysFromCivil, formatLocalDate, parseInstant, parseLocalDate, validZone } from "./time.ts";

/** One formatter per zone name, or null for a zone the runtime does not know. */
const CIVIL_DATE_FORMATS = new Map<string, Intl.DateTimeFormat | null>();

function civilDateFormat(zone: string): Intl.DateTimeFormat | null {
  if (CIVIL_DATE_FORMATS.has(zone)) return CIVIL_DATE_FORMATS.get(zone)!;
  let format: Intl.DateTimeFormat | null;
  try {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    format = null;
  }
  // Bounded by the zone names a process meets; an unknown one is cached as null.
  if (CIVIL_DATE_FORMATS.size < 1024) CIVIL_DATE_FORMATS.set(zone, format);
  return format;
}

/**
 * The runtime's own spelling of a zone name (`resolvedOptions().timeZone`:
 * `asia/tokyo` is `Asia/Tokyo`), or null for a zone it does not know. Whether
 * an alias (`Japan`) maps to its target depends on the runtime; this does not
 * guess.
 */
export function canonicalZone(zone: string): string | null {
  if (!validZone(zone)) return null;
  return civilDateFormat(zone)?.resolvedOptions().timeZone ?? null;
}

/**
 * The civil date (`YYYY-MM-DD`) of an RFC 3339 instant in a named IANA zone,
 * from the runtime's zone data (`Intl.DateTimeFormat("en-CA", { timeZone })`,
 * the pattern packages/collection/src/schedule-model.ts uses). Null when the
 * text is not an instant, the zone is not a zone name, or the runtime does not
 * know the zone: an unknown zone is never read as UTC. A result more than one
 * day from the instant's UTC date (a runtime that renders an era year) is
 * refused as well.
 */
export function civilDateOfInstant(text: string, zone: string): string | null {
  const parsed = parseInstant(text);
  if (parsed === null || !validZone(zone)) return null;
  const format = civilDateFormat(zone);
  if (format === null) return null;
  const parts = format.formatToParts(parsed.epochSeconds * 1000);
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const text10 = `${part("year").padStart(4, "0")}-${part("month")}-${part("day")}`;
  const date = parseLocalDate(text10);
  if (date === null) return null;
  const utcDay = Math.floor(parsed.epochSeconds / 86400);
  if (Math.abs(daysFromCivil(date) - utcDay) > 1) return null;
  return formatLocalDate(date);
}
