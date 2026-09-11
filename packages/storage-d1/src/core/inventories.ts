// Inventories, seals and ingestion attempts (migration 0001): the record that
// a run declared exactly these artifacts and that the declaration was closed.
// The completeness claim is what later readers rely on, so nothing here
// rewrites an inventory or a seal — a second, different declaration is a
// conflict, never an update.
//
// Extracted from `services/raw-evidence/src/store.ts` by U05; SQL unchanged.
import type { D1Like, Row } from "../d1.ts";

export async function insertInventoryIfAbsent(
  db: D1Like,
  runId: number,
  inventorySha256: string,
  expectedArtifactCount: number,
  declarationBasis: string,
  now: number,
  clientId: string,
): Promise<void> {
  await db
    .prepare(
      `
    INSERT INTO run_inventories (
      fetch_run_id, inventory_sha256, expected_artifact_count,
      inventory_digest_version, declaration_basis, created_at_ms, created_by_client_id
    ) SELECT ?, ?, ?, 'v1', ?, ?, ? WHERE NOT EXISTS (
      SELECT 1 FROM run_inventories WHERE fetch_run_id = ? AND inventory_sha256 = ?
    )
  `,
    )
    .bind(
      runId,
      inventorySha256,
      expectedArtifactCount,
      declarationBasis,
      now,
      clientId,
      runId,
      inventorySha256,
    )
    .run();
}

export async function readInventoryByDigest(
  db: D1Like,
  runId: number,
  inventorySha256: string,
): Promise<Row | null> {
  return await db
    .prepare(
      `
    SELECT id, expected_artifact_count, inventory_digest_version,
           declaration_basis, created_by_client_id
    FROM run_inventories WHERE fetch_run_id = ? AND inventory_sha256 = ?
  `,
    )
    .bind(runId, inventorySha256)
    .first<Row>();
}

/** Whether the inventory id belongs to the run the request names. */
export async function inventoryBelongsToRun(
  db: D1Like,
  inventoryId: number,
  runId: number,
): Promise<boolean> {
  const inventory = await db
    .prepare(
      `
    SELECT 1 AS ok FROM run_inventories WHERE id = ? AND fetch_run_id = ?
  `,
    )
    .bind(inventoryId, runId)
    .first<{ ok: number }>();
  return inventory !== null;
}

export async function readInventoryDeclaration(
  db: D1Like,
  inventoryId: number,
  runId: number,
): Promise<{ inventory_sha256: string; expected_artifact_count: number } | null> {
  return await db
    .prepare(
      `
    SELECT inventory_sha256, expected_artifact_count FROM run_inventories
    WHERE id = ? AND fetch_run_id = ?
  `,
    )
    .bind(inventoryId, runId)
    .first<{ inventory_sha256: string; expected_artifact_count: number }>();
}

export async function readInventoryItem(
  db: D1Like,
  inventoryId: number,
  artifactKey: string,
): Promise<Row | null> {
  return await db
    .prepare(
      `
      SELECT sha256, descriptor_sha256 FROM run_inventory_items
      WHERE inventory_id = ? AND artifact_key = ?
    `,
    )
    .bind(inventoryId, artifactKey)
    .first<Row>();
}

export async function readInventoryItems(
  db: D1Like,
  inventoryId: number,
): Promise<{ artifact_key: string; sha256: string; descriptor_sha256: string }[]> {
  const items = await db
    .prepare(
      `
    SELECT artifact_key, sha256, descriptor_sha256 FROM run_inventory_items
    WHERE inventory_id = ? ORDER BY artifact_key COLLATE BINARY
  `,
    )
    .bind(inventoryId)
    .all<{ artifact_key: string; sha256: string; descriptor_sha256: string }>();
  return items.results;
}

/** How many items the inventory declared and how many it already holds. */
export async function readInventoryCapacity(
  db: D1Like,
  inventoryId: number,
): Promise<{ expected: number; received: number } | null> {
  return await db
    .prepare(
      `
    SELECT inventory.expected_artifact_count AS expected,
           count(item.artifact_key) AS received
    FROM run_inventories AS inventory
    LEFT JOIN run_inventory_items AS item ON item.inventory_id = inventory.id
    WHERE inventory.id = ? GROUP BY inventory.id
  `,
    )
    .bind(inventoryId)
    .first<{ expected: number; received: number }>();
}

export async function readInventoryStatus(
  db: D1Like,
  runId: number,
  inventoryId: number,
): Promise<{
  expected_artifact_count: number;
  received_artifact_count: number;
  sealed: number;
} | null> {
  return await db
    .prepare(
      `
    SELECT inventory.expected_artifact_count AS expected_artifact_count,
           count(item.artifact_key) AS received_artifact_count,
           CASE WHEN seal.inventory_id IS NULL THEN 0 ELSE 1 END AS sealed
    FROM run_inventories AS inventory
    LEFT JOIN run_inventory_items AS item ON item.inventory_id = inventory.id
    LEFT JOIN fetch_run_seals AS seal ON seal.inventory_id = inventory.id
    WHERE inventory.id = ? AND inventory.fetch_run_id = ?
    GROUP BY inventory.id, seal.inventory_id
  `,
    )
    .bind(inventoryId, runId)
    .first<{
      expected_artifact_count: number;
      received_artifact_count: number;
      sealed: number;
    }>();
}

/** Whether the run is already sealed; after that no item may be added. */
export async function runSealed(db: D1Like, runId: number): Promise<boolean> {
  const sealed = await db
    .prepare("SELECT 1 AS ok FROM fetch_run_seals WHERE fetch_run_id = ?")
    .bind(runId)
    .first<{ ok: number }>();
  return sealed !== null;
}

export async function readSeal(db: D1Like, runId: number): Promise<Row | null> {
  return await db
    .prepare("SELECT inventory_id, sealed_by_client_id FROM fetch_run_seals WHERE fetch_run_id = ?")
    .bind(runId)
    .first<Row>();
}

export async function readSealInventoryId(
  db: D1Like,
  runId: number,
): Promise<{ inventory_id: number } | null> {
  return await db
    .prepare("SELECT inventory_id FROM fetch_run_seals WHERE fetch_run_id = ?")
    .bind(runId)
    .first<{ inventory_id: number }>();
}

/** Every column the attempt read-back compares. */
const ATTEMPT_COLUMNS = `id, producer_id, source_id, started_at_ms, expected_artifact_count,
           observed_artifact_count, accepted_artifact_count, reused_artifact_count,
           rejected_artifact_count, sealed_inventory_id, outcome, error_code`;

export async function readAttempt(
  db: D1Like,
  runId: number,
  clientId: string,
  externalAttemptId: string,
): Promise<Row | null> {
  return await db
    .prepare(
      `
    SELECT ${ATTEMPT_COLUMNS}
    FROM ingestion_attempts
    WHERE fetch_run_id = ? AND ingest_client_id = ? AND external_attempt_id = ?
  `,
    )
    .bind(runId, clientId, externalAttemptId)
    .first<Row>();
}

/** Completed attempts recorded before this one; the first one accepted the
 * artifacts and every later one only reused them. */
export async function countEarlierCompleteAttempts(
  db: D1Like,
  runId: number,
  attemptId: unknown,
): Promise<{ count: number } | null> {
  return await db
    .prepare(
      `
    SELECT count(*) AS count FROM ingestion_attempts
    WHERE fetch_run_id = ? AND outcome = 'complete' AND id < ?
  `,
    )
    .bind(runId, attemptId)
    .first<{ count: number }>();
}

export interface FailedAttemptFields {
  ingest_client_version: string | null;
  external_attempt_id: string;
  started_at_ms: number | null;
  completed_at_ms: number | null;
  expected_artifact_count: number | null;
  observed_artifact_count: number | null;
  accepted_artifact_count: number | null;
  reused_artifact_count: number | null;
  rejected_artifact_count: number | null;
  outcome: string;
  error_code: string | null;
}

/** A failed or partial attempt: no seal, no inventory, recorded once. */
export async function insertFailedAttemptIfAbsent(
  db: D1Like,
  runId: number,
  producerId: string,
  sourceId: string,
  clientId: string,
  fields: FailedAttemptFields,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `
    INSERT INTO ingestion_attempts (
      fetch_run_id, producer_id, source_id, ingest_client_id, ingest_client_version,
      external_attempt_id, started_at_ms, completed_at_ms, expected_artifact_count,
      observed_artifact_count, accepted_artifact_count, reused_artifact_count,
      rejected_artifact_count, sealed_inventory_id, outcome, error_code, recorded_at_ms
    ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM ingestion_attempts
      WHERE fetch_run_id = ? AND ingest_client_id = ? AND external_attempt_id = ?
    )
  `,
    )
    .bind(
      runId,
      producerId,
      sourceId,
      clientId,
      fields.ingest_client_version,
      fields.external_attempt_id,
      fields.started_at_ms,
      fields.completed_at_ms,
      fields.expected_artifact_count,
      fields.observed_artifact_count,
      fields.accepted_artifact_count,
      fields.reused_artifact_count,
      fields.rejected_artifact_count,
      fields.outcome,
      fields.error_code,
      now,
      runId,
      clientId,
      fields.external_attempt_id,
    )
    .run();
}

export async function readFailedAttempt(
  db: D1Like,
  runId: number,
  clientId: string,
  externalAttemptId: string,
): Promise<Row | null> {
  return await db
    .prepare(
      `
    SELECT id, ingest_client_version, external_attempt_id, started_at_ms, completed_at_ms,
           expected_artifact_count, observed_artifact_count, accepted_artifact_count,
           reused_artifact_count, rejected_artifact_count, outcome, error_code
    FROM ingestion_attempts
    WHERE fetch_run_id = ? AND ingest_client_id = ? AND external_attempt_id = ?
  `,
    )
    .bind(runId, clientId, externalAttemptId)
    .first<Row>();
}

/** One inventory item, inserted directly when the inventory is staged. */
export function inventoryItemInsertSql(): string {
  return `
    INSERT INTO run_inventory_items (
      inventory_id, fetch_run_id, artifact_key, sha256, descriptor_sha256
    ) VALUES (?, ?, ?, ?, ?)
  `;
}
