// Exact quantities. The stored decimal-v1 projection (coefficient, scale,
// exact | missing | unparsed | conflict) is reused as-is; this module adds the
// arithmetic and the unit-aware quantity on top of it. Nothing here converts a
// missing, unparsed or conflicting value into zero (INV05), and nothing adds
// two different units (INV03).
import {
  validNormalizedDecimal,
  type NormalizedDecimal,
} from "../../../packages/observation-shared/src/normalized-decimal.ts";
import { hasExactKeys, isOneOf, isRecord, isSafeInt, isText } from "./guards.ts";

/** `coefficient × 10^(-scale)` in the decimal-v1 canonical form: no trailing zeros, "-0" is "0". */
export interface ExactDecimal {
  coefficient: string;
  scale: number;
}
/** Same bound as the decimal-v1 DB projection. */
export const DECIMAL_DIGIT_LIMIT = 4096;
/** Version stamped on values produced by the arithmetic in this module. */
export const ARITHMETIC_POLICY_VERSION = "exact-arith-v1";

export const VALUE_STATUSES = ["exact", "missing", "unparsed", "conflict"] as const;
export type ValueStatus = (typeof VALUE_STATUSES)[number];
export type ValueState =
  | { status: "exact"; value: ExactDecimal; normalizationVersion: string }
  | { status: "missing" | "unparsed" | "conflict"; reasonCode: string };

export interface Quantity {
  unitRef: string;
  value: ValueState;
}

/** Integer ratio `numerator / denominator`; the denominator is a positive integer. */
export interface ExactRatio {
  numerator: string;
  denominator: string;
}

export const ROUNDING_MODES = ["down", "up", "floor", "ceiling", "half-up", "half-even"] as const;
export type RoundingMode = (typeof ROUNDING_MODES)[number];
export interface Rounding {
  scale: number;
  mode: RoundingMode;
}

export const VALUE_ERROR_CODES = [
  "unit_mismatch",
  "value_not_exact",
  "inexact_result",
  "invalid_decimal",
  "invalid_ratio",
  "division_by_zero",
] as const;
export type ValueErrorCode = (typeof VALUE_ERROR_CODES)[number];
export interface ValueError {
  code: ValueErrorCode;
  message: string;
  /** Operand descriptors (unit references, statuses); never provider content. */
  refs: string[];
}
export type DecimalResult = { ok: true; value: ExactDecimal } | { ok: false; error: ValueError };
export type QuantityResult = { ok: true; quantity: Quantity } | { ok: false; error: ValueError };

const COEFFICIENT = /^(?:0|-?[1-9][0-9]*)$/u;
const INTEGER = /^-?(?:0|[1-9][0-9]*)$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;
const DECIMAL_TEXT = /^[ \t\r\n]*([+-])?([0-9]*)(?:\.([0-9]+))?[ \t\r\n]*$/u;

function error(code: ValueErrorCode, message: string, refs: string[] = []): ValueError {
  return { code, message, refs };
}

export function validExactDecimal(value: unknown): value is ExactDecimal {
  if (!isRecord(value) || !hasExactKeys(value, ["coefficient", "scale"])) return false;
  const { coefficient, scale } = value;
  if (
    typeof coefficient !== "string" ||
    coefficient.length > DECIMAL_DIGIT_LIMIT + 1 ||
    !COEFFICIENT.test(coefficient) ||
    !isSafeInt(scale, 0, DECIMAL_DIGIT_LIMIT)
  )
    return false;
  if (coefficient === "0") return scale === 0;
  return scale === 0 || !coefficient.endsWith("0");
}

export function validExactRatio(value: unknown): value is ExactRatio {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["numerator", "denominator"]) &&
    typeof value.numerator === "string" &&
    value.numerator.length <= DECIMAL_DIGIT_LIMIT + 1 &&
    INTEGER.test(value.numerator) &&
    typeof value.denominator === "string" &&
    value.denominator.length <= DECIMAL_DIGIT_LIMIT &&
    POSITIVE_INTEGER.test(value.denominator)
  );
}

export function validValueState(value: unknown): value is ValueState {
  if (!isRecord(value) || !isOneOf(VALUE_STATUSES)(value.status)) return false;
  if (value.status === "exact")
    return (
      hasExactKeys(value, ["status", "value", "normalizationVersion"]) &&
      validExactDecimal(value.value) &&
      isText(value.normalizationVersion, 64)
    );
  return hasExactKeys(value, ["status", "reasonCode"]) && isText(value.reasonCode, 128);
}

export function validQuantity(value: unknown): value is Quantity {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["unitRef", "value"]) &&
    isText(value.unitRef, 128) &&
    validValueState(value.value)
  );
}

export function validRounding(value: unknown): value is Rounding {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["scale", "mode"]) &&
    isSafeInt(value.scale, 0, DECIMAL_DIGIT_LIMIT) &&
    isOneOf(ROUNDING_MODES)(value.mode)
  );
}

/** Canonical form: strips trailing zeros, maps every zero (including "-0") to `0 / scale 0`. */
export function normalizeDecimal(coefficient: bigint, scale: number): ExactDecimal {
  let c = coefficient;
  let s = scale;
  if (s < 0) {
    c *= 10n ** BigInt(-s);
    s = 0;
  }
  if (c === 0n) return { coefficient: "0", scale: 0 };
  while (s > 0 && c % 10n === 0n) {
    c /= 10n;
    s -= 1;
  }
  return { coefficient: c.toString(), scale: s };
}

function toBigInt(value: ExactDecimal): bigint {
  return BigInt(value.coefficient);
}

/** Parse decimal text under the decimal-v1 text rules: ASCII digits, optional sign, one dot, no exponent. */
export function decimalFromString(text: string): DecimalResult {
  if (text.length > DECIMAL_DIGIT_LIMIT)
    return { ok: false, error: error("invalid_decimal", "decimal text exceeds the digit limit") };
  const match = DECIMAL_TEXT.exec(text);
  const integer = match?.[2] ?? "";
  const fraction = match?.[3] ?? "";
  if (!match || (integer.length === 0 && fraction.length === 0))
    return { ok: false, error: error("invalid_decimal", "decimal text is not a plain decimal") };
  const magnitude = BigInt(integer + fraction);
  return {
    ok: true,
    value: normalizeDecimal(match[1] === "-" ? -magnitude : magnitude, fraction.length),
  };
}

/** For constants in tests and fixtures only: throws on invalid text instead of returning a result. */
export function decimalLiteral(text: string): ExactDecimal {
  const parsed = decimalFromString(text);
  if (!parsed.ok) throw new RangeError(`invalid decimal literal: ${parsed.error.code}`);
  return parsed.value;
}

export function integerDecimal(value: number | bigint): ExactDecimal {
  if (typeof value === "number" && !Number.isSafeInteger(value))
    throw new RangeError("integerDecimal requires a safe integer");
  return normalizeDecimal(BigInt(value), 0);
}

/** Plain decimal text such as `-0.001` or `50.1`; display formatting is a separate concern. */
export function decimalToString(value: ExactDecimal): string {
  if (value.scale === 0) return value.coefficient;
  const negative = value.coefficient.startsWith("-");
  const digits = negative ? value.coefficient.slice(1) : value.coefficient;
  const padded = digits.padStart(value.scale + 1, "0");
  const integer = padded.slice(0, padded.length - value.scale);
  const fraction = padded.slice(padded.length - value.scale);
  return `${negative ? "-" : ""}${integer}.${fraction}`;
}

export function isZeroDecimal(value: ExactDecimal): boolean {
  return value.coefficient === "0";
}

export function alignScales(
  a: ExactDecimal,
  b: ExactDecimal,
): { a: bigint; b: bigint; scale: number } {
  const scale = Math.max(a.scale, b.scale);
  return {
    a: toBigInt(a) * 10n ** BigInt(scale - a.scale),
    b: toBigInt(b) * 10n ** BigInt(scale - b.scale),
    scale,
  };
}

export function addDecimals(a: ExactDecimal, b: ExactDecimal): ExactDecimal {
  const aligned = alignScales(a, b);
  return normalizeDecimal(aligned.a + aligned.b, aligned.scale);
}

export function subtractDecimals(a: ExactDecimal, b: ExactDecimal): ExactDecimal {
  const aligned = alignScales(a, b);
  return normalizeDecimal(aligned.a - aligned.b, aligned.scale);
}

export function negateDecimal(a: ExactDecimal): ExactDecimal {
  return normalizeDecimal(-toBigInt(a), a.scale);
}

export function multiplyDecimals(a: ExactDecimal, b: ExactDecimal): ExactDecimal {
  return normalizeDecimal(toBigInt(a) * toBigInt(b), a.scale + b.scale);
}

export function compareDecimals(a: ExactDecimal, b: ExactDecimal): -1 | 0 | 1 {
  const aligned = alignScales(a, b);
  return aligned.a < aligned.b ? -1 : aligned.a > aligned.b ? 1 : 0;
}

export function decimalEquals(a: ExactDecimal, b: ExactDecimal): boolean {
  return compareDecimals(a, b) === 0;
}

export function sumDecimals(values: readonly ExactDecimal[]): ExactDecimal {
  return values.reduce(addDecimals, integerDecimal(0));
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

/**
 * Exact conversion of `numerator / denominator` into a decimal. Without a
 * rounding instruction the ratio must be a finite decimal (denominator of the
 * reduced fraction is 2^a·5^b); otherwise `inexact_result` is returned rather
 * than a silently rounded value. With rounding, the position and mode are
 * explicit so a different policy can recompute from the same inputs.
 */
function ratioToDecimal(
  numerator: bigint,
  denominator: bigint,
  rounding?: Rounding,
): DecimalResult {
  if (denominator === 0n)
    return { ok: false, error: error("division_by_zero", "ratio denominator is zero") };
  let n = numerator;
  let d = denominator;
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const g = gcd(n, d);
  if (g > 1n) {
    n /= g;
    d /= g;
  }
  if (rounding) {
    const scaled = n * 10n ** BigInt(rounding.scale);
    let quotient = scaled / d;
    const remainder = scaled % d;
    if (remainder !== 0n) {
      const negative = scaled < 0n;
      const twice = (remainder < 0n ? -remainder : remainder) * 2n;
      const away = () => (quotient += negative ? -1n : 1n);
      switch (rounding.mode) {
        case "down":
          break;
        case "up":
          away();
          break;
        case "floor":
          if (negative) quotient -= 1n;
          break;
        case "ceiling":
          if (!negative) quotient += 1n;
          break;
        case "half-up":
          if (twice >= d) away();
          break;
        case "half-even":
          if (twice > d || (twice === d && quotient % 2n !== 0n)) away();
          break;
      }
    }
    return { ok: true, value: normalizeDecimal(quotient, rounding.scale) };
  }
  let twos = 0;
  let fives = 0;
  let rest = d;
  while (rest % 2n === 0n) {
    rest /= 2n;
    twos += 1;
  }
  while (rest % 5n === 0n) {
    rest /= 5n;
    fives += 1;
  }
  if (rest !== 1n)
    return {
      ok: false,
      error: error("inexact_result", "ratio is not a finite decimal; supply an explicit rounding"),
    };
  const scale = Math.max(twos, fives);
  return { ok: true, value: normalizeDecimal((n * 10n ** BigInt(scale)) / d, scale) };
}

export function multiplyByRatio(
  value: ExactDecimal,
  ratio: ExactRatio,
  rounding?: Rounding,
): DecimalResult {
  if (!validExactRatio(ratio))
    return { ok: false, error: error("invalid_ratio", "ratio must be integer / positive integer") };
  return ratioToDecimal(
    toBigInt(value) * BigInt(ratio.numerator),
    BigInt(ratio.denominator) * 10n ** BigInt(value.scale),
    rounding,
  );
}

export function divideDecimals(
  dividend: ExactDecimal,
  divisor: ExactDecimal,
  rounding?: Rounding,
): DecimalResult {
  return ratioToDecimal(
    toBigInt(dividend) * 10n ** BigInt(divisor.scale),
    toBigInt(divisor) * 10n ** BigInt(dividend.scale),
    rounding,
  );
}

export function exactQuantity(
  unitRef: string,
  value: ExactDecimal,
  normalizationVersion = ARITHMETIC_POLICY_VERSION,
): Quantity {
  return { unitRef, value: { status: "exact", value, normalizationVersion } };
}

export function absentQuantity(
  unitRef: string,
  status: "missing" | "unparsed" | "conflict",
  reasonCode: string,
): Quantity {
  return { unitRef, value: { status, reasonCode } };
}

function exactOperands(
  quantities: readonly Quantity[],
  unitRef: string,
): { ok: true; values: ExactDecimal[] } | { ok: false; error: ValueError } {
  const units = quantities.filter((q) => q.unitRef !== unitRef).map((q) => q.unitRef);
  if (units.length > 0)
    return {
      ok: false,
      error: error("unit_mismatch", "quantities with different units are not added", [
        unitRef,
        ...units,
      ]),
    };
  const values: ExactDecimal[] = [];
  const absent: string[] = [];
  for (const quantity of quantities) {
    if (quantity.value.status === "exact") values.push(quantity.value.value);
    else absent.push(`${quantity.value.status}:${quantity.value.reasonCode}`);
  }
  if (absent.length > 0)
    return {
      ok: false,
      error: error(
        "value_not_exact",
        "missing, unparsed or conflicting values are never zero",
        absent,
      ),
    };
  return { ok: true, values };
}

export function addQuantities(a: Quantity, b: Quantity): QuantityResult {
  const operands = exactOperands([a, b], a.unitRef);
  if (!operands.ok) return operands;
  return { ok: true, quantity: exactQuantity(a.unitRef, sumDecimals(operands.values)) };
}

export function subtractQuantities(a: Quantity, b: Quantity): QuantityResult {
  const operands = exactOperands([a, b], a.unitRef);
  if (!operands.ok) return operands;
  const [x, y] = operands.values;
  return { ok: true, quantity: exactQuantity(a.unitRef, subtractDecimals(x!, y!)) };
}

/** Sum of an explicit list; an empty list sums to exact zero of `unitRef`, which callers must only use for a known-complete set. */
export function sumQuantities(unitRef: string, quantities: readonly Quantity[]): QuantityResult {
  const operands = exactOperands(quantities, unitRef);
  if (!operands.ok) return operands;
  return { ok: true, quantity: exactQuantity(unitRef, sumDecimals(operands.values)) };
}

export function scaleQuantity(
  quantity: Quantity,
  ratio: ExactRatio,
  rounding?: Rounding,
): QuantityResult {
  if (quantity.value.status !== "exact")
    return {
      ok: false,
      error: error("value_not_exact", "only exact quantities are scaled", [
        `${quantity.value.status}:${quantity.value.reasonCode}`,
      ]),
    };
  const scaled = multiplyByRatio(quantity.value.value, ratio, rounding);
  if (!scaled.ok) return scaled;
  return { ok: true, quantity: exactQuantity(quantity.unitRef, scaled.value) };
}

export function compareQuantities(
  a: Quantity,
  b: Quantity,
): { ok: true; order: -1 | 0 | 1 } | { ok: false; error: ValueError } {
  const operands = exactOperands([a, b], a.unitRef);
  if (!operands.ok) return operands;
  const [x, y] = operands.values;
  return { ok: true, order: compareDecimals(x!, y!) };
}

/** Adapter from the persisted decimal-v1 row. The status is carried over; nothing becomes zero. */
export function fromNormalizedDecimal(value: NormalizedDecimal): ValueState {
  if (!validNormalizedDecimal(value))
    return { status: "unparsed", reasonCode: "normalized_decimal_invalid" };
  if (value.status === "exact" && value.coefficient !== null && value.scale !== null)
    return {
      status: "exact",
      value: normalizeDecimal(BigInt(value.coefficient), value.scale),
      normalizationVersion: value.policyVersion,
    };
  if (value.status === "exact")
    return { status: "unparsed", reasonCode: "normalized_decimal_invalid" };
  return { status: value.status, reasonCode: `${value.policyVersion}:${value.status}` };
}

export function quantityFromNormalizedDecimal(unitRef: string, value: NormalizedDecimal): Quantity {
  return { unitRef, value: fromNormalizedDecimal(value) };
}
