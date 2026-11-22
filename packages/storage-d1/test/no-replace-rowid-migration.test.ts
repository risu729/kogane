// Migration 0106: replacement guards also refuse a replacing insert by rowid.
//
// A table whose primary key is not an INTEGER PRIMARY KEY keeps a hidden
// rowid, and SQLite's REPLACE conflict resolution deletes a row whose rowid
// the new row names, whatever key it states, without firing DELETE triggers
// while recursive_triggers is off (as on D1). Before 0106 the replacement
// guards of 43 such tables (and of `decision_outbox`, whose rowid is an `id`
// its guard does not check) named only declared keys, so a REPLACE by rowid
// deleted a stored row past every guard. Every row and value here is
// synthetic.
import { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { insertRawObjectIfAbsent } from "../src/core/raw-objects.ts";
import { CORE_MIGRATIONS_URL, migrationFiles, migrationSql } from "../src/migrations.ts";
import { seedPilotRows } from "./core-fixture.ts";
import { coreDatabase, sqliteD1 } from "./sqlite.ts";

const MIGRATION = "0106_no_replace_rowid.sql";

/** The tables 0106 guards: each had a replacement guard that did not cover its rowid. */
const GUARDED = [
  "account_mappings",
  "accounts",
  "allocations",
  "approvals",
  "audit_records",
  "card_purchase_recognition_keys",
  "card_purchase_recognitions",
  "card_settlement_allocation_withdrawals",
  "card_settlement_candidates",
  "card_settlement_decisions",
  "change_plans",
  "decision_operations",
  "decision_outbox",
  "decision_revisions",
  "economic_claims",
  "economic_commit_log",
  "economic_event_revisions",
  "economic_event_times",
  "economic_leg_effects",
  "economic_legs",
  "economic_revision_seals",
  "entity_relations",
  "identity_instrument_uses",
  "identity_observations",
  "identity_run_policies",
  "identity_run_seals",
  "identity_runs",
  "identity_vpass_bindings",
  "instrument_identifiers",
  "instrument_mappings",
  "instrument_temporal_acceptances",
  "instrument_temporal_versions",
  "instruments",
  "obligation_revisions",
  "operation_receipts",
  "ops_requests",
  "own_transfer_proposal_retirements",
  "own_transfer_proposals",
  "projection_input_records",
  "raw_objects",
  "reconciliation_proposals",
  "settlement_relations",
  "source_accounts",
];

/**
 * Tables with a BEFORE INSERT trigger that reads its own table but is not a
 * replacement guard on a key the rowid could bypass, and why.
 */
const NOT_ROWID_HOLES: Record<string, string> = {
  // Refuses only a changed code digest; `parser_releases` has no replacement
  // guard at all (docs/design.md#mutation-policy lists it as a limit).
  parser_releases: "no replacement guard",
  // The ordinal (its rowid) must be the stored maximum plus one, which no
  // stored row's ordinal is.
  economic_identity_epochs: "ordinal is max+1",
};

interface Shape {
  table: string;
  withoutRowid: boolean;
  integerKey: string | null;
  /** The WHEN part of each BEFORE INSERT trigger that raises. */
  guards: string[];
}

/** Every table with its rowid shape and its raising BEFORE INSERT triggers. */
function shapes(db: Database): Shape[] {
  const tables = db
    .query(
      "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
    )
    .all() as { name: string; sql: string }[];
  const triggers = db
    .query("SELECT tbl_name AS tbl, sql FROM sqlite_master WHERE type='trigger'")
    .all() as { tbl: string; sql: string }[];
  return tables.map(({ name, sql }) => {
    const keys = (
      db.query(`SELECT name, type, pk FROM pragma_table_info('${name}')`).all() as {
        name: string;
        type: string;
        pk: number;
      }[]
    ).filter((column) => column.pk > 0);
    return {
      table: name,
      withoutRowid: /WITHOUT\s+ROWID/iu.test(sql),
      integerKey:
        keys.length === 1 && keys[0]!.type.toUpperCase() === "INTEGER" ? keys[0]!.name : null,
      guards: triggers
        .filter((t) => t.tbl === name && /BEFORE\s+INSERT/iu.test(t.sql) && /RAISE/iu.test(t.sql))
        .map((t) => t.sql.split(/\bBEGIN\b/iu)[0]!),
    };
  });
}

/**
 * The rowid tables whose replacement guard (a BEFORE INSERT trigger that
 * looks up its own table) does not refuse a stored rowid: no trigger checks
 * `rowid=NEW.rowid`, and the guards do not check an INTEGER PRIMARY KEY,
 * which is the rowid.
 */
function rowidHoles(db: Database): string[] {
  return shapes(db)
    .filter(({ table, withoutRowid, integerKey, guards }) => {
      if (withoutRowid || table in NOT_ROWID_HOLES) return false;
      const self = new RegExp(`\\bFROM\\s+"?${table}"?\\b`, "iu");
      if (!guards.some((when) => self.test(when))) return false;
      if (guards.some((when) => /\browid\s*=\s*NEW\.rowid\b/iu.test(when))) return false;
      const key = integerKey && new RegExp(`\\b${integerKey}\\s*=\\s*NEW\\.${integerKey}\\b`, "iu");
      return !(key && guards.some((when) => self.test(when) && key.test(when)));
    })
    .map(({ table }) => table);
}

/**
 * Tables that refuse a DELETE by trigger but have no replacement guard: a
 * REPLACE on their key or rowid still deletes a stored row. An open limit,
 * written down in docs/design.md#mutation-policy.
 */
const UNGUARDED = [
  "active_releases",
  "calculation_policies",
  "calculation_results",
  "calculation_runs",
  "card_debit_account_statement",
  "card_settlement_debit_account_evidence",
  "collection_run_stages",
  "collection_runs",
  "collection_schedule_revisions",
  "conversion_offers",
  "core_source_revision",
  "evidence_use_restrictions",
  "expiry_rules",
  "fetch_run_annotations",
  "maintenance_survey_decisions",
  "maintenance_survey_fetches",
  "maintenance_survey_proposals",
  "membership_state_claims",
  "metadata_projection_inputs",
  "metadata_projections",
  "observation_artifact_metadata",
  "ops_collector_dispatches",
  "ops_request_stages",
  "parse_run_candidates",
  "parse_runs",
  "provider_maintenance_rules",
  "publication_events",
  "published_parse_runs",
  "release_activation_events",
  "release_comparisons",
  "report_artifacts",
  "report_events",
  "retention_classes",
  "reward_bucket_claims",
  "reward_bucket_claims_v2",
  "reward_programs",
];

/**
 * Unique keys of guarded tables that no guard checks and that hold no key a
 * guard checks: a REPLACE colliding on one still deletes the stored row. An
 * open limit, written down in docs/design.md#mutation-policy.
 */
const UNCHECKED_KEYS = [
  "allocations(source_component_ref,target_effect_ref,role)",
  "audit_records(principal,operation,idempotency_key)",
  "audit_records(confirms_audit_id)",
  "identity_run_policies(parse_run_id,policy_family,policy_release,dependency_digest)",
  "ops_requests(principal,kind,idempotency_key)",
  "parser_releases(release_id)",
  "reconciliation_proposals(proposal_digest)",
  "settlement_relations(obligation_id,settlement_component_ref)",
];

/** The guard limits above, read from a schema. */
function guardLimits(db: Database): { unguarded: string[]; unchecked: string[] } {
  const deletes = new Set(
    (
      db
        .query(
          "SELECT tbl_name AS tbl FROM sqlite_master WHERE type='trigger' AND sql LIKE '%BEFORE DELETE%' AND sql LIKE '%RAISE%'",
        )
        .all() as { tbl: string }[]
    ).map((row) => row.tbl),
  );
  const unguarded: string[] = [];
  const unchecked: string[] = [];
  for (const { table, guards: all } of shapes(db)) {
    const self = new RegExp(`\\bFROM\\s+"?${table}"?\\b`, "iu");
    const guards = all.filter((when) => self.test(when));
    if (guards.length === 0) {
      if (deletes.has(table)) unguarded.push(table);
      continue;
    }
    const keys = (
      db.query(`SELECT name FROM pragma_index_list('${table}') WHERE "unique"=1`).all() as {
        name: string;
      }[]
    ).map(({ name }) =>
      (db.query(`SELECT name FROM pragma_index_info('${name}')`).all() as { name: string }[]).map(
        (column) => column.name,
      ),
    );
    const named = (key: string[]) =>
      key.every((column) =>
        guards.some((when) =>
          new RegExp(`\\b${column}\\s*(=|IS)\\s*NEW\\.${column}\\b`, "iu").test(when),
        ),
      );
    const checked = keys.filter(named);
    for (const key of keys) {
      if (named(key) || checked.some((k) => k.every((column) => key.includes(column)))) continue;
      unchecked.push(`${table}(${key.join(",")})`);
    }
  }
  return { unguarded, unchecked };
}

const T = "2026-01-05T00:00:00Z";
const HEX = (c: string) => c.repeat(64);
const AUDIT_ID = (n: number) => `aud_0000000${n}-0000-4000-8000-000000000000`;
const CORRELATION = "00000000-0000-4000-8000-000000000000";

/**
 * Stored rows for the representative cases: Layer A evidence, identity, the
 * decision log, economic events, plans and receipts, the outbox and audit.
 * Each case below replaces a row nothing references, so foreign keys (on, as
 * on D1) do not stop the REPLACE before the guards are reached.
 */
const SEED = [
  `INSERT INTO raw_objects(sha256,byte_size,blob_key,first_stored_at_ms) VALUES('${HEX("e")}',1,'objects/ee/synthetic',1000)`,
  `INSERT INTO accounts(id,label,role,status) VALUES('synthetic-account','Synthetic','asset','identified')`,
  `INSERT INTO decision_operations(operation_id,actor_id,actor_verification,action,payload_digest,result_json,created_at)
    VALUES('synthetic-operation','synthetic-actor','server','synthetic','${HEX("1")}','{}','${T}')`,
  `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
    VALUES('synthetic-event-decision','relation','event:synthetic-event',1,'accept','manual','synthetic-actor',NULL,'synthetic','[]',NULL,NULL,'${T}')`,
  `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
    VALUES('synthetic-leaf-decision','relation','relation:synthetic',1,'accept','manual','synthetic-actor',NULL,'synthetic','[]',NULL,NULL,'${T}')`,
  `INSERT INTO economic_event_revisions(event_id,revision,kind,state,unknown_reason,effective_time_json,basis,evidence_support_json,decision_revision_id,superseded_by,created_at)
    VALUES('synthetic-event',1,'charge','observed',NULL,'{"kind":"date","date":"2026-01-05"}','cash-movement','["synthetic"]','synthetic-event-decision',NULL,'${T}')`,
  `INSERT INTO change_plans(plan_id,kind,payload_json,base_context_id,expected_revisions_json,simulation_json,created_by,created_at,expires_at,status)
    VALUES('${HEX("2")}','relation.accept','{}','synthetic','{}','{}','synthetic-actor','${T}','${T}','planned'),
          ('${HEX("3")}','relation.accept','{}','synthetic','{}','{}','synthetic-actor','${T}','${T}','planned')`,
  `INSERT INTO operation_receipts(operation_id,principal,operation_kind,payload_digest,plan_id,status,result_json,created_at,published_at)
    VALUES('synthetic-receipt','synthetic-principal','relation.accept','${HEX("4")}','${HEX("2")}','accepted','{}','${T}',NULL),
          ('synthetic-leaf-receipt','synthetic-principal','relation.accept','${HEX("5")}','${HEX("2")}','accepted','{}','${T}',NULL)`,
  `INSERT INTO decision_outbox(decision_revision_id,principal,operation_id,target,enqueued_at,available_at_ms)
    VALUES('synthetic-event-decision','synthetic-principal','synthetic-receipt','agent-notify','${T}',0)`,
  `INSERT INTO audit_records(audit_id,recorded_at,path,subject,principal,principal_kind,operation,risk_class,step,result,correlation_id,diff_json)
    VALUES('${AUDIT_ID(1)}','2026-01-05T00:00:00.000Z','ui','synthetic','synthetic','human','synthetic.read','R0','call','read','${CORRELATION}','{"kind":"none"}')`,
];

/** A stored row, and a REPLACE that names its rowid but states another key. */
const CASES = [
  {
    table: "raw_objects",
    stored: `sha256='${HEX("e")}'`,
    replace: (rowid: number) =>
      `INSERT OR REPLACE INTO raw_objects(rowid,sha256,byte_size,blob_key,first_stored_at_ms)
        VALUES(${rowid},'${HEX("f")}',1,'objects/ff/synthetic',1000)`,
  },
  {
    table: "accounts",
    stored: "id='synthetic-account'",
    replace: (rowid: number) =>
      `INSERT OR REPLACE INTO accounts(rowid,id,label,role,status) VALUES(${rowid},'synthetic-account-2','Synthetic','asset','identified')`,
  },
  {
    table: "decision_operations",
    stored: "operation_id='synthetic-operation'",
    replace: (rowid: number) =>
      `INSERT OR REPLACE INTO decision_operations(rowid,operation_id,actor_id,actor_verification,action,payload_digest,result_json,created_at)
        VALUES(${rowid},'synthetic-operation-2','synthetic-actor','server','synthetic','${HEX("6")}','{}','${T}')`,
  },
  {
    table: "decision_revisions",
    stored: "id='synthetic-leaf-decision'",
    replace: (rowid: number) =>
      `INSERT OR REPLACE INTO decision_revisions(rowid,id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
        VALUES(${rowid},'synthetic-leaf-decision-2','relation','relation:synthetic-2',1,'accept','manual','synthetic-actor',NULL,'synthetic','[]',NULL,NULL,'${T}')`,
  },
  {
    table: "economic_event_revisions",
    stored: "event_id='synthetic-event' AND revision=1",
    replace: (rowid: number) =>
      `INSERT OR REPLACE INTO economic_event_revisions(rowid,event_id,revision,kind,state,unknown_reason,effective_time_json,basis,evidence_support_json,decision_revision_id,superseded_by,created_at)
        VALUES(${rowid},'synthetic-event',2,'charge','revised',NULL,'{"kind":"date","date":"2026-01-06"}','cash-movement','["synthetic"]','synthetic-event-decision',NULL,'${T}')`,
  },
  {
    table: "change_plans",
    stored: `plan_id='${HEX("3")}'`,
    replace: (rowid: number) =>
      `INSERT OR REPLACE INTO change_plans(rowid,plan_id,kind,payload_json,base_context_id,expected_revisions_json,simulation_json,created_by,created_at,expires_at,status)
        VALUES(${rowid},'${HEX("7")}','relation.accept','{}','synthetic','{}','{}','synthetic-actor','${T}','${T}','planned')`,
  },
  {
    table: "operation_receipts",
    stored: "operation_id='synthetic-leaf-receipt'",
    replace: (rowid: number) =>
      `INSERT OR REPLACE INTO operation_receipts(rowid,operation_id,principal,operation_kind,payload_digest,plan_id,status,result_json,created_at,published_at)
        VALUES(${rowid},'synthetic-receipt-2','synthetic-principal','relation.accept','${HEX("8")}','${HEX("2")}','accepted','{}','${T}',NULL)`,
  },
  {
    // Its rowid is its INTEGER PRIMARY KEY, which its guard did not check.
    table: "decision_outbox",
    stored: "target='agent-notify'",
    replace: (rowid: number) =>
      `INSERT OR REPLACE INTO decision_outbox(id,decision_revision_id,principal,operation_id,target,enqueued_at,available_at_ms)
        VALUES(${rowid},'synthetic-event-decision','synthetic-principal','synthetic-receipt','identity-projection','${T}',0)`,
  },
  {
    table: "audit_records",
    stored: `audit_id='${AUDIT_ID(1)}'`,
    replace: (rowid: number) =>
      `INSERT OR REPLACE INTO audit_records(rowid,audit_id,recorded_at,path,subject,principal,principal_kind,operation,risk_class,step,result,correlation_id,diff_json)
        VALUES(${rowid},'${AUDIT_ID(2)}','2026-01-05T00:00:00.000Z','ui','synthetic','synthetic','human','synthetic.read','R0','call','read','${CORRELATION}','{"kind":"none"}')`,
  },
] as const;

/** A private copy of a seeded image, enforcing foreign keys as D1 does. */
function seeded(image: Uint8Array): Database {
  const db = Database.deserialize(image);
  db.exec("PRAGMA foreign_keys=ON");
  return db;
}

/** CORE migrated by `files`, with the pilot rows and the rows above. */
function migrated(files: readonly string[], seed = true): Uint8Array {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const file of files) db.exec(migrationSql(CORE_MIGRATIONS_URL, file));
  if (seed) {
    seedPilotRows(db);
    for (const statement of SEED) db.run(statement);
  }
  const image = db.serialize();
  db.close();
  return image;
}

/** Every row of every table, so a check can show nothing moved. */
function contents(db: Database): Record<string, string[]> {
  const tables = (
    db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]
  ).map((row) => row.name);
  return Object.fromEntries(
    tables.map((table) => [
      table,
      db
        .query(`SELECT * FROM "${table}"`)
        .all()
        .map((row) => JSON.stringify(row))
        .sort(),
    ]),
  );
}

function schema(db: Database): { type: string; name: string; sql: string | null }[] {
  return db
    .query(
      "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
    )
    .all() as { type: string; name: string; sql: string | null }[];
}

let beforeImage: Uint8Array;
let afterImage: Uint8Array;
/** Every migration, unseeded: the schema whose guards must hold today. */
let currentImage: Uint8Array;

beforeAll(() => {
  const files = migrationFiles(CORE_MIGRATIONS_URL);
  expect(files).toContain(MIGRATION);
  beforeImage = migrated(files.filter((file) => file < MIGRATION));
  // Through 0106 only: later migrations add their own objects.
  afterImage = migrated(files.filter((file) => file <= MIGRATION));
  currentImage = migrated(files, false);
}, 120_000);

describe("before 0106", () => {
  test("exactly these tables had a replacement guard that a REPLACE by rowid bypassed", () => {
    const db = seeded(beforeImage);
    expect(rowidHoles(db)).toEqual(GUARDED);
    db.close();
  });

  test.each(CASES.map((c) => [c.table, c] as const))(
    "%s: a REPLACE naming a stored row's rowid removed that row past the delete guard",
    (table, c) => {
      const db = seeded(beforeImage);
      expect(db.query("PRAGMA recursive_triggers").get()).toEqual({ recursive_triggers: 0 });
      const read = `SELECT rowid AS rowid FROM ${table} WHERE ${c.stored}`;
      const { rowid } = db.query(read).get() as { rowid: number };
      expect(() => db.run(`DELETE FROM ${table} WHERE ${c.stored}`)).toThrow();
      db.run(c.replace(rowid));
      expect(db.query(read).get()).toBeNull();
      db.close();
    },
  );
});

describe("migration 0106", () => {
  test("adds one BEFORE INSERT trigger per guarded table and changes nothing else", () => {
    const db = seeded(beforeImage);
    const prior = schema(db);
    const rows = contents(db);
    db.exec(migrationSql(CORE_MIGRATIONS_URL, MIGRATION));
    const after = schema(db);
    const added = after.filter(
      (object) => !prior.some((p) => p.type === object.type && p.name === object.name),
    );
    // No existing object is dropped or redefined.
    expect(after.filter((object) => !added.includes(object))).toEqual(prior);
    expect(added.map((object) => [object.type, object.name])).toEqual(
      GUARDED.map((table) => ["trigger", `${table}_no_replace_rowid`]),
    );
    for (const object of added) {
      const table = object.name.replace(/_no_replace_rowid$/u, "");
      expect(object.sql).toBe(
        `CREATE TRIGGER ${table}_no_replace_rowid BEFORE INSERT ON ${table}\nWHEN EXISTS(SELECT 1 FROM ${table} WHERE rowid=NEW.rowid)\nBEGIN SELECT RAISE(ABORT,'${table} replacement is forbidden'); END`,
      );
    }
    expect(contents(db)).toEqual(rows);
    db.close();
  });

  test("the migrated image equals the one 0106 builds over a stored database", () => {
    const db = seeded(beforeImage);
    db.exec(migrationSql(CORE_MIGRATIONS_URL, MIGRATION));
    const fresh = seeded(afterImage);
    expect(schema(db)).toEqual(schema(fresh));
    db.close();
    fresh.close();
  });
});

describe("after 0106", () => {
  test("no rowid table has a replacement guard that a REPLACE by rowid bypasses", () => {
    const db = seeded(currentImage);
    expect(rowidHoles(db)).toEqual([]);
    db.close();
  });

  test("the documented limits stand: tables with no replacement guard, and keys no guard checks", () => {
    const db = seeded(currentImage);
    expect(guardLimits(db)).toEqual({ unguarded: UNGUARDED, unchecked: UNCHECKED_KEYS });
    db.close();
  });

  test.each(CASES.map((c) => [c.table, c] as const))(
    "%s: a REPLACE naming a stored row's rowid is refused and nothing changes",
    (table, c) => {
      const db = seeded(afterImage);
      const read = `SELECT rowid AS rowid FROM ${table} WHERE ${c.stored}`;
      const { rowid } = db.query(read).get() as { rowid: number };
      const rows = contents(db);
      expect(() => db.run(c.replace(rowid))).toThrow(
        new RegExp(`${table} replacement is forbidden`, "u"),
      );
      expect(() => db.run(c.replace(rowid).replace("INSERT OR REPLACE", "INSERT"))).toThrow(
        new RegExp(`${table} replacement is forbidden`, "u"),
      );
      expect((db.query(read).get() as { rowid: number }).rowid).toBe(rowid);
      expect(contents(db)).toEqual(rows);
      db.close();
    },
  );

  test("the older guards still refuse a collision on their declared keys", () => {
    const db = seeded(afterImage);
    expect(() =>
      db.run(
        `INSERT OR REPLACE INTO raw_objects(sha256,byte_size,blob_key,first_stored_at_ms) VALUES('${HEX("e")}',1,'objects/ee/other',1000)`,
      ),
    ).toThrow(/immutable_duplicate_insert/u);
    expect(() =>
      db.run(
        "INSERT OR REPLACE INTO accounts(id,label,role,status) VALUES('synthetic-account','Other','asset','identified')",
      ),
    ).toThrow(/identity replacement is forbidden/u);
    expect(() =>
      db.run(
        `INSERT OR REPLACE INTO decision_outbox(decision_revision_id,principal,operation_id,target,enqueued_at,available_at_ms)
          VALUES('synthetic-event-decision','synthetic-principal','synthetic-receipt','agent-notify','${T}',0)`,
      ),
    ).toThrow(/decision outbox replacement is forbidden/u);
    db.close();
  });
});

/**
 * The rowid check relies on NEW.rowid being -1 in a BEFORE INSERT trigger
 * when the insert names no rowid, a value SQLite documents as undefined. This
 * pins it for the insert shapes the writers of these tables use: `VALUES`
 * (one row and several), `INSERT ... SELECT ... WHERE NOT EXISTS`, a
 * multi-row `INSERT ... SELECT` over `json_each`, the raw object writer
 * itself, and `OR IGNORE` and `ON CONFLICT DO NOTHING`, which test seeds use.
 */
describe("NEW.rowid in a BEFORE INSERT trigger", () => {
  test("is -1 for every insert shape that names no rowid, and each insert appends", async () => {
    const db = seeded(currentImage);
    db.exec("CREATE TEMP TABLE seen(name TEXT NOT NULL, new_rowid)");
    for (const table of GUARDED) {
      db.exec(
        `CREATE TEMP TRIGGER seen_${table} BEFORE INSERT ON main.${table}
          BEGIN INSERT INTO seen VALUES('${table}',NEW.rowid); END`,
      );
    }
    seedPilotRows(db);
    for (const statement of SEED) db.run(statement);
    const d1 = sqliteD1(db);
    await insertRawObjectIfAbsent(d1, HEX("9"), 2, "objects/99/synthetic", 2000);
    // The writer's retry of the same object writes nothing.
    await insertRawObjectIfAbsent(d1, HEX("9"), 2, "objects/99/synthetic", 2000);
    expect(
      db
        .prepare(
          `INSERT INTO accounts(id,label,role,status)
            SELECT json_extract(value,'$.id'),'Synthetic','asset','identified' FROM json_each(?)
            WHERE NOT EXISTS(SELECT 1 FROM accounts a WHERE a.id=json_extract(value,'$.id'))`,
        )
        .run(JSON.stringify([{ id: "synthetic-a" }, { id: "synthetic-b" }, { id: "synthetic-c" }]))
        .changes,
    ).toBe(3);
    expect(
      db.run(
        "INSERT OR IGNORE INTO accounts(id,label,role,status) VALUES('synthetic-d','Synthetic','asset','identified')",
      ).changes,
    ).toBe(1);
    expect(
      db.run(
        "INSERT INTO accounts(id,label,role,status) VALUES('synthetic-e','Synthetic','asset','identified') ON CONFLICT DO NOTHING",
      ).changes,
    ).toBe(1);

    const seen = db
      .query(
        "SELECT name, count(*) AS n, min(new_rowid) AS low, max(new_rowid) AS high FROM seen GROUP BY name ORDER BY name",
      )
      .all();
    // The pilot rows hold two raw objects before the seed.
    expect(seen).toEqual([
      { name: "accounts", n: 6, low: -1, high: -1 },
      { name: "audit_records", n: 1, low: -1, high: -1 },
      { name: "change_plans", n: 2, low: -1, high: -1 },
      { name: "decision_operations", n: 1, low: -1, high: -1 },
      { name: "decision_outbox", n: 1, low: -1, high: -1 },
      { name: "decision_revisions", n: 2, low: -1, high: -1 },
      { name: "economic_event_revisions", n: 1, low: -1, high: -1 },
      { name: "operation_receipts", n: 2, low: -1, high: -1 },
      { name: "raw_objects", n: 4, low: -1, high: -1 },
    ]);
    expect(db.query("SELECT count(*) AS n, min(rowid) AS low FROM accounts").get()).toEqual({
      n: 6,
      low: 1,
    });
    expect(db.query("SELECT count(*) AS n, min(rowid) AS low FROM raw_objects").get()).toEqual({
      n: 4,
      low: 1,
    });
    db.close();
  });

  test("the Layer A test stub's OR IGNORE seed of a stored raw object still writes nothing", () => {
    // The Processor harnesses declare `raw_objects` without its 0001 guard and
    // seed it with `INSERT OR IGNORE`; 0106 puts its trigger on that stub too.
    const db = coreDatabase();
    const seed = db.prepare("INSERT OR IGNORE INTO raw_objects VALUES(?,?,?)");
    expect(seed.run(HEX("a"), 1, HEX("a")).changes).toBe(1);
    expect(seed.run(HEX("a"), 1, HEX("a")).changes).toBe(0);
    expect(db.query("SELECT count(*) AS n FROM raw_objects").get()).toEqual({ n: 1 });
    db.close();
  });
});
