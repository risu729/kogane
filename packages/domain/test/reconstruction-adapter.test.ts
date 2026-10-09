// The B adapter (src/reconstruction-adapter.ts): what the knowledge selector
// resolved, folded by `reconstructState` (ADR 0052) and explained against a
// reported end, on hand-built rows (selector-fixture.ts). Acceptance tests B3
// (no double count: raw/event, net/fee, trade/settlement, 101 = 100 + 1), B4
// (a movement on a snapshot's boundary is never adopted), B5 (a zero
// remainder with incomplete coverage is never reconciled), B6 (unknown stays
// unknown), B13 (the manifest is the same under any order of the rows), and
// the dispositions the selector reports. Every id, amount and date is
// invented.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { CARD_PURCHASE_WRITER_RELEASE } from "../src/card-purchase.ts";
import { canonicalDigest } from "../src/context.ts";
import type { AdoptedSelection } from "../src/knowledge-selector.ts";
import {
  adaptedKnowledge,
  adaptSelection,
  COVERAGE_PRODUCER_NONE,
  explainLateSelections,
  KNOWN_WRITER_RELEASES,
  RECONSTRUCTION_ADAPTER_RELEASE,
} from "../src/reconstruction-adapter.ts";
import {
  RECONSTRUCTION_FOLD_V1,
  reconstructState,
  type ReconstructedState,
  type ReconstructionReportedBalance,
  type StartSnapshot,
} from "../src/reconstruction.ts";
import { quantityText, q } from "./helpers.ts";
import { A, B, CARD, EPOCH, Rows, posting } from "./selector-fixture.ts";

const KEY = JSON.stringify(["smbc-bank", "producer-test", "ns-test", "bank-test", "row-1"]);
const START_CAPTURE = "2026-03-01T03:00:00.000Z";
const END_CAPTURE = "2026-03-31T03:00:00.000Z";

function balance(amount: string, capturedAt: string, ref: string): ReconstructionReportedBalance {
  return {
    ref,
    accountId: A,
    metricId: "bank.ledger-balance",
    measurementKind: "stock",
    signMeaning: "asset-positive",
    quantity: q("JPY", amount),
    snapshotRef: `artifact:${ref}`,
    capturedAt,
  };
}

function side(date: string, rows: ReconstructionReportedBalance[]): StartSnapshot {
  return {
    contextId: `context:test:${date}`,
    date,
    accountsWithoutContainer: [],
    balances: rows,
    positions: [],
  };
}

async function fold(
  selection: AdoptedSelection,
  endAmount: string,
  baseline: AdoptedSelection | null = null,
): Promise<ReconstructedState> {
  const now = await adaptedKnowledge(selection);
  if (!now.ok) throw new Error(now.error.code);
  const before = baseline === null ? null : await adaptedKnowledge(baseline);
  if (before !== null && !before.ok) throw new Error(before.error.code);
  const result = reconstructState({
    request: {
      accountIds: [A],
      startDate: "2026-03-01",
      endDate: "2026-03-31",
      basis: "cash",
      knowledgeAt: "2026-04-30T00:00:00.000Z",
      knowledgeCut: { coreEpoch: EPOCH, commitSeq: selection.cut.commitSeq },
    },
    policy: RECONSTRUCTION_FOLD_V1,
    start: side("2026-03-01", [balance("10000", START_CAPTURE, "start")]),
    end: side("2026-03-31", [balance(endAmount, END_CAPTURE, "end")]),
    selection: now.selection,
    baseline: before?.selection ?? null,
  });
  if (!result.ok) throw new Error(result.error.code);
  return result.state;
}

const cellOf = (state: ReconstructedState) =>
  state.cells.find((cell) => cell.accountId === A && cell.unitRef === "JPY")!;
const dispositionOf = (state: ReconstructedState, ref: string) =>
  state.dispositions.find((row) => row.ref === ref)?.disposition;

describe("B3: nothing is counted twice", () => {
  test("101 out = 100 principal + 1 fee: the movement counts once, the breakdown never", async () => {
    const rows = new Rows().add({
      eventId: "ev-1",
      seq: 1,
      times: [posting("2026-03-15")],
      legs: [
        { amount: "101", role: "decrease", effect: "movement" },
        { amount: "100", role: "increase", effect: "movement" },
        { amount: "1", role: "fee", effect: "breakdown", of: 0 },
      ],
    });
    const state = await fold(await rows.select(1), "9999");
    const cell = cellOf(state);
    expect(cell.applied.refs).toEqual(["ev-1@1#0", "ev-1@1#1"]);
    expect(quantityText(cell.applied.total)).toBe("-1");
    expect(cell.ignored.breakdown_attribution).toBe(1);
    expect(quantityText(cell.reconstructed)).toBe("9999");
  });

  test("a legacy fee leg on the movement's own basis is never added: its effect is undeclared", async () => {
    const rows = new Rows().add({
      eventId: "ev-1",
      seq: 1,
      times: [posting("2026-03-15")],
      legs: [
        { amount: "101", role: "decrease" },
        { amount: "1", role: "fee" },
      ],
    });
    const adapted = await adaptSelection(await rows.select(1));
    expect(adapted.notes).toEqual([{ ref: "ev-1@1#1", code: "legacy_leg_effect_undeclared" }]);
    const state = await fold(await rows.select(1), "9899");
    expect(cellOf(state).gaps).toContain("writer_unsupported");
    expect(cellOf(state).applied.count).toBe(0);
  });

  test("a settlement's legacy obligation leg is its movement restated, never added", async () => {
    const rows = new Rows().add({
      eventId: "ev-1",
      seq: 1,
      times: [posting("2026-03-15")],
      legs: [
        { amount: "1000", role: "decrease" },
        { subject: CARD, amount: null, role: "unresolved", basis: "obligation-change" },
      ],
    });
    const adapted = await adaptSelection(await rows.select(1));
    expect(adapted.set.revisions[0]!.legs.map((leg) => [leg.effect, leg.ofLegIndex])).toEqual([
      ["movement", null],
      ["correspondence", 0],
    ]);
    const state = await fold(await rows.select(1), "9000");
    expect(dispositionOf(state, "ev-1@1#1")).toBe("other_basis");
    expect(cellOf(state).applied.refs).toEqual(["ev-1@1#0"]);
  });

  test("trade and settlement: only the cash basis's leg moves the cash cell", async () => {
    const rows = new Rows().add({
      eventId: "ev-1",
      kind: "card_settlement",
      seq: 1,
      times: [
        posting("2026-03-15"),
        [
          "trade",
          { kind: "local-date", value: "2026-03-12", zone: "Asia/Tokyo", basis: "provider" },
        ],
      ],
      legs: [
        { amount: "500", role: "decrease", basis: "trade-date", effect: "movement" },
        { amount: "500", role: "decrease", basis: "cash-movement", effect: "movement" },
      ],
    });
    const state = await fold(await rows.select(1), "9500");
    expect(dispositionOf(state, "ev-1@1#0")).toBe("other_basis");
    expect(cellOf(state).applied.refs).toEqual(["ev-1@1#1"]);
  });

  test("raw and event: one provider row two events claim is a conflict, applied by neither", async () => {
    const rows = new Rows()
      .add({
        eventId: "ev-1",
        seq: 1,
        times: [posting("2026-03-15")],
        legs: [{ amount: "100" }],
        claims: [{ key: KEY }],
      })
      .add({
        eventId: "ev-2",
        seq: 2,
        times: [posting("2026-03-15")],
        legs: [{ amount: "100" }],
        claims: [{ key: KEY }],
      });
    const state = await fold(await rows.select(2), "9800");
    const cell = cellOf(state);
    expect(cell.applied.count).toBe(0);
    expect(cell.gaps).toContain("claim_conflict");
    expect(cell.needsReview).toBe(true);
    expect(cell.reconstructed.value.status).toBe("missing");
  });
});

describe("B4, B5, B6", () => {
  test("B4: a movement dated on the end capture's day is a boundary candidate, never adopted", async () => {
    const rows = new Rows().add({
      eventId: "ev-1",
      seq: 1,
      times: [posting("2026-03-31")],
      legs: [{ amount: "100" }],
    });
    const cell = cellOf(await fold(await rows.select(1), "9900"));
    expect(cell.boundary.count).toBe(1);
    expect(cell.applied.count).toBe(0);
    expect(cell.explanation.status).not.toBe("reconciled");
  });

  test("B4: a movement without a posting time is never placed by another role", async () => {
    const rows = new Rows().add({
      eventId: "ev-1",
      seq: 1,
      times: [
        [
          "usage",
          { kind: "local-date", value: "2026-03-15", zone: "Asia/Tokyo", basis: "provider" },
        ],
      ],
      legs: [{ amount: "100" }],
    });
    const cell = cellOf(await fold(await rows.select(1), "9900"));
    expect(cell.gaps).toContain("event_time_unknown");
    expect(cell.reconstructed.value.status).toBe("missing");
  });

  test("B5: with no coverage producer a zero remainder is never reconciled", async () => {
    const rows = new Rows().add({
      eventId: "ev-1",
      seq: 1,
      times: [posting("2026-03-15")],
      legs: [{ amount: "100" }],
    });
    const selection = await rows.select(1);
    const adapted = await adaptSelection(selection);
    expect(adapted.set.familyCoverage).toEqual([]);
    expect(adapted.set.pins.coverageRelease).toBe(COVERAGE_PRODUCER_NONE);
    const cell = cellOf(await fold(selection, "9900"));
    expect(quantityText(cell.explanation.remainder)).toBe("0");
    expect(cell.gaps).toEqual(["family_not_evented", "history_coverage_unknown"]);
    expect(cell.explanation).toMatchObject({
      status: "not_comparable",
      reasonCode: "reconstruction_incomplete",
    });
  });

  test("B6: an unknown value stays unknown, and so does the figure", async () => {
    const rows = new Rows().add({
      eventId: "ev-1",
      seq: 1,
      times: [posting("2026-03-15")],
      legs: [{ amount: null }],
    });
    const cell = cellOf(await fold(await rows.select(1), "9900"));
    expect(cell.reconstructed.value).toEqual({
      status: "missing",
      reasonCode: "leg_value_not_exact",
    });
    expect(cell.explanation.remainder.value.status).toBe("missing");
  });

  test("B6: a withdrawn settlement has no effect, and a later commit does not change what an earlier cut applied", async () => {
    const rows = new Rows()
      .add({ eventId: "ev-1", seq: 1, times: [posting("2026-03-15")], legs: [{ amount: "100" }] })
      .add({ eventId: "ev-1", revision: 2, seq: 2, state: "unknown" });
    expect(cellOf(await fold(await rows.select(1), "9900")).applied.refs).toEqual(["ev-1@1#0"]);
    const withdrawn = await fold(await rows.select(2), "10000");
    expect(cellOf(withdrawn).applied.count).toBe(0);
    expect(dispositionOf(withdrawn, "ev-1@2")).toBe("state_no_effect");
  });
});

describe("dispositions carried through", () => {
  test("an unlogged revision is knowledge_unlogged in the fold, whatever its date", async () => {
    const rows = new Rows()
      .add({
        eventId: "ev-pre",
        seq: null,
        times: [posting("2026-01-15")],
        legs: [{ amount: "100" }],
      })
      .add({ eventId: "ev-1", seq: 1, times: [posting("2026-03-15")], legs: [{ amount: "5" }] });
    const adapted = await adaptSelection(await rows.select(1));
    expect(adapted.set.revisions.map((row) => [row.eventId, row.commitRef])).toEqual([
      ["ev-1", { coreEpoch: EPOCH, commitSeq: 1 }],
      ["ev-pre", null],
    ]);
    const cell = cellOf(await fold(await rows.select(1), "9995"));
    expect(cell.gaps).toContain("knowledge_unlogged");
    expect(cell.reconstructed.value.status).toBe("missing");
  });

  test("identity_changed and alias_conflict become fold flags: needs review, never applied", async () => {
    const alias = JSON.stringify(["smbc-bank", ["row-1"], A, "rule-test-v1"]);
    const rows = new Rows()
      .add({
        eventId: "ev-1",
        seq: 1,
        times: [posting("2026-03-15")],
        legs: [{ amount: "100" }],
        claims: [{ key: KEY, alias }],
      })
      .add({
        eventId: "ev-2",
        seq: 2,
        times: [posting("2026-03-16")],
        legs: [{ amount: "1", subject: B }],
        claims: [{ key: KEY.replace("row-1", "row-9"), alias }],
      });
    const selection = await rows.select(2, { currentIdentityEpoch: "identity-epoch-2" });
    const adapted = await adaptSelection(selection);
    expect(adapted.set.revisions[0]!.flags).toEqual(["identity_changed", "alias_conflict"]);
    expect(adapted.aliasRuleVersions).toEqual(["rule-test-v1"]);
    const cell = cellOf(await fold(selection, "9900"));
    expect(cell.needsReview).toBe(true);
    expect(cell.gaps).toEqual(expect.arrayContaining(["identity_changed", "alias_conflict"]));
  });

  test("W2 through the fold: an undeclared pointer leaves the cell for review, never an exact figure", async () => {
    const rows = new Rows()
      .add({
        eventId: "ev:pending",
        seq: 1,
        times: [posting("2026-03-10")],
        legs: [{ amount: "10" }],
      })
      .add({
        eventId: "ev:pending",
        revision: 2,
        seq: 2,
        times: [posting("2026-03-10")],
        legs: [{ amount: "10" }],
      })
      .add({
        eventId: "ev:pending",
        revision: 3,
        seq: 3,
        times: [posting("2026-03-10")],
        legs: [{ amount: "10" }],
      })
      .add({
        eventId: "ev:posted",
        seq: 4,
        times: [posting("2026-03-12")],
        legs: [{ amount: "500" }],
      });
    rows.revisions.find((row) => row.eventId === "ev:posted")!.supersededBy = "ev:pending@2";
    const selection = await rows.select(4);
    expect(selection.inconsistent).toEqual([
      { eventId: "ev:posted", reasonCode: "supersession_undeclared" },
    ]);
    const cell = cellOf(await fold(selection, "9490"));
    expect(cell.needsReview).toBe(true);
    expect(cell.reconstructed.value.status).not.toBe("exact");
    expect(cell.applied.refs).not.toContain("ev:posted@1#0");
  });

  test("a kind no fold writer covers, or another writer release, is writer_unsupported", async () => {
    const rows = new Rows()
      .add({
        eventId: "ev-1",
        kind: "transfer",
        seq: 1,
        times: [posting("2026-03-15")],
        legs: [{ amount: "100" }],
      })
      .add({
        eventId: "ev-2",
        seq: 2,
        writerRelease: "unknown-writer-v1",
        times: [posting("2026-03-15")],
        legs: [{ amount: "1" }],
      });
    const adapted = await adaptSelection(await rows.select(2));
    expect(adapted.notes).toEqual([
      { ref: "ev-1@1", code: "writer_unsupported" },
      { ref: "ev-2@1", code: "writer_unsupported" },
    ]);
    expect(adapted.set.writers).toEqual([]);
  });

  test("the adapter hands over a resolved set, keys digested, times as stored, no supersession", async () => {
    const rows = new Rows()
      .add({
        eventId: "ev-1",
        seq: 1,
        times: [posting("2026-03-15")],
        legs: [{ amount: "100" }],
        claims: [{ key: KEY }],
      })
      .add({
        eventId: "ev-1",
        revision: 2,
        seq: 2,
        times: [posting("2026-03-16")],
        legs: [{ amount: "100" }],
        claims: [{ key: KEY }],
      });
    const adapted = await adaptSelection(await rows.select(2));
    expect(adapted.set).toMatchObject({
      resolution: "resolved-at-cut",
      adapterRelease: RECONSTRUCTION_ADAPTER_RELEASE,
      writers: ["card-settlement-review"],
    });
    expect(adapted.set.revisions).toHaveLength(1);
    expect(adapted.set.revisions[0]!).toMatchObject({
      revision: 2,
      supersededBy: null,
      times: [{ role: "posting" }],
    });
    expect(adapted.set.revisions[0]!.claims[0]!.key).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });
});

describe("the late part and the manifest", () => {
  test("explainLate on two selections: a correction recorded after the end capture's cut", async () => {
    const rows = new Rows()
      .add({ eventId: "ev-1", seq: 1, times: [posting("2026-03-15")], legs: [{ amount: "100" }] })
      .add({
        eventId: "ev-1",
        revision: 2,
        seq: 2,
        times: [posting("2026-03-15")],
        legs: [{ amount: "150" }],
      });
    const late = await explainLateSelections(await rows.select(1), await rows.select(2));
    expect(late).toEqual({
      ok: true,
      late: {
        baselineCut: { coreEpoch: EPOCH, commitSeq: 1 },
        cut: { coreEpoch: EPOCH, commitSeq: 2 },
        entered: ["ev-1@2"],
        left: ["ev-1@1"],
      },
    });
    const cell = cellOf(await fold(await rows.select(2), "9850", await rows.select(1)));
    expect(quantityText(cell.explanation.lateRecorded!.total)).toBe("-50");
  });

  test("B13: the fold's manifest digest is the same for any order of the loaded rows", async () => {
    const build = (reverse: boolean) => {
      const specs = [
        {
          eventId: "ev-1",
          seq: 1,
          times: [posting("2026-03-15")],
          legs: [{ amount: "100" }],
          claims: [{ key: KEY }],
        },
        { eventId: "ev-2", seq: 2, times: [posting("2026-03-16")], legs: [{ amount: "7" }] },
      ] as const;
      const rows = new Rows();
      for (const spec of specs) rows.add(structuredClone(spec) as never);
      if (reverse)
        for (const key of ["revisions", "legs", "claims", "times", "seals", "commits"] as const)
          rows[key].reverse();
      return rows;
    };
    const one = await fold(await build(false).select(2), "9893");
    const two = await fold(await build(true).select(2), "9893");
    expect(await canonicalDigest(two.manifest)).toBe(await canonicalDigest(one.manifest));
    expect(two).toEqual(one);
  });
});

describe("writer releases", () => {
  test("the known releases are the writers' own constants", () => {
    expect(KNOWN_WRITER_RELEASES["card-purchase-recognition-v1"]).toEqual([
      CARD_PURCHASE_WRITER_RELEASE,
    ]);
    const source = readFileSync(
      new URL("../../../services/processor/src/card-settlement-commands.ts", import.meta.url),
      "utf8",
    );
    const declared = /CARD_SETTLEMENT_WRITER_RELEASE = "([^"]+)"/u.exec(source)?.[1];
    expect(KNOWN_WRITER_RELEASES["card-settlement-review"]).toEqual([declared!]);
  });
});
