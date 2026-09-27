import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  domesticCurrentPrice,
  foreignStockPrice,
  fxBoardPrice,
  inDomesticRecord,
  PRICE_RULE_CLAIM_KIND,
  PRICE_RULE_IDS,
  priceClaimRef,
  priceEffectiveTime,
  priceId,
  SBI_SHINSEI_FX_PER_UNIT_CURRENCIES,
  SBI_SHINSEI_FX_QUOTE_BASIS,
  stageMatches,
  type DomesticPriceRow,
  type ForeignPositionRow,
  type FxBoardRow,
  type FxQuoteBasisTable,
} from "../src/price-sources.ts";
import { validPriceObservation } from "../src/metrics.ts";

const FETCHED = "2026-09-07T00:02:00.000Z";
const FOREIGN = new URL(
  "../../../tests/fixtures/observation-pipeline/sbi-securities/2026-08-20/run-20260820-210000-poc01/foreign-cash-positions.json",
  import.meta.url,
);

/** The synthetic fixture's elements, as the foreign parser stores them. */
function foreignRows(): ForeignPositionRow[] {
  const body = JSON.parse(readFileSync(FOREIGN, "utf8")) as {
    listSecuritiesBalances: { securitiesBalances: Record<string, unknown>[] };
  };
  return body.listSecuritiesBalances.securitiesBalances.map((element, index) => ({
    observationId: 10 + index,
    parseRunId: 7,
    sourceId: "sbi-securities",
    parserName: "sbi-foreign-cash-positions",
    securityCode: String((element["securities"] as Record<string, unknown>)["securitiesCode"]),
    market: String((element["market"] as Record<string, unknown>)["marketCode"]),
    quantityText: String(element["securitiesQuantity"]),
    currency: String(element["currencyCode"]),
    asOf: null,
    fetchedAt: FETCHED,
    extra: element,
  }));
}

const fxRow = (overrides: Partial<FxBoardRow> = {}): FxBoardRow => ({
  observationId: 1,
  parseRunId: 2,
  sourceId: "sbi-shinsei-bank",
  parserName: "sbi-shinsei-exchange-rate",
  sourceAccount: "sbi-shinsei:fx-board",
  subject: "USD",
  metric: "bank_mid_rate",
  currency: "JPY",
  amountText: "146.00",
  asOf: "2026-09-07T09:01:00+09:00",
  fetchedAt: FETCHED,
  customerCategory: "SYNTHETIC",
  ...overrides,
});
const VERIFIED: FxQuoteBasisTable = {
  USD: { customerCategory: "SYNTHETIC", baseQuantity: "1", evidence: "synthetic" },
  KRW: { customerCategory: "SYNTHETIC", baseQuantity: "100", evidence: "synthetic" },
};

const domesticRow = (overrides: Partial<DomesticPriceRow> = {}): DomesticPriceRow => ({
  observationId: 30,
  parseRunId: 3,
  sourceId: "sbi-securities",
  parserName: "sbi-domestic-cash-positions",
  metric: "current_price",
  securityCode: "1234",
  priceText: "2512.5",
  priceCurrency: "JPY",
  asOf: null,
  fetchedAt: FETCHED,
  positions: [{ market: "XTKS", quantityText: "200", asOf: null }],
  marketValues: [{ amountText: "502500", currency: "JPY" }],
  ...overrides,
});

describe("the rule list", () => {
  test("is closed, and each rule reads one claim kind", () => {
    expect<string[]>([...PRICE_RULE_IDS].sort()).toEqual(Object.keys(PRICE_RULE_CLAIM_KIND).sort());
    expect(PRICE_RULE_CLAIM_KIND["sbi-foreign-stock-price-last-v1"]).toBe("position");
  });

  test("the price id is a digest of the rule and the claim, and a new claim is a new id", async () => {
    const claim = {
      claimKind: "valuation" as const,
      observationId: 1,
      parseRunId: 2,
      jsonPath: "$.amount_text",
    };
    expect(priceClaimRef(claim)).toBe("valuation_observations/1#$.amount_text");
    const id = await priceId("fx-sbi-shinsei-board-v1", claim);
    expect(id).toMatch(/^price_[0-9a-f]{64}$/u);
    expect(await priceId("fx-sbi-shinsei-board-v1", claim)).toBe(id);
    expect(await priceId("fx-sbi-shinsei-board-v1", { ...claim, observationId: 3 })).not.toBe(id);
    expect(await priceId("sbi-domestic-current-price-v1", claim)).not.toBe(id);
  });

  test("effective time is the provider instant, else the fetch instant marked collector", () => {
    expect(priceEffectiveTime("2026-09-07T09:01:00+09:00", "Asia/Tokyo", FETCHED)).toEqual({
      kind: "instant",
      value: "2026-09-07T09:01:00+09:00",
      zone: "Asia/Tokyo",
      basis: "provider",
    });
    for (const provider of [null, "2026-09-07"])
      expect(priceEffectiveTime(provider, "Asia/Tokyo", FETCHED)).toEqual({
        kind: "instant",
        value: FETCHED,
        zone: "UTC",
        basis: "collector",
      });
  });
});

describe("fx-sbi-shinsei-board-v1", () => {
  test("the manual table stays empty, so without a stated stage production promotes no FX row", () => {
    expect(Object.keys(SBI_SHINSEI_FX_QUOTE_BASIS)).toEqual([]);
    // USD is quoted per 1 unit by the provider's pages, but no stage is known.
    expect(fxBoardPrice(fxRow()).outcome).toBe("stage_unstated");
    expect(fxBoardPrice(fxRow({ customerCategoryJson: '"SYNTHETIC"' })).outcome).toBe(
      "stage_unstated",
    );
  });

  test("a verified per-1 currency maps mid, buy and sell to reference, bid and ask", () => {
    const kinds = ["bank_mid_rate", "bank_buy_rate", "bank_sell_rate"].map((metric) => {
      const verdict = fxBoardPrice(fxRow({ metric }), VERIFIED);
      if (verdict.outcome !== "promoted") throw new Error(verdict.outcome);
      expect(verdict.price).toMatchObject({
        baseInstrumentRef: "USD",
        baseQuantity: { coefficient: "1", scale: 0 },
        quoteUnitRef: "JPY",
        quoteAmount: { coefficient: "146", scale: 0 },
        effectiveTime: { basis: "provider", zone: "Asia/Tokyo" },
        sourceClaimRef: "valuation_observations/1#$.amount_text",
      });
      expect(validPriceObservation({ id: "price_x", ...verdict.price })).toBe(true);
      return verdict.price.priceKind;
    });
    expect(kinds).toEqual(["reference", "bid", "ask"]);
  });

  test("a per-100 quote is refused and never rescaled; an unlisted currency is unsupported", () => {
    expect(fxBoardPrice(fxRow({ subject: "KRW" }), VERIFIED).outcome).toBe("basis_unverified");
    // EUR has no manual entry: the stage path decides it, and no stage is stated.
    expect(fxBoardPrice(fxRow({ subject: "EUR" }), VERIFIED).outcome).toBe("stage_unstated");
    expect(fxBoardPrice(fxRow({ subject: "CHF" }), VERIFIED).outcome).toBe("unsupported_currency");
    expect(fxBoardPrice(fxRow({ currency: "USD" }), VERIFIED).outcome).toBe("unsupported_currency");
    expect(fxBoardPrice(fxRow({ subject: "JPY" }), VERIFIED).outcome).toBe("unsupported_currency");
  });

  test("a missing or non-positive rate is never zero and never promoted", () => {
    for (const amountText of [null, "0", "-1", "1e2", "abc"])
      expect(fxBoardPrice(fxRow({ amountText }), VERIFIED).outcome).toBe("basis_unverified");
    expect(fxBoardPrice(fxRow({ metric: "bank_cash_rate" }), VERIFIED).outcome).toBe(
      "basis_unverified",
    );
  });

  test("a board listing a currency once per tier promotes nothing until an admission names a tier", () => {
    // The stored boards' shape (ADR 0028): one row per currency per tier.
    const tiers = ["SYNTHETIC-TIER-1", "SYNTHETIC-TIER-2", "SYNTHETIC-TIER-3", 4, null];
    for (const customerCategory of tiers) {
      expect(fxBoardPrice(fxRow({ customerCategory })).outcome).toBe("stage_unstated");
      // An admission of the currency for another tier reads none of them.
      expect(fxBoardPrice(fxRow({ customerCategory }), VERIFIED).outcome).toBe(
        "unsupported_currency",
      );
    }
    const tier2: FxQuoteBasisTable = {
      USD: { customerCategory: "SYNTHETIC-TIER-2", baseQuantity: "1", evidence: "synthetic" },
    };
    expect(
      tiers.map((customerCategory) => fxBoardPrice(fxRow({ customerCategory }), tier2).outcome),
    ).toEqual([
      "unsupported_currency",
      "promoted",
      "unsupported_currency",
      "unsupported_currency",
      "unsupported_currency",
    ]);
    // The tier is matched as the provider sent it: 4 is not "4".
    const numeric: FxQuoteBasisTable = {
      USD: { customerCategory: 4, baseQuantity: "1", evidence: "synthetic" },
    };
    expect(fxBoardPrice(fxRow({ customerCategory: 4 }), numeric).outcome).toBe("promoted");
    expect(fxBoardPrice(fxRow({ customerCategory: "4" }), numeric).outcome).toBe(
      "unsupported_currency",
    );
  });

  test("a manual entry decides its currency alone; the stage path never overrides it", () => {
    const stage = { state: "stated", categoryJson: '"SYNTHETIC-TIER-2"' } as const;
    const tier2Row = {
      customerCategory: "SYNTHETIC-TIER-2",
      customerCategoryJson: '"SYNTHETIC-TIER-2"',
    };
    // VERIFIED admits USD in tier SYNTHETIC only; the stage names tier 2.
    expect(fxBoardPrice(fxRow({ ...tier2Row, stage }), VERIFIED).outcome).toBe(
      "unsupported_currency",
    );
    expect(fxBoardPrice(fxRow({ ...tier2Row, stage })).outcome).toBe("promoted");
  });

  test("without a provider time the fetch instant is used, marked collector", () => {
    const verdict = fxBoardPrice(fxRow({ asOf: null }), VERIFIED);
    expect(verdict.outcome === "promoted" && verdict.price.effectiveTime).toEqual({
      kind: "instant",
      value: FETCHED,
      zone: "UTC",
      basis: "collector",
    });
  });
});

describe("sbi-foreign-stock-price-last-v1", () => {
  test("the basis check promotes VT and AAPL from the fixture", () => {
    const verdicts = foreignRows().map(foreignStockPrice);
    expect(
      verdicts.map((verdict) =>
        verdict.outcome === "promoted"
          ? [verdict.price.baseInstrumentRef, verdict.price.quoteUnitRef, verdict.price.quoteAmount]
          : verdict.outcome,
      ),
    ).toEqual([
      ["instrument:sbi-securities:NYSEARCA:VT", "USD", { coefficient: "1307", scale: 1 }],
      ["instrument:sbi-securities:NASDAQ:AAPL", "USD", { coefficient: "22435", scale: 2 }],
    ]);
    for (const verdict of verdicts) {
      if (verdict.outcome !== "promoted") throw new Error(verdict.outcome);
      expect(verdict.claim).toEqual({
        claimKind: "position",
        observationId: verdict.claim.observationId,
        parseRunId: 7,
        jsonPath: "$.stockPrice.last",
      });
      expect(verdict.price.effectiveTime).toMatchObject({ basis: "collector", value: FETCHED });
      expect(validPriceObservation({ id: "price_x", ...verdict.price })).toBe(true);
    }
  });

  test("a tampered row fails the basis check and is refused", () => {
    const tamper = (change: (element: Record<string, unknown>) => void) => {
      const row = foreignRows()[0]!;
      const element = structuredClone(row.extra) as Record<string, unknown>;
      change(element);
      return foreignStockPrice({ ...row, extra: element });
    };
    // One cent off the price, the market value, or a price per 10 shares.
    expect(
      tamper((e) => ((e["stockPrice"] as Record<string, unknown>)["last"] = "130.71")).outcome,
    ).toBe("basis_unverified");
    expect(
      tamper(
        (e) =>
          ((e["evaluationProfitLoss"] as Record<string, unknown>)["frnEvaluationAmount"] =
            "1568.41"),
      ).outcome,
    ).toBe("basis_unverified");
    expect(
      tamper((e) => ((e["stockPrice"] as Record<string, unknown>)["last"] = "1307.0")).outcome,
    ).toBe("basis_unverified");
    expect(tamper((e) => delete e["stockPrice"]).outcome).toBe("basis_unverified");
    expect(tamper((e) => (e["currencyCode"] = "EUR")).outcome).toBe("unsupported_currency");
    const row = foreignRows()[0]!;
    expect(foreignStockPrice({ ...row, quantityText: "13" }).outcome).toBe("basis_unverified");
    expect(foreignStockPrice({ ...row, currency: null }).outcome).toBe("unsupported_currency");
  });
});

describe("sbi-domestic-current-price-v1", () => {
  test("quantity × price equal to the market value promotes a per-1-share JPY price", () => {
    const verdict = domesticCurrentPrice(domesticRow());
    if (verdict.outcome !== "promoted") throw new Error(verdict.outcome);
    expect(verdict.price).toMatchObject({
      baseInstrumentRef: "instrument:sbi-securities:XTKS:1234",
      baseQuantity: { coefficient: "1", scale: 0 },
      quoteUnitRef: "JPY",
      quoteAmount: { coefficient: "25125", scale: 1 },
      priceKind: "reference",
      marketRef: "XTKS",
      effectiveTime: { basis: "collector", value: FETCHED },
    });
  });

  test("a mismatch, an ambiguous or missing pairing, or a foreign unit is refused", () => {
    expect(domesticCurrentPrice(domesticRow({ priceText: "2512" })).outcome).toBe(
      "basis_unverified",
    );
    expect(
      domesticCurrentPrice(
        domesticRow({ marketValues: [{ amountText: "502501", currency: "JPY" }] }),
      ).outcome,
    ).toBe("basis_unverified");
    expect(domesticCurrentPrice(domesticRow({ positions: [] })).outcome).toBe("basis_unverified");
    const two = domesticRow().positions;
    expect(domesticCurrentPrice(domesticRow({ positions: [...two, ...two] })).outcome).toBe(
      "basis_unverified",
    );
    expect(domesticCurrentPrice(domesticRow({ marketValues: [] })).outcome).toBe(
      "basis_unverified",
    );
    expect(domesticCurrentPrice(domesticRow({ priceCurrency: "USD" })).outcome).toBe(
      "unsupported_currency",
    );
    expect(domesticCurrentPrice(domesticRow({ metric: "acquisition_unit_price" })).outcome).toBe(
      "basis_unverified",
    );
  });

  test("the record pairing is POSITION_VALUATIONS_SQL's locator rule", () => {
    const at = (offset: number, width = 423) =>
      `mts-shift-jis:payload-byte=${offset},width=${width}`;
    expect(inDomesticRecord(at(34), at(164, 11))).toBe(true);
    expect(inDomesticRecord(at(34), at(34 + 422, 1))).toBe(true);
    expect(inDomesticRecord(at(34), at(34 + 423, 11))).toBe(false);
    expect(inDomesticRecord(at(457), at(164, 11))).toBe(false);
    expect(inDomesticRecord("json:$", at(164))).toBe(false);
  });
});

describe("fx-sbi-shinsei-board-v1: the stage category of the same run (ADR 0031)", () => {
  const stated = (categoryJson: string) => ({ state: "stated", categoryJson }) as const;
  const tierRow = (category: string | number | null, overrides: Partial<FxBoardRow> = {}) =>
    fxRow({
      customerCategory: category,
      customerCategoryJson: category === null ? null : JSON.stringify(category),
      ...overrides,
    });

  test("the per-1-unit list is the provider's 13 currencies; CHF and JPY are never on it", () => {
    expect([...SBI_SHINSEI_FX_PER_UNIT_CURRENCIES].sort()).toEqual([
      "AUD",
      "BRL",
      "CAD",
      "CNY",
      "EUR",
      "GBP",
      "HKD",
      "NOK",
      "NZD",
      "SGD",
      "TRY",
      "USD",
      "ZAR",
    ]);
    expect(SBI_SHINSEI_FX_PER_UNIT_CURRENCIES).not.toContain("CHF");
    expect(SBI_SHINSEI_FX_PER_UNIT_CURRENCIES).not.toContain("JPY");
    const stage = stated('"SYNTHETIC-TOP"');
    for (const subject of SBI_SHINSEI_FX_PER_UNIT_CURRENCIES)
      expect(fxBoardPrice(tierRow("SYNTHETIC-TOP", { subject, stage })).outcome).toBe("promoted");
    expect(fxBoardPrice(tierRow("SYNTHETIC-TOP", { subject: "CHF", stage })).outcome).toBe(
      "unsupported_currency",
    );
    expect(fxBoardPrice(tierRow("SYNTHETIC-TOP", { subject: "JPY", stage })).outcome).toBe(
      "unsupported_currency",
    );
    expect(fxBoardPrice(tierRow("SYNTHETIC-TOP", { subject: "KRW", stage })).outcome).toBe(
      "unsupported_currency",
    );
  });

  test("of five tiers exactly the stated one promotes, per 1 unit, with mid, buy and sell", () => {
    const tiers = ["SYNTHETIC-1", "SYNTHETIC-2", "SYNTHETIC-3", "SYNTHETIC-4", "SYNTHETIC-TOP"];
    const stage = stated('"SYNTHETIC-TOP"');
    expect(tiers.map((tier) => fxBoardPrice(tierRow(tier, { stage })).outcome)).toEqual([
      "tier_unmatched",
      "tier_unmatched",
      "tier_unmatched",
      "tier_unmatched",
      "promoted",
    ]);
    const kinds = ["bank_mid_rate", "bank_buy_rate", "bank_sell_rate"].map((metric) => {
      const verdict = fxBoardPrice(tierRow("SYNTHETIC-TOP", { stage, metric }));
      if (verdict.outcome !== "promoted") throw new Error(verdict.outcome);
      expect(verdict.price).toMatchObject({
        baseInstrumentRef: "USD",
        baseQuantity: { coefficient: "1", scale: 0 },
        quoteUnitRef: "JPY",
      });
      expect(validPriceObservation({ id: "price_x", ...verdict.price })).toBe(true);
      return verdict.price.priceKind;
    });
    expect(kinds).toEqual(["reference", "bid", "ask"]);
  });

  test("equality is strict: a string never equals a number, and nothing is trimmed or folded", () => {
    expect(fxBoardPrice(tierRow("3", { stage: stated("3") })).outcome).toBe("tier_unmatched");
    expect(fxBoardPrice(tierRow(3, { stage: stated('"3"') })).outcome).toBe("tier_unmatched");
    expect(fxBoardPrice(tierRow(3, { stage: stated("3") })).outcome).toBe("promoted");
    expect(fxBoardPrice(tierRow(" top", { stage: stated('"top"') })).outcome).toBe(
      "tier_unmatched",
    );
    expect(fxBoardPrice(tierRow("TOP", { stage: stated('"top"') })).outcome).toBe("tier_unmatched");
    expect(stageMatches("true", stated("true"))).toBe(false);
    expect(stageMatches("null", stated("null"))).toBe(false);
    expect(stageMatches('""', stated('""'))).toBe(false);
    expect(stageMatches('{"a":1}', stated('{"a":1}'))).toBe(false);
    expect(stageMatches("not json", stated("not json"))).toBe(false);
    expect(stageMatches(null, stated('"A"'))).toBe(false);
  });

  test("no promotion when the run's stage is absent or its observations disagree", () => {
    for (const stage of [{ state: "absent" }, { state: "disagreeing" }] as const)
      expect(fxBoardPrice(tierRow("SYNTHETIC-TOP", { stage })).outcome).toBe("stage_unstated");
    // A row without a category never matches, whatever the stage.
    expect(fxBoardPrice(tierRow(null, { stage: stated('"SYNTHETIC-TOP"') })).outcome).toBe(
      "tier_unmatched",
    );
  });

  test("a currency listed once in another tier is not the owner's rate: no fallback to it", () => {
    const stage = stated('"SYNTHETIC-TOP"');
    expect(fxBoardPrice(tierRow("SYNTHETIC-2", { subject: "NOK", stage })).outcome).toBe(
      "tier_unmatched",
    );
    expect(fxBoardPrice(tierRow("SYNTHETIC-TOP", { subject: "NOK", stage })).outcome).toBe(
      "promoted",
    );
  });

  test("an admitted tier still needs a positive exact rate and a JPY quote", () => {
    const stage = stated('"SYNTHETIC-TOP"');
    for (const amountText of [null, "0", "-1", "1e2"])
      expect(fxBoardPrice(tierRow("SYNTHETIC-TOP", { stage, amountText })).outcome).toBe(
        "basis_unverified",
      );
    expect(fxBoardPrice(tierRow("SYNTHETIC-TOP", { stage, currency: "USD" })).outcome).toBe(
      "unsupported_currency",
    );
    expect(
      fxBoardPrice(tierRow("SYNTHETIC-TOP", { stage, sourceAccount: "sbi-shinsei:other" })).outcome,
    ).toBe("basis_unverified");
  });
});
