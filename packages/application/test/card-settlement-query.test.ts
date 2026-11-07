import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  CARD_SETTLEMENT_DEBIT_ACCOUNT_SQL,
  CARD_SETTLEMENT_PAGE_SQL,
  CARD_SETTLEMENT_REVIEW_SQL,
  queryCardSettlements,
} from "../src/query/card-settlements.ts";
import { LEGACY_CARD_SETTLEMENT_REVIEWS_SQL } from "./card-settlement-readiness-legacy-sql.ts";
import { settlementFacts } from "./card-settlement-fixture.ts";
import { CARD_DEBIT_ACCOUNT_POLICY } from "../../domain/src/card-debit-account.ts";
import { CARD_INFORMATION_READER_VERSION } from "../../domain/src/myjcb-card-information.ts";
import type { SqlExecutor } from "../../read-model/src/reader.ts";

const databases: Database[] = [];
function store() {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(`CREATE TABLE card_settlement_reviews(id TEXT,facts_json TEXT,revision INTEGER,status TEXT,
    decision_revision_id TEXT,event_id TEXT,obligation_id TEXT,settlement_id TEXT,created_at TEXT);
    CREATE VIEW card_settlement_readiness AS SELECT id,1 AS statement_current,1 AS bank_current,1 AS ownership_current,1 AS allocation_available FROM card_settlement_reviews;
    CREATE TABLE card_settlement_decisions(proposal_id TEXT,revision INTEGER,status TEXT,decision_revision_id TEXT,created_at TEXT);
    CREATE TABLE card_settlement_candidates(id TEXT PRIMARY KEY,statement_parse_run_id INTEGER,facts_json TEXT);
    CREATE TABLE card_settlement_debit_account_evidence(id INTEGER PRIMARY KEY,candidate_id TEXT,statement_id INTEGER,
      policy TEXT,outcome TEXT,reason TEXT,proposal_json TEXT,created_at TEXT);
    CREATE TABLE parse_runs(id INTEGER PRIMARY KEY,fetch_artifact_id INTEGER);
    CREATE TABLE fetch_artifacts(id INTEGER PRIMARY KEY,sha256 TEXT);
    CREATE TABLE card_debit_account_statement(id INTEGER PRIMARY KEY,raw_sha256 TEXT,card_source_account TEXT,
      reader_version TEXT,outcome TEXT,refusal_code TEXT);`);
  // The stub schema stands in for the readiness view, so the keyed reads run
  // as the shipped text over it; card-settlement-review-differential.test.ts
  // proves the two equal on the complete schema.
  const text = (query: string): string =>
    query === CARD_SETTLEMENT_PAGE_SQL || query === CARD_SETTLEMENT_REVIEW_SQL
      ? LEGACY_CARD_SETTLEMENT_REVIEWS_SQL
      : query;
  const sql: SqlExecutor = {
    async all<T>(query: string, args: readonly unknown[]): Promise<T[]> {
      expect(query.trimStart()).toMatch(/^(?:SELECT|WITH)\b/);
      return db.prepare(text(query)).all(...(args as (string | number | null)[])) as T[];
    },
    async first<T>(query: string, args: readonly unknown[]): Promise<T | null> {
      return db.prepare(text(query)).get(...(args as (string | number | null)[])) as T | null;
    },
  };
  return { db, sql };
}
function insert(
  db: Database,
  id: string,
  unknownOwner = false,
  status = "proposed",
  revision = 0,
  sourceId: "vpass" | "myjcb" = "myjcb",
) {
  const facts = settlementFacts(unknownOwner);
  facts.statement.sourceId = sourceId;
  db.prepare("INSERT INTO card_settlement_reviews VALUES(?,?,?,?,NULL,NULL,NULL,NULL,?)").run(
    id,
    JSON.stringify(facts),
    revision,
    status,
    "2026-09-11T00:00:00Z",
  );
  // The candidate's statement total was parsed by run 1 from artifact 1.
  db.prepare("INSERT INTO card_settlement_candidates VALUES(?,1,?)").run(id, JSON.stringify(facts));
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("card settlement review queries", () => {
  test("unknown ownership remains blocked and no extra cash or purchase is derived", async () => {
    const { db, sql } = store();
    insert(db, "unknown", true);
    const page = await queryCardSettlements(sql);
    expect(page.items[0]?.acceptanceBlockers).toEqual(["owner_not_established"]);
    expect(page.items[0]?.impact).toMatchObject({
      addedCashMovement: { value: { value: { coefficient: "0" } } },
      addedPurchaseExpense: { value: { value: { coefficient: "0" } } },
      allocationState: "proposed",
      netWorthDelta: null,
    });
    expect(page.coverage).toMatchObject({
      completeTransactionHistory: false,
      netAssets: "unknown",
    });
  });
  test("pagination neither drops nor duplicates a candidate", async () => {
    const { db, sql } = store();
    for (let index = 0; index < 51; index++) insert(db, String(index).padStart(2, "0"));
    const first = await queryCardSettlements(sql);
    const second = await queryCardSettlements(sql, { offset: first.nextOffset! });
    expect(first.items).toHaveLength(50);
    expect(second.items).toHaveLength(1);
    expect(second.nextOffset).toBeNull();
    expect(new Set([...first.items, ...second.items].map((row) => row.proposalId)).size).toBe(51);
  });
  test("detail reads the exact candidate and retains withdrawal history without another allocation", async () => {
    const { db, sql } = store();
    insert(db, "one");
    insert(db, "withdrawn", false, "withdrawn", 2);
    db.exec(`INSERT INTO card_settlement_decisions VALUES
      ('withdrawn',1,'accepted','decision-1','2026-09-11T00:00:00Z'),
      ('withdrawn',2,'withdrawn','decision-2','2026-09-12T00:00:00Z');`);
    const page = await queryCardSettlements(sql, { proposalId: "withdrawn" });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.history.map((row) => row.status)).toEqual(["withdrawn", "accepted"]);
    expect(page.items[0]?.impact.liabilityAllocation.value).toMatchObject({
      value: { coefficient: "0" },
    });
    expect((await queryCardSettlements(sql, { proposalId: "missing" })).items).toEqual([]);
  });
  test("malformed facts and invalid offsets fail instead of creating plausible zero values", async () => {
    const { db, sql } = store();
    insert(db, "broken");
    db.exec("UPDATE card_settlement_reviews SET facts_json='{}'");
    await expect(queryCardSettlements(sql)).rejects.toThrow("card_settlement_facts_invalid");
    await expect(queryCardSettlements(sql, { offset: -1 })).rejects.toThrow("invalid_offset");
  });
});

test("fresh publication, ownership and allocation failures block a previously plausible candidate", async () => {
  const { db, sql } = store();
  insert(db, "stale");
  db.exec(`DROP VIEW card_settlement_readiness;
    CREATE VIEW card_settlement_readiness AS SELECT id,0 AS statement_current,0 AS bank_current,0 AS ownership_current,0 AS allocation_available FROM card_settlement_reviews;`);
  const page = await queryCardSettlements(sql);
  expect(page.items[0]?.acceptanceBlockers).toEqual([
    "statement_changed",
    "bank_debit_changed",
    "ownership_changed",
    "allocation_already_used",
  ]);
});
test("history never races ahead of the revision whose status was read", async () => {
  const { db, sql } = store();
  insert(db, "snapshot");
  db.exec(
    "INSERT INTO card_settlement_decisions VALUES('snapshot',1,'rejected','decision-1','2026-09-12')",
  );
  const page = await queryCardSettlements(sql);
  expect(page.items[0]?.revision).toBe(0);
  expect(page.items[0]?.history).toEqual([]);
});

describe("the provider-stated debit account beside each review (ADR 0032)", () => {
  const evidence = (
    db: Database,
    candidate: string,
    outcome: string,
    reason: string | null,
    proposal: object | null,
    policy = CARD_DEBIT_ACCOUNT_POLICY,
  ) =>
    db
      .prepare(
        "INSERT INTO card_settlement_debit_account_evidence(candidate_id,statement_id,policy,outcome,reason,proposal_json,created_at) VALUES(?,1,?,?,?,?,'2026-09-12T00:00:00Z')",
      )
      .run(candidate, policy, outcome, reason, proposal === null ? null : JSON.stringify(proposal));
  const proposal = (bankSourceAccount: string) => ({
    policy: CARD_DEBIT_ACCOUNT_POLICY,
    status: "proposed",
    cardSourceId: "myjcb",
    cardSourceAccount: "synthetic-card",
    bankSourceId: "sony-bank",
    bankSourceAccount,
    evidenceRefs: [],
    visibleDigitCount: 4,
    rationaleCodes: [],
    rejectionConditions: [],
  });
  const reading = (db: Database, code: string, version: string) => {
    db.exec(
      "INSERT OR IGNORE INTO parse_runs VALUES(1,1); INSERT OR IGNORE INTO fetch_artifacts VALUES(1,'synthetic-sha');",
    );
    db.prepare(
      "INSERT INTO card_debit_account_statement(raw_sha256,card_source_account,reader_version,outcome,refusal_code) VALUES('synthetic-sha','synthetic-card',?,'refused',?)",
    ).run(version, code);
  };

  test("a Vpass statement states no debit account, and nothing is read for it", async () => {
    const { db, sql } = store();
    insert(db, "vpass", false, "proposed", 0, "vpass");
    const queries: string[] = [];
    const page = await queryCardSettlements({
      all: (query, args) => {
        queries.push(query);
        return sql.all(query, args);
      },
      first: (query, args) => sql.first(query, args),
    });
    expect(page.items[0]?.debitAccount).toEqual({
      outcome: "not_stated_by_source",
      reason: "source_states_no_debit_account",
      policy: null,
      bankSourceId: null,
      bankSourceAccount: null,
      visibleDigitCount: null,
      recordedAt: null,
    });
    expect(queries).not.toContain(CARD_SETTLEMENT_DEBIT_ACCOUNT_SQL);
  });

  test("a MyJCB candidate shows the newest row under the current policy, else why there is none", async () => {
    const { db, sql } = store();
    for (const id of ["supports", "other", "none", "older", "unread"]) insert(db, id);
    evidence(db, "supports", "names_other_account", null, proposal("synthetic-other"));
    // A later row of the same candidate under the same policy wins.
    evidence(db, "supports", "supports", null, proposal("synthetic-bank"));
    evidence(db, "other", "names_other_account", null, proposal("synthetic-other"));
    evidence(db, "none", "not_proposed", "ambiguous_accounts", null);
    // A row of an earlier policy is not this policy's answer.
    evidence(
      db,
      "older",
      "supports",
      null,
      proposal("synthetic-bank"),
      "card-debit-account-statement-v2",
    );
    const page = await queryCardSettlements(sql);
    const by = new Map(page.items.map((item) => [item.proposalId, item.debitAccount]));
    expect(by.get("supports")).toEqual({
      outcome: "supports",
      reason: null,
      policy: CARD_DEBIT_ACCOUNT_POLICY,
      bankSourceId: "sony-bank",
      bankSourceAccount: "synthetic-bank",
      visibleDigitCount: 4,
      recordedAt: "2026-09-12T00:00:00Z",
    });
    expect(by.get("other")).toMatchObject({
      outcome: "names_other_account",
      bankSourceAccount: "synthetic-other",
    });
    expect(by.get("none")).toMatchObject({
      outcome: "not_proposed",
      reason: "ambiguous_accounts",
      bankSourceId: null,
    });
    for (const id of ["older", "unread"])
      expect(by.get(id)).toMatchObject({ outcome: "not_recorded", reason: null });
    // Evidence never changes what a review is blocked on.
    for (const item of page.items) expect(item.acceptanceBlockers).toEqual([]);

    // A refusal of the page's table under another reader version says
    // nothing; under the current one it is the reason.
    reading(db, "card_information_absent", "myjcb-card-information-0.9.0");
    expect(
      (await queryCardSettlements(sql, { proposalId: "unread" })).items[0]?.debitAccount,
    ).toMatchObject({ outcome: "not_recorded" });
    reading(db, "card_information_table_invalid", CARD_INFORMATION_READER_VERSION);
    expect(
      (await queryCardSettlements(sql, { proposalId: "unread" })).items[0]?.debitAccount,
    ).toMatchObject({ outcome: "statement_refused", reason: "card_information_table_invalid" });
    // A recorded row is the answer whatever the reading says.
    expect(
      (await queryCardSettlements(sql, { proposalId: "supports" })).items[0]?.debitAccount,
    ).toMatchObject({ outcome: "supports" });
  });

  test("a stored row that breaks the evidence contract is an unavailable answer", async () => {
    const cases: [string, string | null, object | null][] = [
      ["supports", null, null],
      ["supports", null, { bankSourceId: "sony-bank" }],
      ["supports", "ambiguous_accounts", proposal("synthetic-bank")],
      ["not_proposed", "invented_reason", null],
      ["not_proposed", "ambiguous_accounts", proposal("synthetic-bank")],
      ["unknown_outcome", null, null],
    ];
    for (const [outcome, reason, stored] of cases) {
      const { db, sql } = store();
      insert(db, "broken");
      evidence(db, "broken", outcome, reason, stored);
      await expect(queryCardSettlements(sql)).rejects.toThrow(
        "card_settlement_debit_account_invalid",
      );
    }
    const { db, sql } = store();
    insert(db, "broken");
    reading(db, "invented_refusal", CARD_INFORMATION_READER_VERSION);
    await expect(queryCardSettlements(sql)).rejects.toThrow(
      "card_settlement_debit_account_invalid",
    );
  });
});
