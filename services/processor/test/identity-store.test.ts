import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { otherIdentity as providerIdentity } from "../../../packages/identity/src/other.ts";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import type { IdentityInput, IdentityPlan } from "../../../packages/identity/src/types.ts";
import {
  identifyParse,
  BASE_IDENTITY_POLICY_VERSION,
  identityKey,
  identitySweep,
  reviseIdentity,
  type IdentityResolver,
} from "../src/identity-store.ts";
import { publishParse } from "./harness.ts";
// Storage tests deliberately do not depend on a provider policy PR.
function otherIdentity(input: IdentityInput): IdentityPlan {
  const unit = input.instrument ?? input.currency;
  return {
    account: {
      key: [input.sourceAccount],
      label: "Synthetic account",
      role: "deposit",
      status: "provider-local",
      reason: "synthetic-test-policy",
    },
    instruments: unit
      ? [
          {
            role: "unit",
            kind: "money",
            namespace: "iso4217",
            scope: "global",
            value: unit,
            label: unit,
            status: "identified",
            reason: "synthetic-test-policy",
            details: {},
          },
        ]
      : [],
    issues: [],
  };
}

let mf: Miniflare;
let db: D1Database;
const migrationDir = new URL("../../../packages/storage-d1/migrations/core/", import.meta.url);
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
CREATE TABLE fetch_run_annotations(fetch_run_id INTEGER,annotation_kind TEXT);
CREATE VIEW financial_fetch_runs AS SELECT * FROM fetch_runs WHERE source_id<>'kogane-synthetic' AND NOT EXISTS(SELECT 1 FROM fetch_run_annotations a WHERE a.fetch_run_id=fetch_runs.id AND a.annotation_kind='exclude_from_financial_views');
CREATE TABLE acquisition_sessions(id INTEGER PRIMARY KEY,external_session_id TEXT);
CREATE TABLE fetch_run_seals(fetch_run_id INTEGER);
CREATE TABLE fetch_run_reports(fetch_run_id INTEGER,report_kind TEXT,normalized_outcome TEXT,started_at_ms INTEGER,completed_at_ms INTEGER);
CREATE TABLE fetch_units(id INTEGER PRIMARY KEY,fetch_run_id INTEGER,unit_key TEXT);
CREATE TABLE fetch_unit_reports(fetch_unit_id INTEGER,report_kind TEXT,normalized_outcome TEXT,safe_failure_code TEXT);
CREATE TABLE fetch_artifacts(id INTEGER PRIMARY KEY,fetch_run_id INTEGER,source_id TEXT,dataset TEXT,artifact_key TEXT,fetch_unit_id INTEGER,declared_media_type TEXT,fetched_at_ms INTEGER,recorded_at_ms INTEGER,sha256 TEXT,artifact_role TEXT);
CREATE TABLE raw_objects(sha256 TEXT PRIMARY KEY,byte_size INTEGER,blob_key TEXT);
CREATE TABLE fetch_run_ranges(id INTEGER PRIMARY KEY,fetch_run_id INTEGER,range_kind TEXT,start_value TEXT,end_value TEXT);
CREATE TABLE artifact_ranges(id INTEGER PRIMARY KEY,fetch_artifact_id INTEGER,range_kind TEXT,start_value TEXT,end_value TEXT);`);
  await db.exec(`ALTER TABLE fetch_runs ADD COLUMN source_run_key TEXT DEFAULT 'default';
ALTER TABLE acquisition_sessions ADD COLUMN producer_id TEXT;
ALTER TABLE acquisition_sessions ADD COLUMN external_id_namespace TEXT;
ALTER TABLE fetch_units ADD COLUMN unit_kind TEXT DEFAULT 'card';
ALTER TABLE fetch_artifacts ADD COLUMN format_id TEXT;
ALTER TABLE fetch_artifacts ADD COLUMN format_version TEXT;`);
  for (const name of [
    "0017_observation_pipeline.sql",
    "0018_identity.sql",
    "0019_identity_seal_provenance.sql",
    "0020_vpass_identity_binding.sql",
    "0021_vpass_binding_lookup_plan.sql",
    "0022_identity_current_run_plan.sql",
    "0023_account_connections.sql",
    "0024_observation_decimals.sql",
    "0025_parse_coverage.sql",
    "0026_publication_gate.sql",
    "0029_decision_log.sql",
  ]) {
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

async function vpass(id: number, ordinal = "card-001", withObservation = true) {
  await seed(id, 0, "vpass");
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO sources VALUES('vpass','synthetic')"),
    db.prepare("INSERT OR IGNORE INTO producers VALUES('collector-r2-importer')"),
    db.prepare("UPDATE fetch_runs SET producer_id='collector-r2-importer' WHERE id=?").bind(id),
    db
      .prepare(
        "UPDATE acquisition_sessions SET producer_id='collector-r2-importer',external_id_namespace='vpass-worker-card-v1' WHERE id=?",
      )
      .bind(id),
    db
      .prepare("INSERT INTO fetch_units(id,fetch_run_id,unit_key,unit_kind) VALUES(?,?,?,'card')")
      .bind(id, id, ordinal),
    db.prepare("UPDATE fetch_artifacts SET fetch_unit_id=? WHERE id=?").bind(id, id),
    ...(withObservation
      ? [
          db
            .prepare(
              "INSERT INTO transaction_observations(parse_run_id,source_account,currency,raw_locator,extra_json) VALUES(?,?,'JPY','$',?)",
            )
            .bind(
              id,
              `vpass:${ordinal}`,
              JSON.stringify({
                trustedVpassBinding: { cardToken: `vpass-card-v1-${"f".repeat(64)}` },
              }),
            ),
        ]
      : []),
  ]);
  return { ...parse(id, "vpass"), producer_id: "collector-r2-importer" };
}
async function sidecar(
  id: number,
  financial: number,
  token = `vpass-card-v1-${"a".repeat(64)}`,
  ordinal = "card-001",
  sealed = true,
) {
  await db.batch([
    db
      .prepare(
        "INSERT INTO fetch_runs(id,source_id,producer_id,acquisition_session_id,source_run_key) VALUES(?,'vpass','collector-r2-importer',?,?)",
      )
      .bind(id, financial, `${ordinal}-vpass-card-binding-v1`),
    db
      .prepare("INSERT INTO fetch_units(id,fetch_run_id,unit_key,unit_kind) VALUES(?,?,?,'card')")
      .bind(id, id, token),
    db.prepare("INSERT INTO fetch_run_reports VALUES(?,'terminal','success',0,0)").bind(id),
    db.prepare("INSERT INTO fetch_unit_reports VALUES(?,'terminal','success',NULL)").bind(id),
    db
      .prepare(
        "INSERT INTO fetch_artifacts(id,fetch_run_id,source_id,dataset,artifact_key,fetch_unit_id,artifact_role,format_id,format_version) VALUES(?,?,'vpass','card-identity-binding','card-identity-binding.json',?,'collector_derived','vpass-card-identity-binding-json','1')",
      )
      .bind(id, id, id),
  ]);
  if (sealed) await db.prepare("INSERT INTO fetch_run_seals VALUES(?)").bind(id).run();
}

test("Vpass missing sidecars complete at baseline; late sealed binding upgrades with pinned evidence", async () => {
  const financial = await vpass(500);
  expect(await identifyParse(db, financial, providerIdentity)).toBe(1);
  expect(await count("identity_run_seals")).toBe(1);
  expect(await identitySweep(db, providerIdentity, 8, "vpass")).toEqual({
    processedRuns: 0,
    identifiedRuns: 0,
    identifiedObservations: 0,
  });
  const before = await db
    .prepare(
      "SELECT sa.reference_json FROM current_identity_observations o JOIN source_accounts sa ON sa.id=o.source_account_id WHERE parse_run_id=500",
    )
    .first<string>("reference_json");
  expect(JSON.parse(before!)).toEqual(["vpass:card-001", "fetch-run", "500"]);
  await sidecar(1500, 500, undefined, undefined, false);
  expect(await count("trusted_vpass_card_bindings")).toBe(0);
  await db.prepare("INSERT INTO fetch_run_seals VALUES(1500)").run();
  expect((await identitySweep(db, providerIdentity, 8, "vpass")).identifiedRuns).toBe(1);
  const pin = await db
    .prepare("SELECT * FROM identity_vpass_bindings")
    .first<{ binding_artifact_id: number; card_token: string }>();
  expect(pin?.binding_artifact_id).toBe(1500);
  expect(pin?.card_token).toBe(`vpass-card-v1-${"a".repeat(64)}`);
  expect(
    await db
      .prepare("SELECT policy_version FROM current_identity_observations WHERE parse_run_id=500")
      .first<number>("policy_version"),
  ).toBe(2);
  expect(await identifyParse(db, financial, providerIdentity)).toBe(0);
  for (const sql of [
    "UPDATE identity_vpass_bindings SET card_token=card_token",
    "DELETE FROM identity_vpass_bindings",
    "INSERT OR REPLACE INTO identity_vpass_bindings SELECT * FROM identity_vpass_bindings",
  ])
    await expect(db.prepare(sql).run()).rejects.toThrow();
});

test("trusted Vpass token survives ordinal and run changes, never consuming forged provider extra", async () => {
  const next = await vpass(501, "card-002");
  await sidecar(1501, 501, undefined, "card-002");
  await identifyParse(db, next, providerIdentity);
  const rows = await db
    .prepare(
      "SELECT DISTINCT source_account_id FROM current_identity_observations WHERE parse_run_id IN(500,501)",
    )
    .all();
  expect(rows.results).toHaveLength(1);
  const other = await vpass(502);
  await sidecar(1502, 502, `vpass-card-v1-${"b".repeat(64)}`);
  await identifyParse(db, other, providerIdentity);
  expect(
    (
      await db
        .prepare(
          "SELECT DISTINCT source_account_id FROM current_identity_observations WHERE parse_run_id IN(500,502)",
        )
        .all()
    ).results,
  ).toHaveLength(2);
});

// Ten complete Miniflare provenance scenarios need more than Bun's default
// five seconds on CI; a timeout also terminates the shared worker for later tests.
test("Vpass binding rejects mismatched provenance, ambiguous units, and unsuccessful ownership", async () => {
  const changes = [
    "UPDATE fetch_runs SET producer_id='other-producer' WHERE id=?",
    "UPDATE fetch_runs SET acquisition_session_id=500 WHERE id=?",
    "UPDATE fetch_runs SET source_run_key='card-002-vpass-card-binding-v1' WHERE id=?",
    "UPDATE fetch_runs SET source_id='smbc-bank' WHERE id=?",
    "UPDATE fetch_artifacts SET format_version='2' WHERE id=?",
    "UPDATE fetch_artifacts SET fetch_unit_id=500 WHERE id=?",
    "UPDATE fetch_unit_reports SET normalized_outcome='partial' WHERE fetch_unit_id=?",
    "UPDATE fetch_run_reports SET normalized_outcome='failure' WHERE fetch_run_id=?",
    "UPDATE fetch_units SET unit_key='vpass-card-v1-invalid' WHERE id=?",
  ];
  for (let i = 0; i < changes.length; i++) {
    const id = 520 + i;
    const financial = await vpass(id);
    await sidecar(id + 1000, id);
    await db
      .prepare(changes[i]!)
      .bind(id + 1000)
      .run();
    expect(await count("trusted_vpass_card_bindings", `financial_artifact_id=${id}`)).toBe(0);
    await identifyParse(db, financial, providerIdentity);
    expect(
      await db
        .prepare("SELECT policy_version FROM current_identity_observations WHERE parse_run_id=?")
        .bind(id)
        .first<number>("policy_version"),
    ).toBe(1);
  }
  const ambiguous = await vpass(540);
  await sidecar(1540, 540);
  await db
    .prepare(
      "INSERT INTO fetch_units(id,fetch_run_id,unit_key,unit_kind) VALUES(2540,1540,?,'card')",
    )
    .bind(`vpass-card-v1-${"c".repeat(64)}`)
    .run();
  expect(await count("trusted_vpass_card_bindings", "financial_artifact_id=540")).toBe(0);
  await identifyParse(db, ambiguous, providerIdentity);
  const fakeRun = await identityKey("ir", [540, 2]);
  await db.prepare("INSERT INTO identity_runs VALUES(?,540,2,'synthetic')").bind(fakeRun).run();
  await expect(
    db
      .prepare("INSERT INTO identity_vpass_bindings VALUES(?,540,1540,?)")
      .bind(fakeRun, `vpass-card-v1-${"a".repeat(64)}`)
      .run(),
  ).rejects.toThrow();
}, 30000);

test("manual fallback decisions survive Vpass evidence upgrade and invalidated evidence is not current", async () => {
  const financial = await vpass(550);
  await identifyParse(db, financial, providerIdentity);
  const mapping = await db
    .prepare(
      "SELECT m.* FROM current_account_mappings m JOIN current_identity_observations o ON o.source_account_id=m.source_account_id WHERE o.parse_run_id=550",
    )
    .first<{ source_account_id: string; account_id: string; revision: number }>();
  await reviseIdentity(db, {
    kind: "account",
    referenceId: mapping!.source_account_id,
    targetId: mapping!.account_id,
    expectedRevision: mapping!.revision,
    reason: "synthetic manual decision",
  });
  await sidecar(1550, 550);
  await identifyParse(db, financial, providerIdentity);
  expect(
    await db
      .prepare("SELECT source_account_id FROM current_identity_observations WHERE parse_run_id=550")
      .first<string>("source_account_id"),
  ).toBe(mapping!.source_account_id);
  await db
    .prepare(
      "UPDATE fetch_unit_reports SET safe_failure_code='synthetic-invalidated' WHERE fetch_unit_id=1550",
    )
    .run();
  expect(
    await db
      .prepare("SELECT policy_version FROM current_identity_observations WHERE parse_run_id=550")
      .first<number>("policy_version"),
  ).toBe(1);
});

test("Vpass pinned decisions resume and concurrent invocations remain idempotent", async () => {
  const financial = await vpass(560);
  await sidecar(1560, 560);
  expect(await identifyParse(db, financial, providerIdentity, 2, 1)).toBe(1);
  expect(await count("current_identity_observations", "parse_run_id=560")).toBe(0);
  await Promise.all([
    identifyParse(db, financial, providerIdentity),
    identifyParse(db, financial, providerIdentity),
  ]);
  expect(await count("current_identity_observations", "parse_run_id=560")).toBe(1);
  const runId = await identityKey("ir", [560, 2]);
  expect(await count("identity_vpass_bindings", `identity_run_id='${runId}'`)).toBe(1);
  const duplicate = await vpass(561);
  await sidecar(1561, 561);
  await sidecar(2561, 561, `vpass-card-v1-${"d".repeat(64)}`);
  expect(await count("trusted_vpass_card_bindings", "financial_artifact_id=561")).toBe(0);
  await identifyParse(db, duplicate, providerIdentity);
  expect((await identitySweep(db, providerIdentity, 40, "vpass")).processedRuns).toBe(0);
  await db
    .prepare("INSERT INTO fetch_run_annotations VALUES(1560,'exclude_from_financial_views')")
    .run();
  expect(await count("trusted_vpass_card_bindings", "financial_artifact_id=560")).toBe(0);
  expect(await count("current_identity_observations", "parse_run_id=560")).toBe(0);
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
    db
      .prepare("INSERT INTO acquisition_sessions(id,external_session_id) VALUES(?,?)")
      .bind(id, `synthetic-${id}`),
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
  // A success is published the way the pipeline writer does; the identity
  // views read the publication projection since migration 0026.
  if (success) await publishParse(db, id);
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
  expect(
    await count(
      "identity_run_seals",
      "identity_run_id IN(SELECT id FROM identity_runs WHERE parse_run_id=100)",
    ),
  ).toBe(1);
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
  const run = await identityKey("ir", [101, BASE_IDENTITY_POLICY_VERSION]);
  expect(await count("identity_observations", `identity_run_id='${run}'`)).toBe(100);
  expect(await count("current_identity_observations", "parse_run_id=101")).toBe(0);
  expect(await identifyParse(db, parse(101), otherIdentity)).toBe(1);
  expect(await count("identity_observations", `identity_run_id='${run}'`)).toBe(101);
  expect(await count("current_identity_observations", "parse_run_id=101")).toBe(101);
}, 30000);

test("numeric policy ordering publishes version 10 over 3 even if old worker runs later", async () => {
  await seed(102);
  await identifyParse(db, parse(102), otherIdentity, 10);
  await identifyParse(db, parse(102), otherIdentity, 3);
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
    .prepare(
      "SELECT m.* FROM current_account_mappings m JOIN current_identity_observations o ON o.source_account_id=m.source_account_id WHERE o.parse_run_id=100 LIMIT 1",
    )
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
  expect(result).toEqual({ processedRuns: 1, identifiedRuns: 1, identifiedObservations: 0 });
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
  const current = await db
    .prepare(
      "SELECT source_account_id,account_id,revision FROM current_account_mappings WHERE label='new synthetic claim'",
    )
    .first<{ source_account_id: string; account_id: string; revision: number }>();
  await reviseIdentity(db, {
    kind: "account",
    referenceId: current!.source_account_id,
    targetId: current!.account_id,
    expectedRevision: current!.revision,
    reason: "Confirm current identity",
  });
  expect(
    await db
      .prepare("SELECT label FROM current_account_mappings WHERE source_account_id=?")
      .bind(current!.source_account_id)
      .first<string>("label"),
  ).toBe("new synthetic claim");
});

test("large runs advance durable row checkpoints without repeating completed resolver work", async () => {
  await seed(112, 401);
  let calls = 0;
  const resolver: IdentityResolver = (input) => {
    calls++;
    return otherIdentity(input);
  };
  expect(await identifyParse(db, parse(112), resolver)).toBe(200);
  expect(await count("current_identity_observations", "parse_run_id=112")).toBe(0);
  expect(await identifyParse(db, parse(112), resolver)).toBe(200);
  expect(await identifyParse(db, parse(112), resolver)).toBe(1);
  expect(calls).toBe(401);
  expect(await count("current_identity_observations", "parse_run_id=112")).toBe(401);
});

test("SQL cannot publish an empty identity run of a failed parse", async () => {
  await seed(113, 0, "smbc-bank", false);
  await db
    .prepare("INSERT INTO identity_runs VALUES('failed-empty-identity',113,1,'synthetic')")
    .run();
  await expect(
    db
      .prepare("INSERT INTO identity_run_seals VALUES('failed-empty-identity',0,'synthetic')")
      .run(),
  ).rejects.toThrow();
});

test("empty Vpass projections batch at most40 runs with mandatory trusted pins and no resolver calls", async () => {
  for (let id = 3000; id < 3043; id++) {
    await vpass(id, "card-001", false);
    if (id !== 3042) await sidecar(id + 1000, id);
  }
  const accountsBefore = await count("account_mappings");
  const instrumentsBefore = await count("instrument_mappings");
  let resolverCalls = 0;
  const resolver: IdentityResolver = (input) => {
    resolverCalls++;
    return providerIdentity(input);
  };
  const batchSizes: number[] = [];
  const measured = new Proxy(db, {
    get(target, key) {
      if (key === "prepare") return target.prepare.bind(target);
      if (key === "batch")
        return (statements: D1PreparedStatement[]) => {
          batchSizes.push(statements.length);
          return target.batch(statements);
        };
      return Reflect.get(target, key, target);
    },
  });
  expect(await identitySweep(measured, resolver, 40, "vpass")).toEqual({
    processedRuns: 40,
    identifiedRuns: 40,
    identifiedObservations: 0,
  });
  // Runs, their policy records, mandatory pins and seals: one batch of four.
  expect(batchSizes).toEqual([4]);
  expect(
    await count(
      "identity_vpass_bindings",
      "identity_run_id IN(SELECT id FROM identity_runs WHERE parse_run_id>=3000)",
    ),
  ).toBe(40);
  expect(await identitySweep(db, resolver, 40, "vpass")).toEqual({
    processedRuns: 3,
    identifiedRuns: 3,
    identifiedObservations: 0,
  });
  expect(
    await count(
      "identity_vpass_bindings",
      "identity_run_id IN(SELECT id FROM identity_runs WHERE parse_run_id>=3000)",
    ),
  ).toBe(42);
  expect(
    await db
      .prepare("SELECT policy_version FROM identity_runs WHERE parse_run_id=3042")
      .first<number>("policy_version"),
  ).toBe(1);
  expect(await identitySweep(db, resolver, 40, "vpass")).toEqual({
    processedRuns: 0,
    identifiedRuns: 0,
    identifiedObservations: 0,
  });
  expect(resolverCalls).toBe(0);
  expect(await count("account_mappings")).toBe(accountsBefore);
  expect(await count("instrument_mappings")).toBe(instrumentsBefore);
}, 30000);

test("empty batching excludes failed parses, failed acquisitions, unsealed and excluded runs", async () => {
  await db.prepare("INSERT INTO sources VALUES('empty-fixture','synthetic')").run();
  for (let id = 3500; id < 3505; id++) await seed(id, 0, "empty-fixture", id !== 3501);
  await db
    .prepare("UPDATE fetch_run_reports SET normalized_outcome='failure' WHERE fetch_run_id=3502")
    .run();
  await db.prepare("DELETE FROM fetch_run_seals WHERE fetch_run_id=3503").run();
  await db
    .prepare("INSERT INTO fetch_run_annotations VALUES(3504,'exclude_from_financial_views')")
    .run();
  const reject: IdentityResolver = () => {
    throw new Error("empty resolver should not run");
  };
  expect(await identitySweep(db, reject, 40, "empty-fixture")).toEqual({
    processedRuns: 1,
    identifiedRuns: 1,
    identifiedObservations: 0,
  });
  expect(await count("identity_runs", "parse_run_id BETWEEN 3501 AND 3504")).toBe(0);
  expect(await identitySweep(db, reject, 40, "empty-fixture")).toEqual({
    processedRuns: 0,
    identifiedRuns: 0,
    identifiedObservations: 0,
  });
  for (const id of [3505, 3506]) await seed(id, 0, "empty-fixture");
  const concurrent = await Promise.all([
    identitySweep(db, reject, 40, "empty-fixture"),
    identitySweep(db, reject, 40, "empty-fixture"),
  ]);
  expect(concurrent.reduce((n, result) => n + result.identifiedRuns, 0)).toBe(2);
  expect(
    await count(
      "identity_run_seals",
      "identity_run_id IN(SELECT id FROM identity_runs WHERE parse_run_id IN(3505,3506))",
    ),
  ).toBe(2);
});

test("one row of any observation kind prevents the empty fast path", async () => {
  const inserts = [
    "INSERT INTO transaction_observations(parse_run_id,source_account,currency,raw_locator,extra_json) VALUES(?,'fixture','JPY','$','{}')",
    "INSERT INTO balance_observations(parse_run_id,source_account,metric,instrument,raw_locator,extra_json) VALUES(?,'fixture','balance','JPY','$','{}')",
    "INSERT INTO position_observations(parse_run_id,source_account,security_code,quantity_text,quantity_scale,raw_locator,extra_json) VALUES(?,'fixture','EXAMPLE','1',0,'$','{}')",
    "INSERT INTO valuation_observations(parse_run_id,source_account,subject,metric,currency,raw_locator,extra_json) VALUES(?,'fixture','EXAMPLE','value','JPY','$','{}')",
  ];
  for (let i = 0; i < inserts.length; i++) {
    await seed(3600 + i, 0, "empty-fixture");
    await db
      .prepare(inserts[i]!)
      .bind(3600 + i)
      .run();
  }
  let calls = 0;
  const resolver: IdentityResolver = (input) => {
    calls++;
    return otherIdentity(input);
  };
  expect(await identitySweep(db, resolver, 40, "empty-fixture")).toEqual({
    processedRuns: 4,
    identifiedRuns: 4,
    identifiedObservations: 4,
  });
  expect(calls).toBe(4);
});
