// `QuantityChange` writes the server's exact change with its sign and nothing
// else: no Number on the way, `±0` for zero, the minus the decimal carries, and
// every fraction digit. A change that is not exact is unknown, not a number.
import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Quantity } from "../../../packages/domain/src/values.ts";
import { QuantityChange } from "../src/reconciliation-display.tsx";

const exact = (coefficient: string, scale: number): Quantity => ({
  unitRef: "instrument:synthetic:-:1001",
  value: { status: "exact", value: { coefficient, scale }, normalizationVersion: "decimal-v1" },
});
// The rendered text without its tags, stripped until nothing changes so no
// partial tag can survive one pass.
const shown = (value: Quantity): string => {
  let text = renderToStaticMarkup(createElement(QuantityChange, { value }));
  for (let previous = ""; previous !== text;) {
    previous = text;
    text = text.replace(/<[^>]*>/gu, "");
  }
  return text;
};

test("the sign is always written and zero is ±0", () => {
  expect(shown(exact("25", 1))).toBe("+2.5");
  expect(shown(exact("-35", 1))).toBe("-3.5");
  expect(shown(exact("0", 0))).toBe("±0");
  expect(shown(exact("7", 0))).toBe("+7");
  expect(shown(exact("-5", 1))).toBe("-0.5");
});

test("every digit survives, beyond what a Number holds", () => {
  expect(shown(exact("1", 18))).toBe("+0.000000000000000001");
  expect(shown(exact("-123456789012345678901234567", 9))).toBe("-123456789012345678.901234567");
  expect(shown(exact("90071992547409931", 0))).toBe("+90071992547409931");
});

test("a change that is not exact is unknown, never a number", () => {
  const unknown = shown({
    unitRef: "instrument:synthetic:-:1001",
    value: { status: "unparsed", reasonCode: "quantity_unreadable" },
  });
  expect(unknown).toContain("不明");
  expect(unknown).not.toMatch(/[+±]|-[0-9]/u);
});
