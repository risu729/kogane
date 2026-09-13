import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { queryCardSettlements } from "../src/query/card-settlements.ts";
import { settlementFacts } from "./card-settlement-fixture.ts";
import type { SqlExecutor } from "../../read-model/src/reader.ts";

const databases: Database[] = [];
function store() {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(`CREATE TABLE card_settlement_reviews(id TEXT,facts_json TEXT,revision INTEGER,status TEXT,
    decision_revision_id TEXT,event_id TEXT,obligation_id TEXT,settlement_id TEXT,created_at TEXT);
    CREATE VIEW card_settlement_readiness AS SELECT id,1 AS statement_current,1 AS bank_current,1 AS ownership_current,1 AS allocation_available FROM card_settlement_reviews;
    CREATE TABLE card_settlement_decisions(proposal_id TEXT,revision INTEGER,status TEXT,decision_revision_id TEXT,created_at TEXT);`);
  const sql: SqlExecutor = {
    async all<T>(query: string, args: readonly unknown[]): Promise<T[]> {
      expect(query.trimStart().startsWith("SELECT")).toBe(true);
      return db.prepare(query).all(...(args as (string | number | null)[])) as T[];
    },
    async first<T>(query: string, args: readonly unknown[]): Promise<T | null> {
      return db.prepare(query).get(...(args as (string | number | null)[])) as T | null;
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
