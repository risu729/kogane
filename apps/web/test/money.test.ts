// `formatDecimal` is the client's one display format for an exact decimal:
// integer digits grouped in threes, the minus the decimal carries, and every
// fraction digit at the decimal's own scale, with no Number on the way.
import { expect, test } from "bun:test";
import type { ExactDecimal } from "../../../packages/domain/src/values.ts";
import { formatAmount, formatDecimal, formatDecimalText, minorUnitExponent } from "../src/money.ts";

const exact = (coefficient: string, scale: number): ExactDecimal => ({ coefficient, scale });

test("integer digits are grouped in threes at every length", () => {
  expect(formatDecimal(exact("1", 0))).toBe("1");
  expect(formatDecimal(exact("123", 0))).toBe("123");
  expect(formatDecimal(exact("1234", 0))).toBe("1,234");
  expect(formatDecimal(exact("123456", 0))).toBe("123,456");
  expect(formatDecimal(exact("1234567", 0))).toBe("1,234,567");
});

test("zero is 0, with no sign and no places", () => {
  expect(formatDecimal(exact("0", 0))).toBe("0");
});

test("a negative value keeps its minus before the first group", () => {
  expect(formatDecimal(exact("-1234", 0))).toBe("-1,234");
  expect(formatDecimal(exact("-123", 0))).toBe("-123");
  expect(formatDecimal(exact("-1234567", 3))).toBe("-1,234.567");
});

test("every fraction digit is kept, ungrouped, at the decimal's own scale", () => {
  expect(formatDecimal(exact("12345678901234567890", 15))).toBe("12,345.678901234567890");
  expect(formatDecimal(exact("123450", 2))).toBe("1,234.50");
  expect(formatDecimal(exact("1", 18))).toBe("0.000000000000000001");
});

test("a value with no integer part is written with a leading 0", () => {
  expect(formatDecimal(exact("5", 1))).toBe("0.5");
  expect(formatDecimal(exact("-5", 3))).toBe("-0.005");
  expect(formatDecimal(exact("999", 3))).toBe("0.999");
});

test("values beyond 2^53 keep every digit", () => {
  // 2^53 + 1 is the first integer a Number cannot hold.
  expect(formatDecimal(exact("9007199254740993", 0))).toBe("9,007,199,254,740,993");
  expect(formatDecimal(exact("-123456789012345678901234567", 9))).toBe(
    "-123,456,789,012,345,678.901234567",
  );
  const huge = "9".repeat(4000);
  const shown = formatDecimal(exact(huge, 0));
  expect(shown.replaceAll(",", "")).toBe(huge);
  expect(shown.startsWith("9,999,")).toBe(true);
});

test("text that is not a plain decimal is shown as it is, never read", () => {
  for (const text of ["", ".5", "+5", "1,234", "1e5", "12.", "-", "１２３４", "1 234"])
    expect(formatDecimalText(text)).toBe(text);
  expect(formatDecimalText("-1234.5")).toBe("-1,234.5");
});

test("for a known currency it writes the same digits as formatAmount", () => {
  // Synthetic coefficients across lengths and signs, deterministic so a
  // failure reproduces.
  let seed = 7; // MINSTD: every product stays below 2^53.
  const next = (): number => (seed = (seed * 48271) % 2147483647);
  for (const currency of ["JPY", "USD", "AUD"]) {
    const scale = minorUnitExponent(currency)!;
    for (let round = 0; round < 300; round += 1) {
      const length = 1 + (next() % 24);
      let digits = String(1 + (next() % 9));
      while (digits.length < length) digits += String(next() % 10);
      const minor = next() % 2 === 0 ? digits : `-${digits}`;
      expect(`${formatDecimal(exact(minor, scale))} ${currency}`).toBe(
        formatAmount(minor, currency),
      );
    }
  }
});
