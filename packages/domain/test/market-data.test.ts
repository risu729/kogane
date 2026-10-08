// As-of price and FX selection (src/market-data.ts, ADR 0056). Every
// instrument, rate, amount and calendar here is invented.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  CANDIDATE_EXCLUSIONS,
  convertToBase,
  freshnessWindowStart,
  fxKey,
  fxPath,
  PROPOSED_EQUITY_SELECTION_POLICY_V1,
  PROPOSED_FX_CONVERSION_POLICY_V1,
  PROPOSED_FX_SELECTION_POLICY_V1,
  policyDigest,
  selectionManifest,
  selectionReadWindow,
  selectPrice,
  validFxConversionPolicy,
  validMarketCalendar,
  validPriceSelectionPolicy,
  validSelectionBound,
  valueInBase,
  type ExclusionCounts,
  type FxConversionPolicy,
  type MarketCalendar,
  type PriceCandidate,
  type PriceKey,
  type PriceSelection,
  type PriceSelectionPolicy,
  type SelectionBound,
} from "../src/market-data.ts";
import { canonicalDigest } from "../src/context.ts";
import { valueAtPrice, type PriceKind } from "../src/metrics.ts";
import type { PriceRuleId } from "../src/price-sources.ts";
import type { TemporalValue } from "../src/time.ts";
import { decimalLiteral, type Quantity } from "../src/values.ts";
import { q, quantityText } from "./helpers.ts";

const USD: PriceKey = { baseInstrumentRef: "USD", quoteUnitRef: "JPY", priceKind: "reference" };
const ALPHA: PriceKey = {
  baseInstrumentRef: "instrument:test:alpha",
  quoteUnitRef: "USD",
  priceKind: "reference",
};

const POLICY: PriceSelectionPolicy = {
  policyId: "test:fx-selection",
  admittedRules: ["fx-sbi-shinsei-board-v1"],
  priceKinds: ["reference"],
  acceptedBases: ["provider", "collector"],
  zone: "Asia/Tokyo",
  freshness: { unit: "calendar-days", maxAgeDays: 4 },
  dateOnly: "exclude",
  multiSource: "refuse-on-overlap",
  candidateScope: "latest-in-window",
};
const policy = (overrides: Partial<PriceSelectionPolicy>): PriceSelectionPolicy => ({
  ...POLICY,
  ...overrides,
});
const EQUITY: PriceSelectionPolicy = policy({
  policyId: "test:equity-selection",
  admittedRules: ["sbi-foreign-stock-price-last-v1"],
});

// 2026-09-10 is a Thursday; its exclusive bound is (D + 1) 00:00 in Asia/Tokyo.
const BOUND: SelectionBound = {
  effectiveBefore: "2026-09-10T15:00:00.000Z",
  asOfDate: "2026-09-10",
  knowledge: { mode: "current" },
};

let sequence = 0;
function candidate(options: {
  key?: PriceKey;
  id?: string;
  at?: string;
  time?: TemporalValue;
  amount: string;
  baseQuantity?: string;
  rule?: PriceRuleId | string;
  recordedAt?: string;
  basis?: "provider" | "collector";
}): PriceCandidate {
  const key = options.key ?? USD;
  sequence += 1;
  return {
    price: {
      id: options.id ?? `price-${sequence}`,
      baseInstrumentRef: key.baseInstrumentRef,
      baseQuantity: decimalLiteral(options.baseQuantity ?? "1"),
      quoteUnitRef: key.quoteUnitRef,
      quoteAmount: decimalLiteral(options.amount),
      priceKind: key.priceKind,
      effectiveTime: options.time ?? {
        kind: "instant",
        value: options.at ?? "2026-09-10T10:00:00+09:00",
        zone: "Asia/Tokyo",
        basis: options.basis ?? "provider",
      },
      sourceClaimRef: `valuation_observations/${sequence}#$.amount_text`,
      marketRef: null,
      adjustmentPolicyRef: null,
    },
    recordedAt: options.recordedAt ?? "2026-09-10T02:00:00.000Z",
    claim: {
      ruleId:
        options.rule ??
        (key === USD || key.quoteUnitRef === "JPY"
          ? "fx-sbi-shinsei-board-v1"
          : "sbi-foreign-stock-price-last-v1"),
      claimKind: "valuation",
      observationId: sequence,
      parseRunId: 1,
      jsonPath: "$.amount_text",
    },
  };
}
const date = (value: string, zone: string | null = "Asia/Tokyo"): TemporalValue => ({
  kind: "local-date",
  value,
  zone,
  basis: "provider",
});

function selected(selection: PriceSelection) {
  if (selection.status !== "selected") throw new Error(`refused: ${selection.reason}`);
  return selection;
}
function refused(selection: PriceSelection) {
  if (selection.status !== "refused") throw new Error("selected");
  return selection;
}
const none = Object.fromEntries(CANDIDATE_EXCLUSIONS.map((code) => [code, 0])) as ExclusionCounts;

describe("filter and counts", () => {
  test("nothing is dropped silently: each removed candidate has its code", () => {
    const result = refused(
      selectPrice(
        USD,
        [
          candidate({ amount: "146", rule: "sbi-domestic-current-price-v1" }),
          candidate({ amount: "146", basis: "collector" }),
          candidate({ amount: "146", time: date("2026-09-10") }),
          candidate({ amount: "146", at: "2026-09-11T00:00:00+09:00" }),
          candidate({ amount: "146", time: { kind: "unknown", reasonCode: "stored_invalid" } }),
          candidate({
            amount: "146",
            time: {
              kind: "period",
              start: "2026-09",
              end: "2026-09",
              endExclusive: false,
              zone: null,
              granularity: "month",
            },
          }),
          candidate({
            amount: "146",
            time: { kind: "instant", value: "2026-09-10 10:00", zone: "UTC", basis: "provider" },
          }),
        ],
        BOUND,
        policy({ acceptedBases: ["provider"] }),
        null,
      ),
    );
    expect(result.reason).toBe("missing");
    expect(result.candidateIds).toEqual([]);
    expect(result.excluded).toEqual({
      recorded_after_known_at: 0,
      rule_not_admitted: 1,
      kind_not_admitted: 0,
      basis_not_admitted: 1,
      date_only_excluded: 1,
      effective_at_or_after_bound: 1,
      invalid_effective_time: 3,
    });
  });

  test("known-at re-checks every candidate's recorded time exactly", () => {
    const at = (knownAt: string): SelectionBound => ({
      ...BOUND,
      knowledge: { mode: "known-at", knownAt },
    });
    const recorded = candidate({ id: "r", amount: "146", recordedAt: "2026-09-10T02:00:00.000Z" });
    expect(
      selected(selectPrice(USD, [recorded], at("2026-09-10T02:00:00Z"), POLICY, null)),
    ).toBeTruthy();
    const late = refused(
      selectPrice(USD, [recorded], at("2026-09-10T01:59:59.999Z"), POLICY, null),
    );
    expect([late.reason, late.excluded.recorded_after_known_at]).toEqual(["missing", 1]);
    const unreadable = candidate({ amount: "146", recordedAt: "2026-09-10 02:00:00" });
    expect(
      refused(selectPrice(USD, [unreadable], at("2026-09-11T00:00:00Z"), POLICY, null)).excluded
        .recorded_after_known_at,
    ).toBe(1);
    // Current knowledge does not look at the recorded time.
    expect(selected(selectPrice(USD, [unreadable], BOUND, POLICY, null))).toBeTruthy();
    expect(validSelectionBound(at("2026-09-10T02:00:00.123Z"))).toBe(true);
    expect(validSelectionBound(at("2026-09-10T02:00:00.1234Z"))).toBe(false);
  });

  test("a kind the policy does not admit is counted for every candidate", () => {
    const bid: PriceKey = { ...USD, priceKind: "bid" };
    const result = refused(
      selectPrice(bid, [candidate({ key: bid, amount: "145" })], BOUND, POLICY, null),
    );
    expect(result.reason).toBe("missing");
    expect(result.excluded.kind_not_admitted).toBe(1);
  });

  test("the bound is exclusive and compared as instants, to the nanosecond", () => {
    const at = candidate({ amount: "146", at: "2026-09-11T00:00:00+09:00" });
    const before = candidate({ amount: "147", at: "2026-09-10T14:59:59.999999999Z" });
    const result = selected(selectPrice(USD, [at, before], BOUND, POLICY, null));
    expect(result.candidate.price.id).toBe(before.price.id);
    expect(result.excluded.effective_at_or_after_bound).toBe(1);
    expect(result.ageDays).toBe(0);
  });

  test("a candidate of another key is a caller error, not a count", () => {
    expect(() =>
      selectPrice(USD, [candidate({ key: ALPHA, amount: "1" })], BOUND, POLICY, null),
    ).toThrow("candidate_key_mismatch");
  });

  test("collector basis is accepted only when the policy says so, and travels with the price", () => {
    const collector = candidate({ amount: "146", basis: "collector" });
    const result = selected(selectPrice(USD, [collector], BOUND, POLICY, null));
    expect(result.candidate.price.effectiveTime).toMatchObject({ basis: "collector" });
    const strict = refused(
      selectPrice(USD, [collector], BOUND, policy({ acceptedBases: ["provider"] }), null),
    );
    expect([strict.reason, strict.excluded.basis_not_admitted]).toEqual(["missing", 1]);
  });
});

describe("date-only prices", () => {
  test("excluded by default policy shape: counted, then missing", () => {
    const result = refused(
      selectPrice(
        USD,
        [candidate({ amount: "146", time: date("2026-09-09") })],
        BOUND,
        POLICY,
        null,
      ),
    );
    expect([result.reason, result.excluded.date_only_excluded]).toEqual(["missing", 1]);
  });

  test("civil-date-in-zone: the as-of date is eligible, the next day is not", () => {
    const civil = policy({ dateOnly: "civil-date-in-zone" });
    const today = candidate({ amount: "146", time: date("2026-09-10") });
    const tomorrow = candidate({ amount: "147", time: date("2026-09-11") });
    const result = selected(selectPrice(USD, [today, tomorrow], BOUND, civil, null));
    expect(result.candidate.price.id).toBe(today.price.id);
    expect(result.ageDays).toBe(0);
    expect(result.excluded.effective_at_or_after_bound).toBe(1);
  });

  test("a date with no zone or another zone is refused only when it might be the newest", () => {
    const civil = policy({ dateOnly: "civil-date-in-zone" });
    const fresh = candidate({ id: "fresh", amount: "146" });
    for (const zone of [null, "UTC"]) {
      // 9/9 elsewhere may be 9/10 here: it might be as new as the instant.
      const near = candidate({ id: `near-${zone}`, amount: "146", time: date("2026-09-09", zone) });
      expect(refused(selectPrice(USD, [fresh, near], BOUND, civil, null))).toMatchObject({
        reason: "time_incomparable",
        candidateIds: [near.price.id],
      });
      // 9/8 elsewhere is at the latest 9/9 here: older than the instant.
      const old = candidate({ id: `old-${zone}`, amount: "140", time: date("2026-09-08", zone) });
      expect(selected(selectPrice(USD, [fresh, old], BOUND, civil, null)).candidate).toBe(fresh);
      // Alone, it cannot be placed at all.
      expect(refused(selectPrice(USD, [old], BOUND, civil, null)).reason).toBe("time_incomparable");
      // 9/12 elsewhere is at the earliest 9/11 here: after the as-of date.
      const after = candidate({ amount: "146", time: date("2026-09-12", zone) });
      expect(
        refused(selectPrice(USD, [after], BOUND, civil, null)).excluded.effective_at_or_after_bound,
      ).toBe(1);
    }
  });

  test("a date and an instant on the same top day: refused when they differ, one value when they agree", () => {
    const civil = policy({ dateOnly: "civil-date-in-zone" });
    const dated = candidate({ id: "dated", amount: "146", time: date("2026-09-10") });
    const differs = candidate({ id: "instant", amount: "147" });
    const result = refused(selectPrice(USD, [dated, differs], BOUND, civil, null));
    expect([result.reason, result.candidateIds]).toEqual([
      "time_incomparable",
      ["dated", "instant"],
    ]);
    const agrees = candidate({ id: "instant-2", amount: "146" });
    const ok = selected(selectPrice(USD, [dated, agrees], BOUND, civil, null));
    expect(ok.corroboratedBy).toHaveLength(1);
    // An instant on an earlier day is simply older than the date.
    const older = candidate({ amount: "140", at: "2026-09-09T10:00:00+09:00" });
    expect(selected(selectPrice(USD, [dated, older], BOUND, civil, null)).candidate).toBe(dated);
  });
});

describe("freshness", () => {
  test("an age equal to the limit is selected; one more day is stale, with the id and age", () => {
    const four = candidate({ amount: "146", at: "2026-09-06T23:59:59+09:00" });
    expect(selected(selectPrice(USD, [four], BOUND, POLICY, null)).ageDays).toBe(4);
    // 23:59 on 9/5 in Tokyo is 14:59Z: the civil date is the zone's, not UTC's.
    const five = candidate({ amount: "146", at: "2026-09-05T14:59:59Z" });
    const result = refused(selectPrice(USD, [five], BOUND, POLICY, null));
    expect(result).toMatchObject({ reason: "stale", candidateIds: [five.price.id], ageDays: 5 });
  });

  test("a stale price is never a value: a conversion through it is refused as stale", () => {
    const five = candidate({ amount: "146", at: "2026-09-05T12:00:00+09:00" });
    const fx = new Map([["USD", selectPrice(USD, [five], BOUND, POLICY, null)]]);
    expect(convertToBase(q("USD", "10"), "JPY", fx, fxPolicy())).toEqual({
      ok: false,
      leg: "fx",
      pair: { base: "USD", quote: "JPY" },
      reason: "stale",
    });
  });

  test("a price dated after the as-of date is refused, never given a negative age", () => {
    const bound = { ...BOUND, asOfDate: "2026-09-09" };
    const result = refused(selectPrice(USD, [candidate({ amount: "146" })], bound, POLICY, null));
    expect(result.reason).toBe("time_incomparable");
  });
});

describe("disagreement and sources", () => {
  test("two prices at one instant that differ are refused; equal ones corroborate", () => {
    const a = candidate({ id: "a", amount: "146" });
    const b = candidate({ id: "b", amount: "146.5" });
    expect(refused(selectPrice(USD, [a, b], BOUND, POLICY, null))).toMatchObject({
      reason: "disagree",
      candidateIds: ["a", "b"],
    });
    const c = candidate({ id: "c", amount: "146", recordedAt: "2026-09-10T03:00:00.000Z" });
    const result = selected(selectPrice(USD, [c, a], BOUND, POLICY, null));
    expect([result.candidate.price.id, result.corroboratedBy]).toEqual(["c", ["a"]]);
    // Same recorded time: the higher id.
    const d = candidate({ id: "d", amount: "146" });
    expect(selected(selectPrice(USD, [a, d], BOUND, POLICY, null)).candidate.price.id).toBe("d");
  });

  test("equal per unit on different bases agree: 146 per 1 and 1460 per 10", () => {
    const one = candidate({ id: "per-1", amount: "146" });
    const ten = candidate({ id: "per-10", amount: "1460", baseQuantity: "10" });
    const result = selected(selectPrice(USD, [one, ten], BOUND, POLICY, null));
    expect(result.corroboratedBy).toHaveLength(1);
    const off = candidate({ id: "per-10-off", amount: "1461", baseQuantity: "10" });
    expect(refused(selectPrice(USD, [one, off], BOUND, POLICY, null)).reason).toBe("disagree");
  });

  test("the same instant written in two offsets is one instant", () => {
    const tokyo = candidate({ id: "tokyo", amount: "146", at: "2026-09-10T09:00:00+09:00" });
    const utc = candidate({ id: "utc", amount: "147", at: "2026-09-10T00:00:00Z" });
    expect(refused(selectPrice(USD, [tokyo, utc], BOUND, POLICY, null)).reason).toBe("disagree");
    // A nanosecond later is later.
    const later = candidate({ id: "later", amount: "148", at: "2026-09-10T00:00:00.000000001Z" });
    expect(
      selected(selectPrice(USD, [tokyo, utc, later], BOUND, POLICY, null)).candidate.price.id,
    ).toBe("later");
  });

  test("two admitted rules with possibly fresh prices are refused unless a priority is declared", () => {
    const both = policy({
      admittedRules: ["fx-sbi-shinsei-board-v1", "sbi-domestic-current-price-v1"],
    });
    const board = candidate({ id: "board", amount: "146", at: "2026-09-05T10:00:00+09:00" });
    const other = candidate({ id: "other", amount: "147", rule: "sbi-domestic-current-price-v1" });
    // Overlap is decided among prices that could be fresh: a stale row of
    // another rule, however old, does not refuse a fresh one.
    expect(selected(selectPrice(USD, [board, other], BOUND, both, null)).candidate.price.id).toBe(
      "other",
    );
    const ancient = candidate({ id: "ancient", amount: "90", at: "2016-01-04T10:00:00+09:00" });
    expect(selected(selectPrice(USD, [ancient, other], BOUND, both, null)).candidate.price.id).toBe(
      "other",
    );
    // Two rules with prices inside the freshness span are refused, with only those ids.
    const boardFresh = candidate({
      id: "board-fresh",
      amount: "146",
      at: "2026-09-06T10:00:00+09:00",
    });
    expect(
      refused(selectPrice(USD, [ancient, boardFresh, other], BOUND, both, null)),
    ).toMatchObject({ reason: "sources_overlap", candidateIds: ["board-fresh", "other"] });
    // Two rules with only stale prices: stale, not an overlap.
    expect(refused(selectPrice(USD, [ancient, board], BOUND, both, null))).toMatchObject({
      reason: "stale",
      candidateIds: ["board"],
    });
    const priority = { ...both, multiSource: "priority-order" as const };
    // The first rule's price is stale, so the second rule's fresh one is taken.
    expect(
      selected(selectPrice(USD, [board, other], BOUND, priority, null)).candidate.price.id,
    ).toBe("other");
    // A fresh first-rule price wins even when the second rule's is newer.
    const fresh = candidate({ id: "fresh", amount: "146", at: "2026-09-09T10:00:00+09:00" });
    expect(
      selected(selectPrice(USD, [fresh, other], BOUND, priority, null)).candidate.price.id,
    ).toBe("fresh");
    // Nothing selectable: the first rule's refusal is reported.
    const staleOther = candidate({
      id: "stale-other",
      amount: "147",
      rule: "sbi-domestic-current-price-v1",
      at: "2026-09-01T10:00:00+09:00",
    });
    expect(refused(selectPrice(USD, [board, staleOther], BOUND, priority, null))).toMatchObject({
      reason: "stale",
      candidateIds: ["board"],
    });
  });
});

describe("business-day freshness and calendars", () => {
  const CALENDAR: MarketCalendar = {
    calendarRef: "calendar:test:weekdays",
    version: "1",
    zone: "Asia/Tokyo",
    coverage: { from: "2026-09-01", to: "2026-09-30" },
    closedWeekdays: [6, 7],
    closedDates: ["2026-09-21"],
    evidenceRefs: ["evidence:test:calendar"],
  };
  const business = policy({
    freshness: { unit: "business-days", maxAgeDays: 1, calendarRef: CALENDAR.calendarRef },
  });
  const friday = candidate({ amount: "146", at: "2026-09-11T10:00:00+09:00" });
  const monday: SelectionBound = {
    ...BOUND,
    effectiveBefore: "2026-09-14T15:00:00.000Z",
    asOfDate: "2026-09-14",
  };

  test("Friday to Monday is one business day", () => {
    expect(selected(selectPrice(USD, [friday], monday, business, CALENDAR)).ageDays).toBe(1);
    // The same span is three calendar days, stale under a one-day calendar rule.
    expect(
      refused(
        selectPrice(
          USD,
          [friday],
          monday,
          policy({ freshness: { unit: "calendar-days", maxAgeDays: 1 } }),
          null,
        ),
      ),
    ).toMatchObject({ reason: "stale", ageDays: 3 });
  });

  test("a closed date is not a business day", () => {
    const before = candidate({ amount: "146", at: "2026-09-18T10:00:00+09:00" });
    const tuesday = {
      ...BOUND,
      effectiveBefore: "2026-09-22T15:00:00.000Z",
      asOfDate: "2026-09-22",
    };
    expect(selected(selectPrice(USD, [before], tuesday, business, CALENDAR)).ageDays).toBe(1);
    expect(freshnessWindowStart(business, tuesday, CALENDAR)).toBe("2026-09-18");
  });

  test("no calendar, another calendar or partial coverage: calendar_missing", () => {
    expect(refused(selectPrice(USD, [friday], monday, business, null)).reason).toBe(
      "calendar_missing",
    );
    const other = { ...CALENDAR, calendarRef: "calendar:test:other" };
    expect(refused(selectPrice(USD, [friday], monday, business, other)).reason).toBe(
      "calendar_missing",
    );
    const partial = { ...CALENDAR, coverage: { from: "2026-09-12", to: "2026-09-30" } };
    expect(refused(selectPrice(USD, [friday], monday, business, partial)).reason).toBe(
      "calendar_missing",
    );
    const otherZone = { ...CALENDAR, zone: "UTC" };
    expect(refused(selectPrice(USD, [friday], monday, business, otherZone)).reason).toBe(
      "calendar_missing",
    );
  });

  test("the read window covers every possibly fresh day with a day of margin", () => {
    expect(selectionReadWindow(POLICY, BOUND, null)).toEqual({
      from: "2026-09-05T00:00:00Z",
      to: "2026-09-11T15:00:01.000Z",
    });
    expect(freshnessWindowStart(business, monday, CALENDAR)).toBe("2026-09-11");
    expect(freshnessWindowStart(business, monday, null)).toBe("2026-09-13");
  });

  test("calendars are validated, sorted and evidenced", () => {
    expect(validMarketCalendar(CALENDAR)).toBe(true);
    expect(validMarketCalendar({ ...CALENDAR, closedDates: ["2026-09-22", "2026-09-21"] })).toBe(
      false,
    );
    expect(validMarketCalendar({ ...CALENDAR, closedWeekdays: [0] })).toBe(false);
    expect(validMarketCalendar({ ...CALENDAR, evidenceRefs: [] })).toBe(false);
    expect(
      validMarketCalendar({ ...CALENDAR, coverage: { from: "2026-10-01", to: "2026-09-01" } }),
    ).toBe(false);
    expect(validMarketCalendar({ ...CALENDAR, extra: 1 })).toBe(false);
  });
});

function fxPolicy(inverse: FxConversionPolicy["inverse"] = null): FxConversionPolicy {
  return {
    policyId: "test:fx-conversion",
    pivot: "JPY",
    currencies: ["USD", "AUD"],
    selection: POLICY,
    inverse,
  };
}
const AUD: PriceKey = { ...USD, baseInstrumentRef: "AUD" };
const fxMap = (...selections: PriceSelection[]) =>
  new Map(selections.map((selection) => [selection.key.baseInstrumentRef, selection]));

describe("FX path and conversion", () => {
  test("paths through the pivot", () => {
    expect(fxPath("JPY", "JPY", "JPY")).toEqual([]);
    expect(fxPath("USD", "JPY", "JPY")).toEqual([
      { base: "USD", quote: "JPY", direction: "direct" },
    ]);
    expect(fxPath("JPY", "AUD", "JPY")).toEqual([
      { base: "AUD", quote: "JPY", direction: "inverse" },
    ]);
    expect(fxPath("USD", "AUD", "JPY")).toHaveLength(2);
    expect(fxPath("instrument:test:alpha", "JPY", "JPY")).toBeNull();
  });

  test("a missing rate is a refusal, never 1:1 and never zero", () => {
    expect(convertToBase(q("USD", "10"), "JPY", new Map(), fxPolicy())).toEqual({
      ok: false,
      leg: "fx",
      pair: { base: "USD", quote: "JPY" },
      reason: "missing",
    });
    const missing = selectPrice(USD, [], BOUND, POLICY, null);
    expect(convertToBase(q("USD", "10"), "JPY", fxMap(missing), fxPolicy())).toMatchObject({
      ok: false,
      reason: "missing",
    });
  });

  test("an unquotable pair is unsupported, the same unit needs no rate", () => {
    expect(convertToBase(q("CHF", "10"), "JPY", new Map(), fxPolicy())).toMatchObject({
      ok: false,
      reason: "unsupported_pair",
      pair: { base: "CHF", quote: "JPY" },
    });
    expect(convertToBase(q("JPY", "1500"), "JPY", new Map(), fxPolicy())).toEqual({
      ok: true,
      value: q("JPY", "1500"),
      legs: [],
      roundingInputs: null,
    });
    expect(
      convertToBase(
        { unitRef: "JPY", value: { status: "missing", reasonCode: "x" } },
        "JPY",
        new Map(),
        fxPolicy(),
      ),
    ).toMatchObject({ ok: false, reason: "quantity_not_exact" });
  });

  test("out of the pivot without an inverse rounding policy is refused before any rate is read", () => {
    expect(convertToBase(q("JPY", "10000"), "AUD", new Map(), fxPolicy())).toMatchObject({
      ok: false,
      reason: "rounding_policy_missing",
    });
    expect(convertToBase(q("USD", "10"), "AUD", new Map(), fxPolicy())).toMatchObject({
      ok: false,
      reason: "rounding_policy_missing",
    });
    // A rounding policy that does not name the target unit's scale is no policy for it.
    expect(
      convertToBase(
        q("JPY", "10000"),
        "AUD",
        new Map(),
        fxPolicy({ mode: "half-even", scaleByUnit: { USD: 2 } }),
      ),
    ).toMatchObject({ ok: false, reason: "rounding_policy_missing" });
  });

  test("two hops: 12 shares at 130.70 USD, at a 146.25 mid, exactly valueAtPrice twice", () => {
    const stock = selectPrice(
      ALPHA,
      [candidate({ key: ALPHA, id: "alpha", amount: "130.70" })],
      BOUND,
      EQUITY,
      null,
    );
    const rate = selectPrice(
      USD,
      [candidate({ id: "mid", amount: "146.25" })],
      BOUND,
      POLICY,
      null,
    );
    const holding = q(ALPHA.baseInstrumentRef, "12");
    const result = valueInBase(holding, stock, "JPY", fxMap(rate), fxPolicy());
    if (!result.ok) throw new Error(result.reason);
    const usd = valueAtPrice(holding, selected(stock).candidate.price);
    if (!usd.ok) throw new Error("usd");
    const jpy = valueAtPrice(usd.quantity, selected(rate).candidate.price);
    if (!jpy.ok) throw new Error("jpy");
    expect(result.value).toEqual(jpy.quantity);
    expect(quantityText(result.value)).toBe("229378.5");
    expect(result.roundingInputs).toBeNull();
    expect(
      result.legs.map((leg) => [leg.leg, leg.base, leg.quote, leg.priceId, leg.ageDays]),
    ).toEqual([
      ["price", ALPHA.baseInstrumentRef, "USD", "alpha", 0],
      ["fx", "USD", "JPY", "mid", 0],
    ]);
  });

  test("into another currency: one ratio, rounded once, with its operands kept", () => {
    const usd = selectPrice(USD, [candidate({ id: "usd", amount: "146.25" })], BOUND, POLICY, null);
    const aud = selectPrice(
      AUD,
      [candidate({ key: AUD, id: "aud", amount: "97.3" })],
      BOUND,
      POLICY,
      null,
    );
    const inverse = fxPolicy({ mode: "half-even", scaleByUnit: { AUD: 2 } });
    const fromJpy = convertToBase(q("JPY", "10000"), "AUD", fxMap(usd, aud), inverse);
    if (!fromJpy.ok) throw new Error(fromJpy.reason);
    // 10000 / 97.3 = 102.7749…, rounded once half-even at 2 places.
    expect(quantityText(fromJpy.value)).toBe("102.77");
    expect(fromJpy.legs.map((leg) => [leg.direction, leg.priceId])).toEqual([["inverse", "aud"]]);
    expect(fromJpy.roundingInputs).toEqual({
      policyId: "test:fx-conversion",
      where: "leg",
      mode: "half-even",
      precision: 2,
      residual: "leave",
      operands: [decimalLiteral("10000"), decimalLiteral("97.3"), decimalLiteral("1")],
      preRounding: null,
    });
    // 1568.4 USD × 146.25 / 97.3 = 2357.4357…: one ratio, not a JPY figure rounded first.
    const fromUsd = convertToBase(q("USD", "1568.4"), "AUD", fxMap(usd, aud), inverse);
    if (!fromUsd.ok) throw new Error(fromUsd.reason);
    expect(quantityText(fromUsd.value)).toBe("2357.44");
    expect(fromUsd.legs.map((leg) => leg.direction)).toEqual(["direct", "inverse"]);
    expect(fromUsd.roundingInputs?.operands).toHaveLength(5);
    // An exact quotient keeps its exact pre-rounding value.
    const even = convertToBase(q("JPY", "973"), "AUD", fxMap(usd, aud), inverse);
    if (!even.ok) throw new Error(even.reason);
    expect(even.roundingInputs?.preRounding).toEqual(decimalLiteral("10"));
  });

  test("a rate selected under another policy is refused, however fresh it claims to be", () => {
    const loose = policy({
      policyId: "test:loose",
      freshness: { unit: "calendar-days", maxAgeDays: 36_600 },
    });
    const old = selectPrice(
      USD,
      [candidate({ id: "old", amount: "100", at: "2020-09-10T10:00:00+09:00" })],
      BOUND,
      loose,
      null,
    );
    expect(selected(old).ageDays).toBe(2191);
    expect(() => convertToBase(q("USD", "10"), "JPY", fxMap(old), fxPolicy())).toThrow(
      "fx_selection_policy_mismatch",
    );
    const stock = selectPrice(
      ALPHA,
      [candidate({ key: ALPHA, amount: "130.70" })],
      BOUND,
      EQUITY,
      null,
    );
    expect(() =>
      valueInBase(q(ALPHA.baseInstrumentRef, "1"), stock, "JPY", fxMap(old), fxPolicy()),
    ).toThrow("fx_selection_policy_mismatch");
  });

  test("a refused price leg names itself; a holding of another instrument is refused", () => {
    const stale = selectPrice(
      ALPHA,
      [candidate({ key: ALPHA, amount: "130.70", at: "2026-09-01T10:00:00+09:00" })],
      BOUND,
      EQUITY,
      null,
    );
    const holding: Quantity = q(ALPHA.baseInstrumentRef, "12");
    expect(valueInBase(holding, stale, "JPY", new Map(), fxPolicy())).toEqual({
      ok: false,
      leg: "price",
      pair: { base: ALPHA.baseInstrumentRef, quote: "USD" },
      reason: "stale",
    });
    expect(
      valueInBase(q("instrument:test:beta", "1"), stale, "JPY", new Map(), fxPolicy()),
    ).toMatchObject({ ok: false, reason: "instrument_mismatch" });
    // An FX selection under another key is a caller error.
    const bid = { ...USD, priceKind: "bid" as PriceKind };
    const wrong = selectPrice(bid, [], BOUND, POLICY, null);
    expect(() => convertToBase(q("USD", "1"), "JPY", fxMap(wrong), fxPolicy())).toThrow(
      "fx_selection_key_mismatch",
    );
    expect(fxKey("USD", fxPolicy())).toEqual(USD);
  });
});

describe("policies, digests and the manifest", () => {
  test("the validator refuses unknown keys, bad days, empty lists and unknown zones", () => {
    expect(validPriceSelectionPolicy(POLICY)).toBe(true);
    for (const bad of [
      { ...POLICY, extra: true },
      { ...POLICY, admittedRules: [] },
      { ...POLICY, admittedRules: ["fx-sbi-shinsei-board-v1", "fx-sbi-shinsei-board-v1"] },
      { ...POLICY, admittedRules: ["guess-v1"] },
      { ...POLICY, priceKinds: [] },
      { ...POLICY, acceptedBases: [] },
      { ...POLICY, zone: "Mars/Olympus_Mons" },
      { ...POLICY, freshness: { unit: "calendar-days", maxAgeDays: -1 } },
      { ...POLICY, freshness: { unit: "calendar-days", maxAgeDays: 1.5 } },
      { ...POLICY, freshness: { unit: "calendar-days", maxAgeDays: 4, calendarRef: "x" } },
      { ...POLICY, freshness: { unit: "business-days", maxAgeDays: 4 } },
      { ...POLICY, dateOnly: "guess" },
      { ...POLICY, multiSource: "average" },
      { ...POLICY, candidateScope: "any" },
    ])
      expect(validPriceSelectionPolicy(bad)).toBe(false);
    expect(validFxConversionPolicy(fxPolicy())).toBe(true);
    expect(validFxConversionPolicy({ ...fxPolicy(), currencies: ["JPY"] })).toBe(false);
    expect(
      validFxConversionPolicy({
        ...fxPolicy(),
        selection: { ...POLICY, priceKinds: ["reference", "bid"] },
      }),
    ).toBe(false);
    expect(validFxConversionPolicy(fxPolicy({ mode: "half-even", scaleByUnit: {} }))).toBe(false);
    expect(validSelectionBound(BOUND)).toBe(true);
    expect(validSelectionBound({ ...BOUND, effectiveBefore: "2026-09-10" })).toBe(false);
    expect(validSelectionBound({ ...BOUND, knowledge: { mode: "known-at" } })).toBe(false);
  });

  test("the proposals are valid policies, frozen, and named as proposals", () => {
    for (const proposal of [PROPOSED_FX_SELECTION_POLICY_V1, PROPOSED_EQUITY_SELECTION_POLICY_V1])
      expect(validPriceSelectionPolicy(proposal)).toBe(true);
    expect(validFxConversionPolicy(PROPOSED_FX_CONVERSION_POLICY_V1)).toBe(true);
    expect(PROPOSED_FX_CONVERSION_POLICY_V1.policyId.startsWith("proposal:")).toBe(true);
    expect(Object.isFrozen(PROPOSED_FX_SELECTION_POLICY_V1.freshness)).toBe(true);
    expect(PROPOSED_FX_CONVERSION_POLICY_V1.currencies).not.toContain("CHF");
  });

  test("no production source outside the domain module names a proposal", () => {
    const root = join(import.meta.dir, "../../..");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry.startsWith(".")) continue;
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (
          /\.(ts|tsx)$/u.test(entry) &&
          !path.endsWith("packages/domain/src/market-data.ts") &&
          readFileSync(path, "utf8").includes("PROPOSED_")
        )
          offenders.push(path.slice(root.length + 1));
      }
    };
    for (const top of ["packages", "services", "apps"])
      for (const workspace of readdirSync(join(root, top))) {
        const src = join(root, top, workspace, "src");
        try {
          if (statSync(src).isDirectory()) walk(src);
        } catch {
          // A workspace without src has no production code to check.
        }
      }
    expect(offenders).toEqual([]);
  });

  test("a digest is stable and changes with any policy value", async () => {
    const digest = await policyDigest(POLICY);
    expect(await policyDigest({ ...POLICY })).toBe(digest);
    expect(
      await policyDigest(policy({ freshness: { unit: "calendar-days", maxAgeDays: 5 } })),
    ).not.toBe(digest);
    expect(await policyDigest(policy({ acceptedBases: ["provider"] }))).not.toBe(digest);
  });

  test("the manifest is order-independent and moves with a new price, not with the knowledge instant", async () => {
    const a = selectPrice(USD, [candidate({ id: "usd-1", amount: "146" })], BOUND, POLICY, null);
    const b = selectPrice(AUD, [], BOUND, POLICY, null);
    const manifest = (selections: PriceSelection[], bound = BOUND) =>
      selectionManifest({ policies: [POLICY, fxPolicy()], calendars: [], bound, selections });
    const first = await manifest([a, b]);
    expect(first).toMatchObject({
      schema: "market-data-selection-v1",
      selected: ["usd-1"],
      refused: [{ key: AUD, reason: "missing", candidateIds: [] }],
      knowledge: "current",
      knowledgeBoundary: "2026-09-10T02:00:00.000Z",
    });
    expect(first.policies.map((p) => p.policyId)).toEqual([
      "test:fx-conversion",
      "test:fx-selection",
    ]);
    expect(await canonicalDigest(await manifest([b, a]))).toBe(await canonicalDigest(first));
    const newer = selectPrice(
      USD,
      [
        candidate({ id: "usd-1", amount: "146" }),
        candidate({ id: "usd-2", amount: "147", at: "2026-09-10T11:00:00+09:00" }),
      ],
      BOUND,
      POLICY,
      null,
    );
    expect(await canonicalDigest(await manifest([newer, b]))).not.toBe(
      await canonicalDigest(first),
    );
    const knownAt = (at: string): SelectionBound => ({
      ...BOUND,
      knowledge: { mode: "known-at", knownAt: at },
    });
    expect(await canonicalDigest(await manifest([a, b], knownAt("2026-09-11T00:00:00Z")))).toBe(
      await canonicalDigest(await manifest([a, b], knownAt("2026-09-12T00:00:00Z"))),
    );
  });

  test("exclusion counts start at zero for every code", () => {
    expect(selectPrice(USD, [], BOUND, POLICY, null).excluded).toEqual(none);
  });
});
