// Every statement one scheduled tick prepares, and its plan without table
// statistics.
//
// The tick runs with the lanes production enables (wrangler.jsonc `vars`) on a
// store holding one sealed artifact, through bindings that record each
// statement a lane prepares. Each distinct statement is then explained on the
// complete CORE schema (every migration, Layer A included) or on the READ
// baseline, the way D1 plans it: never analyzed, so no `sqlite_stat*` table
// exists. A step that reads a growing table from end to end fails the test
// unless it is listed below with the reason it is bounded or the document that
// accepts it. A statement a tick does not reach on this store (work this store
// does not have) is not checked here.
//
// Synthetic throughout: one balance capture of a synthetic amount.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Miniflare } from "miniflare";
import { fullCoreDatabase } from "../../../packages/storage-d1/test/sqlite.ts";
import { createSqliteReadDatabase } from "../../../packages/storage-d1/test/sqlite-read-database.ts";
import { planOf, tableScans } from "../../../packages/storage-d1/test/plan-check.ts";
import { runScheduled } from "../src/worker.ts";
import { seedArtifact, startPipeline } from "./harness.ts";

/** The flags production sets (wrangler.jsonc `vars`), so every lane it runs runs here. */
const PRODUCTION_FLAGS = {
  SCHEDULES_ENABLED: "true",
  RECONCILIATION_ENABLED: "true",
  PURCHASE_RECOGNITION_ENABLED: "true",
  REWARD_CLAIMS_ENABLED: "true",
  REWARD_READ_PROJECTION_ENABLED: "true",
  REPORTS_ENABLED: "true",
  BALANCE_PROJECTION_ENABLED: "1",
  RELEASE_CANDIDATES_ENABLED: "true",
  SHARED_R2_INGEST_ENABLED: "true",
  OPS_DISPATCH_ENABLED: "true",
};

/**
 * Tables a tick may read whole: configuration and operational singletons of a
 * handful of rows that no capture adds to.
 */
const SMALL = new Set([
  "active_releases",
  "conversion_offers",
  "dataset_snapshot_policies",
  "economic_identity_epochs",
  "expiry_rules",
  "price_promotion_cursor",
]);

/**
 * Whole reads of growing tables a tick makes, each matched by a fragment of
 * its statement (whitespace collapsed) and the plan step, with where it is
 * bounded or accepted.
 */
const ACCEPTED: readonly { statement: string; step: RegExp; reason: string }[] = [
  {
    statement: "UPDATE parse_runs SET status='error',error='parse_interrupted'",
    step: /^SCAN parse_runs USING COVERING INDEX parse_runs_pending$/u,
    reason: "the partial index holds pending runs only (migration 0081, ADR 0072)",
  },
  {
    statement: "WITH identity_page AS MATERIALIZED",
    step: /^SCAN p( USING COVERING INDEX idx_parse_runs_success)?$/u,
    reason:
      "the identity sweep's candidate page, pinned by packages/storage-d1/test/identity-sweep-query.test.ts",
  },
  {
    statement: "AS published_high_water",
    step: /^SCAN (t USING COVERING INDEX idx_fetch_run_reports_one_terminal|entity_relations|decision_revisions USING COVERING INDEX decision_revisions_operation)$/u,
    reason: "the operational counts logged with each build (docs/projection-input.md)",
  },
  {
    statement: "snapshot_policies(parser_name, dataset, required_version",
    step: /^SCAN (a USING INDEX idx_fetch_artifacts_source_dataset_time|t USING INDEX idx_fetch_run_reports_one_terminal)$/u,
    reason:
      "the latest-state reads group the whole active set first (docs/read-model.md, Queries); the snapshot CTEs read each artifact once (Cost)",
  },
  {
    statement: "WITH ranked_myjcb_snapshots AS",
    step: /^SCAN a USING INDEX (idx_fetch_artifacts_source_dataset_time|sqlite_autoindex_fetch_artifacts_1)$/u,
    reason: "the card usage snapshot CTEs read each artifact once (docs/read-model.md, Cost)",
  },
  {
    statement: "WITH current_keys AS MATERIALIZED",
    step: /^SCAN k USING INDEX sqlite_autoindex_card_purchase_recognition_keys_1$/u,
    reason:
      "the stale-key read runs only while the retirement proof is dirty (ADR 0037, docs/economic-events.md)",
  },
  {
    statement: "WITH page AS MATERIALIZED ( SELECT * FROM card_statement_facts",
    step: /^SCAN b USING INDEX idx_bal_obs_parse_run$/u,
    reason:
      "card_statement_facts ranks every statement total once a tick (docs/card-settlements.md, Cost)",
  },
  {
    statement: "SELECT b.id,b.parse_run_id,a.source_id,p.parser_name,b.source_account,b.metric",
    step: /^SCAN b$/u,
    reason:
      "the reward candidate page walks balance ids from the start; pinned by reward-claims-query-differential.test.ts",
  },
  {
    statement: "ranked AS MATERIALIZED ( SELECT o.*,p.id parse_run_id",
    step: /^SCAN o$/u,
    reason: "`o` is the `ranked` CTE here (FROM ranked o); identities are reached by key",
  },
  {
    statement: "FROM parse_coverage_claims c",
    step: /^SCAN c USING INDEX parse_coverage_claims_parse_run$/u,
    reason: "walks claims newest first and stops at its LIMIT",
  },
  {
    statement: "FROM reward_bucket_claims_v2 c",
    step: /^SCAN c USING INDEX reward_bucket_claims_v2_holding$/u,
    reason: "the reward read projection builds from every current claim (docs/rewards.md)",
  },
  {
    statement: "FROM membership_state_claims m",
    step: /^SCAN m USING INDEX membership_state_claims_holding$/u,
    reason: "the reward read projection builds from every current claim (docs/rewards.md)",
  },
];

const collapsed = (sql: string) => sql.replace(/\s+/gu, " ");

let mf: Miniflare;
let env: Env;
const issued = new Map<string, "CORE" | "READ">();

/** The binding, recording the text of every statement prepared on it. */
function recording(binding: D1Database, name: "CORE" | "READ"): D1Database {
  return new Proxy(binding, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (property === "prepare")
        return (sql: string) => {
          issued.set(sql, name);
          return target.prepare(sql);
        };
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

beforeAll(async () => {
  fullCoreDatabase().close();
  ({ mf, env } = await startPipeline(undefined, PRODUCTION_FLAGS));
  await seedArtifact(env, 300, "smbc-bank", "balance-normalized", "balance.normalized.json", {
    amount: 1,
    currency: "JPY",
    observedAt: "2026-09-07T00:00:00.000Z",
  });
  const lines: string[] = [];
  await runScheduled(
    { ...env, DB: recording(env.DB, "CORE"), READ: recording(env.READ, "READ") } as Env,
    undefined,
    (line) => lines.push(line),
  );
  // Every lane ran to the end: a failed lane would leave statements out.
  expect(lines.filter((line) => line.includes("_failed"))).toEqual([]);
}, 120_000);
afterAll(async () => {
  await mf?.dispose();
});

test("one tick prepares statements on both databases", () => {
  expect([...issued.values()].filter((name) => name === "CORE").length).toBeGreaterThan(50);
  expect([...issued.values()]).toContain("READ");
});

test("no statement of a tick reads a growing table from end to end", () => {
  const core = fullCoreDatabase();
  const read = createSqliteReadDatabase().sqlite;
  const offending: { sql: string; scans: string[] }[] = [];
  for (const [sql, name] of issued) {
    const db = name === "CORE" ? core : read;
    const accepted = ACCEPTED.filter((entry) => collapsed(sql).includes(entry.statement));
    const scans = tableScans(db, sql, planOf(db, sql))
      .filter((scan) => !scan.tables.every((table) => SMALL.has(table)))
      .filter((scan) => !accepted.some((entry) => entry.step.test(scan.step)))
      .map((scan) => `${scan.step} [${scan.tables.join(",")}]`);
    if (scans.length > 0) offending.push({ sql: collapsed(sql).slice(0, 200), scans });
  }
  core.close();
  read.close();
  expect(offending).toEqual([]);
});

test("every accepted whole read is still made, so none is accepted silently", () => {
  for (const entry of ACCEPTED)
    expect([...issued.keys()].some((sql) => collapsed(sql).includes(entry.statement))).toBe(true);
});
