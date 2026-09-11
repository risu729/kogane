// The fixed input of one projection build (unified plan 05 §3, migration
// 0038).
//
// A bounded build spans several cron invocations. Before this module the
// builder re-read CORE on every invocation, so the rows written after a
// publication came from a different context than the rows written before it,
// and the sealed snapshot was a mixture no input can reproduce. Now the build
// reads CORE once, at a revision that did not move while it was reading,
// writes the canonical bytes of what it read to the DATA bucket under
// `projection-inputs/<digest>/input.json`, records them in CORE, and every
// later invocation resumes from those bytes and never from CORE's current
// state.
//
// Nothing here holds a provider body: the input is the candidate rows,
// relations and release identifiers the projection already stores.

import { canonicalJson, sha256Hex } from "../../../packages/domain/src/context.ts";
import type { D1Like, D1StatementLike } from "../../../packages/storage-d1/src/d1.ts";
import {
  PROJECTION_INPUT_CONTRACT_VERSION,
  type EntityRelationRow,
  type ProjectionCandidate,
  type ProjectionInputManifest,
} from "../../../packages/read-model/src/index";

/** R2 prefix of every stored input; the same DATA bucket, no separate store. */
export const PROJECTION_INPUT_PREFIX = "projection-inputs";

/**
 * What one build is allowed to read. Only `content` is hashed: the digest is
 * the identity of the *data*, so two captures that read the same thing at two
 * revisions produce the same snapshot and the second one is recognised as
 * already built (05 §4). The revision orders the captures and says how current
 * the content is; it is not part of the identity.
 */
export interface ProjectionInputContent {
  manifest: ProjectionInputManifest;
  candidates: ProjectionCandidate[];
  relations: EntityRelationRow[];
}

/**
 * The stored envelope. `capturedAt` is fixed here on purpose: a build that
 * predicts an expiry from "now" has fixed that instant too, so a resumed build
 * cannot quietly evaluate the same rule at a later time (05 §3). It is outside
 * the digest because the same data captured a minute later is the same data.
 */
export interface FixedProjectionInput<Content = ProjectionInputContent> {
  contractVersion: string;
  sourceRevision: number;
  visibilityRevision: number;
  coreEpoch: string;
  capturedAt: string;
  content: Content;
}

export interface CapturedProjectionInput<Content = ProjectionInputContent> {
  input: FixedProjectionInput<Content>;
  /** Canonical JSON of the envelope; these exact bytes are stored. */
  bytes: string;
  /** sha256 of the canonical JSON of `input.content`. */
  digest: string;
}

export interface ProjectionInputRecordRow {
  input_digest: string;
  job_id: string;
  source_revision: number;
  visibility_revision: number;
  core_epoch: string;
  contract_version: string;
  storage_ref: string;
  byte_size: number;
  created_at: string;
}

/** The object store the input lives in; see `projectionInputBucket`. */
export interface ProjectionInputStore {
  put(key: string, value: string): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
}

export function inputStorageRef(digest: string): string {
  return `${PROJECTION_INPUT_PREFIX}/${digest}`;
}
export function inputObjectKey(digest: string): string {
  return `${inputStorageRef(digest)}/input.json`;
}

/**
 * Canonical bytes of the envelope, and the digest of the content it carries.
 *
 * The content type is a parameter because the balance build is not the only
 * fixed input: U16 captures the reward rules, claims and the evaluation instant
 * through the same protocol, the same DATA prefix and the same CORE record, and
 * the only thing that differs is what `content` holds.
 */
export async function captureDigest<Content>(
  input: FixedProjectionInput<Content>,
): Promise<CapturedProjectionInput<Content>> {
  return {
    input,
    bytes: canonicalJson(input),
    digest: await sha256Hex(canonicalJson(input.content)),
  };
}

export function fixedInput(
  parts: Omit<FixedProjectionInput, "contractVersion">,
): FixedProjectionInput {
  return { contractVersion: PROJECTION_INPUT_CONTRACT_VERSION, ...parts };
}

/**
 * Write the input before the build exists. A crash after this put leaves an
 * unreferenced object, which the retention sweep can collect; a crash the
 * other way round would leave a build whose input cannot be read.
 */
export async function storeProjectionInput<Content>(
  store: ProjectionInputStore,
  captured: CapturedProjectionInput<Content>,
): Promise<void> {
  await store.put(inputObjectKey(captured.digest), captured.bytes);
}

/**
 * Read the input a record names and prove it is that input: its content must
 * hash to the recorded digest, and the envelope's revision and epoch must be
 * the ones the record pinned. A resumed build that cannot prove this refuses
 * rather than continuing from something else.
 */
export async function loadProjectionInput<Content = ProjectionInputContent>(
  store: ProjectionInputStore,
  record: ProjectionInputRecordRow,
): Promise<FixedProjectionInput<Content> | null> {
  const object = await store.get(inputObjectKey(record.input_digest));
  if (!object) return null;
  const input = JSON.parse(await object.text()) as FixedProjectionInput<Content>;
  if ((await sha256Hex(canonicalJson(input.content))) !== record.input_digest) return null;
  if (
    input.contractVersion !== record.contract_version ||
    input.sourceRevision !== record.source_revision ||
    input.visibilityRevision !== record.visibility_revision ||
    input.coreEpoch !== record.core_epoch
  )
    return null;
  return input;
}

/**
 * The record of one input, by its content digest, or null when it was never
 * captured. A build finds its record through its snapshot's `input_digest`:
 * the record is per input, and the same input builds a different snapshot
 * after a deploy that changes the build digest.
 */
export async function readInputRecord(
  db: D1Like,
  inputDigest: string,
): Promise<ProjectionInputRecordRow | null> {
  return await db
    .prepare(
      `SELECT input_digest,job_id,source_revision,visibility_revision,core_epoch,
        contract_version,storage_ref,byte_size,created_at
       FROM projection_input_records WHERE input_digest=?1`,
    )
    .bind(inputDigest)
    .first<ProjectionInputRecordRow>();
}

/**
 * Re-store the bytes of an input whose record exists but whose object is gone
 * (a bucket restore, a sweep that ran too early). The content is the same by
 * digest, so it is written back under the envelope the record pinned — the
 * revision and epoch of the first capture — and a resumed build can prove it
 * again.
 */
export async function restoreProjectionInput<Content = ProjectionInputContent>(
  store: ProjectionInputStore,
  record: ProjectionInputRecordRow,
  content: Content,
  capturedAt: string,
): Promise<CapturedProjectionInput<Content>> {
  const captured = await captureDigest({
    contractVersion: record.contract_version,
    sourceRevision: record.source_revision,
    visibilityRevision: record.visibility_revision,
    coreEpoch: record.core_epoch,
    capturedAt,
    content,
  });
  if (captured.digest !== record.input_digest)
    throw new Error("projection input restore: content does not hash to the record");
  await storeProjectionInput(store, captured);
  return captured;
}

/** The statement that records one captured input; append-only by trigger. */
export function insertInputRecord<Content>(
  db: D1Like,
  captured: CapturedProjectionInput<Content>,
  jobId: string,
  now: string,
): D1StatementLike {
  return db
    .prepare(
      `INSERT INTO projection_input_records(input_digest,job_id,source_revision,
        visibility_revision,core_epoch,contract_version,storage_ref,byte_size,created_at)
       VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)`,
    )
    .bind(
      captured.digest,
      jobId,
      captured.input.sourceRevision,
      captured.input.visibilityRevision,
      captured.input.coreEpoch,
      captured.input.contractVersion,
      inputStorageRef(captured.digest),
      new TextEncoder().encode(captured.bytes).length,
      now,
    );
}
