// Seeded property tests of the lot engine (ADR 0051) and the C adapter
// (ADR 0059). Each property runs a fixed set of seeds over random synthetic
// books (invented instruments, holders, dates and round amounts) and lists
// the seeds that break it, so a failure is reproducible from its seed.
import { describe, expect, test } from "bun:test";
import { canonicalJson } from "../src/context.ts";
import { lotsOnSelection } from "../src/lot-adapter.ts";
import {
  computeLots,
  LOT_INPUT_CONTRACT,
  LOT_LIMITED_REASON_CODES,
  type LotInput,
  type LotPolicy,
  type LotReasonCode,
} from "../src/lots.ts";
import { compareTemporal, type TemporalValue } from "../src/time.ts";
import {
  addDecimals,
  decimalEquals,
  decimalLiteral,
  integerDecimal,
  multiplyDecimals,
  type ExactDecimal,
  type Quantity,
} from "../src/values.ts";
import { q } from "./helpers.ts";
import * as fixture from "./lot-selection-fixture.ts";
import { between, pad2, pick, seededRandom, seeds, shuffled, type Random } from "./property.ts";

const ALPHA = "instrument:test:alpha";
const BETA = "instrument:test:beta";
const HOLDER = "account:test:a";

const exactOf = (quantity: Quantity): ExactDecimal => {
  if (quantity.value.status !== "exact") throw new Error("expected an exact quantity");
  return quantity.value.value;
};
const sum = (values: readonly ExactDecimal[]) => values.reduce(addDecimals, integerDecimal(0));
const refOf = (input: LotInput) =>
  input.ref.source === "event" ? `event:${input.ref.eventId}@${input.ref.revision}` : "";

interface Book {
  inputs: LotInput[];
  policy: LotPolicy;
  /** Every time is a Tokyo date, so a text day orders them exactly. */
  datesOnly: boolean;
}

/**
 * A random history of one or two books: acquisitions, disposals, snapshots
 * and splits on twelve days, dates or Tokyo instants, under a random method,
 * fee treatment, rounding and FX mode.
 */
function randomBook(random: Random): Book {
  const method = pick(random, ["fifo", "moving-average", "specific-identification"] as const);
  const convert = random() < 0.3;
  const policy: LotPolicy = {
    policyId: "lot-policy:property",
    version: 1,
    purpose: "investment-analysis",
    method,
    scope: "holder-instrument-wrapper",
    timeBasis: "trade-date",
    ordering: "temporal-then-indeterminate",
    acquisitionFee: pick(random, ["capitalize", "exclude"] as const),
    disposalFee: pick(random, ["reduce-proceeds", "separate"] as const),
    fx: convert ? "convert-at-input-rate" : "lot-currency",
    fxPolicyRef: "fx-policy:property@1",
    costUnitRef: convert ? "JPY" : null,
    rounding:
      random() < 0.3
        ? {
            policyId: "rounding:property",
            where: "leg",
            mode: pick(random, ["half-even", "down", "up"] as const),
            precision: between(random, 0, 2),
            residual: "carry",
          }
        : null,
  };
  const instants = random() < 0.3;
  const acquired: string[] = [];
  const inputs: LotInput[] = [];
  for (let index = 0; index < between(random, 1, 9); index += 1) {
    const instrumentRef = random() < 0.8 ? ALPHA : BETA;
    const date = `2030-01-${pad2(between(random, 1, 12))}`;
    const time: TemporalValue = instants
      ? {
          kind: "instant",
          value: `${date}T${pad2(between(random, 0, 2) * 7)}:00:00+09:00`,
          zone: "Asia/Tokyo",
          basis: "provider",
        }
      : { kind: "local-date", value: date, zone: "Asia/Tokyo", basis: "provider" };
    const roll = random();
    const kind =
      roll < 0.5 ? "acquisition" : roll < 0.85 ? "disposal" : roll < 0.93 ? "snapshot" : "split";
    const quantity = pick(random, ["1", "2", "3", "5", "10", "0.5", "7"]);
    const input: LotInput = {
      contract: LOT_INPUT_CONTRACT,
      ref: { source: "event", eventId: `evt-${index}`, revision: 1 },
      kind,
      holderRef: HOLDER,
      instrumentRef,
      wrapperKey: "wrapper:test",
      instrumentClass: "listed-equity",
      time: { trade: time, settlement: { kind: "unknown", reasonCode: "not_stated" } },
      quantity: q(instrumentRef, quantity),
      consideration: null,
      fees: [],
      fx: null,
      split: null,
      lotSelections: null,
    };
    if (kind === "acquisition") {
      const unit = convert && random() < 0.4 ? "USD" : "JPY";
      if (random() < 0.9) input.consideration = q(unit, pick(random, ["100", "101", "333", "7"]));
      if (random() < 0.4) input.fees = [q(unit, pick(random, ["1", "3", "10"]))];
      if (unit === "USD" && random() < 0.8)
        input.fx = {
          rate: decimalLiteral(pick(random, ["150", "149.5"])),
          fromUnit: "USD",
          toUnit: "JPY",
          rateRef: "rate:property",
        };
      acquired.push(`event:evt-${index}@1`);
    } else if (kind === "disposal") {
      if (random() < 0.9) input.consideration = q("JPY", pick(random, ["150", "99", "1000"]));
      if (random() < 0.3) input.fees = [q("JPY", pick(random, ["1", "2"]))];
      if (method === "specific-identification")
        input.lotSelections = [
          {
            lotId: acquired.length > 0 ? pick(random, acquired) : "event:evt-0@1",
            quantity: q(instrumentRef, quantity),
          },
        ];
    } else if (kind === "split") {
      input.split = {
        numerator: pick(random, ["2", "3", "1"]),
        denominator: pick(random, ["1", "2"]),
      };
      input.quantity = q(instrumentRef, pick(random, ["0", "10", "20"]));
    } else input.quantity = q(instrumentRef, pick(random, ["0", "5", "10"]));
    inputs.push(input);
  }
  return { inputs, policy, datesOnly: !instants };
}

/** The input's own amount in the policy's cost unit, as an oracle independent of the engine. */
function inCostUnit(input: LotInput, amount: Quantity, policy: LotPolicy): ExactDecimal | null {
  if (policy.fx === "lot-currency" || amount.unitRef === policy.costUnitRef) return exactOf(amount);
  return input.fx === null ? null : multiplyDecimals(exactOf(amount), input.fx.rate);
}

const SEEDS = seeds(1, 400);

describe("computeLots over random books", () => {
  test("the order inputs are handed in never changes the result", () => {
    const broken: number[] = [];
    for (const seed of SEEDS) {
      const random = seededRandom(seed);
      const { inputs, policy } = randomBook(random);
      const once = canonicalJson(computeLots(inputs, policy));
      if (canonicalJson(computeLots(shuffled(random, inputs), policy)) !== once) broken.push(seed);
    }
    expect(broken).toEqual([]);
  });

  test("outcomes, allocations and the no-look-ahead rule hold for every disposal", () => {
    const broken: string[] = [];
    for (const seed of SEEDS) {
      const { inputs, policy } = randomBook(seededRandom(seed));
      const result = computeLots(inputs, policy);
      if (result.status !== "computed") continue;
      for (const book of result.books) {
        if (book.status !== "computed") continue;
        for (const disposal of book.disposals) {
          const codes = disposal.reasonCodes as LotReasonCode[];
          if (disposal.outcome === "allocated" && codes.length > 0)
            broken.push(`${seed}: allocated with reasons`);
          if (
            disposal.outcome === "limited" &&
            !codes.every((code) => (LOT_LIMITED_REASON_CODES as readonly string[]).includes(code))
          )
            broken.push(`${seed}: limited with a stop code`);
          if (disposal.outcome === "indeterminate") {
            if (disposal.allocations.length > 0)
              broken.push(`${seed}: indeterminate with allocations`);
            continue;
          }
          // Every unit came from a lot, and no lot was taken twice in one disposal.
          const taken = sum(disposal.allocations.map((allocation) => exactOf(allocation.quantity)));
          if (!decimalEquals(taken, exactOf(disposal.quantity)))
            broken.push(`${seed}: allocations do not sum`);
          const lots = disposal.allocations.map((allocation) => allocation.lotId);
          if (new Set(lots).size !== lots.length)
            broken.push(`${seed}: one lot twice in a disposal`);
          // A lot is only ever drawn when its acquisition is strictly earlier.
          for (const allocation of disposal.allocations) {
            const origin = inputs.find((input) => refOf(input) === allocation.lotId);
            if (origin === undefined || origin.kind !== "acquisition") continue;
            const order = compareTemporal(origin.time.trade, disposal.time);
            if (order.kind !== "ordered" || order.order >= 0)
              broken.push(`${seed}: drew a later lot`);
          }
        }
      }
    }
    expect(broken).toEqual([]);
  });

  test("quantity and cost are conserved exactly in every determinate book (INV03, INV06)", () => {
    const broken: string[] = [];
    let checked = 0;
    for (const seed of SEEDS) {
      const { inputs, policy } = randomBook(seededRandom(seed));
      const result = computeLots(inputs, policy);
      if (result.status !== "computed") continue;
      for (const book of result.books) {
        if (book.status !== "computed" || book.indeterminateFrom !== null) continue;
        const own = inputs.filter((input) => input.instrumentRef === book.instrumentRef);
        if (own.some((input) => input.kind === "split" || input.kind === "snapshot")) continue;
        const allocations = book.disposals.flatMap((disposal) => disposal.allocations);
        const lots = book.remainingLots ?? [];
        // Units: what was acquired is what was allocated plus what is left.
        const entered = sum(
          own.filter((i) => i.kind === "acquisition").map((i) => exactOf(i.quantity)),
        );
        const out = sum([
          ...allocations.map((allocation) => exactOf(allocation.quantity)),
          ...lots.map((lot) => exactOf(lot.remainingQuantity)),
        ]);
        if (!decimalEquals(entered, out)) broken.push(`${seed}: units not conserved`);
        // Cost: when every amount is known, allocated + remaining = what entered.
        const parts: (ExactDecimal | null)[] = [];
        for (const input of own.filter((i) => i.kind === "acquisition")) {
          parts.push(
            input.consideration === null ? null : inCostUnit(input, input.consideration, policy),
          );
          if (policy.acquisitionFee === "capitalize")
            for (const fee of input.fees) parts.push(inCostUnit(input, fee, policy));
        }
        const known = [
          ...allocations.map((allocation) => allocation.cost),
          ...lots.map((lot) => lot.remainingCost),
        ];
        if (
          parts.some((part) => part === null) ||
          known.some((amount) => amount.status !== "known")
        )
          continue;
        checked += 1;
        const costOut = sum(
          known.map((amount) =>
            amount.status === "known" ? exactOf(amount.amount) : integerDecimal(0),
          ),
        );
        if (!decimalEquals(sum(parts as ExactDecimal[]), costOut))
          broken.push(`${seed}: cost not conserved`);
      }
    }
    expect(broken).toEqual([]);
    expect(checked).toBeGreaterThan(50);
  });

  test("a later input never changes an earlier disposal", () => {
    const broken: number[] = [];
    for (const seed of SEEDS) {
      const random = seededRandom(seed);
      const { inputs, policy, datesOnly } = randomBook(random);
      if (!datesOnly) continue;
      const cut = `2030-01-${pad2(between(random, 2, 12))}`;
      const day = (time: TemporalValue) => (time.kind === "local-date" ? time.value : "");
      const full = computeLots(inputs, policy);
      const prefix = computeLots(
        inputs.filter((input) => day(input.time.trade) < cut),
        policy,
      );
      if (full.status !== "computed" || prefix.status !== "computed") continue;
      for (const book of prefix.books) {
        if (book.status !== "computed") continue;
        const whole = full.books.find((entry) => entry.instrumentRef === book.instrumentRef);
        if (whole?.status !== "computed") continue;
        const earlier = whole.disposals.filter((disposal) => day(disposal.time) < cut);
        if (canonicalJson(earlier) !== canonicalJson(book.disposals)) broken.push(seed);
      }
    }
    expect(broken).toEqual([]);
  });
});

describe("lotsOnSelection over random selections", () => {
  const BETA_MAPPING = {
    ...fixture.ALPHA_MAPPING,
    unitRef: fixture.BETA_UNIT,
    instrumentRef: fixture.BETA,
  };

  test("revision, claim, time, holder and mapping order never change the answer or its context", async () => {
    const broken: string[] = [];
    for (const seed of seeds(1, 120)) {
      const random = seededRandom(seed);
      const specs: fixture.FixtureRevision[] = [];
      for (let index = 0; index < between(random, 1, 6); index += 1) {
        const date = `2030-01-${pad2(between(random, 1, 9))}`;
        const fee = random() < 0.4 ? { fee: pick(random, ["1", "2.5"]) } : {};
        const spec =
          random() < 0.6
            ? fixture.buy(
                `ev-${index}`,
                date,
                pick(random, ["1", "2", "5"]),
                pick(random, ["101", "300"]),
                fee,
              )
            : fixture.sell(
                `ev-${index}`,
                date,
                pick(random, ["1", "2"]),
                pick(random, ["150", "99"]),
                fee,
              );
        if (random() < 0.2) spec.legs![0]!.unit = fixture.BETA_UNIT;
        if (random() < 0.1) spec.times = [spec.times![0]!];
        specs.push(spec);
      }
      const selection = await fixture.selection(specs);
      const request = fixture.request({
        instruments: [fixture.ALPHA_MAPPING, BETA_MAPPING],
        holders: [
          { accountId: fixture.HOLDER, wrapperKey: fixture.WRAPPER },
          { accountId: fixture.OTHER, wrapperKey: "wrapper:test:other" },
        ],
        policy: fixture.policy({ method: pick(random, ["fifo", "moving-average"] as const) }),
      });
      const first = await lotsOnSelection(selection, request);
      const again = await lotsOnSelection(
        {
          ...selection,
          revisions: shuffled(random, selection.revisions).map((revision) => ({
            ...revision,
            claims: shuffled(random, revision.claims),
            times: shuffled(random, revision.times),
          })),
        },
        {
          ...request,
          instruments: shuffled(random, request.instruments),
          holders: shuffled(random, request.holders),
        },
      );
      if (!first.ok || !again.ok) {
        broken.push(`${seed}: refused`);
        continue;
      }
      if (canonicalJson(again.result) !== canonicalJson(first.result))
        broken.push(`${seed}: order`);
      // The cash that crossed the account is the consideration and the fees, each once.
      for (const input of first.result.adaptation.inputs) {
        const revision = selection.revisions.find(
          (entry) => entry.eventId === (input.ref as { eventId: string }).eventId,
        )!;
        const cash = revision.legs.find(
          (leg) => leg.effect === "movement" && leg.quantity.unitRef === "JPY",
        );
        if (cash === undefined || input.consideration === null) continue;
        const fees = sum(input.fees.map(exactOf));
        const crossed =
          input.kind === "acquisition"
            ? addDecimals(exactOf(input.consideration), fees)
            : addDecimals(exactOf(input.consideration), multiplyDecimals(fees, integerDecimal(-1)));
        if (!decimalEquals(crossed, exactOf(cash.quantity)))
          broken.push(`${seed}: cash not conserved`);
      }
    }
    expect(broken).toEqual([]);
  });
});
