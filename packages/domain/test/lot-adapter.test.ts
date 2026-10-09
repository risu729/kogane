// The C adapter (src/lot-adapter.ts, ADR 0059): selected revisions as lot
// inputs, the engine under an explicit policy, and the outer manifest.
// Acceptance tests B7 (an unknown order is held), B8 (a partial allocation
// keeps its basis), B9 (split and transfer lineage are refused today), B10 (a
// sale after a withdrawal is never filled with a short), B11 (a stale
// specific id is never reassigned), the C side of B3 (nothing counted twice:
// 101 = 100 + 1, one row claimed by two events), B12 and B13 (the manifest
// changes with history filled later and never with row order), every code the
// adapter gives, and what a selection from today's selector answers. The
// mapped path runs on hand-built selections (lot-selection-fixture.ts):
// no writer, kind or selector release admits a security quantity today.
// Every id, unit, amount and date is invented.
import { describe, expect, test } from "bun:test";
import { KNOWLEDGE_COVERAGE_REASONS, type AdoptedSelection } from "../src/knowledge-selector.ts";
import {
  adaptSelectionToLots,
  LOT_ADAPTER_CODES,
  LOT_ADAPTER_KINDS,
  LOT_ADAPTER_RELEASE,
  LOTS_ON_SELECTION_REASONS,
  lotsOnSelection,
  type LotAdapterCode,
  type LotAdapterRequest,
  type LotsOnSelection,
  type LotsOnSelectionStatus,
} from "../src/lot-adapter.ts";
import {
  LOT_ENGINE_VERSION,
  LOT_REASON_CODES,
  LOT_REFUSAL_CODES,
  type LotBook,
  type LotInput,
  type LotResult,
} from "../src/lots.ts";
import { COVERAGE_PRODUCER_NONE } from "../src/reconstruction-adapter.ts";
import { q, quantityText } from "./helpers.ts";
import {
  ALPHA,
  ALPHA_MAPPING,
  ALPHA_UNIT,
  BANK,
  BETA,
  BETA_UNIT,
  buy,
  day,
  HOLDER,
  OTHER,
  policy,
  request,
  rowKey,
  selection,
  sell,
  settle,
  trade,
  WRAPPER,
  type FixtureRevision,
  type SelectionFields,
} from "./lot-selection-fixture.ts";
import { A, Rows } from "./selector-fixture.ts";

async function run(
  specs: FixtureRevision[],
  req: LotAdapterRequest = request(),
  fields: SelectionFields = {},
): Promise<LotsOnSelection> {
  return runOn(await selection(specs, fields), req);
}

async function runOn(chosen: AdoptedSelection, req: LotAdapterRequest = request()) {
  const result = await lotsOnSelection(chosen, req);
  if (!result.ok) throw new Error(result.error.code);
  return result.result;
}

const entryOf = (result: LotsOnSelection, eventId: string, revision = 1) =>
  result.adaptation.entries.find((entry) => entry.ref === `event:${eventId}@${revision}`)!;
const inputOf = (result: LotsOnSelection, eventId: string, revision = 1): LotInput | undefined =>
  result.adaptation.inputs.find(
    (input) =>
      input.ref.source === "event" &&
      input.ref.eventId === eventId &&
      input.ref.revision === revision,
  );
type Computed = Extract<LotResult, { status: "computed" }>;
type ComputedBook = Extract<LotBook, { status: "computed" }>;
const computed = (result: LotsOnSelection): Computed => {
  if (result.lots.status !== "computed") throw new Error(result.lots.reasonCode);
  return result.lots;
};
const bookOf = (result: LotsOnSelection, instrumentRef = ALPHA): ComputedBook => {
  const book = computed(result).books.find((entry) => entry.instrumentRef === instrumentRef);
  if (book?.status !== "computed") throw new Error("book not computed");
  return book;
};
const amountText = (
  amount: {
    status: string;
    amount?: Parameters<typeof quantityText>[0];
    reasonCode?: string;
  } | null,
) =>
  amount === null
    ? null
    : amount.status === "known"
      ? quantityText(amount.amount!)
      : `unknown:${amount.reasonCode}`;

describe("what it answers today", () => {
  test("a selection with no security-quantity claim is unsupported, and the manifest is still produced", async () => {
    const result = await run([
      {
        eventId: "ev-settle",
        kind: "card_settlement",
        state: "debited",
        legs: [{ amount: "1000", role: "decrease", effect: "movement" }],
        claims: [{ row: "bank-1", book: "cash-movement" }],
      },
    ]);
    expect(result.status).toBe("unsupported");
    expect(result.reasons).toEqual(["security_quantity_writer_missing"]);
    expect(result.adaptation).toMatchObject({
      securityClaims: 0,
      otherRevisions: 1,
      entries: [],
      books: [],
      inputs: [],
    });
    expect(computed(result).books).toEqual([]);
    expect(result.manifest.lotsManifestDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.contextId).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("today's selector reports a security-quantity claim as a book no writer admits: unsupported", async () => {
    const rows = new Rows().add({
      eventId: "ev-sec",
      seq: 1,
      times: [["trade", day("2030-01-06")]],
      legs: [
        {
          subject: `account:${A}`,
          unit: ALPHA_UNIT,
          amount: "10",
          role: "increase",
          effect: "movement",
        },
      ],
      claims: [{ key: rowKey("sec-1"), book: "security-quantity" }],
    });
    const chosen = await rows.select(1);
    expect(chosen.unsupported).toContainEqual({
      eventId: "ev-sec",
      revision: 1,
      reasonCode: "book_unsupported",
    });
    const result = await runOn(
      chosen,
      request({ holders: [{ accountId: A, wrapperKey: WRAPPER }] }),
    );
    expect(result.status).toBe("unsupported");
    expect(entryOf(result, "ev-sec")).toMatchObject({
      outcome: "held",
      codes: ["security_quantity_writer_missing", "writer_unsupported"],
    });
    expect(result.reasons[0]).toBe("security_quantity_writer_missing");
    expect(result.adaptation.inputs).toEqual([]);
  });

  test("a reserved trade kind through today's selector is unreadable there, so never mapped", async () => {
    const rows = new Rows().add({
      eventId: "ev-trade",
      kind: "trade" as never,
      state: "executed",
      seq: 1,
      legs: [
        {
          subject: `account:${A}`,
          unit: ALPHA_UNIT,
          amount: "10",
          role: "increase",
          effect: "movement",
        },
      ],
      claims: [{ key: rowKey("sec-2"), book: "security-quantity" }],
    });
    const chosen = await rows.select(1);
    expect(chosen.revisions[0]!.kind).toBe("unknown");
    const result = await runOn(
      chosen,
      request({ holders: [{ accountId: A, wrapperKey: WRAPPER }] }),
    );
    expect(entryOf(result, "ev-trade").outcome).toBe("held");
    expect(result.status).toBe("unsupported");
  });

  test("the kinds read are a closed list naming the reserved trade kind", () => {
    expect(LOT_ADAPTER_KINDS).toEqual(["trade", "transfer", "corporate_action"]);
  });
});

describe("typed effects (B3, the C side: nothing counted twice)", () => {
  test("101 out = 100 principal + 1 fee is one acquisition of consideration 100 and fee 1", async () => {
    const result = await run([buy("acq", "2030-01-06", "10", "101", { fee: "1" })]);
    const input = inputOf(result, "acq")!;
    expect(input.kind).toBe("acquisition");
    expect(quantityText(input.consideration)).toBe("100");
    expect(input.fees.map(quantityText)).toEqual(["1"]);
    expect(input.quantity).toEqual(q(ALPHA, "10"));
    expect(result.adaptation.inputs).toHaveLength(1);
    const lot = bookOf(result).remainingLots![0]!;
    expect(amountText(lot.cost)).toBe("101");
    expect(result.status).toBe("complete");
    expect(result.reasons).toEqual([]);
  });

  test("100 in with a 1 fee deducted is one disposal of gross 101: the fee is never added twice", async () => {
    const specs = [
      buy("acq", "2030-01-06", "10", "1000"),
      sell("dis", "2030-01-08", "10", "100", { fee: "1" }),
    ];
    const net = await run(specs);
    const input = inputOf(net, "dis")!;
    expect(input.kind).toBe("disposal");
    expect(quantityText(input.consideration)).toBe("101");
    expect(input.fees.map(quantityText)).toEqual(["1"]);
    expect(net.adaptation.inputs).toHaveLength(2);
    const disposal = bookOf(net).disposals[0]!;
    expect(amountText(disposal.proceeds)).toBe("100");
    expect(disposal.outcome).toBe("allocated");
    const gross = await run(specs, request({ policy: policy({ disposalFee: "separate" }) }));
    const separate = bookOf(gross).disposals[0]!;
    expect(amountText(separate.proceeds)).toBe("101");
    expect(amountText(separate.disposalFees)).toBe("1");
  });

  test("a stated consideration and fee (correspondences of the security movement) are read as stated", async () => {
    const result = await run([
      {
        eventId: "acq",
        times: [trade("2030-01-06"), settle("2030-01-08")],
        legs: [
          { unit: ALPHA_UNIT, amount: "10", role: "increase", effect: "movement" },
          { account: BANK, amount: "1000", role: "decrease", effect: "correspondence", of: 0 },
          { account: BANK, amount: "5", role: "fee", effect: "correspondence", of: 0 },
        ],
        claims: [{ row: "row-acq" }],
      },
    ]);
    const input = inputOf(result, "acq")!;
    expect(quantityText(input.consideration)).toBe("1000");
    expect(input.fees.map(quantityText)).toEqual(["5"]);
    expect(input.time).toEqual({ trade: day("2030-01-06"), settlement: day("2030-01-08") });
  });

  test("one row claimed by two events never yields two inputs, flagged by the selector or not", async () => {
    const twice = (flags: boolean) => [
      buy("acq-1", "2030-01-06", "10", "1000", {
        claims: [{ row: "same-row" }],
        flags: flags ? ["claim_conflict"] : [],
      }),
      buy("acq-2", "2030-01-07", "10", "1000", {
        claims: [{ row: "same-row" }],
        flags: flags ? ["claim_conflict"] : [],
      }),
    ];
    for (const flags of [true, false]) {
      const result = await run(twice(flags));
      expect(result.adaptation.inputs).toEqual([]);
      expect(entryOf(result, "acq-1").codes).toEqual(["claim_conflict"]);
      expect(entryOf(result, "acq-2").codes).toEqual(["claim_conflict"]);
      expect(result.adaptation.books).toEqual([
        {
          holderRef: `account:${HOLDER}`,
          instrumentRef: ALPHA,
          wrapperKey: WRAPPER,
          status: "needs_review",
          codes: ["claim_conflict"],
          refs: ["event:acq-1@1", "event:acq-2@1"],
        },
      ]);
      expect(result.status).toBe("needs_review");
    }
  });

  test("one alias class under two events holds the book (alias_conflict)", async () => {
    const alias = JSON.stringify(["synthetic-broker", ["exec-1"], HOLDER, "synthetic-alias-v1"]);
    const result = await run([
      buy("acq-1", "2030-01-06", "10", "1000", { claims: [{ row: "row-a", alias }] }),
      buy("acq-2", "2030-01-07", "10", "1000", { claims: [{ row: "row-b", alias }] }),
    ]);
    expect(entryOf(result, "acq-1").codes).toEqual(["alias_conflict"]);
    expect(result.adaptation.inputs).toEqual([]);
    expect(result.adaptation.aliasRuleVersions).toEqual(["synthetic-alias-v1"]);
    expect(result.manifest.aliasRuleVersions).toEqual(["synthetic-alias-v1"]);
  });
});

describe("times: trade and settlement roles as stored, no fallback", () => {
  test("a missing trade role is unknown on that basis, never the settlement or another role", async () => {
    const spec = buy("acq", "2030-01-06", "10", "1000", {
      times: [settle("2030-01-08"), ["posting", day("2030-01-06")], ["value", day("2030-01-06")]],
    });
    const result = await run([spec]);
    const entry = entryOf(result, "acq");
    expect(entry).toMatchObject({
      outcome: "mapped",
      codes: ["time_role_missing"],
      missingTimeRoles: ["trade"],
    });
    expect(inputOf(result, "acq")!.time).toEqual({
      trade: { kind: "unknown", reasonCode: "time_role_missing" },
      settlement: day("2030-01-08"),
    });
    // B7: on the trade-date basis the book is held by the engine.
    expect(bookOf(result).indeterminateFrom).toEqual({
      refs: ["event:acq@1"],
      reasonCode: "unknown_time",
    });
    expect(result.status).toBe("indeterminate");
    expect(result.reasons).toEqual(["unknown_time", "time_role_missing"]);
    // On the settlement-date basis the stated settlement time places it.
    const settled = await run(
      [spec],
      request({ policy: policy({ timeBasis: "settlement-date" }) }),
    );
    expect(bookOf(settled).indeterminateFrom).toBeNull();
    expect(settled.status).toBe("limited");
  });

  test("posting and value roles alone leave both bases unknown", async () => {
    const result = await run([
      buy("acq", "2030-01-06", "10", "1000", { times: [["posting", day("2030-01-06")]] }),
    ]);
    expect(entryOf(result, "acq").missingTimeRoles).toEqual(["trade", "settlement"]);
  });
});

describe("B7: a lot that depends on an unknown order is held", () => {
  test("a buy and a sale on one trade date under FIFO are an order tie", async () => {
    const result = await run([
      buy("acq-1", "2030-01-05", "10", "1000"),
      buy("acq-2", "2030-01-06", "10", "1200"),
      sell("dis", "2030-01-06", "5", "700"),
    ]);
    const book = bookOf(result);
    expect(book.indeterminateFrom).toEqual({
      refs: ["event:acq-2@1", "event:dis@1"],
      reasonCode: "order_tie",
    });
    expect(book.remainingLots).toBeNull();
    expect(book.disposals[0]!.outcome).toBe("indeterminate");
    expect(result.status).toBe("indeterminate");
    expect(result.reasons).toContain("order_tie");
  });
});

describe("B8: a partial allocation keeps its basis", () => {
  test("selling 4 of 10 takes 4/10 of the cost; what is left keeps the rest and its acquisition time", async () => {
    for (const timeBasis of ["trade-date", "settlement-date"] as const) {
      const result = await run(
        [
          buy("acq", "2030-01-06", "10", "1000", {
            times: [trade("2030-01-06"), settle("2030-01-08")],
          }),
          sell("dis", "2030-01-10", "4", "480", {
            times: [trade("2030-01-10"), settle("2030-01-14")],
          }),
        ],
        request({ policy: policy({ timeBasis }) }),
      );
      const book = bookOf(result);
      const disposal = book.disposals[0]!;
      expect(disposal.time).toEqual(
        timeBasis === "trade-date" ? day("2030-01-10") : day("2030-01-14"),
      );
      expect(disposal.allocations).toHaveLength(1);
      expect(amountText(disposal.allocations[0]!.cost)).toBe("400");
      expect(quantityText(disposal.allocatedCost)).toBe("400");
      const lot = book.remainingLots![0]!;
      expect(lot.lotId).toBe("event:acq@1");
      expect(lot.acquiredAt).toEqual(
        timeBasis === "trade-date" ? day("2030-01-06") : day("2030-01-08"),
      );
      expect(quantityText(lot.remainingQuantity)).toBe("6");
      expect(amountText(lot.remainingCost)).toBe("600");
      expect(lot.lineage).toMatchObject({ originRef: "event:acq@1", fragmentOf: null, splits: [] });
      expect(result.status).toBe("complete");
    }
  });
});

describe("B9: split and transfer lineage are refused today", () => {
  test("an explicit corporate-action revision is corporate_action_unsupported and holds its book", async () => {
    const result = await run([
      buy("acq", "2030-01-06", "10", "1000"),
      {
        eventId: "split",
        kind: "corporate_action",
        times: [trade("2030-01-07")],
        legs: [{ unit: ALPHA_UNIT, amount: "10", role: "increase", effect: "movement" }],
        claims: [{ row: "ca-1" }],
      },
    ]);
    expect(entryOf(result, "split")).toMatchObject({
      outcome: "held",
      codes: ["corporate_action_unsupported"],
    });
    expect(result.adaptation.books[0]).toMatchObject({
      status: "unsupported",
      codes: ["corporate_action_unsupported"],
    });
    expect(result.adaptation.inputs).toEqual([]);
    expect(result.status).toBe("unsupported");
    expect(result.reasons).toEqual(["corporate_action_unsupported"]);
  });

  test("a transfer moving a security quantity stays transfer_contract_pending", async () => {
    const result = await run([
      buy("acq", "2030-01-06", "10", "1000"),
      {
        eventId: "xfer",
        kind: "transfer",
        state: "credited",
        times: [trade("2030-01-07")],
        legs: [
          { unit: ALPHA_UNIT, amount: "10", role: "decrease", effect: "movement" },
          { unit: ALPHA_UNIT, account: OTHER, amount: "10", role: "increase", effect: "movement" },
        ],
        claims: [{ row: "xfer-1" }],
      },
    ]);
    expect(entryOf(result, "xfer").codes).toEqual(["transfer_contract_pending"]);
    expect(result.adaptation.books).toHaveLength(1);
    expect(result.adaptation.books[0]!.status).toBe("unsupported");
    expect(result.adaptation.inputs).toEqual([]);
    expect(result.reasons).toEqual(["transfer_contract_pending"]);
  });
});

describe("B10: a sale after a withdrawal is never filled with a short", () => {
  test("the withdrawn acquisition moves nothing; the sale is a negative holding, not an allocation", async () => {
    const before = await run([
      buy("acq", "2030-01-06", "10", "1000", { seq: 1 }),
      sell("dis", "2030-01-08", "4", "480", { seq: 2 }),
    ]);
    expect(bookOf(before).disposals[0]!.outcome).toBe("allocated");
    const after = await run([
      { eventId: "acq", revision: 2, state: "unknown", seq: 3, legs: [], claims: [], times: [] },
      sell("dis", "2030-01-08", "4", "480", { seq: 2 }),
    ]);
    expect(entryOf(after, "acq", 2)).toMatchObject({
      outcome: "no_movement",
      codes: [],
      books: [],
    });
    const book = bookOf(after);
    expect(book.indeterminateFrom).toEqual({
      refs: ["event:dis@1"],
      reasonCode: "negative_holding",
    });
    expect(book.disposals[0]).toMatchObject({
      outcome: "indeterminate",
      allocations: [],
      allocatedCost: null,
    });
    expect(after.status).toBe("indeterminate");
    // A withdrawal the log does not place is held for that reason alone.
    const unlogged = await run([
      { eventId: "acq", revision: 2, state: "unknown", seq: null, legs: [], claims: [], times: [] },
      sell("dis", "2030-01-08", "4", "480", { seq: 2 }),
    ]);
    expect(entryOf(unlogged, "acq", 2)).toMatchObject({
      outcome: "held",
      codes: ["knowledge_unlogged"],
    });
    expect(unlogged.status).toBe("indeterminate");
  });
});

describe("B11: a stale specific id is never reassigned", () => {
  const specific = policy({ method: "specific-identification" });
  test("a choice naming a corrected acquisition's old revision is unknown_lot, not the new lot", async () => {
    const result = await run(
      [
        buy("acq", "2030-01-06", "10", "1000", { revision: 2, seq: 2 }),
        sell("dis", "2030-01-08", "4", "480", { seq: 3 }),
      ],
      request({
        policy: specific,
        lotSelections: [
          {
            disposalRef: "event:dis@1",
            selections: [{ lotId: "event:acq@1", quantity: q(ALPHA, "4") }],
          },
        ],
      }),
    );
    const book = bookOf(result);
    expect(book.indeterminateFrom).toEqual({ refs: ["event:dis@1"], reasonCode: "unknown_lot" });
    expect(book.disposals[0]!.allocations).toEqual([]);
    expect(result.status).toBe("indeterminate");
  });

  test("a choice for a disposal revision no longer in force is unused, and the disposal has none", async () => {
    const result = await run(
      [
        buy("acq", "2030-01-06", "10", "1000"),
        sell("dis", "2030-01-08", "4", "480", { revision: 2 }),
      ],
      request({
        policy: specific,
        lotSelections: [
          {
            disposalRef: "event:dis@1",
            selections: [{ lotId: "event:acq@1", quantity: q(ALPHA, "4") }],
          },
        ],
      }),
    );
    expect(result.adaptation.unusedLotSelections).toEqual(["event:dis@1"]);
    expect(bookOf(result).indeterminateFrom!.reasonCode).toBe("lot_selection_missing");
    expect(result.reasons).toEqual(
      expect.arrayContaining(["lot_selection_missing", "lot_selection_unused"]),
    );
  });

  test("a current choice is applied as given", async () => {
    const result = await run(
      [buy("acq", "2030-01-06", "10", "1000"), sell("dis", "2030-01-08", "4", "480")],
      request({
        policy: specific,
        lotSelections: [
          {
            disposalRef: "event:dis@1",
            selections: [{ lotId: "event:acq@1", quantity: q(ALPHA, "4") }],
          },
        ],
      }),
    );
    expect(bookOf(result).disposals[0]!.outcome).toBe("allocated");
    expect(result.adaptation.unusedLotSelections).toEqual([]);
  });
});

describe("B12 and B13: the manifest", () => {
  test("B12: history filled later gives a new cut, set version and result; the earlier cut's stays", async () => {
    const sale = sell("dis", "2030-01-08", "4", "480", { seq: 1 });
    const early = await run([sale]);
    expect(bookOf(early).indeterminateFrom!.reasonCode).toBe("negative_holding");
    const filled = [sale, buy("acq", "2030-01-06", "10", "1000", { seq: 2 })];
    const late = await run(filled);
    expect(bookOf(late).disposals[0]!.outcome).toBe("allocated");
    expect(late.manifest.cut.resolved.commitSeq).toBe(2);
    expect(late.manifest.setVersion).not.toBe(early.manifest.setVersion);
    expect(late.manifest.lotsManifestDigest).not.toBe(early.manifest.lotsManifestDigest);
    expect(late.contextId).not.toBe(early.contextId);
    // The later commit is invisible at cut 1: the same answer and the same manifest.
    const again = await run([sale], request(), { cut: 1 });
    expect(again.contextId).toBe(early.contextId);
    expect(again.lots).toEqual(early.lots);
  });

  test("B12 through today's selector: a later commit leaves the earlier cut's manifest unchanged", async () => {
    const rows = new Rows().add({
      eventId: "ev-1",
      seq: 1,
      legs: [{ amount: "1000", role: "decrease" }],
      claims: [{ key: rowKey("bank-1") }],
    });
    const req = request({ holders: [{ accountId: A, wrapperKey: WRAPPER }] });
    const first = await runOn(await rows.select(1), req);
    rows.add({
      eventId: "ev-2",
      seq: 2,
      legs: [{ amount: "500", role: "decrease" }],
      claims: [{ key: rowKey("bank-2") }],
    });
    const atOne = await runOn(await rows.select(1), req);
    const atTwo = await runOn(await rows.select(2), req);
    expect(atOne.contextId).toBe(first.contextId);
    expect(atTwo.contextId).not.toBe(first.contextId);
    expect(atTwo.status).toBe("unsupported");
  });

  test("B13: any order of the revisions, holders and mappings gives the same answer and manifest", async () => {
    const specs = [
      buy("acq-1", "2030-01-05", "10", "1000", { seq: 1 }),
      buy("acq-2", "2030-01-06", "10", "1200", { fee: "3", seq: 2 }),
      sell("dis", "2030-01-09", "15", "2000", { fee: "2", seq: 3 }),
      buy("beta", "2030-01-06", "1", "50", {
        seq: 4,
        legs: [
          { unit: BETA_UNIT, amount: "1", role: "increase", effect: "movement" },
          { account: BANK, amount: "50", role: "decrease", effect: "movement" },
        ],
      }),
    ];
    const beta = {
      ...ALPHA_MAPPING,
      unitRef: BETA_UNIT,
      instrumentRef: BETA,
      instrumentClass: "fund-unit" as const,
    };
    const holders = [
      { accountId: HOLDER, wrapperKey: WRAPPER },
      { accountId: OTHER, wrapperKey: "wrapper:test:other" },
    ];
    const one = await run(specs, request({ holders, instruments: [ALPHA_MAPPING, beta] }));
    const two = await run(
      [...specs].reverse(),
      request({ holders: [...holders].reverse(), instruments: [beta, ALPHA_MAPPING] }),
    );
    expect(two.contextId).toBe(one.contextId);
    expect(two.manifest).toEqual(one.manifest);
    expect(two.lots).toEqual(one.lots);
    expect(two.adaptation).toEqual(one.adaptation);
    expect(one.status).toBe("complete");
  });
});

describe("every code the adapter gives", () => {
  const held = async (
    spec: FixtureRevision,
    req: LotAdapterRequest = request(),
    fields: SelectionFields = {},
  ) => {
    const result = await run([spec], req, fields);
    const entry = entryOf(result, spec.eventId, spec.revision ?? 1);
    expect(result.adaptation.inputs).toEqual([]);
    return { result, entry };
  };

  test("writer_unsupported: shapes the adapter cannot place", async () => {
    const shapes: FixtureRevision[] = [
      buy("kind", "2030-01-06", "10", "1000", { kind: "purchase", state: "captured" }),
      buy("state", "2030-01-06", "10", "1000", { state: "canceled" }),
      buy("no-claim", "2030-01-06", "10", "1000", { claims: [] }),
      buy("two-moves", "2030-01-06", "10", "1000", {
        legs: [
          { unit: ALPHA_UNIT, amount: "10", role: "increase", effect: "movement" },
          { unit: ALPHA_UNIT, amount: "1", role: "increase", effect: "movement" },
          { account: BANK, amount: "1000", role: "decrease", effect: "movement" },
        ],
      }),
      buy("fee-in-kind", "2030-01-06", "10", "1000", {
        legs: [
          { unit: ALPHA_UNIT, amount: "10", role: "increase", effect: "movement" },
          { unit: ALPHA_UNIT, amount: "1", role: "fee", effect: "breakdown", of: 0 },
          { account: BANK, amount: "1000", role: "decrease", effect: "movement" },
        ],
      }),
      buy("legacy-fee", "2030-01-06", "10", "1000", {
        legs: [
          { unit: ALPHA_UNIT, amount: "10", role: "increase", effect: "movement" },
          { account: BANK, amount: "1000", role: "decrease", effect: "movement" },
          { account: BANK, amount: "1", role: "fee" },
        ],
      }),
      buy("direction", "2030-01-06", "10", "1000", {
        legs: [
          { unit: ALPHA_UNIT, amount: "10", role: "increase", effect: "movement" },
          { account: BANK, amount: "1000", role: "increase", effect: "movement" },
        ],
      }),
      buy("two-cash", "2030-01-06", "10", "1000", {
        legs: [
          { unit: ALPHA_UNIT, amount: "10", role: "increase", effect: "movement" },
          { account: BANK, amount: "600", role: "decrease", effect: "movement" },
          { account: BANK, amount: "400", role: "decrease", effect: "movement" },
        ],
      }),
      buy("zero", "2030-01-06", "0", "1000"),
      buy("fee-over", "2030-01-06", "10", "1", { fee: "2" }),
      buy("ev 1", "2030-01-06", "10", "1000"),
    ];
    for (const spec of shapes) {
      const { entry } = await held(spec);
      expect({ id: spec.eventId, codes: entry.codes, outcome: entry.outcome }).toEqual({
        id: spec.eventId,
        codes: ["writer_unsupported"],
        outcome: "held",
      });
    }
  });

  test("writer_unsupported: a shape the selector could not read", async () => {
    const { entry, result } = await held(
      buy("acq", "2030-01-06", "10", "1000", { flags: ["unsupported"] }),
      request(),
      {
        unsupported: [{ eventId: "acq", revision: 1, reasonCode: "time_unreadable" }],
      },
    );
    expect(entry.codes).toEqual(["writer_unsupported"]);
    expect(result.status).toBe("needs_review");
  });

  test("instrument_unresolved: no mapping, an unresolved or aggregate mapping, no class, a pin that differs or is missing", async () => {
    const unmapped = await held(
      buy("acq", "2030-01-06", "10", "1000", {
        legs: [
          { unit: "ii-test-unmapped", amount: "10", role: "increase", effect: "movement" },
          { account: BANK, amount: "1000", role: "decrease", effect: "movement" },
        ],
      }),
    );
    expect(unmapped.entry).toMatchObject({ codes: ["instrument_unresolved"], books: [] });
    // Placed in no book: the run needs review while nothing is fed.
    expect(unmapped.result.status).toBe("needs_review");
    for (const mapping of [
      { ...ALPHA_MAPPING, status: "unresolved" as const },
      { ...ALPHA_MAPPING, status: "aggregate" as const },
      { ...ALPHA_MAPPING, instrumentClass: null },
      { ...ALPHA_MAPPING, mappingRevision: 2 },
    ]) {
      const { entry, result } = await held(
        buy("acq", "2030-01-06", "10", "1000"),
        request({ instruments: [mapping] }),
      );
      expect(entry.codes).toEqual(["instrument_unresolved"]);
      expect(result.adaptation.books[0]!.status).toBe("needs_review");
    }
    const unpinned = await held(buy("acq", "2030-01-06", "10", "1000", { pins: {} }));
    expect(unpinned.entry.codes).toEqual(["instrument_unresolved"]);
    const provider = await run(
      [buy("acq", "2030-01-06", "10", "1000")],
      request({ instruments: [{ ...ALPHA_MAPPING, status: "provider-local" }] }),
    );
    expect(entryOf(provider, "acq").outcome).toBe("mapped");
  });

  test("instrument_unresolved: two classes for one instrument hold its book", async () => {
    const twin = { ...ALPHA_MAPPING, unitRef: BETA_UNIT, instrumentClass: "fund-unit" as const };
    const result = await run(
      [
        buy("acq-1", "2030-01-06", "10", "1000"),
        buy("acq-2", "2030-01-07", "1", "100", {
          legs: [
            { unit: BETA_UNIT, amount: "1", role: "increase", effect: "movement" },
            { account: BANK, amount: "100", role: "decrease", effect: "movement" },
          ],
        }),
      ],
      request({ instruments: [ALPHA_MAPPING, twin] }),
    );
    expect(result.adaptation.books).toMatchObject([
      { status: "needs_review", codes: ["instrument_unresolved"] },
    ]);
    expect(result.adaptation.inputs).toEqual([]);
  });

  test("holder_unresolved: a security leg on an account the request names no wrapper for, or on no account", async () => {
    for (const account of [OTHER, null]) {
      const { entry } = await held(
        buy("acq", "2030-01-06", "10", "1000", {
          legs: [
            { unit: ALPHA_UNIT, account, amount: "10", role: "increase", effect: "movement" },
            { account: BANK, amount: "1000", role: "decrease", effect: "movement" },
          ],
        }),
      );
      expect(entry).toMatchObject({ codes: ["holder_unresolved"], books: [] });
    }
  });

  test("consideration_missing and fee_unknown: kept unknown by the engine, never zero", async () => {
    const absentCash = await run([
      buy("acq", "2030-01-06", "10", "1000", {
        legs: [
          { unit: ALPHA_UNIT, amount: "10", role: "increase", effect: "movement" },
          { account: BANK, amount: null, role: "decrease", effect: "movement" },
        ],
      }),
    ]);
    expect(entryOf(absentCash, "acq")).toMatchObject({
      outcome: "mapped",
      codes: ["consideration_missing"],
    });
    expect(inputOf(absentCash, "acq")!.consideration).toBeNull();
    expect(amountText(bookOf(absentCash).remainingLots![0]!.cost)).toBe(
      "unknown:consideration_missing",
    );
    expect(absentCash.status).toBe("limited");
    expect(absentCash.reasons).toEqual(["consideration_missing", "unknown_cost"]);

    const absentFee = await run([
      buy("acq", "2030-01-06", "10", "1000", {
        legs: [
          { unit: ALPHA_UNIT, amount: "10", role: "increase", effect: "movement" },
          { account: BANK, amount: "1001", role: "decrease", effect: "movement" },
          { account: BANK, amount: null, role: "fee", effect: "breakdown", of: 1 },
        ],
      }),
    ]);
    expect(entryOf(absentFee, "acq").codes).toEqual(["consideration_missing", "fee_unknown"]);
    expect(inputOf(absentFee, "acq")!.fees[0]!.value.status).toBe("missing");

    const noCash = await run([
      buy("acq", "2030-01-06", "10", "1000", {
        legs: [{ unit: ALPHA_UNIT, amount: "10", role: "increase", effect: "movement" }],
      }),
    ]);
    expect(entryOf(noCash, "acq").codes).toEqual(["consideration_missing", "fee_unknown"]);
    const lot = bookOf(noCash).remainingLots![0]!;
    expect(amountText(lot.cost)).toBe("unknown:consideration_missing");
  });

  test("fx_rate_missing: amounts outside the cost unit are kept unknown, no rate is invented", async () => {
    const result = await run(
      [
        buy("acq", "2030-01-06", "10", "1000"),
        sell("dis", "2030-01-08", "4", "5", {
          legs: [
            { unit: ALPHA_UNIT, amount: "4", role: "decrease", effect: "movement" },
            { account: BANK, unit: "USD", amount: "5", role: "increase", effect: "movement" },
          ],
        }),
      ],
      request({ policy: policy({ fx: "convert-at-input-rate", costUnitRef: "JPY" }) }),
    );
    expect(entryOf(result, "dis").codes).toEqual(["fx_rate_missing"]);
    expect(inputOf(result, "dis")!.fx).toBeNull();
    const disposal = bookOf(result).disposals[0]!;
    expect(disposal.outcome).toBe("limited");
    expect(disposal.reasonCodes).toContain("fx_rate_missing");
    expect(result.status).toBe("limited");
    expect(result.manifest.fx).toEqual({ policyRef: "fx-policy:test@1", rateRefs: [] });
  });

  test("dispositions hold the touched book and none of its inputs reaches the engine", async () => {
    const cases: [Partial<FixtureRevision>, LotAdapterCode, LotsOnSelectionStatus][] = [
      [{ flags: ["identity_changed"] }, "identity_changed", "needs_review"],
      [{ status: "chain_inconsistent" }, "revision_chain_inconsistent", "needs_review"],
      [{ seq: null }, "knowledge_unlogged", "indeterminate"],
    ];
    for (const [fields, code, status] of cases) {
      const result = await run(
        [
          buy("acq-1", "2030-01-05", "10", "1000"),
          buy("acq-2", "2030-01-06", "10", "1000", fields),
          buy("beta", "2030-01-06", "1", "50", {
            legs: [
              { unit: BETA_UNIT, amount: "1", role: "increase", effect: "movement" },
              { account: BANK, amount: "50", role: "decrease", effect: "movement" },
            ],
          }),
        ],
        request({
          instruments: [
            ALPHA_MAPPING,
            { ...ALPHA_MAPPING, unitRef: BETA_UNIT, instrumentRef: BETA },
          ],
        }),
      );
      expect(entryOf(result, "acq-2").codes).toEqual([code]);
      expect(result.adaptation.books.map((book) => [book.instrumentRef, book.status])).toEqual([
        [ALPHA, status],
        [BETA, "fed"],
      ]);
      expect(result.adaptation.inputs.map((input) => input.instrumentRef)).toEqual([BETA]);
      expect(result.status).toBe(status);
      expect(result.reasons).toContain(code);
    }
  });

  test("every code an entry or a run carries is in the closed lists", async () => {
    expect(LOTS_ON_SELECTION_REASONS).toEqual(expect.arrayContaining([...LOT_ADAPTER_CODES]));
    expect(LOTS_ON_SELECTION_REASONS).toEqual(expect.arrayContaining([...LOT_REFUSAL_CODES]));
    expect(LOTS_ON_SELECTION_REASONS).toEqual(expect.arrayContaining([...LOT_REASON_CODES]));
    expect(LOTS_ON_SELECTION_REASONS).toEqual(
      expect.arrayContaining([...KNOWLEDGE_COVERAGE_REASONS]),
    );
    expect(new Set(LOTS_ON_SELECTION_REASONS).size).toBe(LOTS_ON_SELECTION_REASONS.length);
  });
});

describe("the engine's gates and the manifest pins", () => {
  test("the engine's whole-run refusals pass through; the manifest has no lots digest", async () => {
    const specs = [buy("acq", "2030-01-06", "10", "1000")];
    const none = await run(specs, request({ policy: null }));
    expect(none).toMatchObject({ status: "refused", reasons: ["policy_missing"] });
    expect(none.manifest.lotsManifestDigest).toBeNull();
    expect(none.manifest.policyRef).toBeNull();
    const tax = await run(specs, request({ policy: policy({ purpose: "tax" }) }));
    expect(tax).toMatchObject({ status: "refused", reasons: ["tax_rules_unverified"] });
  });

  test("a margin class is the engine's unsupported_instrument for its book", async () => {
    const result = await run(
      [buy("acq", "2030-01-06", "10", "1000")],
      request({ instruments: [{ ...ALPHA_MAPPING, instrumentClass: "margin-position" }] }),
    );
    expect(result.status).toBe("unsupported");
    expect(result.reasons).toEqual(["unsupported_instrument"]);
  });

  test("the outer manifest pins the selector, cut, set version, identity, coverage, policy and engine", async () => {
    const chosen = await selection([buy("acq", "2030-01-06", "10", "1000")]);
    const result = await runOn(chosen);
    expect(result.manifest).toMatchObject({
      schemaVersion: "lots-on-selection-manifest-v1",
      selectorRelease: "knowledge-selector-v1",
      adapterRelease: LOT_ADAPTER_RELEASE,
      contract: "provisional-lot-input-v0",
      engineVersion: LOT_ENGINE_VERSION,
      cut: {
        requested: { coreEpoch: "core-epoch-test", commitSeq: 1 },
        resolved: { coreEpoch: "core-epoch-test", commitSeq: 1 },
        knownAt: "2030-02-01T00:00:00.000Z",
      },
      setVersion: chosen.setVersion,
      identity: {
        epoch: "identity-epoch-1",
        pins: [["acq@1", `instrument_mapping:${ALPHA_UNIT}`, 1]],
      },
      coverageProducer: COVERAGE_PRODUCER_NONE,
      snapshotContexts: [],
      holders: [{ accountId: HOLDER, wrapperKey: WRAPPER }],
      instruments: [ALPHA_MAPPING],
      policyRef: "lot-policy:test@1",
    });
  });

  test("a request with an unknown key, or two wrappers for one account, is refused", async () => {
    const chosen = await selection([buy("acq", "2030-01-06", "10", "1000")]);
    const extra = { ...request(), note: "x" } as unknown as LotAdapterRequest;
    expect(adaptSelectionToLots(chosen, extra)).toEqual({
      ok: false,
      error: { code: "invalid_request", refs: ["request"] },
    });
    const twice = request({
      holders: [
        { accountId: HOLDER, wrapperKey: WRAPPER },
        { accountId: HOLDER, wrapperKey: "wrapper:test:other" },
      ],
    });
    expect((await lotsOnSelection(chosen, twice)).ok).toBe(false);
  });
});
