// Staged inventories: declare how many artifacts a run will have, add the
// items as they are catalogued, then seal.
//
// The declared digest of each item is compared against the value the server
// computed when it catalogued the artifact, so an inventory cannot claim
// bytes or a descriptor the catalogue never saw. Overflow, a sealed run and a
// disagreeing repeat are all refused; none of them rewrites an item.
//
// Extracted from `services/raw-evidence/src/store.ts` by U05.
import {
  parseAddInventoryItemsRequest,
  parseBeginInventoryRequest,
  type InventoryItem,
} from "../../../evidence-contract/src/requests.ts";
import { readArtifactDigests } from "../../../storage-d1/src/core/artifacts.ts";
import {
  insertInventoryIfAbsent,
  inventoryBelongsToRun,
  readInventoryByDigest,
  readInventoryCapacity,
  readInventoryItem,
  readInventoryStatus,
  runSealed,
} from "../../../storage-d1/src/core/inventories.ts";
import { inventoryItemStatements } from "../../../storage-d1/src/atomic/seal.ts";
import { runBatch } from "../../../storage-d1/src/d1.ts";
import { loadRun } from "./access.ts";
import { assertSame, IngestError, type IngestEnv, type RecordValue } from "./contract.ts";

export interface InventoryStatus {
  expectedArtifactCount: number;
  receivedArtifactCount: number;
  sealed: boolean;
}

export async function beginInventory(
  env: IngestEnv,
  clientId: string,
  runId: number,
  body: RecordValue,
): Promise<{ inventoryId: number; inventorySha256: string; expectedArtifactCount: number }> {
  await loadRun(env, clientId, runId);
  const { inventorySha256, expectedArtifactCount, declarationBasis } =
    parseBeginInventoryRequest(body);
  const expected = {
    expected_artifact_count: expectedArtifactCount,
    inventory_digest_version: "v1",
    declaration_basis: declarationBasis,
    created_by_client_id: clientId,
  };
  const now = Date.now();
  await insertInventoryIfAbsent(
    env.DB,
    runId,
    inventorySha256,
    expectedArtifactCount,
    declarationBasis,
    now,
    clientId,
  );
  const inventory = await readInventoryByDigest(env.DB, runId, inventorySha256);
  assertSame(inventory, expected, "inventory_conflict");
  return { inventoryId: inventory!.id as number, inventorySha256, expectedArtifactCount };
}

export async function addInventoryItems(
  env: IngestEnv,
  clientId: string,
  runId: number,
  inventoryId: number,
  body: RecordValue,
): Promise<{ inventoryId: number; accepted: number } & InventoryStatus> {
  await loadRun(env, clientId, runId);
  const { items } = parseAddInventoryItemsRequest(body);
  if (!(await inventoryBelongsToRun(env.DB, inventoryId, runId)))
    throw new IngestError(404, "inventory_not_found");
  const newItems: InventoryItem[] = [];
  for (const item of items) {
    // The client-declared descriptorSha256 must equal the value this server
    // computed when the artifact was catalogued; it is never taken on trust.
    const artifact = await readArtifactDigests(env.DB, runId, item.artifactKey);
    assertSame(
      artifact,
      {
        sha256: item.sha256,
        descriptor_sha256: item.descriptorSha256,
      },
      "inventory_artifact_conflict",
    );
    const existing = await readInventoryItem(env.DB, inventoryId, item.artifactKey);
    if (existing) {
      assertSame(
        existing,
        {
          sha256: item.sha256,
          descriptor_sha256: item.descriptorSha256,
        },
        "inventory_item_conflict",
      );
    } else {
      newItems.push(item);
    }
  }
  if ((await runSealed(env.DB, runId)) && newItems.length > 0)
    throw new IngestError(409, "run_already_sealed");
  const capacity = await readInventoryCapacity(env.DB, inventoryId);
  if (!capacity || capacity.received + newItems.length > capacity.expected) {
    throw new IngestError(409, "inventory_overflow");
  }
  const statements = inventoryItemStatements(env.DB, runId, inventoryId, newItems);
  let accepted = newItems.length;
  if (statements.length > 0) {
    try {
      await runBatch(env.DB, statements);
    } catch (originalError) {
      accepted = 0;
      try {
        for (const item of items) {
          const existing = await readInventoryItem(env.DB, inventoryId, item.artifactKey);
          if (!existing) throw originalError;
          if (
            existing.sha256 !== item.sha256 ||
            existing.descriptor_sha256 !== item.descriptorSha256
          ) {
            throw new IngestError(409, "inventory_item_conflict");
          }
        }
      } catch (reconciliationError) {
        if (reconciliationError instanceof IngestError && reconciliationError.status === 409) {
          throw reconciliationError;
        }
        throw originalError;
      }
    }
  }
  const status = await inventoryStatus(env, runId, inventoryId);
  return { inventoryId, accepted, ...status };
}

export async function getInventoryStatus(
  env: IngestEnv,
  clientId: string,
  runId: number,
  inventoryId: number,
): Promise<{ inventoryId: number } & InventoryStatus> {
  await loadRun(env, clientId, runId);
  return { inventoryId, ...(await inventoryStatus(env, runId, inventoryId)) };
}

async function inventoryStatus(
  env: IngestEnv,
  runId: number,
  inventoryId: number,
): Promise<InventoryStatus> {
  const row = await readInventoryStatus(env.DB, runId, inventoryId);
  if (!row) throw new IngestError(404, "inventory_not_found");
  return {
    expectedArtifactCount: row.expected_artifact_count,
    receivedArtifactCount: row.received_artifact_count,
    sealed: row.sealed === 1,
  };
}
