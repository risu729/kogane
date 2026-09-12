// In-process registration operations used by the Processor to register shared runs.
// The application layer owns validation, authorization and idempotency.
import type {
  AddPageGroupRequest,
  AddRunRangeRequest,
  AddRunReportRequest,
  AddUnitReportRequest,
  AddUnitRequest,
  ArtifactRequest,
  CreateRunRequest,
  DeclarationBasis,
  InventoryItem,
  RecordAttemptRequest,
} from "../../../evidence-contract/src/index.ts";
import { requireActiveClient } from "./access.ts";
import { addArtifact } from "./catalogue.ts";
import type { IngestEnv, RecordValue } from "./contract.ts";
import { addInventoryItems, beginInventory } from "./inventory.ts";
import { adoptStoredObject, putObject } from "./objects.ts";
import { addRunReport, createRun } from "./registration.ts";
import { addFailedAttempt, sealRun, sealStagedInventory } from "./seal.ts";
import { addPageGroup, addRunRange, addUnit, addUnitReport } from "./structure.ts";

export interface RunRegistrationPort {
  createRun(input: CreateRunRequest): Promise<number>;
  addUnit(runId: number, input: AddUnitRequest): Promise<number>;
  addRunRange(runId: number, input: AddRunRangeRequest): Promise<void>;
  addPageGroup(runId: number, input: AddPageGroupRequest): Promise<number>;
  addUnitReport(unitId: number, input: AddUnitReportRequest): Promise<void>;
  /** True when the bytes were already stored. */
  uploadObject(runId: number, sha256: string, bytes: Uint8Array): Promise<boolean>;
  /**
   * Registers bytes that are already in the object store, without sending or
   * writing any. A shared-R2 run takes this path, so registering it never
   * copies an object (U08, acceptance G1-15).
   */
  adoptObject?(runId: number, sha256: string, byteSize: number): Promise<void>;
  /** The descriptor digest the server computed; never the client's own. */
  addArtifact(runId: number, input: ArtifactRequest): Promise<string>;
  beginInventory(
    runId: number,
    inventorySha256: string,
    expectedArtifactCount: number,
  ): Promise<number>;
  addInventoryItems(runId: number, inventoryId: number, items: InventoryItem[]): Promise<void>;
  sealStagedInventory(
    runId: number,
    inventoryId: number,
    externalAttemptId: string,
    startedAtMs: number,
  ): Promise<void>;
  addRunReport(runId: number, input: AddRunReportRequest): Promise<void>;
  seal(
    runId: number,
    artifacts: InventoryItem[],
    externalAttemptId: string,
    startedAtMs: number,
    declarationBasis?: DeclarationBasis,
  ): Promise<void>;
  recordAttempt(runId: number, input: RecordAttemptRequest): Promise<void>;
}

/** Requests are plain JSON objects on the wire; in-process they are the same
 * objects, and the same contract parsers validate them either way. */
function body(input: object): RecordValue {
  return input as RecordValue;
}

/**
 * Registration straight into CORE, through the guarded application use cases.
 */
export function directRegistrationPort(env: IngestEnv, clientId: string): RunRegistrationPort {
  return activeClientOnly(env, clientId, {
    async createRun(input) {
      return (await createRun(env, clientId, body(input))).runId;
    },
    async addUnit(runId, input) {
      return (await addUnit(env, clientId, runId, body(input))).unitId;
    },
    async addRunRange(runId, input) {
      await addRunRange(env, clientId, runId, body(input));
    },
    async addPageGroup(runId, input) {
      return (await addPageGroup(env, clientId, runId, body(input))).pageGroupId;
    },
    async addUnitReport(unitId, input) {
      await addUnitReport(env, clientId, unitId, body(input));
    },
    async uploadObject(runId, sha256, bytes) {
      const stored = await putObject(env, clientId, runId, sha256, {
        declaredByteSize: String(bytes.byteLength),
        transportByteSize: String(bytes.byteLength),
        body: bytes,
      });
      return stored.reused;
    },
    async adoptObject(runId, sha256, byteSize) {
      await adoptStoredObject(env, clientId, runId, sha256, byteSize);
    },
    async addArtifact(runId, input) {
      return (await addArtifact(env, clientId, runId, body(input))).descriptorSha256;
    },
    async beginInventory(runId, inventorySha256, expectedArtifactCount) {
      const inventory = await beginInventory(env, clientId, runId, {
        inventorySha256,
        expectedArtifactCount,
        declarationBasis: "producer_manifest",
      });
      return inventory.inventoryId;
    },
    async addInventoryItems(runId, inventoryId, items) {
      await addInventoryItems(env, clientId, runId, inventoryId, { items });
    },
    async sealStagedInventory(runId, inventoryId, externalAttemptId, startedAtMs) {
      await sealStagedInventory(env, clientId, runId, inventoryId, {
        externalAttemptId,
        startedAtMs,
      });
    },
    async addRunReport(runId, input) {
      await addRunReport(env, clientId, runId, body(input));
    },
    async seal(runId, artifacts, externalAttemptId, startedAtMs, declarationBasis) {
      await sealRun(env, clientId, runId, {
        artifacts,
        declarationBasis: declarationBasis ?? "producer_manifest",
        externalAttemptId,
        startedAtMs,
      });
    },
    async recordAttempt(runId, input) {
      await addFailedAttempt(env, clientId, runId, body(input));
    },
  });
}

/**
 * The HTTP adapter refuses a deactivated client before it looks at the route
 * (`inactive_ingest_client`, not `inactive_ingest_route`). The port makes the
 * same check before every operation, so the two paths answer a revoked client
 * with the same code — and so a route row that outlives its client can never
 * be reached through the port, because `active_ingest_routes` joins on the
 * client's `active` flag as well.
 */
function activeClientOnly(
  env: IngestEnv,
  clientId: string,
  port: RunRegistrationPort,
): RunRegistrationPort {
  const guarded = {} as Record<keyof RunRegistrationPort, unknown>;
  for (const key of Object.keys(port) as (keyof RunRegistrationPort)[]) {
    const operation = port[key] as (...args: unknown[]) => Promise<unknown>;
    guarded[key] = async (...args: unknown[]) => {
      await requireActiveClient(env, clientId);
      return operation(...args);
    };
  }
  return guarded as unknown as RunRegistrationPort;
}
