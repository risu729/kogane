import { readFileSync } from "node:fs";
import { decimalLiteral, exactQuantity, type ExactDecimal, type Quantity } from "../src/values.ts";

/** Exact quantity from a decimal literal, stamped as an arithmetic result; for tests only. */
export function q(unitRef: string, text: string): Quantity {
  return exactQuantity(unitRef, decimalLiteral(text));
}

export function loadFixture<T = unknown>(relativePath: string): T {
  return JSON.parse(
    readFileSync(new URL(`../fixtures/${relativePath}`, import.meta.url), "utf8"),
  ) as T;
}

export function quantityText(quantity: Quantity | null): string | null {
  if (quantity === null || quantity.value.status !== "exact") return null;
  const { coefficient, scale } = quantity.value.value;
  if (scale === 0) return coefficient;
  const negative = coefficient.startsWith("-");
  const digits = (negative ? coefficient.slice(1) : coefficient).padStart(scale + 1, "0");
  return `${negative ? "-" : ""}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

/** The exact decimal of a quantity the test expects to be exact. */
export function exact(quantity: Quantity): ExactDecimal {
  if (quantity.value.status !== "exact")
    throw new Error(`expected exact, got ${quantity.value.status}`);
  return quantity.value.value;
}

/** Unwrap a typed result the test expects to succeed. */
export function ok<R extends { ok: true } | { ok: false; error: { code: string } }>(
  result: R,
): Extract<R, { ok: true }> {
  if (!result.ok) throw new Error(`unexpected error: ${result.error.code}`);
  return result as Extract<R, { ok: true }>;
}
