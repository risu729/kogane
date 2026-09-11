// G2-14 for the run seal, over the whole CORE schema with foreign keys on:
// when the identifying columns of the inventory do not match what the first
// statement wrote (or found), every later statement of the batch matches
// nothing — no items, no seal, no attempt. A batch is not rolled back because
// a conditional INSERT wrote zero rows (unified plan 09 §2), so this is the
// property that keeps a failed guard from leaving a half-sealed run.
//
// Synthetic only: a source called "seal-source", one artifact of three bytes.
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  inventoryItemStatements,
  sealRunStatements,
  sealStagedInventoryStatements,
  type SealRunInput,
} from "../src/atomic/seal.ts";
import { fullCoreDatabase, sqliteD1 } from "./sqlite.ts";

const RUN_ID = 1;
const CLIENT = "seal-client";
const OTHER_CLIENT = "other-client";
const OBJECT_SHA256 = "a".repeat(64);
const DESCRIPTOR_SHA256 = "b".repeat(64);
const INVENTORY_SHA256 = "c".repeat(64);
const NOW = 2_000;

/** One registered, catalogued run with its terminal report: sealable. */
const FIXTURE = `INSERT INTO sources(id,provider,display_name) VALUES('seal-source','synthetic','Seal source');
INSERT INTO producers(id,kind,display_name) VALUES('seal-producer','collector','Seal producer');
INSERT INTO producer_sources(producer_id,source_id) VALUES('seal-producer','seal-source');
INSERT INTO ingest_clients(id,display_name) VALUES('${CLIENT}','Seal client'),('${OTHER_CLIENT}','Other client');
INSERT INTO ingest_client_producers(ingest_client_id,producer_id)
  VALUES('${CLIENT}','seal-producer'),('${OTHER_CLIENT}','seal-producer');
INSERT INTO ingest_client_routes(ingest_client_id,producer_id,source_id)
  VALUES('${CLIENT}','seal-producer','seal-source'),('${OTHER_CLIENT}','seal-producer','seal-source');
INSERT INTO acquisition_sessions(id,producer_id,first_recorded_by_client_id,external_id_namespace,external_session_id,first_recorded_at_ms)
  VALUES(1,'seal-producer','${CLIENT}','test','seal-session',1000);
INSERT INTO fetch_runs(id,acquisition_session_id,producer_id,source_id,first_recorded_by_client_id,first_recorded_at_ms)
  VALUES(${RUN_ID},1,'seal-producer','seal-source','${CLIENT}',1000);
INSERT INTO raw_objects(sha256,byte_size,blob_key,first_stored_at_ms) VALUES('${OBJECT_SHA256}',3,'objects/aa/${OBJECT_SHA256}',1000);
INSERT INTO fetch_artifacts(id,fetch_run_id,source_id,producer_id,first_ingested_by_client_id,artifact_key,artifact_role,
  payload_fidelity,container_kind,lineage_disposition,sha256,byte_size,descriptor_version,descriptor_sha256,recorded_at_ms)
  VALUES(1,${RUN_ID},'seal-source','seal-producer','${CLIENT}','seal.json','provider_response','exact','single','not_applicable',
  '${OBJECT_SHA256}',3,'v1','${DESCRIPTOR_SHA256}',1000);
INSERT INTO fetch_run_reports(fetch_run_id,report_key,report_kind,recorded_by_client_id,normalized_outcome,
  declared_artifact_count,artifact_count_scope,recorded_at_ms)
  VALUES(${RUN_ID},'terminal','terminal','${CLIENT}','success',1,'all_catalogued',1000);`;

const ITEM = {
  artifactKey: "seal.json",
  sha256: OBJECT_SHA256,
  descriptorSha256: DESCRIPTOR_SHA256,
};

function sealInput(overrides: Partial<SealRunInput> = {}): SealRunInput {
  return {
    runId: RUN_ID,
    inventorySha256: INVENTORY_SHA256,
    expectedArtifactCount: 1,
    declarationBasis: "producer_manifest",
    clientId: CLIENT,
    submitted: [ITEM],
    producerId: "seal-producer",
    sourceId: "seal-source",
    externalAttemptId: "attempt-1",
    startedAtMs: 1_500,
    now: NOW,
    ...overrides,
  };
}

let db: Database;

/** Row counts of every table the seal touches. */
function counts(): Record<string, number> {
  const one = (sql: string): number => (db.query(sql).get() as { n: number }).n;
  return {
    inventories: one("SELECT count(*) AS n FROM run_inventories"),
    items: one("SELECT count(*) AS n FROM run_inventory_items"),
    seals: one("SELECT count(*) AS n FROM fetch_run_seals"),
    attempts: one("SELECT count(*) AS n FROM ingestion_attempts"),
  };
}

beforeEach(() => {
  db = fullCoreDatabase();
  db.exec(FIXTURE);
});

describe("the direct seal batch (G2-14)", () => {
  test("a declaration the catalogue satisfies writes the inventory, its item, the seal and the attempt", async () => {
    const results = await sqliteD1(db).batch(sealRunStatements(sqliteD1(db), sealInput()));
    // The seal's own row plus the work item its AFTER INSERT trigger enqueues
    // (0035): the fake counts trigger writes too, so the seal statement
    // reports more than one change. The table counts are the fact.
    expect(results.map((result) => result.meta.changes > 0)).toEqual([true, true, true, true]);
    expect(results.map((result) => result.meta.changes).slice(0, 2)).toEqual([1, 1]);
    expect(counts()).toEqual({ inventories: 1, items: 1, seals: 1, attempts: 1 });
    const attempt = db
      .query(
        "SELECT outcome, accepted_artifact_count, reused_artifact_count FROM ingestion_attempts",
      )
      .get() as Record<string, unknown>;
    expect(attempt).toEqual({
      outcome: "complete",
      accepted_artifact_count: 1,
      reused_artifact_count: 0,
    });
  });

  test("an inventory that exists under another basis leaves items, seal and attempt unwritten", async () => {
    // The same digest was declared earlier with a different basis. The first
    // statement finds it and writes nothing; every later statement restates
    // the basis and so matches nothing either — not "the seal but no attempt".
    db.exec(`INSERT INTO run_inventories(fetch_run_id,inventory_sha256,expected_artifact_count,inventory_digest_version,
      declaration_basis,created_at_ms,created_by_client_id)
      VALUES(${RUN_ID},'${INVENTORY_SHA256}',1,'v1','directory_scan',1000,'${CLIENT}')`);
    const before = counts();

    const results = await sqliteD1(db).batch(sealRunStatements(sqliteD1(db), sealInput()));

    expect(results.map((result) => result.meta.changes)).toEqual([0, 0, 0, 0]);
    expect(counts()).toEqual(before);
    expect(before).toEqual({ inventories: 1, items: 0, seals: 0, attempts: 0 });
  });

  test("another client cannot seal against an inventory it did not declare", async () => {
    db.exec(`INSERT INTO run_inventories(fetch_run_id,inventory_sha256,expected_artifact_count,inventory_digest_version,
      declaration_basis,created_at_ms,created_by_client_id)
      VALUES(${RUN_ID},'${INVENTORY_SHA256}',1,'v1','producer_manifest',1000,'${OTHER_CLIENT}')`);
    const before = counts();

    const results = await sqliteD1(db).batch(sealRunStatements(sqliteD1(db), sealInput()));

    expect(results.map((result) => result.meta.changes)).toEqual([0, 0, 0, 0]);
    expect(counts()).toEqual(before);
  });

  test("a run that is already sealed takes no second seal and no second attempt", async () => {
    await sqliteD1(db).batch(sealRunStatements(sqliteD1(db), sealInput()));
    const after = counts();

    // A replay under a new attempt id: the inventory and item statements
    // find their rows, the seal statement is guarded on "no seal yet" and the
    // attempt statement records the reuse against the inventory it names.
    const replay = await sqliteD1(db).batch(
      sealRunStatements(sqliteD1(db), sealInput({ externalAttemptId: "attempt-2", now: NOW + 1 })),
    );
    expect(replay.map((result) => result.meta.changes)).toEqual([0, 0, 0, 1]);
    expect(counts()).toEqual({ ...after, attempts: 2 });
    expect(
      db
        .query("SELECT reused_artifact_count FROM ingestion_attempts ORDER BY id DESC LIMIT 1")
        .get(),
    ).toEqual({ reused_artifact_count: 1 });
    // The same attempt id again is a schema error, and the batch is atomic.
    await expect(
      sqliteD1(db).batch(sealRunStatements(sqliteD1(db), sealInput({ now: NOW + 2 }))),
    ).rejects.toThrow();
    expect(counts()).toEqual({ ...after, attempts: 2 });
  });
});

describe("the staged seal batch (G2-14)", () => {
  test("seals a staged inventory and records the attempt together, once", async () => {
    db.exec(`INSERT INTO run_inventories(id,fetch_run_id,inventory_sha256,expected_artifact_count,inventory_digest_version,
      declaration_basis,created_at_ms,created_by_client_id)
      VALUES(7,${RUN_ID},'${INVENTORY_SHA256}',1,'v1','producer_manifest',1000,'${CLIENT}')`);
    await sqliteD1(db).batch(inventoryItemStatements(sqliteD1(db), RUN_ID, 7, [ITEM]));
    const input = {
      runId: RUN_ID,
      inventoryId: 7,
      producerId: "seal-producer",
      sourceId: "seal-source",
      clientId: CLIENT,
      externalAttemptId: "staged-1",
      startedAtMs: 1_500,
      expectedArtifactCount: 1,
      now: NOW,
    };

    const results = await sqliteD1(db).batch(sealStagedInventoryStatements(sqliteD1(db), input));
    expect(results.map((result) => result.meta.changes > 0)).toEqual([true, true]);
    expect(counts()).toEqual({ inventories: 1, items: 1, seals: 1, attempts: 1 });

    // Replaying the same attempt is refused as a whole by the schema: the
    // seal statement matches nothing and the duplicate attempt aborts the
    // batch, so neither half lands on its own.
    await expect(
      sqliteD1(db).batch(sealStagedInventoryStatements(sqliteD1(db), { ...input, now: NOW + 1 })),
    ).rejects.toThrow();
    expect(counts()).toEqual({ inventories: 1, items: 1, seals: 1, attempts: 1 });
  });
});
