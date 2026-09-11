// The registration port U05 extracted (packages/application/src/ingest):
// this class is its HTTP implementation, and `directRegistrationPort` is
// the in-process one the Processor will use (U08). Declaring the interface
// here is what keeps the two from drifting apart while both exist.
import type { RunRegistrationPort } from "../../../packages/application/src/ingest/port.ts";
import {
  descriptorSha256V1,
  type AddPageGroupRequest,
  type AddRunRangeRequest,
  type AddRunReportRequest,
  type AddUnitReportRequest,
  type AddUnitRequest,
  type ArtifactRequest,
  type CreateRunRequest,
  type DeclarationBasis,
  type InventoryItem,
  type RecordAttemptRequest,
} from "../../../packages/evidence-contract/src/index";

type JsonObject = Record<string, unknown>;

export class CentralClient implements RunRegistrationPort {
  readonly #service: Fetcher;
  readonly #token: string;

  constructor(service: Fetcher, token: string, expectedClientId: string) {
    if (
      !/^[a-z0-9-]{1,100}$/u.test(expectedClientId) ||
      !token.startsWith(`${expectedClientId}.`) ||
      token.slice(expectedClientId.length + 1).length < 20 ||
      /\s/u.test(token)
    ) {
      throw new Error("central_auth_configuration_invalid");
    }
    this.#service = service;
    this.#token = token;
  }

  async createRun(input: CreateRunRequest): Promise<number> {
    const result = await this.json("/v1/runs", input);
    return requiredInteger(result.runId, "central_run_id_missing");
  }

  async addUnit(runId: number, input: AddUnitRequest): Promise<number> {
    const result = await this.json(`/v1/runs/${runId}/units`, input);
    return requiredInteger(result.unitId, "central_unit_id_missing");
  }

  async addRunRange(runId: number, input: AddRunRangeRequest): Promise<void> {
    await this.json(`/v1/runs/${runId}/ranges`, input);
  }

  async addPageGroup(runId: number, input: AddPageGroupRequest): Promise<number> {
    const result = await this.json(`/v1/runs/${runId}/page-groups`, input);
    return requiredInteger(result.pageGroupId, "central_page_group_id_missing");
  }

  async addUnitReport(unitId: number, input: AddUnitReportRequest): Promise<void> {
    await this.json(`/v1/units/${unitId}/reports`, input);
  }

  async uploadObject(runId: number, sha256: string, bytes: Uint8Array): Promise<boolean> {
    const response = await this.#service.fetch(
      new Request(`https://kogane-ingest.internal/v1/runs/${runId}/objects/${sha256}`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${this.#token}`,
          "x-kogane-byte-size": String(bytes.byteLength),
        },
        body: ownedArrayBuffer(bytes),
      }),
    );
    if (!response.ok) throw await centralError(response);
    return response.status === 200;
  }

  async addArtifact(runId: number, input: ArtifactRequest): Promise<string> {
    const result = await this.json(`/v1/runs/${runId}/artifacts`, input);
    return requiredSha256(result.descriptorSha256, "central_descriptor_missing");
  }

  async beginInventory(
    runId: number,
    inventorySha256: string,
    expectedArtifactCount: number,
  ): Promise<number> {
    const result = await this.json(`/v1/runs/${runId}/inventories`, {
      inventorySha256,
      expectedArtifactCount,
      declarationBasis: "producer_manifest",
    });
    return requiredInteger(result.inventoryId, "central_inventory_id_missing");
  }

  async addInventoryItems(
    runId: number,
    inventoryId: number,
    items: InventoryItem[],
  ): Promise<void> {
    await this.json(`/v1/runs/${runId}/inventories/${inventoryId}/items`, { items });
  }

  async sealStagedInventory(
    runId: number,
    inventoryId: number,
    externalAttemptId: string,
    startedAtMs: number,
  ): Promise<void> {
    const result = await this.json(`/v1/runs/${runId}/inventories/${inventoryId}/seal`, {
      externalAttemptId,
      startedAtMs,
    });
    if (result.sealed !== true) throw new Error("central_seal_missing");
  }

  async addRunReport(runId: number, input: AddRunReportRequest): Promise<void> {
    await this.json(`/v1/runs/${runId}/reports`, input);
  }

  async seal(
    runId: number,
    artifacts: InventoryItem[],
    externalAttemptId: string,
    startedAtMs: number,
    declarationBasis: DeclarationBasis = "producer_manifest",
  ): Promise<void> {
    const result = await this.json(`/v1/runs/${runId}/seal`, {
      artifacts,
      declarationBasis,
      externalAttemptId,
      startedAtMs,
    });
    if (result.sealed !== true) throw new Error("central_seal_missing");
  }

  async recordAttempt(runId: number, input: RecordAttemptRequest): Promise<void> {
    await this.json(`/v1/runs/${runId}/attempts`, input);
  }

  private async json(path: string, body: object): Promise<JsonObject> {
    const response = await this.#service.fetch(
      new Request(`https://kogane-ingest.internal${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
    );
    if (!response.ok) throw await centralError(response);
    const parsed: unknown = await response.json();
    if (!isRecord(parsed)) throw new Error("central_response_invalid");
    return parsed;
  }
}

/**
 * descriptor-v1 digest of an artifact request, computed by the shared
 * evidence-contract normalizer and encoder (the local copies moved there in
 * PR A02). Importers hash before staging inventory so a normalization drift
 * between client and raw-evidence fails closed before any terminal report or
 * seal. The server never trusts this value: it recomputes the digest from its
 * own validated parse and rejects inventory items that disagree.
 */
export function centralDescriptorSha256(descriptor: ArtifactRequest): Promise<string> {
  return descriptorSha256V1(descriptor);
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function centralError(response: Response): Promise<Error> {
  let code = "request_failed";
  try {
    const parsed: unknown = await response.json();
    if (
      isRecord(parsed) &&
      typeof parsed.error === "string" &&
      /^[a-z0-9_-]{1,100}$/u.test(parsed.error)
    ) {
      code = parsed.error;
    }
  } catch {
    // Keep the stable generic code and never copy an arbitrary response body.
  }
  return new Error(`central_${response.status}_${code}`);
}

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(code);
  return value as number;
}

function requiredSha256(value: unknown, code: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(code);
  }
  return value;
}
