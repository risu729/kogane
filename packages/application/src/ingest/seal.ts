// Sealing a run, and recording an attempt that did not get that far.
//
// A seal is the completeness claim every later reader depends on, so it is
// written as one guarded batch (`packages/storage-d1/src/atomic/seal.ts`) and
// then read back: inventory, seal and ingestion attempt must all say what this
// request meant, or the whole thing is a conflict. Nothing here updates a seal
// that already exists.
//
// Extracted from `services/raw-evidence/src/store.ts` by U05.
import { canonicalJsonV1, type JsonValue } from "../../../evidence-contract/src/json.ts";
import { sha256Hex } from "../../../evidence-contract/src/digest.ts";
import {
  parseRecordAttemptRequest,
  parseSealRunRequest,
  parseSealStagedInventoryRequest,
} from "../../../evidence-contract/src/requests.ts";
import { readRunCatalogue } from "../../../storage-d1/src/core/artifacts.ts";
import {
  countEarlierCompleteAttempts,
  insertFailedAttemptIfAbsent,
  readAttempt,
  readFailedAttempt,
  readInventoryByDigest,
  readInventoryDeclaration,
  readInventoryItems,
  readSeal,
  readSealInventoryId,
  type FailedAttemptFields,
} from "../../../storage-d1/src/core/inventories.ts";
import {
  sealRunStatements,
  sealStagedInventoryStatements,
} from "../../../storage-d1/src/atomic/seal.ts";
import { runBatch } from "../../../storage-d1/src/d1.ts";
import { loadRun } from "./access.ts";
import { assertSame, IngestError, type IngestEnv, type RecordValue } from "./contract.ts";

export interface SealedRun {
  runId: number;
  inventoryId: number;
  inventorySha256: string;
  sealed: true;
}

/**
 * The direct seal: the client declares the whole inventory in one request.
 * Its declaration is compared with the catalogue the server actually holds,
 * in the catalogue's own order, before anything is written.
 */
export async function sealRun(
  env: IngestEnv,
  clientId: string,
  runId: number,
  body: RecordValue,
): Promise<SealedRun> {
  const run = await loadRun(env, clientId, runId);
  const {
    artifacts: submitted,
    declarationBasis,
    externalAttemptId,
    startedAtMs,
  } = parseSealRunRequest(body);
  // Client-declared descriptor hashes are compared against the catalogue's
  // own recomputed values; any difference is an inventory_mismatch conflict.
  const actual = await readRunCatalogue(env.DB, runId);
  if (
    actual.length !== submitted.length ||
    actual.some(
      (row, index) =>
        row.artifact_key !== submitted[index]!.artifactKey ||
        row.sha256 !== submitted[index]!.sha256 ||
        row.descriptor_sha256 !== submitted[index]!.descriptorSha256,
    )
  ) {
    throw new IngestError(409, "inventory_mismatch");
  }
  const inventorySha256 = await sha256Hex(canonicalJsonV1(submitted as unknown as JsonValue));
  const now = Date.now();

  const expectedInventory = {
    expected_artifact_count: submitted.length,
    inventory_digest_version: "v1",
    declaration_basis: declarationBasis,
    created_by_client_id: clientId,
  };
  const priorInventory = await readInventoryByDigest(env.DB, runId, inventorySha256);
  if (priorInventory) assertSame(priorInventory, expectedInventory, "inventory_conflict");
  const priorSeal = await readSeal(env.DB, runId);
  if (priorSeal && priorInventory && priorSeal.inventory_id !== priorInventory.id) {
    throw new IngestError(409, "seal_conflict");
  }
  const expectedAttempt = {
    producer_id: run.producer_id,
    source_id: run.source_id,
    started_at_ms: startedAtMs,
    expected_artifact_count: submitted.length,
    observed_artifact_count: submitted.length,
    rejected_artifact_count: 0,
    outcome: "complete",
    error_code: null,
  };
  const priorAttempt = await readAttempt(env.DB, runId, clientId, externalAttemptId);
  if (priorAttempt) {
    if (!priorInventory) throw new IngestError(409, "inventory_conflict");
    await assertCompleteAttempt(
      env,
      runId,
      priorAttempt,
      {
        ...expectedAttempt,
        sealed_inventory_id: priorInventory.id,
      },
      submitted.length,
    );
    if (
      !priorSeal ||
      priorSeal.inventory_id !== priorInventory.id ||
      priorSeal.sealed_by_client_id !== clientId
    ) {
      throw new IngestError(409, "seal_conflict");
    }
    return {
      runId,
      inventoryId: priorInventory.id as number,
      inventorySha256,
      sealed: true,
    };
  }

  const statements = sealRunStatements(env.DB, {
    runId,
    inventorySha256,
    expectedArtifactCount: submitted.length,
    declarationBasis,
    clientId,
    submitted,
    producerId: run.producer_id,
    sourceId: run.source_id,
    externalAttemptId,
    startedAtMs,
    now,
  });
  try {
    await runBatch(env.DB, statements);
  } catch (originalError) {
    try {
      const racedInventory = await readInventoryByDigest(env.DB, runId, inventorySha256);
      const racedSeal = await readSeal(env.DB, runId);
      const racedAttempt = await readAttempt(env.DB, runId, clientId, externalAttemptId);
      if (!racedInventory || !racedSeal || !racedAttempt) throw originalError;
      assertSame(racedInventory, expectedInventory, "inventory_conflict");
      assertSame(
        racedSeal,
        {
          inventory_id: racedInventory.id,
          sealed_by_client_id: clientId,
        },
        "seal_conflict",
      );
      await assertCompleteAttempt(
        env,
        runId,
        racedAttempt,
        {
          ...expectedAttempt,
          sealed_inventory_id: racedInventory.id,
        },
        submitted.length,
      );
      return {
        runId,
        inventoryId: racedInventory.id as number,
        inventorySha256,
        sealed: true,
      };
    } catch (reconciliationError) {
      if (reconciliationError instanceof IngestError && reconciliationError.status === 409) {
        throw reconciliationError;
      }
      throw originalError;
    }
  }

  const inventory = await readInventoryByDigest(env.DB, runId, inventorySha256);
  assertSame(inventory, expectedInventory, "inventory_conflict");
  const inventoryId = inventory!.id as number;
  const seal = await readSeal(env.DB, runId);
  assertSame(seal, { inventory_id: inventoryId, sealed_by_client_id: clientId }, "seal_conflict");
  const attempt = await readAttempt(env.DB, runId, clientId, externalAttemptId);
  await assertCompleteAttempt(
    env,
    runId,
    attempt,
    {
      ...expectedAttempt,
      sealed_inventory_id: inventoryId,
    },
    submitted.length,
  );
  return { runId, inventoryId, inventorySha256, sealed: true };
}

/**
 * The attempt row must say what this request meant, and its accepted/reused
 * split must match the history: the first completed attempt accepted the
 * artifacts, every later one only reused them.
 */
async function assertCompleteAttempt(
  env: IngestEnv,
  runId: number,
  attempt: RecordValue | null,
  expected: RecordValue,
  artifactCount: number,
): Promise<void> {
  assertSame(attempt, expected, "ingestion_attempt_conflict");
  const earlier = await countEarlierCompleteAttempts(env.DB, runId, attempt!.id);
  const reused = (earlier?.count ?? 0) > 0;
  assertSame(
    attempt,
    {
      accepted_artifact_count: reused ? 0 : artifactCount,
      reused_artifact_count: reused ? artifactCount : 0,
    },
    "ingestion_attempt_conflict",
  );
}

/**
 * The staged seal: the inventory was begun and filled earlier. Its items are
 * re-hashed here and compared with the digest the inventory was created with,
 * so a seal cannot close a declaration that changed underneath it.
 */
export async function sealStagedInventory(
  env: IngestEnv,
  clientId: string,
  runId: number,
  inventoryId: number,
  body: RecordValue,
): Promise<SealedRun> {
  const run = await loadRun(env, clientId, runId);
  const { externalAttemptId, startedAtMs } = parseSealStagedInventoryRequest(body);
  const inventory = await readInventoryDeclaration(env.DB, inventoryId, runId);
  if (!inventory) throw new IngestError(404, "inventory_not_found");
  const items = await readInventoryItems(env.DB, inventoryId);
  if (items.length !== inventory.expected_artifact_count) {
    throw new IngestError(409, "inventory_incomplete");
  }
  const canonicalItems = items.map((item) => ({
    artifactKey: item.artifact_key,
    sha256: item.sha256,
    descriptorSha256: item.descriptor_sha256,
  }));
  if (
    (await sha256Hex(canonicalJsonV1(canonicalItems as unknown as JsonValue))) !==
    inventory.inventory_sha256
  ) {
    throw new IngestError(409, "inventory_digest_mismatch");
  }
  const expectedAttempt = {
    producer_id: run.producer_id,
    source_id: run.source_id,
    started_at_ms: startedAtMs,
    expected_artifact_count: inventory.expected_artifact_count,
    observed_artifact_count: inventory.expected_artifact_count,
    rejected_artifact_count: 0,
    sealed_inventory_id: inventoryId,
    outcome: "complete",
    error_code: null,
  };
  const priorAttempt = await readAttempt(env.DB, runId, clientId, externalAttemptId);
  if (priorAttempt) {
    await assertCompleteAttempt(
      env,
      runId,
      priorAttempt,
      expectedAttempt,
      inventory.expected_artifact_count,
    );
    return { runId, inventoryId, inventorySha256: inventory.inventory_sha256, sealed: true };
  }
  const now = Date.now();
  const statements = sealStagedInventoryStatements(env.DB, {
    runId,
    inventoryId,
    producerId: run.producer_id,
    sourceId: run.source_id,
    clientId,
    externalAttemptId,
    startedAtMs,
    expectedArtifactCount: inventory.expected_artifact_count,
    now,
  });
  try {
    await runBatch(env.DB, statements);
  } catch (originalError) {
    try {
      const finalSeal = await readSealInventoryId(env.DB, runId);
      const finalAttempt = await readAttempt(env.DB, runId, clientId, externalAttemptId);
      if (!finalSeal || !finalAttempt) throw originalError;
      if (finalSeal.inventory_id !== inventoryId) throw new IngestError(409, "seal_conflict");
      await assertCompleteAttempt(
        env,
        runId,
        finalAttempt,
        expectedAttempt,
        inventory.expected_artifact_count,
      );
    } catch (reconciliationError) {
      if (reconciliationError instanceof IngestError && reconciliationError.status === 409) {
        throw reconciliationError;
      }
      throw originalError;
    }
  }
  return { runId, inventoryId, inventorySha256: inventory.inventory_sha256, sealed: true };
}

/** An attempt that did not seal: recorded once, with no inventory and no seal. */
export async function addFailedAttempt(
  env: IngestEnv,
  clientId: string,
  runId: number,
  body: RecordValue,
): Promise<{ attemptId: number; outcome: string }> {
  const run = await loadRun(env, clientId, runId);
  const attemptRequest = parseRecordAttemptRequest(body);
  const fields: FailedAttemptFields = {
    ingest_client_version: attemptRequest.ingestClientVersion,
    external_attempt_id: attemptRequest.externalAttemptId,
    started_at_ms: attemptRequest.startedAtMs,
    completed_at_ms: attemptRequest.completedAtMs,
    expected_artifact_count: attemptRequest.expectedArtifactCount,
    observed_artifact_count: attemptRequest.observedArtifactCount,
    accepted_artifact_count: attemptRequest.acceptedArtifactCount,
    reused_artifact_count: attemptRequest.reusedArtifactCount,
    rejected_artifact_count: attemptRequest.rejectedArtifactCount,
    outcome: attemptRequest.outcome,
    error_code: attemptRequest.errorCode,
  };
  const now = Date.now();
  await insertFailedAttemptIfAbsent(
    env.DB,
    runId,
    run.producer_id,
    run.source_id,
    clientId,
    fields,
    now,
  );
  const attempt = await readFailedAttempt(
    env.DB,
    runId,
    clientId,
    fields.external_attempt_id,
  );
  assertSame(attempt, { ...fields }, "ingestion_attempt_conflict");
  return { attemptId: attempt!.id as number, outcome: fields.outcome };
}
