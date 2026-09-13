// The A10 read side over the real Layer B/C schema (migrations 0017+ on a
// minimal synthetic Layer A). Proves that a figure always names its basis, that
// an obligation's outstanding amount is computed from settlements with exact
// arithmetic, that a provider-reported balance and the event-derived balance are
// shown side by side with their difference, and that correcting a wrong merge
// appends a revision instead of rewriting one.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createEventsReader, type EventsReader } from "../src/index";
import type { SqlExecutor } from "../src/reader";

const MIGRATIONS = join(import.meta.dir, "../../../packages/storage-d1/migrations/core");
const LAYER_A = `CREATE TABLE sources(id TEXT PRIMARY KEY,provider TEXT);
CREATE TABLE ingest_clients(id TEXT PRIMARY KEY,active INTEGER);
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
INSERT INTO sources VALUES('synthetic-card','synthetic');
INSERT INTO producers VALUES('synthetic-producer');
INSERT INTO acquisition_sessions(id,external_session_id) VALUES(1,'synthetic-1');
INSERT INTO fetch_runs(id,source_id,acquisition_session_id,producer_id,first_recorded_at_ms) VALUES(1,'synthetic-card',1,'synthetic-producer',0);
INSERT INTO fetch_run_reports VALUES(1,'terminal','success',0,0);
INSERT INTO fetch_run_seals(fetch_run_id) VALUES(1);
INSERT INTO fetch_artifacts(id,fetch_run_id,source_id,dataset,artifact_key,sha256) VALUES(1,1,'synthetic-card','synthetic','a.json','ab');`;

const DATE = `'{"kind":"local-date","value":"2026-03-01","zone":null,"basis":"provider"}'`;

/** One decision per C row; 0029 admits only `relation` beside the mapping kinds. */
function decision(id: string, subjectRef: string): string {
  return `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
VALUES('${id}','relation','${subjectRef}',1,'accept','rule','rule:test',NULL,'synthetic','[]',NULL,NULL,'2026-03-01T00:00:00Z');`;
}

function seededDatabase(): Database {
  const db = new Database(":memory:");
  db.exec(LAYER_A);
  for (const name of readdirSync(MIGRATIONS)
    // 0043 only removes historical bootstrap rows from the full Layer A
    // schema; this deliberately minimal stub has neither those rows nor
    // the registry and append-only guards that the cleanup touches.
    .filter(
      (entry) =>
        entry.endsWith(".sql") &&
        entry >= "0017" &&
        entry !== "0043_remove_synthetic_bootstrap.sql",
    )
    .sort())
    db.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
  db.exec(`INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(1,1,'synthetic','1','2026-03-01','pending','[]');
INSERT INTO transaction_observations(id,parse_run_id,source_account,external_id,status,amount_minor,amount_text,amount_scale,currency,raw_locator,extra_json)
 VALUES(1,1,'account:card','row-1','posted',-3000,'-3000',0,'JPY','json:$.rows[0]','{}');
INSERT INTO balance_observations(id,parse_run_id,source_account,metric,instrument,amount_minor,amount_text,raw_locator,extra_json)
 VALUES(1,1,'account:card','balance','JPY',-2500,'-2500','json:$.balance','{}');
UPDATE parse_runs SET status='ok' WHERE id=1;
INSERT INTO publication_events(fetch_artifact_id,parser_name,previous_parse_run_id,new_parse_run_id,kind,actor,reason,occurred_at) VALUES(1,'synthetic',NULL,1,'normal','pipeline','parse_ok','2026-03-01');
INSERT INTO published_parse_runs(fetch_artifact_id,parser_name,parse_run_id,parser_version,published_at,publication_kind) VALUES(1,'synthetic',1,'1','2026-03-01','normal');`);
  // One purchase: 3,000 JPY of cost recognised at purchase, and the same 3,000
  // leaving the card account as a cash movement. Two bases, one event.
  db.exec(`${decision("dr_event_1", "event:ev-purchase-1")}
INSERT INTO economic_event_revisions(event_id,revision,kind,state,unknown_reason,effective_time_json,basis,evidence_support_json,decision_revision_id,superseded_by,created_at)
 VALUES('ev-purchase-1',1,'purchase','captured',NULL,${DATE},'purchase-recognition',
  '[{"kind":"transaction","id":"transaction:1","revision":"parse_run:1"}]','dr_event_1',NULL,'2026-03-01T00:00:00Z');
INSERT INTO economic_legs VALUES('ev-purchase-1',1,0,'account:card','JPY','exact','3000',0,NULL,'decrease','cash-movement');
INSERT INTO economic_legs VALUES('ev-purchase-1',1,1,'claim:cost','JPY','exact','3000',0,NULL,'increase','purchase-recognition');`);
  // One obligation of 12,000 with one 4,000 settlement and a confirmed fee.
  db.exec(`${decision("dr_obl_1", "obligation:obl-1")}
INSERT INTO obligation_revisions(obligation_id,revision,creditor_ref,debtor_ref,principal_unit_ref,principal_status,principal_coefficient,principal_scale,fee_components_json,schedule_json,state,unknown_reason,state_evidence_refs_json,decision_revision_id,superseded_by,created_at)
 VALUES('obl-1',1,'party:issuer','party:self','JPY','exact','12000',0,
  '[{"code":"instalment-fee","quantity":{"unitRef":"JPY","value":{"status":"exact","value":{"coefficient":"100","scale":0},"normalizationVersion":"decimal-v1"}},"confirmed":true},
    {"code":"instalment-fee","quantity":{"unitRef":"JPY","value":{"status":"exact","value":{"coefficient":"200","scale":0},"normalizationVersion":"decimal-v1"}},"confirmed":false}]',
  '[]','partially-settled',NULL,'["transaction:1"]','dr_obl_1',NULL,'2026-03-01T00:00:00Z');
${decision("dr_settle_1", "settlement:st-1")}
INSERT INTO settlement_relations(id,obligation_id,settlement_component_ref,unit_ref,coefficient,scale,occurred_json,unresolved_coefficient,unresolved_scale,decision_revision_id,superseded_by,created_at)
 VALUES('st-1','obl-1','leg:ev-purchase-1#0','JPY','4000',0,${DATE},NULL,NULL,'dr_settle_1',NULL,'2026-03-01T00:00:00Z');`);
  return db;
}

function reader(db: Database): EventsReader {
  const sql: SqlExecutor = {
    all: async <T>(statement: string, args: readonly unknown[]) =>
      db.query(statement).all(...(args as never[])) as T[],
    first: async <T>(statement: string, args: readonly unknown[]) =>
      (db.query(statement).get(...(args as never[])) ?? null) as T | null,
  };
  return createEventsReader(sql, { pageSize: 10 });
}

describe("activity carries its basis and explains itself", () => {
  test("the same purchase appears on both bases with different totals (SC02, SC04)", async () => {
    const db = seededDatabase();
    const cash = await reader(db).activity({ basis: "cash-movement", offset: 0 });
    expect(cash.items).toHaveLength(1);
    const event = cash.items[0]!;
    expect(event).toMatchObject({ eventId: "ev-purchase-1", kind: "purchase", state: "captured" });
    // Two bases, two totals; nothing merges them into one number.
    expect(event.totals).toEqual([
      {
        basis: "cash-movement",
        quantity: {
          unitRef: "JPY",
          value: {
            status: "exact",
            value: { coefficient: "3000", scale: 0 },
            normalizationVersion: "exact-arith-v1",
          },
        },
      },
      {
        basis: "purchase-recognition",
        quantity: {
          unitRef: "JPY",
          value: {
            status: "exact",
            value: { coefficient: "3000", scale: 0 },
            normalizationVersion: "exact-arith-v1",
          },
        },
      },
    ]);
    const recognition = await reader(db).activity({ basis: "purchase-recognition", offset: 0 });
    expect(recognition.items.map((item) => item.eventId)).toEqual(["ev-purchase-1"]);
    expect(cash.nextCursor).toBeNull();
  });

  test("explanation runs event → legs → source facts → raw locator", async () => {
    const db = seededDatabase();
    const page = await reader(db).activity({ basis: "cash-movement", offset: 0 });
    expect(page.items[0]!.explanationRefs).toEqual([
      "event:ev-purchase-1@1",
      "leg:ev-purchase-1@1#0",
      "leg:ev-purchase-1@1#1",
      "transaction:transaction:1@parse_run:1",
      "raw_locator:json:$.rows[0]",
      "raw_object:ab",
      "decision_revision:dr_event_1",
    ]);
  });
});

describe("obligations compute outstanding from settlements", () => {
  test("12,000 principal minus a 4,000 settlement leaves 8,000, fees stay apart (SC04)", async () => {
    const db = seededDatabase();
    const page = await reader(db).obligations({ offset: 0 });
    expect(page.items).toHaveLength(1);
    const obligation = page.items[0]!;
    expect(obligation.state).toBe("partially-settled");
    expect(obligation.settled?.value).toMatchObject({ value: { coefficient: "4000", scale: 0 } });
    expect(obligation.outstanding?.value).toMatchObject({
      value: { coefficient: "8000", scale: 0 },
    });
    expect(obligation.outstandingReasonCode).toBeNull();
    expect(obligation.confirmedFees?.value).toMatchObject({ value: { coefficient: "100" } });
    expect(obligation.projectedFees?.value).toMatchObject({ value: { coefficient: "200" } });
    expect(obligation.explanationRefs).toContain("settlement:st-1");
  });

  test("a non-exact principal leaves the outstanding amount unknown, never zero (INV05)", async () => {
    const db = seededDatabase();
    db.exec(`${decision("dr_obl_2", "obligation:obl-2")}
INSERT INTO obligation_revisions(obligation_id,revision,creditor_ref,debtor_ref,principal_unit_ref,principal_status,principal_coefficient,principal_scale,fee_components_json,schedule_json,state,unknown_reason,state_evidence_refs_json,decision_revision_id,superseded_by,created_at)
 VALUES('obl-2',1,'party:issuer','party:self','JPY','unparsed',NULL,NULL,'[]','[]','unknown','provider_status_absent','[]','dr_obl_2',NULL,'2026-03-01T00:00:00Z');`);
    const page = await reader(db).obligations({ offset: 0 });
    const unknown = page.items.find((item) => item.obligationId === "obl-2")!;
    expect(unknown.outstanding).toBeNull();
    expect(unknown.outstandingReasonCode).toBe("principal_unparsed");
    expect(unknown.unknownReason).toBe("provider_status_absent");
  });
});

describe("provider-reported against event-derived", () => {
  test("the difference is a signal with reasons, not an adjustment entry", async () => {
    const db = seededDatabase();
    const signals = await reader(db).reconciliationSignals({ subjectRefs: ["account:card"] });
    expect(signals).toHaveLength(1);
    const signal = signals[0]!;
    expect(signal.kind).toBe("difference");
    // Provider says −2,500; the adopted events imply −3,000; the gap is 500.
    expect(signal.providerReported.value).toMatchObject({ value: { coefficient: "-2500" } });
    expect(signal.eventDerived.value).toMatchObject({ value: { coefficient: "-3000" } });
    expect(signal.difference?.value).toMatchObject({ value: { coefficient: "500" } });
    expect(signal.reasonCodes).toContain("snapshot_boundary_unknown");
    expect(signal.evidenceRefs).toEqual(["balance:1"]);
    // Nothing was written to make the two agree.
    expect(
      db.query("SELECT count(*) AS n FROM economic_event_revisions").get() as { n: number },
    ).toEqual({ n: 1 });
  });

  test("no adopted event leaves the derived side absent rather than zero", async () => {
    const db = seededDatabase();
    db.exec(
      `INSERT INTO balance_observations(id,parse_run_id,source_account,metric,instrument,amount_minor,amount_text,raw_locator,extra_json)
       VALUES(2,1,'account:other','balance','JPY',100,'100','json:$.b','{}');`,
    );
    const signals = await reader(db).reconciliationSignals({ subjectRefs: ["account:other"] });
    expect(signals[0]!.eventDerived.value).toEqual({
      status: "missing",
      reasonCode: "no_adopted_events",
    });
    expect(signals[0]!.difference).toBeNull();
    expect(signals[0]!.reasonCodes).toContain("derived_no_adopted_events");
  });
});

describe("corrections append; they never rewrite", () => {
  test("a wrong merge is undone by a new revision and the old one is still readable", async () => {
    const db = seededDatabase();
    const before = await reader(db).activity({ basis: "cash-movement", offset: 0 });
    expect(before.items.map((item) => item.revision)).toEqual([1]);
    // Revision 2 replaces revision 1 with the corrected legs. Only the pointer
    // on the old row is written; every fact column stays as it was.
    db.exec(`${decision("dr_event_2", "event:ev-purchase-1")}
INSERT INTO economic_event_revisions(event_id,revision,kind,state,unknown_reason,effective_time_json,basis,evidence_support_json,decision_revision_id,superseded_by,created_at)
 VALUES('ev-purchase-1',2,'purchase','captured',NULL,${DATE},'purchase-recognition',
  '[{"kind":"transaction","id":"transaction:1","revision":"parse_run:1"}]','dr_event_2',NULL,'2026-03-02T00:00:00Z');
INSERT INTO economic_legs VALUES('ev-purchase-1',2,0,'account:card','JPY','exact','2500',0,NULL,'decrease','cash-movement');
UPDATE economic_event_revisions SET superseded_by='ev-purchase-1@2' WHERE event_id='ev-purchase-1' AND revision=1;`);
    const after = await reader(db).activity({ basis: "cash-movement", offset: 0 });
    expect(after.items.map((item) => item.revision)).toEqual([2]);
    expect(after.items[0]!.totals[0]!.quantity.value).toMatchObject({
      value: { coefficient: "2500" },
    });
    // The superseded revision and its legs are retained, so a report that
    // referenced `event:ev-purchase-1@1` still resolves to the same numbers.
    const old = db
      .query(
        "SELECT superseded_by,decision_revision_id FROM economic_event_revisions WHERE event_id='ev-purchase-1' AND revision=1",
      )
      .get() as { superseded_by: string; decision_revision_id: string };
    expect(old).toEqual({ superseded_by: "ev-purchase-1@2", decision_revision_id: "dr_event_1" });
    expect(
      db
        .query(
          "SELECT coefficient FROM economic_legs WHERE event_id='ev-purchase-1' AND revision=1 AND leg_index=0",
        )
        .get(),
    ).toEqual({ coefficient: "3000" });
  });

  test("a fact column of a stored revision cannot be updated at all", () => {
    const db = seededDatabase();
    expect(() =>
      db.exec(
        "UPDATE economic_event_revisions SET state='canceled' WHERE event_id='ev-purchase-1'",
      ),
    ).toThrow(/event_supersession_invalid/u);
    expect(() => db.exec("DELETE FROM economic_legs")).toThrow(/append-only/u);
    expect(() => db.exec("UPDATE economic_legs SET coefficient='1'")).toThrow(/append-only/u);
  });
});

describe("allocations", () => {
  test("the same source cannot be allocated twice to the same effect (INV06)", () => {
    const db = seededDatabase();
    const insert = (id: string) =>
      db.exec(`${decision(`dr_alloc_${id}`, `allocation:${id}`)}
INSERT INTO allocations(id,source_component_ref,target_effect_ref,role,unit_ref,coefficient,scale,decision_revision_id,superseded_by,created_at)
 VALUES('${id}','transaction:1','event:ev-purchase-1','principal','JPY','3000',0,'dr_alloc_${id}',NULL,'2026-03-01T00:00:00Z');`);
    insert("al-1");
    expect(() => insert("al-2")).toThrow(/UNIQUE/u);
    // Superseding the first one frees the pair for a corrected allocation.
    db.exec(`${decision("dr_alloc_al-3", "allocation:al-3")}
INSERT INTO allocations(id,source_component_ref,target_effect_ref,role,unit_ref,coefficient,scale,decision_revision_id,superseded_by,created_at)
 VALUES('al-3','transaction:1','event:ev-purchase-other','principal','JPY','3000',0,'dr_alloc_al-3',NULL,'2026-03-01T00:00:00Z');
UPDATE allocations SET superseded_by='al-3' WHERE id='al-1';`);
    insert("al-4");
    // Three rows are stored; the superseded one is retained and is not live.
    expect(db.query("SELECT count(*) AS n FROM allocations").get()).toEqual({ n: 3 });
    expect(db.query("SELECT count(*) AS n FROM current_allocations").get()).toEqual({ n: 2 });
  });

  test("an allocation without its own decision is refused", () => {
    const db = seededDatabase();
    expect(() =>
      db.exec(`INSERT INTO allocations(id,source_component_ref,target_effect_ref,role,unit_ref,coefficient,scale,decision_revision_id,superseded_by,created_at)
 VALUES('al-x','transaction:1','event:ev-purchase-1','principal','JPY','3000',0,'dr_event_1',NULL,'2026-03-01T00:00:00Z');`),
    ).toThrow(/allocation_invalid/u);
  });

  test("live allocations of an event reach the activity view", async () => {
    const db = seededDatabase();
    db.exec(`${decision("dr_alloc_live", "allocation:al-live")}
INSERT INTO allocations(id,source_component_ref,target_effect_ref,role,unit_ref,coefficient,scale,decision_revision_id,superseded_by,created_at)
 VALUES('al-live','transaction:1','event:ev-purchase-1','principal','JPY','3000',0,'dr_alloc_live',NULL,'2026-03-01T00:00:00Z');`);
    const page = await reader(db).activity({ basis: "cash-movement", offset: 0 });
    expect(page.items[0]!.allocations).toEqual([
      {
        allocationId: "al-live",
        sourceComponentRef: "transaction:1",
        targetEffectRef: "event:ev-purchase-1",
        role: "principal",
        quantity: {
          unitRef: "JPY",
          value: {
            status: "exact",
            value: { coefficient: "3000", scale: 0 },
            normalizationVersion: "decimal-v1",
          },
        },
      },
    ]);
    expect(page.items[0]!.explanationRefs).toContain("allocation:al-live");
  });
});
