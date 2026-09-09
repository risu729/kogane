// Server-side golden vectors for descriptor-v1 (PR A02 / finding D05).
//
// The expected digests come from packages/evidence-contract/fixtures/
// golden-vectors.json, which was produced by the PRE-REFACTOR store.ts
// parseArtifact + canonical.ts at commit 130912af. Posting each vector through
// the Worker and comparing the returned descriptorSha256 proves the shared
// contract did not move any persisted digest.
import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import fixture from "../../../packages/evidence-contract/fixtures/golden-vectors.json";

const AUTH = "Bearer test.test-secret-at-least-twenty-chars";

interface VectorResult {
  normalized: unknown;
  canonical: string;
  sha256: string;
}
interface Vector {
  name: string;
  runId: number;
  serverPostable: boolean;
  sameServerDigestAs?: string;
  input: Record<string, unknown>;
  client: VectorResult | { error: string };
  server: VectorResult | { error: string };
}
const vectors = fixture.vectors as Vector[];

async function post(path: string, body: unknown): Promise<Response> {
  return SELF.fetch(`https://example.test${path}`, {
    method: "POST",
    headers: { authorization: AUTH, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function createRun(sessionId: string): Promise<number> {
  const response = await post("/v1/runs", {
    producerId: "api-producer",
    sourceId: "api-source",
    externalIdNamespace: "golden",
    externalSessionId: sessionId,
  });
  expect(response.status).toBe(201);
  return Number(((await response.json()) as { runId: number }).runId);
}

async function uploadFixtureObject(runId: number): Promise<void> {
  const bytes = new TextEncoder().encode(fixture.object.text);
  const response = await SELF.fetch(
    `https://example.test/v1/runs/${runId}/objects/${fixture.object.sha256}`,
    {
      method: "PUT",
      headers: {
        authorization: AUTH,
        "content-length": String(bytes.byteLength),
        "x-kogane-byte-size": String(bytes.byteLength),
      },
      body: bytes,
    },
  );
  expect([200, 201]).toContain(response.status);
}

function tampered(sha256: string): string {
  return `${sha256.slice(0, -1)}${sha256.endsWith("0") ? "1" : "0"}`;
}

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO sources (id, provider, display_name) VALUES ('api-source', 'Provider', 'API Source')",
    ),
    env.DB.prepare(
      "INSERT INTO producers (id, kind, display_name) VALUES ('api-producer', 'collector', 'API Producer')",
    ),
    env.DB.prepare(
      "INSERT INTO producer_sources (producer_id, source_id) VALUES ('api-producer', 'api-source')",
    ),
    env.DB.prepare("INSERT INTO ingest_clients (id, display_name) VALUES ('test', 'Test client')"),
    env.DB.prepare(
      "INSERT INTO ingest_client_producers (ingest_client_id, producer_id) VALUES ('test', 'api-producer')",
    ),
    env.DB.prepare(
      "INSERT INTO ingest_client_routes (ingest_client_id, producer_id, source_id) VALUES ('test', 'api-producer', 'api-source')",
    ),
    env.DB.prepare(
      "INSERT INTO http_scope_rules (source_id, action, scheme, host, path_prefix) VALUES ('api-source', 'allow', 'https', 'api.example.test', '/v1/')",
    ),
    env.DB.prepare(
      "INSERT INTO origin_template_policies (source_id, origin_kind, template, redaction_version, query_names_json) VALUES ('api-source', 'http', '/v1/history/{month}', 'v1', '[\"month\",\"page\"]')",
    ),
    env.DB.prepare(
      "INSERT INTO origin_template_policies (source_id, origin_kind, template, redaction_version, fingerprint_key_version) VALUES ('api-source', 'file', '{redacted}.{extension}', 'v1', 'test-hmac-v1')",
    ),
    env.DB.prepare(
      "INSERT INTO origin_template_policies (source_id, origin_kind, template, redaction_version, fingerprint_key_version) VALUES ('api-source', 'storage', 'runs/{redacted}/artifact', 'v1', 'test-hmac-v1')",
    ),
    env.DB.prepare(
      "INSERT INTO origin_template_policies (source_id, origin_kind, template, redaction_version, fingerprint_key_version) VALUES ('api-source', 'email', '{redacted}.{extension}', 'v1', 'test-hmac-v1')",
    ),
  ]);
});

describe("descriptor-v1 golden vectors through the ingest Worker", () => {
  it("returns the pre-refactor digest for every postable vector and rejects the invalid ones", async () => {
    const seedRun = await createRun("golden-seed");
    await uploadFixtureObject(seedRun);
    let posted = 0;
    let rejected = 0;
    for (const vector of vectors) {
      if ("error" in vector.server) {
        const runId = await createRun(`golden-${vector.name}`);
        const response = await post(`/v1/runs/${runId}/artifacts`, vector.input);
        expect(response.status, vector.name).toBe(400);
        expect(await response.json(), vector.name).toEqual({ error: vector.server.error });
        rejected += 1;
        continue;
      }
      if (!vector.serverPostable) continue;
      const runId = await createRun(`golden-${vector.name}`);
      const response = await post(`/v1/runs/${runId}/artifacts`, vector.input);
      const body = (await response.json()) as { descriptorSha256?: string; error?: string };
      expect([response.status, body.error], vector.name).toEqual([201, undefined]);
      expect(body.descriptorSha256, vector.name).toBe(vector.server.sha256);
      posted += 1;
    }
    expect(posted).toBeGreaterThanOrEqual(20);
    expect(rejected).toBeGreaterThanOrEqual(8);
  });

  it("resending the same descriptor replays the same digest", async () => {
    const vector = vectors.find((entry) => entry.name === "canonical-storage-explicit")!;
    const expected = (vector.server as VectorResult).sha256;
    const runId = await createRun("golden-replay");
    await uploadFixtureObject(runId);
    const first = await post(`/v1/runs/${runId}/artifacts`, vector.input);
    expect(first.status).toBe(201);
    const replay = await post(`/v1/runs/${runId}/artifacts`, vector.input);
    expect(replay.status).toBe(201);
    expect(((await replay.json()) as { descriptorSha256: string }).descriptorSha256).toBe(expected);
    expect(((await first.json()) as { descriptorSha256: string }).descriptorSha256).toBe(expected);
  });

  it("never trusts a client-supplied descriptor hash in a staged inventory", async () => {
    const vector = vectors.find((entry) => entry.name === "canonical-storage-explicit")!;
    const expected = (vector.server as VectorResult).sha256;
    const runId = await createRun("golden-staged-tamper");
    await uploadFixtureObject(runId);
    expect((await post(`/v1/runs/${runId}/artifacts`, vector.input)).status).toBe(201);
    // A client-declared hash that differs from the server's recomputed value
    // is a conflict, exactly as before the refactor.
    const inventory = await post(`/v1/runs/${runId}/inventories`, {
      inventorySha256: "0".repeat(64),
      expectedArtifactCount: 1,
      declarationBasis: "producer_manifest",
    });
    expect(inventory.status).toBe(201);
    const { inventoryId } = (await inventory.json()) as { inventoryId: number };
    const tamperedItems = await post(`/v1/runs/${runId}/inventories/${inventoryId}/items`, {
      items: [
        {
          artifactKey: "golden.json",
          sha256: fixture.object.sha256,
          descriptorSha256: tampered(expected),
        },
      ],
    });
    expect(tamperedItems.status).toBe(409);
    expect(await tamperedItems.json()).toEqual({ error: "inventory_artifact_conflict" });
  });

  it("never trusts a client-supplied descriptor hash in a direct seal", async () => {
    const vector = vectors.find((entry) => entry.name === "canonical-storage-explicit")!;
    const expected = (vector.server as VectorResult).sha256;
    const runId = await createRun("golden-seal-tamper");
    await uploadFixtureObject(runId);
    expect((await post(`/v1/runs/${runId}/artifacts`, vector.input)).status).toBe(201);
    const report = await post(`/v1/runs/${runId}/reports`, {
      reportKey: "terminal",
      reportKind: "terminal",
      normalizedOutcome: "success",
      completedAtMs: 1_788_324_000_000,
      completedAtBasis: "manifest",
      declaredArtifactCount: 1,
      artifactCountScope: "all_catalogued",
    });
    expect(report.status).toBe(201);
    const tamperedSeal = await post(`/v1/runs/${runId}/seal`, {
      artifacts: [
        {
          artifactKey: "golden.json",
          sha256: fixture.object.sha256,
          descriptorSha256: tampered(expected),
        },
      ],
      declarationBasis: "producer_manifest",
      externalAttemptId: "golden-attempt-tampered",
      startedAtMs: 1_788_323_900_000,
    });
    expect(tamperedSeal.status).toBe(409);
    expect(await tamperedSeal.json()).toEqual({ error: "inventory_mismatch" });

    const seal = await post(`/v1/runs/${runId}/seal`, {
      artifacts: [
        { artifactKey: "golden.json", sha256: fixture.object.sha256, descriptorSha256: expected },
      ],
      declarationBasis: "producer_manifest",
      externalAttemptId: "golden-attempt",
      startedAtMs: 1_788_323_900_000,
    });
    expect(seal.status).toBe(201);
    expect(((await seal.json()) as { sealed: boolean }).sealed).toBe(true);
  });

  it("rejects unknown request fields on every schema-validated endpoint", async () => {
    const runId = await createRun("golden-unknown-fields");
    for (const [path, body] of [
      ["/v1/runs", { producerId: "api-producer", sourceId: "api-source", extra: 1 }],
      [`/v1/runs/${runId}/units`, { unitKind: "k", unitKey: "u", extra: 1 }],
      [`/v1/runs/${runId}/ranges`, { rangeKey: "r", extra: 1 }],
      [`/v1/runs/${runId}/page-groups`, { pageGroupKey: "g", extra: 1 }],
      [`/v1/runs/${runId}/reports`, { reportKey: "t", reportKind: "terminal", extra: 1 }],
      [`/v1/runs/${runId}/artifacts`, { artifactKey: "a", extra: 1 }],
      [`/v1/runs/${runId}/inventories`, { inventorySha256: "0".repeat(64), extra: 1 }],
      [`/v1/runs/${runId}/attempts`, { externalAttemptId: "a", extra: 1 }],
      [`/v1/runs/${runId}/seal`, { artifacts: [], extra: 1 }],
    ] as const) {
      const response = await post(path, body);
      expect(response.status, path).toBe(400);
      expect(await response.json(), path).toEqual({ error: "unknown_field" });
    }
  });
});
