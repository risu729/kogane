import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  CARD_SETTLEMENT_PAGE_SQL,
  CARD_SETTLEMENT_REVIEW_SQL,
  queryCardSettlements,
} from "../src/query/card-settlements.ts";
import { LEGACY_CARD_SETTLEMENT_REVIEWS_SQL } from "./card-settlement-readiness-legacy-sql.ts";
import { settlementFacts } from "./card-settlement-fixture.ts";
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
    CREATE TABLE candidate_pages(id TEXT PRIMARY KEY,parse_run_id INTEGER);
    CREATE VIEW card_settlement_candidates AS SELECT r.id,coalesce(p.parse_run_id,1) AS statement_parse_run_id,r.facts_json
      FROM card_settlement_reviews r LEFT JOIN candidate_pages p ON p.id=r.id;
    CREATE TABLE parse_runs(id INTEGER PRIMARY KEY,fetch_artifact_id INTEGER);
    CREATE TABLE fetch_artifacts(id INTEGER PRIMARY KEY,sha256 TEXT);
    INSERT INTO parse_runs VALUES(1,1),(2,2);
    INSERT INTO fetch_artifacts VALUES(1,'synthetic-sha-1'),(2,'synthetic-sha-2');
    CREATE TABLE card_debit_account_statement(id INTEGER PRIMARY KEY,raw_sha256 TEXT,card_source_account TEXT,
      reader_version TEXT,outcome TEXT,refusal_code TEXT);
    CREATE TABLE card_settlement_debit_account_evidence(id INTEGER PRIMARY KEY,candidate_id TEXT,statement_id INTEGER,
      policy TEXT,outcome TEXT,reason TEXT,proposal_json TEXT,created_at TEXT);`);
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
function insert(db: Database, id: string, unknownOwner = false, status = "proposed", revision = 0) {
  db.prepare("INSERT INTO card_settlement_reviews VALUES(?,?,?,?,NULL,NULL,NULL,NULL,?)").run(
    id,
    JSON.stringify(settlementFacts(unknownOwner)),
    revision,
    status,
    "2026-09-11T00:00:00Z",
  );
}
/**
 * A `card_debit_account_statement` reading of the synthetic card's page that
 * parse run 1 (or `page`) read, `read` unless a refusal code is given.
 */
function reading(
  db: Database,
  id: number,
  options: { version?: string; refusal?: string; page?: 1 | 2; card?: string } = {},
) {
  db.prepare("INSERT INTO card_debit_account_statement VALUES(?,?,?,?,?,?)").run(
    id,
    `synthetic-sha-${options.page ?? 1}`,
    options.card ?? "synthetic-card",
    options.version ?? CARD_INFORMATION_READER_VERSION,
    options.refusal === undefined ? "read" : "refused",
    options.refusal ?? null,
  );
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

describe("provider-stated debit-account evidence", () => {
  const proposal = JSON.stringify({
    bankSourceId: "smbc-bank",
    bankSourceAccount: "synthetic-bank",
    visibleDigitCount: 4,
  });
  test("the latest row under the current policy is shown, older and other-policy rows are not", async () => {
    const { db, sql } = store();
    insert(db, "myjcb");
    reading(db, 3);
    db.exec(`INSERT INTO card_settlement_debit_account_evidence VALUES
       (1,'myjcb',3,'card-debit-account-statement-v3','not_proposed','no_comparable_bank_account',NULL,'2026-09-10'),
       (2,'myjcb',3,'card-debit-account-statement-v3','supports',NULL,'${proposal}','2026-09-11'),
       (3,'myjcb',3,'card-debit-account-statement-v2','names_other_account',NULL,'${proposal}','2026-09-12');`);
    const [item] = (await queryCardSettlements(sql)).items;
    expect(item?.debitAccount).toEqual({
      outcome: "supports",
      reason: null,
      policy: "card-debit-account-statement-v3",
      statementRef: {
        kind: "typed-claim",
        id: "card_debit_account_statement:3",
        revision: `reader:${CARD_INFORMATION_READER_VERSION}`,
      },
      bankSourceId: "smbc-bank",
      bankSourceAccount: "synthetic-bank",
      visibleDigitCount: 4,
      recordedAt: "2026-09-11",
    });
    // Evidence only: the blockers are the facts' and readiness's, unchanged.
    expect(item?.acceptanceBlockers).toEqual([]);
  });
  test("a closed reason is kept, and no row is a reason by source, never a blank", async () => {
    const { db, sql } = store();
    insert(db, "myjcb", true);
    reading(db, 3);
    db.exec(`INSERT INTO card_settlement_debit_account_evidence VALUES
       (1,'myjcb',3,'card-debit-account-statement-v3','not_proposed','ambiguous_accounts',NULL,'2026-09-10');`);
    let [item] = (await queryCardSettlements(sql, { proposalId: "myjcb" })).items;
    expect(item?.debitAccount).toMatchObject({
      outcome: "not_proposed",
      reason: "ambiguous_accounts",
    });
    expect(item?.acceptanceBlockers).toEqual(["owner_not_established"]);
    insert(db, "unrecorded");
    [item] = (await queryCardSettlements(sql, { proposalId: "unrecorded" })).items;
    expect(item?.debitAccount).toMatchObject({
      outcome: "absent",
      reason: "evidence_not_recorded",
    });
    const vpass = settlementFacts();
    vpass.statement.sourceId = "vpass";
    db.prepare(
      "INSERT INTO card_settlement_reviews VALUES(?,?,0,'proposed',NULL,NULL,NULL,NULL,?)",
    ).run("vpass", JSON.stringify(vpass), "2026-09-11T00:00:00Z");
    [item] = (await queryCardSettlements(sql, { proposalId: "vpass" })).items;
    expect(item?.debitAccount).toMatchObject({
      outcome: "absent",
      reason: "source_has_no_debit_account_statement",
      statementRef: null,
    });
  });
  test("a malformed evidence row fails the read", async () => {
    const { db, sql } = store();
    insert(db, "myjcb");
    reading(db, 3);
    db.exec(`INSERT INTO card_settlement_debit_account_evidence VALUES
       (1,'myjcb',3,'card-debit-account-statement-v3','supports',NULL,'{}','2026-09-10');`);
    await expect(queryCardSettlements(sql)).rejects.toThrow(
      "card_settlement_debit_account_evidence_invalid",
    );
  });
  test("only a row citing a reading under the current reader version counts, and a later stale row hides none", async () => {
    const { db, sql } = store();
    insert(db, "myjcb");
    insert(db, "stale-only");
    reading(db, 3);
    // The same page read by an earlier reader version.
    reading(db, 4, { version: "myjcb-card-information-0.9.0" });
    db.exec(`INSERT INTO card_settlement_debit_account_evidence VALUES
       (1,'myjcb',3,'card-debit-account-statement-v3','supports',NULL,'${proposal}','2026-09-10'),
       (2,'myjcb',4,'card-debit-account-statement-v3','names_other_account',NULL,'${proposal}','2026-09-11'),
       (3,'stale-only',4,'card-debit-account-statement-v3','supports',NULL,'${proposal}','2026-09-12');`);
    let [item] = (await queryCardSettlements(sql, { proposalId: "myjcb" })).items;
    expect(item?.debitAccount).toMatchObject({
      outcome: "supports",
      statementRef: { id: "card_debit_account_statement:3" },
      recordedAt: "2026-09-10",
    });
    [item] = (await queryCardSettlements(sql, { proposalId: "stale-only" })).items;
    expect(item?.debitAccount).toMatchObject({
      outcome: "absent",
      reason: "evidence_not_recorded",
      statementRef: null,
    });
  });
  test("a page the lane refused under the current reader version is absent with its refusal code", async () => {
    const { db, sql } = store();
    insert(db, "refused");
    insert(db, "old-refusal");
    insert(db, "other-page");
    insert(db, "other-card");
    db.exec(
      `INSERT INTO candidate_pages VALUES('old-refusal',2),('other-page',2),('other-card',2)`,
    );
    reading(db, 3, { refusal: "card_information_table_invalid" });
    // Page 2: refused only by an earlier reader, or for another card.
    reading(db, 4, { page: 2, version: "myjcb-card-information-0.9.0", refusal: "page_not_utf8" });
    reading(db, 5, { page: 2, card: "synthetic-other-card", refusal: "page_not_utf8" });
    const page = await queryCardSettlements(sql);
    const reason = (id: string) => page.items.find((item) => item.proposalId === id)?.debitAccount;
    expect(reason("refused")).toEqual({
      outcome: "absent",
      reason: "card_information_table_invalid",
      policy: "card-debit-account-statement-v3",
      statementRef: null,
      bankSourceId: null,
      bankSourceAccount: null,
      visibleDigitCount: null,
      recordedAt: null,
    });
    for (const id of ["old-refusal", "other-page", "other-card"])
      expect(reason(id)).toMatchObject({ outcome: "absent", reason: "evidence_not_recorded" });
    // Evidence only: the refusal adds no blocker.
    expect(page.items.every((item) => item.acceptanceBlockers.length === 0)).toBe(true);
  });
  test("a current row wins over a refusal of the candidate's own page", async () => {
    // The sweep cites only the candidate's own page, so this pair does not
    // arise from it; the trigger still admits a row citing another page's
    // reading of the same card, and the row is the answer.
    const { db, sql } = store();
    insert(db, "both");
    reading(db, 3, { page: 2 });
    reading(db, 4, { refusal: "card_information_absent" });
    db.exec(`INSERT INTO card_settlement_debit_account_evidence VALUES
       (1,'both',3,'card-debit-account-statement-v3','supports',NULL,'${proposal}','2026-09-10');`);
    const [item] = (await queryCardSettlements(sql, { proposalId: "both" })).items;
    expect(item?.debitAccount).toMatchObject({
      outcome: "supports",
      statementRef: { id: "card_debit_account_statement:3" },
    });
  });
  test("an unknown refusal code fails the read instead of passing as a reason", async () => {
    const { db, sql } = store();
    insert(db, "refused");
    reading(db, 3, { refusal: "card_information_invented" });
    await expect(queryCardSettlements(sql)).rejects.toThrow(
      "card_settlement_debit_account_evidence_invalid",
    );
  });
});
