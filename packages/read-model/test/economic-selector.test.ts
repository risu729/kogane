// The knowledge selector's SQL half (src/economic-selector.ts) with its pure
// half (packages/domain/src/knowledge-selector.ts) over synthetic histories
// written through CORE 0070's triggers (economic-history-fixture.ts): cuts by
// sequence and by instant, corrections that never revive an old revision
// (B1), earlier cuts unchanged by later commits (B2) and history filled later
// (B12), both leg subject forms, legacy holders through the 0070 view,
// revisions the log does not place, identity epochs, conflicts, bounds, and
// every statement's plan without table statistics. Every id, amount and date
// is invented.
import { beforeAll, describe, expect, test } from "bun:test";
import type { KnowledgeCut } from "../../domain/src/economic-contract.ts";
import {
  SELECTOR_BOUNDS,
  selectAdopted,
  type AdoptedSelection,
  type SelectionScope,
} from "../../domain/src/knowledge-selector.ts";
import {
  ACCOUNT_SOURCES_SQL,
  ALIAS_HOLDERS_SQL,
  CLAIMS_SQL,
  COMMIT_AT_SQL,
  COMMITS_SQL,
  ECONOMIC_SELECTOR_PRESENT_SQL,
  EFFECTS_SQL,
  EconomicSelectorError,
  INSTANT_CUT_SQL,
  KEY_HOLDERS_SQL,
  LEGS_SQL,
  LOG_EXTENT_SQL,
  PINS_SQL,
  POINTED_BY_SQL,
  REVISIONS_SQL,
  SEALS_SQL,
  SEED_EVENTS_SQL,
  SELECTOR_EPOCHS_SQL,
  SUBJECTS_SQL,
  TIMES_SQL,
  economicSelectorAvailable,
  loadSelectorRows,
  readSelectorMeta,
  resolveSelectorCut,
  selectorInput,
} from "../src/economic-selector.ts";
import { explain } from "./card-usage-plan";
import { fullCoreSchema } from "./card-usage-scale-fixture";
import { DatedStore } from "./dated-state-fixture";
import { EconomicHistory, day, storeExecutor } from "./economic-history-fixture";

const BANK = "acct-bank";
const OTHER = "acct-other";
const CARD = "acct-card";
const EPOCH = "core-epoch-1";

beforeAll(() => {
  fullCoreSchema().close();
}, 60_000);

function history(): EconomicHistory {
  const h = new EconomicHistory(new DatedStore());
  for (const id of [BANK, OTHER, CARD]) h.account(id);
  return h;
}

const scopeOf = (accounts: string[], fields: Partial<SelectionScope> = {}): SelectionScope => ({
  accounts,
  instruments: null,
  kinds: null,
  legEffects: null,
  basis: null,
  range: null,
  ...fields,
});

async function selectAt(
  h: EconomicHistory,
  cut: KnowledgeCut | null,
  scope: SelectionScope = scopeOf([BANK]),
): Promise<AdoptedSelection> {
  const sql = storeExecutor(h.db);
  const meta = await readSelectorMeta(sql);
  const requested = cut ?? { coreEpoch: EPOCH, commitSeq: meta.log.lastSeq! };
  const resolved = await resolveSelectorCut(sql, meta, requested);
  const rows = await loadSelectorRows(sql, scope);
  const result = await selectAdopted(selectorInput(meta, resolved, scope, rows));
  if (!result.ok) throw new Error(result.error.code);
  return result.selection;
}

const seq = (commitSeq: number) => ({ coreEpoch: EPOCH, commitSeq });
const refs = (selection: AdoptedSelection) =>
  selection.revisions.map((row) => `${row.eventId}@${row.revision}:${row.status}`);

const debit = (subject: string, amount: string) => ({
  subject,
  amount,
  role: "decrease" as const,
  basis: "cash-movement" as const,
});

describe("cuts", () => {
  test("a sequence cut sees exactly the commits at or before it", async () => {
    const h = history();
    h.adopt({
      eventId: "ev-1",
      revision: 1,
      legs: [debit(BANK, "100")],
      knownAt: "2026-03-02T00:00:00.000Z",
    });
    h.adopt({
      eventId: "ev-2",
      revision: 1,
      legs: [debit(BANK, "200")],
      knownAt: "2026-03-03T00:00:00.000Z",
    });
    expect(refs(await selectAt(h, seq(1)))).toEqual(["ev-1@1:active"]);
    expect(refs(await selectAt(h, seq(2)))).toEqual(["ev-1@1:active", "ev-2@1:active"]);
  });

  test("an instant cut takes every commit of an equal instant, and floors a finer instant", async () => {
    const h = history();
    const at = "2026-03-02T00:00:00.000Z";
    h.adopt({ eventId: "ev-1", revision: 1, legs: [debit(BANK, "100")], knownAt: at });
    h.adopt({ eventId: "ev-2", revision: 1, legs: [debit(BANK, "200")], knownAt: at });
    h.adopt({
      eventId: "ev-3",
      revision: 1,
      legs: [debit(BANK, "300")],
      knownAt: "2026-03-02T00:00:00.001Z",
    });
    const equal = await selectAt(h, { coreEpoch: EPOCH, instant: at });
    expect(equal.cut).toEqual(seq(2));
    expect(refs(equal)).toEqual(["ev-1@1:active", "ev-2@1:active"]);
    const finer = await selectAt(h, {
      coreEpoch: EPOCH,
      instant: "2026-03-02T09:00:00.0009+09:00",
    });
    expect(finer.cut).toEqual(seq(2));
    const before = await selectAt(h, { coreEpoch: EPOCH, instant: "2026-03-01T23:59:59.999Z" });
    expect(before.cut).toEqual(seq(0));
    expect(before.coverage).toMatchObject({
      status: "indeterminate",
      reasons: ["cut_before_log_start"],
    });
    expect(before.revisions).toEqual([]);
  });

  test("a cut past the log's end, or of another core epoch, is refused", async () => {
    const h = history();
    h.adopt({ eventId: "ev-1", revision: 1, legs: [debit(BANK, "100")] });
    await expect(selectAt(h, seq(2))).rejects.toThrow(EconomicSelectorError);
    await expect(selectAt(h, { coreEpoch: "core-epoch-0", commitSeq: 1 })).rejects.toThrow(
      "cut_epoch_not_current",
    );
  });

  test("an empty log is indeterminate, never an empty answer", async () => {
    const h = history();
    h.adopt({ eventId: "ev-pre", revision: 1, legs: [debit(BANK, "100")], logged: false });
    const selection = await selectAt(h, { coreEpoch: EPOCH, instant: "2026-03-05T00:00:00.000Z" });
    expect(selection.coverage).toMatchObject({
      status: "indeterminate",
      reasons: ["log_empty", "knowledge_unlogged"],
    });
    expect(refs(selection)).toEqual(["ev-pre@1:knowledge_unlogged"]);
  });
});

describe("B1: after a correction the old revision never returns at any cut", () => {
  test("a date correction and an account correction", async () => {
    const h = history();
    h.adopt({
      eventId: "ev-date",
      revision: 1,
      legs: [debit(BANK, "100")],
      times: [["posting", day("2026-03-05")]],
    });
    h.adopt({
      eventId: "ev-acct",
      revision: 1,
      legs: [debit(BANK, "50")],
      times: [["posting", day("2026-03-06")]],
    });
    h.adopt({
      eventId: "ev-date",
      revision: 2,
      legs: [debit(BANK, "100")],
      times: [["posting", day("2026-04-05")]],
    });
    h.adopt({
      eventId: "ev-acct",
      revision: 2,
      legs: [debit(OTHER, "50")],
      times: [["posting", day("2026-03-06")]],
    });
    h.adopt({ eventId: "ev-later", revision: 1, legs: [debit(BANK, "1")] });
    for (const cut of [1, 2, 3, 4, 5]) {
      const selection = await selectAt(h, seq(cut));
      const seen = refs(selection);
      if (cut >= 3) expect(seen).not.toContain("ev-date@1:active");
      if (cut >= 4) expect(seen).not.toContain("ev-acct@1:active");
      // The moved revision stays in the bank's scope (its chain reached the
      // bank), with its legs on the other account only.
      if (cut >= 4) {
        const moved = selection.revisions.find((row) => row.eventId === "ev-acct")!;
        expect(moved.revision).toBe(2);
        expect(moved.legs.map((leg) => leg.accountId)).toEqual([OTHER]);
      }
    }
    expect(refs(await selectAt(h, seq(2)))).toEqual(["ev-acct@1:active", "ev-date@1:active"]);
  });
});

describe("B2 and B12: later commits leave an earlier cut's answer unchanged", () => {
  test("the set version of a cut is stable; a new cut gives a new result", async () => {
    const h = history();
    h.adopt({
      eventId: "ev-1",
      revision: 1,
      legs: [debit(BANK, "100")],
      knownAt: "2026-03-02T00:00:00.000Z",
    });
    h.adopt({
      eventId: "ev-2",
      revision: 1,
      legs: [debit(BANK, "200")],
      knownAt: "2026-03-03T00:00:00.000Z",
    });
    const before = await selectAt(h, seq(2));
    // A correction of ev-1, a withdrawal of ev-2, and history filled in later.
    h.adopt({
      eventId: "ev-1",
      revision: 2,
      legs: [debit(BANK, "110")],
      knownAt: "2026-03-04T00:00:00.000Z",
    });
    h.adopt({
      eventId: "ev-2",
      revision: 2,
      state: "unknown",
      unknownReason: "conflicting_evidence",
      knownAt: "2026-03-05T00:00:00.000Z",
    });
    h.adopt({
      eventId: "ev-old",
      revision: 1,
      legs: [debit(BANK, "7")],
      times: [["posting", day("2026-01-10")]],
      knownAt: "2026-03-06T00:00:00.000Z",
    });
    const again = await selectAt(h, seq(2));
    expect(again.setVersion).toBe(before.setVersion);
    expect(again).toEqual(before);
    const after = await selectAt(h, seq(5));
    expect(after.setVersion).not.toBe(before.setVersion);
    expect(refs(after)).toEqual(["ev-1@2:active", "ev-2@2:active", "ev-old@1:active"]);
  });
});

describe("subjects, holders and what the log cannot place", () => {
  test("both leg subject forms name the same account; another prefix names none", async () => {
    const h = history();
    h.adopt({ eventId: "ev-prefixed", revision: 1, legs: [debit(`account:${BANK}`, "1")] });
    h.adopt({ eventId: "ev-bare", revision: 1, legs: [debit(BANK, "2")] });
    h.adopt({
      eventId: "ev-claim",
      revision: 1,
      legs: [debit("claim:synthetic", "3"), debit(BANK, "4")],
    });
    const selection = await selectAt(h, null);
    const legs = selection.revisions.flatMap((row) =>
      row.legs.map((leg) => [row.eventId, leg.subjectForm, leg.accountId]),
    );
    expect(legs).toEqual([
      ["ev-bare", "bare-account", BANK],
      ["ev-claim", "unrecognized", null],
      ["ev-claim", "bare-account", BANK],
      ["ev-prefixed", "account-prefixed", BANK],
    ]);
  });

  test("past holders come from the cut's revisions; two holders are a conflict, never washed", async () => {
    const h = history();
    const row = h.bankRow("meisai-0001");
    h.adopt({
      eventId: "ev-a",
      revision: 1,
      legs: [debit(BANK, "100")],
      claims: [{ book: "cash-movement", observationId: row }],
    });
    // The claim is released by a withdrawal, then held again by another event.
    h.adopt({
      eventId: "ev-a",
      revision: 2,
      state: "unknown",
      unknownReason: "conflicting_evidence",
    });
    h.adopt({
      eventId: "ev-b",
      revision: 1,
      legs: [debit(BANK, "100")],
      claims: [{ book: "cash-movement", observationId: row }],
    });
    const atOne = await selectAt(h, seq(1));
    expect(atOne.claims.map((claim) => `${claim.eventId}@${claim.revision}`)).toEqual(["ev-a@1"]);
    const atThree = await selectAt(h, seq(3));
    expect(atThree.claims.map((claim) => `${claim.eventId}@${claim.revision}`)).toEqual(["ev-b@1"]);
    expect(atThree.conflicts).toEqual([]);
  });

  test("a legacy double holder (two pre-log settlements of one debit) is listed with both holders", async () => {
    const h = history();
    const row = h.bankRow("meisai-0002");
    h.adopt({
      eventId: "ev-a",
      revision: 1,
      legs: [debit(BANK, "100")],
      claims: [{ book: "cash-movement", observationId: row }],
    });
    // An older build bypassing the guard: the claim trigger refuses a second
    // live holder, so the second holder is written as the legacy view sees one.
    h.db.exec("DROP TRIGGER economic_claims_one_live_holder");
    h.adopt({
      eventId: "ev-b",
      revision: 1,
      legs: [debit(BANK, "100")],
      claims: [{ book: "cash-movement", observationId: row }],
      logged: false,
    });
    const selection = await selectAt(h, null);
    expect(selection.conflicts).toEqual([
      {
        dimension: "key",
        book: "cash-movement",
        ref: JSON.stringify(h.keyOf(row)),
        holders: ["ev-a@1", "ev-b@1"],
      },
    ]);
    expect(selection.revisions.find((r) => r.eventId === "ev-a")!.flags).toEqual([
      "claim_conflict",
    ]);
    expect(selection.unlogged).toEqual([{ eventId: "ev-b", revision: 1, reasonCode: "no_commit" }]);
  });

  test("a holder out of scope is found by its key, and its conflict reported", async () => {
    const h = history();
    const row = h.bankRow("meisai-0003");
    h.adopt({
      eventId: "ev-in",
      revision: 1,
      legs: [debit(BANK, "100")],
      claims: [{ book: "cash-movement", observationId: row }],
    });
    h.db.exec("DROP TRIGGER economic_claims_one_live_holder");
    h.adopt({
      eventId: "ev-out",
      revision: 1,
      legs: [debit(OTHER, "100")],
      claims: [{ book: "cash-movement", observationId: row }],
      logged: false,
    });
    const selection = await selectAt(h, null);
    expect(refs(selection)).toEqual(["ev-in@1:active"]);
    expect(selection.conflicts[0]!.holders).toEqual(["ev-in@1", "ev-out@1"]);
  });

  test("legacy settlement holders are read through economic_revision_claims", async () => {
    const h = history();
    const statement = h.store.statement({
      card: "card-a",
      period: "2026-03",
      paymentDate: "2026-03-26",
      minor: 1,
      fetchedAt: "2026-03-05T01:00:00Z",
    });
    h.store.identify(statement, "vpass", CARD, "identified");
    const id = h.store.settle(statement, {
      account: CARD,
      period: "2026-03",
      debitDate: "2026-03-26",
      decision: "accepted",
    });
    // The accepted decision names revision 1 of its event; a pre-guard settlement wrote it unlogged.
    h.adopt({ eventId: `event-${id}`, revision: 1, legs: [debit(BANK, "1")], logged: false });
    const rows = await loadSelectorRows(storeExecutor(h.db), { accounts: [BANK] });
    expect(rows.claims).toEqual([
      expect.objectContaining({
        eventId: `event-${id}`,
        revision: 1,
        book: "cash-movement",
        aliasClass: null,
      }),
    ]);
  });

  test("a pre-log revision is unlogged until a logged revision supersedes it; an older build's successor makes the event unlogged", async () => {
    const h = history();
    h.adopt({ eventId: "ev-pre", revision: 1, legs: [debit(BANK, "100")], logged: false });
    h.adopt({ eventId: "ev-log", revision: 1, legs: [debit(BANK, "5")] });
    expect(refs(await selectAt(h, seq(1)))).toEqual([
      "ev-log@1:active",
      "ev-pre@1:knowledge_unlogged",
    ]);
    h.adopt({ eventId: "ev-pre", revision: 2, legs: [debit(BANK, "100")] });
    expect(refs(await selectAt(h, seq(1)))).toEqual([
      "ev-log@1:active",
      "ev-pre@1:knowledge_unlogged",
    ]);
    const replaced = await selectAt(h, seq(2));
    expect(refs(replaced)).toEqual(["ev-log@1:active", "ev-pre@2:active"]);
    expect(replaced.coverage.status).toBe("logged");
    // An older build supersedes ev-log@1 without a commit.
    h.adopt({ eventId: "ev-log", revision: 2, legs: [debit(BANK, "6")], logged: false });
    const rolled = await selectAt(h, seq(2));
    expect(refs(rolled)).toEqual([
      "ev-log@1:knowledge_unlogged",
      "ev-log@2:knowledge_unlogged",
      "ev-pre@2:active",
    ]);
    expect(rolled.unlogged).toEqual([
      { eventId: "ev-log", revision: 1, reasonCode: "successor_unlogged" },
      { eventId: "ev-log", revision: 2, reasonCode: "no_commit" },
    ]);
    expect(rolled.coverage).toMatchObject({ status: "partial", reasons: ["knowledge_unlogged"] });
  });

  test("a seal under an epoch that is no longer current is identity_changed, its claim still held", async () => {
    const h = history();
    const row = h.bankRow("meisai-0004");
    h.adopt({
      eventId: "ev-1",
      revision: 1,
      legs: [debit(BANK, "100")],
      claims: [{ book: "cash-movement", observationId: row }],
      pins: { "account_mapping:sa-synthetic": 0 },
    });
    h.declareEpoch("identity-epoch-2");
    const selection = await selectAt(h, null);
    expect(selection.identityChanged).toEqual([
      { eventId: "ev-1", revision: 1, reasons: ["identity_epoch_changed"] },
    ]);
    expect(selection.revisions[0]!.flags).toEqual(["identity_changed"]);
    expect(selection.claims.map((claim) => claim.eventId)).toEqual(["ev-1"]);
  });

  test("a pinned mapping that moved, and a pin no reader answers, are identity_changed", async () => {
    const h = history();
    h.adopt({
      eventId: "ev-1",
      revision: 1,
      legs: [debit(BANK, "100")],
      pins: { "account_mapping:sa-moved": 3, "ownership:beneficial_owner|acct-bank": 1 },
    });
    const selection = await selectAt(h, null);
    expect(selection.identityChanged).toEqual([
      { eventId: "ev-1", revision: 1, reasons: ["identity_pin_moved", "identity_pin_unreadable"] },
    ]);
  });

  test("a cross-event merge is followed from either side", async () => {
    const h = history();
    h.adopt({ eventId: "ev-x", revision: 1, legs: [debit(BANK, "100")] });
    h.adopt({ eventId: "ev-y", revision: 1, legs: [debit(OTHER, "100")] });
    // ev-y@2 replaces both: ev-x is merged into it.
    h.adopt({
      eventId: "ev-y",
      revision: 2,
      legs: [debit(OTHER, "100")],
      supersedes: [
        { eventId: "ev-y", revision: 1 },
        { eventId: "ev-x", revision: 1 },
      ],
    });
    const selection = await selectAt(h, null);
    // ev-y@2's chain reached the bank through ev-x@1.
    expect(refs(selection)).toEqual(["ev-y@2:active"]);
    expect(selection.revisions[0]!.supersedes).toEqual([
      { eventId: "ev-x", revision: 1 },
      { eventId: "ev-y", revision: 1 },
    ]);
    expect(refs(await selectAt(h, seq(2)))).toEqual(["ev-x@1:active"]);
  });

  test("the scope filters after resolution: kinds, leg effects, basis and range", async () => {
    const h = history();
    h.adopt({
      eventId: "ev-cash",
      revision: 1,
      legs: [debit(BANK, "100")],
      times: [["posting", day("2026-03-05")]],
    });
    h.adopt({
      eventId: "ev-purchase",
      revision: 1,
      kind: "purchase",
      state: "captured",
      legs: [
        {
          subject: `account:${BANK}`,
          amount: "9",
          role: "decrease",
          basis: "purchase-recognition",
        },
      ],
      times: [["usage", day("2026-03-05")]],
    });
    const kinds = await selectAt(h, null, scopeOf([BANK], { kinds: ["purchase"] }));
    expect(refs(kinds)).toEqual(["ev-purchase@1:active"]);
    const basis = await selectAt(
      h,
      null,
      scopeOf([BANK], {
        basis: { legBasis: "cash-movement", timeRole: "posting" },
        range: { from: "2026-03-01", to: "2026-03-31" },
      }),
    );
    expect(refs(basis)).toEqual(["ev-cash@1:active"]);
    const outside = await selectAt(
      h,
      null,
      scopeOf([BANK], {
        basis: { legBasis: "cash-movement", timeRole: "posting" },
        range: { from: "2026-04-01", to: "2026-04-30" },
      }),
    );
    expect(refs(outside)).toEqual([]);
    const effects = await selectAt(h, null, scopeOf([BANK], { legEffects: ["breakdown"] }));
    expect(refs(effects)).toEqual([]);
  });
});

describe("bounds", () => {
  test("more events than the bound is refused, never cut", async () => {
    const h = history();
    const insert = h.db.transaction(() => {
      for (let index = 0; index <= SELECTOR_BOUNDS.events; index += 1) {
        const id = `ev-${index}`;
        h.db.run(
          `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
           VALUES(?,'relation',?,1,'accept','rule','rule:synthetic',NULL,'synthetic','[]',NULL,NULL,'2026-03-01T00:00:00.000Z')`,
          [`dr-${id}`, `event:${id}`],
        );
        h.db.run(
          `INSERT INTO economic_event_revisions VALUES(?,1,'card_settlement','debited',NULL,'{}','cash-movement','["e"]',?,NULL,'2026-03-01T00:00:00.000Z')`,
          [id, `dr-${id}`],
        );
        h.db.run(
          `INSERT INTO economic_legs VALUES(?,1,0,?,'JPY','exact','1',0,NULL,'decrease','cash-movement')`,
          [id, BANK],
        );
      }
    });
    insert();
    await expect(loadSelectorRows(storeExecutor(h.db), { accounts: [BANK] })).rejects.toThrow(
      "selector_bound_exceeded",
    );
  });
});

describe("availability", () => {
  test("a store without CORE 0070 is not available", async () => {
    const h = history();
    expect(await economicSelectorAvailable(storeExecutor(h.db))).toBe(true);
    h.db.exec(
      "DROP VIEW unlogged_economic_revisions; DROP VIEW consumption_claim_conflicts; DROP VIEW live_consumption_claims; DROP VIEW economic_revision_claims",
    );
    expect(await economicSelectorAvailable(storeExecutor(h.db))).toBe(false);
  });
});

describe("plans on the complete CORE schema without statistics", () => {
  const ids = JSON.stringify(["ev-1", "ev-2"]);
  const statements: [string, string, unknown[]][] = [
    ["present", ECONOMIC_SELECTOR_PRESENT_SQL, []],
    ["epochs", SELECTOR_EPOCHS_SQL, []],
    ["extent", LOG_EXTENT_SQL, [EPOCH]],
    ["instant", INSTANT_CUT_SQL, [EPOCH, "2026-03-01T00:00:00.000Z"]],
    ["commit", COMMIT_AT_SQL, [EPOCH, 1]],
    ["seed", SEED_EVENTS_SQL, [JSON.stringify([BANK, `account:${BANK}`]), 10]],
    ["revisions", REVISIONS_SQL, [ids, 10]],
    ["pointed", POINTED_BY_SQL, [JSON.stringify(["ev-1@1"])]],
    ["claims", CLAIMS_SQL, [ids, 10]],
    ["key holders", KEY_HOLDERS_SQL, [JSON.stringify([["cash-movement", "[]"]])]],
    ["alias holders", ALIAS_HOLDERS_SQL, [JSON.stringify([["cash-movement", "[]"]])]],
    ["legs", LEGS_SQL, [ids, 10]],
    ["times", TIMES_SQL, [ids, 10]],
    ["effects", EFFECTS_SQL, [ids, 10]],
    ["seals", SEALS_SQL, [ids, 10]],
    ["commits", COMMITS_SQL, [JSON.stringify([[EPOCH, 1]])]],
    ["subjects", SUBJECTS_SQL, [JSON.stringify([BANK])]],
    ["pins", PINS_SQL, [JSON.stringify(["account_mapping:x"])]],
  ];
  /**
   * The only whole reads allowed: the JSON argument, the schema catalogue, the
   * view's co-routine over its keyed arms, the identity epochs read newest
   * first by rowid (one row), and the materialized key list.
   */
  const ALLOWED = new Set([
    "json_each",
    "s",
    "e",
    "p",
    "k",
    "a",
    "w",
    "sqlite_master",
    "economic_revision_claims",
    "economic_identity_epochs",
    "CONSTANT",
  ]);

  test("the store is what D1 runs: no table statistics", () => {
    const db = fullCoreSchema();
    expect(
      db.query("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'sqlite_stat%'").get(),
    ).toEqual({ n: 0 });
  });

  for (const [name, sql, args] of statements)
    test(`${name} reads by key`, () => {
      const db = fullCoreSchema();
      const steps = explain(db, sql, args);
      const scans = steps
        .filter((step) => step.detail.startsWith("SCAN "))
        .map((step) => step.detail.slice(5).split(" ")[0]!)
        .filter((relation) => !ALLOWED.has(relation));
      expect(scans).toEqual([]);
    });

  test("the account's sources read the mapping table once (no index by account)", () => {
    const db = fullCoreSchema();
    const steps = explain(db, ACCOUNT_SOURCES_SQL, [BANK]);
    const scans = steps
      .filter((step) => step.detail.startsWith("SCAN "))
      .map((step) => step.detail);
    expect(scans.every((detail) => /^SCAN (m|n)\b/u.test(detail))).toBe(true);
    expect(
      steps.some(
        (step) =>
          step.detail.includes("sa USING INDEX") ||
          step.detail.includes("sa USING PRIMARY KEY") ||
          step.detail.includes("SEARCH sa"),
      ),
    ).toBe(true);
  });

  test("the key and alias holder reads use their indexes", () => {
    const db = fullCoreSchema();
    const keys = explain(db, KEY_HOLDERS_SQL, [JSON.stringify([["cash-movement", "[]"]])]).map(
      (step) => step.detail,
    );
    for (const index of [
      "economic_claims_key",
      "card_purchase_recognition_keys_key",
      "card_settlement_candidates_bank",
    ])
      expect(keys.some((detail) => detail.includes(index))).toBe(true);
    const alias = explain(db, ALIAS_HOLDERS_SQL, [JSON.stringify([["cash-movement", "[]"]])]).map(
      (step) => step.detail,
    );
    expect(alias.some((detail) => detail.includes("economic_claims_alias"))).toBe(true);
    const pointed = explain(db, POINTED_BY_SQL, [JSON.stringify(["ev@1"])]).map(
      (step) => step.detail,
    );
    expect(
      pointed.some((detail) => detail.includes("economic_event_revisions_superseded_by")),
    ).toBe(true);
  });
});
