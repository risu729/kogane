// Shared Miniflare harness: a minimal synthetic Layer A plus every Layer B
// migration (0017 onward) applied in order through D1, so tests exercise the
// production schema including triggers. No real provider data is seeded.
import { readdirSync, readFileSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

export const migrationDir = new URL("../../raw-evidence/migrations/", import.meta.url);
export const LAYER_A_SQL = `CREATE TABLE sources(id TEXT PRIMARY KEY,provider TEXT);
CREATE TABLE producers(id TEXT PRIMARY KEY);
CREATE TABLE fetch_runs(id INTEGER PRIMARY KEY,source_id TEXT,acquisition_session_id INTEGER,producer_id TEXT,first_recorded_at_ms INTEGER);
CREATE TABLE fetch_run_annotations(fetch_run_id INTEGER,annotation_kind TEXT);
CREATE VIEW financial_fetch_runs AS SELECT * FROM fetch_runs WHERE source_id<>'kogane-synthetic' AND NOT EXISTS(SELECT 1 FROM fetch_run_annotations a WHERE a.fetch_run_id=fetch_runs.id AND a.annotation_kind='exclude_from_financial_views');
CREATE TABLE acquisition_sessions(id INTEGER PRIMARY KEY,external_session_id TEXT);
CREATE TABLE fetch_run_seals(fetch_run_id INTEGER,sealed_at_ms INTEGER NOT NULL DEFAULT 0);
CREATE TABLE fetch_run_reports(fetch_run_id INTEGER,report_kind TEXT,normalized_outcome TEXT,started_at_ms INTEGER,completed_at_ms INTEGER);
CREATE TABLE fetch_units(id INTEGER PRIMARY KEY,fetch_run_id INTEGER,unit_key TEXT);
CREATE TABLE fetch_unit_reports(fetch_unit_id INTEGER,report_kind TEXT,normalized_outcome TEXT,safe_failure_code TEXT);
CREATE TABLE fetch_artifacts(id INTEGER PRIMARY KEY,fetch_run_id INTEGER,source_id TEXT,dataset TEXT,artifact_key TEXT,fetch_unit_id INTEGER,declared_media_type TEXT,fetched_at_ms INTEGER,recorded_at_ms INTEGER,sha256 TEXT,artifact_role TEXT);
CREATE TABLE raw_objects(sha256 TEXT PRIMARY KEY,byte_size INTEGER,blob_key TEXT);
CREATE TABLE fetch_run_ranges(id INTEGER PRIMARY KEY,fetch_run_id INTEGER,range_kind TEXT,start_value TEXT,end_value TEXT);
CREATE TABLE artifact_ranges(id INTEGER PRIMARY KEY,fetch_artifact_id INTEGER,range_kind TEXT,start_value TEXT,end_value TEXT);
ALTER TABLE fetch_runs ADD COLUMN source_run_key TEXT DEFAULT 'default';
ALTER TABLE acquisition_sessions ADD COLUMN producer_id TEXT;
ALTER TABLE acquisition_sessions ADD COLUMN external_id_namespace TEXT;
ALTER TABLE fetch_units ADD COLUMN unit_kind TEXT DEFAULT 'card';
ALTER TABLE fetch_artifacts ADD COLUMN format_id TEXT;
ALTER TABLE fetch_artifacts ADD COLUMN format_version TEXT;`;

/** D1 exec splits statements by line; use SQLite-aware splitting so triggers
 * are prepared as single statements. */
export function splitSql(sql: string): string[] {
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

export function layerBMigrations(): string[] {
  return readdirSync(migrationDir)
    .filter((name) => name.endsWith(".sql") && name >= "0017")
    .sort();
}

export async function startPipeline(): Promise<{ mf: Miniflare; env: Env }> {
  const bundle = await Bun.build({
    entrypoints: [new URL("../src/worker.ts", import.meta.url).pathname],
    target: "browser",
    format: "esm",
  });
  if (!bundle.success) throw new Error("Worker test bundle failed");
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: await bundle.outputs[0]!.text(),
      compatibilityDate: "2026-09-07",
      d1Databases: ["DB"],
      r2Buckets: ["EVIDENCE"],
    }),
  );
  const db = await mf.getD1Database("DB");
  const bucket = await mf.getR2Bucket("EVIDENCE");
  await db.exec(LAYER_A_SQL);
  for (const name of layerBMigrations())
    for (const sql of splitSql(readFileSync(new URL(name, migrationDir), "utf8")))
      await db.prepare(sql).run();
  // Miniflare and generated Workers types use distinct platform declarations;
  // validate the runtime proxy at this test boundary instead of double casts.
  const bindings: unknown = { DB: db, EVIDENCE: bucket };
  assertBindings(bindings);
  return { mf, env: bindings };
}

function assertBindings(value: unknown): asserts value is Env {
  if (!value || typeof value !== "object" || !("DB" in value) || !("EVIDENCE" in value))
    throw new Error("bindings missing");
  for (const [binding, method] of [
    [value.DB, "prepare"],
    [value.EVIDENCE, "get"],
  ] as const) {
    if (!binding || typeof binding !== "object" || !(method in binding))
      throw new Error("invalid runtime binding");
  }
}

/** Seed one synthetic successful run with one artifact. Sealing goes through
 * the same insert the production trigger observes. */
export async function seedArtifact(
  env: Env,
  id: number,
  source: string,
  dataset: string,
  key: string,
  payload: unknown,
  seal = true,
): Promise<string> {
  const bytes =
    payload instanceof Uint8Array
      ? new Uint8Array(payload)
      : new TextEncoder().encode(JSON.stringify(payload));
  const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  await env.EVIDENCE.put(sha, bytes);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO sources VALUES(?,?)").bind(source, source),
    env.DB.prepare("INSERT OR IGNORE INTO producers VALUES('collector-r2-importer')"),
    env.DB.prepare("INSERT INTO acquisition_sessions(id,external_session_id) VALUES(?,?)").bind(
      id,
      `run-${id}`,
    ),
    env.DB.prepare(
      "INSERT INTO fetch_runs(id,source_id,acquisition_session_id,producer_id,first_recorded_at_ms) VALUES(?,?,?,?,?)",
    ).bind(id, source, id, "collector-r2-importer", now),
    env.DB.prepare("INSERT INTO fetch_run_reports VALUES(?,'terminal','success',?,?)").bind(
      id,
      now,
      now,
    ),
    env.DB.prepare("INSERT OR IGNORE INTO raw_objects VALUES(?,?,?)").bind(sha, bytes.length, sha),
    env.DB.prepare(
      "INSERT INTO fetch_artifacts(id,fetch_run_id,source_id,dataset,artifact_key,fetch_unit_id,declared_media_type,fetched_at_ms,recorded_at_ms,sha256,artifact_role) VALUES(?,?,?,?,?,NULL,'application/json',?,?,?,'collector_derived')",
    ).bind(id, id, source, dataset, key, now, now, sha),
  ]);
  if (seal)
    await env.DB.prepare("INSERT INTO fetch_run_seals(fetch_run_id,sealed_at_ms) VALUES(?,?)")
      .bind(id, now)
      .run();
  return sha;
}
