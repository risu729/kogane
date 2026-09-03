import type { CentralInventoryItem } from "./types";

type JsonObject = Record<string, unknown>;

export class CentralClient {
  readonly #service: Fetcher;
  readonly #token: string;

  constructor(service: Fetcher, token: string) {
    if (!/^collector-r2-sbi\.[^\s]{20,}$/u.test(token)) {
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

  async addUnitReport(unitId: number, input: JsonObject): Promise<void> {
    await this.json(`/v1/units/${unitId}/reports`, input);
  }

  async uploadObject(
    runId: number,
    sha256: string,
    bytes: Uint8Array,
  ): Promise<boolean> {
    const response = await this.#service.fetch(new Request(
      `https://kogane-ingest.internal/v1/runs/${runId}/objects/${sha256}`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${this.#token}`,
          "x-kogane-byte-size": String(bytes.byteLength),
        },
        body: ownedArrayBuffer(bytes),
      },
    ));
    if (!response.ok) throw await centralError(response);
    return response.status === 200;
  }

  async addArtifact(runId: number, input: JsonObject): Promise<string> {
    const result = await this.json(`/v1/runs/${runId}/artifacts`, input);
    return requiredSha256(result.descriptorSha256, "central_descriptor_missing");
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
    const response = await this.#service.fetch(new Request(
      `https://kogane-ingest.internal${path}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
    ));
    if (!response.ok) throw await centralError(response);
    const parsed: unknown = await response.json();
    if (!isRecord(parsed)) throw new Error("central_response_invalid");
    return parsed;
  }
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
    if (isRecord(parsed) && typeof parsed.error === "string" &&
        /^[a-z0-9_-]{1,100}$/u.test(parsed.error)) {
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
