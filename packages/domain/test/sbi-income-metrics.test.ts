import { expect, test } from "bun:test";
import { resolveMetric, additivityVerdict } from "../src/metrics.ts";

test("reported SBI payment/sale measures have typed event semantics and remain non-additive", () => {
  for (const [parserName, metrics] of [
    [
      "sbi-income-payments",
      ["income_gross", "income_tax", "income_income_tax", "income_resident_tax", "income_net"],
    ],
    [
      "sbi-realised-gains",
      [
        "sale_proceeds",
        "realised_gain_before_tax",
        "sale_unit_price",
        "average_acquisition_unit_cost",
      ],
    ],
  ] as const) {
    for (const metric of metrics) {
      const definition = resolveMetric({
        family: "valuation",
        sourceId: "sbi-securities",
        parserName,
        metric,
        sourceAccount: "sbi-securities:synthetic",
        amountBasis: null,
      });
      expect(definition).toMatchObject({
        metricId: `sbi-securities.${metric}`,
        measurementKind:
          metric === "sale_unit_price" || metric === "average_acquisition_unit_cost"
            ? "price"
            : "flow",
        timeBasis: "event-reported",
        subjectKind: "product",
        sourceAuthority: "provider-reported",
        aggregationRule: "non-additive",
        netAssetEligible: false,
      });
      expect(additivityVerdict(definition, definition).additive).toBe(false);
    }
  }
});
