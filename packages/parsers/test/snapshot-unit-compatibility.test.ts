import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { snapshotCtes, LOCAL_SNAPSHOT_RELATIONS } from "../src/snapshot-query.ts";

for (const kind of ["income", "gains"] as const)
  for (const control of ["exact", "source", "parser", "dataset", "unit"] as const)
    test(`legacy income partition compatibility is exact: ${kind}/${control}`, () => {
      const db = new Database(":memory:");
      db.exec(`CREATE TABLE fetch_artifacts(id INTEGER,source_id TEXT,dataset TEXT,fetch_unit_key TEXT,fetch_run_id INTEGER,fetched_at TEXT,artifact_key TEXT);
      CREATE TABLE fetch_runs(id INTEGER,status TEXT,failure_count INTEGER);
      CREATE TABLE parse_runs(id INTEGER,fetch_artifact_id INTEGER,parser_name TEXT,parser_version TEXT,warnings_json TEXT);
      CREATE TABLE published_parse_runs(parse_run_id INTEGER);
      CREATE TABLE parse_coverage_claims(parse_run_id INTEGER,mode TEXT,scope_key TEXT,completeness TEXT,membership_complete INTEGER,failure_cause TEXT,observed_count INTEGER);
      CREATE TABLE dataset_snapshot_policies(source_id TEXT,parser_name TEXT,dataset TEXT,required_parser_version TEXT,policy_id TEXT,replaces_previous_on_complete_empty INTEGER,unit_scope TEXT,snapshot_selection INTEGER);
      CREATE TABLE observation_fetch_artifact_units(fetch_artifact_id INTEGER,unit_status TEXT);`);
      const datasetName = kind === "income" ? "income-payments" : "realised-gains";
      const newUnit = `income-history-${kind}`;
      const source = control === "source" ? "other-source" : "sbi-securities";
      const parser = control === "parser" ? "other-parser" : `sbi-${datasetName}`;
      const dataset = control === "dataset" ? "other-dataset" : datasetName;
      const unit = control === "unit" ? "other-unit" : "domestic";
      db.query(
        "INSERT INTO dataset_snapshot_policies VALUES(?,?,?,NULL,'legacy-warning-compat-v1',1,'run',1)",
      ).run(source, parser, dataset);
      for (const [id, key] of [
        [1, unit],
        [2, newUnit],
      ] as const) {
        db.query("INSERT INTO fetch_runs VALUES(?,'success',0)").run(id);
        db.query("INSERT INTO fetch_artifacts VALUES(?,?,?,?,?,?,?)").run(
          id,
          source,
          dataset,
          key,
          id,
          `2020-01-0${id}T00:00:00Z`,
          `${dataset}.json`,
        );
        db.query("INSERT INTO parse_runs VALUES(?,?,?,'1.0.0','[]')").run(id, id, parser);
        db.query("INSERT INTO published_parse_runs VALUES(?)").run(id);
      }
      expect(
        db
          .query(
            `WITH ${snapshotCtes(LOCAL_SNAPSHOT_RELATIONS)} SELECT artifact_id FROM current_snapshots ORDER BY artifact_id`,
          )
          .all(),
      ).toEqual(
        control === "exact" ? [{ artifact_id: 2 }] : [{ artifact_id: 1 }, { artifact_id: 2 }],
      );
      db.close();
    });

// ADR 0109 amendment (2026-11-19): SBI Shinsei's container datasets were
// captured under the retired importer's `primary` unit and are captured with
// no unit by the native collector. Only those exact three source/parser/dataset
// combinations share one partition; every other control keeps two.
const SHINSEI_CONTAINERS = [
  ["sbi-shinsei-top-balances-and-activity", "top-accounts-balance-and-activity"],
  ["sbi-shinsei-yen-deposit-account", "yen-deposit-account"],
  ["sbi-shinsei-exchange-rate", "exchange-rate"],
] as const;

function shinseiStore(
  source: string,
  parser: string,
  dataset: string,
  legacyUnit: string,
  successorUnit: string | null,
): Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE fetch_artifacts(id INTEGER,source_id TEXT,dataset TEXT,fetch_unit_key TEXT,fetch_run_id INTEGER,fetched_at TEXT,artifact_key TEXT);
  CREATE TABLE fetch_runs(id INTEGER,status TEXT,failure_count INTEGER);
  CREATE TABLE parse_runs(id INTEGER,fetch_artifact_id INTEGER,parser_name TEXT,parser_version TEXT,warnings_json TEXT);
  CREATE TABLE published_parse_runs(parse_run_id INTEGER);
  CREATE TABLE parse_coverage_claims(parse_run_id INTEGER,mode TEXT,scope_key TEXT,completeness TEXT,membership_complete INTEGER,failure_cause TEXT,observed_count INTEGER);
  CREATE TABLE dataset_snapshot_policies(source_id TEXT,parser_name TEXT,dataset TEXT,required_parser_version TEXT,policy_id TEXT,replaces_previous_on_complete_empty INTEGER,unit_scope TEXT,snapshot_selection INTEGER);
  CREATE TABLE observation_fetch_artifact_units(fetch_artifact_id INTEGER,unit_status TEXT);`);
  db.query(
    "INSERT INTO dataset_snapshot_policies VALUES(?,?,?,NULL,'legacy-warning-compat-v1',1,'run',1)",
  ).run(source, parser, dataset);
  for (const [id, key] of [
    [1, legacyUnit],
    [2, successorUnit],
  ] as const) {
    db.query("INSERT INTO fetch_runs VALUES(?,'success',0)").run(id);
    db.query("INSERT INTO fetch_artifacts VALUES(?,?,?,?,?,?,?)").run(
      id,
      source,
      dataset,
      key,
      id,
      `2020-01-0${id}T00:00:00.000Z`,
      `${dataset}.json`,
    );
    db.query("INSERT INTO parse_runs VALUES(?,?,?,'1.0.0','[]')").run(id, id, parser);
    db.query("INSERT INTO published_parse_runs VALUES(?)").run(id);
  }
  return db;
}

function currentArtifacts(db: Database, cutoff?: string): unknown[] {
  const sql = `WITH ${snapshotCtes(LOCAL_SNAPSHOT_RELATIONS, cutoff === undefined ? {} : { cutoffParam: "?1" })} SELECT artifact_id FROM current_snapshots ORDER BY artifact_id`;
  return cutoff === undefined ? db.query(sql).all() : db.query(sql).all(cutoff);
}

for (const [parserName, datasetName] of SHINSEI_CONTAINERS)
  for (const control of ["exact", "source", "parser", "dataset", "unit", "successor"] as const)
    test(`SBI Shinsei importer partition compatibility is exact: ${datasetName}/${control}`, () => {
      const source = control === "source" ? "other-source" : "sbi-shinsei-bank";
      const parser = control === "parser" ? "other-parser" : parserName;
      const dataset = control === "dataset" ? "other-dataset" : datasetName;
      const legacyUnit = control === "unit" ? "other-unit" : "primary";
      // A successor with a named unit is a different container, not the native one.
      const successorUnit = control === "successor" ? "other-unit" : null;
      const db = shinseiStore(source, parser, dataset, legacyUnit, successorUnit);
      expect(currentArtifacts(db)).toEqual(
        control === "exact" ? [{ artifact_id: 2 }] : [{ artifact_id: 1 }, { artifact_id: 2 }],
      );
      db.close();
    });

test("SBI Shinsei: a cutoff before the native capture still selects the importer's capture", () => {
  const [parser, dataset] = SHINSEI_CONTAINERS[0];
  const db = shinseiStore("sbi-shinsei-bank", parser, dataset, "primary", null);
  expect(currentArtifacts(db, "2020-01-02T00:00:00.000Z")).toEqual([{ artifact_id: 1 }]);
  expect(currentArtifacts(db, "2020-01-03T00:00:00.000Z")).toEqual([{ artifact_id: 2 }]);
  db.close();
});
