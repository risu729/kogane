// Seeded property tests of as-of price and FX selection (ADR 0056). Random
// synthetic candidates (instants in four offsets, Tokyo and foreign dates,
// two rules, agreeing and disagreeing prices) and random calendars; each
// property lists the seeds that break it.
import { describe, expect, test } from "bun:test";
import { civilDateOfInstant } from "../src/civil-date.ts";
import { canonicalJson } from "../src/context.ts";
import {
  convertToBase,
  freshnessWindowStart,
  selectionManifest,
  selectPrice,
  type FxConversionPolicy,
  type MarketCalendar,
  type PriceCandidate,
  type PriceKey,
  type PriceSelection,
  type PriceSelectionPolicy,
  type SelectionBound,
} from "../src/market-data.ts";
import type { PriceRuleId } from "../src/price-sources.ts";
import { compareTemporal, type TemporalValue } from "../src/time.ts";
import {
  addDecimals,
  compareDecimals,
  decimalEquals,
  decimalLiteral,
  divideDecimals,
  exactQuantity,
  integerDecimal,
  multiplyDecimals,
  normalizeDecimal,
  subtractDecimals,
  type ExactDecimal,
} from "../src/values.ts";
import { between, pad2, pick, seededRandom, seeds, shuffled, type Random } from "./property.ts";

const KEY: PriceKey = { baseInstrumentRef: "USD", quoteUnitRef: "JPY", priceKind: "reference" };
const RULES: PriceRuleId[] = ["fx-sbi-shinsei-board-v1", "sbi-foreign-stock-price-last-v1"];
const TOKYO = "Asia/Tokyo";

/** Open days of `calendar` in (from, to], walked day by day: the oracle for business-day ages. */
function walkOpenDays(calendar: MarketCalendar, from: string, to: string): number {
  let open = 0;
  const day = new Date(`${from}T00:00:00Z`);
  for (;;) {
    day.setUTCDate(day.getUTCDate() + 1);
    const text = day.toISOString().slice(0, 10);
    if (text > to) return open;
    const weekday = ((day.getUTCDay() + 6) % 7) + 1;
    if (!calendar.closedWeekdays.includes(weekday) && !calendar.closedDates.includes(text))
      open += 1;
  }
}
const calendarDays = (from: string, to: string) =>
  (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;

interface Case {
  bound: SelectionBound;
  policy: PriceSelectionPolicy;
  calendar: MarketCalendar | null;
  candidates: PriceCandidate[];
}

function randomCase(random: Random): Case {
  const asOfDay = between(random, 10, 19);
  const bound: SelectionBound = {
    effectiveBefore: new Date(Date.UTC(2026, 8, asOfDay + 1) - 9 * 3_600_000).toISOString(),
    asOfDate: `2026-09-${pad2(asOfDay)}`,
    knowledge:
      random() < 0.3
        ? {
            mode: "known-at",
            knownAt: `2026-09-${pad2(between(random, 5, 20))}T0${between(random, 0, 8)}:00:00.000Z`,
          }
        : { mode: "current" },
  };
  const business = random() < 0.4;
  const calendar: MarketCalendar = {
    calendarRef: "calendar:property",
    version: "1",
    zone: TOKYO,
    coverage:
      random() < 0.5
        ? { from: "2026-08-01", to: "2026-10-31" }
        : {
            from: `2026-09-${pad2(between(random, 1, 14))}`,
            to: `2026-09-${pad2(between(random, 15, 29))}`,
          },
    closedWeekdays: shuffled(random, [3, 6, 7])
      .slice(0, between(random, 0, 2))
      .sort(),
    closedDates: [
      ...new Set(
        Array.from(
          { length: between(random, 0, 4) },
          () => `2026-09-${pad2(between(random, 1, 25))}`,
        ),
      ),
    ].sort(),
    evidenceRefs: ["evidence:calendar:property"],
  };
  const maxAgeDays = between(random, 0, 5);
  const rules = random() < 0.5 ? [RULES[0]!] : shuffled(random, RULES);
  const policy: PriceSelectionPolicy = {
    policyId: "policy:property",
    admittedRules: rules,
    priceKinds: ["reference"],
    acceptedBases: ["provider", "collector"],
    zone: TOKYO,
    freshness: business
      ? { unit: "business-days", maxAgeDays, calendarRef: "calendar:property" }
      : { unit: "calendar-days", maxAgeDays },
    dateOnly: random() < 0.5 ? "exclude" : "civil-date-in-zone",
    multiSource: random() < 0.5 ? "refuse-on-overlap" : "priority-order",
    candidateScope: "latest-in-window",
  };
  const candidates: PriceCandidate[] = [];
  for (let index = 0; index < between(random, 0, 6); index += 1) {
    const day = `2026-09-${pad2(between(random, 3, 22))}`;
    const time: TemporalValue =
      random() < 0.6
        ? {
            kind: "instant",
            value: `${day}T${pad2(pick(random, [0, 8, 15, 23]))}:${pick(random, ["00", "30"])}:00${pick(random, ["+09:00", "Z", "-05:00", "+14:00"])}`,
            zone: TOKYO,
            basis: pick(random, ["provider", "collector"] as const),
          }
        : {
            kind: "local-date",
            value: day,
            zone: random() < 0.75 ? TOKYO : pick(random, [null, "UTC", "America/New_York"]),
            basis: "provider",
          };
    candidates.push({
      price: {
        id: `price-${index}`,
        baseInstrumentRef: "USD",
        baseQuantity: decimalLiteral(pick(random, ["1", "1", "10"])),
        quoteUnitRef: "JPY",
        quoteAmount: decimalLiteral(pick(random, ["150", "1500", "151", "0"])),
        priceKind: "reference",
        effectiveTime: time,
        sourceClaimRef: `valuation_observations/${index}#$.amount_text`,
        marketRef: null,
        adjustmentPolicyRef: null,
      },
      recordedAt: `2026-09-${pad2(between(random, 1, 25))}T0${between(random, 0, 8)}:00:00.000Z`,
      claim: {
        ruleId: pick(random, rules),
        claimKind: "valuation",
        observationId: index + 1,
        parseRunId: 1,
        jsonPath: "$.amount_text",
      },
    });
  }
  return { bound, policy, calendar: business ? calendar : null, candidates };
}

const SEEDS = seeds(1, 600);

describe("selectPrice over random candidates", () => {
  test("candidate order never changes the selection", () => {
    const broken: number[] = [];
    for (const seed of SEEDS) {
      const random = seededRandom(seed);
      const { bound, policy, calendar, candidates } = randomCase(random);
      const once = canonicalJson(selectPrice(KEY, candidates, bound, policy, calendar));
      const again = selectPrice(KEY, shuffled(random, candidates), bound, policy, calendar);
      if (canonicalJson(again) !== once) broken.push(seed);
    }
    expect(broken).toEqual([]);
  });

  test("a selected price is before the bound, known at K, fresh, and aged as the calendar says", () => {
    const broken: string[] = [];
    let selected = 0;
    for (const seed of SEEDS) {
      const { bound, policy, calendar, candidates } = randomCase(seededRandom(seed));
      const selection = selectPrice(KEY, candidates, bound, policy, calendar);
      if (selection.status === "refused") {
        if (selection.reason === "stale" && !(selection.ageDays! > policy.freshness.maxAgeDays))
          broken.push(`${seed}: stale within the window`);
        continue;
      }
      selected += 1;
      const time = selection.candidate.price.effectiveTime;
      let day: string | null = null;
      if (time.kind === "instant") {
        const order = compareTemporal(time, {
          kind: "instant",
          value: bound.effectiveBefore,
          zone: "UTC",
          basis: "derived",
        });
        if (order.kind !== "ordered" || order.order >= 0)
          broken.push(`${seed}: at or after the bound`);
        day = civilDateOfInstant(time.value, TOKYO);
      } else if (time.kind === "local-date") {
        if (time.zone !== TOKYO || time.value > bound.asOfDate)
          broken.push(`${seed}: foreign or later date`);
        day = time.value;
      }
      if (
        bound.knowledge.mode === "known-at" &&
        selection.candidate.recordedAt > bound.knowledge.knownAt
      )
        broken.push(`${seed}: recorded after K`);
      if (selection.ageDays > policy.freshness.maxAgeDays)
        broken.push(`${seed}: older than allowed`);
      // The age is calendar days, or open days in (price day, as-of], walked one by one.
      const expected =
        policy.freshness.unit === "calendar-days"
          ? calendarDays(day!, bound.asOfDate)
          : walkOpenDays(calendar!, day!, bound.asOfDate);
      if (selection.ageDays !== expected)
        broken.push(`${seed}: age ${selection.ageDays} != ${expected}`);
    }
    expect(broken).toEqual([]);
    expect(selected).toBeGreaterThan(60);
  });

  test("a looser freshness keeps a single-rule selection, and a price at the bound changes nothing", () => {
    const broken: string[] = [];
    for (const seed of SEEDS) {
      const { bound, policy, calendar, candidates } = randomCase(seededRandom(seed));
      const selection = selectPrice(KEY, candidates, bound, policy, calendar);
      if (selection.status !== "selected") continue;
      const id = selection.candidate.price.id;
      if (policy.admittedRules.length === 1) {
        const looser = {
          ...policy,
          freshness: { ...policy.freshness, maxAgeDays: policy.freshness.maxAgeDays + 1 },
        };
        const again = selectPrice(KEY, candidates, bound, looser, calendar);
        if (again.status !== "selected" || again.candidate.price.id !== id)
          broken.push(`${seed}: looser lost it`);
      }
      // The bound is exclusive: a price effective exactly at it is never a candidate.
      const atBound: PriceCandidate = {
        ...candidates[0]!,
        price: {
          ...candidates[0]!.price,
          id: "price-at-bound",
          effectiveTime: {
            kind: "instant",
            value: bound.effectiveBefore,
            zone: "UTC",
            basis: "provider",
          },
        },
      };
      const late = selectPrice(KEY, [...candidates, atBound], bound, policy, calendar);
      if (late.status !== "selected" || late.candidate.price.id !== id)
        broken.push(`${seed}: bound price counted`);
    }
    expect(broken).toEqual([]);
  });

  test("a business-day window starts at the earliest day an open-day walk still finds fresh", () => {
    const broken: string[] = [];
    for (const seed of SEEDS) {
      const { bound, policy, calendar } = randomCase(seededRandom(seed));
      if (calendar === null || bound.asOfDate > calendar.coverage.to) continue;
      let day = bound.asOfDate;
      for (;;) {
        const previous = new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000)
          .toISOString()
          .slice(0, 10);
        if (previous < calendar.coverage.from) break;
        if (walkOpenDays(calendar, previous, bound.asOfDate) > policy.freshness.maxAgeDays) break;
        day = previous;
      }
      const start = freshnessWindowStart(policy, bound, calendar);
      if (start !== day) broken.push(`${seed}: ${start} != ${day}`);
    }
    expect(broken).toEqual([]);
  });
});

describe("selectionManifest", () => {
  test("the order selections arrive in never changes the manifest", async () => {
    const broken: number[] = [];
    for (const seed of seeds(1, 100)) {
      const random = seededRandom(seed);
      const { bound, policy, calendar } = randomCase(random);
      const selections: PriceSelection[] = [];
      for (const currency of ["USD", "EUR", "AUD"]) {
        const key = { ...KEY, baseInstrumentRef: currency };
        // One recorded instant in several spellings, so ties between texts occur.
        const recordedAt = pick(random, [
          "2026-09-01T00:00:00.000Z",
          "2026-09-01T09:00:00+09:00",
          "2026-09-01T00:00:00Z",
          "2026-09-02T00:00:00.000Z",
        ]);
        const candidates = randomCase(random).candidates.map((candidate) => ({
          ...candidate,
          price: {
            ...candidate.price,
            id: `${currency}-${candidate.price.id}`,
            baseInstrumentRef: currency,
          },
          recordedAt,
        }));
        selections.push(
          selectPrice(
            key,
            candidates,
            { ...bound, knowledge: { mode: "current" } },
            policy,
            calendar,
          ),
        );
      }
      const manifest = (list: PriceSelection[]) =>
        selectionManifest({
          policies: [policy],
          calendars: calendar === null ? [] : [calendar],
          bound,
          selections: list,
        });
      if (
        canonicalJson(await manifest(shuffled(random, selections))) !==
        canonicalJson(await manifest(selections))
      )
        broken.push(seed);
    }
    expect(broken).toEqual([]);
  });
});

describe("convertToBase", () => {
  const MODES = ["down", "up", "floor", "ceiling", "half-up", "half-even"] as const;
  const policyWith = (mode: (typeof MODES)[number]): FxConversionPolicy => ({
    policyId: "fx-conversion:property",
    pivot: "JPY",
    currencies: ["USD", "EUR"],
    selection: {
      policyId: "fx-selection:property",
      admittedRules: ["fx-sbi-shinsei-board-v1"],
      priceKinds: ["reference"],
      acceptedBases: ["provider"],
      zone: TOKYO,
      freshness: { unit: "calendar-days", maxAgeDays: 3 },
      dateOnly: "exclude",
      multiSource: "refuse-on-overlap",
      candidateScope: "latest-in-window",
    },
    inverse: { mode, scaleByUnit: { USD: 2, EUR: 2, JPY: 0 } },
  });
  const rate = (currency: string, quote: ExactDecimal, base: ExactDecimal): PriceSelection => ({
    status: "selected",
    key: { baseInstrumentRef: currency, quoteUnitRef: "JPY", priceKind: "reference" },
    candidate: {
      price: {
        id: `rate-${currency}`,
        baseInstrumentRef: currency,
        baseQuantity: base,
        quoteUnitRef: "JPY",
        quoteAmount: quote,
        priceKind: "reference",
        effectiveTime: { kind: "local-date", value: "2026-09-10", zone: TOKYO, basis: "provider" },
        sourceClaimRef: "valuation_observations/1#$.amount_text",
        marketRef: null,
        adjustmentPolicyRef: null,
      },
      recordedAt: "2026-09-10T00:00:00.000Z",
      claim: {
        ruleId: "fx-sbi-shinsei-board-v1",
        claimKind: "valuation",
        observationId: 1,
        parseRunId: 1,
        jsonPath: "$.amount_text",
      },
    },
    ageDays: 0,
    corroboratedBy: [],
    excluded: selectPrice(
      KEY,
      [],
      {
        effectiveBefore: "2026-09-10T15:00:00.000Z",
        asOfDate: "2026-09-10",
        knowledge: { mode: "current" },
      },
      policyWith("down").selection,
      null,
    ).excluded,
    policyId: "fx-selection:property",
  });
  const positive = (random: Random) =>
    normalizeDecimal(BigInt(between(random, 1, 200_000)), between(random, 0, 3));

  test("into the pivot is exact; across it is rounded once, within one unit of the exact value", () => {
    const broken: string[] = [];
    for (const seed of seeds(1, 400)) {
      const random = seededRandom(seed);
      const policy = policyWith(pick(random, MODES));
      const usd = rate(
        "USD",
        positive(random),
        pick(random, [integerDecimal(1), integerDecimal(100)]),
      );
      const eur = rate(
        "EUR",
        positive(random),
        pick(random, [integerDecimal(1), integerDecimal(100)]),
      );
      const fx = new Map([
        ["USD", usd],
        ["EUR", eur],
      ]);
      const amount = exactQuantity(
        "USD",
        normalizeDecimal(BigInt(between(random, -100_000, 100_000)), between(random, 0, 2)),
      );
      const value = amount.value.status === "exact" ? amount.value.value : integerDecimal(0);
      const usdPrice = usd.status === "selected" ? usd.candidate.price : null;
      const eurPrice = eur.status === "selected" ? eur.candidate.price : null;
      const direct = convertToBase(amount, "JPY", fx, policy);
      const exactJpy = divideDecimals(
        multiplyDecimals(value, usdPrice!.quoteAmount),
        usdPrice!.baseQuantity,
      );
      if (
        !direct.ok ||
        !exactJpy.ok ||
        direct.value.value.status !== "exact" ||
        !decimalEquals(direct.value.value.value, exactJpy.value)
      )
        broken.push(`${seed}: direct hop not exact`);
      const across = convertToBase(amount, "EUR", fx, policy);
      if (!across.ok || across.value.value.status !== "exact") {
        broken.push(`${seed}: refused`);
        continue;
      }
      // exact = amount × (usd quote / usd base) ÷ (eur quote / eur base); compare without dividing.
      const numerator = multiplyDecimals(
        multiplyDecimals(value, usdPrice!.quoteAmount),
        eurPrice!.baseQuantity,
      );
      const denominator = multiplyDecimals(usdPrice!.baseQuantity, eurPrice!.quoteAmount);
      const unit = normalizeDecimal(1n, 2);
      const result = across.value.value.value;
      const above = multiplyDecimals(addDecimals(result, unit), denominator);
      const below = multiplyDecimals(subtractDecimals(result, unit), denominator);
      if (!(compareDecimals(numerator, above) < 0 && compareDecimals(numerator, below) > 0))
        broken.push(`${seed}: more than a unit from exact`);
      if (across.roundingInputs?.precision !== 2)
        broken.push(`${seed}: not rounded at the target scale`);
    }
    expect(broken).toEqual([]);
  });
});
