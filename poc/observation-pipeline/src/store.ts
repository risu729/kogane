// SQLite (bun:sqlite) + filesystem blob store, standing in for D1 + R2.
// The SQL is written to stay valid on D1; only this module would change when
// the pipeline moves to a Worker.

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ArtifactMeta, Observation } from "./types.ts";

const POC_ROOT = dirname(import.meta.dir); // poc/observation-pipeline/

export interface Store {
  db: Database;
  blobDir: string;
}

export function openStore(stateDir?: string): Store {
  const root = stateDir ?? join(POC_ROOT, "state");
  const blobDir = join(root, "blobs");
  mkdirSync(blobDir, { recursive: true });
  const db = new Database(join(root, "kogane-poc.sqlite"), { create: true });
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(readFileSync(join(POC_ROOT, "schema.sql"), "utf8"));
  return { db, blobDir };
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
    status: string;
  },
): number {
  const existing = run.externalRunId
    ? (store.db
        .query(
          "SELECT id FROM fetch_runs WHERE source_id = ?1 AND external_run_id = ?2",
        )
        .get(run.sourceId, run.externalRunId) as { id: number } | null)
    : null;
  if (existing) return existing.id;
  const result = store.db
    .query(
      `INSERT INTO fetch_runs (source_id, external_run_id, tool, started_at, completed_at, status)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
    .run(
      run.sourceId,
      run.externalRunId ?? null,
      run.tool,
      run.startedAt,
      run.completedAt ?? null,
      run.status,
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
  const blobKey = join(digest.slice(0, 2), digest);
  const path = join(store.blobDir, blobKey);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  store.db
    .query(
      "INSERT INTO raw_objects (sha256, size, content_type, blob_key) VALUES (?1, ?2, ?3, ?4)",
    )
    .run(digest, bytes.byteLength, contentType, blobKey);
  return { sha256: digest, deduplicated: false };
}

export function readRawObject(store: Store, sha256: string): Uint8Array {
  const row = store.db
    .query("SELECT blob_key FROM raw_objects WHERE sha256 = ?1")
    .get(sha256) as { blob_key: string } | null;
  if (!row) throw new Error(`raw object not found: ${sha256}`);
  const path = join(store.blobDir, row.blob_key);
  if (!existsSync(path)) throw new Error(`blob missing on disk: ${path}`);
  return readFileSync(path);
}

export function insertFetchArtifact(
  store: Store,
  artifact: {
    fetchRunId: number;
    sourceId: string;
    dataset?: string;
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
         (fetch_run_id, source_id, dataset, url, method, http_status, mime, fetched_at, sha256)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
    .run(
      artifact.fetchRunId,
      artifact.sourceId,
      artifact.dataset ?? null,
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
      `SELECT id, source_id, dataset, url, mime, fetched_at, sha256
       FROM fetch_artifacts ORDER BY id`,
    )
    .all() as {
    id: number;
    source_id: string;
    dataset: string | null;
    url: string | null;
    mime: string;
    fetched_at: string;
    sha256: string;
  }[];
  return rows.map((row) => ({
    id: row.id,
    sourceId: row.source_id,
    dataset: row.dataset,
    url: row.url,
    mime: row.mime,
    fetchedAt: row.fetched_at,
    sha256: row.sha256,
  }));
}

// ── layer B writes ─────────────────────────────────────────────────────

export function findParseRun(
  store: Store,
  artifactId: number,
  parserName: string,
  parserVersion: string,
): number | undefined {
  const row = store.db
    .query(
      `SELECT id FROM parse_runs
       WHERE fetch_artifact_id = ?1 AND parser_name = ?2 AND parser_version = ?3`,
    )
    .get(artifactId, parserName, parserVersion) as { id: number } | null;
  return row?.id;
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

/**
 * Mark every earlier parse run of the same parser over the same artifact as
 * superseded by the new run. Observations themselves are never touched — the
 * old rows stay queryable through their (superseded) parse run.
 */
export function supersedeOlderParseRuns(
  store: Store,
  artifactId: number,
  parserName: string,
  newParseRunId: number,
): number {
  const result = store.db
    .query(
      `UPDATE parse_runs SET superseded_by_parse_run_id = ?1
       WHERE fetch_artifact_id = ?2 AND parser_name = ?3
         AND id <> ?1 AND superseded_by_parse_run_id IS NULL`,
    )
    .run(newParseRunId, artifactId, parserName);
  return result.changes;
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
             (parse_run_id, source_account, external_id, status, amount_minor, currency,
              description, counterparty, as_of, observed_at, raw_locator, extra_json)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
        )
        .run(
          parseRunId,
          observation.sourceAccount,
          observation.externalId ?? null,
          observation.status ?? null,
          observation.amountMinor ?? null,
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
