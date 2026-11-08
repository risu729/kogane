// Synthetic upgrade of the exact-version policies. The real parsers and
// price lane are exercised separately in coverage, PRESTIA and price tests.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { coreDatabase, sqliteD1 } from "../../storage-d1/test/sqlite.ts";
import { CORE_MIGRATIONS_URL, migrationSql } from "../../storage-d1/src/migrations.ts";
import { snapshotCtes } from "../../../packages/parsers/src/snapshot-query.ts";
import { PARSERS } from "../../parsers/src/parsers/registry.ts";

const MIGRATION = "0084_csv_reader_release_snapshot_policies.sql";
const POLICIES = [
  {
    source: "sbi-securities",
    dataset: "foreign-cash-positions",
    parser: "sbi-foreign-cash-positions",
    old: "0.3.0",
    current: "0.3.1",
  },
  {
    source: "sbi-shinsei-bank",
    dataset: "exchange-rate",
    parser: "sbi-shinsei-exchange-rate",
    old: "1.0.2",
    current: "1.0.3",
  },
  {
    source: "prestia",
    dataset: "prestia-bank-balance-html",
    parser: "prestia-bank-balances",
    old: "1.0.0",
    current: "1.0.1",
  },
  {
    source: "st-george",
    dataset: "account-snapshot",
    parser: "st-george-balances",
    old: "1.0.0",
    current: "1.0.1",
  },
] as const;
const RELATIONS = {
  fetchArtifacts: "observation_fetch_artifacts",
  fetchRuns: "observation_fetch_runs",
  parseRuns: "parse_runs",
  publishedParseRuns: "published_parse_runs",
};
let sqlite: Database;
let db: ReturnType<typeof sqliteD1>;
beforeAll(() => {
  sqlite = coreDatabase("0017", "0084");
  db = sqliteD1(sqlite);
}, 30000);
afterAll(() => {
  sqlite?.close();
});
async function seedArtifact(id: number, source: string, dataset: string) {
  sqlite.run("INSERT OR IGNORE INTO sources VALUES(?,?)", [source, source]);
  sqlite.run("INSERT INTO acquisition_sessions(id,external_session_id) VALUES(?,?)", [
    id,
    `synthetic-${id}`,
  ]);
  sqlite.run(
    "INSERT INTO fetch_runs(id,source_id,acquisition_session_id,producer_id) VALUES(?,?,?,'synthetic')",
    [id, source, id],
  );
  sqlite.run("INSERT INTO fetch_run_reports VALUES(?,'terminal','success',1,1)", [id]);
  sqlite.run("INSERT INTO raw_objects VALUES(?,1,?)", [String(id), String(id)]);
  sqlite.run(
    "INSERT INTO fetch_artifacts(id,fetch_run_id,source_id,dataset,artifact_key,declared_media_type,fetched_at_ms,recorded_at_ms,sha256) VALUES(?,?,?,?,'synthetic','application/json',1,1,?)",
    [id, id, source, dataset, String(id)],
  );
  sqlite.run("INSERT INTO fetch_run_seals VALUES(?,1)", [id]);
}
async function publishParse(run: number) {
  sqlite.run(
    `INSERT INTO publication_events(fetch_artifact_id,parser_name,previous_parse_run_id,new_parse_run_id,kind,actor,reason,occurred_at)
    SELECT p.fetch_artifact_id,p.parser_name,(SELECT parse_run_id FROM published_parse_runs x WHERE x.fetch_artifact_id=p.fetch_artifact_id AND x.parser_name=p.parser_name),p.id,'normal','pipeline','test','2026-11-08' FROM parse_runs p WHERE p.id=?`,
    [run],
  );
  sqlite.run(
    `INSERT INTO published_parse_runs(fetch_artifact_id,parser_name,parse_run_id,parser_version,published_at,publication_kind)
    SELECT fetch_artifact_id,parser_name,id,parser_version,'2026-11-08','normal' FROM parse_runs WHERE id=?
    ON CONFLICT(fetch_artifact_id,parser_name) DO UPDATE SET parse_run_id=excluded.parse_run_id,parser_version=excluded.parser_version`,
    [run],
  );
}
async function applyMigration() {
  sqlite.exec(migrationSql(CORE_MIGRATIONS_URL, MIGRATION));
}
const snapshots = async () =>
  (
    await db
      .prepare(
        `WITH ${snapshotCtes(RELATIONS)} SELECT parser_name,required_version FROM current_snapshots ORDER BY parser_name`,
      )
      .all()
  ).results;
const evidence = async () => {
  const result: Record<string, unknown[]> = {};
  for (const table of [
    "raw_objects",
    "fetch_artifacts",
    "parse_runs",
    "parse_coverage_claims",
    "valuation_observations",
    "published_parse_runs",
    "publication_events",
  ])
    result[table] = (await db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results;
  return result;
};

test("migration admits each equivalent current snapshot and preserves every old fact and publication", async () => {
  for (const [index, policy] of POLICIES.entries()) {
    const artifact = 1700 + index;
    await seedArtifact(artifact, policy.source, policy.dataset);
    for (const [offset, version] of [
      [1000, policy.old],
      [2000, policy.current],
    ] as const) {
      const run = artifact + offset;
      await db
        .prepare(`INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
        VALUES(?,?,?,?,'2026-11-08T00:00:00Z','ok','[]')`)
        .bind(run, artifact, policy.parser, version)
        .run();
      const scope = `${policy.source}/${policy.dataset}`;
      await db
        .prepare(`INSERT INTO parse_coverage_claims(parse_run_id,claim_id,scope_key,mode,completeness,membership_complete,observed_count,expected_count,evidence_refs_json,policy_version,failure_cause,absence_meaning,parent_run_status,parent_run_failure_count)
        VALUES(?, ?,?,'complete-container','complete',1,1,1,'["json:$"]','coverage-v1',NULL,'not-applicable','success',0)`)
        .bind(run, `container:${scope}`, scope)
        .run();
      await db
        .prepare(`INSERT INTO valuation_observations(parse_run_id,source_account,subject,metric,amount_text,amount_scale,currency,raw_locator,extra_json)
        VALUES(?,'synthetic','synthetic','synthetic','100',0,'JPY','json:$','{}')`)
        .bind(run)
        .run();
    }
    await publishParse(artifact + 1000);
  }
  expect(await snapshots()).toEqual(
    POLICIES.map((p) => ({ parser_name: p.parser, required_version: p.old })).sort((a, b) =>
      a.parser_name.localeCompare(b.parser_name),
    ),
  );
  for (const [index] of POLICIES.entries()) await publishParse(3700 + index);
  // An exact old pin cannot see the new publication until the upgrade.
  expect(await snapshots()).toEqual([]);
  const before = await evidence();
  const policiesBefore = (
    await db.prepare("SELECT * FROM dataset_snapshot_policies ORDER BY parser_name,dataset").all()
  ).results;
  await applyMigration();
  // Every exact pin must name a reader this build deploys, including policies
  // outside the examples above. A later shared release must satisfy this too.
  for (const row of (
    await db
      .prepare(
        "SELECT parser_name,required_parser_version FROM dataset_snapshot_policies WHERE required_parser_version IS NOT NULL",
      )
      .all<{ parser_name: string; required_parser_version: string }>()
  ).results)
    expect(
      PARSERS.some(
        (parser) =>
          parser.name === row.parser_name && parser.version === row.required_parser_version,
      ),
      `${row.parser_name}@${row.required_parser_version}`,
    ).toBe(true);
  expect(await snapshots()).toEqual(
    POLICIES.map((p) => ({ parser_name: p.parser, required_version: p.current })).sort((a, b) =>
      a.parser_name.localeCompare(b.parser_name),
    ),
  );
  expect(await evidence()).toEqual(before);
  const after = (
    await db.prepare("SELECT * FROM dataset_snapshot_policies ORDER BY parser_name,dataset").all()
  ).results;
  expect(after).toEqual(
    policiesBefore.map((row) => {
      const policy = POLICIES.find(
        (p) => p.parser === row.parser_name && p.dataset === row.dataset,
      );
      return policy
        ? { ...row, required_parser_version: policy.current, updated_at_ms: 1794096000000 }
        : row;
    }),
  );
}, 60000);

test("the upgrade is idempotent and preserves operator-selected alternatives", async () => {
  for (const policy of POLICIES)
    await db
      .prepare(
        "UPDATE dataset_snapshot_policies SET required_parser_version='9.0.0',updated_at_ms=42 WHERE parser_name=? AND dataset=?",
      )
      .bind(policy.parser, policy.dataset)
      .run();
  const before = (
    await db.prepare("SELECT * FROM dataset_snapshot_policies ORDER BY parser_name,dataset").all()
  ).results;
  await applyMigration();
  await applyMigration();
  expect(
    (await db.prepare("SELECT * FROM dataset_snapshot_policies ORDER BY parser_name,dataset").all())
      .results,
  ).toEqual(before);
}, 60000);
