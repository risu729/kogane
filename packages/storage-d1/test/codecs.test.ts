// The column codecs, with one test per value each must never produce.
import { describe, expect, test } from "bun:test";
import {
  decodeBoolean,
  decodeBooleanOr,
  decodeDateOnly,
  decodeDecimal,
  decodeNullableId,
  encodeBoolean,
  encodeDateOnly,
  encodeDecimal,
  encodeNullableId,
  isRowId,
  isTrue,
  readValueStatus,
  requireRowId,
} from "../src/codecs/index.ts";
import type { ValueState } from "../../domain/src/values.ts";

describe("decimal-v1 columns", () => {
  test("an exact value round-trips through the three columns", () => {
    const value: ValueState = {
      status: "exact",
      value: { coefficient: "-12345", scale: 2 },
      normalizationVersion: "decimal-v1",
    };
    const columns = encodeDecimal(value);
    expect(columns).toEqual({ coefficient: "-12345", scale: 2, status: "exact" });
    expect(decodeDecimal(columns)).toEqual(value);
  });

  test("a coefficient wider than any float survives unchanged", () => {
    const coefficient = "9".repeat(60);
    const columns = encodeDecimal({
      status: "exact",
      value: { coefficient, scale: 18 },
      normalizationVersion: "decimal-v1",
    });
    expect(columns.coefficient).toBe(coefficient);
    const decoded = decodeDecimal(columns);
    expect(decoded.status === "exact" && decoded.value.coefficient).toBe(coefficient);
  });

  test("missing, unparsed and conflicting values write NULL and never decode as zero", () => {
    for (const status of ["missing", "unparsed", "conflict"] as const) {
      const columns = encodeDecimal({ status, reasonCode: "value_not_exact" });
      expect(columns).toEqual({ coefficient: null, scale: null, status });
      const decoded = decodeDecimal(columns);
      expect(decoded.status).toBe(status);
      expect(decoded).not.toHaveProperty("value");
    }
  });

  test("an exact row whose columns are not a decimal-v1 pair reads as a conflict", () => {
    expect(decodeDecimal({ coefficient: null, scale: null, status: "exact" }).status).toBe(
      "conflict",
    );
    // Leading zeros, a negative scale and a non-canonical "-0" are all forms
    // the schema forbids; none of them may become a number.
    expect(decodeDecimal({ coefficient: "007", scale: 0, status: "exact" }).status).toBe("conflict");
    expect(decodeDecimal({ coefficient: "1", scale: -1, status: "exact" }).status).toBe("conflict");
    expect(decodeDecimal({ coefficient: "-0", scale: 0, status: "exact" }).status).toBe("conflict");
  });

  test("an unreadable status column is a conflict, never an exact value", () => {
    expect(readValueStatus("exact")).toBe("exact");
    expect(readValueStatus("ok")).toBe("conflict");
    expect(readValueStatus(null)).toBe("conflict");
    expect(readValueStatus(1)).toBe("conflict");
  });
});

describe("date-only columns", () => {
  test("a calendar date round-trips as YYYY-MM-DD text", () => {
    expect(encodeDateOnly({ year: 2026, month: 9, day: 7 })).toBe("2026-09-07");
    expect(decodeDateOnly("2026-09-07")).toEqual({ year: 2026, month: 9, day: 7 });
    expect(encodeDateOnly(null)).toBeNull();
  });

  test("a date that does not exist reads back as null, not as a neighbouring day", () => {
    expect(decodeDateOnly("2026-02-30")).toBeNull();
    expect(decodeDateOnly("2026-13-01")).toBeNull();
    expect(decodeDateOnly("2026-9-7")).toBeNull();
    expect(decodeDateOnly("2026-09-07T00:00:00Z")).toBeNull();
    expect(decodeDateOnly(20260907)).toBeNull();
  });

  test("a leap day is a date in a leap year and not in a common one", () => {
    expect(decodeDateOnly("2024-02-29")).toEqual({ year: 2024, month: 2, day: 29 });
    expect(decodeDateOnly("2026-02-29")).toBeNull();
  });
});

describe("boolean columns", () => {
  test("only 0 and 1 are booleans; anything else is unreadable", () => {
    expect(encodeBoolean(true)).toBe(1);
    expect(encodeBoolean(false)).toBe(0);
    expect(decodeBoolean(1)).toBe(true);
    expect(decodeBoolean(0)).toBe(false);
    expect(decodeBoolean("1")).toBeNull();
    expect(decodeBoolean(null)).toBeNull();
    expect(decodeBoolean(2)).toBeNull();
  });

  test('the string "0" never reads as true, the way Boolean() would', () => {
    expect(Boolean("0")).toBe(true);
    expect(isTrue("0")).toBe(false);
    expect(decodeBooleanOr("0", false)).toBe(false);
    // An unreadable flag takes the caller's stated default, not a coincidence.
    expect(decodeBooleanOr(undefined, true)).toBe(true);
  });
});

describe("nullable id columns", () => {
  test("a NULL reference reads as null, never as row 0", () => {
    expect(decodeNullableId(null)).toBeNull();
    expect(decodeNullableId(0)).toBeNull();
    expect(decodeNullableId(-1)).toBeNull();
    expect(decodeNullableId(1.5)).toBeNull();
    expect(decodeNullableId("7")).toBeNull();
    expect(decodeNullableId(7)).toBe(7);
    expect(isRowId(0)).toBe(false);
  });

  test("a required id throws with the caller's code instead of being invented", () => {
    expect(requireRowId(7, "run_not_found")).toBe(7);
    expect(() => requireRowId(null, "run_not_found")).toThrow("run_not_found");
    expect(encodeNullableId(undefined)).toBeNull();
    expect(encodeNullableId(null)).toBeNull();
    expect(encodeNullableId(7)).toBe(7);
  });
});
