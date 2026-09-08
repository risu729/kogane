import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import {
  identifyParse,
  identityKey,
  identitySweep,
  reviseIdentity,
  type IdentityResolver,
} from "../src/identity-store.ts";
import { otherIdentity } from "../../../poc/observation-pipeline/src/identity/other.ts";

let mf: Miniflare;
let db: D1Database;
const migrationDir = new URL("../../raw-evidence/migrations/", import.meta.url);
function splitSql(sql: string): string[] {
  const statements: string[] = [];
  let pending = "";
  for (const line of sql.split("\n")) {
    if (line.trimStart().startsWith("--")) continue;
    pending += line + "\n";
    const trigger = /CREATE TRIGGER/i.test(pending);
    if ((!trigger && /;\s*$/.test(line)) || (trigger && /END;\s*$/.test(line))) {
      statements.push(pending);
      pending = "";
    }
  }
  if (pending.trim()) throw new Error("unparsed migration remainder");
  return statements.filter((s) => s.trim());
}
function assertDb(value: unknown): asserts value is D1Database {
  if (!value || typeof value !== "object" || !("prepare" in value) || !("batch" in value))
    throw new Error("invalid D1 binding");
}
beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default { fetch() { return new Response('test'); } };",
      compatibilityDate: "2026-09-07",
      d1Databases: ["DB"],
    }),
  );
  const binding: unknown = await mf.getD1Database("DB");
  assertDb(binding);
  db = binding;
  await db.exec(`CREATE TABLE sources(id TEXT PRIMARY KEY,provider TEXT);
CREATE TABLE producers(id TEXT PRIMARY KEY);
CREATE TABLE fetch_runs(id INTEGER PRIMARY KEY,source_id TEXT,acquisition_session_id INTEGER,producer_id TEXT,first_recorded_at_ms INTEGER);
CREATE VIEW financial_fetch_runs AS SELECT * FROM fetch_runs WHERE source_id<>'kogane-synthetic';
CREATE TABLE acquisition_sessions(id INTEGER PRIMARY KEY,external_session_id TEXT);
CREATE TABLE fetch_run_seals(fetch_run_id INTEGER);
CREATE TABLE fetch_run_reports(fetch_run_id INTEGER,report_kind TEXT,normalized_outcome TEXT,started_at_ms INTEGER,completed_at_ms INTEGER);
CREATE TABLE fetch_units(id INTEGER PRIMARY KEY,fetch_run_id INTEGER,unit_key TEXT);
CREATE TABLE fetch_unit_reports(fetch_unit_id INTEGER,report_kind TEXT,normalized_outcome TEXT,safe_failure_code TEXT);
CREATE TABLE fetch_artifacts(id INTEGER PRIMARY KEY,fetch_run_id INTEGER,source_id TEXT,dataset TEXT,artifact_key TEXT,fetch_unit_id INTEGER,declared_media_type TEXT,fetched_at_ms INTEGER,recorded_at_ms INTEGER,sha256 TEXT,artifact_role TEXT);
CREATE TABLE raw_objects(sha256 TEXT PRIMARY KEY,byte_size INTEGER,blob_key TEXT);
CREATE TABLE fetch_run_ranges(id INTEGER PRIMARY KEY,fetch_run_id INTEGER,range_kind TEXT,start_value TEXT,end_value TEXT);
CREATE TABLE artifact_ranges(id INTEGER PRIMARY KEY,fetch_artifact_id INTEGER,range_kind TEXT,start_value TEXT,end_value TEXT);`);
  for (const name of ["0017_observation_pipeline.sql", "0018_identity.sql"]) {
    for (const sql of splitSql(readFileSync(new URL(name, migrationDir), "utf8")))
      await db.prepare(sql).run();
  }
  await db.batch([
    db.prepare("INSERT INTO sources VALUES('smbc-bank','synthetic'),('v-point','synthetic')"),
    db.prepare("INSERT INTO producers VALUES('synthetic-producer'),('other-producer')"),
  ]);
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});

function parse(id: number, source = "smbc-bank") {
  return {
    id,
    artifact_id: id,
    source_id: source,
    producer_id: "synthetic-producer",
    fetch_run_id: id,
  };
}
async function seed(id: number, count = 1, source = "smbc-bank", success = true) {
  await db.batch([
    db.prepare("INSERT INTO acquisition_sessions VALUES(?,?)").bind(id, `synthetic-${id}`),
    db
      .prepare(
        "INSERT INTO fetch_runs(id,source_id,producer_id,acquisition_session_id) VALUES(?,?,?,?)",
      )
      .bind(id, source, "synthetic-producer", id),
    db.prepare("INSERT INTO fetch_run_seals VALUES(?)").bind(id),
    db.prepare("INSERT INTO fetch_run_reports VALUES(?,'terminal','success',0,0)").bind(id),
    db
      .prepare(
        "INSERT INTO fetch_artifacts(id,fetch_run_id,source_id,dataset) VALUES(?,?,?,'synthetic')",
      )
      .bind(id, id, source),
    db
      .prepare(
        "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,?,'synthetic','1','2026-01-01','pending','[]')",
      )
      .bind(id, id),
    db
      .prepare(
        "INSERT INTO balance_observations(parse_run_id,source_account,metric,instrument,raw_locator,extra_json) SELECT ?,?,'synthetic_balance',?,'synthetic:'||value,'{}' FROM json_each(?)",
      )
      .bind(
        id,
        source === "v-point" ? "v-point:member" : "smbc-bank:ordinary-yen",
        source === "v-point" ? "V_POINT" : "JPY",
        JSON.stringify(Array.from({ length: count }, (_, i) => i)),
      ),
    db.prepare("UPDATE parse_runs SET status=? WHERE id=?").bind(success ? "ok" : "error", id),
  ]);
}
async function count(table: string, where = "1=1") {
  return await db.prepare(`SELECT count(*) n FROM ${table} WHERE ${where}`).first<number>("n");
}

test("identification seals atomically and repeating a parse is a no-op", async () => {
  await seed(100);
  expect(await identifyParse(db, parse(100), otherIdentity)).toBe(1);
  const snapshot = await db.prepare("SELECT * FROM identity_observations").all();
  expect(await identifyParse(db, parse(100), otherIdentity)).toBe(0);
  expect((await db.prepare("SELECT * FROM identity_observations").all()).results).toEqual(
    snapshot.results,
  );
  expect(await count("identity_run_seals")).toBe(1);
});

test("a crash after the first page resumes without publishing partial results or duplicate rows", async () => {
  await seed(101, 101);
  let calls = 0;
  const interrupted: IdentityResolver = (input) => {
    if (++calls === 101) throw new Error("synthetic-interruption");
    return otherIdentity(input);
  };
  await expect(identifyParse(db, parse(101), interrupted)).rejects.toThrow(
    "synthetic-interruption",
  );
  const run = await identityKey("ir", [101, 1]);
  expect(await count("identity_observations", `identity_run_id='${run}'`)).toBe(100);
  expect(await count("current_identity_observations", "parse_run_id=101")).toBe(0);
  expect(await identifyParse(db, parse(101), otherIdentity)).toBe(101);
  expect(await count("identity_observations", `identity_run_id='${run}'`)).toBe(101);
  expect(await count("current_identity_observations", "parse_run_id=101")).toBe(101);
}, 30000);

test("numeric policy ordering publishes version 10 over 2 even if old worker runs later", async () => {
  await seed(102);
  await identifyParse(db, parse(102), otherIdentity, 10);
  await identifyParse(db, parse(102), otherIdentity, 2);
  expect(
    await db
      .prepare("SELECT policy_version FROM current_identity_observations WHERE parse_run_id=102")
      .first<number>("policy_version"),
  ).toBe(10);
  expect(
    await db
      .prepare("SELECT max(policy_version) v FROM current_account_mappings")
      .first<number>("v"),
  ).toBe(10);
});

test("manual mappings are visible for existing observations, preserve historical evidence, and reject stale revision", async () => {
  const original = await db
    .prepare("SELECT * FROM current_account_mappings LIMIT 1")
    .first<{ id: string; source_account_id: string; revision: number; account_id: string }>();
  const instrument = await db
    .prepare("SELECT * FROM current_instrument_mappings LIMIT 1")
    .first<{ id: string; identifier_id: string; revision: number }>();
  expect(original).not.toBeNull();
  expect(instrument).not.toBeNull();
  await db.batch([
    db.prepare(
      "INSERT INTO accounts VALUES('manual-account','確認済みテスト口座','deposit','identified')",
    ),
    db.prepare(
      "INSERT INTO instruments VALUES('manual-instrument','money','確認済みテスト通貨','identified')",
    ),
  ]);
  const accountChange = {
    kind: "account" as const,
    referenceId: original!.source_account_id,
    targetId: "manual-account",
    expectedRevision: original!.revision,
    reason: "synthetic evidence correction",
  };
  await reviseIdentity(db, accountChange);
  await reviseIdentity(db, {
    kind: "instrument",
    referenceId: instrument!.identifier_id,
    targetId: "manual-instrument",
    expectedRevision: instrument!.revision,
    reason: "synthetic evidence correction",
  });
  await expect(reviseIdentity(db, accountChange)).rejects.toThrow("identity_revision_conflict");
  expect(
    await db
      .prepare("SELECT account_id FROM effective_identity_observations WHERE parse_run_id=100")
      .first<string>("account_id"),
  ).toBe("manual-account");
  expect(
    await db
      .prepare("SELECT instrument_id FROM effective_identity_instruments LIMIT 1")
      .first<string>("instrument_id"),
  ).toBe("manual-instrument");
  expect(
    await count("identity_observations", `account_mapping_id='${original!.id}'`),
  ).toBeGreaterThan(0);
  await seed(103);
  await identifyParse(db, parse(103), otherIdentity, 11);
  expect(
    await db
      .prepare("SELECT account_id FROM current_account_mappings WHERE source_account_id=?")
      .bind(original!.source_account_id)
      .first<string>("account_id"),
  ).toBe("manual-account");
});

test("all identity rows reject UPDATE DELETE and INSERT OR REPLACE", async () => {
  for (const table of [
    "source_accounts",
    "accounts",
    "account_mappings",
    "instruments",
    "instrument_identifiers",
    "instrument_mappings",
    "identity_runs",
    "identity_observations",
    "identity_instrument_uses",
    "identity_run_seals",
  ]) {
    const column =
      table === "identity_instrument_uses"
        ? "identity_observation_id"
        : table === "identity_run_seals"
          ? "identity_run_id"
          : "id";
    await expect(db.prepare(`UPDATE ${table} SET ${column}=${column}`).run()).rejects.toThrow();
    await expect(db.prepare(`DELETE FROM ${table}`).run()).rejects.toThrow();
    await expect(
      db.prepare(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table} LIMIT 1`).run(),
    ).rejects.toThrow();
  }
});

test("seal checks completeness; wrong observation and mapping provenance are rejected", async () => {
  await seed(104, 2);
  const run = await identityKey("ir", [104, 1]);
  await db.prepare("INSERT INTO identity_runs VALUES(?,104,1,'synthetic')").bind(run).run();
  await expect(
    db.prepare("INSERT INTO identity_run_seals VALUES(?,0,'synthetic')").bind(run).run(),
  ).rejects.toThrow();
  const mapping = await db
    .prepare("SELECT id,source_account_id FROM current_account_mappings LIMIT 1")
    .first<{ id: string; source_account_id: string }>();
  const foreignObservation = await db
    .prepare("SELECT id FROM balance_observations WHERE parse_run_id=100")
    .first<number>("id");
  await expect(
    db
      .prepare("INSERT INTO identity_observations VALUES('bad-observation',?,'balance',?,?,?,'[]')")
      .bind(run, foreignObservation, mapping!.source_account_id, mapping!.id)
      .run(),
  ).rejects.toThrow();
  await db
    .prepare(
      "INSERT INTO source_accounts VALUES('different-reference','v-point','synthetic-producer','[\"synthetic\"]')",
    )
    .run();
  const ownObservation = await db
    .prepare("SELECT id FROM balance_observations WHERE parse_run_id=104 LIMIT 1")
    .first<number>("id");
  await expect(
    db
      .prepare(
        "INSERT INTO identity_observations VALUES('bad-mapping',?,'balance',?,'different-reference',?,'[]')",
      )
      .bind(run, ownObservation, mapping!.id)
      .run(),
  ).rejects.toThrow();
  expect(await identifyParse(db, parse(104), otherIdentity)).toBe(2);
});

test("caller-supplied source or producer cannot falsify parse provenance", async () => {
  await seed(105);
  await expect(
    identifyParse(db, { ...parse(105), source_id: "v-point" }, otherIdentity),
  ).rejects.toThrow();
  await expect(
    identifyParse(db, { ...parse(105), producer_id: "other-producer" }, otherIdentity),
  ).rejects.toThrow();
  await expect(
    identifyParse(db, { ...parse(105), artifact_id: 100 }, otherIdentity),
  ).rejects.toThrow();
  await expect(
    identifyParse(db, { ...parse(105), fetch_run_id: 100 }, otherIdentity),
  ).rejects.toThrow();
  expect(await count("current_identity_observations", "parse_run_id=105")).toBe(0);
});

test("sweep honors source bounds, skips errors, and publishes empty successful parses", async () => {
  await seed(106, 0, "v-point");
  await seed(107, 1, "v-point", false);
  const result = await identitySweep(db, otherIdentity, 8, "v-point");
  expect(result).toEqual({ identifiedRuns: 1, identifiedObservations: 0 });
  expect(await count("identity_runs", "parse_run_id=107")).toBe(0);
  await expect(identitySweep(db, otherIdentity, 0)).rejects.toThrow("identity_batch_invalid");
  await expect(identifyParse(db, parse(100), otherIdentity, 0)).rejects.toThrow(
    "identity_version_invalid",
  );
});

test("all four observation kinds preserve their instrument roles and provenance", async () => {
  await seed(108);
  await db.batch([
    db.prepare(
      "INSERT INTO transaction_observations(parse_run_id,source_account,currency,raw_locator,extra_json) VALUES(108,'smbc-bank:ordinary-yen','JPY','synthetic-transaction','{}')",
    ),
    db.prepare(
      "INSERT INTO position_observations(parse_run_id,source_account,security_code,quantity_text,quantity_scale,currency,raw_locator,extra_json) VALUES(108,'smbc-bank:ordinary-yen','synthetic-product','0',0,'JPY','synthetic-position','{}')",
    ),
    db.prepare(
      "INSERT INTO valuation_observations(parse_run_id,source_account,subject,metric,currency,raw_locator,extra_json) VALUES(108,'smbc-bank:ordinary-yen','synthetic-product','synthetic-valuation','JPY','synthetic-valuation','{}')",
    ),
  ]);
  expect(await identifyParse(db, parse(108), otherIdentity)).toBe(4);
  const kinds = await db
    .prepare("SELECT kind FROM current_identity_observations WHERE parse_run_id=108 ORDER BY kind")
    .all<{ kind: string }>();
  expect(kinds.results.map((r) => r.kind)).toEqual([
    "balance",
    "position",
    "transaction",
    "valuation",
  ]);
  expect(
    await db
      .prepare(
        "SELECT count(*) n FROM effective_identity_instruments u JOIN current_identity_observations o ON o.id=u.identity_observation_id WHERE o.parse_run_id=108 AND role='unit'",
      )
      .first<number>("n"),
  ).toBe(4);
});

test("empty error parses cannot be published and sealed rows cannot gain later uses", async () => {
  await seed(109, 0, "smbc-bank", false);
  await expect(identifyParse(db, parse(109), otherIdentity)).rejects.toThrow();
  const use = await db.prepare("SELECT * FROM identity_instrument_uses LIMIT 1").first<{
    identity_observation_id: string;
    identifier_id: string;
    instrument_mapping_id: string;
  }>();
  await expect(
    db
      .prepare("INSERT INTO identity_instrument_uses VALUES(?,'usage-unit',?,?)")
      .bind(use!.identity_observation_id, use!.identifier_id, use!.instrument_mapping_id)
      .run(),
  ).rejects.toThrow();
});

test("duplicate instrument roles fail closed before sealing", async () => {
  await seed(110);
  const duplicate: IdentityResolver = (value) => {
    const plan = otherIdentity(value);
    plan.instruments.push({ ...plan.instruments[0]!, value: "USD" });
    return plan;
  };
  await expect(identifyParse(db, parse(110), duplicate)).rejects.toThrow(
    "identity_duplicate_instrument_role",
  );
  expect(await count("current_identity_observations", "parse_run_id=110")).toBe(0);
  expect(await identifyParse(db, parse(110), otherIdentity)).toBe(1);
});

test("new policy revises label and status claims without changing stable entity continuity", async () => {
  await seed(111, 1, "v-point");
  const resolver =
    (label: string): IdentityResolver =>
    (value) => {
      const plan = otherIdentity(value);
      plan.account.label = label;
      plan.account.status = "identified";
      plan.instruments[0]!.label = label;
      return plan;
    };
  await identifyParse(db, parse(111, "v-point"), resolver("old synthetic claim"), 1);
  const before = await db
    .prepare(
      "SELECT m.account_id FROM current_account_mappings m JOIN source_accounts a ON a.id=m.source_account_id WHERE a.source_id='v-point' AND m.label='old synthetic claim'",
    )
    .first<string>("account_id");
  await identifyParse(db, parse(111, "v-point"), resolver("new synthetic claim"), 12);
  await identifyParse(db, parse(111, "v-point"), resolver("stale synthetic claim"), 2);
  const after = await db
    .prepare(
      "SELECT m.account_id,m.label,m.status FROM current_account_mappings m JOIN source_accounts a ON a.id=m.source_account_id WHERE a.source_id='v-point' AND m.label='new synthetic claim'",
    )
    .first<{ account_id: string; label: string; status: string }>();
  expect(after).toEqual({
    account_id: before!,
    label: "new synthetic claim",
    status: "identified",
  });
  expect(
    await db
      .prepare("SELECT label FROM current_instrument_mappings WHERE policy_version=12")
      .first<string>("label"),
  ).toBe("new synthetic claim");
});
