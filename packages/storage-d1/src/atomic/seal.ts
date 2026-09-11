// The run seal, as guarded batches (unified plan 09 §2).
//
// Sealing a run says three things at once: this inventory is the declaration,
// this run is closed against it, and this ingestion attempt completed. They
// must be one transaction, and every statement after the first re-states the
// inventory's identifying columns, so a batch whose first statement matched
// nothing writes neither seal nor attempt. D1 rolls a batch back on an SQL
// error, not because a conditional INSERT matched zero rows, which is exactly
// why each statement carries the condition rather than the batch.
//
// Two shapes, both already in production:
//
//   * `sealRunStatements` — the direct seal: the client declares the whole
//     inventory in one request, so the inventory, its items and the seal are
//     written together;
//   * `sealStagedInventoryStatements` — the staged seal: the inventory was
//     begun and filled earlier, so only the seal and the attempt are written.
//
// Extracted from `services/raw-evidence/src/store.ts` by U05; SQL unchanged.
import type { InventoryItem } from "../../../evidence-contract/src/requests.ts";
import type { D1Like, D1StatementLike } from "../d1.ts";

/** The identifying columns every later statement re-states. */
interface InventoryKey {
  runId: number;
  inventorySha256: string;
  expectedArtifactCount: number;
  declarationBasis: string;
  clientId: string;
}

export interface SealRunInput extends InventoryKey {
  submitted: readonly InventoryItem[];
  producerId: string;
  sourceId: string;
  externalAttemptId: string;
  startedAtMs: number | null;
  now: number;
}

/**
 * D1's runtime SQLite build accepts at most five terms in a compound SELECT,
 * so the VALUES-shaped UNION that carries the declared items is chunked.
 */
const ITEM_CHUNK = 5;

export function sealRunStatements(db: D1Like, input: SealRunInput): D1StatementLike[] {
  const { runId, inventorySha256, expectedArtifactCount, declarationBasis, clientId, now } = input;
  const statements: D1StatementLike[] = [
    db
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
      ),
  ];
  for (let offset = 0; offset < input.submitted.length; offset += ITEM_CHUNK) {
    const chunk = input.submitted.slice(offset, offset + ITEM_CHUNK);
    const rows = chunk
      .map(() => "SELECT ? AS artifact_key, ? AS sha256, ? AS descriptor_sha256")
      .join(" UNION ALL ");
    statements.push(
      db
        .prepare(
          `
      INSERT INTO run_inventory_items (
        inventory_id, fetch_run_id, artifact_key, sha256, descriptor_sha256
      )
      SELECT inventory.id, inventory.fetch_run_id,
             item.artifact_key, item.sha256, item.descriptor_sha256
      FROM run_inventories AS inventory
      JOIN (${rows}) AS item
      WHERE inventory.fetch_run_id = ? AND inventory.inventory_sha256 = ?
        AND inventory.expected_artifact_count = ?
        AND inventory.inventory_digest_version = 'v1'
        AND inventory.declaration_basis = ?
        AND inventory.created_by_client_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM run_inventory_items AS existing
          WHERE existing.inventory_id = inventory.id
            AND existing.artifact_key = item.artifact_key
        )
    `,
        )
        .bind(
          ...chunk.flatMap((item) => [item.artifactKey, item.sha256, item.descriptorSha256]),
          runId,
          inventorySha256,
          expectedArtifactCount,
          declarationBasis,
          clientId,
        ),
    );
  }
  statements.push(
    db
      .prepare(
        `
    INSERT INTO fetch_run_seals (
      inventory_id, fetch_run_id, sealed_at_ms, sealed_by_client_id
    ) SELECT inventory.id, inventory.fetch_run_id, ?, ?
      FROM run_inventories AS inventory
     WHERE inventory.fetch_run_id = ? AND inventory.inventory_sha256 = ?
       AND inventory.expected_artifact_count = ?
       AND inventory.inventory_digest_version = 'v1'
       AND inventory.declaration_basis = ?
       AND inventory.created_by_client_id = ?
       AND NOT EXISTS (SELECT 1 FROM fetch_run_seals WHERE fetch_run_id = ?)
  `,
      )
      .bind(
        now,
        clientId,
        runId,
        inventorySha256,
        expectedArtifactCount,
        declarationBasis,
        clientId,
        runId,
      ),
  );
  statements.push(
    db
      .prepare(
        `
    INSERT INTO ingestion_attempts (
      fetch_run_id, producer_id, source_id, ingest_client_id, external_attempt_id,
      started_at_ms, completed_at_ms, expected_artifact_count, observed_artifact_count,
      accepted_artifact_count, reused_artifact_count, rejected_artifact_count,
      sealed_inventory_id, outcome, error_code, recorded_at_ms
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?,
           CASE WHEN EXISTS (
             SELECT 1 FROM ingestion_attempts
             WHERE fetch_run_id = ? AND outcome = 'complete'
           ) THEN 0 ELSE ? END,
           CASE WHEN EXISTS (
             SELECT 1 FROM ingestion_attempts
             WHERE fetch_run_id = ? AND outcome = 'complete'
           ) THEN ? ELSE 0 END,
           0, inventory.id, 'complete', NULL, ?
      FROM run_inventories AS inventory
     WHERE inventory.fetch_run_id = ? AND inventory.inventory_sha256 = ?
       AND inventory.expected_artifact_count = ?
       AND inventory.inventory_digest_version = 'v1'
       AND inventory.declaration_basis = ?
       AND inventory.created_by_client_id = ?
  `,
      )
      .bind(
        runId,
        input.producerId,
        input.sourceId,
        clientId,
        input.externalAttemptId,
        input.startedAtMs,
        now,
        expectedArtifactCount,
        expectedArtifactCount,
        runId,
        expectedArtifactCount,
        runId,
        expectedArtifactCount,
        now,
        runId,
        inventorySha256,
        expectedArtifactCount,
        declarationBasis,
        clientId,
      ),
  );
  return statements;
}

export interface SealStagedInput {
  runId: number;
  inventoryId: number;
  producerId: string;
  sourceId: string;
  clientId: string;
  externalAttemptId: string;
  startedAtMs: number | null;
  expectedArtifactCount: number;
  now: number;
}

export function sealStagedInventoryStatements(
  db: D1Like,
  input: SealStagedInput,
): D1StatementLike[] {
  const { runId, inventoryId, clientId, expectedArtifactCount, now } = input;
  return [
    db
      .prepare(
        `
      INSERT INTO fetch_run_seals (
        inventory_id, fetch_run_id, sealed_at_ms, sealed_by_client_id
      ) SELECT ?, ?, ?, ? WHERE NOT EXISTS (
        SELECT 1 FROM fetch_run_seals WHERE fetch_run_id = ?
      )
    `,
      )
      .bind(inventoryId, runId, now, clientId, runId),
    db
      .prepare(
        `
      INSERT INTO ingestion_attempts (
        fetch_run_id, producer_id, source_id, ingest_client_id, external_attempt_id,
        started_at_ms, completed_at_ms, expected_artifact_count, observed_artifact_count,
        accepted_artifact_count, reused_artifact_count, rejected_artifact_count,
        sealed_inventory_id, outcome, error_code, recorded_at_ms
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?,
        CASE WHEN EXISTS (
          SELECT 1 FROM ingestion_attempts WHERE fetch_run_id = ? AND outcome = 'complete'
        ) THEN 0 ELSE ? END,
        CASE WHEN EXISTS (
          SELECT 1 FROM ingestion_attempts WHERE fetch_run_id = ? AND outcome = 'complete'
        ) THEN ? ELSE 0 END,
        0, ?, 'complete', NULL, ?
      )
    `,
      )
      .bind(
        runId,
        input.producerId,
        input.sourceId,
        clientId,
        input.externalAttemptId,
        input.startedAtMs,
        now,
        expectedArtifactCount,
        expectedArtifactCount,
        runId,
        expectedArtifactCount,
        runId,
        expectedArtifactCount,
        inventoryId,
        now,
      ),
  ];
}

/** The items of a direct seal, inserted one statement each when the inventory
 * was staged rather than declared in full. */
export function inventoryItemStatements(
  db: D1Like,
  runId: number,
  inventoryId: number,
  items: readonly InventoryItem[],
): D1StatementLike[] {
  return items.map((item) =>
    db
      .prepare(
        `
    INSERT INTO run_inventory_items (
      inventory_id, fetch_run_id, artifact_key, sha256, descriptor_sha256
    ) VALUES (?, ?, ?, ?, ?)
  `,
      )
      .bind(inventoryId, runId, item.artifactKey, item.sha256, item.descriptorSha256),
  );
}
