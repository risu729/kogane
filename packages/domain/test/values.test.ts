import { describe, expect, test } from "bun:test";
import {
  addDecimals,
  addQuantities,
  compareDecimals,
  compareQuantities,
  decimalFromString,
  decimalLiteral,
  decimalToString,
  divideDecimals,
  fromNormalizedDecimal,
  integerDecimal,
  multiplyByRatio,
  multiplyDecimals,
  negateDecimal,
  normalizeDecimal,
  quantityFromNormalizedDecimal,
  scaleQuantity,
  subtractDecimals,
  subtractQuantities,
  sumQuantities,
  validExactDecimal,
  validExactRatio,
  validQuantity,
  validValueState,
} from "../src/values.ts";
import { q } from "./helpers.ts";

describe("ExactDecimal canonical form", () => {
  test("accepts canonical values and rejects non-canonical or unknown-key shapes", () => {
    expect(validExactDecimal({ coefficient: "0", scale: 0 })).toBe(true);
    expect(validExactDecimal({ coefficient: "-1234", scale: 2 })).toBe(true);
    expect(validExactDecimal({ coefficient: "100", scale: 0 })).toBe(true);
    expect(validExactDecimal({ coefficient: "-0", scale: 0 })).toBe(false);
    expect(validExactDecimal({ coefficient: "0", scale: 2 })).toBe(false);
    expect(validExactDecimal({ coefficient: "120", scale: 1 })).toBe(false);
    expect(validExactDecimal({ coefficient: "007", scale: 0 })).toBe(false);
    expect(validExactDecimal({ coefficient: 12, scale: 0 })).toBe(false);
    expect(validExactDecimal({ coefficient: "1", scale: 1.5 })).toBe(false);
    expect(validExactDecimal({ coefficient: "1", scale: 0, extra: true })).toBe(false);
    expect(validExactDecimal({ coefficient: "1", scale: 0, __proto__: { polluted: 1 } })).toBe(
      true,
    );
    expect(validExactDecimal(JSON.parse('{"coefficient":"1","scale":0,"__proto__":{}}'))).toBe(
      false,
    );
  });

  test("parses decimal text under decimal-v1 rules", () => {
    expect(decimalFromString("-0.000")).toEqual({
      ok: true,
      value: { coefficient: "0", scale: 0 },
    });
    expect(decimalFromString(".001")).toEqual({ ok: true, value: { coefficient: "1", scale: 3 } });
    expect(decimalFromString("1.20")).toEqual({ ok: true, value: { coefficient: "12", scale: 1 } });
    expect(decimalFromString(" 007 ")).toEqual({ ok: true, value: { coefficient: "7", scale: 0 } });
    expect(decimalFromString("-00012.3400")).toEqual({
      ok: true,
      value: { coefficient: "-1234", scale: 2 },
    });
    for (const invalid of ["", "1.", "1e-3", "0 EUR", "--1", "0.1.0", "１"]) {
      const parsed = decimalFromString(invalid);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error.code).toBe("invalid_decimal");
    }
    expect(() => decimalLiteral("1.")).toThrow(RangeError);
  });

  test("keeps huge coefficients exact and round-trips text", () => {
    const huge = `9${"0".repeat(400)}.${"0".repeat(399)}1`;
    const parsed = decimalLiteral(huge);
    expect(parsed.scale).toBe(400);
    expect(decimalToString(parsed)).toBe(huge);
    expect(decimalToString(decimalLiteral("-0.001"))).toBe("-0.001");
    expect(decimalToString(decimalLiteral("50.1"))).toBe("50.1");
    expect(decimalToString(integerDecimal(-42))).toBe("-42");
    expect(() => integerDecimal(2 ** 53)).toThrow(RangeError);
  });

  test("normalizes negative zero and trailing zeros", () => {
    expect(normalizeDecimal(-0n, 3)).toEqual({ coefficient: "0", scale: 0 });
    expect(normalizeDecimal(1200n, 2)).toEqual({ coefficient: "12", scale: 0 });
    expect(normalizeDecimal(5n, -2)).toEqual({ coefficient: "500", scale: 0 });
    expect(subtractDecimals(decimalLiteral("0.5"), decimalLiteral("0.5"))).toEqual({
      coefficient: "0",
      scale: 0,
    });
  });
});

describe("exact arithmetic", () => {
  test("adds, subtracts, compares and negates across scales", () => {
    expect(addDecimals(decimalLiteral("0.999"), decimalLiteral("0.001"))).toEqual(
      integerDecimal(1),
    );
    expect(addDecimals(decimalLiteral("1.5"), integerDecimal(-2))).toEqual(decimalLiteral("-0.5"));
    expect(compareDecimals(decimalLiteral("1.10"), decimalLiteral("1.1"))).toBe(0);
    expect(compareDecimals(decimalLiteral("-1.01"), decimalLiteral("-1.1"))).toBe(1);
    expect(negateDecimal(integerDecimal(0))).toEqual(integerDecimal(0));
    expect(multiplyDecimals(decimalLiteral("0.1"), decimalLiteral("0.1"))).toEqual(
      decimalLiteral("0.01"),
    );
  });

  test("multiplies by exact ratios and refuses inexact results without a rounding instruction", () => {
    expect(
      multiplyByRatio(integerDecimal(12500), { numerator: "8000", denominator: "10000" }),
    ).toEqual({
      ok: true,
      value: integerDecimal(10000),
    });
    expect(multiplyByRatio(integerDecimal(2500), { numerator: "1", denominator: "2" })).toEqual({
      ok: true,
      value: integerDecimal(1250),
    });
    const third = multiplyByRatio(integerDecimal(1), { numerator: "1", denominator: "3" });
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.error.code).toBe("inexact_result");
    expect(multiplyByRatio(integerDecimal(1), { numerator: "1", denominator: "0" })).toMatchObject({
      ok: false,
      error: { code: "invalid_ratio" },
    });
    expect(validExactRatio({ numerator: "-3", denominator: "4" })).toBe(true);
    expect(validExactRatio({ numerator: "3", denominator: "-4" })).toBe(false);
    expect(validExactRatio({ numerator: "3", denominator: "4", extra: 1 })).toBe(false);
  });

  test("divides exactly or by an explicit rounding position and mode", () => {
    expect(divideDecimals(integerDecimal(1002), integerDecimal(20))).toEqual({
      ok: true,
      value: { coefficient: "501", scale: 1 },
    });
    expect(divideDecimals(integerDecimal(95000), integerDecimal(1000))).toEqual({
      ok: true,
      value: integerDecimal(95),
    });
    expect(divideDecimals(integerDecimal(1), integerDecimal(0))).toMatchObject({
      ok: false,
      error: { code: "division_by_zero" },
    });
    const cases: [string, string, number, string, string][] = [
      ["2", "3", 2, "down", "0.66"],
      ["2", "3", 2, "up", "0.67"],
      ["-2", "3", 2, "down", "-0.66"],
      ["-2", "3", 2, "floor", "-0.67"],
      ["-2", "3", 2, "ceiling", "-0.66"],
      ["2.5", "1", 0, "half-up", "3"],
      ["-2.5", "1", 0, "half-up", "-3"],
      ["2.5", "1", 0, "half-even", "2"],
      ["3.5", "1", 0, "half-even", "4"],
      ["2500", "1000", 0, "down", "2"],
    ];
    for (const [a, b, scale, mode, expected] of cases) {
      const result = divideDecimals(decimalLiteral(a), decimalLiteral(b), {
        scale,
        mode: mode as "down",
      });
      expect(result).toEqual({ ok: true, value: decimalLiteral(expected) });
    }
  });
});

describe("quantities", () => {
  test("never adds different units (INV03)", () => {
    const result = addQuantities(q("JPY", "6000"), q("points:program-a", "800"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("unit_mismatch");
      expect(result.error.refs).toEqual(["JPY", "points:program-a"]);
    }
    expect(sumQuantities("AUD", [q("AUD", "1005"), q("JPY", "95000")])).toMatchObject({
      ok: false,
      error: { code: "unit_mismatch" },
    });
  });

  test("never coerces missing, unparsed or conflicting values to zero (INV05)", () => {
    const missing = {
      unitRef: "JPY",
      value: { status: "missing" as const, reasonCode: "decimal-v1:missing" },
    };
    for (const result of [
      addQuantities(q("JPY", "100"), missing),
      subtractQuantities(q("JPY", "100"), missing),
      sumQuantities("JPY", [q("JPY", "100"), missing]),
      compareQuantities(missing, q("JPY", "0")),
      scaleQuantity(missing, { numerator: "1", denominator: "2" }),
    ]) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("value_not_exact");
        expect(result.error.refs).toEqual(["missing:decimal-v1:missing"]);
      }
    }
    expect(sumQuantities("JPY", [])).toEqual({ ok: true, quantity: q("JPY", "0") });
  });

  test("adapts decimal-v1 rows without inventing values", () => {
    expect(
      fromNormalizedDecimal({
        policyVersion: "decimal-v1",
        status: "exact",
        coefficient: "120",
        scale: 1,
        basis: "decimal_text",
      }),
    ).toEqual({
      status: "exact",
      value: { coefficient: "12", scale: 0 },
      normalizationVersion: "decimal-v1",
    });
    for (const status of ["missing", "unparsed", "conflict"] as const)
      expect(
        fromNormalizedDecimal({
          policyVersion: "decimal-v1",
          status,
          coefficient: null,
          scale: null,
          basis: "none",
        }),
      ).toEqual({ status, reasonCode: `decimal-v1:${status}` });
    expect(
      quantityFromNormalizedDecimal("JPY", {
        policyVersion: "decimal-v1",
        status: "exact",
        coefficient: "-0",
        scale: 0,
        basis: "minor_units",
      }),
    ).toEqual({
      unitRef: "JPY",
      value: { status: "unparsed", reasonCode: "normalized_decimal_invalid" },
    });
  });

  test("validators reject unknown keys and wrong shapes", () => {
    expect(validQuantity(q("JPY", "1"))).toBe(true);
    expect(validQuantity({ ...q("JPY", "1"), note: "x" })).toBe(false);
    expect(validQuantity({ unitRef: "", value: q("JPY", "1").value })).toBe(false);
    expect(validValueState({ status: "missing", reasonCode: "x" })).toBe(true);
    expect(
      validValueState({
        status: "missing",
        reasonCode: "x",
        value: { coefficient: "0", scale: 0 },
      }),
    ).toBe(false);
    expect(validValueState({ status: "exact", value: { coefficient: "1", scale: 0 } })).toBe(false);
    expect(validValueState({ status: "zero", reasonCode: "x" })).toBe(false);
  });
});
