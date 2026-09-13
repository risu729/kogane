import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { queryCardOwnership } from "../src/query/card-ownership.ts";
import { settlementFacts } from "./card-settlement-fixture.ts";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
const databases: Database[] = [];
function fixture() {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(`CREATE TABLE card_settlement_reviews(id TEXT,facts_json TEXT,revision INTEGER,status TEXT);
 CREATE TABLE card_settlement_readiness(id TEXT,statement_current INTEGER,bank_current INTEGER);
 CREATE TABLE current_identity_observations(kind TEXT,observation_id INTEGER,parse_run_id INTEGER,source_account_id TEXT);
 CREATE TABLE current_account_mappings(id TEXT,source_account_id TEXT,account_id TEXT,revision INTEGER);
 CREATE TABLE entity_relations(id TEXT,kind TEXT,from_ref TEXT,to_ref TEXT,status TEXT,valid_from TEXT,valid_to TEXT,evidence_refs_json TEXT,decision_revision_id TEXT);
 CREATE TABLE decision_revisions(id TEXT,superseded_by TEXT);
 INSERT INTO card_settlement_readiness VALUES('one',1,1);
 INSERT INTO current_identity_observations VALUES('balance',11,1,'sa-card'),('transaction',12,2,'sa-bank');
 INSERT INTO current_account_mappings VALUES('mapping-card','sa-card','acct-card',1),('mapping-bank','sa-bank','acct-bank',2);`);
  db.prepare("INSERT INTO card_settlement_reviews VALUES('one',?,0,'proposed')").run(
    JSON.stringify(settlementFacts(true)),
  );
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
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
test("unknown ownership exposes current accounts and exact evidence without a default owner", async () => {
  const { db, sql } = fixture();
  const result = await queryCardOwnership(sql, "one");
  expect(result?.sides[0]).toMatchObject({
    accountId: "acct-card",
    mappingRevision: 1,
    ownershipRevision: 0,
    claims: [],
    blockers: [],
    evidenceRefs: [
      "card-settlement:one",
      "balance:11",
      "parse_run:1",
      "account_mapping:mapping-card",
    ],
  });
  expect(result?.sides[1]?.mappingRevision).toBe(2);
  expect(db.query("SELECT count(*) AS n FROM entity_relations").get()).toEqual({ n: 0 });
  expect(await queryCardOwnership(sql, "missing")).toBeNull();
});
test("changed account mapping and either stale source block an ownership decision", async () => {
  const { db, sql } = fixture();
  db.exec(
    "UPDATE current_account_mappings SET account_id='changed' WHERE source_account_id='sa-card'; UPDATE card_settlement_readiness SET bank_current=0;",
  );
  const result = await queryCardOwnership(sql, "one");
  expect(result?.sides[0]?.blockers).toContain("account_context_changed");
  expect(result?.sides.every((side) => side.blockers.includes("source_changed"))).toBe(true);
});
test("all alias and rejected history counts pin freshness while only latest party claims are displayed", async () => {
  const { db, sql } = fixture();
  db.exec(`INSERT INTO decision_revisions VALUES('d1',NULL),('d2',NULL),('d3',NULL);
 INSERT INTO entity_relations VALUES('r1','liable_party','acct-card','party:本人A','accepted',NULL,NULL,'[]','d1');
 INSERT INTO entity_relations VALUES('r2','liable_party','account:acct-card','party:本人A','rejected',NULL,NULL,'[]','d2');
 INSERT INTO entity_relations VALUES('r3','liable_party','account:acct-card','party:本人B','accepted','2026-01-01',NULL,'[]','d3');`);
  const side = (await queryCardOwnership(sql, "one"))!.sides[0]!;
  expect(side.ownershipRevision).toBe(3);
  expect(side.claims).toHaveLength(2);
  expect(side.claims.map((c) => c.id)).toEqual(["r3", "r2"]);
  expect(side.claims[0]?.validFrom).toBe("2026-01-01");
});
test("ambiguous mappings and terminal candidates remain read-only", async () => {
  const { db, sql } = fixture();
  db.exec(
    "INSERT INTO current_account_mappings VALUES('other','sa-card','other',3); UPDATE card_settlement_reviews SET status='rejected',revision=1;",
  );
  const side = (await queryCardOwnership(sql, "one"))!.sides[0]!;
  expect(side.accountId).toBeNull();
  expect(side.evidenceRefs).toEqual([]);
  expect(side.blockers).toEqual(["candidate_not_proposed", "account_mapping_unresolved"]);
});

test("duplicate current identity rows do not become a falsely unique mapping", async () => {
  const { db, sql } = fixture();
  db.exec("INSERT INTO current_identity_observations VALUES('balance',11,1,'sa-card')");
  const side = (await queryCardOwnership(sql, "one"))!.sides[0]!;
  expect(side.accountId).toBeNull();
  expect(side.blockers).toContain("account_mapping_unresolved");
  expect(side.evidenceRefs).toEqual([]);
});
