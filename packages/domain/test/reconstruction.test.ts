// The reconstruction fold (docs/reconstructed-state.md, ADR 0052) on synthetic
// inputs only: invented account and instrument ids, round invented amounts,
// invented dates and invented commit sequences. The shapes mirror what an
// adapter maps the two writers onto (a card settlement's cash movement and
// its obligation correspondence, a card purchase's purchase-recognition
// movement, retirement and withdrawal without legs, cross-id merge and
// split); no value comes from production.
import { describe, expect, test } from "bun:test";
import { canonicalDigest, canonicalJson, sha256Hex } from "../src/context.ts";
import {
  canonicalReconstructionManifest,
  explainLate,
  PROVISIONAL_EVENT_CONTRACT,
  RECONSTRUCTION_BUDGET,
  RECONSTRUCTION_FOLD_V1,
  reconstructState,
  selectKnowledge,
  type EndReported,
  type KnowledgeSelection,
  type ProvisionalAdoptedEventSet,
  type ProvisionalEventRevision,
  type ProvisionalLeg,
  type ProvisionalTime,
  type ReconstructedState,
  type ReconstructionReportedBalance,
  type ReconstructionReportedPosition,
  type ReconstructionRequest,
  type StartSnapshot,
} from "../src/reconstruction.ts";
import { absentQuantity, type Quantity } from "../src/values.ts";
import { ok, q, quantityText } from "./helpers.ts";

const A = "account:test:a";
const B = "account:test:b";
const CARD = "account:test:card";
const ALPHA = "instrument:test:alpha";
const START_DATE = "2026-03-01";
const END_DATE = "2026-03-31";
const START_CAPTURE = "2026-03-01T03:00:00.000Z";
const END_CAPTURE = "2026-03-31T03:00:00.000Z";
/** The cut every test asks at unless it says otherwise, in one invented history epoch. */
const CUT = 100;
const EPOCH = "epoch:test:1";

const on = (date: string, role: ProvisionalTime["role"] = "posting"): ProvisionalTime => ({
  role,
  time: { kind: "local-date", value: date, zone: "Asia/Tokyo", basis: "provider" },
});

function leg(fields: Partial<ProvisionalLeg> & { quantity: Quantity }): ProvisionalLeg {
  return {
    legIndex: 0,
    accountId: A,
    effect: "movement",
    role: "decrease",
    ofLegIndex: null,
    basis: "cash-movement",
    ...fields,
  };
}

type RevisionFields = Partial<ProvisionalEventRevision> & { commit?: number | null };

function rev(fields: RevisionFields): ProvisionalEventRevision {
  const { commit = 10, ...rest } = fields;
  return {
    eventId: "event:test:1",
    revision: 1,
    kind: "card_settlement",
    state: "debited",
    unknownReason: null,
    times: [on("2026-03-15")],
    commitRef: commit === null ? null : { coreEpoch: EPOCH, commitSeq: commit },
    recordedAt: "2026-03-16T00:00:00.000Z",
    supersededBy: null,
    legs: [],
    evidenceIds: [],
    claims: [],
    flags: [],
    ...rest,
  };
}

/** One cash debit from A as an accepted settlement review stores it: a movement and its obligation correspondence. */
function debit(eventId: string, amount: string, date: string, fields: RevisionFields = {}) {
  return rev({
    eventId,
    times: [on(date)],
    legs: [
      leg({ quantity: q("JPY", amount) }),
      leg({
        legIndex: 1,
        accountId: CARD,
        effect: "correspondence",
        role: "unresolved",
        ofLegIndex: 0,
        basis: "obligation-change",
        quantity: absentQuantity("JPY", "missing", "statement_principal_and_fees_unknown"),
      }),
    ],
    ...fields,
  });
}

function eventSet(
  revisions: ProvisionalEventRevision[],
  fields: Partial<ProvisionalAdoptedEventSet> = {},
): ProvisionalAdoptedEventSet {
  return {
    contract: PROVISIONAL_EVENT_CONTRACT,
    resolution: "full-chains",
    setVersion: "set:test:1",
    adapterRelease: "adapter:test:v0",
    writers: ["card-settlement-review"],
    pins: {
      identityRelease: "identity:test:1",
      evidenceAliasRelease: "alias:test:1",
      coverageRelease: "coverage:test:1",
      fxReferenceRef: null,
      policyRefs: [],
    },
    revisions,
    familyCoverage: [
      { accountId: A, families: ["bank-transactions"], status: "evented" },
      { accountId: B, families: ["bank-transactions"], status: "evented" },
    ],
    historyCoverage: [
      { accountId: A, from: "2026-01-01", to: "2026-04-30", status: "complete", reasonCode: null },
      { accountId: B, from: "2026-01-01", to: "2026-04-30", status: "complete", reasonCode: null },
    ],
    ...fields,
  };
}

function balance(
  fields: Partial<ReconstructionReportedBalance> = {},
): ReconstructionReportedBalance {
  return {
    ref: "balance:test:start",
    accountId: A,
    metricId: "bank.ledger-balance",
    measurementKind: "stock",
    signMeaning: "asset-positive",
    quantity: q("JPY", "10000"),
    snapshotRef: "artifact:test:start",
    capturedAt: START_CAPTURE,
    ...fields,
  };
}

function endBalance(amount: string, fields: Partial<ReconstructionReportedBalance> = {}) {
  return balance({
    ref: "balance:test:end",
    quantity: q("JPY", amount),
    snapshotRef: "artifact:test:end",
    capturedAt: END_CAPTURE,
    ...fields,
  });
}

function side(
  date: string,
  balances: ReconstructionReportedBalance[],
  fields: Partial<StartSnapshot> = {},
): StartSnapshot {
  return {
    contextId: `context:test:${date}`,
    date,
    accountsWithoutContainer: [],
    balances,
    positions: [],
    ...fields,
  };
}

function request(fields: Partial<ReconstructionRequest> = {}): ReconstructionRequest {
  return {
    accountIds: [A],
    startDate: START_DATE,
    endDate: END_DATE,
    basis: "cash",
    knowledgeAt: "2026-04-05T00:00:00.000Z",
    knowledgeCut: { coreEpoch: EPOCH, commitSeq: CUT },
    ...fields,
  };
}

const select = (set: ProvisionalAdoptedEventSet, commitSeq: number): KnowledgeSelection =>
  ok(selectKnowledge(set, { coreEpoch: EPOCH, commitSeq })).selection;

function run(input: {
  set: ProvisionalAdoptedEventSet;
  start?: StartSnapshot;
  end?: EndReported;
  request?: Partial<ReconstructionRequest>;
  /** The cut of the end capture, for `lateRecorded`. */
  baselineCut?: number;
}): ReconstructedState {
  const asked = request(input.request);
  return ok(
    reconstructState({
      request: asked,
      policy: RECONSTRUCTION_FOLD_V1,
      start: input.start ?? side(asked.startDate, [balance()]),
      end: input.end ?? side(asked.endDate, [endBalance("10000")]),
      selection: select(input.set, asked.knowledgeCut.commitSeq),
      baseline: input.baselineCut === undefined ? null : select(input.set, input.baselineCut),
    }),
  ).state;
}

function cell(state: ReconstructedState, accountId = A, unitRef: string | null = "JPY") {
  const found = state.cells.find((row) => row.accountId === accountId && row.unitRef === unitRef);
  if (found === undefined) throw new Error(`no cell ${accountId} ${unitRef}`);
  return found;
}

const text = (quantity: Quantity) => quantityText(quantity);
const reason = (quantity: Quantity) =>
  quantity.value.status === "exact" ? null : quantity.value.reasonCode;
const disposition = (state: ReconstructedState, ref: string) =>
  state.dispositions.find((row) => row.ref === ref)?.disposition;

describe("the fold of one cell", () => {
  test("folds exact decimals at their own scale", () => {
    const state = run({
      set: eventSet([
        rev({ legs: [leg({ quantity: q("USD", "0.75") })] }),
        rev({
          eventId: "event:test:2",
          legs: [leg({ role: "increase", quantity: q("USD", "10.005") })],
        }),
      ]),
      start: side(START_DATE, [balance({ quantity: q("USD", "100.25") })]),
      end: side(END_DATE, [endBalance("109.505", { quantity: q("USD", "109.505") })]),
    });
    const usd = cell(state, A, "USD");
    expect(text(usd.reconstructed)).toBe("109.505");
    expect(text(usd.applied.total)).toBe("9.255");
    expect(usd.partition).toBe("complete");
    expect(usd.explanation.status).toBe("reconciled");
    expect(text(usd.explanation.remainder)).toBe("0");
  });

  test("keeps JPY and USD in separate cells, never added", () => {
    const state = run({
      set: eventSet([
        debit("event:test:1", "1000", "2026-03-15"),
        rev({
          eventId: "event:test:2",
          legs: [leg({ role: "increase", quantity: q("USD", "5") })],
        }),
      ]),
      start: side(START_DATE, [
        balance(),
        balance({ ref: "balance:test:usd", quantity: q("USD", "50") }),
      ]),
    });
    expect(text(cell(state, A, "JPY").reconstructed)).toBe("9000");
    expect(text(cell(state, A, "USD").reconstructed)).toBe("55");
    for (const row of state.cells)
      for (const quantity of [row.reconstructed, row.applied.total])
        expect(quantity.unitRef).toBe(row.unitRef!);
  });

  test("a missing start leaves the figure absent with a reason, never zero, and still lists the flow", () => {
    const state = run({
      set: eventSet([debit("event:test:1", "1000", "2026-03-15")]),
      start: side(START_DATE, []),
    });
    const jpy = cell(state);
    expect(jpy.start).toBeNull();
    expect(jpy.reconstructed.value.status).toBe("missing");
    expect(reason(jpy.reconstructed)).toBe("no_start_snapshot");
    expect(jpy.gaps).toContain("no_start_snapshot");
    expect(jpy.applied.count).toBe(1);
    expect(text(jpy.applied.total)).toBe("-1000");
    expect(jpy.partition).toBe("not-computable");
    expect(jpy.explanation.status).toBe("not_comparable");
  });

  test("a movement without an exact value makes the cell incomplete", () => {
    const state = run({
      set: eventSet([
        rev({ legs: [leg({ quantity: absentQuantity("JPY", "unparsed", "test") })] }),
      ]),
    });
    const jpy = cell(state);
    expect(jpy.gaps).toEqual(["leg_value_not_exact"]);
    expect(reason(jpy.reconstructed)).toBe("leg_value_not_exact");
    expect(jpy.unknown.refs).toEqual(["event:test:1@1#0"]);
    expect(jpy.explanation.reasonCode).toBe("reconstruction_incomplete");
  });

  test("an empty set with unknown coverage is not reconciled even at a zero remainder", () => {
    const state = run({
      set: eventSet([], {
        familyCoverage: [],
        historyCoverage: [
          {
            accountId: A,
            from: "2026-01-01",
            to: "2026-04-30",
            status: "unknown",
            reasonCode: "no_history_claim",
          },
        ],
      }),
    });
    const jpy = cell(state);
    expect(text(jpy.reconstructed)).toBe("10000");
    expect(jpy.gaps).toEqual(["family_not_evented", "history_coverage_unknown"]);
    expect(jpy.partition).toBe("partial-verified-scope");
    expect(text(jpy.explanation.remainder)).toBe("0");
    expect(jpy.explanation.status).toBe("not_comparable");
    expect(jpy.explanation.reasonCode).toBe("reconstruction_incomplete");
    expect(state.accounts[0]!.familyCoverage).toBe("not-declared");
  });

  test("an empty set with declared complete coverage is the start, reconciled", () => {
    const jpy = cell(run({ set: eventSet([]) }));
    expect(text(jpy.reconstructed)).toBe("10000");
    expect(jpy.partition).toBe("complete");
    expect(jpy.explanation.status).toBe("reconciled");
  });

  test("history filled in later recomputes the gap", () => {
    const partial = eventSet([], {
      historyCoverage: [
        {
          accountId: A,
          from: "2026-01-01",
          to: "2026-03-10",
          status: "complete",
          reasonCode: null,
        },
      ],
    });
    expect(cell(run({ set: partial })).gaps).toEqual(["history_coverage_unknown"]);
    const filled = eventSet([], {
      historyCoverage: [
        {
          accountId: A,
          from: "2026-01-01",
          to: "2026-03-10",
          status: "complete",
          reasonCode: null,
        },
        {
          accountId: A,
          from: "2026-03-11",
          to: "2026-04-30",
          status: "complete",
          reasonCode: null,
        },
      ],
    });
    expect(cell(run({ set: filled })).partition).toBe("complete");
    const gap = eventSet([], {
      historyCoverage: [
        {
          accountId: A,
          from: "2026-01-01",
          to: "2026-04-30",
          status: "complete",
          reasonCode: null,
        },
        {
          accountId: A,
          from: "2026-03-05",
          to: "2026-03-06",
          status: "gap",
          reasonCode: "fetch_failed",
        },
      ],
    });
    expect(cell(run({ set: gap })).gaps).toEqual(["history_gap"]);
  });

  test("a liability-positive start is negated into the asset-positive orientation", () => {
    const state = run({
      set: eventSet([rev({ legs: [leg({ role: "increase", quantity: q("JPY", "1000") })] })]),
      start: side(START_DATE, [
        balance({ signMeaning: "liability-positive", quantity: q("JPY", "5000") }),
      ]),
      end: side(END_DATE, [endBalance("4000", { signMeaning: "liability-positive" })]),
    });
    const jpy = cell(state);
    expect(text(jpy.start!.oriented)).toBe("-5000");
    expect(text(jpy.reconstructed)).toBe("-4000");
    expect(jpy.explanation.status).toBe("reconciled");
  });

  test("a start that is not one stock figure with a known sign is refused per cell", () => {
    const capacity = cell(
      run({
        set: eventSet([]),
        start: side(START_DATE, [balance({ measurementKind: "capacity" })]),
      }),
    );
    expect(capacity.gaps).toContain("start_metric_not_stock");
    expect(reason(capacity.reconstructed)).toBe("start_metric_not_stock");
    const unsigned = cell(
      run({
        set: eventSet([]),
        start: side(START_DATE, [balance({ signMeaning: "provider-sign" })]),
      }),
    );
    expect(reason(unsigned.reconstructed)).toBe("start_sign_unknown");
    const ambiguous = cell(
      run({
        set: eventSet([]),
        start: side(START_DATE, [
          balance(),
          balance({ ref: "balance:test:two", metricId: "bank.other" }),
        ]),
      }),
    );
    expect(reason(ambiguous.reconstructed)).toBe("start_ambiguous_metrics");
    const absent = cell(
      run({
        set: eventSet([]),
        start: side(START_DATE, [balance({ quantity: absentQuantity("JPY", "missing", "test") })]),
      }),
    );
    expect(reason(absent.reconstructed)).toBe("start_value_not_exact");
  });

  test("a stale start capture counts the events between its day and the start date", () => {
    const state = run({
      set: eventSet([debit("event:test:1", "300", "2026-02-27")]),
      start: side(START_DATE, [balance({ capturedAt: "2026-02-25T03:00:00.000Z" })]),
    });
    const jpy = cell(state);
    expect(jpy.applied.count).toBe(1);
    expect(text(jpy.reconstructed)).toBe("9700");
  });
});

describe("leg effects", () => {
  test("a purchase-recognition movement is not applied on the cash basis", () => {
    const state = run({
      set: eventSet([
        rev({
          kind: "purchase",
          state: "captured",
          times: [on("2026-03-15", "usage")],
          legs: [
            leg({ accountId: CARD, basis: "purchase-recognition", quantity: q("JPY", "800") }),
          ],
        }),
      ]),
      request: { accountIds: [A, CARD] },
      start: side(START_DATE, [balance()], { accountsWithoutContainer: [CARD] }),
      end: side(END_DATE, [endBalance("10000")], { accountsWithoutContainer: [CARD] }),
    });
    expect(disposition(state, "event:test:1@1#0")).toBe("other_basis");
    expect(state.cells.some((row) => row.accountId === CARD)).toBe(false);
    expect(state.accounts.find((row) => row.accountId === CARD)!.startContainer).toBe(false);
    expect(cell(state).explanation.status).toBe("reconciled");
  });

  test("101 out = principal 100 + fee 1: each movement counts once, the breakdown never", () => {
    const state = run({
      set: eventSet([
        rev({
          kind: "transfer",
          legs: [
            leg({ quantity: q("JPY", "101") }),
            leg({ legIndex: 1, role: "increase", quantity: q("JPY", "100") }),
            leg({
              legIndex: 2,
              effect: "breakdown",
              role: "fee",
              ofLegIndex: 0,
              quantity: q("JPY", "1"),
            }),
          ],
        }),
      ]),
      end: side(END_DATE, [endBalance("9999")]),
    });
    const jpy = cell(state);
    expect(jpy.applied.refs).toEqual(["event:test:1@1#0", "event:test:1@1#1"]);
    expect(text(jpy.applied.total)).toBe("-1");
    expect(jpy.ignored.breakdown_attribution).toBe(1);
    expect(text(jpy.reconstructed)).toBe("9999");
    expect(jpy.explanation.status).toBe("reconciled");
  });

  test("the same 101 = 100 + 1 between two own accounts is held, not applied", () => {
    const state = run({
      set: eventSet([
        rev({
          kind: "transfer",
          legs: [
            leg({ quantity: q("JPY", "101") }),
            leg({ legIndex: 1, accountId: B, role: "increase", quantity: q("JPY", "100") }),
            leg({
              legIndex: 2,
              effect: "breakdown",
              role: "fee",
              ofLegIndex: 0,
              quantity: q("JPY", "1"),
            }),
          ],
        }),
      ]),
      request: { accountIds: [A, B] },
      start: side(START_DATE, [balance(), balance({ ref: "balance:test:b", accountId: B })]),
      end: side(END_DATE, [
        endBalance("10000"),
        endBalance("10000", { ref: "balance:test:b-end", accountId: B }),
      ]),
    });
    for (const accountId of [A, B]) {
      const row = cell(state, accountId);
      expect(row.gaps).toContain("own_transfer_held");
      expect(row.applied.count).toBe(0);
      expect(row.reconstructed.value.status).toBe("missing");
    }
    expect(disposition(state, "event:test:1@1#2")).toBe("breakdown_attribution");
  });

  test("a settlement's obligation correspondence stays on its own basis and is never added", () => {
    const state = run({
      set: eventSet([debit("event:test:1", "1000", "2026-03-15")]),
      end: side(END_DATE, [endBalance("9000")]),
    });
    expect(disposition(state, "event:test:1@1#1")).toBe("other_basis");
    expect(cell(state).explanation.status).toBe("reconciled");
  });

  test("a leg on an unknown basis has an unknown effect", () => {
    const state = run({
      set: eventSet([rev({ legs: [leg({ basis: "unknown", quantity: q("JPY", "50") })] })]),
    });
    expect(cell(state).unknown.count).toBe(1);
    expect(reason(cell(state).reconstructed)).toBe("unknown_effect");
  });

  test("a movement no account resolves blocks every requested cell of its unit", () => {
    const state = run({
      set: eventSet([rev({ legs: [leg({ accountId: null, quantity: q("JPY", "10") })] })]),
    });
    const jpy = cell(state);
    expect(jpy.gaps).toContain("leg_subject_unrecognized");
    expect(jpy.unknown.refs).toEqual(["event:test:1@1#0"]);
    expect(state.dispositions.filter((row) => row.ref === "event:test:1@1#0")).toHaveLength(1);
  });

  test("another account's leg is recorded once and touches no cell", () => {
    const state = run({
      set: eventSet([rev({ legs: [leg({ accountId: B, quantity: q("JPY", "10") })] })]),
    });
    expect(disposition(state, "event:test:1@1#0")).toBe("other_account");
    expect(state.cells.map((row) => row.accountId)).toEqual([A]);
  });

  test("a breakdown must refer to a movement of its own unit", () => {
    const set = eventSet([
      rev({
        legs: [
          leg({ quantity: q("JPY", "101") }),
          leg({
            legIndex: 1,
            effect: "breakdown",
            role: "fee",
            ofLegIndex: 0,
            quantity: q("USD", "1"),
          }),
        ],
      }),
    ]);
    expect(selectKnowledge(set, { coreEpoch: EPOCH, commitSeq: CUT }).ok).toBe(false);
  });
});

describe("states and adapter flags", () => {
  test("an authorized purchase is shown apart and never added", () => {
    const state = run({
      set: eventSet([
        rev({ kind: "purchase", state: "authorized", legs: [leg({ quantity: q("JPY", "700") })] }),
      ]),
    });
    const jpy = cell(state);
    expect(jpy.pending.count).toBe(1);
    expect(text(jpy.pending.total)).toBe("-700");
    expect(text(jpy.reconstructed)).toBe("10000");
    expect(text(jpy.explanation.pendingShownApart.total)).toBe("-700");
  });

  test("a canceled purchase has no effect", () => {
    const state = run({
      set: eventSet([
        rev({ kind: "purchase", state: "canceled", legs: [leg({ quantity: q("JPY", "700") })] }),
      ]),
    });
    expect(cell(state).ignored.state_no_effect).toBe(1);
    expect(text(cell(state).reconstructed)).toBe("10000");
  });

  test("a retirement (unknown, no legs) supersedes and has no effect", () => {
    const state = run({
      set: eventSet([
        rev({
          kind: "purchase",
          state: "captured",
          legs: [leg({ quantity: q("JPY", "700") })],
          supersededBy: "event:test:1@2",
        }),
        rev({
          kind: "purchase",
          revision: 2,
          state: "unknown",
          unknownReason: "provider_status_absent",
          commit: 20,
        }),
      ]),
    });
    expect(disposition(state, "event:test:1@1#0")).toBe("superseded_at_knowledge_time");
    expect(disposition(state, "event:test:1@2")).toBe("state_no_effect");
    expect(text(cell(state).reconstructed)).toBe("10000");
  });

  test("a charge state the policy does not map has an unknown effect", () => {
    const state = run({
      set: eventSet([
        rev({ kind: "charge", state: "issued", legs: [leg({ quantity: q("JPY", "10") })] }),
      ]),
    });
    expect(reason(cell(state).reconstructed)).toBe("unknown_effect");
  });

  test("an adapter flag is never applied through: the cell needs review", () => {
    for (const flag of [
      "identity_changed",
      "alias_conflict",
      "claim_conflict",
      "writer_unsupported",
    ] as const) {
      const state = run({
        set: eventSet([debit("event:test:1", "1000", "2026-03-15", { flags: [flag] })]),
      });
      const jpy = cell(state);
      expect(disposition(state, "event:test:1@1#0")).toBe(flag);
      expect(jpy.gaps).toContain(flag);
      expect(jpy.needsReview).toBe(true);
      expect(jpy.applied.count).toBe(0);
      expect(reason(jpy.reconstructed)).toBe(flag);
    }
  });
});

describe("knowledge selection", () => {
  const corrected = [
    debit("event:test:1", "1000", "2026-03-15", { supersededBy: "event:test:1@2" }),
    debit("event:test:1", "1200", "2026-03-15", { revision: 2, commit: 60 }),
  ];

  test("a correction committed after the cut leaves the earlier revision applied", () => {
    const state = run({
      set: eventSet(corrected),
      request: { knowledgeCut: { coreEpoch: EPOCH, commitSeq: 50 } },
    });
    expect(disposition(state, "event:test:1@1#0")).toBe("applied");
    expect(disposition(state, "event:test:1@2#0")).toBe("recorded_after_knowledge_time");
    expect(text(cell(state).reconstructed)).toBe("9000");
  });

  test("the change committed after the end capture's cut is late_recorded", () => {
    const state = run({
      set: eventSet(corrected),
      end: side(END_DATE, [endBalance("8800")]),
      baselineCut: 50,
    });
    const jpy = cell(state);
    expect(text(jpy.reconstructed)).toBe("8800");
    expect(text(jpy.explanation.lateRecorded!.total)).toBe("-200");
    expect(jpy.explanation.lateRecorded!.refs).toEqual(["event:test:1@1#0", "event:test:1@2#0"]);
    expect(jpy.explanation.status).toBe("reconciled");
    expect(state.manifest.baselineCut).toEqual({ coreEpoch: EPOCH, commitSeq: 50 });
    const late = ok(
      explainLate(select(eventSet(corrected), 50), select(eventSet(corrected), CUT)),
    ).late;
    expect(late).toEqual({
      baselineCut: { coreEpoch: EPOCH, commitSeq: 50 },
      cut: { coreEpoch: EPOCH, commitSeq: CUT },
      entered: ["event:test:1@2"],
      left: ["event:test:1@1"],
    });
    expect(cell(run({ set: eventSet(corrected) })).explanation.lateRecorded).toBeNull();
  });

  test("a baseline after the cut, or of another scope, is refused", () => {
    const set = eventSet(corrected);
    const refused = explainLate(select(set, CUT), select(set, 50));
    expect(!refused.ok && refused.error.code).toBe("baseline_mismatch");
    const other = explainLate(
      select(eventSet(corrected, { adapterRelease: "adapter:test:v9" }), 50),
      select(set, CUT),
    );
    expect(!other.ok && other.error.code).toBe("baseline_mismatch");
  });

  test("recordedAt plays no part: commit order decides", () => {
    const state = run({
      set: eventSet([
        debit("event:test:1", "1000", "2026-03-15", {
          supersededBy: "event:test:1@2",
          recordedAt: "2026-03-30T00:00:00.000Z",
        }),
        debit("event:test:1", "1200", "2026-03-15", {
          revision: 2,
          commit: 20,
          recordedAt: "2026-03-01T00:00:00.000Z",
        }),
      ]),
    });
    expect(cell(state).gaps).not.toContain("revision_chain_inconsistent");
    expect(text(cell(state).reconstructed)).toBe("8800");
  });

  test("a successor committed before its predecessor makes the chain inconsistent", () => {
    const state = run({
      set: eventSet([
        debit("event:test:1", "1000", "2026-03-15", { supersededBy: "event:test:1@2", commit: 30 }),
        debit("event:test:1", "1200", "2026-03-15", { revision: 2, commit: 20 }),
      ]),
    });
    expect(cell(state).gaps).toContain("revision_chain_inconsistent");
    expect(cell(state).needsReview).toBe(true);
  });

  test("a revision without a history position is knowledge_unlogged, and so is its event", () => {
    const state = run({
      set: eventSet([
        debit("event:test:1", "1000", "2026-03-15", { supersededBy: "event:test:1@2" }),
        debit("event:test:1", "1200", "2026-03-15", { revision: 2, commit: null }),
      ]),
    });
    const jpy = cell(state);
    expect(disposition(state, "event:test:1@1#0")).toBe("knowledge_unlogged");
    expect(disposition(state, "event:test:1@2#0")).toBe("knowledge_unlogged");
    expect(reason(jpy.reconstructed)).toBe("knowledge_unlogged");
    expect(jpy.needsReview).toBe(false);
  });

  test("an account correction moves the movement; the old revision never revives", () => {
    const set = eventSet([
      debit("event:test:1", "1000", "2026-03-15", { supersededBy: "event:test:1@2" }),
      rev({ revision: 2, commit: 20, legs: [leg({ accountId: B, quantity: q("JPY", "1000") })] }),
    ]);
    const state = run({
      set,
      request: { accountIds: [A, B] },
      start: side(START_DATE, [balance(), balance({ ref: "balance:test:b", accountId: B })]),
      end: side(END_DATE, [
        endBalance("10000"),
        endBalance("9000", { ref: "balance:test:b-end", accountId: B }),
      ]),
    });
    expect(text(cell(state, A).reconstructed)).toBe("10000");
    expect(cell(state, A).ignored.superseded_at_knowledge_time).toBe(1);
    expect(text(cell(state, B).reconstructed)).toBe("9000");
    const before = run({ set, request: { knowledgeCut: { coreEpoch: EPOCH, commitSeq: 15 } } });
    expect(text(cell(before).reconstructed)).toBe("9000");
  });

  test("a date correction out of the range is outside it; the old date never revives", () => {
    const state = run({
      set: eventSet([
        debit("event:test:1", "1000", "2026-03-15", { supersededBy: "event:test:1@2" }),
        debit("event:test:1", "1000", "2026-04-10", { revision: 2, commit: 20 }),
      ]),
    });
    expect(disposition(state, "event:test:1@1#0")).toBe("superseded_at_knowledge_time");
    expect(disposition(state, "event:test:1@2#0")).toBe("outside_range");
    expect(text(cell(state).reconstructed)).toBe("10000");
  });

  test("a dateless withdrawal still supersedes the acceptance it withdraws", () => {
    const state = run({
      set: eventSet([
        debit("event:test:1", "1000", "2026-03-15", {
          revision: 2,
          supersededBy: "event:test:1@3",
        }),
        rev({
          revision: 3,
          state: "unknown",
          unknownReason: "conflicting_evidence",
          times: [],
          commit: 20,
        }),
      ]),
    });
    expect(disposition(state, "event:test:1@2#0")).toBe("superseded_at_knowledge_time");
    expect(text(cell(state).reconstructed)).toBe("10000");
  });

  test("a settlement accepted at revision 2 and withdrawn at 3, before and after the withdrawal", () => {
    const set = eventSet([
      debit("event:test:1", "3000", "2026-03-15", { revision: 2, supersededBy: "event:test:1@3" }),
      rev({ revision: 3, state: "unknown", unknownReason: "conflicting_evidence", commit: 60 }),
    ]);
    const before = run({ set, request: { knowledgeCut: { coreEpoch: EPOCH, commitSeq: 50 } } });
    expect(disposition(before, "event:test:1@2#0")).toBe("applied");
    expect(text(cell(before).reconstructed)).toBe("7000");
    const after = run({ set, baselineCut: 50 });
    expect(disposition(after, "event:test:1@2#0")).toBe("superseded_at_knowledge_time");
    expect(disposition(after, "event:test:1@3")).toBe("state_no_effect");
    expect(text(cell(after).reconstructed)).toBe("10000");
    expect(text(cell(after).explanation.lateRecorded!.total)).toBe("3000");
  });

  test("a cross-event merge counts once, and its split restores the posted event", () => {
    const pending = (fields: RevisionFields) =>
      rev({
        eventId: "event:test:pending",
        kind: "purchase",
        legs: [leg({ quantity: q("JPY", "500") })],
        ...fields,
      });
    const posted = (fields: RevisionFields) =>
      rev({
        eventId: "event:test:posted",
        kind: "purchase",
        legs: [leg({ quantity: q("JPY", "500") })],
        ...fields,
      });
    const merged = [
      pending({ state: "authorized", supersededBy: "event:test:pending@2" }),
      posted({ state: "captured", commit: 11, supersededBy: "event:test:pending@2" }),
      pending({ revision: 2, state: "captured", commit: 20 }),
    ];
    const beforeMerge = run({
      set: eventSet(merged),
      request: { knowledgeCut: { coreEpoch: EPOCH, commitSeq: 15 } },
    });
    expect(cell(beforeMerge).applied.count).toBe(1);
    expect(cell(beforeMerge).pending.count).toBe(1);
    const afterMerge = cell(run({ set: eventSet(merged) }));
    expect(afterMerge.applied.refs).toEqual(["event:test:pending@2#0"]);
    expect(afterMerge.pending.count).toBe(0);
    expect(text(afterMerge.reconstructed)).toBe("9500");
    const split = [
      ...merged.slice(0, 2),
      pending({
        revision: 2,
        state: "captured",
        commit: 20,
        supersededBy: "event:test:pending@3",
      }),
      pending({
        revision: 3,
        state: "unknown",
        unknownReason: "conflicting_evidence",
        legs: [],
        commit: 30,
      }),
      posted({ revision: 2, state: "captured", commit: 30 }),
    ];
    const afterSplit = cell(run({ set: eventSet(split) }));
    expect(afterSplit.applied.refs).toEqual(["event:test:posted@2#0"]);
    expect(text(afterSplit.reconstructed)).toBe("9500");
  });

  test("two live revisions or a cycle make the chain inconsistent, never summed", () => {
    const twoLive = run({
      set: eventSet([
        debit("event:test:1", "1000", "2026-03-15"),
        debit("event:test:1", "1000", "2026-03-15", { revision: 2 }),
      ]),
    });
    expect(cell(twoLive).gaps).toContain("revision_chain_inconsistent");
    expect(cell(twoLive).applied.count).toBe(0);
    expect(cell(twoLive).reconstructed.value.status).toBe("missing");
    const cycleSet = eventSet([
      debit("event:test:1", "1000", "2026-03-15", { supersededBy: "event:test:2@1" }),
      debit("event:test:2", "1000", "2026-03-15", { supersededBy: "event:test:1@1" }),
    ]);
    expect(cell(run({ set: cycleSet })).gaps).toContain("revision_chain_inconsistent");
    expect(select(cycleSet, CUT).inconsistentEvents).toEqual(["event:test:1", "event:test:2"]);
  });

  test("an input resolved by the adapter is only checked for one revision per event", () => {
    const resolved = eventSet(
      [
        debit("event:test:1", "1000", "2026-03-15", {
          revision: 2,
          supersededBy: "event:test:1@9",
        }),
      ],
      { resolution: "resolved-at-cut" },
    );
    expect(text(cell(run({ set: resolved })).reconstructed)).toBe("9000");
    const twice = eventSet(
      [
        debit("event:test:1", "1000", "2026-03-15"),
        debit("event:test:1", "1000", "2026-03-15", { revision: 2 }),
      ],
      { resolution: "resolved-at-cut" },
    );
    expect(cell(run({ set: twice })).gaps).toContain("revision_chain_inconsistent");
  });

  test("a later inconsistency does not reach an earlier cut", () => {
    const set = eventSet([
      debit("event:test:1", "1000", "2026-03-15"),
      debit("event:test:1", "1000", "2026-03-15", { revision: 2, commit: 150 }),
    ]);
    expect(cell(run({ set })).applied.count).toBe(1);
    expect(
      cell(run({ set, request: { knowledgeCut: { coreEpoch: EPOCH, commitSeq: 200 } } })).gaps,
    ).toContain("revision_chain_inconsistent");
  });

  test("the selector resolves before it filters and reports every revision", () => {
    const selection = select(
      eventSet([
        debit("event:test:1", "1000", "2026-03-15", { supersededBy: "event:test:1@2" }),
        debit("event:test:1", "1000", "2026-09-15", { revision: 2, commit: 20 }),
      ]),
      CUT,
    );
    expect(
      selection.revisions.map((row) => [row.revision.revision, row.status, row.supersededAtCutBy]),
    ).toEqual([
      [1, "superseded_at_cut", "event:test:1@2"],
      [2, "active", null],
    ]);
  });
});

describe("claims", () => {
  test("two active events holding one (book, key) are both marked conflicts", () => {
    const claim = { book: "cash-movement" as const, key: "movement:test:k" };
    const state = run({
      set: eventSet([
        debit("event:test:1", "1000", "2026-03-15", { claims: [claim] }),
        debit("event:test:2", "1000", "2026-03-16", { claims: [claim] }),
      ]),
    });
    const jpy = cell(state);
    expect(jpy.gaps).toContain("duplicate_claim");
    expect(jpy.needsReview).toBe(true);
    expect(jpy.reconstructed.value.status).toBe("missing");
    expect(
      state.dispositions.filter((row) => row.conflict === "duplicate_claim").map((row) => row.ref),
    ).toEqual(["event:test:1@1#0", "event:test:2@1#0"]);
  });

  test("one key in two books, or one cited evidence id, is not a duplicate", () => {
    const state = run({
      set: eventSet([
        debit("event:test:1", "1000", "2026-03-15", {
          claims: [{ book: "cash-movement", key: "k" }],
          evidenceIds: ["transaction:test:1"],
        }),
        debit("event:test:2", "1000", "2026-03-16", {
          claims: [{ book: "card-usage", key: "k" }],
          evidenceIds: ["transaction:test:1"],
        }),
      ]),
    });
    expect(cell(state).gaps).not.toContain("duplicate_claim");
    expect(text(cell(state).reconstructed)).toBe("8000");
  });

  test("a holder that was superseded by the cut is no longer a holder", () => {
    const claim = { book: "cash-movement" as const, key: "movement:test:k" };
    const state = run({
      set: eventSet([
        debit("event:test:1", "1000", "2026-03-15", {
          claims: [claim],
          supersededBy: "event:test:1@2",
        }),
        rev({ revision: 2, state: "unknown", unknownReason: "conflicting_evidence", commit: 20 }),
        debit("event:test:2", "1000", "2026-03-16", { claims: [claim], commit: 30 }),
      ]),
    });
    expect(cell(state).gaps).not.toContain("duplicate_claim");
    expect(text(cell(state).reconstructed)).toBe("9000");
  });
});

describe("time placement", () => {
  test("a capture at 16:00Z is the next Tokyo day: an event on that day is a boundary", () => {
    const start = side("2026-03-11", [balance({ capturedAt: "2026-03-10T16:00:00.000Z" })]);
    const state = run({
      set: eventSet([
        debit("event:test:1", "100", "2026-03-11"),
        debit("event:test:2", "200", "2026-03-10"),
      ]),
      start,
      request: { startDate: "2026-03-11" },
    });
    const jpy = cell(state);
    expect(disposition(state, "event:test:1@1#0")).toBe("boundary_same_day");
    expect(disposition(state, "event:test:2@1#0")).toBe("outside_range");
    expect(jpy.boundary.atStart).toBe(1);
    expect(text(jpy.reconstructed)).toBe("10000");
  });

  test("an unknown, missing or other-role time is never guessed", () => {
    const state = run({
      set: eventSet([
        rev({
          times: [{ role: "posting", time: { kind: "unknown", reasonCode: "test" } }],
          legs: [leg({ quantity: q("JPY", "1") })],
        }),
        rev({ eventId: "event:test:2", times: [], legs: [leg({ quantity: q("JPY", "1") })] }),
        rev({
          eventId: "event:test:3",
          times: [on("2026-03-15", "usage")],
          legs: [leg({ quantity: q("JPY", "1") })],
        }),
      ]),
    });
    const jpy = cell(state);
    expect(jpy.gaps).toContain("event_time_unknown");
    expect(jpy.unknown.count).toBe(3);
    expect(reason(jpy.reconstructed)).toBe("event_time_unknown");
  });

  test("boundary legs make the comparison a candidate, never reconciled", () => {
    const set = eventSet([debit("event:test:1", "400", END_DATE)]);
    const included = cell(run({ set, end: side(END_DATE, [endBalance("9600")]) }));
    expect(included.boundary.atEnd).toBe(1);
    expect(included.explanation.status).toBe("consistent_with_boundary_inclusion");
    expect(text(included.reconstructed)).toBe("10000");
    const excluded = cell(run({ set }));
    expect(excluded.explanation.status).toBe("consistent_with_boundary_exclusion");
    const neither = cell(run({ set, end: side(END_DATE, [endBalance("9000")]) }));
    expect(neither.explanation.status).toBe("difference_unexplained");
    expect(text(neither.explanation.remainder)).toBe("-1000");
  });
});

describe("explanation", () => {
  test("an account without a reported container is unavailable", () => {
    const state = run({
      set: eventSet([rev({ legs: [leg({ accountId: B, quantity: q("JPY", "10") })] })]),
      request: { accountIds: [B] },
      start: side(START_DATE, [], { accountsWithoutContainer: [B] }),
      end: side(END_DATE, [], { accountsWithoutContainer: [B] }),
    });
    const row = cell(state, B);
    expect(row.explanation.status).toBe("unavailable");
    expect(row.explanation.reasonCode).toBe("no_reported_container");
    expect(row.gaps).toContain("no_start_snapshot");
    expect(row.applied.count).toBe(1);
  });

  test("a missing or inexact end is not comparable", () => {
    const missing = cell(run({ set: eventSet([]), end: side(END_DATE, []) }));
    expect(missing.explanation.reasonCode).toBe("reported_end_missing");
    expect(missing.explanation.remainder.value.status).toBe("missing");
    const inexact = cell(
      run({
        set: eventSet([]),
        end: side(END_DATE, [
          endBalance("0", { quantity: absentQuantity("JPY", "conflict", "test") }),
        ]),
      }),
    );
    expect(inexact.explanation.reasonCode).toBe("reported_end_not_exact");
  });

  test("an unexplained difference is shown exactly and never absorbed", () => {
    const jpy = cell(run({ set: eventSet([]), end: side(END_DATE, [endBalance("10000.5")]) }));
    expect(jpy.explanation.status).toBe("difference_unexplained");
    expect(text(jpy.explanation.remainder)).toBe("0.5");
    expect(text(jpy.reconstructed)).toBe("10000");
  });

  test("nothing is totalled across accounts", () => {
    const state = run({
      set: eventSet([]),
      request: { accountIds: [A, B] },
      start: side(START_DATE, [balance(), balance({ ref: "balance:test:b", accountId: B })]),
    });
    expect(state.netWorth).toBe("not-computed");
    expect(state.cells).toHaveLength(2);
    expect(Object.keys(state)).not.toContain("total");
  });
});

describe("instruments and bases", () => {
  const position = (
    fields: Partial<ReconstructionReportedPosition>,
  ): ReconstructionReportedPosition => ({
    ref: "position:test:start",
    accountId: A,
    instrumentId: ALPHA,
    quantity: q(ALPHA, "1.00000001"),
    snapshotRef: "artifact:test:start",
    capturedAt: START_CAPTURE,
    ...fields,
  });

  test("an instrument quantity folds at eight decimal places on the trade-date basis", () => {
    const state = run({
      set: eventSet([
        rev({
          kind: "transfer",
          state: "credited",
          times: [on("2026-03-15", "trade")],
          legs: [leg({ role: "increase", basis: "trade-date", quantity: q(ALPHA, "0.00000001") })],
        }),
      ]),
      request: { basis: "trade-date" },
      start: side(START_DATE, [], { positions: [position({})] }),
      end: side(END_DATE, [], {
        positions: [
          position({
            ref: "position:test:end",
            quantity: q(ALPHA, "1.00000002"),
            capturedAt: END_CAPTURE,
          }),
        ],
      }),
    });
    const alpha = cell(state, A, ALPHA);
    expect(alpha.measure).toBe("position");
    expect(text(alpha.reconstructed)).toBe("1.00000002");
    // No container says which basis its quantity reflects (ADR 0004).
    expect(alpha.explanation.reasonCode).toBe("snapshot_basis_unknown");
    expect(alpha.explanation.remainder.value.status).toBe("missing");
  });

  test("a trade movement and its settlement correspondence are never both applied", () => {
    const set = eventSet([
      rev({
        kind: "transfer",
        state: "credited",
        times: [on("2026-03-13", "trade"), on("2026-03-15", "settlement")],
        legs: [
          leg({ role: "increase", basis: "trade-date", quantity: q(ALPHA, "3") }),
          leg({
            legIndex: 1,
            effect: "correspondence",
            role: "increase",
            ofLegIndex: 0,
            basis: "settlement-date",
            quantity: q(ALPHA, "3"),
          }),
        ],
      }),
    ]);
    const start = side(START_DATE, [], { positions: [position({ quantity: q(ALPHA, "10") })] });
    const trade = cell(run({ set, start, request: { basis: "trade-date" } }), A, ALPHA);
    expect(trade.applied.count).toBe(1);
    expect(text(trade.reconstructed)).toBe("13");
    const settlement = cell(run({ set, start, request: { basis: "settlement-date" } }), A, ALPHA);
    expect(settlement.applied.count).toBe(0);
    expect(settlement.ignored.correspondence_link).toBe(1);
    expect(text(settlement.reconstructed)).toBe("10");
    const cash = run({ set, start });
    expect(cash.dispositions.every((row) => row.disposition === "other_basis")).toBe(true);
  });

  test("an unidentified instrument is never matched to a leg", () => {
    const state = run({
      set: eventSet([]),
      start: side(START_DATE, [balance()], {
        positions: [position({ instrumentId: null, quantity: q("unit:test:unknown", "5") })],
      }),
    });
    const row = state.cells.find((item) => item.unidentifiedRef === "position:test:start")!;
    expect(row.gaps).toContain("instrument_not_identified");
    expect(row.reconstructed.value.status).toBe("missing");
  });
});

describe("refusals, determinism and the manifest", () => {
  test("an input over the budget is refused, never cut", () => {
    const revisions = Array.from({ length: RECONSTRUCTION_BUDGET.revisions + 1 }, (_, index) =>
      rev({ eventId: `event:test:${index}` }),
    );
    const refused = selectKnowledge(eventSet(revisions), { coreEpoch: EPOCH, commitSeq: CUT });
    expect(!refused.ok && refused.error.code).toBe("event_budget_exceeded");
  });

  test("unknown keys, another policy and a tampered selection are refused", () => {
    const withExtra = { ...eventSet([]), extra: 1 } as unknown as ProvisionalAdoptedEventSet;
    expect(selectKnowledge(withExtra, { coreEpoch: EPOCH, commitSeq: CUT }).ok).toBe(false);
    const legExtra = eventSet([
      rev({
        legs: [{ ...leg({ quantity: q("JPY", "1") }), note: "x" } as unknown as ProvisionalLeg],
      }),
    ]);
    expect(selectKnowledge(legExtra, { coreEpoch: EPOCH, commitSeq: CUT }).ok).toBe(false);
    const cutExtra = selectKnowledge(eventSet([]), {
      coreEpoch: EPOCH,
      commitSeq: CUT,
      at: 1,
    } as never);
    expect(!cutExtra.ok && cutExtra.error.code).toBe("invalid_knowledge_cut");
    const selection = select(eventSet([debit("event:test:1", "1", "2026-03-15")]), CUT);
    const base = {
      request: request(),
      policy: RECONSTRUCTION_FOLD_V1,
      start: side(START_DATE, [balance()]),
      end: side(END_DATE, [endBalance("10000")]),
      selection,
      baseline: null,
    };
    const changedPolicy = structuredClone(RECONSTRUCTION_FOLD_V1);
    changedPolicy.stateEffects.purchase.authorized = "applied";
    const policyRefusal = reconstructState({ ...base, policy: changedPolicy });
    expect(!policyRefusal.ok && policyRefusal.error.code).toBe("invalid_policy");
    const tampered = structuredClone(selection);
    tampered.revisions[0]!.status = "superseded_at_cut";
    const tamperRefusal = reconstructState({ ...base, selection: tampered });
    expect(!tamperRefusal.ok && tamperRefusal.error.code).toBe("selection_mismatch");
    const otherCut = reconstructState({
      ...base,
      request: request({ knowledgeCut: { coreEpoch: EPOCH, commitSeq: CUT + 1 } }),
    });
    expect(!otherCut.ok && otherCut.error.code).toBe("selection_mismatch");
    const requestExtra = reconstructState({
      ...base,
      request: { ...request(), netWorth: true } as unknown as ReconstructionRequest,
    });
    expect(!requestExtra.ok && requestExtra.error.code).toBe("invalid_request");
    const wrongDate = reconstructState({ ...base, start: side("2026-03-02", [balance()]) });
    expect(!wrongDate.ok && wrongDate.error.code).toBe("invalid_start_snapshot");
  });

  test("any input order gives the same output and context id", async () => {
    const revisions = [
      debit("event:test:1", "1000", "2026-03-15", { supersededBy: "event:test:1@2" }),
      debit("event:test:1", "1200", "2026-03-15", { revision: 2, commit: 60 }),
      debit("event:test:2", "300", "2026-03-20"),
      rev({
        eventId: "event:test:3",
        kind: "purchase",
        state: "authorized",
        legs: [leg({ quantity: q("JPY", "50") })],
      }),
    ];
    const balances = [balance(), balance({ ref: "balance:test:b", accountId: B })];
    const first = run({
      set: eventSet(revisions),
      request: { accountIds: [A, B] },
      start: side(START_DATE, balances),
      baselineCut: 50,
    });
    const second = run({
      set: eventSet([...revisions].reverse(), {
        familyCoverage: [...eventSet([]).familyCoverage].reverse(),
        historyCoverage: [...eventSet([]).historyCoverage].reverse(),
      }),
      request: { accountIds: [B, A] },
      start: side(START_DATE, [...balances].reverse()),
      baselineCut: 50,
    });
    expect(canonicalJson(second)).toBe(canonicalJson(first));
    const contextId = await canonicalDigest(first.manifest);
    expect(await canonicalDigest(second.manifest)).toBe(contextId);
    expect(await sha256Hex(canonicalReconstructionManifest(first.manifest))).toBe(contextId);
    expect(first.manifest).toMatchObject({
      schemaVersion: "reconstructed-state-v1",
      engineRelease: "reconstruction-engine-v1",
      inputContract: "provisional-adopted-events-v1",
      policies: ["reconstruction-fold-v1"],
      accountIds: [A, B],
      knowledgeCut: { coreEpoch: EPOCH, commitSeq: CUT },
      baselineCut: { coreEpoch: EPOCH, commitSeq: 50 },
      eventSetVersion: "set:test:1",
      identityRelease: "identity:test:1",
      evidenceAliasRelease: "alias:test:1",
      coverageRelease: "coverage:test:1",
      fxReferenceRef: null,
      startContextId: `context:test:${START_DATE}`,
    });
    const later = run({
      set: eventSet(revisions),
      request: { knowledgeCut: { coreEpoch: EPOCH, commitSeq: CUT + 1 } },
    });
    expect(await canonicalDigest(later.manifest)).not.toBe(contextId);
  });
});

describe("history epochs and exported names", () => {
  test("a cut names its epoch; a commit of another epoch cannot be placed", () => {
    const bare = selectKnowledge(eventSet([]), { commitSeq: CUT } as never);
    expect(!bare.ok && bare.error.code).toBe("invalid_knowledge_cut");
    const restored = rev({ legs: [leg({ quantity: q("JPY", "100") })] });
    restored.commitRef = { coreEpoch: "epoch:test:2", commitSeq: 5 };
    const state = run({ set: eventSet([restored]) });
    expect(disposition(state, "event:test:1@1#0")).toBe("knowledge_unlogged");
    expect(reason(cell(state).reconstructed)).toBe("knowledge_unlogged");
    const other = selectKnowledge(eventSet([]), { coreEpoch: "epoch:test:2", commitSeq: 200 });
    const late = explainLate(ok(other).selection, select(eventSet([]), CUT));
    expect(!late.ok && late.error.code).toBe("baseline_mismatch");
  });

  test("no runtime name collides with the common contract's", async () => {
    const exported = Object.keys(await import("../src/reconstruction.ts"));
    for (const name of ["BOOKS", "LEG_EFFECTS", "EVENT_TIME_ROLES", "CLAIM_BOOKS"])
      expect(exported).not.toContain(name);
  });
});

describe("signs", () => {
  test("a negative movement is never negated twice: its sign is unknown", () => {
    const state = run({ set: eventSet([rev({ legs: [leg({ quantity: q("JPY", "-100") })] })]) });
    const jpy = cell(state);
    expect(disposition(state, "event:test:1@1#0")).toBe("unknown_effect");
    expect(jpy.gaps).toContain("leg_sign_unknown");
    expect(reason(jpy.reconstructed)).toBe("leg_sign_unknown");
  });

  test("a negative breakdown is refused the same way; zero is a value", () => {
    const state = run({
      set: eventSet([
        rev({
          legs: [
            leg({ quantity: q("JPY", "0") }),
            leg({
              legIndex: 1,
              effect: "breakdown",
              role: "fee",
              ofLegIndex: 0,
              quantity: q("JPY", "-1"),
            }),
          ],
        }),
      ]),
    });
    expect(disposition(state, "event:test:1@1#0")).toBe("applied");
    expect(disposition(state, "event:test:1@1#1")).toBe("unknown_effect");
    expect(cell(state).gaps).toContain("leg_sign_unknown");
  });
});

describe("placement before holds", () => {
  test("an own transfer dated after the window is outside it, not held", () => {
    const state = run({
      set: eventSet([
        rev({
          kind: "transfer",
          times: [on("2026-04-20")],
          legs: [
            leg({ quantity: q("JPY", "100") }),
            leg({ legIndex: 1, accountId: B, role: "increase", quantity: q("JPY", "100") }),
          ],
        }),
      ]),
      request: { accountIds: [A, B] },
      start: side(START_DATE, [balance(), balance({ ref: "balance:test:b", accountId: B })]),
      end: side(END_DATE, [
        endBalance("10000"),
        endBalance("10000", { ref: "balance:test:b-end", accountId: B }),
      ]),
    });
    for (const accountId of [A, B]) {
      expect(cell(state, accountId).gaps).toEqual([]);
      expect(cell(state, accountId).explanation.status).toBe("reconciled");
    }
    expect(disposition(state, "event:test:1@1#0")).toBe("outside_range");
  });

  test("an unmapped state dated before the window is outside it", () => {
    const state = run({
      set: eventSet([
        rev({
          kind: "charge",
          state: "issued",
          times: [on("2025-01-01")],
          legs: [leg({ quantity: q("JPY", "1") })],
        }),
      ]),
    });
    expect(disposition(state, "event:test:1@1#0")).toBe("outside_range");
    expect(cell(state).partition).toBe("complete");
  });

  test("a movement no account resolves, dated before the window, blocks nothing", () => {
    const state = run({
      set: eventSet([
        rev({
          times: [on("2025-01-01")],
          legs: [leg({ accountId: null, quantity: q("JPY", "1") })],
        }),
      ]),
    });
    expect(cell(state).gaps).toEqual([]);
    expect(disposition(state, "event:test:1@1#0")).toBe("outside_range");
  });

  test("chain, knowledge and adapter blocks do not depend on the date", () => {
    const flagged = run({
      set: eventSet([debit("event:test:1", "1", "2025-01-01", { flags: ["writer_unsupported"] })]),
    });
    expect(cell(flagged).gaps).toContain("writer_unsupported");
    const unlogged = run({
      set: eventSet([debit("event:test:1", "1", "2025-01-01", { commit: null })]),
    });
    expect(cell(unlogged).gaps).toContain("knowledge_unlogged");
  });
});
