import { describe, expect, test } from "bun:test";
import { classifyActivity } from "../../../poc/observation-pipeline/shared/activity-semantics.ts";
import { classifyBalance } from "../../../poc/observation-pipeline/shared/balance-semantics.ts";
import {
  additivityVerdict,
  METRIC_REGISTRY,
  metricById,
  resolveMetric,
  UNKNOWN_METRIC,
  validMetricDefinition,
  validPriceObservation,
  valueAtPrice,
  type MetricLookup,
  type PriceObservation,
} from "../src/metrics.ts";
import { integerDecimal } from "../src/values.ts";
import { q } from "./helpers.ts";

/** One synthetic lookup per selector, exercising every listed metric. */
function lookupsFor(
  selector: (typeof METRIC_REGISTRY)[number]["selectors"][number],
): MetricLookup[] {
  const sourceAccount =
    selector.sourceAccountEquals ??
    (selector.sourceAccountPrefix
      ? `${selector.sourceAccountPrefix}0`
      : `${selector.sourceId}:synthetic`);
  const metrics = selector.metrics ?? [null];
  return metrics.map((metric) => ({
    family: selector.family,
    sourceId: selector.sourceId,
    parserName: selector.parserName,
    metric,
    sourceAccount,
    amountBasis: selector.amountBasis ?? null,
  }));
}

describe("metric registry seeded from the current PoC rules", () => {
  test("every balance definition matches classifyBalance for its selectors (no behaviour change)", () => {
    let checked = 0;
    for (const { selectors, definition } of METRIC_REGISTRY)
      for (const selector of selectors) {
        if (selector.family !== "balance") continue;
        for (const lookup of lookupsFor(selector)) {
          expect(resolveMetric(lookup)).toBe(definition);
          const legacy = classifyBalance({
            sourceId: lookup.sourceId,
            parserName: lookup.parserName,
            metric: lookup.metric!,
            sourceAccount: lookup.sourceAccount!,
          });
          expect(legacy.netAssetEligible).toBe(false);
          expect(definition.legacyBalance).toEqual({
            kind: legacy.kind,
            measurementKind: legacy.measurementKind!,
            assetClass: legacy.assetClass!,
            timeBasis: legacy.timeBasis!,
          });
          checked += 1;
        }
      }
    expect(checked).toBeGreaterThanOrEqual(20);
  });

  test("every transaction definition matches classifyActivity for its selectors", () => {
    let checked = 0;
    for (const { selectors, definition } of METRIC_REGISTRY)
      for (const selector of selectors) {
        if (selector.family !== "transaction") continue;
        for (const lookup of lookupsFor(selector)) {
          expect(resolveMetric(lookup)).toBe(definition);
          const legacy = classifyActivity({
            sourceId: lookup.sourceId,
            parserName: lookup.parserName!,
            status: null,
            extra:
              lookup.amountBasis === null ? {} : { _kogane: { amountBasis: lookup.amountBasis } },
          });
          expect(definition.legacyActivity).toEqual({ kind: legacy.kind });
          checked += 1;
        }
      }
    expect(checked).toBeGreaterThanOrEqual(14);
  });

  test("selector order preserves the PoC precedence for shared parsers", () => {
    const shinseiPair = resolveMetric({
      family: "balance",
      sourceId: "sbi-shinsei-bank",
      parserName: "sbi-shinsei-yen-deposit-account",
      metric: "yen_deposit_savings_balance",
      sourceAccount: "sbi-shinsei-bank:1",
      amountBasis: null,
    });
    expect(shinseiPair.metricId).toBe("deposit.balance");
    expect(
      resolveMetric({
        family: "balance",
        sourceId: "sbi-securities",
        parserName: "sbi-foreign-cash-balances",
        metric: "keep_cash",
        sourceAccount: "sbi-securities:usd",
        amountBasis: null,
      }).measurementKind,
    ).toBe("stock");
    expect(
      resolveMetric({
        family: "balance",
        sourceId: "sbi-securities",
        parserName: "sbi-foreign-cash-balances",
        metric: "buy_possible_amount",
        sourceAccount: "sbi-securities:usd",
        amountBasis: null,
      }).measurementKind,
    ).toBe("capacity");
    expect(
      resolveMetric({
        family: "balance",
        sourceId: "v-point",
        parserName: "v-point-balance-info",
        metric: "available_point_bucket",
        sourceAccount: "v-point:store-limited:0",
        amountBasis: null,
      }).metricId,
    ).toBe("reward.store-limited-bucket-balance");
    expect(
      resolveMetric({
        family: "balance",
        sourceId: "v-point",
        parserName: "v-point-smfg-point",
        metric: "displayed_point_balance",
        sourceAccount: "v-point:smfg",
        amountBasis: null,
      }),
    ).toMatchObject({
      measurementKind: "period-total",
      unitDimension: "reward",
      aggregationRule: "non-additive",
    });
    expect(
      resolveMetric({
        family: "balance",
        sourceId: "myjcb",
        parserName: "myjcb-credit-past-month-balances",
        metric: "credit_statement_payment_amount",
        sourceAccount: "myjcb:card",
        amountBasis: null,
      }),
    ).toMatchObject({
      measurementKind: "period-total",
      aggregationRule: "non-additive",
      overlapGroup: "myjcb:statement",
    });
    expect(
      resolveMetric({
        family: "transaction",
        sourceId: "myjcb",
        parserName: "myjcb-credit-ledger",
        metric: null,
        sourceAccount: "myjcb:card",
        amountBasis: "current-statement-payment",
      }),
    ).toMatchObject({ measurementKind: "obligation", overlapGroup: "myjcb:statement" });
  });

  test("unknown metrics resolve to the explicit non-additive definition, matching the PoC fallback", () => {
    for (const lookup of [
      { sourceId: "moneyforward", parserName: "moneyforward-balances", metric: "amount" },
      {
        sourceId: "sbi-securities",
        parserName: "sbi-foreign-cash-balances",
        metric: "settlement_pending",
      },
      { sourceId: "sbi-vc-trade", parserName: "sbi-vc-account-margin", metric: "margin_balance" },
      {
        sourceId: "mobile-suica",
        parserName: "mobile-suica-sf-history",
        metric: "sf_balance_after_transaction",
      },
      { sourceId: "new-bank", parserName: null, metric: "balance" },
    ]) {
      const definition = resolveMetric({
        family: "balance",
        ...lookup,
        sourceAccount: "mobile-suica:commuter-pass",
        amountBasis: null,
      });
      expect(definition).toBe(UNKNOWN_METRIC);
      expect(definition.aggregationRule).toBe("non-additive");
      const legacy = classifyBalance({
        sourceId: lookup.sourceId,
        parserName: lookup.parserName,
        metric: lookup.metric,
        sourceAccount: "mobile-suica:commuter-pass",
      });
      expect(legacy.kind).toBe("other");
      expect(legacy.measurementKind).toBe(definition.legacyBalance!.measurementKind);
    }
    expect(metricById("unknown")).toBe(UNKNOWN_METRIC);
    expect(metricById("deposit.balance")?.aggregationRule).toBe("sum-disjoint");
    expect(metricById("nope")).toBeNull();
  });

  test("definitions are valid, unique, and never net-asset eligible", () => {
    const ids = METRIC_REGISTRY.map(({ definition }) => definition.metricId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { definition } of [...METRIC_REGISTRY, { definition: UNKNOWN_METRIC }]) {
      expect(validMetricDefinition(definition)).toBe(true);
      expect(definition.netAssetEligible).toBe(false);
    }
    expect(validMetricDefinition({ ...UNKNOWN_METRIC, netAssetEligible: true })).toBe(false);
    expect(validMetricDefinition({ ...UNKNOWN_METRIC, label: "x" })).toBe(false);
  });

  test("additivity is decided by metric, dimension, rule and overlap group", () => {
    const deposit = metricById("deposit.balance")!;
    const capacity = metricById("broker.buying-power")!;
    const statement = metricById("card.statement-payment-amount")!;
    expect(additivityVerdict(deposit, deposit)).toEqual({ additive: true });
    expect(additivityVerdict(deposit, capacity)).toEqual({
      additive: false,
      reasonCode: "metric_mismatch",
    });
    expect(additivityVerdict(capacity, capacity)).toEqual({
      additive: false,
      reasonCode: "not_sum_disjoint",
    });
    expect(additivityVerdict(statement, statement)).toEqual({
      additive: false,
      reasonCode: "not_sum_disjoint",
    });
    const grouped = { ...deposit, overlapGroup: "g" };
    expect(additivityVerdict(grouped, grouped)).toEqual({
      additive: false,
      reasonCode: "shared_overlap_group",
    });
  });
});

describe("price basis", () => {
  const nav: PriceObservation = {
    id: "price:fund:1",
    baseInstrumentRef: "fund:synthetic",
    baseQuantity: integerDecimal(10000),
    quoteUnitRef: "JPY",
    quoteAmount: integerDecimal(8000),
    priceKind: "nav",
    effectiveTime: {
      kind: "local-date",
      value: "2026-09-01",
      zone: "Asia/Tokyo",
      basis: "provider",
    },
    sourceClaimRef: "claim:fund-nav:1",
    marketRef: null,
    adjustmentPolicyRef: null,
  };

  test("values 12,500 units at 8,000 per 10,000 units as 10,000, not 12,500 × 8,000", () => {
    expect(validPriceObservation(nav)).toBe(true);
    expect(valueAtPrice(q("fund:synthetic", "12500"), nav)).toEqual({
      ok: true,
      quantity: q("JPY", "10000"),
    });
    expect(valueAtPrice(q("share:synthetic", "12500"), nav)).toMatchObject({
      ok: false,
      error: { code: "unit_mismatch" },
    });
    expect(
      valueAtPrice(
        { unitRef: "fund:synthetic", value: { status: "missing", reasonCode: "x" } },
        nav,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "value_not_exact" },
    });
    expect(validPriceObservation({ ...nav, baseQuantity: integerDecimal(0) })).toBe(false);
    expect(validPriceObservation({ ...nav, price: 8000 })).toBe(false);
  });
});
