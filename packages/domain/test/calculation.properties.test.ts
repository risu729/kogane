// Seeded property tests of the calculation contract (docs/calculation-and-
// reports.md §3–§5): rounding modes, rounding policies and the two P&L
// attributions, over random exact decimals.
import { describe, expect, test } from "bun:test";
import {
  applyRoundingPolicy,
  pnlDecompositions,
  roundDecimal,
  type RoundingPolicy,
} from "../src/calculation.ts";
import {
  compareDecimals,
  decimalEquals,
  integerDecimal,
  multiplyDecimals,
  negateDecimal,
  normalizeDecimal,
  subtractDecimals,
  sumDecimals,
  type ExactDecimal,
} from "../src/values.ts";
import { between, pick, seededRandom, seeds, type Random } from "./property.ts";

const MODES = ["down", "up", "floor", "ceiling", "half-up", "half-even"] as const;

function decimal(random: Random, maxScale = 4): ExactDecimal {
  const magnitude = BigInt(between(random, 0, 199_999));
  return normalizeDecimal(random() < 0.3 ? -magnitude : magnitude, between(random, 0, maxScale));
}
/** |a| < |unit|, both ways. */
const withinOne = (difference: ExactDecimal, unit: ExactDecimal) =>
  compareDecimals(difference, unit) < 0 && compareDecimals(difference, negateDecimal(unit)) > 0;

const SEEDS = seeds(1, 3000);

describe("rounding over random decimals", () => {
  test("each mode moves less than one unit, in its own direction, to the asked scale", () => {
    const broken: string[] = [];
    for (const seed of SEEDS) {
      const random = seededRandom(seed);
      const value = decimal(random, 6);
      const scale = between(random, 0, 3);
      const mode = pick(random, MODES);
      const rounded = roundDecimal(value, { scale, mode });
      const unit = normalizeDecimal(1n, scale);
      const moved = subtractDecimals(rounded, value);
      const direction = compareDecimals(moved, integerDecimal(0));
      const sign = compareDecimals(value, integerDecimal(0));
      if (rounded.scale > scale || !withinOne(moved, unit)) broken.push(`${seed}: range`);
      if (mode === "floor" && direction > 0) broken.push(`${seed}: floor up`);
      if (mode === "ceiling" && direction < 0) broken.push(`${seed}: ceiling down`);
      if (mode === "down" && direction !== 0 && direction === sign)
        broken.push(`${seed}: down away from zero`);
      if (mode === "up" && direction !== 0 && direction !== sign)
        broken.push(`${seed}: up toward zero`);
      // The half modes land on a nearest step: at most half a unit either way.
      const twice = multiplyDecimals(moved, integerDecimal(2));
      if (
        (mode === "half-up" || mode === "half-even") &&
        (compareDecimals(twice, unit) > 0 || compareDecimals(twice, negateDecimal(unit)) < 0)
      )
        broken.push(`${seed}: not nearest`);
    }
    expect(broken).toEqual([]);
  });

  test("a rounding policy keeps the exact sum, states its residual, and carries to the rounded total", () => {
    const broken: string[] = [];
    for (const seed of SEEDS) {
      const random = seededRandom(seed);
      const parts = Array.from({ length: between(random, 0, 5) }, () => decimal(random, 5));
      const policy: RoundingPolicy = {
        policyId: "rounding:property",
        where: pick(random, ["leg", "execution", "statement", "aggregate"] as const),
        mode: pick(random, MODES),
        precision: between(random, 0, 2),
        residual: pick(random, ["carry", "largest-remainder", "leave", "refuse"] as const),
      };
      const applied = applyRoundingPolicy("JPY", parts, policy);
      const exact = sumDecimals(parts);
      const target = roundDecimal(exact, { scale: policy.precision, mode: policy.mode });
      if (!applied.ok) {
        if (policy.residual !== "refuse") broken.push(`${seed}: refused under ${policy.residual}`);
        continue;
      }
      const { total, preRounding, residual, parts: reported } = applied.aggregate;
      const totalValue = total.value.status === "exact" ? total.value.value : null;
      if (
        totalValue === null ||
        preRounding.value.status !== "exact" ||
        !decimalEquals(preRounding.value.value, exact)
      ) {
        broken.push(`${seed}: exact sum lost`);
        continue;
      }
      if (!decimalEquals(residual, subtractDecimals(totalValue, exact)))
        broken.push(`${seed}: residual`);
      if (policy.where === "aggregate") {
        if (!decimalEquals(totalValue, target)) broken.push(`${seed}: aggregate total`);
        continue;
      }
      if (reported.length !== parts.length || !decimalEquals(sumDecimals(reported), totalValue))
        broken.push(`${seed}: parts do not make the total`);
      if (reported.some((part) => part.scale > policy.precision))
        broken.push(`${seed}: part finer than precision`);
      if (
        (policy.residual === "carry" || policy.residual === "largest-remainder") &&
        parts.length > 0 &&
        !decimalEquals(totalValue, target)
      )
        broken.push(`${seed}: total is not the rounded exact sum`);
      if (policy.residual === "largest-remainder") {
        const unit = normalizeDecimal(1n, policy.precision);
        parts.forEach((part, index) => {
          const own = roundDecimal(part, { scale: policy.precision, mode: policy.mode });
          const moved = subtractDecimals(reported[index]!, own);
          if (compareDecimals(moved, unit) > 0 || compareDecimals(moved, negateDecimal(unit)) < 0)
            broken.push(`${seed}: a part moved more than one unit`);
        });
      }
    }
    expect(broken).toEqual([]);
  });
});

describe("pnlDecompositions over random prices and rates", () => {
  test("both attributions add up to the observed total; only the cross term moves", () => {
    const broken: number[] = [];
    for (const seed of SEEDS) {
      const random = seededRandom(seed);
      const inputs = {
        quantity: decimal(random),
        openingPrice: decimal(random),
        closingPrice: decimal(random),
        openingRate: decimal(random),
        closingRate: decimal(random),
        baseUnitRef: "JPY",
      };
      const both = pnlDecompositions(inputs);
      const value = (side: "policy-a" | "policy-b", part: "market" | "fx") => {
        const quantity = both[side][part].value;
        return quantity.status === "exact" ? quantity.value : integerDecimal(0);
      };
      // policy-a − policy-b on the market side is −q(P₁−P₀)(R₁−R₀): the cross term.
      const cross = multiplyDecimals(
        multiplyDecimals(
          inputs.quantity,
          subtractDecimals(inputs.closingPrice, inputs.openingPrice),
        ),
        subtractDecimals(inputs.closingRate, inputs.openingRate),
      );
      if (
        !both.totalsAgree ||
        !decimalEquals(
          subtractDecimals(value("policy-b", "market"), value("policy-a", "market")),
          cross,
        ) ||
        !decimalEquals(subtractDecimals(value("policy-a", "fx"), value("policy-b", "fx")), cross)
      )
        broken.push(seed);
    }
    expect(broken).toEqual([]);
  });
});
