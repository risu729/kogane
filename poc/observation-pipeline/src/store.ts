// SQLite (bun:sqlite) + filesystem blob store, standing in for D1 + R2.
// The SQL is written to stay valid on D1; only this module would change when
// the pipeline moves to a Worker.

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ArtifactMeta, CoverageClaim, Observation, ParseIssue } from "./types.ts";
import { unitScopePolicySql, unitScopeSuccessSql } from "./snapshot-query.ts";

const POC_ROOT = dirname(import.meta.dir); // poc/observation-pipeline/

export interface Store {
  db: Database;
  blobDir: string;
}

/**
 * Bumped whenever schema.sql changes shape. The DDL uses IF NOT EXISTS, so
 * without this check an existing database would silently keep an older shape
 * and fail later at an unrelated INSERT. Versions 2 and 3 have explicit
 * compatible migrations because fetch-run outcome and artifact-level collector identity
 * are required to interpret observations; other unknown versions remain
 * fail-closed.
 *
 * Purely additive objects do not need a bump: a new `CREATE TABLE/VIEW IF NOT
 * EXISTS` in schema.sql appears on the next open of an existing store, and
 * nothing already stored is reinterpreted. `fetch_unit_outcomes` and
 * `observation_fetch_artifact_units` (D13) are added that way, empty, which
 * leaves every existing store on the run-scoped rule.
 */
const SCHEMA_VERSION = 6;

export function openStore(stateDir?: string): Store {
  const root = stateDir ?? join(POC_ROOT, "state");
  const blobDir = join(root, "blobs");
  mkdirSync(blobDir, { recursive: true });
  const db = new Database(join(root, "kogane-poc.sqlite"), { create: true });
  db.exec("PRAGMA foreign_keys = ON;");
  const found = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (![0, 2, 3, 4, 5, SCHEMA_VERSION].includes(found)) {
    throw new Error(
      `${root} was created with schema version ${found}, but this build expects ${SCHEMA_VERSION}. ` +
        "Only schema versions 2 through 5 have in-place migrations; export or re-ingest other stores.",
    );
  }
  if (found >= 2 && found <= 5) {
    db.transaction(() => {
      if (found === 2) {
        db.exec(
          "ALTER TABLE fetch_runs ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0);",
        );
        // v2 did not persist failure evidence. Preserve the conservative outcome:
        // every known non-success run has at least one failure.
        db.exec("UPDATE fetch_runs SET failure_count = 1 WHERE status <> 'success';");
      }
      if (found === 2 || found === 3) {
        const hasArtifacts = storeTableExists(db, "fetch_artifacts");
        if (hasArtifacts) {
          db.exec("ALTER TABLE fetch_artifacts ADD COLUMN artifact_key TEXT;");
          db.exec("ALTER TABLE fetch_artifacts ADD COLUMN statement_state TEXT;");
          db.exec("ALTER TABLE fetch_artifacts ADD COLUMN period TEXT;");
        }
      }
      if (found <= 4) {
        db.exec("ALTER TABLE fetch_runs ADD COLUMN window_start TEXT;");
        db.exec("ALTER TABLE fetch_runs ADD COLUMN window_end TEXT;");
      }
      if (storeTableExists(db, "fetch_artifacts")) {
        db.exec("ALTER TABLE fetch_artifacts ADD COLUMN fetch_unit_key TEXT;");
      }
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    })();
  }
  // The publication gate is additive (docs/publication-gate.md). A store that
  // predates it gets the legacy current set materialised once, exactly as
  // production migration 0026 does, so current views keep showing the same rows.
  const hadPublicationGate = storeTableExists(db, "published_parse_runs");
  db.exec(readFileSync(join(POC_ROOT, "schema.sql"), "utf8"));
  if (!hadPublicationGate) db.transaction(() => backfillPublicationGate(db))();
  // Additive derived schema: same SQL policy as production D1. Raw schema and
  // existing store version remain compatible; apply once, transactionally.
  if (!storeTableExists(db, "observation_decimal_values")) {
    db.transaction(() =>
      db.exec(
        readFileSync(
          join(POC_ROOT, "../../services/raw-evidence/migrations/0024_observation_decimals.sql"),
          "utf8",
        ),
      ),
    )();
  }
  // Parser coverage contract (0025): typed issues, coverage claims and the
  // dataset snapshot policy table, seeded on the legacy policy exactly as in
  // production. Additive; existing parse runs gain no synthesized claim.
  if (!storeTableExists(db, "dataset_snapshot_policies")) {
    db.transaction(() =>
      db.exec(
        readFileSync(
          join(POC_ROOT, "../../services/raw-evidence/migrations/0025_parse_coverage.sql"),
          "utf8",
        ),
      ),
    )();
  }
  // Unit-scoped eligibility (0037): the additive policy and claim columns come
  // from the production migration, so the two schemas cannot drift. Its
  // `observation_fetch_artifact_units` view is `CREATE VIEW IF NOT EXISTS` and
  // schema.sql above already defined the PoC's own projection of the same
  // shape, so applying the file here leaves that view untouched.
  if (!storeColumnExists(db, "parse_coverage_claims", "unit_scope")) {
    db.transaction(() =>
      db.exec(
        readFileSync(
          join(POC_ROOT, "../../services/raw-evidence/migrations/0037_unit_scope_eligibility.sql"),
          "utf8",
        ),
      ),
    )();
  }
  if (found === 0) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return { db, blobDir };
}

function storeTableExists(db: Database, name: string): boolean {
  return (
    db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1").get(name) !== null
  );
}

function storeColumnExists(db: Database, table: string, column: string): boolean {
  if (!storeTableExists(db, table)) return false;
  return (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(
    (row) => row.name === column,
  );
}

/**
 * One-time backfill of the publication pointer from the legacy rule
 * (`status = 'ok' AND superseded_by_parse_run_id IS NULL`), idempotent and
 * recorded as 'backfill' events. Mirrors production migration 0026; this is
 * the one reader-side use of the legacy predicate outside publishParseRun.
 */
function backfillPublicationGate(db: Database): void {
  db.exec(
    `INSERT INTO published_parse_runs
       (fetch_artifact_id, parser_name, parse_run_id, parser_version, published_at, publication_kind)
     SELECT p.fetch_artifact_id, p.parser_name, p.id, p.parser_version, p.parsed_at, 'normal'
     FROM parse_runs p
     WHERE p.status = 'ok' AND p.superseded_by_parse_run_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM parse_runs q WHERE q.fetch_artifact_id = p.fetch_artifact_id
         AND q.parser_name = p.parser_name AND q.status = 'ok'
         AND q.superseded_by_parse_run_id IS NULL AND q.id > p.id)
       AND NOT EXISTS (SELECT 1 FROM published_parse_runs x
         WHERE x.fetch_artifact_id = p.fetch_artifact_id AND x.parser_name = p.parser_name);
     INSERT INTO publication_events
       (fetch_artifact_id, parser_name, previous_parse_run_id, new_parse_run_id, kind, actor, reason, occurred_at)
     SELECT x.fetch_artifact_id, x.parser_name, NULL, x.parse_run_id, 'backfill', 'store:schema',
       'legacy_current_predicate', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     FROM published_parse_runs x
     WHERE NOT EXISTS (SELECT 1 FROM publication_events e WHERE e.new_parse_run_id = x.parse_run_id);`,
  );
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ── layer A writes ─────────────────────────────────────────────────────

export function upsertSource(
  store: Store,
  source: { id: string; provider: string; ingestion: string },
): void {
  store.db
    .query(
      "INSERT INTO sources (id, provider, ingestion) VALUES (?1, ?2, ?3) ON CONFLICT (id) DO NOTHING",
    )
    .run(source.id, source.provider, source.ingestion);
}

export function insertFetchRun(
  store: Store,
  run: {
    sourceId: string;
    externalRunId?: string;
    tool: string;
    startedAt: string;
    completedAt?: string;
    status: "success" | "partial" | "failed";
    failureCount?: number;
    window?: { from: string; to: string };
  },
): number {
  // An empty external run id is treated as absent throughout, so that a
  // manifest with `"runId": ""` cannot claim a distinct run identity.
  const externalRunId =
    run.externalRunId !== undefined && run.externalRunId !== "" ? run.externalRunId : undefined;
  const failureCount = run.failureCount ?? (run.status === "success" ? 0 : 1);
  if (
    !Number.isSafeInteger(failureCount) ||
    failureCount < 0 ||
    (run.status === "success") !== (failureCount === 0)
  ) {
    throw new Error("fetch-run status and failure evidence are inconsistent");
  }
  if (
    run.window &&
    (!validDate(run.window.from) || !validDate(run.window.to) || run.window.from > run.window.to)
  ) {
    throw new Error("fetch-run window is invalid");
  }
  const existing = externalRunId
    ? (store.db
        .query("SELECT id FROM fetch_runs WHERE source_id = ?1 AND external_run_id = ?2")
        .get(run.sourceId, externalRunId) as { id: number } | null)
    : null;
  if (existing) return existing.id;
  const result = store.db
    .query(
      `INSERT INTO fetch_runs
         (source_id, external_run_id, tool, started_at, completed_at, status, failure_count,
          window_start, window_end)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
    .run(
      run.sourceId,
      externalRunId ?? null,
      run.tool,
      run.startedAt,
      run.completedAt ?? null,
      run.status,
      failureCount,
      run.window?.from ?? null,
      run.window?.to ?? null,
    );
  return Number(result.lastInsertRowid);
}

/** Content-addressed blob write: identical bytes are stored once. */
export function putRawObject(
  store: Store,
  bytes: Uint8Array,
  contentType: string,
): { sha256: string; deduplicated: boolean } {
  const digest = sha256Hex(bytes);
  const existing = store.db
    .query("SELECT sha256 FROM raw_objects WHERE sha256 = ?1")
    .get(digest) as { sha256: string } | null;
  if (existing) return { sha256: digest, deduplicated: true };
  // "/" rather than the platform separator: this key is an R2 object key.
  const blobKey = `${digest.slice(0, 2)}/${digest}`;
  const path = join(store.blobDir, ...blobKey.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  store.db
    .query("INSERT INTO raw_objects (sha256, size, content_type, blob_key) VALUES (?1, ?2, ?3, ?4)")
    .run(digest, bytes.byteLength, contentType, blobKey);
  return { sha256: digest, deduplicated: false };
}

export function readRawObject(store: Store, sha256: string): Uint8Array {
  const row = store.db.query("SELECT blob_key FROM raw_objects WHERE sha256 = ?1").get(sha256) as {
    blob_key: string;
  } | null;
  if (!row) throw new Error(`raw object not found: ${sha256}`);
  const path = join(store.blobDir, ...row.blob_key.split("/"));
  if (!existsSync(path)) throw new Error(`blob missing on disk: ${path}`);
  return readFileSync(path);
}

export function insertFetchArtifact(
  store: Store,
  artifact: {
    fetchRunId: number;
    sourceId: string;
    dataset?: string;
    artifactKey?: string;
    fetchUnitKey?: string;
    statementState?: string;
    period?: string;
    url?: string;
    method?: string;
    httpStatus?: number;
    mime: string;
    fetchedAt: string;
    sha256: string;
  },
): number {
  const result = store.db
    .query(
      `INSERT INTO fetch_artifacts
         (fetch_run_id, source_id, dataset, artifact_key, fetch_unit_key, statement_state, period,
          url, method, http_status, mime, fetched_at, sha256)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
    )
    .run(
      artifact.fetchRunId,
      artifact.sourceId,
      artifact.dataset ?? null,
      artifact.artifactKey ?? null,
      artifact.fetchUnitKey ?? null,
      artifact.statementState ?? null,
      artifact.period ?? null,
      artifact.url ?? null,
      artifact.method ?? null,
      artifact.httpStatus ?? null,
      artifact.mime,
      artifact.fetchedAt,
      artifact.sha256,
    );
  return Number(result.lastInsertRowid);
}

export function listArtifacts(store: Store): ArtifactMeta[] {
  const rows = store.db
    .query(
      `SELECT a.id, a.source_id, f.status AS run_status,
              f.failure_count AS run_failure_count, f.window_start, f.window_end,
              a.dataset, a.artifact_key, a.fetch_unit_key, a.statement_state, a.period,
              a.url, a.mime, a.fetched_at, a.sha256,
              CASE WHEN ${unitScopePolicySql("a")} AND ${unitScopeSuccessSql("a")}
                   THEN 1 ELSE 0 END AS unit_scope_admitted
       FROM fetch_artifacts a
       JOIN fetch_runs f ON f.id = a.fetch_run_id
       ORDER BY a.id`,
    )
    .all() as {
    id: number;
    source_id: string;
    run_status: "success" | "partial" | "failed";
    run_failure_count: number;
    window_start: string | null;
    window_end: string | null;
    dataset: string | null;
    artifact_key: string | null;
    fetch_unit_key: string | null;
    statement_state: string | null;
    period: string | null;
    url: string | null;
    mime: string;
    fetched_at: string;
    sha256: string;
    unit_scope_admitted: number;
  }[];
  return rows.map((row) => {
    if ((row.window_start === null) !== (row.window_end === null)) {
      throw new Error("fetch-run window is incomplete");
    }
    if (
      row.window_start !== null &&
      row.window_end !== null &&
      (!validDate(row.window_start) ||
        !validDate(row.window_end) ||
        row.window_start > row.window_end)
    ) {
      throw new Error("fetch-run window is invalid");
    }
    return {
      id: row.id,
      sourceId: row.source_id,
      runStatus: row.run_status,
      runFailureCount: row.run_failure_count,
      // D13: the artifact's dataset names the `unit` scope and its own fetch
      // unit reported terminal success, so a parser precondition about "the
      // run succeeded" may be met by the unit instead. Null for every dataset
      // until an operator changes a policy row.
      unitScopeEligibility: row.unit_scope_admitted === 1 ? "unit-independent-v1" : null,
      ...(row.window_start && row.window_end
        ? { runWindow: { from: row.window_start, to: row.window_end } }
        : {}),
      dataset: row.dataset,
      artifactKey: row.artifact_key,
      fetchUnitKey: row.fetch_unit_key,
      statementState: row.statement_state,
      period: row.period,
      url: row.url,
      mime: row.mime,
      fetchedAt: row.fetched_at,
      sha256: row.sha256,
    };
  });
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  return new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

// ── layer B writes ─────────────────────────────────────────────────────

/**
 * Find the SUCCESSFUL parse run for this artifact at this parser version, if
 * one exists. A previous failed attempt is deliberately not matched: a parse
 * that failed on a transient condition must stay retryable at the same
 * version, without inventing a version number to get past it.
 */
export function findParseRun(
  store: Store,
  artifactId: number,
  parserName: string,
  parserVersion: string,
): number | undefined {
  const row = store.db
    .query(
      `SELECT id FROM parse_runs
       WHERE fetch_artifact_id = ?1 AND parser_name = ?2 AND parser_version = ?3
         AND status = 'ok'`,
    )
    .get(artifactId, parserName, parserVersion) as { id: number } | null;
  return row?.id;
}

/**
 * Compare two dotted version strings numerically, segment by segment.
 * Returns a negative number when `a` is older than `b`.
 */
export function compareVersions(a: string, b: string): number {
  const left = a.split(".");
  const right = b.split(".");
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const x = Number(left[index] ?? "0");
    const y = Number(right[index] ?? "0");
    if (Number.isNaN(x) || Number.isNaN(y)) {
      // Non-numeric versions are only ever compared for equality.
      return a === b ? 0 : a < b ? -1 : 1;
    }
    if (x !== y) return x - y;
  }
  return 0;
}

export function insertParseRun(
  store: Store,
  run: {
    artifactId: number;
    parserName: string;
    parserVersion: string;
    parsedAt: string;
    status: "ok" | "error";
    error?: string;
    warnings: string[];
  },
): number {
  const result = store.db
    .query(
      `INSERT INTO parse_runs
         (fetch_artifact_id, parser_name, parser_version, parsed_at, status, error, warnings_json)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .run(
      run.artifactId,
      run.parserName,
      run.parserVersion,
      run.parsedAt,
      run.status,
      run.error ?? null,
      JSON.stringify(run.warnings),
    );
  return Number(result.lastInsertRowid);
}

/** Contract v2 diagnostics of a parse run; nothing is written for a legacy parser. */
export function insertParseIssues(
  store: Store,
  parseRunId: number,
  issues: readonly ParseIssue[],
): void {
  const statement = store.db.query(
    `INSERT INTO parse_issues (parse_run_id, code, locator, severity, impact, message)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  );
  for (const issue of issues) {
    statement.run(
      parseRunId,
      issue.code,
      issue.locator,
      issue.severity,
      issue.impact,
      issue.message,
    );
  }
}

/**
 * Contract v2 coverage claims of a parse run. The parent fetch run outcome is
 * recorded with the claim so a later unit-scoped policy can read it.
 */
export function insertCoverageClaims(
  store: Store,
  parseRunId: number,
  claims: readonly CoverageClaim[],
  parentRun: {
    status: "success" | "partial" | "failed";
    failureCount: number;
    /** The artifact's own terminal unit outcome, when it has a fetch unit (D13). */
    unitOutcome?: string | null;
  },
): void {
  // `unit_scope` records which D13 eligibility scope admitted this parse: a
  // parent run that is not a clean success can only have been parsed under
  // `unit-independent-v1`.
  const unitScope = parentRun.status === "success" && parentRun.failureCount === 0 ? "run" : "unit";
  const statement = store.db.query(
    `INSERT INTO parse_coverage_claims
       (parse_run_id, claim_id, scope_key, mode, completeness, membership_complete,
        observed_count, expected_count, evidence_refs_json, policy_version, failure_cause,
        absence_meaning, parent_run_status, parent_run_failure_count, unit_scope,
        unit_report_outcome)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`,
  );
  for (const claim of claims) {
    statement.run(
      parseRunId,
      claim.claimId,
      claim.scopeKey,
      claim.mode,
      claim.completeness,
      claim.membershipComplete ? 1 : 0,
      claim.observedCount,
      claim.expectedCount,
      JSON.stringify(claim.evidenceRefs),
      claim.policyVersion,
      claim.failureCause,
      claim.absenceMeaning,
      parentRun.status,
      parentRun.failureCount,
      unitScope,
      parentRun.unitOutcome ?? null,
    );
  }
}

/** The terminal outcome of the unit an artifact belongs to, or null (D13). */
export function fetchUnitOutcome(store: Store, artifact: { id: number }): string | null {
  const row = store.db
    .query("SELECT unit_outcome FROM observation_fetch_artifact_units WHERE fetch_artifact_id = ?1")
    .get(artifact.id) as { unit_outcome: string } | null;
  return row?.unit_outcome ?? null;
}

/**
 * Record one fetch unit's terminal outcome (D13). Production writes this
 * through Layer A's `fetch_unit_reports`; the PoC store has no unit hierarchy,
 * so the outcome is attached to the run's unit key directly.
 */
export function insertFetchUnitOutcome(
  store: Store,
  outcome: {
    fetchRunId: number;
    unitKey: string;
    unitOutcome: "success" | "partial" | "failed" | "human_required" | "cancelled" | "unknown";
    failureCode?: string;
  },
): void {
  store.db
    .query(
      `INSERT INTO fetch_unit_outcomes (fetch_run_id, unit_key, unit_outcome, unit_failure_code)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (fetch_run_id, unit_key) DO UPDATE SET
         unit_outcome = excluded.unit_outcome, unit_failure_code = excluded.unit_failure_code`,
    )
    .run(outcome.fetchRunId, outcome.unitKey, outcome.unitOutcome, outcome.failureCode ?? null);
}

/**
 * Reconcile parse-run lineage after a successful parse.
 *
 * Every currently-live run of the same parser over the same artifact is
 * compared by version, not by insertion order, because parsers can be run out
 * of order (a rollback, a stale worker, a reverted registry entry). Runs at an
 * older version are superseded by the new run; if a newer version is already
 * live, the new run is marked superseded by it instead, so that running an old
 * parser can never quietly make stale observations current again.
 *
 * Observations themselves are never touched. The superseded rows stay
 * queryable through their parse run, which is what makes "current" a query
 * rather than a stored state.
 */
export function supersedeOlderParseRuns(
  store: Store,
  artifactId: number,
  parserName: string,
  newParseRunId: number,
): number {
  const newRun = store.db
    .query("SELECT parser_version FROM parse_runs WHERE id = ?1")
    .get(newParseRunId) as { parser_version: string } | null;
  if (!newRun) return 0;
  const live = store.db
    .query(
      `SELECT id, parser_version FROM parse_runs
       WHERE fetch_artifact_id = ?1 AND parser_name = ?2 AND status = 'ok'
         AND id <> ?3 AND superseded_by_parse_run_id IS NULL`,
    )
    .all(artifactId, parserName, newParseRunId) as {
    id: number;
    parser_version: string;
  }[];

  const newer = live
    .filter((run) => compareVersions(run.parser_version, newRun.parser_version) > 0)
    .sort((a, b) => compareVersions(b.parser_version, a.parser_version))[0];
  if (newer) {
    store.db
      .query("UPDATE parse_runs SET superseded_by_parse_run_id = ?1 WHERE id = ?2")
      .run(newer.id, newParseRunId);
    return 0;
  }

  let superseded = 0;
  for (const run of live) {
    if (compareVersions(run.parser_version, newRun.parser_version) >= 0) continue;
    store.db
      .query("UPDATE parse_runs SET superseded_by_parse_run_id = ?1 WHERE id = ?2")
      .run(newParseRunId, run.id);
    superseded += 1;
  }
  return superseded;
}

/**
 * Publish a successful parse run: reconcile lineage, then move the
 * publication pointer of (artifact, parser) to the new run only if that
 * reconciliation left it current. A run born superseded (an older version
 * completing late) never moves the pointer, so readers of the pointer and
 * readers of the legacy rule agree. One transaction; one event per move.
 * Returns the number of older runs superseded, as supersedeOlderParseRuns does.
 */
export function publishParseRun(
  store: Store,
  artifactId: number,
  parserName: string,
  parseRunId: number,
  publishedAt: string = new Date().toISOString(),
): number {
  return store.db.transaction(() => {
    const superseded = supersedeOlderParseRuns(store, artifactId, parserName, parseRunId);
    const run = store.db
      .query("SELECT status, superseded_by_parse_run_id FROM parse_runs WHERE id = ?1")
      .get(parseRunId) as { status: string; superseded_by_parse_run_id: number | null } | null;
    if (!run || run.status !== "ok" || run.superseded_by_parse_run_id !== null) return superseded;
    store.db
      .query(
        `INSERT INTO publication_events
           (fetch_artifact_id, parser_name, previous_parse_run_id, new_parse_run_id, kind, actor, reason, occurred_at)
         SELECT p.fetch_artifact_id, p.parser_name,
           (SELECT x.parse_run_id FROM published_parse_runs x
             WHERE x.fetch_artifact_id = p.fetch_artifact_id AND x.parser_name = p.parser_name),
           p.id, 'normal', 'pipeline', 'parse_ok', ?2
         FROM parse_runs p WHERE p.id = ?1`,
      )
      .run(parseRunId, publishedAt);
    store.db
      .query(
        `INSERT INTO published_parse_runs
           (fetch_artifact_id, parser_name, parse_run_id, parser_version, published_at, publication_kind)
         SELECT p.fetch_artifact_id, p.parser_name, p.id, p.parser_version, ?2, 'normal'
         FROM parse_runs p WHERE p.id = ?1
         ON CONFLICT (fetch_artifact_id, parser_name) DO UPDATE SET
           parse_run_id = excluded.parse_run_id, parser_version = excluded.parser_version,
           published_at = excluded.published_at, publication_kind = 'normal', release_id = NULL`,
      )
      .run(parseRunId, publishedAt);
    return superseded;
  })();
}

export function insertObservation(
  store: Store,
  parseRunId: number,
  observation: Observation,
): void {
  const extra = JSON.stringify(observation.extra);
  switch (observation.kind) {
    case "transaction": {
      store.db
        .query(
          `INSERT INTO transaction_observations
             (parse_run_id, source_account, external_id, status, amount_minor, amount_text,
              amount_scale, currency, description, counterparty, as_of, observed_at,
              raw_locator, extra_json)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
        )
        .run(
          parseRunId,
          observation.sourceAccount,
          observation.externalId ?? null,
          observation.status ?? null,
          observation.amountMinor ?? null,
          observation.amountText ?? null,
          observation.amountScale ?? null,
          observation.currency ?? null,
          observation.description ?? null,
          observation.counterparty ?? null,
          observation.asOf ?? null,
          observation.observedAt ?? null,
          observation.rawLocator,
          extra,
        );
      return;
    }
    case "balance": {
      store.db
        .query(
          `INSERT INTO balance_observations
             (parse_run_id, source_account, metric, amount_minor, amount_text, amount_scale,
              instrument, as_of, observed_at, raw_locator, extra_json)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
        )
        .run(
          parseRunId,
          observation.sourceAccount,
          observation.metric,
          observation.amountMinor ?? null,
          observation.amountText ?? null,
          observation.amountScale ?? null,
          observation.instrument,
          observation.asOf ?? null,
          observation.observedAt ?? null,
          observation.rawLocator,
          extra,
        );
      return;
    }
    case "position": {
      store.db
        .query(
          `INSERT INTO position_observations
             (parse_run_id, source_account, security_code, security_name, market,
              quantity_text, quantity_scale, currency, as_of, observed_at, raw_locator, extra_json)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
        )
        .run(
          parseRunId,
          observation.sourceAccount,
          observation.securityCode,
          observation.securityName ?? null,
          observation.market ?? null,
          observation.quantityText,
          observation.quantityScale,
          observation.currency ?? null,
          observation.asOf ?? null,
          observation.observedAt ?? null,
          observation.rawLocator,
          extra,
        );
      return;
    }
    case "valuation": {
      store.db
        .query(
          `INSERT INTO valuation_observations
             (parse_run_id, source_account, subject, metric, amount_minor, amount_text,
              amount_scale, currency, as_of, observed_at, raw_locator, extra_json)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
        )
        .run(
          parseRunId,
          observation.sourceAccount,
          observation.subject,
          observation.metric,
          observation.amountMinor ?? null,
          observation.amountText ?? null,
          observation.amountScale ?? null,
          observation.currency,
          observation.asOf ?? null,
          observation.observedAt ?? null,
          observation.rawLocator,
          extra,
        );
      return;
    }
  }
}
