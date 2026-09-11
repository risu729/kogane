// Shared-R2 collection runs and their stage evidence (migration 0039).
//
// The Processor's questions are exactly three: "have I seen this terminal
// before, and under what identity?", "what happened at each stage?", and
// "where did the bounded scan get to?". Each is one statement here, so the
// Processor holds no SQL of its own (unified plan 02 §3).
//
// Every write is conditional on its own absence or on the row still being
// open, and is read back by the caller through `readCollectionRun`. The 0039
// triggers refuse the rest: no delete, no re-pointing a registered run, no
// rewriting a stage attempt.
import { all, first, run, type D1Like } from "../d1.ts";

/** The idempotency tuple of plan 03 §4. */
export interface CollectionRunIdentity {
  source: string;
  runId: string;
  terminalDigest: string;
  registrationContractVersion: string;
}

export interface CollectionRunRow {
  id: number;
  source: string;
  run_id: string;
  terminal_key: string;
  terminal_digest: string;
  registration_contract_version: string;
  provider_outcome: string | null;
  coverage_status: string | null;
  acquisition_session_ref: string | null;
  first_seen_at: string;
  blocked_code: string | null;
  fetch_run_id: number | null;
  acquisition_session_id: number | null;
  registered_at: string | null;
}

export interface CollectionStageRow {
  id: number;
  collection_run_id: number;
  stage: string;
  state: string;
  evidence_ref: string | null;
  failure_code: string | null;
  recorded_at: string;
}

const RUN_COLUMNS = `id, source, run_id, terminal_key, terminal_digest,
 registration_contract_version, provider_outcome, coverage_status,
 acquisition_session_ref, first_seen_at, blocked_code, fetch_run_id,
 acquisition_session_id, registered_at`;

/** The row for one exact identity, or null when this terminal is new here. */
export function readCollectionRun(
  db: D1Like,
  identity: CollectionRunIdentity,
): Promise<CollectionRunRow | null> {
  return first<CollectionRunRow>(
    db,
    `SELECT ${RUN_COLUMNS} FROM collection_runs
      WHERE source = ?1 AND run_id = ?2 AND terminal_digest = ?3
        AND registration_contract_version = ?4`,
    [
      identity.source,
      identity.runId,
      identity.terminalDigest,
      identity.registrationContractVersion,
    ],
  );
}

/**
 * Every row recorded for one run id, newest first. A second manifest under the
 * same run id shows up here as a second row with a different digest, which is
 * how a conflict is detected rather than by overwriting anything (G1-06).
 */
export function readCollectionRunsFor(
  db: D1Like,
  source: string,
  runId: string,
): Promise<CollectionRunRow[]> {
  return all<CollectionRunRow>(
    db,
    `SELECT ${RUN_COLUMNS} FROM collection_runs
      WHERE source = ?1 AND run_id = ?2 ORDER BY id DESC`,
    [source, runId],
  );
}

export interface CollectionRunSighting extends CollectionRunIdentity {
  terminalKey: string;
  providerOutcome: string | null;
  coverageStatus: string | null;
  acquisitionSessionRef: string | null;
  firstSeenAt: string;
  blockedCode: string | null;
}

/**
 * Records that this terminal was seen. Conditional on its own absence, so the
 * queue consumer and the scan can both record the same sighting and only the
 * first one writes (G1-05); returns 1 for the caller that wrote it and 0 for
 * every other. Never records a run as already registered: the 0039 insert
 * trigger refuses that.
 */
export async function insertCollectionRunIfAbsent(
  db: D1Like,
  sighting: CollectionRunSighting,
): Promise<number> {
  const result = await run(
    db,
    `INSERT INTO collection_runs (
       source, run_id, terminal_key, terminal_digest, registration_contract_version,
       provider_outcome, coverage_status, acquisition_session_ref, first_seen_at, blocked_code
     ) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
       WHERE NOT EXISTS (
         SELECT 1 FROM collection_runs
          WHERE source = ?1 AND run_id = ?2 AND terminal_digest = ?4
            AND registration_contract_version = ?5)`,
    [
      sighting.source,
      sighting.runId,
      sighting.terminalKey,
      sighting.terminalDigest,
      sighting.registrationContractVersion,
      sighting.providerOutcome,
      sighting.coverageStatus,
      sighting.acquisitionSessionRef,
      sighting.firstSeenAt,
      sighting.blockedCode,
    ],
  );
  return result.meta.changes;
}

/**
 * Blocks an open run. Write-once by the 0039 trigger: the first reason stays,
 * so a later sweep cannot relabel why a run stopped.
 */
export async function blockCollectionRun(
  db: D1Like,
  collectionRunId: number,
  blockedCode: string,
): Promise<number> {
  const result = await run(
    db,
    `UPDATE collection_runs SET blocked_code = ?2
      WHERE id = ?1 AND blocked_code IS NULL AND registered_at IS NULL`,
    [collectionRunId, blockedCode],
  );
  return result.meta.changes;
}

/**
 * Links the CORE rows the registration produced. Guarded on the run still
 * being unregistered, so a duplicate delivery that races this one writes
 * nothing and the caller reads back the winner's link (G1-11).
 */
export async function linkRegisteredRun(
  db: D1Like,
  collectionRunId: number,
  link: { fetchRunId: number; acquisitionSessionId: number | null; registeredAt: string },
): Promise<number> {
  const result = await run(
    db,
    `UPDATE collection_runs
        SET fetch_run_id = ?2, acquisition_session_id = ?3, registered_at = ?4
      WHERE id = ?1 AND fetch_run_id IS NULL AND registered_at IS NULL`,
    [collectionRunId, link.fetchRunId, link.acquisitionSessionId, link.registeredAt],
  );
  return result.meta.changes;
}

export interface CollectionStageInput {
  collectionRunId: number;
  stage: string;
  state: string;
  evidenceRef?: string | null;
  failureCode?: string | null;
  recordedAt: string;
}

/** Appends one stage attempt. Rows are never updated (0039 triggers). */
export async function appendCollectionStage(
  db: D1Like,
  input: CollectionStageInput,
): Promise<void> {
  await run(
    db,
    `INSERT INTO collection_run_stages
       (collection_run_id, stage, state, evidence_ref, failure_code, recorded_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    [
      input.collectionRunId,
      input.stage,
      input.state,
      input.evidenceRef ?? null,
      input.failureCode ?? null,
      input.recordedAt,
    ],
  );
}

/** The newest attempt of each stage of one run. */
export function readCollectionStages(
  db: D1Like,
  collectionRunId: number,
): Promise<CollectionStageRow[]> {
  return all<CollectionStageRow>(
    db,
    `SELECT id, collection_run_id, stage, state, evidence_ref, failure_code, recorded_at
       FROM collection_run_stages s
      WHERE collection_run_id = ?1
        AND id = (SELECT max(id) FROM collection_run_stages
                   WHERE collection_run_id = s.collection_run_id AND stage = s.stage)
      ORDER BY id`,
    [collectionRunId],
  );
}

/** The newest attempt of one stage of one run, or null when it has none. */
export function readLatestCollectionStage(
  db: D1Like,
  collectionRunId: number,
  stage: string,
): Promise<CollectionStageRow | null> {
  return first<CollectionStageRow>(
    db,
    `SELECT id, collection_run_id, stage, state, evidence_ref, failure_code, recorded_at
       FROM collection_run_stages
      WHERE collection_run_id = ?1 AND stage = ?2
      ORDER BY id DESC LIMIT 1`,
    [collectionRunId, stage],
  );
}

/** True when this run already has a completed `registered` stage. */
export async function collectionRunRegistered(
  db: D1Like,
  collectionRunId: number,
): Promise<boolean> {
  const row = await first<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM collection_run_stages
      WHERE collection_run_id = ?1 AND stage = 'registered' AND state = 'completed'`,
    [collectionRunId],
  );
  return (row?.n ?? 0) > 0;
}

// ── the bounded scan's cursor ───────────────────────────────────────────

export interface CollectionScanStateRow {
  lane: string;
  cursor: string | null;
  last_scan_at_ms: number;
  pages_completed: number;
  cycles_completed: number;
  last_seen: number;
  last_registered: number;
  last_blocked: number;
}

export const COLLECTION_SCAN_LANE = "collection_scan";

export async function readCollectionScanState(db: D1Like): Promise<CollectionScanStateRow | null> {
  return await first<CollectionScanStateRow>(
    db,
    `SELECT lane, cursor, last_scan_at_ms, pages_completed, cycles_completed,
            last_seen, last_registered, last_blocked
       FROM collection_scan_state WHERE lane = ?1`,
    [COLLECTION_SCAN_LANE],
  );
}

export interface CollectionScanProgress {
  /** The R2 cursor for the next tick; null finishes the cycle and restarts it. */
  cursor: string | null;
  nowMs: number;
  seen: number;
  registered: number;
  blocked: number;
}

/**
 * Advances the cursor by one page. A finished walk (`cursor` null) counts a
 * cycle and starts the next tick at the beginning of the prefix again, which
 * is what makes a terminal confirmed late reachable at all (G1-12).
 */
export async function advanceCollectionScan(
  db: D1Like,
  progress: CollectionScanProgress,
): Promise<void> {
  await run(
    db,
    `UPDATE collection_scan_state
        SET cursor = ?2, last_scan_at_ms = ?3, pages_completed = pages_completed + 1,
            cycles_completed = cycles_completed + CASE WHEN ?2 IS NULL THEN 1 ELSE 0 END,
            last_seen = ?4, last_registered = ?5, last_blocked = ?6
      WHERE lane = ?1`,
    [
      COLLECTION_SCAN_LANE,
      progress.cursor,
      progress.nowMs,
      progress.seen,
      progress.registered,
      progress.blocked,
    ],
  );
}
