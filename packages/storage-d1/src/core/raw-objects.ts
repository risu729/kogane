// Raw objects and their verification events (migration 0001): the row that
// says "these bytes are in the object store under this key, at this size".
// The bytes themselves live in R2 and are the adapter's concern; this module
// only owns the CORE rows.
//
// Extracted from `services/raw-evidence/src/store.ts` by U05; SQL unchanged.
import type { D1Like, Row } from "../d1.ts";

export interface RawObjectRow {
  sha256: string;
  byte_size: number;
  blob_key: string;
}

/**
 * Records the object once. Conditional on its own absence, so two concurrent
 * uploads of the same bytes leave one row and the caller compares it with what
 * it expected rather than trusting the insert.
 */
export async function insertRawObjectIfAbsent(
  db: D1Like,
  sha256: string,
  byteSize: number,
  blobKey: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `
    INSERT INTO raw_objects (sha256, byte_size, blob_key, first_stored_at_ms)
    SELECT ?, ?, ?, ? WHERE NOT EXISTS (
      SELECT 1 FROM raw_objects WHERE sha256 = ?
    )
  `,
    )
    .bind(sha256, byteSize, blobKey, now, sha256)
    .run();
}

/** The recorded object, for the read-back comparison after an insert. */
export async function readRawObjectRecord(db: D1Like, sha256: string): Promise<Row | null> {
  return await db
    .prepare(
      `
    SELECT sha256, byte_size, blob_key FROM raw_objects WHERE sha256 = ?
  `,
    )
    .bind(sha256)
    .first<Row>();
}

/** Size and key of a stored object, or null when nothing was ever recorded. */
export async function readRawObjectLocation(
  db: D1Like,
  sha256: string,
): Promise<{ byte_size: number; blob_key: string } | null> {
  return await db
    .prepare(
      `
    SELECT byte_size, blob_key FROM raw_objects WHERE sha256 = ?
  `,
    )
    .bind(sha256)
    .first<{ byte_size: number; blob_key: string }>();
}

/** The declared size of an object, used when cataloguing an artifact. */
export async function readRawObjectSize(
  db: D1Like,
  sha256: string,
): Promise<{ byte_size: number } | null> {
  return await db
    .prepare("SELECT byte_size FROM raw_objects WHERE sha256 = ?")
    .bind(sha256)
    .first<{ byte_size: number }>();
}

/**
 * Whether this run's catalogue names the object. Verification is authorized by
 * the catalogue, not by knowing a hash: an unrelated run may not probe for the
 * existence of somebody else's bytes.
 */
export async function runCataloguesObject(
  db: D1Like,
  runId: number,
  sha256: string,
): Promise<boolean> {
  const authorized = await db
    .prepare(
      `
    SELECT 1 AS ok FROM fetch_artifacts WHERE fetch_run_id = ? AND sha256 = ? LIMIT 1
  `,
    )
    .bind(runId, sha256)
    .first<{ ok: number }>();
  return authorized !== null;
}

/** The most recent verification this client made inside the reuse window. */
export async function readRecentVerification(
  db: D1Like,
  sha256: string,
  clientId: string,
  since: number,
): Promise<{ id: number; result: string } | null> {
  return await db
    .prepare(
      `
    SELECT id, result FROM raw_object_verification_events
    WHERE sha256 = ? AND checked_by_client_id = ? AND checked_at_ms >= ?
    ORDER BY checked_at_ms DESC, id DESC LIMIT 1
  `,
    )
    .bind(sha256, clientId, since)
    .first<{ id: number; result: string }>();
}

export interface VerificationEvent {
  sha256: string;
  now: number;
  result: string;
  observedSize: number | null;
  observedSha256: string | null;
  detailCode: string | null;
  clientId: string;
}

/** Appends the verification outcome; the table is append-only by trigger. */
export async function insertVerificationEvent(
  db: D1Like,
  event: VerificationEvent,
): Promise<{ id: number } | null> {
  return await db
    .prepare(
      `
    INSERT INTO raw_object_verification_events (
      sha256, checked_at_ms, result, observed_size, observed_sha256,
      detail_code, checked_by_client_id, recorded_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `,
    )
    .bind(
      event.sha256,
      event.now,
      event.result,
      event.observedSize,
      event.observedSha256,
      event.detailCode,
      event.clientId,
      event.now,
    )
    .first<{ id: number }>();
}
