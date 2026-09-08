import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import {
  IDENTITY_AUDIT_QUERIES,
  validateIdentityAudit,
} from "../src/identity-audit.ts";

function fixture() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE sources(id TEXT PRIMARY KEY); CREATE TABLE producers(id TEXT PRIMARY KEY);
    CREATE TABLE fetch_runs(id INTEGER PRIMARY KEY,producer_id TEXT,status TEXT,failure_count INTEGER,sealed INTEGER);
    CREATE TABLE fetch_artifacts(id INTEGER PRIMARY KEY,source_id TEXT,fetch_run_id INTEGER);
    CREATE TABLE parse_runs(id INTEGER PRIMARY KEY,fetch_artifact_id INTEGER,status TEXT,superseded_by_parse_run_id INTEGER);
    CREATE VIEW observation_sources AS SELECT * FROM sources;
    CREATE VIEW observation_fetch_runs AS SELECT * FROM fetch_runs WHERE sealed=1;
    CREATE VIEW observation_fetch_artifacts AS SELECT a.* FROM fetch_artifacts a JOIN observation_fetch_runs f ON f.id=a.fetch_run_id;
    CREATE TABLE transaction_observations(id INTEGER PRIMARY KEY,parse_run_id INTEGER);
    CREATE TABLE balance_observations(id INTEGER PRIMARY KEY,parse_run_id INTEGER);
    CREATE TABLE position_observations(id INTEGER PRIMARY KEY,parse_run_id INTEGER);
    CREATE TABLE valuation_observations(id INTEGER PRIMARY KEY,parse_run_id INTEGER);`);
  db.exec(
    readFileSync(
      new URL(
        "../../raw-evidence/migrations/0018_identity.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  db.exec(`INSERT INTO sources VALUES ('synthetic'),('empty-source'); INSERT INTO producers VALUES ('synthetic');
    INSERT INTO fetch_runs VALUES (1,'synthetic','success',0,1),(2,'synthetic','success',0,0),(3,'synthetic','partial',1,1);
    INSERT INTO fetch_artifacts VALUES (1,'synthetic',1),(2,'synthetic',2),(3,'synthetic',3);
    INSERT INTO parse_runs VALUES (1,1,'ok',NULL),(2,1,'ok',1),(3,1,'error',NULL),(4,2,'ok',NULL),(5,3,'ok',NULL),(6,1,'ok',NULL);
    INSERT INTO transaction_observations VALUES (1,1),(2,2),(3,3),(4,4),(5,5),(6,6);
    INSERT INTO balance_observations VALUES (1,1); INSERT INTO position_observations VALUES (1,1); INSERT INTO valuation_observations VALUES (1,1);
    INSERT INTO source_accounts VALUES ('ref','synthetic','synthetic','["PRIVATE_ACCOUNT"]');
    INSERT INTO accounts VALUES ('account','PRIVATE_NAME','cash','provider-local');
    INSERT INTO account_mappings VALUES ('am1','ref',1,'account','rule','PRIVATE_REASON',1,'2099','PRIVATE_NAME','provider-local');
    INSERT INTO account_mappings VALUES ('am2','ref',2,'account','manual','PRIVATE_REASON',1,'2099','PRIVATE_NAME','identified');
    INSERT INTO instruments VALUES ('inst','money','PRIVATE_UNIT','identified');
    INSERT INTO instrument_identifiers VALUES ('ii','PRIVATE_NAMESPACE','PRIVATE_SCOPE','PRIVATE_VALUE','{}');
    INSERT INTO instrument_mappings VALUES ('im','ii',1,'inst','rule','PRIVATE_REASON',1,'2099','PRIVATE_UNIT','identified');
    INSERT INTO identity_runs VALUES ('run1',1,1,'2099'),('run2',2,1,'2099'),('run4',4,1,'2099'),('run5',5,1,'2099');
    INSERT INTO identity_observations VALUES ('t','run1','transaction',1,'ref','am1','["missing-security-identifier","PRIVATE_ISSUE"]'),('b','run1','balance',1,'ref','am1','[]'),('p','run1','position',1,'ref','am1','[]'),('v','run1','valuation',1,'ref','am1','[]'),('old','run2','transaction',2,'ref','am1','[]'),('unsealed','run4','transaction',4,'ref','am1','[]'),('partial','run5','transaction',5,'ref','am1','[]');
    INSERT INTO identity_instrument_uses VALUES ('t','unit','ii','im');
    INSERT INTO identity_run_seals VALUES ('run1',4,'2099'),('run2',1,'2099'),('run4',1,'2099'),('run5',1,'2099');`);
  return db;
}
test("aggregate audit covers all forms, pending history, current claims, and hides raw values", () => {
  const db = fixture();
  try {
    const report = validateIdentityAudit(
      IDENTITY_AUDIT_QUERIES.map((q) => db.query(q.sql).all()),
    );
    const coverage = report.find((s) => s.name === "coverage")!.rows;
    expect(coverage).toHaveLength(8);
    expect(coverage).toContainEqual({
      source: "synthetic",
      kind: "transaction",
      eligible: 2,
      organized: 1,
    });
    expect(coverage).toContainEqual({
      source: "empty-source",
      kind: "valuation",
      eligible: 0,
      organized: 0,
    });
    expect(
      report
        .find((s) => s.name === "integrity")!
        .rows.every((row) =>
          Object.values(row as Record<string, number>).every(
            (count) => count === 0,
          ),
        ),
    ).toBe(true);
    expect(report.find((s) => s.name === "account_status")!.rows).toEqual([
      { source: "synthetic", status: "identified", count: 4 },
    ]);
    expect(report.find((s) => s.name === "issues")!.rows).toContainEqual({
      source: "synthetic",
      issue: "other",
      count: 1,
    });
    expect(
      report.find((s) => s.name === "pending_parses")!.rows,
    ).toContainEqual({
      source: "synthetic",
      lineage: "current",
      eligible_parses: 2,
      pending_parses: 1,
    });
    expect(
      report.find((s) => s.name === "pending_parses")!.rows,
    ).toContainEqual({
      source: "synthetic",
      lineage: "historical",
      eligible_parses: 1,
      pending_parses: 0,
    });
    expect(JSON.stringify(report)).not.toContain("PRIVATE_");
  } finally {
    db.close();
  }
});
test("audit refuses unknown output fields, unsafe counts and excess cardinality", () => {
  const empty = () => IDENTITY_AUDIT_QUERIES.map(() => [] as unknown[]);
  for (const entry of [
    { amount: 123 },
    { count: -1 },
    { count: Number.MAX_SAFE_INTEGER + 1 },
    { source: "private/account" },
  ]) {
    const rows = empty();
    rows[0] = [entry];
    expect(() => validateIdentityAudit(rows)).toThrow();
  }
  const rows = empty();
  rows[0] = Array(1001).fill({ count: 0 });
  expect(() => validateIdentityAudit(rows)).toThrow();
  expect(
    IDENTITY_AUDIT_QUERIES.every((q) => /^(WITH|SELECT)/.test(q.sql)),
  ).toBe(true);
});
test("audit detects duplicate and ineligible exposure if a current view regresses", () => {
  const db = fixture();
  try {
    db.exec(`DROP VIEW current_identity_observations;
      CREATE VIEW current_identity_observations AS
      SELECT o.*,r.parse_run_id FROM identity_observations o JOIN identity_runs r ON r.id=o.identity_run_id
      UNION ALL SELECT o.*,r.parse_run_id FROM identity_observations o JOIN identity_runs r ON r.id=o.identity_run_id;`);
    const report = validateIdentityAudit(IDENTITY_AUDIT_QUERIES.map((q) => db.query(q.sql).all()));
    expect(report.find((s) => s.name === "integrity")!.rows[0]).toMatchObject({
      duplicate_current_observation: 7,
      ineligible_current_observation: 6,
    });
    expect(JSON.stringify(report)).not.toContain("PRIVATE_");
  } finally {
    db.close();
  }
});
test("all queries compile against the complete production schema without compound-select expansion limits", () => {
  const db = new Database(":memory:");
  const directory = new URL("../../raw-evidence/migrations/", import.meta.url);
  try {
    for (const name of readdirSync(directory)
      .filter((name) => name.endsWith(".sql"))
      .sort())
      db.exec(readFileSync(new URL(name, directory), "utf8"));
    const report = validateIdentityAudit(
      IDENTITY_AUDIT_QUERIES.map((q) => db.query(q.sql).all()),
    );
    expect(
      report
        .find((s) => s.name === "integrity")!
        .rows.every((row) =>
          Object.values(row as Record<string, number>).every(
            (count) => count === 0,
          ),
        ),
    ).toBe(true);
  } finally {
    db.close();
  }
});
