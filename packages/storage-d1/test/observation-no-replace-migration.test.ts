// Migration 0105: parsed observations refuse `INSERT OR REPLACE`.
//
// Each table below already refuses UPDATE and DELETE. SQLite's REPLACE
// conflict resolution deletes the row it collides with without firing DELETE
// triggers while recursive_triggers is off (the default), so before 0105 a
// replacing insert rewrote a stored observation, and through the decimal
// triggers its amount, past both guards. Every row and value here is
// synthetic.
import { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { CORE_MIGRATIONS_URL, migrationFiles, migrationSql } from "../src/migrations.ts";
import { seedPilotRows } from "./core-fixture.ts";

const MIGRATION = "0105_observation_no_replace.sql";

/** One stored row per table, a replacing insert of it, and a column the replacement changes. */
interface Case {
  table: string;
  /** The row as first stored. */
  insert: string;
  /** The same key stating something else. */
  replace: string;
  /** Reads the column the replacement changes. */
  read: string;
  /** A statement that changes the row in place. */
  update: string;
  /** A statement that removes the row. */
  delete: string;
}

const PRICE_TIME = `'{"kind":"date","date":"2026-01-05"}'`;

const CASES: Case[] = [
  {
    table: "transaction_observations",
    insert: `INSERT INTO transaction_observations(id,parse_run_id,source_account,amount_minor,amount_text,amount_scale,currency,raw_locator,extra_json)
      VALUES(11,1,'synthetic-account',100,'100',0,'JPY','$[0]','{}')`,
    replace: `INSERT OR REPLACE INTO transaction_observations(id,parse_run_id,source_account,amount_minor,amount_text,amount_scale,currency,raw_locator,extra_json)
      VALUES(11,1,'synthetic-account',999,'999',0,'JPY','$[0]','{}')`,
    read: "SELECT amount_minor AS value FROM transaction_observations WHERE id=11",
    update: "UPDATE transaction_observations SET amount_minor=999 WHERE id=11",
    delete: "DELETE FROM transaction_observations WHERE id=11",
  },
  {
    table: "balance_observations",
    insert: `INSERT INTO balance_observations(id,parse_run_id,source_account,metric,amount_minor,amount_text,amount_scale,instrument,raw_locator,extra_json)
      VALUES(12,1,'synthetic-account','synthetic-metric',100,'100',0,'JPY','$[0]','{}')`,
    replace: `INSERT OR REPLACE INTO balance_observations(id,parse_run_id,source_account,metric,amount_minor,amount_text,amount_scale,instrument,raw_locator,extra_json)
      VALUES(12,1,'synthetic-account','synthetic-metric',999,'999',0,'JPY','$[0]','{}')`,
    read: "SELECT amount_minor AS value FROM balance_observations WHERE id=12",
    update: "UPDATE balance_observations SET amount_minor=999 WHERE id=12",
    delete: "DELETE FROM balance_observations WHERE id=12",
  },
  {
    table: "position_observations",
    insert: `INSERT INTO position_observations(id,parse_run_id,source_account,security_code,quantity_text,quantity_scale,raw_locator,extra_json)
      VALUES(13,1,'synthetic-account','SYN1','1',0,'$[0]','{}')`,
    replace: `INSERT OR REPLACE INTO position_observations(id,parse_run_id,source_account,security_code,quantity_text,quantity_scale,raw_locator,extra_json)
      VALUES(13,1,'synthetic-account','SYN1','9',0,'$[0]','{}')`,
    read: "SELECT quantity_text AS value FROM position_observations WHERE id=13",
    update: "UPDATE position_observations SET quantity_text='9' WHERE id=13",
    delete: "DELETE FROM position_observations WHERE id=13",
  },
  {
    table: "valuation_observations",
    insert: `INSERT INTO valuation_observations(id,parse_run_id,source_account,subject,metric,amount_minor,amount_text,amount_scale,currency,raw_locator,extra_json)
      VALUES(14,1,'synthetic-account','SYN1','evaluation_amount',100,'100',0,'JPY','$[0]','{}')`,
    replace: `INSERT OR REPLACE INTO valuation_observations(id,parse_run_id,source_account,subject,metric,amount_minor,amount_text,amount_scale,currency,raw_locator,extra_json)
      VALUES(14,1,'synthetic-account','SYN1','evaluation_amount',999,'999',0,'JPY','$[0]','{}')`,
    read: "SELECT amount_minor AS value FROM valuation_observations WHERE id=14",
    update: "UPDATE valuation_observations SET amount_minor=999 WHERE id=14",
    delete: "DELETE FROM valuation_observations WHERE id=14",
  },
  {
    table: "scheduled_payment_observations",
    insert: `INSERT INTO scheduled_payment_observations(id,parse_run_id,source_account,external_id,schedule_kind,usage_date,due_date,amount_text,amount_scale,currency,counterparty,as_of,raw_locator,extra_json)
      VALUES(15,1,'synthetic-account','synthetic-1','card-skip-payment','2026-01-05','2026-02-10','100',0,'JPY','synthetic-payee','2026-01-05','$[0]','{}')`,
    replace: `INSERT OR REPLACE INTO scheduled_payment_observations(id,parse_run_id,source_account,external_id,schedule_kind,usage_date,due_date,amount_text,amount_scale,currency,counterparty,as_of,raw_locator,extra_json)
      VALUES(15,1,'synthetic-account','synthetic-1','card-skip-payment','2026-01-05','2026-02-10','999',0,'JPY','synthetic-payee','2026-01-05','$[0]','{}')`,
    read: "SELECT amount_text AS value FROM scheduled_payment_observations WHERE id=15",
    update: "UPDATE scheduled_payment_observations SET amount_text='999' WHERE id=15",
    delete: "DELETE FROM scheduled_payment_observations WHERE id=15",
  },
  {
    // The pilot fixture's own row: a coefficient too large for a JS number.
    table: "observation_decimal_values",
    insert: "",
    replace: `INSERT OR REPLACE INTO observation_decimal_values(kind,observation_id,parse_run_id,policy_version,status,coefficient,scale,basis)
      VALUES('balance',1,1,'decimal-v1','exact','999',0,'decimal_text')`,
    read: "SELECT coefficient AS value FROM observation_decimal_values WHERE kind='balance' AND observation_id=1",
    update:
      "UPDATE observation_decimal_values SET coefficient='999',scale=0 WHERE kind='balance' AND observation_id=1",
    delete: "DELETE FROM observation_decimal_values WHERE kind='balance' AND observation_id=1",
  },
  {
    table: "parse_issues",
    insert: `INSERT INTO parse_issues(id,parse_run_id,code,locator,severity,impact,message)
      VALUES(16,1,'row_unreadable','$[1]','warning','field','synthetic')`,
    replace: `INSERT OR REPLACE INTO parse_issues(id,parse_run_id,code,locator,severity,impact,message)
      VALUES(16,1,'row_unreadable','$[1]','info','none','synthetic')`,
    read: "SELECT severity AS value FROM parse_issues WHERE id=16",
    update: "UPDATE parse_issues SET severity='info' WHERE id=16",
    delete: "DELETE FROM parse_issues WHERE id=16",
  },
  {
    table: "parse_coverage_claims",
    insert: `INSERT INTO parse_coverage_claims(id,parse_run_id,claim_id,scope_key,mode,completeness,membership_complete,observed_count,evidence_refs_json,policy_version,absence_meaning,parent_run_status,parent_run_failure_count)
      VALUES(17,1,'synthetic-claim','synthetic-scope','window','partial',0,1,'[]','synthetic-coverage-v1','not-applicable','success',0)`,
    // No id: the collision is on the (parse_run_id, claim_id) key alone.
    replace: `INSERT OR REPLACE INTO parse_coverage_claims(parse_run_id,claim_id,scope_key,mode,completeness,membership_complete,observed_count,evidence_refs_json,policy_version,absence_meaning,parent_run_status,parent_run_failure_count)
      VALUES(1,'synthetic-claim','synthetic-scope','complete-container','complete',1,1,'[]','synthetic-coverage-v1','not-applicable','success',0)`,
    read: "SELECT completeness AS value FROM parse_coverage_claims WHERE claim_id='synthetic-claim'",
    update: "UPDATE parse_coverage_claims SET completeness='unknown' WHERE id=17",
    delete: "DELETE FROM parse_coverage_claims WHERE id=17",
  },
  {
    table: "parse_input_references",
    insert: `INSERT INTO parse_input_references(parse_run_id,metadata_projection_id,parser_release_id,input_fingerprint)
      VALUES(1,NULL,'pilot-parser@1.0.0','${"f".repeat(64)}')`,
    replace: `INSERT OR REPLACE INTO parse_input_references(parse_run_id,metadata_projection_id,parser_release_id,input_fingerprint)
      VALUES(1,NULL,'pilot-parser@1.0.0','${"0".repeat(64)}')`,
    read: "SELECT input_fingerprint AS value FROM parse_input_references WHERE parse_run_id=1",
    update: `UPDATE parse_input_references SET input_fingerprint='${"0".repeat(64)}' WHERE parse_run_id=1`,
    delete: "DELETE FROM parse_input_references WHERE parse_run_id=1",
  },
  {
    table: "price_observations",
    insert: `INSERT INTO price_observations(id,base_instrument_ref,base_quantity_coefficient,base_quantity_scale,quote_unit_ref,quote_amount_coefficient,quote_amount_scale,price_kind,effective_time,source_claim_ref,recorded_at)
      VALUES('synthetic-price','synthetic-instrument','1',0,'JPY','100',0,'reference',${PRICE_TIME},'synthetic-claim','2026-01-05T00:00:00Z')`,
    replace: `INSERT OR REPLACE INTO price_observations(id,base_instrument_ref,base_quantity_coefficient,base_quantity_scale,quote_unit_ref,quote_amount_coefficient,quote_amount_scale,price_kind,effective_time,source_claim_ref,recorded_at)
      VALUES('synthetic-price','synthetic-instrument','1',0,'JPY','999',0,'reference',${PRICE_TIME},'synthetic-claim','2026-01-05T00:00:00Z')`,
    read: "SELECT quote_amount_coefficient AS value FROM price_observations WHERE id='synthetic-price'",
    update:
      "UPDATE price_observations SET quote_amount_coefficient='999' WHERE id='synthetic-price'",
    delete: "DELETE FROM price_observations WHERE id='synthetic-price'",
  },
  {
    table: "price_observation_claims",
    insert: `INSERT INTO price_observation_claims(price_id,rule_id,claim_kind,observation_id,parse_run_id,json_path,created_at)
      VALUES('synthetic-price','synthetic-rule','valuation',14,1,'$.amount','2026-01-05T00:00:00Z')`,
    // A new price id: the collision is on the claim key alone.
    replace: `INSERT OR REPLACE INTO price_observation_claims(price_id,rule_id,claim_kind,observation_id,parse_run_id,json_path,created_at)
      VALUES('synthetic-price-2','synthetic-rule','valuation',14,1,'$.amount','2026-01-06T00:00:00Z')`,
    read: "SELECT price_id AS value FROM price_observation_claims WHERE rule_id='synthetic-rule'",
    update:
      "UPDATE price_observation_claims SET created_at='2026-01-06T00:00:00Z' WHERE price_id='synthetic-price'",
    delete: "DELETE FROM price_observation_claims WHERE price_id='synthetic-price'",
  },
];

/** A private copy of a seeded image, enforcing foreign keys as D1 does. */
function seeded(image: Uint8Array): Database {
  const db = Database.deserialize(image);
  db.exec("PRAGMA foreign_keys=ON");
  return db;
}

/** CORE migrated by `files`, with the pilot rows and one stored row per case. */
function migrated(files: readonly string[]): Uint8Array {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const file of files) db.exec(migrationSql(CORE_MIGRATIONS_URL, file));
  seedPilotRows(db);
  for (const { insert } of CASES) if (insert.length > 0) db.run(insert);
  // The price claim's replacement names a second price, which must exist.
  db.run(
    `INSERT INTO price_observations(id,base_instrument_ref,base_quantity_coefficient,base_quantity_scale,quote_unit_ref,quote_amount_coefficient,quote_amount_scale,price_kind,effective_time,source_claim_ref,recorded_at)
      VALUES('synthetic-price-2','synthetic-instrument','1',0,'JPY','100',0,'reference',${PRICE_TIME},'synthetic-claim-2','2026-01-06T00:00:00Z')`,
  );
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
    // Sorted as text: WITHOUT ROWID tables have no rowid to order by.
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

beforeAll(() => {
  const files = migrationFiles(CORE_MIGRATIONS_URL);
  expect(files).toContain(MIGRATION);
  beforeImage = migrated(files.filter((file) => file < MIGRATION));
  afterImage = migrated(files);
}, 120_000);

describe("before 0105", () => {
  test.each(CASES.map((c) => [c.table, c] as const))(
    "%s: a replacing insert rewrote the stored row past the update and delete guards",
    (_table, c) => {
      const db = seeded(beforeImage);
      expect(db.query("PRAGMA recursive_triggers").get()).toEqual({ recursive_triggers: 0 });
      const stored = db.query(c.read).get();
      expect(() => db.run(c.update)).toThrow();
      expect(() => db.run(c.delete)).toThrow();
      db.run(c.replace);
      expect(db.query(c.read).get()).not.toEqual(stored);
      db.close();
    },
  );
});

describe("migration 0105", () => {
  test("adds one BEFORE INSERT trigger per table and changes no row", () => {
    const db = seeded(beforeImage);
    const prior = schema(db);
    const rows = contents(db);
    db.exec(migrationSql(CORE_MIGRATIONS_URL, MIGRATION));
    const after = schema(db);
    const added = after.filter(
      (object) => !prior.some((p) => p.type === object.type && p.name === object.name),
    );
    expect(after.filter((object) => !added.includes(object))).toEqual(prior);
    expect(added.every((object) => object.type === "trigger")).toBe(true);
    expect(
      added.map((object) => /BEFORE INSERT ON (\w+)/u.exec(object.sql ?? "")?.[1]).sort(),
    ).toEqual(CASES.map((c) => c.table).sort());
    expect(contents(db)).toEqual(rows);
    db.close();
  });

  test("the migrated image equals the one 0105 builds over a stored database", () => {
    const db = seeded(beforeImage);
    db.exec(migrationSql(CORE_MIGRATIONS_URL, MIGRATION));
    const fresh = seeded(afterImage);
    expect(schema(db)).toEqual(schema(fresh));
    db.close();
    fresh.close();
  });
});

describe("after 0105", () => {
  test.each(CASES.map((c) => [c.table, c] as const))(
    "%s: update, delete and a replacing insert are all refused, and the row is unchanged",
    (_table, c) => {
      const db = seeded(afterImage);
      const stored = db.query(c.read).get();
      const rows = contents(db);
      expect(() => db.run(c.update)).toThrow(/append-only|immutable/u);
      expect(() => db.run(c.delete)).toThrow(/append-only|immutable/u);
      expect(() => db.run(c.replace)).toThrow(/replacement is forbidden/u);
      expect(() => db.run(c.replace.replace("INSERT OR REPLACE", "INSERT"))).toThrow(
        /replacement is forbidden/u,
      );
      expect(db.query(c.read).get()).toEqual(stored);
      expect(contents(db)).toEqual(rows);
      db.close();
    },
  );

  test("the Processor's insert shapes still append: observations without an id, issues and coverage claims", () => {
    const db = seeded(afterImage);
    db.run(
      `INSERT INTO transaction_observations(parse_run_id,source_account,amount_minor,amount_text,amount_scale,currency,raw_locator,extra_json)
        VALUES(1,'synthetic-account',100,'100',0,'JPY','$[1]','{}')`,
    );
    db.run(
      `INSERT INTO parse_issues(parse_run_id,code,locator,severity,impact,message)
        VALUES(1,'row_unreadable','$[2]','warning','field','synthetic')`,
    );
    db.run(
      `INSERT INTO parse_coverage_claims(parse_run_id,claim_id,scope_key,mode,completeness,membership_complete,observed_count,evidence_refs_json,policy_version,absence_meaning,parent_run_status,parent_run_failure_count)
        VALUES(1,'synthetic-claim-2','synthetic-scope','window','partial',0,1,'[]','synthetic-coverage-v1','not-applicable','success',0)`,
    );
    expect(
      db
        .query(
          "SELECT d.coefficient FROM transaction_observations t JOIN observation_decimal_values d ON d.kind='transaction' AND d.observation_id=t.id WHERE t.raw_locator='$[1]'",
        )
        .get(),
    ).toEqual({ coefficient: "100" });
    // The price promotion's idempotent write: a second promotion of the same price writes nothing.
    const promote = `INSERT INTO price_observations(id,base_instrument_ref,base_quantity_coefficient,base_quantity_scale,quote_unit_ref,quote_amount_coefficient,quote_amount_scale,price_kind,effective_time,source_claim_ref,recorded_at)
      SELECT 'synthetic-price','synthetic-instrument','1',0,'JPY','999',0,'reference',${PRICE_TIME},'synthetic-claim','2026-01-07T00:00:00Z'
      WHERE NOT EXISTS(SELECT 1 FROM price_observations WHERE id='synthetic-price')`;
    expect(db.run(promote).changes).toBe(0);
    db.close();
  });
});

/**
 * The three tables whose key is not an INTEGER PRIMARY KEY keep a hidden
 * rowid, and a REPLACE naming a stored row's rowid deletes that row whatever
 * key it states.
 */
const ROWID_CASES = [
  {
    table: "observation_decimal_values",
    stored: "kind='balance' AND observation_id=1",
    replace: (rowid: number) =>
      `INSERT OR REPLACE INTO observation_decimal_values(rowid,kind,observation_id,parse_run_id,policy_version,status,coefficient,scale,basis)
        VALUES(${rowid},'valuation',777,1,'decimal-v1','exact','999',0,'decimal_text')`,
  },
  {
    table: "price_observations",
    stored: "id='synthetic-price-2'",
    replace: (rowid: number) =>
      `INSERT OR REPLACE INTO price_observations(rowid,id,base_instrument_ref,base_quantity_coefficient,base_quantity_scale,quote_unit_ref,quote_amount_coefficient,quote_amount_scale,price_kind,effective_time,source_claim_ref,recorded_at)
        VALUES(${rowid},'synthetic-price-3','synthetic-instrument','1',0,'JPY','999',0,'reference',${PRICE_TIME},'synthetic-claim-3','2026-01-07T00:00:00Z')`,
  },
  {
    table: "price_observation_claims",
    stored: "price_id='synthetic-price'",
    replace: (rowid: number) =>
      `INSERT OR REPLACE INTO price_observation_claims(rowid,price_id,rule_id,claim_kind,observation_id,parse_run_id,json_path,created_at)
        VALUES(${rowid},'synthetic-price-2','synthetic-rule','valuation',14,1,'$.other','2026-01-07T00:00:00Z')`,
  },
] as const;

describe("a replacing insert by rowid", () => {
  test.each(ROWID_CASES.map((c) => [c.table, c] as const))(
    "%s: removed the stored row before 0105 and is refused after it",
    (table, c) => {
      const read = `SELECT rowid AS rowid FROM ${table} WHERE ${c.stored}`;
      const before = seeded(beforeImage);
      const { rowid } = before.query(read).get() as { rowid: number };
      before.run(c.replace(rowid));
      expect(before.query(read).get()).toBeNull();
      before.close();

      const after = seeded(afterImage);
      const rows = contents(after);
      expect((after.query(read).get() as { rowid: number }).rowid).toBe(rowid);
      expect(() => after.run(c.replace(rowid))).toThrow(/replacement is forbidden/u);
      expect(contents(after)).toEqual(rows);
      after.close();
    },
  );
});

/**
 * The rowid checks above rely on NEW.rowid being -1 in a BEFORE INSERT
 * trigger when the insert names no rowid, a value SQLite documents as
 * undefined. This pins it for every insert shape the writers use: a plain
 * insert into an empty table, a multi-row `INSERT ... SELECT` over
 * `json_each`, and the 0024 decimal triggers' inserts made inside another
 * trigger, on an empty store and on one that already holds rows.
 */
describe("NEW.rowid in a BEFORE INSERT trigger", () => {
  test("is -1 for every ordinary insert into the three rowid tables, and each insert appends", () => {
    const tables = ROWID_CASES.map((c) => c.table);
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    for (const file of migrationFiles(CORE_MIGRATIONS_URL)) {
      db.exec(migrationSql(CORE_MIGRATIONS_URL, file));
    }
    db.exec("CREATE TEMP TABLE seen(name TEXT NOT NULL, new_rowid)");
    for (const table of tables) {
      db.exec(
        `CREATE TEMP TRIGGER seen_${table} BEFORE INSERT ON main.${table}
          BEGIN INSERT INTO seen VALUES('${table}',NEW.rowid); END`,
      );
    }
    // The pilot rows put the first decimal values into the empty table.
    seedPilotRows(db);
    const pilot = (
      db.query("SELECT count(*) AS n FROM observation_decimal_values").get() as { n: number }
    ).n;
    expect(pilot).toBeGreaterThan(0);

    // The Processor's observation and price promotion shapes, twice: on a
    // store without prices, then on one that already holds them.
    const observations = db.prepare(
      `INSERT INTO valuation_observations(parse_run_id,source_account,subject,metric,amount_minor,amount_text,amount_scale,currency,raw_locator,extra_json)
        SELECT 1,'synthetic-account','SYN1','evaluation_amount',json_extract(value,'$.minor'),json_extract(value,'$.text'),0,'JPY',json_extract(value,'$.locator'),'{}'
        FROM json_each(?)`,
    );
    const prices = db.prepare(
      `INSERT INTO price_observations(id,base_instrument_ref,base_quantity_coefficient,base_quantity_scale,quote_unit_ref,quote_amount_coefficient,quote_amount_scale,price_kind,effective_time,source_claim_ref,recorded_at)
        SELECT json_extract(j.value,'$.id'),'synthetic-instrument','1',0,'JPY',json_extract(j.value,'$.quote'),0,'reference',${PRICE_TIME},json_extract(j.value,'$.claim'),'2026-01-05T00:00:00Z'
        FROM json_each(?) j
        WHERE NOT EXISTS(SELECT 1 FROM price_observations existing WHERE existing.id=json_extract(j.value,'$.id'))`,
    );
    const claims = db.prepare(
      `INSERT INTO price_observation_claims(price_id,rule_id,claim_kind,observation_id,parse_run_id,json_path,created_at)
        SELECT json_extract(j.value,'$.id'),'synthetic-rule','valuation',json_extract(j.value,'$.observation'),1,'$.amount','2026-01-05T00:00:00Z'
        FROM json_each(?) j
        WHERE NOT EXISTS(SELECT 1 FROM price_observation_claims existing WHERE existing.price_id=json_extract(j.value,'$.id'))`,
    );
    for (const round of [1, 2]) {
      const locators = [`$[${round}0]`, `$[${round}1]`, `$[${round}2]`];
      observations.run(
        JSON.stringify(
          locators.map((locator, i) => ({ minor: 100 + i, text: `${100 + i}`, locator })),
        ),
      );
      const ids = (
        db
          .query(
            `SELECT id FROM valuation_observations WHERE raw_locator IN (${locators.map(() => "?").join(",")}) ORDER BY id`,
          )
          .all(...locators) as { id: number }[]
      ).map((row) => row.id);
      const items = ids.map((id) => ({
        id: `synthetic-price-${round}-${id}`,
        quote: `${id}`,
        claim: `synthetic-claim-${round}-${id}`,
        observation: id,
      }));
      expect(prices.run(JSON.stringify(items)).changes).toBe(3);
      expect(claims.run(JSON.stringify(items)).changes).toBe(3);
    }

    const seen = db
      .query(
        "SELECT name, count(*) AS n, min(new_rowid) AS low, max(new_rowid) AS high FROM seen GROUP BY name ORDER BY name",
      )
      .all();
    const stored = Object.fromEntries(
      tables.map((table) => [
        table,
        db.query(`SELECT count(*) AS n, min(rowid) AS low FROM ${table}`).get() as {
          n: number;
          low: number;
        },
      ]),
    );
    // The pilot values plus six trigger-made ones; six prices; six claims.
    expect(seen).toEqual([
      { name: "observation_decimal_values", n: pilot + 6, low: -1, high: -1 },
      { name: "price_observation_claims", n: 6, low: -1, high: -1 },
      { name: "price_observations", n: 6, low: -1, high: -1 },
    ]);
    expect(stored).toEqual({
      observation_decimal_values: { n: pilot + 6, low: 1 },
      price_observations: { n: 6, low: 1 },
      price_observation_claims: { n: 6, low: 1 },
    });
    db.close();
  });
});
