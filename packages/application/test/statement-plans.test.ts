// Plans of the card settlement review reads that had none, without table
// statistics (D1 never runs `ANALYZE`).
//
// `queryCardSettlements` and `queryCardOwnership` choose their candidates with
// keyed CTEs whose plans card-settlement-review-differential.test.ts already
// checks; after that each issues statements of its own: a review's decision
// history, the side's account mapping, its ownership claims and relations.
// Those are recorded here as the functions issue them, over the stub stores of
// card-settlement-query.test.ts and card-ownership-query.test.ts (which stand
// in for the readiness view), and explained on every CORE migration. None may
// read a growing table from end to end, except the mapping read the document
// names as a limit.
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { beforeAll, expect, test } from "bun:test";
import { fullCoreDatabase } from "../../storage-d1/test/sqlite.ts";
import { planOf, tableScans } from "../../storage-d1/test/plan-check.ts";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import { CARD_OWNERSHIP_CANDIDATE_SQL, queryCardOwnership } from "../src/query/card-ownership.ts";
import {
  CARD_SETTLEMENT_PAGE_SQL,
  CARD_SETTLEMENT_REVIEW_SQL,
  queryCardSettlements,
} from "../src/query/card-settlements.ts";
import {
  LEGACY_CARD_OWNERSHIP_CANDIDATE_SQL,
  LEGACY_CARD_SETTLEMENT_REVIEWS_SQL,
} from "./card-settlement-readiness-legacy-sql.ts";
import { settlementFacts } from "./card-settlement-fixture.ts";

beforeAll(() => {
  fullCoreDatabase().close();
}, 60_000);

/** The candidate reads, plan-checked elsewhere, run as their stub-schema text. */
const CANDIDATE_READS = new Map([
  [CARD_SETTLEMENT_PAGE_SQL, LEGACY_CARD_SETTLEMENT_REVIEWS_SQL],
  [CARD_SETTLEMENT_REVIEW_SQL, LEGACY_CARD_SETTLEMENT_REVIEWS_SQL],
  [CARD_OWNERSHIP_CANDIDATE_SQL, LEGACY_CARD_OWNERSHIP_CANDIDATE_SQL],
]);

/** An executor over `db` that remembers every other statement it is asked to run. */
function recording(db: Database, issued: Set<string>): SqlExecutor {
  const text = (query: string): string => {
    const stub = CANDIDATE_READS.get(query);
    if (stub === undefined) issued.add(query);
    return stub ?? query;
  };
  return {
    all: async <T>(query: string, args: readonly unknown[]): Promise<T[]> =>
      db.query(text(query)).all(...(args as SQLQueryBindings[])) as T[],
    first: async <T>(query: string, args: readonly unknown[]): Promise<T | null> =>
      (db.query(text(query)).get(...(args as SQLQueryBindings[])) as T | null) ?? null,
  };
}

/** One proposed review whose card side's owner is unknown (card-settlement-query.test.ts). */
function settlementStore(): Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE card_settlement_reviews(id TEXT,facts_json TEXT,revision INTEGER,status TEXT,
    decision_revision_id TEXT,event_id TEXT,obligation_id TEXT,settlement_id TEXT,created_at TEXT);
    CREATE VIEW card_settlement_readiness AS SELECT id,1 AS statement_current,1 AS bank_current,1 AS ownership_current,1 AS allocation_available FROM card_settlement_reviews;
    CREATE TABLE card_settlement_decisions(proposal_id TEXT,revision INTEGER,status TEXT,decision_revision_id TEXT,created_at TEXT);`);
  db.prepare(
    "INSERT INTO card_settlement_reviews VALUES('one',?,0,'proposed',NULL,NULL,NULL,NULL,?)",
  ).run(JSON.stringify(settlementFacts(true)), "2026-09-11T00:00:00Z");
  return db;
}

/** One proposed review with a mapped account on each side (card-ownership-query.test.ts). */
function ownershipStore(): Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE card_settlement_reviews(id TEXT,facts_json TEXT,revision INTEGER,status TEXT);
 CREATE TABLE card_settlement_readiness(id TEXT,statement_current INTEGER,bank_current INTEGER);
 CREATE TABLE current_identity_observations(kind TEXT,observation_id INTEGER,parse_run_id INTEGER,source_account_id TEXT);
 CREATE TABLE current_account_mappings(id TEXT,source_account_id TEXT,account_id TEXT,revision INTEGER,status TEXT);
 CREATE TABLE accounts(id TEXT,role TEXT,status TEXT);
 CREATE TABLE entity_relations(id TEXT,kind TEXT,from_ref TEXT,to_ref TEXT,status TEXT,valid_from TEXT,valid_to TEXT,evidence_refs_json TEXT,decision_revision_id TEXT);
 CREATE TABLE decision_revisions(id TEXT,superseded_by TEXT);
 INSERT INTO card_settlement_readiness VALUES('one',1,1);
 INSERT INTO current_identity_observations VALUES('balance',11,1,'sa-card'),('transaction',12,2,'sa-bank');
 INSERT INTO current_account_mappings VALUES('mapping-card','sa-card','acct-card',1,'provider-local'),('mapping-bank','sa-bank','acct-bank',2,'provider-local');
 INSERT INTO accounts VALUES('acct-card','card-statement','provider-local'),('acct-bank','deposit','provider-local');`);
  db.prepare("INSERT INTO card_settlement_reviews VALUES('one',?,0,'proposed')").run(
    JSON.stringify(settlementFacts(true)),
  );
  return db;
}

/**
 * The one whole read left: the mapping read reaches the side's identity
 * through `current_identity_observations`, which materializes the candidate
 * identity runs of every published parse. docs/card-settlements.md (Cost)
 * records it as not yet changed.
 */
const ACCEPTED = {
  statement: "FROM current_identity_observations o JOIN current_account_mappings m",
  step: /^SCAN pub USING COVERING INDEX published_parse_runs_run$/u,
};

const collapsed = (sql: string) => sql.replace(/\s+/gu, " ");

test("the review reads' own statements read no growing table whole", async () => {
  const issued = new Set<string>();
  const settlements = settlementStore();
  const page = await queryCardSettlements(recording(settlements, issued));
  expect(page.items).toHaveLength(1);
  await queryCardSettlements(recording(settlements, issued), { proposalId: "one" });
  settlements.close();
  const ownership = ownershipStore();
  expect(await queryCardOwnership(recording(ownership, issued), "one")).not.toBeNull();
  ownership.close();
  // The decision history, the mapping, the claims and the relations.
  expect(issued.size).toBeGreaterThanOrEqual(4);

  const core = fullCoreDatabase();
  const offending: { sql: string; scans: string[] }[] = [];
  let acceptedMade = false;
  for (const query of issued) {
    const accepted = collapsed(query).includes(ACCEPTED.statement);
    const plan = planOf(core, query);
    // Each statement reaches its rows from the keys it is given.
    expect(plan.some((step) => step.startsWith("SEARCH "))).toBe(true);
    if (accepted && plan.some((step) => ACCEPTED.step.test(step))) acceptedMade = true;
    const scans = tableScans(core, query, plan)
      .filter((scan) => !(accepted && ACCEPTED.step.test(scan.step)))
      .map((scan) => `${scan.step} [${scan.tables.join(",")}]`);
    if (scans.length > 0) offending.push({ sql: collapsed(query).slice(0, 200), scans });
  }
  core.close();
  expect(offending).toEqual([]);
  // The accepted read is still made; once it is not, remove ACCEPTED and the
  // limit docs/card-settlements.md records.
  expect(acceptedMade).toBe(true);
}, 60_000);
