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
  validRounding,
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

/**
 * mulberry32, the same step as `seededRandom` in `scripts/load-fixture.ts`.
 * Kept here so this file does not import the load-fixture harness.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canonicalSample(random: () => number): string {
  const negative = random() < 0.5;
  const scale = Math.floor(random() * 9);
  const integerLength = 1 + Math.floor(random() * 8);
  let integer = String(1 + Math.floor(random() * 9));
  for (let i = 1; i < integerLength; i += 1) integer += String(Math.floor(random() * 10));
  if (scale === 0) return `${negative ? "-" : ""}${integer}`;
  let fraction = "";
  for (let i = 0; i < scale - 1; i += 1) fraction += String(Math.floor(random() * 10));
  fraction += String(1 + Math.floor(random() * 9));
  return `${negative ? "-" : ""}${integer}.${fraction}`;
}

/** Leading zeros, a plus, trailing fractional zeros, or decimal-v1 whitespace around a canonical text. */
function noncanonicalSample(random: () => number, canonical: string): string {
  const pads = ["", " ", "\t", "\r\n"];
  const lead = pads[Math.floor(random() * pads.length)] ?? "";
  const trail = pads[Math.floor(random() * pads.length)] ?? "";
  const sign = canonical.startsWith("-") ? "-" : "";
  const body = sign === "" ? canonical : canonical.slice(1);
  const zeros = "0".repeat(Math.floor(random() * 4));
  const mode = Math.floor(random() * 3);
  let noisy = body;
  if (mode === 0 && body.includes("."))
    noisy = `${body}${"0".repeat(1 + Math.floor(random() * 3))}`;
  else if (mode === 1) noisy = `${zeros}${body}`;
  else noisy = `${zeros}${body}${body.includes(".") ? "00" : ".00"}`;
  if (sign === "" && random() < 0.5) noisy = `+${noisy}`;
  return `${lead}${sign}${noisy}${trail}`;
}

describe("exact decimal representation bounds", () => {
  test("canonical text round-trips inside the 4096-character parse window", () => {
    const texts = ["8".repeat(4096), `-${"8".repeat(4095)}`];
    for (const text of texts) {
      const parsed = decimalFromString(text);
      expect(parsed).toEqual({ ok: true, value: { coefficient: text, scale: 0 } });
      if (!parsed.ok) continue;
      expect(decimalToString(parsed.value)).toBe(text);
      expect(validExactDecimal(parsed.value)).toBe(true);
      expect(decimalFromString(decimalToString(parsed.value))).toEqual(parsed);
    }
    const plus = decimalFromString("+2.50");
    expect(plus).toEqual({ ok: true, value: { coefficient: "25", scale: 1 } });
    if (plus.ok) {
      expect(decimalToString(plus.value)).toBe("2.5");
      expect(validExactDecimal(plus.value)).toBe(true);
    }
    const plusZero = decimalFromString("+0");
    expect(plusZero).toEqual({ ok: true, value: { coefficient: "0", scale: 0 } });
    if (plusZero.ok) expect(decimalToString(plusZero.value)).toBe("0");
    expect(decimalFromString("\t8\r\n")).toEqual({
      ok: true,
      value: { coefficient: "8", scale: 0 },
    });
  });

  test("a fixed seed of canonical and noisy texts agrees after normalization", () => {
    const random = mulberry32(20261009);
    for (let i = 0; i < 32; i += 1) {
      const canonical = canonicalSample(random);
      const parsed = decimalFromString(canonical);
      expect([i, canonical, parsed.ok]).toEqual([i, canonical, true]);
      if (!parsed.ok) continue;
      expect([i, canonical, decimalToString(parsed.value)]).toEqual([i, canonical, canonical]);
      expect(validExactDecimal(parsed.value)).toBe(true);
      const noisy = noncanonicalSample(random, canonical);
      const normalized = decimalFromString(noisy);
      expect({
        i,
        noisy,
        normalized: normalized.ok ? decimalToString(normalized.value) : normalized,
      }).toEqual({
        i,
        noisy,
        normalized: canonical,
      });
    }
  });

  test("one character past 4096 is rejected as decimal text", () => {
    for (const text of ["8".repeat(4097), `-${"8".repeat(4096)}`]) {
      const parsed = decimalFromString(text);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error.code).toBe("invalid_decimal");
    }
  });

  test("scale 4096 is a valid decimal whose rendered text is outside the parse window", () => {
    const value = { coefficient: "1", scale: 4096 };
    expect(validExactDecimal(value)).toBe(true);
    const rendered = decimalToString(value);
    expect(rendered.length).toBe(4098);
    expect(rendered.startsWith("0.")).toBe(true);
    expect(rendered.endsWith("1")).toBe(true);
    expect(rendered.slice(2, -1)).toBe("0".repeat(4095));
    const parsed = decimalFromString(rendered);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe("invalid_decimal");
  });

  test("each representation check keeps its own bound", () => {
    // Length 4097 is not asserted. validExactDecimal allows it; decimal-v1 storage does not.
    expect(validExactDecimal({ coefficient: "8".repeat(4098), scale: 0 })).toBe(false);
    expect(validExactDecimal({ coefficient: `-${"8".repeat(4097)}`, scale: 0 })).toBe(false);
    expect(validExactDecimal({ coefficient: "1", scale: 4097 })).toBe(false);
    expect(validExactDecimal({ coefficient: "1", scale: -1 })).toBe(false);

    expect(validExactRatio({ numerator: "1", denominator: "4".repeat(4096) })).toBe(true);
    expect(validExactRatio({ numerator: "1", denominator: "4".repeat(4097) })).toBe(false);
    expect(validExactRatio({ numerator: "4".repeat(4097), denominator: "1" })).toBe(true);
    expect(validExactRatio({ numerator: "4".repeat(4098), denominator: "1" })).toBe(false);

    expect(validRounding({ scale: 4096, mode: "down" })).toBe(true);
    expect(validRounding({ scale: 4097, mode: "down" })).toBe(false);
    expect(validRounding({ scale: -1, mode: "down" })).toBe(false);
    expect(validRounding({ scale: 1.5, mode: "down" })).toBe(false);

    const exact = {
      status: "exact" as const,
      value: { coefficient: "1", scale: 0 },
    };
    expect(validValueState({ ...exact, normalizationVersion: "v".repeat(64) })).toBe(true);
    expect(validValueState({ ...exact, normalizationVersion: "v".repeat(65) })).toBe(false);
    expect(validValueState({ status: "missing", reasonCode: "r".repeat(128) })).toBe(true);
    expect(validValueState({ status: "missing", reasonCode: "r".repeat(129) })).toBe(false);
    expect(validValueState({ status: "missing", reasonCode: "" })).toBe(false);
    const state = {
      status: "exact" as const,
      value: { coefficient: "1", scale: 0 },
      normalizationVersion: "v",
    };
    expect(validQuantity({ unitRef: "u".repeat(128), value: state })).toBe(true);
    expect(validQuantity({ unitRef: "u".repeat(129), value: state })).toBe(false);

    const stored = (coefficient: string) =>
      fromNormalizedDecimal({
        policyVersion: "decimal-v1",
        status: "exact",
        coefficient,
        scale: 0,
        basis: "decimal_text",
      });
    expect(stored("8".repeat(4096))).toEqual({
      status: "exact",
      value: { coefficient: "8".repeat(4096), scale: 0 },
      normalizationVersion: "decimal-v1",
    });
    expect(stored(`-${"8".repeat(4095)}`)).toEqual({
      status: "exact",
      value: { coefficient: `-${"8".repeat(4095)}`, scale: 0 },
      normalizationVersion: "decimal-v1",
    });
    for (const coefficient of ["8".repeat(4097), `-${"8".repeat(4096)}`])
      expect(stored(coefficient)).toEqual({
        status: "unparsed",
        reasonCode: "normalized_decimal_invalid",
      });
  });

  test("non-canonical spellings and unknown fields stay rejected", () => {
    expect(validExactDecimal({ coefficient: "+1", scale: 0 })).toBe(false);
    expect(
      validValueState({
        status: "exact",
        value: { coefficient: "1", scale: 0 },
        normalizationVersion: "v",
        extra: true,
      }),
    ).toBe(false);
    expect(
      validValueState({
        status: "exact",
        value: { coefficient: "120", scale: 1 },
        normalizationVersion: "v",
      }),
    ).toBe(false);
    expect(
      validQuantity({
        unitRef: "u",
        value: {
          status: "exact",
          value: { coefficient: "0", scale: 2 },
          normalizationVersion: "v",
        },
      }),
    ).toBe(false);
    expect(validExactRatio({ numerator: "01", denominator: "1" })).toBe(false);
    expect(validExactRatio({ numerator: "+3", denominator: "1" })).toBe(false);
    expect(validRounding({ scale: 0, mode: "down", extra: 1 })).toBe(false);
    expect(validRounding({ scale: 0, mode: "bankers" })).toBe(false);
  });
});
