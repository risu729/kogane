// The CORE change detector of migration 0038 on the production schema
// (unified plan 05 §2, acceptance G2-01, G2-03, G2-04).
//
// What is proved here: the dependency ledger in `source-revision.ts` and the
// triggers in the database are the same set, a write to any ledger family
// moves the revision, a write to a checkpoint or job table does not, and the
// counting query the read model used before cannot see the change that made
// the old identity wrong. Every row below is synthetic.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CORE_REVISION_SQL,
  PROJECTION_INPUTS_SQL,
  REVISION_EXCLUDED_TABLES,
  revisionTriggerNames,
  snapshotIdentity,
  SOURCE_REVISION_LEDGER,
  VISIBILITY_REVISION_LEDGER,
  type CoreRevisionRow,
  type ProjectionInputsRow,
} from "../src/index";

const MIGRATIONS = join(import.meta.dir, "../../../packages/storage-d1/migrations/core");

function migratedDatabase(): Database {
  const db = new Database(":memory:");
  for (const name of readdirSync(MIGRATIONS)
    .filter((entry) => entry.endsWith(".sql"))
    .sort())
    db.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
  return db;
}

const revision = (db: Database): CoreRevisionRow =>
  db.query(CORE_REVISION_SQL).get() as CoreRevisionRow;

/**
 * One parse run per artifact id. Layer A registration has its own ingest
 * route rules, which this fixture deliberately does not exercise: what is
 * under test is the revision, so the rows are written directly.
 */
function seedParse(db: Database, artifactId: number, parseRunId: number, version = "1"): void {
  db.exec(
    `INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
     VALUES(${parseRunId},${artifactId},'smbc-direct-balance','${version}','2026-09-07T00:00:00Z','ok','[]')`,
  );
}

/**
 * Every trigger that writes the revision row, whatever it is called. Selecting
 * by body rather than by name is what makes an extra bump trigger under a
 * different naming convention visible to the equality below.
 */
const BUMP_TRIGGERS_SQL = `SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger'
  AND sql LIKE '%UPDATE core_source_revision%' ORDER BY name`;
const bumpTriggers = (db: Database) =>
  db.query(BUMP_TRIGGERS_SQL).all() as { name: string; tbl_name: string; sql: string }[];

test("G2-03: the trigger set in the database is exactly the declared dependency ledger", () => {
  const db = migratedDatabase();
  const found = bumpTriggers(db).map((row) => row.name);
  // The ledger in source-revision.ts and the triggers in migration 0038 are
  // one list: a dependency table added to one side alone fails here, which is
  // what keeps a new dependency from being forgotten silently.
  expect(found).toEqual(revisionTriggerNames());
  // The equality is sensitive in both directions: one trigger fewer, or one
  // more on a table outside the ledger, and the sets differ.
  db.exec("DROP TRIGGER parse_runs_bump_revision_update");
  expect(bumpTriggers(db).map((row) => row.name)).not.toEqual(revisionTriggerNames());
  db.exec(
    `CREATE TRIGGER parse_runs_bump_revision_update AFTER UPDATE ON parse_runs
     BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END`,
  );
  expect(bumpTriggers(db).map((row) => row.name)).toEqual(revisionTriggerNames());
  db.exec(
    `CREATE TRIGGER fetch_runs_extra AFTER INSERT ON fetch_runs
     BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END`,
  );
  expect(bumpTriggers(db).map((row) => row.name)).not.toEqual(revisionTriggerNames());
  db.exec("DROP TRIGGER fetch_runs_extra");
  // Every trigger really writes the revision, and sits on its own table.
  const rows = bumpTriggers(db);
  const ledger = new Set<string>([...SOURCE_REVISION_LEDGER, ...VISIBILITY_REVISION_LEDGER]);
  for (const row of rows) {
    expect(ledger.has(row.tbl_name)).toBe(true);
    expect(row.name.startsWith(`${row.tbl_name}_bump_revision_`)).toBe(true);
    expect(row.sql).toContain("UPDATE core_source_revision SET source_revision=source_revision+1");
  }
  // The visibility ledger moves both counters; the source ledger only one.
  for (const row of rows) {
    const visibility = (VISIBILITY_REVISION_LEDGER as readonly string[]).includes(row.tbl_name);
    expect(row.sql.includes("visibility_revision=visibility_revision+1")).toBe(visibility);
  }
  db.close();
});

test("G2-04: checkpoint, job and projection-output tables never move the revision", () => {
  const db = migratedDatabase();
  const covered = new Set(bumpTriggers(db).map((row) => row.tbl_name));
  const tables = new Set(
    (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
      (row) => row.name,
    ),
  );
  for (const table of REVISION_EXCLUDED_TABLES) {
    // An excluded table exists (the list cannot drift from the schema) and
    // carries no bump trigger.
    expect(tables.has(table)).toBe(true);
    expect(covered.has(table)).toBe(false);
  }

  // A build recording its own progress must not invalidate itself: that is an
  // endless rebuild, not a change of the data (05 §2).
  const before = revision(db).source_revision;
  db.exec(
    `INSERT INTO balance_read_snapshots(snapshot_id,created_at,input_manifest_json,status,row_count,projection_release)
     VALUES('${"b".repeat(64)}','2026-09-12T00:00:00Z','{}','building',0,'balance-projection-v1')`,
  );
  db.exec(
    `UPDATE balance_read_snapshots SET build_cursor='42' WHERE snapshot_id='${"b".repeat(64)}'`,
  );
  db.exec("UPDATE observation_scan_state SET cursor=cursor+11 WHERE id=1");
  expect(revision(db).source_revision).toBe(before);
  db.close();
});

test("G2-03: a write in each dependency family moves the matching revision", () => {
  const db = migratedDatabase();
  const moved = (write: string): { source: number; visibility: number } => {
    const before = revision(db);
    db.exec(write);
    const after = revision(db);
    return {
      source: after.source_revision - before.source_revision,
      visibility: after.visibility_revision - before.visibility_revision,
    };
  };
  seedParse(db, 1, 1);

  // Adoption.
  expect(
    moved(
      `INSERT INTO published_parse_runs(fetch_artifact_id,parser_name,parse_run_id,parser_version,published_at,publication_kind)
       VALUES(1,'smbc-direct-balance',1,'1','2026-09-07T00:00:00Z','normal')`,
    ),
  ).toEqual({ source: 1, visibility: 0 });
  expect(
    moved(
      `INSERT INTO publication_events(fetch_artifact_id,parser_name,previous_parse_run_id,new_parse_run_id,kind,actor,reason,occurred_at)
       VALUES(1,'smbc-direct-balance',NULL,1,'normal','pipeline','parse_ok','2026-09-07T00:00:00Z')`,
    ),
  ).toEqual({ source: 1, visibility: 0 });
  // Exact decimals.
  expect(
    moved(
      `INSERT INTO observation_decimal_values(kind,observation_id,parse_run_id,policy_version,status,coefficient,scale,basis)
       VALUES('balance',1,1,'decimal-v1','exact','60000',0,'minor_units')`,
    ),
  ).toEqual({ source: 1, visibility: 0 });
  // Coverage and the policy that reads it.
  expect(
    moved(
      `INSERT INTO parse_coverage_claims(parse_run_id,claim_id,scope_key,mode,completeness,membership_complete,
        observed_count,expected_count,evidence_refs_json,policy_version,failure_cause,absence_meaning,
        parent_run_status,parent_run_failure_count)
       VALUES(1,'c1','s1','complete-container','complete',1,1,1,'[]','coverage-v1',NULL,'not-applicable','success',0)`,
    ),
  ).toEqual({ source: 1, visibility: 0 });
  expect(
    moved(
      `INSERT INTO dataset_snapshot_policies(source_id,dataset,parser_name,policy_id)
       VALUES('smbc-bank','balance-revision-probe','smbc-direct-balance','coverage-v1')`,
    ),
  ).toEqual({ source: 1, visibility: 0 });
  // Judgements.
  expect(
    moved(
      `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,
        operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
       VALUES('dr1','relation','rel1',1,'accept','manual','operator:1',NULL,'synthetic','[]',NULL,NULL,'2026-09-12T00:00:00Z')`,
    ),
  ).toEqual({ source: 1, visibility: 0 });
  expect(
    moved(
      `INSERT INTO entity_relations(id,kind,from_ref,to_ref,valid_from,valid_to,status,decision_revision_id,evidence_refs_json,created_at)
       VALUES('rel1','same_account','source_account:a','source_account:b',NULL,NULL,'accepted','dr1','[]','2026-09-12T00:00:00Z')`,
    ),
  ).toEqual({ source: 1, visibility: 0 });
  // Identity.
  db.exec("INSERT INTO source_accounts VALUES('ref-x','smbc-bank','p','[\"x\"]')");
  db.exec("INSERT INTO accounts VALUES('acct-x','X','deposit','provider-local')");
  expect(
    moved(
      `INSERT INTO account_mappings(id,source_account_id,revision,account_id,method,reason,policy_version,created_at,label,status)
       VALUES('am-x-1','ref-x',1,'acct-x','rule','synthetic',1,'2026-09-12T00:00:00Z','X','provider-local')`,
    ),
  ).toEqual({ source: 1, visibility: 0 });
  // Calculation policy.
  expect(
    moved(
      `INSERT INTO calculation_policies(policy_id,kind,version,definition_json,verification,evidence_refs_json,created_at)
       VALUES('p1','rounding','v1','{}','verified','[]','2026-09-12T00:00:00Z')`,
    ),
  ).toEqual({ source: 1, visibility: 0 });
  // Rewards (migration 0041): a reward capture reads the reference claims and
  // the promoted claims, so each of them has to move the revision. A rule
  // version that changed without moving it would be invisible to the r0/r1
  // capture and would silently alter a "reproducible" deadline (U16, G2-19).
  expect(
    moved(
      `INSERT INTO reward_programs(program_id,institution_ref,program_ref,source_id,unit_ref,
        holding_kind,terms_evidence_refs_json,release_id,recorded_at)
       VALUES('program:probe','institution:probe','probe','probe','points:probe','reward-points',
         '[]','reward-model-v1','2026-09-12T00:00:00Z')`,
    ),
  ).toEqual({ source: 1, visibility: 0 });
  expect(
    moved(
      `INSERT INTO expiry_rules(rule_id,version,family,program_id,applicability_json,
        qualifying_activity_policy_ref,deadline_calendar_ref,priority_policy_ref,
        evidence_refs_json,verification,recorded_at)
       VALUES('rule:probe','v1','fixed-lot','program:probe',
         '{"bucketKinds":["regular"],"tiers":null,"validPeriod":null}',NULL,
         'Asia/Tokyo:end-of-day:assumed',NULL,'[]','verified','2026-09-12T00:00:00Z')`,
    ),
  ).toEqual({ source: 1, visibility: 0 });
  expect(
    moved(
      `INSERT INTO conversion_offers(offer_id,version,source_program_ref,destination_program_ref,
        from_unit_ref,to_unit_ref,ratio_numerator,ratio_denominator,minimum_coefficient,
        minimum_scale,increment_coefficient,increment_scale,fixed_fees_json,
        eligibility_policy_ref,eligible_bucket_kinds_json,eligible_restriction_refs_json,
        valid_time_json,application_deadline_json,processing_policy_ref,processing_days,
        rounding_policy_ref,rounding_scale,rounding_mode,evidence_refs_json,verification,
        recorded_at)
       VALUES('offer:probe','v1','program:probe','program:probe-cash','points:probe','JPY','1','2',
         '100',0,'100',0,'[]','policy:probe:eligibility','["regular"]','[]',
         '{"kind":"unknown","reasonCode":"probe"}','{"kind":"unknown","reasonCode":"probe"}',
         'policy:probe:processing',3,'policy:probe:rounding',0,'down','[]','verified',
         '2026-09-12T00:00:00Z')`,
    ),
  ).toEqual({ source: 1, visibility: 0 });
  expect(
    moved(
      `INSERT INTO reward_bucket_claims(claim_digest,parse_run_id,source_fact_kind,source_fact_id,
        program_id,holding_ref,bucket_ref,bucket_kind,restriction_refs_json,unit_ref,
        quantity_coefficient,quantity_scale,quantity_status,observed_expiry_json,observed_at,
        promotion_release,recorded_at)
       VALUES('${"c".repeat(64)}',1,'balance',1,'program:probe','holding:probe','bucket:probe',
         'regular','[]','points:probe','100',0,'exact',NULL,'2026-09-12T00:00:00Z',
         'reward-promotion-v1','2026-09-12T00:00:00Z')`,
    ),
  ).toEqual({ source: 1, visibility: 0 });
  expect(
    moved(
      `INSERT INTO membership_state_claims(claim_digest,parse_run_id,program_id,holding_ref,tier,
        valid_json,source,evidence_refs_json,recorded_at)
       VALUES('${"d".repeat(64)}',1,'program:probe','holding:probe','gold',
         '{"kind":"unknown","reasonCode":"probe"}','provider','[]','2026-09-12T00:00:00Z')`,
    ),
  ).toEqual({ source: 1, visibility: 0 });
  // The reward projection's own output stays outside the ledger: a build that
  // recorded its result must not invalidate itself (05 §2).
  expect(
    moved(
      `INSERT INTO expiry_estimates(holding_ref,rule_id,rule_version,context_id,state,
        expiring_buckets_json,uncertainty_codes_json,source_expiry_refs_json,policy_release,
        computed_at)
       VALUES('holding:probe','rule:probe','v1','context:probe','computed','[]','[]','[]',
         'reward-model-v1','2026-09-12T00:00:00Z')`,
    ),
  ).toEqual({ source: 0, visibility: 0 });
  // `fetch_run_seals` is in the ledger too; sealing needs a registered Layer A
  // run, so it is exercised against the real registration path in
  // services/processor/test/projection-input.test.ts.
  // Restrictions move both: a subtotal computed before one is wrong, so the
  // affected snapshot is rebuilt rather than filtered (05 §7).
  expect(
    moved(
      `INSERT INTO evidence_use_restrictions(evidence_ref,restriction,since,affected_manifests_json,actor,reason)
       VALUES('balance:1','no-reuse','2026-09-12','[]','operator:1','synthetic')`,
    ),
  ).toEqual({ source: 1, visibility: 1 });
  expect(
    moved(
      `INSERT INTO fetch_run_annotations(fetch_run_id,annotation_kind,reason_code,recorded_at_ms)
       VALUES(1,'exclude_from_financial_views','synthetic-probe',1)`,
    ),
  ).toEqual({ source: 1, visibility: 1 });
  db.close();
});

test("G2-01: an adopted parse moving 100 to 150 is invisible to the old identity and moves the revision", () => {
  const db = migratedDatabase();
  seedParse(db, 1, 100);
  // The later run of the same artifact and parser: this is the adoption that
  // moves, and the publication gate only accepts a successful run of that pair.
  seedParse(db, 1, 150, "2");
  // An unrelated published run with a much higher id: this is what made
  // `max(parse_run_id)` a false identity (01 §5).
  seedParse(db, 3, 900);
  db.exec(
    `INSERT INTO published_parse_runs(fetch_artifact_id,parser_name,parse_run_id,parser_version,published_at,publication_kind)
     VALUES(1,'smbc-direct-balance',100,'1','2026-09-07T00:00:00Z','normal'),
           (3,'smbc-direct-balance',900,'1','2026-09-07T00:00:00Z','normal')`,
  );
  const legacyBefore = db.query(PROJECTION_INPUTS_SQL).get() as ProjectionInputsRow;
  const before = revision(db);

  // The adoption pointer of artifact 1 moves from run 100 to run 150.
  db.exec(
    "UPDATE published_parse_runs SET parse_run_id=150,parser_version='2' WHERE fetch_artifact_id=1",
  );

  const legacyAfter = db.query(PROJECTION_INPUTS_SQL).get() as ProjectionInputsRow;
  const after = revision(db);
  // The old declared inputs cannot see it: the maximum is still 900 and no
  // count changed, so the old snapshot id would have stayed the same.
  expect(legacyAfter.published_high_water).toBe(legacyBefore.published_high_water);
  expect(legacyAfter).toEqual(legacyBefore);
  // The revision does see it.
  expect(after.source_revision).toBeGreaterThan(before.source_revision);
  expect(after.core_epoch).toBe(before.core_epoch);
  db.close();
});

test("G2-04: a revision rewind needs a new core epoch, and never happens silently", () => {
  const db = migratedDatabase();
  db.exec("UPDATE core_source_revision SET source_revision=source_revision+5 WHERE id=1");
  expect(() => db.exec("UPDATE core_source_revision SET source_revision=1 WHERE id=1")).toThrow(
    /new core epoch/u,
  );
  // A restore declares itself: the epoch changes with the rewind, so a READ
  // built under the old epoch is never mistaken for the same context (05 §2).
  db.exec("UPDATE core_source_revision SET source_revision=1,core_epoch='core-epoch-2' WHERE id=1");
  expect(revision(db)).toMatchObject({ source_revision: 1, core_epoch: "core-epoch-2" });
  expect(() => db.exec("DELETE FROM core_source_revision")).toThrow(/permanent/u);
  // One row, ever: a second row would make "the revision" ambiguous.
  expect(() =>
    db.exec(
      "INSERT INTO core_source_revision(id,source_revision,visibility_revision,core_epoch) VALUES(2,1,1,'x')",
    ),
  ).toThrow();
  expect(db.query("SELECT count(*) AS n FROM core_source_revision").get()).toEqual({ n: 1 });
  db.close();
});

test("G2-01: the snapshot identity is the digest of the input, the build and the contract", async () => {
  const input = "1".repeat(64);
  const build = "2".repeat(64);
  const id = await snapshotIdentity(input, build);
  expect(id).toMatch(/^[0-9a-f]{64}$/u);
  // Stable for the same three parts, different for any different one.
  expect(await snapshotIdentity(input, build)).toBe(id);
  expect(await snapshotIdentity("3".repeat(64), build)).not.toBe(id);
  expect(await snapshotIdentity(input, "4".repeat(64))).not.toBe(id);
  expect(await snapshotIdentity(input, build, "projection-input-v2")).not.toBe(id);
  // The two halves are digests, never a revision or a row count.
  await expect(snapshotIdentity("12", build)).rejects.toThrow(/sha256 digests/u);
});
