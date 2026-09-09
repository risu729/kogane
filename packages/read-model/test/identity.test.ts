// Identity read modes over the real Layer B/C schema (migrations 0017+ on a
// minimal synthetic Layer A). Proves AT63 at the query level: a correction
// changes `latest` and never `as-recorded`, and the context says which was read.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  IDENTITY_READ_MODES,
  type InterpretationContext,
  LOCAL_STORE_CAPABILITIES,
  validInterpretationContext,
} from "../../../poc/observation-pipeline/shared/api-schema";
import {
  DECIMAL_POLICY_RELEASE,
  DEFAULT_IDENTITY_READ_MODE,
  identityReleaseFor,
  interpretationContext,
  isIdentityReadMode,
  LATEST_IDENTITY_RELEASE,
  MAPPING_RELATIONS,
  MEASURE_POLICY_RELEASE,
  NO_RECORDED_IDENTITY_RELEASE,
  organizationSql,
} from "../src/index";

const MIGRATIONS = join(import.meta.dir, "../../../services/raw-evidence/migrations");
const LAYER_A = `CREATE TABLE sources(id TEXT PRIMARY KEY,provider TEXT);
CREATE TABLE producers(id TEXT PRIMARY KEY);
CREATE TABLE fetch_runs(id INTEGER PRIMARY KEY,source_id TEXT,acquisition_session_id INTEGER,producer_id TEXT,first_recorded_at_ms INTEGER,source_run_key TEXT DEFAULT 'default');
CREATE TABLE fetch_run_annotations(fetch_run_id INTEGER,annotation_kind TEXT);
CREATE VIEW financial_fetch_runs AS SELECT * FROM fetch_runs WHERE source_id<>'kogane-synthetic' AND NOT EXISTS(SELECT 1 FROM fetch_run_annotations a WHERE a.fetch_run_id=fetch_runs.id AND a.annotation_kind='exclude_from_financial_views');
CREATE TABLE acquisition_sessions(id INTEGER PRIMARY KEY,external_session_id TEXT,producer_id TEXT,external_id_namespace TEXT);
CREATE TABLE fetch_run_seals(fetch_run_id INTEGER,sealed_at_ms INTEGER NOT NULL DEFAULT 0);
CREATE TABLE fetch_run_reports(fetch_run_id INTEGER,report_kind TEXT,normalized_outcome TEXT,started_at_ms INTEGER,completed_at_ms INTEGER);
CREATE TABLE fetch_units(id INTEGER PRIMARY KEY,fetch_run_id INTEGER,unit_key TEXT,unit_kind TEXT DEFAULT 'card');
CREATE TABLE fetch_unit_reports(fetch_unit_id INTEGER,report_kind TEXT,normalized_outcome TEXT,safe_failure_code TEXT);
CREATE TABLE fetch_artifacts(id INTEGER PRIMARY KEY,fetch_run_id INTEGER,source_id TEXT,dataset TEXT,artifact_key TEXT,fetch_unit_id INTEGER,declared_media_type TEXT,fetched_at_ms INTEGER,recorded_at_ms INTEGER,sha256 TEXT,artifact_role TEXT,format_id TEXT,format_version TEXT);
CREATE TABLE raw_objects(sha256 TEXT PRIMARY KEY,byte_size INTEGER,blob_key TEXT);
CREATE TABLE fetch_run_ranges(id INTEGER PRIMARY KEY,fetch_run_id INTEGER,range_kind TEXT,start_value TEXT,end_value TEXT);
CREATE TABLE artifact_ranges(id INTEGER PRIMARY KEY,fetch_artifact_id INTEGER,range_kind TEXT,start_value TEXT,end_value TEXT);
INSERT INTO sources VALUES('smbc-bank','synthetic');
INSERT INTO producers VALUES('synthetic-producer');
INSERT INTO acquisition_sessions(id,external_session_id) VALUES(1,'synthetic-1');
INSERT INTO fetch_runs(id,source_id,acquisition_session_id,producer_id,first_recorded_at_ms) VALUES(1,'smbc-bank',1,'synthetic-producer',0);
INSERT INTO fetch_run_reports VALUES(1,'terminal','success',0,0);
INSERT INTO fetch_run_seals(fetch_run_id) VALUES(1);
INSERT INTO fetch_artifacts(id,fetch_run_id,source_id,dataset,artifact_key) VALUES(1,1,'smbc-bank','synthetic','a.json');`;

/** Layer B/C schema with one sealed parse whose observation was organized at revision 1. */
function seededDatabase(): Database {
  const db = new Database(":memory:");
  db.exec(LAYER_A);
  for (const name of readdirSync(MIGRATIONS)
    .filter((entry) => entry.endsWith(".sql") && entry >= "0017")
    .sort())
    db.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
  db.exec(`INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(1,1,'synthetic','1','2026-01-01','pending','[]');
INSERT INTO balance_observations(id,parse_run_id,source_account,metric,instrument,raw_locator,extra_json) VALUES(1,1,'smbc-bank:ordinary-yen','balance','JPY','$','{}');
UPDATE parse_runs SET status='ok' WHERE id=1;
INSERT INTO source_accounts VALUES('ref','smbc-bank','synthetic-producer','["smbc-bank:ordinary-yen"]');
INSERT INTO accounts VALUES('rule-account','規則口座','deposit','provider-local'),('manual-account','手動口座','deposit','identified');
INSERT INTO account_mappings VALUES('am1','ref',1,'rule-account','rule','provider-scope',1,'2098-01-01','規則口座','provider-local');
INSERT INTO instruments VALUES('rule-instrument','money','JPY','identified'),('manual-instrument','money','手動通貨','identified');
INSERT INTO instrument_identifiers VALUES('ident','iso4217','global','JPY','{}');
INSERT INTO instrument_mappings VALUES('im1','ident',1,'rule-instrument','rule','iso',1,'2098-01-01','JPY','identified');
INSERT INTO identity_runs VALUES('run',1,1,'2098-01-01');
INSERT INTO identity_observations VALUES('io','run','balance',1,'ref','am1','[]');
INSERT INTO identity_instrument_uses VALUES('io','unit','ident','im1');
INSERT INTO identity_run_seals VALUES('run',1,'2098-01-01');`);
  return db;
}

interface Row {
  account_target: string;
  account_revision: number;
  account_method: string;
  instrument_target: string;
  instrument_revision: number;
  identity_release: string;
}
const organized = (db: Database, mode: "latest" | "as-recorded") =>
  db.query(organizationSql(mode)).all(JSON.stringify([{ kind: "balance", id: 1 }])) as Row[];

describe("identity read modes", () => {
  test("a correction changes latest and never as-recorded (AT63)", () => {
    const db = seededDatabase();
    const before = { latest: organized(db, "latest"), recorded: organized(db, "as-recorded") };
    expect(before.latest).toEqual(before.recorded);
    expect(before.latest[0]).toMatchObject({
      account_target: "rule-account",
      account_revision: 1,
      instrument_target: "rule-instrument",
      instrument_revision: 1,
      identity_release: "identity-default-v1",
    });
    db.exec(`INSERT INTO account_mappings VALUES('am2','ref',2,'manual-account','manual','reviewed',2,'2099-01-01','手動口座','identified');
INSERT INTO instrument_mappings VALUES('im2','ident',2,'manual-instrument','manual','reviewed',2,'2099-01-01','手動通貨','identified');`);
    expect(organized(db, "latest")[0]).toMatchObject({
      account_target: "manual-account",
      account_revision: 2,
      account_method: "manual",
      instrument_target: "manual-instrument",
      instrument_revision: 2,
    });
    expect(organized(db, "as-recorded")).toEqual(before.recorded);
    // The recorded release comes from the run's policy record when one exists.
    db.exec(`INSERT INTO identity_runs VALUES('run-2',1,2,'2099-02-02');
INSERT INTO identity_run_policies VALUES('run-2',1,'vpass-card-binding','vpass-card-binding-v2','${"a".repeat(64)}','[]');
INSERT INTO identity_observations VALUES('io-2','run-2','balance',1,'ref','am2','[]');
INSERT INTO identity_run_seals VALUES('run-2',1,'2099-02-02');`);
    expect(organized(db, "as-recorded")[0]).toMatchObject({
      account_target: "manual-account",
      account_revision: 2,
      identity_release: "vpass-card-binding-v2",
    });
    expect(organized(db, "latest")[0]).toMatchObject({ identity_release: "vpass-card-binding-v2" });
  });

  test("the two modes differ only in the mapping relation they join", () => {
    const latest = organizationSql("latest");
    const recorded = organizationSql("as-recorded");
    expect(latest).toContain(MAPPING_RELATIONS.latest.account);
    expect(latest).toContain(MAPPING_RELATIONS.latest.instrument);
    expect(recorded).toContain(MAPPING_RELATIONS["as-recorded"].account);
    expect(recorded).toContain(MAPPING_RELATIONS["as-recorded"].instrument);
    const normalize = (sql: string) =>
      sql
        .replace(MAPPING_RELATIONS.latest.account, "ACCOUNT")
        .replace(MAPPING_RELATIONS["as-recorded"].account, "ACCOUNT")
        .replace(MAPPING_RELATIONS.latest.instrument, "INSTRUMENT")
        .replace(MAPPING_RELATIONS["as-recorded"].instrument, "INSTRUMENT");
    expect(normalize(latest)).toBe(normalize(recorded));
    for (const sql of [latest, recorded]) {
      expect(sql).toMatch(/\bobservation_fetch_artifacts\b/);
      expect(sql).toMatch(/\beligible_identity_runs\b/);
      expect(sql).not.toMatch(/\b(fetch_runs|fetch_artifacts)\b/);
    }
  });

  test("the interpretation context names every release and validates against the shared contract", () => {
    expect(DEFAULT_IDENTITY_READ_MODE).toBe("latest");
    expect([...IDENTITY_READ_MODES]).toEqual(["latest", "as-recorded"]);
    expect(isIdentityReadMode("as-recorded")).toBe(true);
    expect(isIdentityReadMode("snapshot")).toBe(false);
    const latest = interpretationContext("latest", identityReleaseFor("latest", ["anything"]));
    expect(latest).toEqual({
      mode: "latest",
      snapshotId: null,
      identityRelease: LATEST_IDENTITY_RELEASE,
      productCatalogueRelease: expect.any(String),
      productResolverRelease: expect.any(String),
      measurePolicyRelease: MEASURE_POLICY_RELEASE,
      decimalPolicyRelease: DECIMAL_POLICY_RELEASE,
    });
    expect(DECIMAL_POLICY_RELEASE).toBe("decimal-v1");
    expect(MEASURE_POLICY_RELEASE).toBe("metric-registry-v1");
    // Same keys as InterpretationContext in packages/domain (context.ts).
    expect(Object.keys(latest).sort()).toEqual(
      [
        "mode",
        "snapshotId",
        "identityRelease",
        "productCatalogueRelease",
        "productResolverRelease",
        "measurePolicyRelease",
        "decimalPolicyRelease",
      ].sort(),
    );
    expect(validInterpretationContext(latest)).toBe(true);
    expect(identityReleaseFor("as-recorded", [])).toBe(NO_RECORDED_IDENTITY_RELEASE);
    expect(
      identityReleaseFor("as-recorded", [
        "vpass-card-binding-v2",
        undefined,
        "identity-default-v1",
        "identity-default-v1",
        null,
      ]),
    ).toBe("identity-default-v1+vpass-card-binding-v2");
    const recorded: InterpretationContext = interpretationContext(
      "as-recorded",
      identityReleaseFor("as-recorded", ["identity-default-v1"]),
    );
    expect(validInterpretationContext(recorded)).toBe(true);
    expect(validInterpretationContext({ ...recorded, mode: "snapshot" })).toBe(false);
    expect(validInterpretationContext({ ...recorded, snapshotId: "s" })).toBe(false);
    expect(validInterpretationContext({ ...recorded, identityRelease: "" })).toBe(false);
    expect(LOCAL_STORE_CAPABILITIES.identityReadModes).toEqual([]);
  });
});
