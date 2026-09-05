import type { CentralInventoryItem } from "./types";

type JsonObject = Record<string, unknown>;
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export class CentralClient {
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

  async createRun(input: JsonObject): Promise<number> {
    const result = await this.json("/v1/runs", input);
    return requiredInteger(result.runId, "central_run_id_missing");
  }

  async addUnit(runId: number, input: JsonObject): Promise<number> {
    const result = await this.json(`/v1/runs/${runId}/units`, input);
    return requiredInteger(result.unitId, "central_unit_id_missing");
  }

  async addRunRange(runId: number, input: JsonObject): Promise<void> {
    await this.json(`/v1/runs/${runId}/ranges`, input);
  }

  async addPageGroup(runId: number, input: JsonObject): Promise<number> {
    const result = await this.json(`/v1/runs/${runId}/page-groups`, input);
    return requiredInteger(result.pageGroupId, "central_page_group_id_missing");
  }

  async addUnitReport(unitId: number, input: JsonObject): Promise<void> {
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

  async addArtifact(runId: number, input: JsonObject): Promise<string> {
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
    items: CentralInventoryItem[],
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

  async addRunReport(runId: number, input: JsonObject): Promise<void> {
    await this.json(`/v1/runs/${runId}/reports`, input);
  }

  async seal(
    runId: number,
    artifacts: CentralInventoryItem[],
    externalAttemptId: string,
    startedAtMs: number,
  ): Promise<void> {
    const result = await this.json(`/v1/runs/${runId}/seal`, {
      artifacts,
      declarationBasis: "producer_manifest",
      externalAttemptId,
      startedAtMs,
    });
    if (result.sealed !== true) throw new Error("central_seal_missing");
  }

  async recordAttempt(runId: number, input: JsonObject): Promise<void> {
    await this.json(`/v1/runs/${runId}/attempts`, input);
  }

  private async json(path: string, body: JsonObject): Promise<JsonObject> {
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
 * Hash the exact storage-origin descriptor shape persisted by raw-evidence
 * after its schema parser has supplied optional origin fields and empty
 * collection defaults. Importers use this before staging inventory so a
 * parser-normalization drift fails closed before any terminal report or seal.
 * HTTP, file, and email importers must add their nested origin normalization
 * here before sharing this helper.
 */
export async function centralDescriptorSha256(descriptor: JsonObject): Promise<string> {
  const {
    http,
    storage,
    file,
    email,
    fetchUnitId,
    pageGroupId,
    pageIndex,
    ranges,
    transformSteps,
    relations,
    ...fields
  } = descriptor;
  const normalized = {
    ...fields,
    fetchUnitId: fetchUnitId ?? null,
    pageGroupId: pageGroupId ?? null,
    pageIndex: pageIndex ?? null,
    origins: {
      http: http ?? null,
      storage: normalizedStorageOrigin(storage),
      file: file ?? null,
      email: email ?? null,
    },
    ranges: ranges ?? [],
    transformSteps: transformSteps ?? [],
    relations: relations ?? [],
  };
  const bytes = new TextEncoder().encode(canonicalJson(normalized as unknown as JsonValue));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", ownedArrayBuffer(bytes)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizedStorageOrigin(value: unknown): JsonValue {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new TypeError("storage origin must be an object");
  return {
    storageKind: value.storageKind,
    containerName: value.containerName,
    objectKeyTemplate: value.objectKeyTemplate,
    objectKeyFingerprint: value.objectKeyFingerprint,
    fingerprintKeyVersion: value.fingerprintKeyVersion,
    redactionVersion: value.redactionVersion,
    objectVersion: value.objectVersion ?? null,
    etag: value.etag ?? null,
    lastModifiedAtMs: value.lastModifiedAtMs ?? null,
    lastModifiedAtBasis: value.lastModifiedAtBasis ?? null,
  } as unknown as JsonValue;
}

function canonicalJson(value: JsonValue): string {
  return JSON.stringify(canonical(value));
}

function canonical(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new TypeError("canonical numbers must be safe integers");
  }
  return value;
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
