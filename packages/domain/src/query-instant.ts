// An instant as a read's time filter takes it (`kogane.changes.since`'s
// `since`, the activity list's `since` and `before`): a date, a time to the
// minute or the second with at most three fraction digits, and a zone (`Z`
// or an offset up to ±23:59). No bare date, no local time.
//
// It is pure arithmetic on the written fields, never `Date.parse`: a parser
// that rolls `02-30` or `24:00` over to another instant is not trusted with
// it, and `Date.UTC` reads the years 0 to 99 as 1900 to 1999. The years are
// taken as written, 0000 to 9999, proleptic Gregorian.
//
// Its ISO form (`toISOString`, milliseconds, `Z`) is what the stores compare
// as text, in `strftime`'s four-digit years: an instant whose UTC form leaves
// them (`+010000-…`, `-000001-…`) is a real time but not one such a text
// comparison orders, so it is told apart (`range`) from a malformed one.
import { daysFromCivil, daysInMonth } from "./time.ts";

/** A date, a time and a zone; the capture groups are the written fields. */
const QUERY_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/u;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export type QueryInstant =
  /** A real calendar time whose UTC form is within the years 0000 to 9999. */
  | { ok: true; iso: string; epochMs: number }
  /** Not an instant of this form, or not a real calendar time (`02-30`, `24:00`, `:60`, `+24:00`). */
  | { ok: false; reason: "format" }
  /** A real calendar time whose UTC form leaves the years 0000 to 9999. */
  | { ok: false; reason: "range"; epochMs: number };

/** The instant `text` names, or why it names none a time filter can take. */
export function parseQueryInstant(text: string): QueryInstant {
  const match = QUERY_INSTANT.exec(text);
  if (match === null) return { ok: false, reason: "format" };
  const [, y, mo, d, h, mi, s = "0", fraction = "", zone, sign, oh = "0", om = "0"] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  const offsetHours = Number(oh);
  const offsetMinutes = Number(om);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHours > 23 ||
    offsetMinutes > 59
  )
    return { ok: false, reason: "format" };
  const offsetMs =
    zone === "Z" ? 0 : (sign === "-" ? -1 : 1) * (offsetHours * 60 + offsetMinutes) * MINUTE_MS;
  const epochMs =
    daysFromCivil({ year, month, day }) * DAY_MS +
    ((hour * 60 + minute) * 60 + second) * 1000 +
    Number(fraction.padEnd(3, "0")) -
    offsetMs;
  const iso = new Date(epochMs).toISOString();
  return /^\d{4}-/u.test(iso)
    ? { ok: true, iso, epochMs }
    : { ok: false, reason: "range", epochMs };
}
