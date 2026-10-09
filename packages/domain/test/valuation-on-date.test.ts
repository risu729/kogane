// Valuation of reported holdings on a date (src/valuation-on-date.ts; ADR 0056,
// amendment "Valuation on a date as implemented"). Every instrument, quantity,
// price, rate and policy here is invented.
import { describe, expect, test } from "bun:test";
import {
  fxKey,
  selectFxRate,
  selectPrice,
  type FxConversionPolicy,
  type PriceCandidate,
  type PriceKey,
  type PriceSelection,
  type PriceSelectionPolicy,
  type SelectionBound,
} from "../src/market-data.ts";
import type { IdentityStatus } from "../src/reported-state.ts";
import {
  holdingPriceWant,
  valueHoldingsOnDate,
  type HoldingOnDate,
  type HoldingValueOnDate,
  type ValuationOnDate,
  type ValuationOnDateInput,
  type ValuationOnDatePolicy,
} from "../src/valuation-on-date.ts";
import { absentQuantity, decimalLiteral, type Quantity } from "../src/values.ts";
import { q, quantityText } from "./helpers.ts";

const PRICE: PriceSelectionPolicy = {
  policyId: "test:holding-price",
  admittedRules: ["sbi-domestic-current-price-v1", "sbi-foreign-stock-price-last-v1"],
  priceKinds: ["reference"],
  acceptedBases: ["provider", "collector"],
  zone: "Asia/Tokyo",
  freshness: { unit: "calendar-days", maxAgeDays: 3 },
  dateOnly: "exclude",
  multiSource: "refuse-on-overlap",
  candidateScope: "same-snapshot",
};
const FX: FxConversionPolicy = {
  policyId: "test:fx-conversion",
  pivot: "JPY",
  currencies: ["USD", "AUD"],
  selection: {
    ...PRICE,
    policyId: "test:fx-selection",
    admittedRules: ["fx-sbi-shinsei-board-v1"],
    freshness: { unit: "calendar-days", maxAgeDays: 4 },
    candidateScope: "latest-in-window",
  },
  inverse: null,
};
const POLICY: ValuationOnDatePolicy = { price: PRICE, fx: FX, calendars: [] };
const BOUND: SelectionBound = {
  effectiveBefore: "2026-09-10T15:00:00.000Z",
  asOfDate: "2026-09-10",
  knowledge: { mode: "current" },
};
const REPORTED: ValuationOnDateInput["reportedState"] = {
  date: "2026-09-10",
  cutoff: "2026-09-10T15:00:00.000Z",
  filters: { source: null, account: null },
  quantityPolicy: "decimal-v1",
  contextId: "0".repeat(64),
  positionContainersWithoutSnapshot: [],
  stalePositionSnapshots: [],
};

const ALPHA = "instrument:test-broker:-:ALPHA";
const BETA = "instrument:test-broker:-:BETA";

function holding(options: {
  ref: string;
  instrumentRef: string;
  quantity: string | Quantity;
  quoteUnit?: string | null;
  parseRunId?: number;
  status?: IdentityStatus;
  instrumentId?: string | null;
  sourceId?: string;
  snapshotFreshness?: HoldingOnDate["snapshotFreshness"];
  snapshotAgeDays?: number;
}): HoldingOnDate {
  return {
    ref: options.ref,
    sourceId: options.sourceId ?? "test-broker",
    snapshotRef: `artifact:${options.parseRunId ?? 1}`,
    snapshotFreshness: options.snapshotFreshness ?? "same-day",
    snapshotAgeDays: options.snapshotAgeDays ?? 0,
    parseRunId: options.parseRunId ?? 1,
    instrumentRef: options.instrumentRef,
    instrument: {
      instrumentId: options.instrumentId === undefined ? "inst-test" : options.instrumentId,
      status: options.status ?? "provider-local",
    },
    quoteUnit: options.quoteUnit === undefined ? "JPY" : options.quoteUnit,
    quantity:
      typeof options.quantity === "string"
        ? q(options.instrumentRef, options.quantity)
        : options.quantity,
  };
}

let sequence = 0;
function candidate(options: {
  key: PriceKey;
  amount: string;
  id?: string;
  at?: string;
  run?: number;
  baseQuantity?: string;
}): PriceCandidate {
  sequence += 1;
  const fx =
    options.key.quoteUnitRef === "JPY" && /^[A-Z]{3}$/u.test(options.key.baseInstrumentRef);
  return {
    price: {
      id: options.id ?? `price-${sequence}`,
      baseInstrumentRef: options.key.baseInstrumentRef,
      baseQuantity: decimalLiteral(options.baseQuantity ?? "1"),
      quoteUnitRef: options.key.quoteUnitRef,
      quoteAmount: decimalLiteral(options.amount),
      priceKind: options.key.priceKind,
      effectiveTime: {
        kind: "instant",
        value: options.at ?? "2026-09-10T10:00:00+09:00",
        zone: "Asia/Tokyo",
        basis: "provider",
      },
      sourceClaimRef: `valuation_observations/${sequence}#$.amount_text`,
      marketRef: null,
      adjustmentPolicyRef: null,
    },
    recordedAt: "2026-09-10T02:00:00.000Z",
    claim: {
      ruleId: fx
        ? "fx-sbi-shinsei-board-v1"
        : options.key.quoteUnitRef === "JPY"
          ? "sbi-domestic-current-price-v1"
          : "sbi-foreign-stock-price-last-v1",
      claimKind: "valuation",
      observationId: sequence,
      parseRunId: options.run ?? 1,
      jsonPath: "$.amount_text",
    },
  };
}

const key = (instrumentRef: string, quote: string): PriceKey => ({
  baseInstrumentRef: instrumentRef,
  quoteUnitRef: quote,
  priceKind: "reference",
});

/** The selections a caller makes for `holdings`: one per wanted key, through `selectPrice`. */
function priceSelections(
  holdings: readonly HoldingOnDate[],
  candidates: readonly PriceCandidate[],
  policy: PriceSelectionPolicy = PRICE,
): ValuationOnDateInput["prices"] {
  const seen = new Map<string, ValuationOnDateInput["prices"][number]>();
  for (const entry of holdings) {
    const want = holdingPriceWant(entry, policy);
    if (want === null) continue;
    const text = JSON.stringify(want);
    if (seen.has(text)) continue;
    const own = candidates.filter(
      (item) =>
        item.price.baseInstrumentRef === want.key.baseInstrumentRef &&
        item.price.quoteUnitRef === want.key.quoteUnitRef &&
        (want.snapshotParseRunId === null || item.claim.parseRunId === want.snapshotParseRunId),
    );
    seen.set(text, {
      snapshotParseRunId: want.snapshotParseRunId,
      selection: selectPrice(want.key, own, BOUND, policy, null),
    });
  }
  return [...seen.values()];
}

function rates(
  currencies: readonly string[],
  candidates: readonly PriceCandidate[],
  policy: FxConversionPolicy = FX,
): PriceSelection[] {
  return currencies.map((code) =>
    selectFxRate(
      code,
      candidates.filter((item) => item.price.baseInstrumentRef === code),
      BOUND,
      policy,
      null,
    ),
  );
}

const USD_MID = () => candidate({ key: fxKey("USD", FX), id: "usd-mid", amount: "146.25" });
const ALPHA_PRICE = () => candidate({ key: key(ALPHA, "USD"), id: "alpha-px", amount: "130.70" });
const BETA_PRICE = () => candidate({ key: key(BETA, "JPY"), id: "beta-px", amount: "1500" });

function input(
  holdings: readonly HoldingOnDate[],
  candidates: readonly PriceCandidate[],
  overrides: Partial<ValuationOnDateInput> = {},
): ValuationOnDateInput {
  return {
    policy: POLICY,
    baseUnit: "JPY",
    bound: BOUND,
    reportedState: REPORTED,
    holdings,
    prices: priceSelections(holdings, candidates),
    fx: rates(["USD", "AUD"], candidates),
    ...overrides,
  };
}

function computed(result: ValuationOnDate) {
  if (result.status !== "computed") throw new Error(result.reasonCode);
  return result;
}
function outcome(result: ValuationOnDate, ref: string): HoldingValueOnDate {
  const found = computed(result).holdings.find((entry) => entry.holdingRef === ref);
  if (found === undefined) throw new Error(`no ${ref}`);
  return found;
}

const TWO = () => [
  holding({ ref: "position:1", instrumentRef: ALPHA, quantity: "12", quoteUnit: "USD" }),
  holding({ ref: "position:2", instrumentRef: BETA, quantity: "100" }),
];

describe("valued holdings", () => {
  test("a foreign holding in two exact hops and a yen holding in one, with an exact total", async () => {
    const result = computed(
      await valueHoldingsOnDate(input(TWO(), [ALPHA_PRICE(), BETA_PRICE(), USD_MID()])),
    );
    const alpha = outcome(result, "position:1");
    if (alpha.outcome !== "valued") throw new Error(alpha.outcome);
    expect(quantityText(alpha.local)).toBe("1568.4");
    expect(alpha.local.unitRef).toBe("USD");
    expect(quantityText(alpha.value)).toBe("229378.5");
    expect(alpha.value.unitRef).toBe("JPY");
    expect(alpha.legs.map((leg) => [leg.leg, leg.priceId, leg.policyId])).toEqual([
      ["price", "alpha-px", "test:holding-price"],
      ["fx", "usd-mid", "test:fx-selection"],
    ]);
    expect(alpha.roundingInputs).toBeNull();
    const beta = outcome(result, "position:2");
    if (beta.outcome !== "valued") throw new Error(beta.outcome);
    expect(quantityText(beta.value)).toBe("150000");
    expect(beta.legs.map((leg) => leg.leg)).toEqual(["price"]);
    expect(result.total.status === "exact" && quantityText(result.total.value)).toBe("379378.5");
    expect(result.counts).toMatchObject({ valued: 2, unpriced: 0 });
    expect(result.contextId).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("a provider-local instrument mapping is resolved; an identified one too", async () => {
    const holdings = [
      holding({ ref: "position:1", instrumentRef: BETA, quantity: "1", status: "identified" }),
      holding({ ref: "position:2", instrumentRef: BETA, quantity: "2", status: "provider-local" }),
    ];
    const result = computed(await valueHoldingsOnDate(input(holdings, [BETA_PRICE()])));
    expect(result.holdings.map((entry) => entry.outcome)).toEqual(["valued", "valued"]);
    expect(result.total.status === "exact" && quantityText(result.total.value)).toBe("4500");
  });
});

describe("each outcome is closed and named", () => {
  test("an instrument the reported state does not resolve is not valued", async () => {
    const holdings = (["unresolved", "aggregate", "not-recorded"] as const).map((status, index) =>
      holding({ ref: `position:${index + 1}`, instrumentRef: BETA, quantity: "1", status }),
    );
    holdings.push(
      holding({ ref: "position:9", instrumentRef: BETA, quantity: "1", instrumentId: null }),
    );
    const result = computed(await valueHoldingsOnDate(input(holdings, [BETA_PRICE()])));
    expect(
      result.holdings.map((entry) => [
        entry.outcome,
        entry.outcome === "instrument_unresolved" && entry.status,
      ]),
    ).toEqual([
      ["instrument_unresolved", "unresolved"],
      ["instrument_unresolved", "aggregate"],
      ["instrument_unresolved", "not-recorded"],
      ["instrument_unresolved", "provider-local"],
    ]);
    // No price was wanted for any of them.
    expect(input(holdings, [BETA_PRICE()]).prices).toEqual([]);
    expect(result.total).toEqual({ status: "absent", reason: "holding_not_valued" });
  });

  test("a quantity that is not exact is quantity_unknown, never zero", async () => {
    const holdings = [
      holding({
        ref: "position:1",
        instrumentRef: BETA,
        quantity: absentQuantity(BETA, "unparsed", "stored:unparsed"),
      }),
    ];
    const result = computed(await valueHoldingsOnDate(input(holdings, [BETA_PRICE()])));
    expect(result.holdings[0]).toMatchObject({
      outcome: "quantity_unknown",
      reason: "unparsed:stored:unparsed",
    });
    expect(result.total).toEqual({ status: "absent", reason: "holding_not_valued" });
  });

  test("no price is unpriced with the selection's code; a holding without a currency cannot be quoted", async () => {
    const holdings = [
      holding({ ref: "position:1", instrumentRef: BETA, quantity: "1" }),
      holding({ ref: "position:2", instrumentRef: ALPHA, quantity: "1", quoteUnit: null }),
    ];
    const result = computed(await valueHoldingsOnDate(input(holdings, [])));
    expect(result.holdings[0]).toMatchObject({
      outcome: "unpriced",
      reason: "missing",
      priceKey: key(BETA, "JPY"),
      candidateIds: [],
    });
    expect(result.holdings[1]).toMatchObject({
      outcome: "unpriced",
      reason: "unsupported_pair",
      priceKey: null,
    });
  });

  test("a stale price under the policy is unpriced with its id and age, never the latest value", async () => {
    const old = candidate({
      key: key(BETA, "JPY"),
      id: "beta-old",
      amount: "1500",
      at: "2026-09-06T10:00:00+09:00",
    });
    const holdings = [holding({ ref: "position:1", instrumentRef: BETA, quantity: "10" })];
    const result = computed(await valueHoldingsOnDate(input(holdings, [old])));
    expect(result.holdings[0]).toMatchObject({
      outcome: "unpriced",
      reason: "stale",
      candidateIds: ["beta-old"],
      ageDays: 4,
    });
    expect(result.holdings[0]).not.toHaveProperty("value");
    expect(result.total).toEqual({ status: "absent", reason: "holding_not_valued" });
    // At the limit (3 days) the same price values the holding.
    const fresh = candidate({
      key: key(BETA, "JPY"),
      id: "beta-3d",
      amount: "1500",
      at: "2026-09-07T10:00:00+09:00",
    });
    expect(outcome(await valueHoldingsOnDate(input(holdings, [fresh])), "position:1").outcome).toBe(
      "valued",
    );
  });

  test("a zero or negative price is excluded from selection, and refused if handed in selected", async () => {
    const holdings = [holding({ ref: "position:1", instrumentRef: BETA, quantity: "10" })];
    for (const amount of ["0", "-1500"]) {
      const bad = candidate({ key: key(BETA, "JPY"), id: `beta-${amount}`, amount });
      const via = input(holdings, [bad]);
      const selection = via.prices[0]!.selection;
      expect(selection.status === "refused" && selection.excluded.price_not_positive).toBe(1);
      expect(outcome(await valueHoldingsOnDate(via), "position:1")).toMatchObject({
        outcome: "unpriced",
        reason: "missing",
      });
      // A selection built by hand around the bad price still values nothing.
      const handmade: PriceSelection = {
        status: "selected",
        key: key(BETA, "JPY"),
        candidate: bad,
        ageDays: 0,
        corroboratedBy: [],
        excluded: selection.excluded,
        policyId: PRICE.policyId,
      };
      const result = await valueHoldingsOnDate({
        ...via,
        prices: [{ snapshotParseRunId: 1, selection: handmade }],
      });
      expect(outcome(result, "position:1")).toMatchObject({
        outcome: "unpriced",
        reason: "price_not_positive",
        candidateIds: [`beta-${amount}`],
      });
      expect(computed(result).total).toEqual({ status: "absent", reason: "holding_not_valued" });
    }
  });

  test("a price whose basis does not divide the quantity exactly is unpriced, not rounded", async () => {
    const per3 = candidate({
      key: key(BETA, "JPY"),
      id: "beta-per-3",
      amount: "1000",
      baseQuantity: "3",
    });
    const holdings = [holding({ ref: "position:1", instrumentRef: BETA, quantity: "1" })];
    expect(outcome(await valueHoldingsOnDate(input(holdings, [per3])), "position:1")).toMatchObject(
      {
        outcome: "unpriced",
        reason: "rounding_policy_missing",
        candidateIds: ["beta-per-3"],
      },
    );
  });

  test("a missing rate or an unquotable currency is unconverted, with the price leg kept", async () => {
    const aud = holding({
      ref: "position:1",
      instrumentRef: ALPHA,
      quantity: "2",
      quoteUnit: "AUD",
    });
    const chf = holding({
      ref: "position:2",
      instrumentRef: BETA,
      quantity: "2",
      quoteUnit: "CHF",
    });
    const candidates = [
      candidate({ key: key(ALPHA, "AUD"), id: "alpha-aud", amount: "10.5" }),
      candidate({ key: key(BETA, "CHF"), id: "beta-chf", amount: "3" }),
      USD_MID(),
    ];
    const result = computed(
      await valueHoldingsOnDate({
        ...input([aud, chf], candidates),
        fx: rates(["AUD", "CHF"], candidates),
      }),
    );
    const first = result.holdings[0]!;
    if (first.outcome !== "unconverted") throw new Error(first.outcome);
    expect(first).toMatchObject({ reason: "missing", pair: { base: "AUD", quote: "JPY" } });
    expect(quantityText(first.local)).toBe("21");
    expect(first.priceLeg.priceId).toBe("alpha-aud");
    expect(result.holdings[1]).toMatchObject({
      outcome: "unconverted",
      reason: "unsupported_pair",
    });
    expect(result.counts).toMatchObject({ unconverted: 2, valued: 0 });
  });

  test("a stale rate is unconverted stale, never a 1:1 conversion", async () => {
    const holdings = [
      holding({ ref: "position:1", instrumentRef: ALPHA, quantity: "12", quoteUnit: "USD" }),
    ];
    const oldRate = candidate({
      key: fxKey("USD", FX),
      id: "usd-old",
      amount: "140",
      at: "2026-09-01T10:00:00+09:00",
    });
    expect(
      outcome(await valueHoldingsOnDate(input(holdings, [ALPHA_PRICE(), oldRate])), "position:1"),
    ).toMatchObject({
      outcome: "unconverted",
      reason: "stale",
      pair: { base: "USD", quote: "JPY" },
    });
  });

  test("selections made under another policy or from another snapshot are policy_mismatch", async () => {
    const holdings = [
      holding({ ref: "position:1", instrumentRef: ALPHA, quantity: "12", quoteUnit: "USD" }),
    ];
    const candidates = [ALPHA_PRICE(), USD_MID()];
    const base = input(holdings, candidates);
    // The price selected under a looser policy that shares nothing with this one.
    const loose = { ...PRICE, policyId: "test:other-price" };
    const result1 = await valueHoldingsOnDate({
      ...base,
      prices: priceSelections(holdings, candidates, loose),
    });
    expect(outcome(result1, "position:1")).toMatchObject({
      outcome: "policy_mismatch",
      reason: "price_selection_policy",
    });
    // A same-snapshot selection whose price came from another parse run.
    const elsewhere = candidate({
      key: key(ALPHA, "USD"),
      id: "alpha-run-7",
      amount: "130.70",
      run: 7,
    });
    const other = selectPrice(key(ALPHA, "USD"), [elsewhere], BOUND, PRICE, null);
    const result2 = await valueHoldingsOnDate({
      ...base,
      prices: [{ snapshotParseRunId: 1, selection: other }],
    });
    expect(outcome(result2, "position:1")).toMatchObject({
      outcome: "policy_mismatch",
      reason: "price_selection_scope",
    });
    // A rate selected under another FX selection policy.
    const otherFx = { ...FX, selection: { ...FX.selection, policyId: "test:other-fx" } };
    const result3 = await valueHoldingsOnDate({ ...base, fx: rates(["USD"], candidates, otherFx) });
    expect(outcome(result3, "position:1")).toMatchObject({
      outcome: "policy_mismatch",
      reason: "fx_selection_policy",
    });
    expect(computed(result3).total).toEqual({ status: "absent", reason: "holding_not_valued" });
  });
});

describe("totals", () => {
  test("one unpriced holding makes the total absent, never a partial sum", async () => {
    const holdings = [
      ...TWO(),
      holding({
        ref: "position:3",
        instrumentRef: "instrument:test-broker:-:GAMMA",
        quantity: "5",
      }),
    ];
    const result = computed(
      await valueHoldingsOnDate(input(holdings, [ALPHA_PRICE(), BETA_PRICE(), USD_MID()])),
    );
    expect(result.counts).toMatchObject({ valued: 2, unpriced: 1 });
    expect(result.total).toEqual({ status: "absent", reason: "holding_not_valued" });
  });

  test("holdings of two sources have no total: adoption across sources is not applied", async () => {
    const holdings = [
      holding({ ref: "position:1", instrumentRef: BETA, quantity: "1" }),
      holding({
        ref: "position:2",
        instrumentRef: BETA,
        quantity: "1",
        sourceId: "other-broker",
        parseRunId: 2,
      }),
    ];
    const other = candidate({ key: key(BETA, "JPY"), id: "beta-run-2", amount: "1500", run: 2 });
    const result = computed(await valueHoldingsOnDate(input(holdings, [BETA_PRICE(), other])));
    expect(result.counts.valued).toBe(2);
    expect(result.total).toEqual({ status: "absent", reason: "adoption_not_applied" });
  });

  test("a holding of a stale snapshot is snapshot_stale: its quantity is not known on the date", async () => {
    const holdings = [
      holding({ ref: "position:1", instrumentRef: BETA, quantity: "100" }),
      holding({
        ref: "position:2",
        instrumentRef: BETA,
        quantity: "100",
        parseRunId: 2,
        snapshotFreshness: "stale",
        snapshotAgeDays: 40,
      }),
      holding({
        ref: "position:3",
        instrumentRef: BETA,
        quantity: "1",
        parseRunId: 3,
        snapshotFreshness: "recent",
        snapshotAgeDays: 3,
      }),
    ];
    const latest = { ...PRICE, candidateScope: "latest-in-window" as const };
    const via = input(holdings, [BETA_PRICE()]);
    const result = computed(
      await valueHoldingsOnDate({
        ...via,
        policy: { ...POLICY, price: latest },
        prices: priceSelections(holdings, [BETA_PRICE()], latest),
      }),
    );
    expect(result.holdings.map((entry) => entry.outcome)).toEqual([
      "valued",
      "snapshot_stale",
      "valued",
    ]);
    expect(result.holdings[1]).toMatchObject({ snapshotRef: "artifact:2", ageDays: 40 });
    expect(result.total).toEqual({ status: "absent", reason: "holding_not_valued" });
    expect(result.manifest.holdings[1]).toMatchObject({
      outcome: "snapshot_stale",
      reason: "stale",
    });
    // The stale holding selects no price.
    expect(holdingPriceWant(holdings[1]!, latest)).toBeNull();
  });

  test("a position container without a snapshot makes the total a partial verified scope, never exact", async () => {
    const result = computed(
      await valueHoldingsOnDate({
        ...input(TWO(), [ALPHA_PRICE(), BETA_PRICE(), USD_MID()]),
        reportedState: {
          ...REPORTED,
          positionContainersWithoutSnapshot: [
            { sourceId: "test-broker", parserName: "test-positions", dataset: "positions" },
          ],
        },
      }),
    );
    expect(result.total.status).toBe("partial-verified-scope");
    if (result.total.status !== "partial-verified-scope") throw new Error(result.total.status);
    expect(quantityText(result.total.value)).toBe("379378.5");
    expect(result.total.positionContainersWithoutSnapshot).toBe(1);
    expect(result.manifest.reportedState.positionContainersWithoutSnapshot).toHaveLength(1);
  });

  test("a stale position snapshot that listed no holding makes the total partial, never exact", async () => {
    const stale = {
      ref: "artifact:77",
      sourceId: "test-broker",
      parserName: "test-positions",
      ageDays: 40,
    };
    const result = computed(
      await valueHoldingsOnDate({
        ...input(TWO(), [ALPHA_PRICE(), BETA_PRICE(), USD_MID()]),
        reportedState: { ...REPORTED, stalePositionSnapshots: [stale] },
      }),
    );
    expect(result.total).toMatchObject({
      status: "partial-verified-scope",
      positionContainersWithoutSnapshot: 0,
      stalePositionContainersWithoutHoldings: 1,
    });
    expect(result.manifest.reportedState.stalePositionSnapshotsWithoutHoldings).toEqual([stale]);
    // A stale snapshot a holding came from is not counted here: the holding
    // itself is snapshot_stale, and the total is absent.
    const held = holding({
      ref: "position:3",
      instrumentRef: BETA,
      quantity: "1",
      parseRunId: 77,
      snapshotFreshness: "stale",
      snapshotAgeDays: 40,
    });
    const absent = computed(
      await valueHoldingsOnDate({
        ...input([...TWO(), held], [ALPHA_PRICE(), BETA_PRICE(), USD_MID()]),
        reportedState: { ...REPORTED, stalePositionSnapshots: [stale] },
      }),
    );
    expect(absent.total).toEqual({ status: "absent", reason: "holding_not_valued" });
    expect(absent.manifest.reportedState.stalePositionSnapshotsWithoutHoldings).toEqual([]);
  });

  test("no holdings is no total, not zero", async () => {
    const result = computed(await valueHoldingsOnDate(input([], [])));
    expect(result.total).toEqual({ status: "absent", reason: "no_holdings" });
  });
});

describe("FX across the pivot", () => {
  test("a USD holding into an AUD base is one ratio rounded once, every leg reported", async () => {
    const inverse: FxConversionPolicy = {
      ...FX,
      inverse: { mode: "half-even", scaleByUnit: { AUD: 2 } },
    };
    const holdings = [
      holding({ ref: "position:1", instrumentRef: ALPHA, quantity: "12", quoteUnit: "USD" }),
    ];
    const candidates = [
      ALPHA_PRICE(),
      USD_MID(),
      candidate({ key: fxKey("AUD", FX), id: "aud-mid", amount: "97.3" }),
    ];
    const result = await valueHoldingsOnDate({
      ...input(holdings, candidates),
      policy: { ...POLICY, fx: inverse },
      baseUnit: "AUD",
      fx: rates(["USD", "AUD"], candidates, inverse),
    });
    const alpha = outcome(result, "position:1");
    if (alpha.outcome !== "valued") throw new Error(alpha.outcome);
    // 1568.4 USD × 146.25 / 97.3 = 2357.4357… → 2357.44 AUD, rounded once.
    expect(quantityText(alpha.value)).toBe("2357.44");
    expect(alpha.legs.map((leg) => [leg.leg, leg.base, leg.direction])).toEqual([
      ["price", ALPHA, "direct"],
      ["fx", "USD", "direct"],
      ["fx", "AUD", "inverse"],
    ]);
    expect(alpha.roundingInputs).toMatchObject({ mode: "half-even", precision: 2 });
    expect(computed(result).manifest.holdings[0]!.fxPriceIds).toEqual(["usd-mid", "aud-mid"]);
    // Without an inverse rounding, a non-pivot base is refused, not rounded.
    const refusedResult = await valueHoldingsOnDate({
      ...input(holdings, candidates),
      baseUnit: "AUD",
    });
    expect(outcome(refusedResult, "position:1")).toMatchObject({
      outcome: "unconverted",
      reason: "rounding_policy_missing",
    });
  });
});

describe("the policy gate", () => {
  test("no policy is needs-policy, the costBasis gate's shape, with nothing valued", async () => {
    expect(await valueHoldingsOnDate(input(TWO(), [], { policy: null }))).toEqual({
      status: "needs-policy",
      reasonCode: "policy_missing",
      holdings: null,
      total: null,
    });
  });

  test("a proposal is not a decision", async () => {
    const proposal = { ...POLICY, price: { ...PRICE, policyId: "proposal:test-price" } };
    expect(await valueHoldingsOnDate(input(TWO(), [], { policy: proposal }))).toMatchObject({
      status: "needs-policy",
      reasonCode: "policy_proposal",
    });
  });

  test("caller errors throw: two price kinds, a missing selection, duplicates, a date mismatch", async () => {
    const twoKinds: ValuationOnDatePolicy = {
      ...POLICY,
      price: { ...PRICE, priceKinds: ["reference", "nav"] },
    };
    await expect(valueHoldingsOnDate(input(TWO(), [], { policy: twoKinds }))).rejects.toThrow(
      "invalid_policy",
    );
    await expect(valueHoldingsOnDate(input(TWO(), [], { prices: [] }))).rejects.toThrow(
      "price_selection_absent",
    );
    const base = input(TWO(), [BETA_PRICE()]);
    await expect(
      valueHoldingsOnDate({ ...base, prices: [...base.prices, base.prices[0]!] }),
    ).rejects.toThrow("price_selection_duplicated");
    await expect(
      valueHoldingsOnDate({ ...base, reportedState: { ...REPORTED, date: "2026-09-09" } }),
    ).rejects.toThrow("as_of_date_mismatch");
    await expect(valueHoldingsOnDate({ ...base, baseUnit: "yen" })).rejects.toThrow(
      "invalid_base_unit",
    );
  });
});

describe("the manifest is the context", () => {
  test("equal inputs in any order give one context id; it holds ids and codes, never amounts", async () => {
    const candidates = [ALPHA_PRICE(), BETA_PRICE(), USD_MID()];
    const first = computed(await valueHoldingsOnDate(input(TWO(), candidates)));
    const reversed = [...TWO()].reverse();
    const second = computed(
      await valueHoldingsOnDate({
        ...input(reversed, candidates),
        fx: [...rates(["USD", "AUD"], candidates)].reverse(),
      }),
    );
    expect(second.contextId).toBe(first.contextId);
    expect(first.manifest).toMatchObject({
      schema: "valuation-on-date-v1",
      engine: "valuation-on-date-engine-v1",
      asOf: {
        date: "2026-09-10",
        effectiveBefore: "2026-09-10T15:00:00.000Z",
        knowledge: "current",
      },
      baseUnit: "JPY",
      snapshots: [{ snapshotRef: "artifact:1", parseRunId: 1 }],
      holdings: [
        {
          ref: "position:1",
          outcome: "valued",
          reason: null,
          priceId: "alpha-px",
          fxPriceIds: ["usd-mid"],
        },
        { ref: "position:2", outcome: "valued", reason: null, priceId: "beta-px", fxPriceIds: [] },
      ],
    });
    expect(first.manifest.selection.selected).toEqual(["alpha-px", "beta-px", "usd-mid"]);
    expect(first.manifest.policies.map((entry) => entry.policyId)).toEqual([
      "test:fx-conversion",
      "test:fx-selection",
      "test:holding-price",
    ]);
    const text = JSON.stringify(first.manifest);
    for (const amount of ["130.70", "13070", "146.25", "14625", "229378", "1500"])
      expect(text).not.toContain(amount);
  });

  test("a different reported-state context is a different valuation context", async () => {
    const candidates = [ALPHA_PRICE(), BETA_PRICE(), USD_MID()];
    const first = computed(await valueHoldingsOnDate(input(TWO(), candidates)));
    const other = computed(
      await valueHoldingsOnDate({
        ...input(TWO(), candidates),
        reportedState: { ...REPORTED, contextId: "1".repeat(64) },
      }),
    );
    expect(other.contextId).not.toBe(first.contextId);
    expect(other.manifest.reportedState.contextId).toBe("1".repeat(64));
  });

  test("a corrected price is a new context; a changed policy too", async () => {
    const first = computed(
      await valueHoldingsOnDate(input(TWO(), [ALPHA_PRICE(), BETA_PRICE(), USD_MID()])),
    );
    // The re-parsed snapshot's price replaces the old one as the candidate.
    const corrected = candidate({ key: key(BETA, "JPY"), id: "beta-px-corrected", amount: "1510" });
    const second = computed(
      await valueHoldingsOnDate(input(TWO(), [ALPHA_PRICE(), corrected, USD_MID()])),
    );
    expect(second.contextId).not.toBe(first.contextId);
    expect(second.total.status === "exact" && quantityText(second.total.value)).toBe("380378.5");
    const stricter: ValuationOnDatePolicy = {
      ...POLICY,
      fx: {
        ...FX,
        selection: { ...FX.selection, freshness: { unit: "calendar-days", maxAgeDays: 2 } },
      },
    };
    const holdings = TWO();
    const candidates = [ALPHA_PRICE(), BETA_PRICE(), USD_MID()];
    const third = computed(
      await valueHoldingsOnDate({
        ...input(holdings, candidates),
        policy: stricter,
        fx: rates(["USD", "AUD"], candidates, stricter.fx),
      }),
    );
    expect(third.contextId).not.toBe(first.contextId);
  });
});
