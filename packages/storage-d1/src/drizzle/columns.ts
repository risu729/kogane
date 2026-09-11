// Drizzle column types that go through this package's codecs (unified plan
// 09 §4; G4-11, G4-12).
//
// An ORM's job is to move a column value into a JS value. For four kinds of
// column that move is where meaning is lost, and the loss is silent:
//
// - a money coefficient read as a JS `number` rounds at 2^53 and turns
//   "1.10" into 1.1 — the exact text is the value, so it stays text;
// - a `YYYY-MM-DD` column read as a `Date` gains a time and a timezone
//   nobody wrote, shifting the day for half the world;
// - a `0`/`1` flag read with `Boolean(...)` turns the string "0" into `true`;
// - a NULL foreign key read as `0` invents row 0 as a parent.
//
// So the ORM does not get to decide any of them. Each column below is a
// `customType` whose `fromDriver`/`toDriver` call the same functions in
// `../codecs/` that the native-SQL path calls, and the types they produce are
// the domain's (`CivilDate`, the decimal-v1 column triple) rather than
// JavaScript's defaults. A column value that cannot be read as what the
// schema declares raises instead of being coerced: a query that returns a
// number where a coefficient belongs is a schema violation, and reporting it
// is the only answer that is not a lie.
import { customType } from "drizzle-orm/sqlite-core";
import type { CivilDate } from "../../../domain/src/time.ts";
import type { ValueStatus } from "../../../domain/src/values.ts";
import { decodeBoolean, encodeBoolean } from "../codecs/boolean.ts";
import { decodeDateOnly, encodeDateOnly } from "../codecs/date-only.ts";
import { readValueStatus } from "../codecs/decimal.ts";
import { isRowId } from "../codecs/nullable-id.ts";

/**
 * The coefficient half of a decimal-v1 pair: an arbitrary-precision integer
 * kept as TEXT, in and out, with no numeric type anywhere near it. A driver
 * value that is not text is refused rather than stringified, because
 * `String(1.1)` is not the digits somebody stored.
 */
export const decimalCoefficient = customType<{ data: string; driverData: string }>({
  dataType: () => "text",
  fromDriver: (value) => {
    if (typeof value !== "string") throw new Error("decimal_coefficient_not_text");
    return value;
  },
  toDriver: (value) => value,
});

/**
 * The scale half: a non-negative integer exponent. A fractional or unsafe
 * value is refused; rounding it would move the decimal point.
 */
export const decimalScale = customType<{ data: number; driverData: number }>({
  dataType: () => "integer",
  fromDriver: (value) => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      throw new Error("decimal_scale_invalid");
    return value;
  },
  toDriver: (value) => value,
});

/**
 * The status column of a decimal-v1 triple. An unreadable status reads as
 * `conflict` — "the stored value cannot be read" — never as `exact`, so no
 * caller can mistake a broken row for a number (`readValueStatus`).
 */
export const valueStatus = customType<{ data: ValueStatus; driverData: string }>({
  dataType: () => "text",
  fromDriver: (value) => readValueStatus(value),
  toDriver: (value) => value,
});

/**
 * A date-only column: `YYYY-MM-DD` text in the database, a `CivilDate` triple
 * in JavaScript. Never a `Date`, so no instant, offset or hour is invented; a
 * malformed or impossible date (`2026-02-30`) raises rather than rounding
 * into a neighbouring day.
 */
export const dateOnly = customType<{ data: CivilDate; driverData: string }>({
  dataType: () => "text",
  fromDriver: (value) => {
    const date = decodeDateOnly(value);
    if (date === null) throw new Error("date_only_invalid");
    return date;
  },
  toDriver: (value) => {
    const text = encodeDateOnly(value);
    if (text === null) throw new Error("date_only_invalid");
    return text;
  },
});

/**
 * A `0`/`1` flag. Only those two values are a boolean; anything else raises
 * instead of being read as "yes" (`decodeBoolean`).
 */
export const flag = customType<{ data: boolean; driverData: number }>({
  dataType: () => "integer",
  fromDriver: (value) => {
    const decoded = decodeBoolean(value);
    if (decoded === null) throw new Error("boolean_column_invalid");
    return decoded;
  },
  toDriver: (value) => encodeBoolean(value),
});

/**
 * An `INTEGER PRIMARY KEY` reference. NULL never reaches here (the driver
 * short-circuits it), so what this rejects is the other mistake: a zero,
 * negative or non-integer id that no row ever had (`isRowId`).
 */
export const rowId = customType<{ data: number; driverData: number }>({
  dataType: () => "integer",
  fromDriver: (value) => {
    if (!isRowId(value)) throw new Error("row_id_invalid");
    return value;
  },
  toDriver: (value) => value,
});
