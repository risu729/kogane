// #556: the pure lot engine over the provisional input contract. Every
// instrument, holder, wrapper, date and amount below is invented; nothing
// mirrors a real holding.
import { describe, expect, test } from "bun:test";
import { canonicalDigest, canonicalJson } from "../src/context.ts";
import {
  computeLots,
  LOT_INPUT_CONTRACT,
  lotInputRefText,
  validLotInput,
  validLotInputRef,
  validLotPolicy,
  type LotAmount,
  type LotBook,
  type LotInput,
  type LotPolicy,
  type LotResult,
} from "../src/lots.ts";
import type { TemporalValue } from "../src/time.ts";
import {
  absentQuantity,
  addDecimals,
  decimalLiteral,
  integerDecimal,
  type ExactDecimal,
} from "../src/values.ts";
import { exact, q, quantityText } from "./helpers.ts";

const ALPHA = "instrument:test:alpha";
const HOLDER = "account:test:a";
const WRAPPER = "wrapper:test:general";

const day = (value: string): TemporalValue => ({
  kind: "local-date",
  value,
  zone: "Asia/Tokyo",
  basis: "provider",
});

interface Draft {
  kind?: LotInput["kind"];
  date?: string;
  time?: LotInput["time"];
  quantity?: string;
  consideration?: LotInput["consideration"];
  fees?: LotInput["fees"];
  fx?: LotInput["fx"];
  split?: LotInput["split"];
  lotSelections?: LotInput["lotSelections"];
  holderRef?: string;
  instrumentRef?: string;
  wrapperKey?: string;
  instrumentClass?: LotInput["instrumentClass"];
  revision?: number;
}

function input(id: string, draft: Draft): LotInput {
  const instrumentRef = draft.instrumentRef ?? ALPHA;
  const date = draft.date ?? "2030-01-06";
  return {
    contract: LOT_INPUT_CONTRACT,
    ref: { source: "event", eventId: `evt-${id}`, revision: draft.revision ?? 1 },
    kind: draft.kind ?? "acquisition",
    holderRef: draft.holderRef ?? HOLDER,
    instrumentRef,
    wrapperKey: draft.wrapperKey ?? WRAPPER,
    instrumentClass: draft.instrumentClass ?? "listed-equity",
    time: draft.time ?? {
      trade: day(date),
      settlement: { kind: "unknown", reasonCode: "not_stated" },
    },
    quantity: q(instrumentRef, draft.quantity ?? "10"),
    consideration: draft.consideration === undefined ? null : draft.consideration,
    fees: draft.fees ?? [],
    fx: draft.fx ?? null,
    split: draft.split ?? null,
    lotSelections: draft.lotSelections ?? null,
  };
}

const jpy = (text: string) => q("JPY", text);
const usd = (text: string) => q("USD", text);
const buy = (id: string, date: string, quantity: string, cost: string, extra: Draft = {}) =>
  input(id, { kind: "acquisition", date, quantity, consideration: jpy(cost), ...extra });
const sell = (id: string, date: string, quantity: string, proceeds: string, extra: Draft = {}) =>
  input(id, { kind: "disposal", date, quantity, consideration: jpy(proceeds), ...extra });
const ref = (id: string, revision = 1) => `event:evt-${id}@${revision}`;

function policy(overrides: Partial<LotPolicy> = {}): LotPolicy {
  return {
    policyId: "lot-policy:test",
    version: 1,
    purpose: "investment-analysis",
    method: "fifo",
    scope: "holder-instrument-wrapper",
    timeBasis: "trade-date",
    ordering: "temporal-then-indeterminate",
    acquisitionFee: "capitalize",
    disposalFee: "separate",
    fx: "lot-currency",
    fxPolicyRef: "fx-policy:test@1",
    costUnitRef: null,
    rounding: null,
    ...overrides,
  };
}

const yenLegRounding = {
  policyId: "rounding:test:jpy-leg",
  where: "leg",
  mode: "half-even",
  precision: 0,
  residual: "carry",
} as const;

type Computed = Extract<LotResult, { status: "computed" }>;
type ComputedBook = Extract<LotBook, { status: "computed" }>;

function computed(result: LotResult): Computed {
  if (result.status !== "computed") throw new Error(`refused: ${result.reasonCode}`);
  return result;
}

function onlyBook(result: LotResult): ComputedBook {
  const books = computed(result).books;
  expect(books).toHaveLength(1);
  const book = books[0]!;
  if (book.status !== "computed") throw new Error(`book refused: ${book.reasonCode}`);
  return book;
}

function amountText(amount: LotAmount | null): string | null {
  if (amount === null) return null;
  if (amount.status === "unknown") return `unknown:${amount.reasonCode}`;
  return `${quantityText(amount.amount)} ${amount.amount.unitRef}`;
}

function knownValue(amount: LotAmount): ExactDecimal {
  if (amount.status !== "known") throw new Error(`expected known, got ${amount.reasonCode}`);
  return exact(amount.amount);
}

const sum = (values: readonly ExactDecimal[]) => values.reduce(addDecimals, integerDecimal(0));
const text = (value: ExactDecimal) =>
  quantityText({ unitRef: "x", value: { status: "exact", value, normalizationVersion: "t" } });

/** allocated + remaining = what entered the lots, for both cost and quantity. */
function conservation(book: ComputedBook): { cost: string | null; quantity: string | null } {
  const allocations = book.disposals.flatMap((disposal) => disposal.allocations);
  const lots = book.remainingLots ?? [];
  return {
    cost: text(
      sum([
        ...allocations.map((allocation) => knownValue(allocation.cost)),
        ...lots.map((lot) => knownValue(lot.remainingCost)),
      ]),
    ),
    quantity: text(
      sum([
        ...allocations.map((allocation) => exact(allocation.quantity)),
        ...lots.map((lot) => exact(lot.remainingQuantity)),
      ]),
    ),
  };
}

const twoLotsThenPartialSale = (selections: LotInput["lotSelections"] = null) => [
  buy("a", "2030-01-06", "10", "1000"),
  buy("b", "2030-01-07", "10", "1200"),
  sell("s", "2030-01-08", "15", "2000", { lotSelections: selections }),
];

describe("methods allocate a partial disposal across lots and conserve exactly", () => {
  test("FIFO takes the oldest lot first", () => {
    const book = onlyBook(computeLots(twoLotsThenPartialSale(), policy()));
    const [disposal] = book.disposals;
    expect(disposal!.outcome).toBe("allocated");
    expect(disposal!.reasonCodes).toEqual([]);
    expect(
      disposal!.allocations.map((a) => [a.lotId, quantityText(a.quantity), amountText(a.cost)]),
    ).toEqual([
      [ref("a"), "10", "1000 JPY"],
      [ref("b"), "5", "600 JPY"],
    ]);
    expect(quantityText(disposal!.allocatedCost)).toBe("1600");
    expect(amountText(disposal!.proceeds)).toBe("2000 JPY");
    expect(
      book.remainingLots!.map((lot) => [lot.lotId, quantityText(lot.remainingQuantity)]),
    ).toEqual([[ref("b"), "5"]]);
    expect(conservation(book)).toEqual({ cost: "2200", quantity: "20" });
    expect(computed(computeLots(twoLotsThenPartialSale(), policy())).partition).toBe("complete");
  });

  test("moving average keeps exact pool totals and never stores a unit price", () => {
    const book = onlyBook(
      computeLots(twoLotsThenPartialSale(), policy({ method: "moving-average" })),
    );
    const [disposal] = book.disposals;
    expect(disposal!.allocations).toHaveLength(1);
    expect(disposal!.allocations[0]!.lotId).toBe(`pool:${ref("a")}`);
    expect(disposal!.allocations[0]!.acquisitionRefs).toEqual([ref("a"), ref("b")]);
    expect(amountText(disposal!.allocations[0]!.cost)).toBe("1650 JPY");
    const [pool] = book.remainingLots!;
    expect(quantityText(pool!.quantity)).toBe("20");
    expect(amountText(pool!.cost)).toBe("2200 JPY");
    expect(amountText(pool!.remainingCost)).toBe("550 JPY");
    expect(pool!.acquiredAt).toBeNull();
    expect(Object.keys(pool!).some((key) => /price/iu.test(key))).toBe(false);
    expect(conservation(book)).toEqual({ cost: "2200", quantity: "20" });
  });

  test("specific identification takes the named lots", () => {
    const selections = [
      { lotId: ref("b"), quantity: q(ALPHA, "10") },
      { lotId: ref("a"), quantity: q(ALPHA, "5") },
    ];
    const book = onlyBook(
      computeLots(
        twoLotsThenPartialSale(selections),
        policy({ method: "specific-identification" }),
      ),
    );
    const [disposal] = book.disposals;
    expect(disposal!.allocations.map((a) => [a.lotId, amountText(a.cost)])).toEqual([
      [ref("a"), "500 JPY"],
      [ref("b"), "1200 JPY"],
    ]);
    expect(quantityText(disposal!.allocatedCost)).toBe("1700");
    expect(conservation(book)).toEqual({ cost: "2200", quantity: "20" });
  });

  test("every lot carries an origin lineage with the transfer fields reserved", () => {
    const book = onlyBook(computeLots([buy("a", "2030-01-06", "10", "1000")], policy()));
    expect(book.remainingLots![0]!.lineage).toEqual({
      originRef: ref("a"),
      originAcquiredAt: day("2030-01-06"),
      originCostUnit: "JPY",
      fragmentOf: null,
      splits: [],
    });
  });
});

describe("partial allocation: exact, refused, or rounded with the remainder carried", () => {
  const thirds = [
    buy("a", "2030-01-06", "3", "100"),
    sell("s1", "2030-01-07", "1", "40"),
    sell("s2", "2030-01-08", "1", "40"),
    sell("s3", "2030-01-09", "1", "40"),
  ];

  test("100 / 3 without a rounding policy is inexact_allocation, not a guess", () => {
    for (const method of ["fifo", "moving-average"] as const) {
      const book = onlyBook(computeLots(thirds, policy({ method })));
      expect(book.indeterminateFrom).toEqual({
        refs: [ref("s1")],
        reasonCode: "inexact_allocation",
      });
      expect(book.disposals.map((d) => [d.outcome, d.reasonCodes])).toEqual([
        ["indeterminate", ["inexact_allocation"]],
        ["indeterminate", ["upstream_indeterminate"]],
        ["indeterminate", ["upstream_indeterminate"]],
      ]);
      expect(book.remainingLots).toBeNull();
    }
  });

  test("with a half-even leg rounding the last disposal carries the exact remainder", () => {
    for (const method of ["fifo", "moving-average"] as const) {
      const book = onlyBook(computeLots(thirds, policy({ method, rounding: yenLegRounding })));
      const costs = book.disposals.map((d) => amountText(d.allocations[0]!.cost));
      expect(costs).toEqual(["33 JPY", "34 JPY", "33 JPY"]);
      const [first, second, last] = book.disposals.map(
        (d) => d.allocations[0]!.roundingInputs.cost,
      );
      expect(first!.operands.map(text)).toEqual(["100", "1", "3"]);
      expect(first!.preRounding).toBeNull();
      expect(first!.policyId).toBe("rounding:test:jpy-leg");
      expect(second!.operands.map(text)).toEqual(["67", "1", "2"]);
      expect(text(second!.preRounding!)).toBe("33.5");
      expect(last).toBeNull();
      expect(conservation(book)).toEqual({ cost: "100", quantity: "3" });
    }
  });
});

describe("acquisition fees", () => {
  const withFee = (fees: LotInput["fees"]) => [buy("a", "2030-01-06", "10", "1000", { fees })];

  test("capitalize puts the fee into cost; exclude keeps it beside", () => {
    const capitalized = onlyBook(computeLots(withFee([jpy("10")]), policy())).remainingLots![0]!;
    expect(amountText(capitalized.cost)).toBe("1010 JPY");
    expect(amountText(capitalized.acquisitionFees)).toBe("10 JPY");
    const excluded = onlyBook(
      computeLots(withFee([jpy("10")]), policy({ acquisitionFee: "exclude" })),
    ).remainingLots![0]!;
    expect(amountText(excluded.cost)).toBe("1000 JPY");
    expect(amountText(excluded.acquisitionFees)).toBe("10 JPY");
  });

  test("an empty fee list is no stated fee, not a zero", () => {
    const lot = onlyBook(computeLots(withFee([]), policy())).remainingLots![0]!;
    expect(lot.acquisitionFees).toBeNull();
    expect(amountText(lot.cost)).toBe("1000 JPY");
  });

  test("an unknown fee makes a capitalized cost unknown (fee_unknown) and the disposal limited", () => {
    const fees = [absentQuantity("JPY", "missing", "not_stated")];
    const inputs = [...withFee(fees), sell("s", "2030-01-07", "4", "500")];
    const book = onlyBook(computeLots(inputs, policy()));
    const [disposal] = book.disposals;
    expect(amountText(disposal!.allocations[0]!.cost)).toBe("unknown:fee_unknown");
    expect(disposal!.allocatedCost).toBeNull();
    expect(disposal!.outcome).toBe("limited");
    expect(disposal!.reasonCodes).toEqual(["unknown_acquisition_fee", "unknown_cost"]);
    expect(computed(computeLots(inputs, policy())).partition).toBe("partial-verified-scope");
  });

  test("review finding 4: an unknown excluded fee keeps the disposal limited, never complete", () => {
    const fees = [absentQuantity("JPY", "missing", "not_stated")];
    const inputs = [...withFee(fees), sell("s", "2030-01-07", "10", "1200")];
    const result = computeLots(inputs, policy({ acquisitionFee: "exclude" }));
    const disposal = onlyBook(result).disposals[0]!;
    expect(amountText(disposal.allocations[0]!.cost)).toBe("1000 JPY");
    expect(amountText(disposal.allocations[0]!.acquisitionFees)).toBe("unknown:fee_unknown");
    expect(quantityText(disposal.allocatedCost)).toBe("1000");
    expect(disposal.outcome).toBe("limited");
    expect(disposal.reasonCodes).toEqual(["unknown_acquisition_fee"]);
    expect(computed(result).partition).toBe("partial-verified-scope");
  });

  test("a consideration that is not stated is consideration_missing, never zero", () => {
    const inputs = [
      input("a", { kind: "acquisition", quantity: "10", consideration: null }),
      sell("s", "2030-01-07", "10", "900"),
    ];
    const disposal = onlyBook(computeLots(inputs, policy())).disposals[0]!;
    expect(amountText(disposal.allocations[0]!.cost)).toBe("unknown:consideration_missing");
    expect(disposal.reasonCodes).toEqual(["unknown_cost"]);
  });
});

describe("disposal fees", () => {
  const inputs = (fees: LotInput["fees"]) => [
    buy("a", "2030-01-06", "10", "1000"),
    sell("s", "2030-01-07", "10", "1500", { fees }),
  ];

  test("reduce-proceeds nets the fee; separate reports gross proceeds and the fee beside", () => {
    const reduced = onlyBook(
      computeLots(inputs([jpy("15")]), policy({ disposalFee: "reduce-proceeds" })),
    ).disposals[0]!;
    expect(amountText(reduced.proceeds)).toBe("1485 JPY");
    expect(amountText(reduced.disposalFees)).toBe("15 JPY");
    const separate = onlyBook(computeLots(inputs([jpy("15")]), policy())).disposals[0]!;
    expect(amountText(separate.proceeds)).toBe("1500 JPY");
    expect(amountText(separate.disposalFees)).toBe("15 JPY");
    expect(separate.outcome).toBe("allocated");
  });

  test("an unknown disposal fee leaves proceeds unknown under reduce-proceeds", () => {
    const fees = [absentQuantity("JPY", "unparsed", "not_read")];
    const disposal = onlyBook(computeLots(inputs(fees), policy({ disposalFee: "reduce-proceeds" })))
      .disposals[0]!;
    expect(amountText(disposal.proceeds)).toBe("unknown:fee_unknown");
    expect(disposal.outcome).toBe("limited");
    expect(disposal.reasonCodes).toEqual(["unknown_proceeds"]);
    expect(quantityText(disposal.allocatedCost)).toBe("1000");
  });
});

describe("FX", () => {
  const rate = {
    rate: decimalLiteral("150"),
    fromUnit: "USD",
    toUnit: "JPY",
    rateRef: "fx:test:1",
  };

  test("lot-currency keeps each lot in its own unit and never sums USD with JPY", () => {
    const inputs = [
      input("a", { kind: "acquisition", date: "2030-01-06", consideration: usd("100") }),
      buy("b", "2030-01-07", "10", "15000"),
      sell("s", "2030-01-08", "15", "20000"),
    ];
    const disposal = onlyBook(computeLots(inputs, policy())).disposals[0]!;
    expect(disposal.allocations.map((a) => amountText(a.cost))).toEqual(["100 USD", "7500 JPY"]);
    expect(disposal.allocatedCost).toBeNull();
    expect(disposal.outcome).toBe("limited");
    expect(disposal.reasonCodes).toEqual(["unit_mismatch"]);
    const pooled = onlyBook(computeLots(inputs, policy({ method: "moving-average" })));
    expect(pooled.indeterminateFrom).toEqual({ refs: [ref("b")], reasonCode: "unit_mismatch" });
  });

  test("convert-at-input-rate converts with the input's rate and records its ref", () => {
    const inputs = [
      input("a", {
        kind: "acquisition",
        consideration: usd("100.5"),
        fees: [usd("1")],
        fx: rate,
      }),
      sell("s", "2030-01-07", "10", "16000"),
    ];
    const book = onlyBook(
      computeLots(inputs, policy({ fx: "convert-at-input-rate", costUnitRef: "JPY" })),
    );
    const allocation = book.disposals[0]!.allocations[0]!;
    expect(amountText(allocation.cost)).toBe("15225 JPY");
    expect(allocation.fxBasis).toEqual([rate]);
    expect(book.disposals[0]!.fxBasis).toBeNull();
  });

  test("a foreign amount without a rate is fx_rate_missing", () => {
    const inputs = [
      input("a", { kind: "acquisition", consideration: usd("100") }),
      input("s", { kind: "disposal", date: "2030-01-07", consideration: usd("120") }),
    ];
    const disposal = onlyBook(
      computeLots(inputs, policy({ fx: "convert-at-input-rate", costUnitRef: "JPY" })),
    ).disposals[0]!;
    expect(amountText(disposal.allocations[0]!.cost)).toBe("unknown:fx_rate_missing");
    expect(amountText(disposal.proceeds)).toBe("unknown:fx_rate_missing");
    expect(disposal.reasonCodes).toEqual(["fx_rate_missing", "unknown_cost", "unknown_proceeds"]);
  });
});

describe("splits keep cost and acquisition time and record the quantity lineage", () => {
  const split = (
    id: string,
    date: string,
    numerator: string,
    denominator: string,
    stated: string,
  ) => input(id, { kind: "split", date, quantity: stated, split: { numerator, denominator } });

  test("1:2 split doubles the quantity, cost unchanged", () => {
    const inputs = [
      buy("a", "2030-01-06", "10", "1000"),
      split("x", "2030-01-07", "2", "1", "20"),
      sell("s", "2030-01-08", "5", "300"),
    ];
    const book = onlyBook(computeLots(inputs, policy()));
    expect(amountText(book.disposals[0]!.allocations[0]!.cost)).toBe("250 JPY");
    const lot = book.remainingLots![0]!;
    expect(quantityText(lot.quantity)).toBe("20");
    expect(quantityText(lot.remainingQuantity)).toBe("15");
    expect(amountText(lot.remainingCost)).toBe("750 JPY");
    expect(lot.acquiredAt).toEqual(day("2030-01-06"));
    expect(lot.lineage.splits).toEqual([
      { splitRef: ref("x"), ratio: { numerator: "2", denominator: "1" } },
    ]);
  });

  test("a reverse split halves the quantity", () => {
    const inputs = [buy("a", "2030-01-06", "10", "1000"), split("x", "2030-01-07", "1", "2", "5")];
    const lot = onlyBook(computeLots(inputs, policy())).remainingLots![0]!;
    expect(quantityText(lot.remainingQuantity)).toBe("5");
    expect(amountText(lot.remainingCost)).toBe("1000 JPY");
  });

  test("a ratio that does not scale exactly, or disagrees with the stated holding, is unsupported", () => {
    const inexact = onlyBook(
      computeLots(
        [buy("a", "2030-01-06", "10", "1000"), split("x", "2030-01-07", "1", "3", "3")],
        policy(),
      ),
    );
    expect(inexact.indeterminateFrom).toEqual({
      refs: [ref("x")],
      reasonCode: "corporate_action_unsupported",
    });
    const cashInLieu = onlyBook(
      computeLots(
        [buy("a", "2030-01-06", "3", "300"), split("x", "2030-01-07", "1", "2", "1")],
        policy(),
      ),
    );
    expect(cashInLieu.indeterminateFrom).toEqual({
      refs: [ref("x")],
      reasonCode: "corporate_action_unsupported",
    });
    expect(cashInLieu.remainingLots).toBeNull();
  });
});

describe("snapshots are checks or unknown-cost seeds, never cost", () => {
  const snapshot = (id: string, date: string, quantity: string) =>
    input(id, { kind: "snapshot", date, quantity });

  test("a snapshot with no history is a lot of unknown cost; its disposal is limited", () => {
    const inputs = [snapshot("p", "2030-01-06", "10"), sell("s", "2030-01-07", "4", "500")];
    const result = computeLots(inputs, policy());
    const book = onlyBook(result);
    const disposal = book.disposals[0]!;
    expect(disposal.outcome).toBe("limited");
    expect(disposal.allocatedCost).toBeNull();
    expect(amountText(disposal.allocations[0]!.cost)).toBe("unknown:snapshot_only");
    expect(disposal.reasonCodes).toEqual(["unknown_cost"]);
    const lot = book.remainingLots![0]!;
    expect(quantityText(lot.remainingQuantity)).toBe("6");
    expect(amountText(lot.remainingCost)).toBe("unknown:snapshot_only");
    expect(lot.acquiredAt).toEqual({ kind: "unknown", reasonCode: "snapshot_only" });
    expect(computed(result).partition).toBe("partial-verified-scope");
  });

  test("a snapshot carrying a provider cost is refused as invalid input", () => {
    const withCost = { ...snapshot("p", "2030-01-06", "10"), consideration: jpy("1000") };
    const result = computeLots([withCost], policy());
    expect(result).toMatchObject({
      status: "refused",
      reasonCode: "invalid_input",
      refs: [ref("p")],
    });
  });

  test("an agreeing snapshot is a check; a disagreeing one stops the book", () => {
    const agree = onlyBook(
      computeLots(
        [buy("a", "2030-01-06", "10", "1000"), snapshot("p", "2030-01-07", "10")],
        policy(),
      ),
    );
    expect(agree.indeterminateFrom).toBeNull();
    const disagree = onlyBook(
      computeLots(
        [
          buy("a", "2030-01-06", "10", "1000"),
          snapshot("p", "2030-01-07", "12"),
          sell("s", "2030-01-08", "4", "500"),
        ],
        policy(),
      ),
    );
    expect(disagree.indeterminateFrom).toEqual({
      refs: [ref("p")],
      reasonCode: "snapshot_mismatch",
    });
    expect(disagree.disposals[0]!.reasonCodes).toEqual(["upstream_indeterminate"]);
    expect(disagree.remainingLots).toBeNull();
  });

  test("a snapshot whose boundary on the policy's basis is not stated is unknown_time", () => {
    const inputs = [buy("a", "2030-01-06", "10", "1000"), snapshot("p", "2030-01-07", "10")];
    const book = onlyBook(computeLots(inputs, policy({ timeBasis: "settlement-date" })));
    expect(book.indeterminateFrom!.reasonCode).toBe("unknown_time");
  });
});

describe("holdings never go short and stale selections are never reassigned", () => {
  test("a disposal beyond the holding is negative_holding; later ones are upstream_indeterminate", () => {
    const book = onlyBook(
      computeLots(
        [
          buy("a", "2030-01-06", "5", "500"),
          sell("s1", "2030-01-07", "10", "1000"),
          buy("b", "2030-01-08", "10", "1000"),
          sell("s2", "2030-01-09", "1", "100"),
        ],
        policy(),
      ),
    );
    expect(book.indeterminateFrom).toEqual({ refs: [ref("s1")], reasonCode: "negative_holding" });
    expect(book.disposals.map((d) => [d.outcome, d.reasonCodes])).toEqual([
      ["indeterminate", ["negative_holding"]],
      ["indeterminate", ["upstream_indeterminate"]],
    ]);
    expect(book.remainingLots).toBeNull();
  });

  test("specific identification: missing, unknown, stale and mismatched selections", () => {
    const si = policy({ method: "specific-identification" });
    const pick = (lotId: string, quantity: string) => [{ lotId, quantity: q(ALPHA, quantity) }];
    const base = [buy("a", "2030-01-06", "10", "1000"), buy("b", "2030-01-07", "10", "1000")];
    const reason = (inputs: LotInput[]) => onlyBook(computeLots(inputs, si)).indeterminateFrom;
    expect(reason([...base, sell("s", "2030-01-08", "5", "1")])!.reasonCode).toBe(
      "lot_selection_missing",
    );
    expect(
      reason([...base, sell("s", "2030-01-08", "5", "1", { lotSelections: pick(ref("zz"), "5") })])!
        .reasonCode,
    ).toBe("unknown_lot");
    expect(
      reason([...base, sell("s", "2030-01-08", "5", "1", { lotSelections: pick(ref("a"), "4") })])!
        .reasonCode,
    ).toBe("lot_selection_mismatch");
    // The first sale consumes lot a; a second sale still naming a is stale, not moved to b.
    const stale = onlyBook(
      computeLots(
        [
          ...base,
          sell("s1", "2030-01-08", "10", "1", { lotSelections: pick(ref("a"), "10") }),
          sell("s2", "2030-01-09", "1", "1", { lotSelections: pick(ref("a"), "1") }),
        ],
        si,
      ),
    );
    expect(stale.disposals[0]!.outcome).toBe("allocated");
    expect(stale.indeterminateFrom).toEqual({
      refs: [ref("s2")],
      reasonCode: "lot_selection_mismatch",
    });
  });
});

describe("refs", () => {
  test("text forms are pinned", () => {
    expect(lotInputRefText({ source: "event", eventId: "evt-x", revision: 3 })).toBe(
      "event:evt-x@3",
    );
    expect(
      lotInputRefText({
        source: "observation",
        factKind: "position",
        observationId: 7,
        parseRunId: 2,
        jsonPath: "$.rows[0]",
      }),
    ).toBe("position:7@parse_run:2#$.rows[0]");
    expect(
      lotInputRefText({
        source: "observation",
        factKind: "transaction",
        observationId: 7,
        parseRunId: 2,
        jsonPath: null,
      }),
    ).toBe("transaction:7@parse_run:2");
  });

  test("the same ref twice in one book is duplicate_ref; on two instruments it is two legs", () => {
    const a = buy("a", "2030-01-06", "10", "1000");
    expect(computeLots([a, a], policy())).toMatchObject({
      status: "refused",
      reasonCode: "duplicate_ref",
      refs: [ref("a")],
    });
    const otherInstrument = {
      ...a,
      kind: "disposal" as const,
      instrumentRef: "instrument:test:beta",
      quantity: q("instrument:test:beta", "10"),
    };
    expect(computed(computeLots([a, otherInstrument], policy())).books).toHaveLength(2);
  });

  test("review finding 2: one ref in two books of the same instrument is duplicate_ref", () => {
    const a = buy("a", "2030-01-06", "10", "1000");
    for (const other of [
      { ...a, wrapperKey: "wrapper:test:other" },
      { ...a, holderRef: "account:test:b" },
    ])
      expect(computeLots([a, other], policy())).toMatchObject({
        status: "refused",
        reasonCode: "duplicate_ref",
        refs: [ref("a")],
      });
  });

  test("review finding 2: the two sides of one transfer still refuse only their books", () => {
    const out = input("t", { kind: "transfer" });
    const into = { ...out, holderRef: "account:test:b" };
    const result = computed(computeLots([out, into], policy()));
    expect(result.books.map((book) => book.status === "refused" && book.reasonCode)).toEqual([
      "transfer_contract_pending",
      "transfer_contract_pending",
    ]);
  });

  test("review finding 2: one observation under two parse runs is refused", () => {
    const observed = (parseRunId: number, date: string): LotInput => ({
      ...buy("o", date, "10", "1000"),
      ref: {
        source: "observation",
        factKind: "transaction",
        observationId: 7,
        parseRunId,
        jsonPath: "$.rows[0]",
      },
    });
    expect(
      computeLots([observed(1, "2030-01-06"), observed(2, "2030-01-07")], policy()),
    ).toMatchObject({
      status: "refused",
      reasonCode: "same_observation_parse_runs",
      refs: ["transaction:7@parse_run:1#$.rows[0]", "transaction:7@parse_run:2#$.rows[0]"],
    });
    const otherPath = {
      ...observed(2, "2030-01-07"),
      ref: { ...observed(2, "2030-01-07").ref, jsonPath: "$.rows[1]" },
    };
    expect(computeLots([observed(1, "2030-01-06"), otherPath as LotInput], policy()).status).toBe(
      "computed",
    );
  });

  test("two revisions of one event are same_event_revisions", () => {
    const result = computeLots(
      [buy("a", "2030-01-06", "10", "1000"), buy("a", "2030-01-06", "10", "1100", { revision: 2 })],
      policy(),
    );
    expect(result).toMatchObject({
      status: "refused",
      reasonCode: "same_event_revisions",
      refs: [ref("a", 1), ref("a", 2)],
    });
  });
});

describe("ordering: economic time only; anything it does not order is indeterminate", () => {
  test("FIFO buy and sell on the same date are an order tie, whatever their ids", () => {
    const book = onlyBook(
      computeLots(
        [buy("a", "2030-01-06", "10", "1000"), sell("s", "2030-01-06", "5", "600")],
        policy(),
      ),
    );
    expect(book.indeterminateFrom!.reasonCode).toBe("order_tie");
    expect(book.disposals[0]!.reasonCodes).toEqual(["order_tie"]);
  });

  test("FIFO buys on the same date are an order tie: which lot is older is unknown", () => {
    const book = onlyBook(
      computeLots(
        [buy("a", "2030-01-06", "10", "1000"), buy("b", "2030-01-06", "10", "1200")],
        policy(),
      ),
    );
    expect(book.indeterminateFrom!.reasonCode).toBe("order_tie");
  });

  test("moving average: same-date buys commute, same-date sells commute only without rounding", () => {
    const ma = policy({ method: "moving-average" });
    const buys = onlyBook(
      computeLots(
        [
          buy("a", "2030-01-06", "10", "1000"),
          buy("b", "2030-01-06", "10", "1200"),
          sell("s", "2030-01-07", "5", "600"),
        ],
        ma,
      ),
    );
    expect(buys.indeterminateFrom).toBeNull();
    expect(amountText(buys.disposals[0]!.allocations[0]!.cost)).toBe("550 JPY");
    const sells = [
      buy("a", "2030-01-06", "10", "1000"),
      sell("s1", "2030-01-07", "2", "300"),
      sell("s2", "2030-01-07", "3", "300"),
    ];
    expect(
      onlyBook(computeLots(sells, ma)).disposals.map((d) => amountText(d.allocations[0]!.cost)),
    ).toEqual(["200 JPY", "300 JPY"]);
    expect(
      onlyBook(computeLots(sells, { ...ma, rounding: yenLegRounding })).indeterminateFrom!
        .reasonCode,
    ).toBe("order_tie");
    const mixed = onlyBook(
      computeLots([buy("a", "2030-01-06", "10", "1000"), sell("s", "2030-01-06", "5", "600")], ma),
    );
    expect(mixed.indeterminateFrom!.reasonCode).toBe("order_tie");
  });

  test("an instant inside a dated day is within_day, reported as an order tie", () => {
    const instant: TemporalValue = {
      kind: "instant",
      value: "2030-01-06T10:00:00+09:00",
      zone: "Asia/Tokyo",
      basis: "provider",
    };
    const book = onlyBook(
      computeLots(
        [
          input("a", {
            kind: "acquisition",
            consideration: jpy("1000"),
            time: { trade: instant, settlement: instant },
          }),
          sell("s", "2030-01-06", "5", "600"),
        ],
        policy(),
      ),
    );
    expect(book.indeterminateFrom!.reasonCode).toBe("order_tie");
  });

  test("the time basis picks the time; an unknown time stops the whole book", () => {
    const inputs = [
      input("a", {
        kind: "acquisition",
        consideration: jpy("1000"),
        time: { trade: day("2030-01-06"), settlement: day("2030-01-08") },
      }),
      input("s", {
        kind: "disposal",
        quantity: "5",
        consideration: jpy("600"),
        time: {
          trade: day("2030-01-07"),
          settlement: { kind: "unknown", reasonCode: "not_stated" },
        },
      }),
    ];
    expect(onlyBook(computeLots(inputs, policy())).disposals[0]!.outcome).toBe("allocated");
    const settled = onlyBook(computeLots(inputs, policy({ timeBasis: "settlement-date" })));
    expect(settled.indeterminateFrom).toEqual({ refs: [ref("s")], reasonCode: "unknown_time" });
    expect(settled.disposals[0]!.reasonCodes).toEqual(["unknown_time"]);
    expect(settled.remainingLots).toBeNull();
  });
});

describe("gates", () => {
  test("no policy is policy_missing", () => {
    expect(computeLots([buy("a", "2030-01-06", "10", "1000")], null)).toMatchObject({
      status: "refused",
      reasonCode: "policy_missing",
    });
  });

  test("a tax purpose is refused through the unchanged costBasis gate", () => {
    const result = computeLots([buy("a", "2030-01-06", "10", "1000")], policy({ purpose: "tax" }));
    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.reasonCode).toBe("tax_rules_unverified");
    expect(result.refs).toContain("cost-basis:needs-policy:no_verified_rule_package");
    expect(result.refs).toContain("missing:jurisdiction");
  });

  test("a rounding policy other than leg-and-carry is refused rather than reinterpreted", () => {
    const result = computeLots([], policy({ rounding: { ...yenLegRounding, residual: "refuse" } }));
    expect(result).toMatchObject({
      status: "refused",
      reasonCode: "invalid_input",
      refs: ["policy"],
    });
  });

  test("an unsupported class or a transfer refuses only its own book", () => {
    const margin = buy("m", "2030-01-06", "10", "1000", {
      instrumentRef: "instrument:test:beta",
      instrumentClass: "margin-position",
    });
    const transfer = input("t", {
      kind: "transfer",
      instrumentRef: "instrument:test:gamma",
      consideration: null,
    });
    const result = computed(
      computeLots([buy("a", "2030-01-06", "10", "1000"), margin, transfer], policy()),
    );
    expect(
      result.books.map((book) => [
        book.instrumentRef,
        book.status === "refused" ? book.reasonCode : "computed",
      ]),
    ).toEqual([
      [ALPHA, "computed"],
      ["instrument:test:beta", "unsupported_instrument"],
      ["instrument:test:gamma", "transfer_contract_pending"],
    ]);
    expect(result.partition).toBe("partial-verified-scope");
  });

  test("the result has no gain and no tax conclusion anywhere", () => {
    const json = canonicalJson(computeLots(twoLotsThenPartialSale(), policy()));
    expect(json).not.toMatch(/gain|tax/iu);
  });
});

describe("determinism", () => {
  const mixed = [
    buy("a", "2030-01-06", "10", "1000", { fees: [jpy("7")] }),
    buy("b", "2030-01-07", "10", "1250"),
    sell("s1", "2030-01-08", "4", "700"),
    input("x", {
      kind: "split",
      date: "2030-01-09",
      quantity: "32",
      split: { numerator: "2", denominator: "1" },
    }),
    sell("s2", "2030-01-10", "9", "800"),
    buy("c", "2030-01-06", "3", "330", { wrapperKey: "wrapper:test:other" }),
    sell("s3", "2030-01-07", "1", "120", { wrapperKey: "wrapper:test:other" }),
  ];
  const orders = [mixed, [...mixed].reverse(), [...mixed.slice(3), ...mixed.slice(0, 3)]];

  test("the same inputs in any order give the same result and manifest digest", async () => {
    for (const method of ["fifo", "moving-average"] as const) {
      const p = policy({ method, rounding: yenLegRounding });
      const results = orders.map((inputs) => computeLots(inputs, p));
      const texts = results.map((result) => canonicalJson(result));
      expect(new Set(texts).size).toBe(1);
      const digests = await Promise.all(
        results.map((result) => canonicalDigest(computed(result).manifest)),
      );
      expect(new Set(digests).size).toBe(1);
      expect(computed(results[0]!).manifest.refs).toEqual([
        ref("a"),
        ref("b"),
        ref("c"),
        ref("s1"),
        ref("s2"),
        ref("s3"),
        ref("x"),
      ]);
    }
  });

  test("a different policy is a different manifest", async () => {
    const a = computed(computeLots(mixed, policy()));
    const b = computed(computeLots(mixed, policy({ acquisitionFee: "exclude" })));
    expect(await canonicalDigest(a.manifest)).not.toBe(await canonicalDigest(b.manifest));
  });
});

describe("validators reject unknown keys and broken shapes", () => {
  const good = buy("a", "2030-01-06", "10", "1000");

  test("input, ref, time and policy", () => {
    expect(validLotInput(good)).toBe(true);
    expect(validLotInput({ ...good, note: "x" })).toBe(false);
    expect(validLotInput({ ...good, contract: "lot-input-v1" })).toBe(false);
    expect(validLotInput({ ...good, holderRef: "holder:test:a" })).toBe(false);
    expect(validLotInput({ ...good, time: { ...good.time, recorded: day("2030-01-06") } })).toBe(
      false,
    );
    expect(validLotInputRef({ ...good.ref, extra: 1 })).toBe(false);
    expect(validLotInputRef({ source: "event", eventId: "evt@1", revision: 1 })).toBe(false);
    expect(validLotPolicy(policy())).toBe(true);
    expect(validLotPolicy({ ...policy(), extra: true })).toBe(false);
    expect(validLotPolicy({ ...policy(), ordering: "by-id" })).toBe(false);
    expect(validLotPolicy({ ...policy(), costUnitRef: "JPY" })).toBe(false);
    expect(validLotPolicy({ ...policy(), fx: "convert-at-input-rate" })).toBe(false);
    expect(validLotPolicy({ ...policy(), rounding: { ...yenLegRounding, extra: 1 } })).toBe(false);
  });

  test("computeLots refuses an input that breaks the contract", () => {
    const broken = { ...good, extra: true } as unknown as LotInput;
    expect(computeLots([broken], policy())).toMatchObject({
      status: "refused",
      reasonCode: "invalid_input",
      refs: [ref("a")],
    });
    const negative = buy("n", "2030-01-06", "-1", "1000");
    expect(computeLots([negative], policy())).toMatchObject({ reasonCode: "invalid_input" });
    const wrongUnit = { ...good, quantity: q("instrument:test:beta", "10") };
    expect(computeLots([wrongUnit], policy())).toMatchObject({ reasonCode: "invalid_input" });
  });
});

describe("review finding 1: grouping is closed over every member, instants laid out by epoch", () => {
  const ma = policy({ method: "moving-average" });
  const instant = (value: string, zone = "Asia/Tokyo"): TemporalValue => ({
    kind: "instant",
    value,
    zone,
    basis: "provider",
  });
  const at = (time: TemporalValue) => ({ time: { trade: time, settlement: time } });

  test("A: a dated acquisition is not ordered against a same-day disposal through its neighbour", () => {
    const book = onlyBook(
      computeLots(
        [
          buy("a", "2030-01-06", "10", "1000"),
          buy("b", "2030-01-06", "10", "2000", at(instant("2030-01-06T10:00:00+09:00"))),
          sell("d", "2030-01-06", "15", "3000", at(instant("2030-01-06T11:00:00+09:00"))),
        ],
        ma,
      ),
    );
    expect(book.indeterminateFrom!.reasonCode).toBe("order_tie");
    expect(book.disposals[0]!.outcome).toBe("indeterminate");
  });

  test("B: a period overlapping a later date ties every input it overlaps", () => {
    const period: TemporalValue = {
      kind: "period",
      start: "2030-01-01",
      end: "2030-01-10",
      endExclusive: false,
      zone: "Asia/Tokyo",
      granularity: "day",
    };
    const book = onlyBook(
      computeLots(
        [
          buy("p", "2030-01-01", "10", "1000", at(period)),
          buy("b", "2030-01-02", "10", "2000"),
          sell("d", "2030-01-05", "15", "3000"),
        ],
        ma,
      ),
    );
    expect(book.indeterminateFrom!.reasonCode).toBe("order_tie");
    expect(book.disposals[0]!.reasonCodes).toEqual(["order_tie"]);
  });

  test("C: instants with different offsets are laid out by absolute time", () => {
    const book = onlyBook(
      computeLots(
        [
          buy("x", "2030-01-02", "10", "1000", at(instant("2030-01-02T01:00:00+09:00"))),
          buy("y", "2030-01-01", "10", "2000", at(instant("2030-01-01T20:00:00Z", "UTC"))),
          sell("z", "2030-01-02", "15", "3000", at(instant("2030-01-02T04:00:00+09:00"))),
        ],
        ma,
      ),
    );
    // z (19:00Z) comes before y (20:00Z): only x is held when z disposes of 15.
    expect(book.indeterminateFrom).toEqual({ refs: [ref("z")], reasonCode: "negative_holding" });
  });
});

describe("review finding 3: a moving-average group's outcome does not depend on ref names", () => {
  const ma = policy({ method: "moving-average" });

  test("same-date acquisitions in two cost units stop the book whatever their names", () => {
    for (const names of [
      ["a", "b", "c"],
      ["z", "b", "c"],
    ]) {
      const [unknownCost, dollars, yen] = names as [string, string, string];
      const book = onlyBook(
        computeLots(
          [
            input(unknownCost, { kind: "acquisition", consideration: null }),
            input(dollars, { kind: "acquisition", consideration: usd("100") }),
            input(yen, { kind: "acquisition", consideration: jpy("100") }),
          ],
          ma,
        ),
      );
      expect(book.indeterminateFrom).toEqual({
        refs: names.map((name) => ref(name)).sort(),
        reasonCode: "unit_mismatch",
      });
    }
  });

  test("a cost unit is tracked even while the pool's cost is unknown", () => {
    const book = onlyBook(
      computeLots(
        [
          input("a", {
            kind: "acquisition",
            consideration: absentQuantity("USD", "missing", "not_stated"),
          }),
          buy("b", "2030-01-07", "10", "100"),
        ],
        ma,
      ),
    );
    expect(book.indeterminateFrom).toEqual({ refs: [ref("b")], reasonCode: "unit_mismatch" });
  });

  test("a failing same-date disposal group is reported as a whole", () => {
    for (const [first, second] of [
      ["s1", "s2"],
      ["s2", "s1"],
    ] as const) {
      const short = onlyBook(
        computeLots(
          [
            buy("a", "2030-01-06", "10", "1000"),
            sell(first, "2030-01-07", "6", "1"),
            sell(second, "2030-01-07", "6", "1"),
          ],
          ma,
        ),
      );
      expect(short.indeterminateFrom).toEqual({
        refs: [ref("s1"), ref("s2")],
        reasonCode: "negative_holding",
      });
      expect(short.disposals.map((d) => d.reasonCodes)).toEqual([
        ["negative_holding"],
        ["negative_holding"],
      ]);
      const inexact = onlyBook(
        computeLots(
          [
            buy("a", "2030-01-06", "3", "100"),
            sell(first, "2030-01-07", "1", "1"),
            sell(second, "2030-01-07", "1.5", "1"),
          ],
          ma,
        ),
      );
      expect(inexact.indeterminateFrom).toEqual({
        refs: [ref("s1"), ref("s2")],
        reasonCode: "inexact_allocation",
      });
    }
  });
});

describe("review finding 5: a rounded share never exceeds what is left nor flips its sign", () => {
  test("0.9 over 3 units rounded to whole yen is inexact_allocation, not a negative cost", () => {
    const book = onlyBook(
      computeLots(
        [
          buy("a", "2030-01-06", "3", "0.9"),
          sell("s1", "2030-01-07", "2", "1"),
          sell("s2", "2030-01-08", "1", "1"),
        ],
        policy({ rounding: yenLegRounding }),
      ),
    );
    expect(book.indeterminateFrom).toEqual({ refs: [ref("s1")], reasonCode: "inexact_allocation" });
    expect(book.disposals.map((d) => d.reasonCodes)).toEqual([
      ["inexact_allocation"],
      ["upstream_indeterminate"],
    ]);
  });

  test("a share rounded down to zero stays allowed: it is within the remaining amount", () => {
    const book = onlyBook(
      computeLots(
        [
          buy("a", "2030-01-06", "3", "0.9"),
          sell("s1", "2030-01-07", "1", "1"),
          sell("s2", "2030-01-08", "2", "1"),
        ],
        policy({ rounding: yenLegRounding }),
      ),
    );
    expect(book.disposals.map((d) => amountText(d.allocations[0]!.cost))).toEqual([
      "0 JPY",
      "0.9 JPY",
    ]);
  });
});
