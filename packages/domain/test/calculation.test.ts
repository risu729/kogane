// A12: the valuation order, price basis, rounding policy, P&L decomposition
// and cost-basis gate of addendum 09, plus the synthetic checks SYN11-SYN15
// and SYN22-SYN23 driven through this module rather than through ad-hoc
// arithmetic.
import { describe, expect, test } from "bun:test";
import {
  applyRoundingPolicy,
  costBasis,
  DEFAULT_INSTRUMENT_VALUATION_POLICY,
  netWorth,
  pnlDecomposition,
  pnlDecompositions,
  roundDecimal,
  summarizeValuation,
  UNVALUED_REASONS,
  validRoundingPolicy,
  valuationMethodFor,
  valueHolding,
  type RoundingPolicy,
  type ValuationCell,
} from "../src/calculation.ts";
import type { PriceObservation } from "../src/metrics.ts";
import type { TemporalValue } from "../src/time.ts";
import {
  decimalLiteral,
  decimalToString,
  divideDecimals,
  integerDecimal,
  multiplyByRatio,
  sumQuantities,
  type ExactDecimal,
  type Quantity,
} from "../src/values.ts";
import { exact, ok, q, quantityText } from "./helpers.ts";

const tokyoDate = (value: string): TemporalValue => ({
  kind: "local-date",
  value,
  zone: "Asia/Tokyo",
  basis: "provider",
});

function price(overrides: Partial<PriceObservation> = {}): PriceObservation {
  return {
    id: "price:1",
    baseInstrumentRef: "fund:synthetic",
    baseQuantity: integerDecimal(10_000),
    quoteUnitRef: "JPY",
    quoteAmount: integerDecimal(8000),
    priceKind: "nav",
    effectiveTime: tokyoDate("2026-09-01"),
    sourceClaimRef: "claim:nav:1",
    marketRef: null,
    adjustmentPolicyRef: null,
    ...overrides,
  };
}

const yenRounding: RoundingPolicy = {
  policyId: "rounding-jpy-v1",
  where: "aggregate",
  mode: "half-even",
  precision: 0,
  residual: "leave",
};

describe("price basis and the valuation order", () => {
  test("SYN22 a fund quoted per 10,000 units values 12,500 units at 10,000, not 100,000,000", () => {
    const outcome = valueHolding(q("fund:synthetic", "12500"), price(), {
      instrumentClass: "fund-unit",
    });
    expect(outcome.valued).toBe(true);
    if (!outcome.valued) return;
    expect(quantityText(outcome.value)).toBe("10000");
    expect(outcome.priceRef).toBe("price:1");
    expect(outcome.roundingInputs).toBeNull();
  });

  test("a one-share basis and a 10,000-unit basis are different prices for the same number", () => {
    const perShare = valueHolding(
      q("fund:synthetic", "12500"),
      price({ baseQuantity: integerDecimal(1) }),
      {
        instrumentClass: "fund-unit",
      },
    );
    expect(perShare.valued && quantityText(perShare.value)).toBe("100000000");
  });

  test("AT24 a missing FX price leaves the holding unvalued instead of converting 1:1", () => {
    const outcome = valueHolding(q("AUD", "1000"), null, { instrumentClass: "cash" });
    expect(outcome).toMatchObject({ valued: false, reason: "missing-price" });
    // And a price for another instrument is an identity problem, not a rate of one.
    const wrong = valueHolding(q("AUD", "1000"), price({ baseInstrumentRef: "USD" }), {
      instrumentClass: "cash",
    });
    expect(wrong).toMatchObject({ valued: false, reason: "unresolved-identity" });
  });

  test("AT24 a price older than the freshness floor is stale, and an unknown price time is not fresh", () => {
    const stale = valueHolding(q("fund:synthetic", "10000"), price(), {
      instrumentClass: "fund-unit",
      freshnessFloor: tokyoDate("2026-09-08"),
    });
    expect(stale).toMatchObject({ valued: false, reason: "stale-price" });
    const unknown = valueHolding(
      q("fund:synthetic", "10000"),
      price({ effectiveTime: { kind: "unknown", reasonCode: "provider_omitted" } }),
      { instrumentClass: "fund-unit", freshnessFloor: tokyoDate("2026-08-01") },
    );
    expect(unknown).toMatchObject({ valued: false, reason: "stale-price" });
    const fresh = valueHolding(q("fund:synthetic", "10000"), price(), {
      instrumentClass: "fund-unit",
      freshnessFloor: tokyoDate("2026-08-01"),
    });
    expect(fresh.valued).toBe(true);
  });

  test("each unvalued reason is reachable and they are not interchangeable", () => {
    const missingQuantity: Quantity = {
      unitRef: "fund:synthetic",
      value: { status: "missing", reasonCode: "decimal-v1:missing" },
    };
    const reasons = [
      valueHolding(q("fund:synthetic", "1"), price(), {
        instrumentClass: "fund-unit",
        identityUnresolved: true,
      }),
      valueHolding(q("fund:synthetic", "1"), price(), {
        instrumentClass: "fund-unit",
        scopeOverlap: true,
      }),
      valueHolding(missingQuantity, price(), { instrumentClass: "fund-unit" }),
      valueHolding(q("future:synthetic", "1"), price({ baseInstrumentRef: "future:synthetic" }), {
        instrumentClass: "derivative",
      }),
      valueHolding(q("fund:synthetic", "1"), null, { instrumentClass: "fund-unit" }),
    ].map((outcome) => (outcome.valued ? null : outcome.reason));
    expect(reasons).toEqual([
      "unresolved-identity",
      "overlap",
      "missing-quantity",
      "unsupported-instrument",
      "missing-price",
    ]);
    // The order is fixed: an overlapping holding with no price reports the overlap.
    const both = valueHolding(q("fund:synthetic", "1"), null, {
      instrumentClass: "fund-unit",
      scopeOverlap: true,
    });
    expect(both).toMatchObject({ valued: false, reason: "overlap" });
  });

  test("derivative notional, margin and nominal contracts are unsupported unless a policy says otherwise", () => {
    for (const kind of ["derivative", "margin-position", "nominal-contract", "unknown"] as const)
      expect(valuationMethodFor(kind)).toBe("unsupported");
    for (const kind of ["cash", "deposit", "listed-equity", "fund-unit", "crypto-asset"] as const)
      expect(valuationMethodFor(kind)).toBe("quantity-times-price");
    const permissive = {
      policyId: "instrument-valuation-test",
      methods: {
        ...DEFAULT_INSTRUMENT_VALUATION_POLICY.methods,
        derivative: "quantity-times-price",
      },
    } as const;
    const outcome = valueHolding(
      q("future:synthetic", "2"),
      price({ baseInstrumentRef: "future:synthetic", baseQuantity: integerDecimal(1) }),
      { instrumentClass: "derivative", instrumentPolicy: permissive },
    );
    expect(outcome.valued).toBe(true);
  });
});

describe("results are partitioned, never labelled as an 'at least' total", () => {
  const cell = (subjectRef: string, outcome: ValuationCell["outcome"]): ValuationCell => ({
    subjectRef,
    scopeRef: `scope:${subjectRef}`,
    metric: "holdings.valuation",
    unitRef: "JPY",
    outcome,
  });
  const valued = (subjectRef: string, amount: string) =>
    cell(
      subjectRef,
      valueHolding(q("fund:synthetic", amount), price(), { instrumentClass: "fund-unit" }),
    );

  test("every cell valued is complete; a mix is a partial verified scope; none is not computable", () => {
    expect(summarizeValuation("JPY", [valued("a", "10000"), valued("b", "10000")])).toMatchObject({
      partition: "complete",
      reasons: [],
    });
    const mixed = summarizeValuation("JPY", [
      valued("a", "10000"),
      cell("b", valueHolding(q("fund:synthetic", "1"), null, { instrumentClass: "fund-unit" })),
    ]);
    expect(mixed.partition).toBe("partial-verified-scope");
    expect(quantityText(mixed.subtotal)).toBe("8000");
    expect(mixed.reasons).toEqual(["missing-price"]);
    const none = summarizeValuation("JPY", [
      cell("b", valueHolding(q("fund:synthetic", "1"), null, { instrumentClass: "fund-unit" })),
    ]);
    expect(none).toMatchObject({ partition: "not-computable", subtotal: null });
  });

  test("net worth needs complete liability coverage; otherwise it is a known-assets subtotal", () => {
    const complete = netWorth({
      unitRef: "JPY",
      assets: integerDecimal(160_000),
      liabilities: integerDecimal(60_000),
      liabilitiesCoverage: "complete",
      assetsPartition: "complete",
    });
    expect(complete).toMatchObject({ metric: "net-worth", partition: "complete" });
    expect(quantityText(complete.value)).toBe("100000");
    for (const coverage of ["partial", "unknown"] as const) {
      const partial = netWorth({
        unitRef: "JPY",
        assets: integerDecimal(160_000),
        liabilities: integerDecimal(60_000),
        liabilitiesCoverage: coverage,
        assetsPartition: "complete",
      });
      expect(partial).toMatchObject({
        metric: "known-assets-subtotal",
        reason: "incomplete-liabilities",
        partition: "partial-verified-scope",
      });
      // The assets are reported as themselves; nothing is subtracted.
      expect(quantityText(partial.value)).toBe("160000");
    }
  });

  test("UNVALUED_REASONS matches the reasons addendum 09 section 3 requires", () => {
    expect([...UNVALUED_REASONS].sort()).toEqual([
      "incomplete-liabilities",
      "missing-price",
      "missing-quantity",
      "overlap",
      "stale-price",
      "unresolved-identity",
      "unsupported-instrument",
    ]);
  });
});

describe("rounding is a policy applied at a declared point", () => {
  const parts = [decimalLiteral("0.5"), decimalLiteral("0.5"), decimalLiteral("0.5")];

  test("the same numbers give different totals depending on where the policy rounds", () => {
    const perLeg = ok(
      applyRoundingPolicy("JPY", parts, { ...yenRounding, where: "leg", residual: "leave" }),
    ).aggregate;
    const aggregate = ok(applyRoundingPolicy("JPY", parts, yenRounding)).aggregate;
    // half-even per leg: 0.5 -> 0, 0.5 -> 0, 0.5 -> 0. Aggregate: 1.5 -> 2.
    expect(quantityText(perLeg.total)).toBe("0");
    expect(quantityText(aggregate.total)).toBe("2");
    // Both keep the exact input so a third policy can start from it.
    expect(quantityText(perLeg.preRounding)).toBe("1.5");
    expect(quantityText(aggregate.preRounding)).toBe("1.5");
    expect(perLeg.roundingInputs.operands).toEqual(parts);
    expect(aggregate.roundingInputs).toMatchObject({ where: "aggregate", mode: "half-even" });
  });

  test("residual handling: carry, largest-remainder, leave and refuse are different policies", () => {
    const base = { ...yenRounding, where: "leg" as const };
    const carry = ok(applyRoundingPolicy("JPY", parts, { ...base, residual: "carry" })).aggregate;
    expect(quantityText(carry.total)).toBe("2");
    expect(carry.parts.map((part) => part.coefficient)).toEqual(["0", "0", "2"]);
    const largest = ok(
      applyRoundingPolicy("JPY", parts, { ...base, residual: "largest-remainder" }),
    ).aggregate;
    expect(quantityText(largest.total)).toBe("2");
    const leave = ok(applyRoundingPolicy("JPY", parts, { ...base, residual: "leave" })).aggregate;
    expect(quantityText(leave.total)).toBe("0");
    expect(decimalToString(leave.residual)).toBe("-1.5");
    const refused = applyRoundingPolicy("JPY", parts, { ...base, residual: "refuse" });
    expect(refused).toMatchObject({ ok: false, error: { code: "inexact_result" } });
  });

  test("valueHolding keeps the pre-rounding value and the operands beside the rounded one", () => {
    const outcome = valueHolding(
      q("fund:synthetic", "12345"),
      price({ quoteAmount: decimalLiteral("8000.7") }),
      { instrumentClass: "fund-unit", rounding: { ...yenRounding, where: "leg" } },
    );
    expect(outcome.valued).toBe(true);
    if (!outcome.valued || outcome.roundingInputs === null) return;
    expect(quantityText(outcome.preRounding)).toBe("9876.86415");
    expect(quantityText(outcome.value)).toBe("9877");
    expect(outcome.roundingInputs.preRounding).toEqual(exact(outcome.preRounding));
    expect(outcome.roundingInputs.operands).toHaveLength(3);
  });

  test("roundDecimal keeps the declared mode and validRoundingPolicy rejects a partial policy", () => {
    expect(roundDecimal(decimalLiteral("2.5"), { scale: 0, mode: "half-even" })).toEqual(
      integerDecimal(2),
    );
    expect(roundDecimal(decimalLiteral("2.5"), { scale: 0, mode: "half-up" })).toEqual(
      integerDecimal(3),
    );
    expect(roundDecimal(decimalLiteral("-2.5"), { scale: 0, mode: "floor" })).toEqual(
      integerDecimal(-3),
    );
    expect(validRoundingPolicy(yenRounding)).toBe(true);
    expect(validRoundingPolicy({ ...yenRounding, residual: "round-somehow" })).toBe(false);
  });
});

describe("P&L decomposition is a policy, not an observation", () => {
  const inputs = {
    quantity: integerDecimal(10),
    openingPrice: integerDecimal(100),
    closingPrice: integerDecimal(110),
    openingRate: integerDecimal(100),
    closingRate: integerDecimal(105),
    baseUnitRef: "JPY",
  };

  test("SYN23 both policies total 15,500 and attribute the cross term differently", () => {
    const both = pnlDecompositions(inputs);
    expect(both.totalsAgree).toBe(true);
    expect(
      [both["policy-a"].total, both["policy-a"].market, both["policy-a"].fx].map(quantityText),
    ).toEqual(["15500", "10000", "5500"]);
    expect(
      [both["policy-b"].total, both["policy-b"].market, both["policy-b"].fx].map(quantityText),
    ).toEqual(["15500", "10500", "5000"]);
    // Neither is presented as the observed split.
    expect([both["policy-a"].factual, both["policy-b"].factual]).toEqual([false, false]);
  });

  test("the components of one policy add up to that policy's total", () => {
    for (const policyId of ["policy-a", "policy-b"] as const) {
      const decomposition = pnlDecomposition(inputs, policyId);
      const sum = ok(sumQuantities("JPY", [decomposition.market, decomposition.fx]));
      expect(quantityText(sum.quantity)).toBe(quantityText(decomposition.total));
      expect(decomposition.policyId).toBe(policyId);
    }
  });
});

describe("cost basis is a contract with a verification gate", () => {
  const request = {
    jurisdiction: "JP",
    taxPeriod: "2026",
    accountWrapper: "taxable",
    residencyOrEntity: "unknown",
    method: "average",
    feeTreatment: "include",
    carriedCost: "none",
    lotSelection: "none",
    rulePackage: null,
  };

  test("AT59 no verified rule package means needs-policy for JP and AU, with no tax conclusion", () => {
    for (const jurisdiction of ["JP", "AU"]) {
      const outcome = costBasis({ ...request, jurisdiction });
      expect(outcome).toMatchObject({
        status: "needs-policy",
        reasonCode: "no_verified_rule_package",
        taxConclusion: null,
      });
    }
    const unverified = costBasis({
      ...request,
      rulePackage: { policyId: "au-cgt-draft", verification: "unverified" },
    });
    expect(unverified.reasonCode).toBe("no_verified_rule_package");
  });

  test("even a verified package still names the inputs it does not have", () => {
    const outcome = costBasis({
      ...request,
      taxPeriod: null,
      residencyOrEntity: null,
      rulePackage: { policyId: "synthetic-rules-v1", verification: "verified" },
    });
    expect(outcome).toMatchObject({ status: "needs-policy", reasonCode: "missing_inputs" });
    expect(outcome.missing).toEqual(["taxPeriod", "residencyOrEntity"]);
  });
});

describe("SC07 and SC08 through exact arithmetic (SYN11-SYN15)", () => {
  test("SYN11-SYN12 6 + 4 fills are 10 shares; consideration is 10 x 100 + 2 = 1002", () => {
    const fills = ok(
      sumQuantities("share:synthetic", [q("share:synthetic", "6"), q("share:synthetic", "4")]),
    );
    expect(quantityText(fills.quantity)).toBe("10");
    const shares = price({
      id: "price:share",
      baseInstrumentRef: "share:synthetic",
      baseQuantity: integerDecimal(1),
      quoteUnitRef: "USD",
      quoteAmount: integerDecimal(100),
      priceKind: "execution",
    });
    const consideration = valueHolding(fills.quantity, shares, {
      instrumentClass: "listed-equity",
    });
    expect(consideration.valued).toBe(true);
    if (!consideration.valued) return;
    const withFee = ok(sumQuantities("USD", [consideration.value, q("USD", "2")]));
    expect(quantityText(withFee.quantity)).toBe("1002");
  });

  test("SYN13-SYN15 a 1:2 split doubles the quantity, keeps the cost, halves the unit cost and preserves the comparison value", () => {
    const split = ok(multiplyByRatio(integerDecimal(10), { numerator: "2", denominator: "1" }));
    expect(split.value).toEqual(integerDecimal(20));
    const unitCost = ok(divideDecimals(integerDecimal(1002), split.value)).value;
    expect(unitCost).toEqual({ coefficient: "501", scale: 1 });
    const before = valueHolding(
      q("share:synthetic", "10"),
      price({
        baseInstrumentRef: "share:synthetic",
        baseQuantity: integerDecimal(1),
        quoteAmount: integerDecimal(100),
      }),
      { instrumentClass: "listed-equity" },
    );
    const after = valueHolding(
      q("share:synthetic", "20"),
      price({
        baseInstrumentRef: "share:synthetic",
        baseQuantity: integerDecimal(1),
        quoteAmount: integerDecimal(50),
      }),
      { instrumentClass: "listed-equity" },
    );
    expect(before.valued && quantityText(before.value)).toBe("1000");
    expect(after.valued && quantityText(after.value)).toBe("1000");
    // The comparison price in SC08 is JPY-quoted by fixture default; the point is
    // that the extra ten units are neither income nor a purchase.
    const totalCost: ExactDecimal = ok(
      multiplyByRatio(unitCost, { numerator: "20", denominator: "1" }),
    ).value;
    expect(totalCost).toEqual(integerDecimal(1002));
  });
});
