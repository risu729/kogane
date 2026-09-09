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

/** Apply one migration file through D1, statement by statement. */
export async function applyMigration(db: D1Database, name: string): Promise<void> {
  for (const sql of splitSql(readFileSync(new URL(name, migrationDir), "utf8")))
    await db.prepare(sql).run();
}

/** `migrations` defaults to every Layer B migration; an upgrade test passes
 * the subset that represents the deployed schema and applies the rest later.
 * `vars` are Worker configuration variables - `RELEASE_CANDIDATES_ENABLED` is
 * the A04 flag, absent by default exactly as in production. */
export async function startPipeline(
  migrations: readonly string[] = layerBMigrations(),
  vars: Record<string, string> = {},
): Promise<{ mf: Miniflare; env: Env }> {
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
      bindings: vars,
    }),
  );
  const db = await mf.getD1Database("DB");
  const bucket = await mf.getR2Bucket("EVIDENCE");
  await db.exec(LAYER_A_SQL);
  for (const name of migrations) await applyMigration(db, name);
  // Miniflare and generated Workers types use distinct platform declarations;
  // validate the runtime proxy at this test boundary instead of double casts.
  const bindings: unknown = { DB: db, EVIDENCE: bucket, ...vars };
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

/** Publish a successful parse run the way the pipeline writer does
 * (docs/publication-gate.md): move the (artifact, parser) pointer and record
 * the event. A parse run seeded directly with status 'ok' is an unadopted
 * result until this runs, and no normal reader shows it. Like the writer it
 * does nothing for a run that is already the pointer, so it can never append
 * the self-referencing event migration 0036 rejects. */
export async function publishParse(
  db: D1Database,
  parseRunId: number,
  publishedAt = "2026-09-07T00:00:00.000Z",
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO publication_events(fetch_artifact_id,parser_name,previous_parse_run_id,new_parse_run_id,kind,actor,reason,occurred_at)
        SELECT p.fetch_artifact_id,p.parser_name,
          (SELECT x.parse_run_id FROM published_parse_runs x WHERE x.fetch_artifact_id=p.fetch_artifact_id AND x.parser_name=p.parser_name),
          p.id,'normal','pipeline','parse_ok',?2 FROM parse_runs p WHERE p.id=?1
          AND NOT EXISTS(SELECT 1 FROM published_parse_runs x WHERE x.parse_run_id=p.id)`,
      )
      .bind(parseRunId, publishedAt),
    db
      .prepare(
        `INSERT INTO published_parse_runs(fetch_artifact_id,parser_name,parse_run_id,parser_version,published_at,publication_kind)
        SELECT p.fetch_artifact_id,p.parser_name,p.id,p.parser_version,?2,'normal' FROM parse_runs p WHERE p.id=?1
          AND NOT EXISTS(SELECT 1 FROM published_parse_runs x WHERE x.parse_run_id=p.id)
        ON CONFLICT(fetch_artifact_id,parser_name) DO UPDATE SET parse_run_id=excluded.parse_run_id,
          parser_version=excluded.parser_version,published_at=excluded.published_at,publication_kind='normal',release_id=NULL`,
      )
      .bind(parseRunId, publishedAt),
  ]);
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

/** One fetch unit of a multi-unit run: its own terminal report and artifacts. */
export interface SeededUnit {
  /** Layer A unit id and unit key; MyJCB uses one unit per card connection. */
  id: number;
  key: string;
  outcome: "success" | "partial" | "failed" | "human_required";
  failureCode?: string;
  artifacts: { id: number; key: string; payload: unknown }[];
}

/**
 * Seed one sealed run that catalogued several independent fetch units, the way
 * a per-card collector does (design review D13). `runOutcome` is the run's own
 * terminal report: 'partial' is what a collector reports when one card failed,
 * and it is what makes `observation_fetch_runs` project the run as partial with
 * `failure_count = 1`. Every artifact is attributed to its unit, so the
 * unit-scoped predicate can tell the units apart.
 */
export async function seedUnitRun(
  env: Env,
  run: {
    id: number;
    source: string;
    dataset: string;
    runOutcome: "success" | "partial" | "failed";
    units: SeededUnit[];
    fetchedAtMs?: number;
  },
): Promise<void> {
  const now = run.fetchedAtMs ?? Date.now();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("INSERT OR IGNORE INTO sources VALUES(?,?)").bind(run.source, run.source),
    env.DB.prepare("INSERT OR IGNORE INTO producers VALUES('collector-r2-importer')"),
    env.DB.prepare("INSERT INTO acquisition_sessions(id,external_session_id) VALUES(?,?)").bind(
      run.id,
      `run-${run.id}`,
    ),
    env.DB.prepare(
      "INSERT INTO fetch_runs(id,source_id,acquisition_session_id,producer_id,first_recorded_at_ms) VALUES(?,?,?,?,?)",
    ).bind(run.id, run.source, run.id, "collector-r2-importer", now),
    env.DB.prepare("INSERT INTO fetch_run_reports VALUES(?,'terminal',?,?,?)").bind(
      run.id,
      run.runOutcome,
      now,
      now,
    ),
  ];
  for (const unit of run.units) {
    statements.push(
      env.DB.prepare(
        "INSERT INTO fetch_units(id,fetch_run_id,unit_key,unit_kind) VALUES(?,?,?,'connection')",
      ).bind(unit.id, run.id, unit.key),
      env.DB.prepare(
        "INSERT INTO fetch_unit_reports(fetch_unit_id,report_kind,normalized_outcome,safe_failure_code) VALUES(?,'terminal',?,?)",
      ).bind(unit.id, unit.outcome, unit.failureCode ?? null),
    );
  }
  for (const unit of run.units)
    for (const artifact of unit.artifacts) {
      const bytes = new TextEncoder().encode(JSON.stringify(artifact.payload));
      const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
      await env.EVIDENCE.put(sha, bytes);
      statements.push(
        env.DB.prepare("INSERT OR IGNORE INTO raw_objects VALUES(?,?,?)").bind(
          sha,
          bytes.length,
          sha,
        ),
        env.DB.prepare(
          "INSERT INTO fetch_artifacts(id,fetch_run_id,source_id,dataset,artifact_key,fetch_unit_id,declared_media_type,fetched_at_ms,recorded_at_ms,sha256,artifact_role) VALUES(?,?,?,?,?,?,'application/json',?,?,?,'collector_derived')",
        ).bind(artifact.id, run.id, run.source, run.dataset, artifact.key, unit.id, now, now, sha),
      );
    }
  await env.DB.batch(statements);
  await env.DB.prepare("INSERT INTO fetch_run_seals(fetch_run_id,sealed_at_ms) VALUES(?,?)")
    .bind(run.id, now)
    .run();
}

/**
 * The operator step that enables `unit-independent-v1` for one dataset, and
 * its rollback. `snapshotSelection = 0` names a dataset for eligibility only,
 * without making it a container-snapshot dataset.
 */
export async function setUnitScope(
  env: Env,
  row: {
    sourceId: string;
    dataset: string;
    parserName: string;
    scope: "run" | "unit";
    snapshotSelection?: 0 | 1;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO dataset_snapshot_policies(source_id,dataset,parser_name,policy_id,unit_scope,snapshot_selection,updated_at_ms)
     VALUES(?,?,?,'legacy-warning-compat-v1',?,?,1)
     ON CONFLICT(parser_name,dataset) DO UPDATE SET unit_scope=excluded.unit_scope,
       snapshot_selection=excluded.snapshot_selection,updated_at_ms=excluded.updated_at_ms`,
  )
    .bind(row.sourceId, row.dataset, row.parserName, row.scope, row.snapshotSelection ?? 1)
    .run();
}
