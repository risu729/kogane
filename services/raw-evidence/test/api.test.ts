import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { canonicalJson, sha256Hex } from "../src/canonical";

const AUTH = "Bearer test.test-secret-at-least-twenty-chars";

async function post(path: string, body: unknown): Promise<Response> {
  return SELF.fetch(`https://example.test${path}`, {
    method: "POST",
    headers: { authorization: AUTH, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function createTestRun(sessionId: string): Promise<number> {
  const response = await post("/v1/runs", {
    producerId: "api-producer",
    sourceId: "api-source",
    externalIdNamespace: "test",
    externalSessionId: sessionId,
  });
  expect(response.status).toBe(201);
  return Number((await response.json() as { runId: number }).runId);
}

async function uploadText(runId: number, text: string): Promise<{ sha256: string; byteSize: number }> {
  const bytes = new TextEncoder().encode(text);
  const sha256 = await sha256Hex(bytes);
  const response = await SELF.fetch(`https://example.test/v1/runs/${runId}/objects/${sha256}`, {
    method: "PUT",
    headers: {
      authorization: AUTH,
      "content-length": String(bytes.byteLength),
      "x-kogane-byte-size": String(bytes.byteLength),
    },
    body: bytes,
  });
  expect([200, 201]).toContain(response.status);
  return { sha256, byteSize: bytes.byteLength };
}

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO sources (id, provider, display_name) VALUES ('api-source', 'Provider', 'API Source')"),
    env.DB.prepare("INSERT INTO producers (id, kind, display_name) VALUES ('api-producer', 'collector', 'API Producer')"),
    env.DB.prepare("INSERT INTO producer_sources (producer_id, source_id) VALUES ('api-producer', 'api-source')"),
    env.DB.prepare("INSERT INTO ingest_clients (id, display_name) VALUES ('test', 'Test client')"),
    env.DB.prepare("INSERT INTO ingest_client_producers (ingest_client_id, producer_id) VALUES ('test', 'api-producer')"),
    env.DB.prepare("INSERT INTO ingest_client_routes (ingest_client_id, producer_id, source_id) VALUES ('test', 'api-producer', 'api-source')"),
    env.DB.prepare("INSERT INTO http_scope_rules (source_id, action, scheme, host, path_prefix) VALUES ('api-source', 'allow', 'https', 'api.example.test', '/v1/')"),
    env.DB.prepare("INSERT INTO origin_template_policies (source_id, origin_kind, template, redaction_version, query_names_json) VALUES ('api-source', 'http', '/v1/history/{month}', 'v1', '[\"month\",\"page\"]')"),
    env.DB.prepare("INSERT INTO origin_template_policies (source_id, origin_kind, template, redaction_version, query_names_json) VALUES ('api-source', 'http', '/v1/history/{month}', 'v1', '[]')"),
    env.DB.prepare("INSERT INTO origin_template_policies (source_id, origin_kind, template, redaction_version, fingerprint_key_version) VALUES ('api-source', 'file', '{redacted}', 'v1', 'test-hmac-v1')"),
    env.DB.prepare("INSERT INTO origin_template_policies (source_id, origin_kind, template, redaction_version, fingerprint_key_version) VALUES ('api-source', 'file', '{redacted}.{extension}', 'v1', 'test-hmac-v1')"),
    env.DB.prepare("INSERT INTO origin_template_policies (source_id, origin_kind, template, redaction_version, fingerprint_key_version) VALUES ('api-source', 'storage', 'runs/{redacted}/artifact', 'v1', 'test-hmac-v1')"),
    env.DB.prepare("INSERT INTO origin_template_policies (source_id, origin_kind, template, redaction_version, fingerprint_key_version) VALUES ('api-source', 'email', '{redacted}.{extension}', 'v1', 'test-hmac-v1')"),
    env.DB.prepare("INSERT INTO sources (id, provider, display_name) VALUES ('api-source-2', 'Provider', 'API Source 2')"),
    env.DB.prepare("INSERT INTO producer_sources (producer_id, source_id) VALUES ('api-producer', 'api-source-2')"),
    env.DB.prepare("INSERT INTO ingest_client_routes (ingest_client_id, producer_id, source_id) VALUES ('test', 'api-producer', 'api-source-2')"),
  ]);
});

describe("raw-evidence Worker", () => {
  it("exposes only a non-sensitive health response without authentication", async () => {
    const response = await SELF.fetch("https://example.test/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      service: "kogane-ingest",
      apiVersion: "v1",
      schemaVersion: "0005",
    });
    const denied = await post("/v1/runs", {});
    expect(denied.status).toBe(400);
    const unauthenticated = await SELF.fetch("https://example.test/v1/runs", { method: "POST" });
    expect(unauthenticated.status).toBe(401);
  });

  it("streams an object and completes an idempotent run, report, artifact, and seal", async () => {
    const bytes = new TextEncoder().encode('{"safe":"fixture"}');
    const sha256 = await sha256Hex(bytes);
    const runPayload = {
      producerId: "api-producer",
      sourceId: "api-source",
      externalIdNamespace: "test",
      externalSessionId: "api-session-001",
      sourceRunKey: "default",
    };
    const runResponse = await post("/v1/runs", runPayload);
    expect(runResponse.status).toBe(201);
    const { runId } = await runResponse.json() as { runId: number };
    const put = () => SELF.fetch(`https://example.test/v1/runs/${runId}/objects/${sha256}`, {
      method: "PUT",
      headers: {
        authorization: AUTH,
        "content-length": String(bytes.byteLength),
        "x-kogane-byte-size": String(bytes.byteLength),
      },
      body: bytes,
    });
    const firstPut = await put();
    expect(firstPut.status).toBe(201);
    expect((await firstPut.json() as { reused: boolean }).reused).toBe(false);
    const secondPut = await put();
    expect(secondPut.status).toBe(200);
    expect((await secondPut.json() as { reused: boolean }).reused).toBe(true);

    const replayRun = await post("/v1/runs", runPayload);
    expect((await replayRun.json() as { runId: number }).runId).toBe(runId);

    const artifactPayload = {
      artifactKey: "response.json",
      artifactRole: "provider_response",
      payloadFidelity: "exact",
      containerKind: "single",
      lineageDisposition: "not_applicable",
      dataset: "fixture",
      declaredMediaType: "application/json",
      mediaTypeBasis: "response_header",
      fetchedAtMs: 1_788_324_000_000,
      fetchedAtBasis: "response",
      sequence: 0,
      sha256,
      byteSize: bytes.byteLength,
      http: {
        method: "GET",
        status: 200,
        scheme: "https",
        host: "api.example.test",
        pathTemplate: "/v1/history/{month}",
        queryNames: ["page", "month"],
        redactionVersion: "v1",
      },
    };
    const artifactResponse = await post(`/v1/runs/${runId}/artifacts`, artifactPayload);
    expect(artifactResponse.status).toBe(201);
    const artifact = await artifactResponse.json() as { descriptorSha256: string };
    expect(artifact.descriptorSha256).toMatch(/^[0-9a-f]{64}$/);
    const replayArtifact = await post(`/v1/runs/${runId}/artifacts`, artifactPayload);
    expect((await replayArtifact.json() as { descriptorSha256: string }).descriptorSha256)
      .toBe(artifact.descriptorSha256);

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

    const sealPayload = {
      artifacts: [{ artifactKey: "response.json", sha256, descriptorSha256: artifact.descriptorSha256 }],
      declarationBasis: "producer_manifest",
      externalAttemptId: "attempt-001",
      startedAtMs: 1_788_323_900_000,
    };
    const seal = await post(`/v1/runs/${runId}/seal`, sealPayload);
    expect(seal.status).toBe(201);
    expect((await seal.json() as { sealed: boolean }).sealed).toBe(true);
    const replaySeal = await post(`/v1/runs/${runId}/seal`, sealPayload);
    expect(replaySeal.status).toBe(201);
    const laterAttempt = await post(`/v1/runs/${runId}/seal`, {
      ...sealPayload,
      externalAttemptId: "attempt-002",
    });
    expect(laterAttempt.status).toBe(201);
    const attempts = await env.DB.prepare(`
      SELECT external_attempt_id, accepted_artifact_count, reused_artifact_count
      FROM ingestion_attempts WHERE fetch_run_id = ? ORDER BY external_attempt_id
    `).bind(runId).all<{
      external_attempt_id: string;
      accepted_artifact_count: number;
      reused_artifact_count: number;
    }>();
    expect(attempts.results).toEqual([
      { external_attempt_id: "attempt-001", accepted_artifact_count: 1, reused_artifact_count: 0 },
      { external_attempt_id: "attempt-002", accepted_artifact_count: 0, reused_artifact_count: 1 },
    ]);
  });

  it("fails closed for a wrong digest before cataloguing bytes", async () => {
    const run = await post("/v1/runs", {
      producerId: "api-producer",
      sourceId: "api-source",
      externalIdNamespace: "test",
      externalSessionId: "api-session-bad-digest",
    });
    const { runId } = await run.json() as { runId: number };
    const response = await SELF.fetch(`https://example.test/v1/runs/${runId}/objects/${"0".repeat(64)}`, {
      method: "PUT",
      headers: {
        authorization: AUTH,
        "content-length": "3",
        "x-kogane-byte-size": "3",
      },
      body: "abc",
    });
    expect(response.status).toBe(422);
    const row = await env.DB.prepare("SELECT 1 AS ok FROM raw_objects WHERE sha256 = ?")
      .bind("0".repeat(64)).first();
    expect(row).toBeNull();
  });

  it("rejects an inventory that is not exactly the server catalogue", async () => {
    const run = await post("/v1/runs", {
      producerId: "api-producer",
      sourceId: "api-source",
      externalIdNamespace: "test",
      externalSessionId: "api-session-empty",
    });
    const { runId } = await run.json() as { runId: number };
    const response = await post(`/v1/runs/${runId}/seal`, {
      artifacts: [{
        artifactKey: "not-present.json",
        sha256: "1".repeat(64),
        descriptorSha256: "2".repeat(64),
      }],
      declarationBasis: "operator",
      externalAttemptId: "attempt-mismatch",
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "inventory_mismatch" });
  });

  it("represents a bounded backfill with a required unit and declared page set", async () => {
    const bytes = new TextEncoder().encode('{"page":0}');
    const sha256 = await sha256Hex(bytes);
    const runResponse = await post("/v1/runs", {
      producerId: "api-producer",
      sourceId: "api-source",
      externalIdNamespace: "test",
      externalSessionId: "api-session-structure",
    });
    const { runId } = await runResponse.json() as { runId: number };
    const put = await SELF.fetch(`https://example.test/v1/runs/${runId}/objects/${sha256}`, {
      method: "PUT",
      headers: {
        authorization: AUTH,
        "content-length": String(bytes.byteLength),
        "x-kogane-byte-size": String(bytes.byteLength),
      },
      body: bytes,
    });
    expect(put.status).toBe(201);
    const range = await post(`/v1/runs/${runId}/ranges`, {
      rangeKey: "requested-window",
      rangeKind: "requested",
      precision: "month",
      startValue: "2026-01",
      endValue: "2026-08",
      basis: "request",
    });
    expect(range.status).toBe(201);
    const pageGroup = await post(`/v1/runs/${runId}/page-groups`, {
      pageGroupKey: "history",
      declaredPageCount: 1,
    });
    const { pageGroupId } = await pageGroup.json() as { pageGroupId: number };
    const unit = await post(`/v1/runs/${runId}/units`, {
      unitKind: "account",
      unitKey: "account-001",
      terminalReportRequired: true,
    });
    const { unitId } = await unit.json() as { unitId: number };
    const artifactResponse = await post(`/v1/runs/${runId}/artifacts`, {
      artifactKey: "history/page-0000.json",
      artifactRole: "provider_response",
      payloadFidelity: "exact",
      containerKind: "single",
      lineageDisposition: "not_applicable",
      fetchUnitId: unitId,
      pageGroupId,
      pageIndex: 0,
      sha256,
      byteSize: bytes.byteLength,
      ranges: [{
        rangeKey: "coverage",
        rangeKind: "declared_coverage",
        precision: "date",
        startValue: "2026-08-01",
        endValue: "2026-08-31",
        basis: "source",
      }],
    });
    expect(artifactResponse.status).toBe(201);
    const artifact = await artifactResponse.json() as { descriptorSha256: string };
    const unitReport = await post(`/v1/units/${unitId}/reports`, {
      reportKey: "terminal",
      reportKind: "terminal",
      normalizedOutcome: "success",
      declaredArtifactCount: 1,
      artifactCountScope: "direct",
    });
    expect(unitReport.status).toBe(201);
    await post(`/v1/runs/${runId}/reports`, {
      reportKey: "terminal",
      reportKind: "terminal",
      normalizedOutcome: "success",
      declaredArtifactCount: 1,
      artifactCountScope: "all_catalogued",
    });
    const seal = await post(`/v1/runs/${runId}/seal`, {
      artifacts: [{
        artifactKey: "history/page-0000.json",
        sha256,
        descriptorSha256: artifact.descriptorSha256,
      }],
      declarationBasis: "producer_manifest",
      externalAttemptId: "attempt-structure",
    });
    expect(seal.status).toBe(201);
  });

  it("leaves no immutable artifact residue after nested validation or policy failure", async () => {
    const runId = await createTestRun("api-session-atomic-artifact");
    const object = await uploadText(runId, "atomic-artifact");
    const base = {
      artifactKey: "atomic.json",
      artifactRole: "provider_response",
      payloadFidelity: "exact",
      containerKind: "single",
      lineageDisposition: "not_applicable",
      sha256: object.sha256,
      byteSize: object.byteSize,
    };
    const denied = await post(`/v1/runs/${runId}/artifacts`, {
      ...base,
      http: {
        scheme: "https",
        host: "blocked.example.test",
        pathTemplate: "/v1/history/{month}",
        queryNames: [],
        redactionVersion: "v1",
      },
    });
    expect(denied.status).toBe(403);
    expect(await env.DB.prepare(
      "SELECT count(*) AS count FROM fetch_artifacts WHERE fetch_run_id = ?",
    ).bind(runId).first<{ count: number }>()).toEqual({ count: 0 });

    const duplicate = await post(`/v1/runs/${runId}/artifacts`, {
      ...base,
      ranges: [
        { rangeKey: "coverage", rangeKind: "selector", precision: "month", startValue: "2026-01", basis: "request" },
        { rangeKey: "coverage", rangeKind: "selector", precision: "month", startValue: "2026-02", basis: "request" },
      ],
    });
    expect(duplicate.status).toBe(400);
    expect(await env.DB.prepare(
      "SELECT count(*) AS count FROM fetch_artifacts WHERE fetch_run_id = ?",
    ).bind(runId).first<{ count: number }>()).toEqual({ count: 0 });

    const corrected = await post(`/v1/runs/${runId}/artifacts`, {
      ...base,
      http: {
        scheme: "https",
        host: "api.example.test",
        pathTemplate: "/v1/history/{month}",
        queryNames: [],
        redactionVersion: "v1",
      },
    });
    expect(corrected.status).toBe(201);
  });

  it("reconciles concurrent exact artifact retries and rejects a conflicting winner", async () => {
    const exactRunId = await createTestRun("api-session-artifact-race-exact");
    const exactObject = await uploadText(exactRunId, "race-exact");
    const exactPayload = {
      artifactKey: "race.json",
      artifactRole: "provider_response",
      payloadFidelity: "exact",
      containerKind: "single",
      lineageDisposition: "not_applicable",
      sha256: exactObject.sha256,
      byteSize: exactObject.byteSize,
    };
    const exactStatuses = (await Promise.all([
      post(`/v1/runs/${exactRunId}/artifacts`, exactPayload),
      post(`/v1/runs/${exactRunId}/artifacts`, exactPayload),
    ])).map((response) => response.status).sort();
    expect(exactStatuses).toEqual([201, 201]);

    const conflictRunId = await createTestRun("api-session-artifact-race-conflict");
    const conflictObject = await uploadText(conflictRunId, "race-conflict");
    const conflictBase = {
      ...exactPayload,
      sha256: conflictObject.sha256,
      byteSize: conflictObject.byteSize,
    };
    const conflictStatuses = (await Promise.all([
      post(`/v1/runs/${conflictRunId}/artifacts`, { ...conflictBase, dataset: "left" }),
      post(`/v1/runs/${conflictRunId}/artifacts`, { ...conflictBase, dataset: "right" }),
    ])).map((response) => response.status).sort();
    expect(conflictStatuses).toEqual([201, 409]);
  });

  it("keeps a transient artifact batch failure retryable when no winner committed", async () => {
    const runId = await createTestRun("api-session-artifact-transient");
    const content = await uploadText(runId, "artifact-transient");
    const payload = {
      artifactKey: "transient.json",
      artifactRole: "provider_response",
      payloadFidelity: "exact",
      containerKind: "single",
      lineageDisposition: "not_applicable",
      sha256: content.sha256,
      byteSize: content.byteSize,
    };
    const batchSpy = vi.spyOn(env.DB, "batch")
      .mockRejectedValueOnce(new Error("synthetic transient D1 failure"));
    expect((await post(`/v1/runs/${runId}/artifacts`, payload)).status).toBe(500);
    batchSpy.mockRestore();
    expect(await env.DB.prepare(
      "SELECT count(*) AS count FROM fetch_artifacts WHERE fetch_run_id = ?",
    ).bind(runId).first<{ count: number }>()).toEqual({ count: 0 });
    expect((await post(`/v1/runs/${runId}/artifacts`, payload)).status).toBe(201);
  });

  it("keeps a transient direct-seal batch failure retryable without residue", async () => {
    const runId = await createTestRun("api-session-seal-transient");
    await post(`/v1/runs/${runId}/reports`, {
      reportKey: "terminal",
      reportKind: "terminal",
      normalizedOutcome: "success",
      declaredArtifactCount: 0,
      artifactCountScope: "all_catalogued",
    });
    const payload = {
      artifacts: [],
      declarationBasis: "operator",
      externalAttemptId: "attempt-seal-transient",
      startedAtMs: 1_788_323_900_000,
    };
    const batchSpy = vi.spyOn(env.DB, "batch")
      .mockRejectedValueOnce(new Error("synthetic transient D1 seal failure"));
    expect((await post(`/v1/runs/${runId}/seal`, payload)).status).toBe(500);
    batchSpy.mockRestore();
    expect(await env.DB.prepare(
      "SELECT count(*) AS count FROM run_inventories WHERE fetch_run_id = ?",
    ).bind(runId).first<{ count: number }>()).toEqual({ count: 0 });
    expect(await env.DB.prepare(
      "SELECT count(*) AS count FROM fetch_run_seals WHERE fetch_run_id = ?",
    ).bind(runId).first<{ count: number }>()).toEqual({ count: 0 });
    expect(await env.DB.prepare(
      "SELECT count(*) AS count FROM ingestion_attempts WHERE fetch_run_id = ?",
    ).bind(runId).first<{ count: number }>()).toEqual({ count: 0 });
    expect((await post(`/v1/runs/${runId}/seal`, payload)).status).toBe(201);
  });

  it("rejects unreviewed query names and MIME parameters before catalogue writes", async () => {
    const runId = await createTestRun("api-session-origin-privacy");
    const content = await uploadText(runId, "origin-privacy");
    const base = {
      artifactRole: "provider_response",
      payloadFidelity: "exact",
      containerKind: "single",
      lineageDisposition: "not_applicable",
      sha256: content.sha256,
      byteSize: content.byteSize,
    };
    const unreviewed = await post(`/v1/runs/${runId}/artifacts`, {
      ...base,
      artifactKey: "unreviewed.json",
      http: {
        scheme: "https",
        host: "api.example.test",
        pathTemplate: "/v1/history/{month}",
        queryNames: ["account123"],
        redactionVersion: "v1",
      },
    });
    expect(unreviewed.status).toBe(403);
    const invalidName = await post(`/v1/runs/${runId}/artifacts`, {
      ...base,
      artifactKey: "invalid-name.json",
      http: {
        scheme: "https",
        host: "api.example.test",
        pathTemplate: "/v1/history/{month}",
        queryNames: ["token=secret"],
        redactionVersion: "v1",
      },
    });
    expect(invalidName.status).toBe(400);
    const mimeParameter = await post(`/v1/runs/${runId}/artifacts`, {
      ...base,
      artifactKey: "mime.json",
      declaredMediaType: "multipart/form-data; boundary=secret",
      mediaTypeBasis: "response_header",
    });
    expect(mimeParameter.status).toBe(400);
    expect(await env.DB.prepare(
      "SELECT count(*) AS count FROM fetch_artifacts WHERE fetch_run_id = ?",
    ).bind(runId).first<{ count: number }>()).toEqual({ count: 0 });
  });

  it("preserves same-source lineage across acquisition sessions", async () => {
    const parentRunId = await createTestRun("api-session-lineage-parent");
    const parentObject = await uploadText(parentRunId, "lineage-parent");
    const parentResponse = await post(`/v1/runs/${parentRunId}/artifacts`, {
      artifactKey: "parent.json",
      artifactRole: "provider_response",
      payloadFidelity: "exact",
      containerKind: "single",
      lineageDisposition: "not_applicable",
      sha256: parentObject.sha256,
      byteSize: parentObject.byteSize,
    });
    expect(parentResponse.status).toBe(201);

    const childRunId = await createTestRun("api-session-lineage-child");
    const childObject = await uploadText(childRunId, "lineage-child");
    const childResponse = await post(`/v1/runs/${childRunId}/artifacts`, {
      artifactKey: "child.json",
      artifactRole: "collector_derived",
      payloadFidelity: "transformed",
      containerKind: "single",
      lineageDisposition: "linked",
      sha256: childObject.sha256,
      byteSize: childObject.byteSize,
      transformSteps: [{
        stepIndex: 0,
        stepKind: "extracted",
        transformerId: "fixture-transformer",
        transformerVersion: "v1",
      }],
      relations: [{
        parentRunId,
        parentArtifactKey: "parent.json",
        relation: "input",
        transformerId: "fixture-transformer",
        transformerVersion: "v1",
      }],
    });
    expect(childResponse.status).toBe(201);
    const relation = await env.DB.prepare(`
      SELECT parent.fetch_run_id AS parent_run_id, child.fetch_run_id AS child_run_id
      FROM artifact_relations relation
      JOIN fetch_artifacts parent ON parent.id = relation.parent_artifact_id
      JOIN fetch_artifacts child ON child.id = relation.child_artifact_id
      WHERE child.fetch_run_id = ?
    `).bind(childRunId).first();
    expect(relation).toEqual({ parent_run_id: parentRunId, child_run_id: childRunId });
  });

  it("records failed transfer attempts idempotently and prevents a conflicting seal", async () => {
    const runId = await createTestRun("api-session-failed-attempt");
    const attempt = {
      externalAttemptId: "attempt-failed",
      outcome: "failed",
      startedAtMs: 1_788_323_900_000,
      completedAtMs: 1_788_324_000_000,
      expectedArtifactCount: 0,
      observedArtifactCount: 0,
      acceptedArtifactCount: 0,
      reusedArtifactCount: 0,
      rejectedArtifactCount: 0,
      errorCode: "source_unavailable",
    };
    expect((await post(`/v1/runs/${runId}/attempts`, attempt)).status).toBe(201);
    expect((await post(`/v1/runs/${runId}/attempts`, attempt)).status).toBe(201);
    expect((await post(`/v1/runs/${runId}/attempts`, {
      ...attempt,
      completedAtMs: attempt.completedAtMs + 1,
    })).status).toBe(409);
    await post(`/v1/runs/${runId}/reports`, {
      reportKey: "terminal",
      reportKind: "terminal",
      normalizedOutcome: "failed",
      declaredArtifactCount: 0,
      artifactCountScope: "all_catalogued",
    });
    const seal = await post(`/v1/runs/${runId}/seal`, {
      artifacts: [],
      declarationBasis: "operator",
      externalAttemptId: "attempt-failed",
      startedAtMs: attempt.startedAtMs,
    });
    expect(seal.status).toBe(409);
    expect(await env.DB.prepare(
      "SELECT count(*) AS count FROM fetch_run_seals WHERE fetch_run_id = ?",
    ).bind(runId).first<{ count: number }>()).toEqual({ count: 0 });
    expect(await env.DB.prepare(
      "SELECT count(*) AS count FROM run_inventories WHERE fetch_run_id = ?",
    ).bind(runId).first<{ count: number }>()).toEqual({ count: 0 });
  });

  it("serializes concurrent exact and conflicting seals without partial attempts", async () => {
    const exactRunId = await createTestRun("api-session-seal-race-exact");
    await post(`/v1/runs/${exactRunId}/reports`, {
      reportKey: "terminal",
      reportKind: "terminal",
      normalizedOutcome: "success",
      declaredArtifactCount: 0,
      artifactCountScope: "all_catalogued",
    });
    const exactPayload = {
      artifacts: [],
      declarationBasis: "operator",
      externalAttemptId: "attempt-race-exact",
    };
    const exactStatuses = (await Promise.all([
      post(`/v1/runs/${exactRunId}/seal`, exactPayload),
      post(`/v1/runs/${exactRunId}/seal`, exactPayload),
    ])).map((response) => response.status).sort();
    expect(exactStatuses).toEqual([201, 201]);
    expect(await env.DB.prepare(`
      SELECT count(*) AS count FROM ingestion_attempts WHERE fetch_run_id = ?
    `).bind(exactRunId).first<{ count: number }>()).toEqual({ count: 1 });

    const conflictRunId = await createTestRun("api-session-seal-race-conflict");
    await post(`/v1/runs/${conflictRunId}/reports`, {
      reportKey: "terminal",
      reportKind: "terminal",
      normalizedOutcome: "success",
      declaredArtifactCount: 0,
      artifactCountScope: "all_catalogued",
    });
    const conflictStatuses = (await Promise.all([
      post(`/v1/runs/${conflictRunId}/seal`, {
        artifacts: [], declarationBasis: "operator", externalAttemptId: "attempt-left",
      }),
      post(`/v1/runs/${conflictRunId}/seal`, {
        artifacts: [], declarationBasis: "directory_scan", externalAttemptId: "attempt-right",
      }),
    ])).map((response) => response.status).sort();
    expect(conflictStatuses).toEqual([201, 409]);
    expect(await env.DB.prepare(`
      SELECT count(*) AS count FROM ingestion_attempts WHERE fetch_run_id = ?
    `).bind(conflictRunId).first<{ count: number }>()).toEqual({ count: 1 });
  });

  it("keeps a transient staged-item batch failure retryable without residue", async () => {
    const runId = await createTestRun("api-session-staged-item-transient");
    const object = await uploadText(runId, "staged-item-transient");
    const artifactResponse = await post(`/v1/runs/${runId}/artifacts`, {
      artifactKey: "staged-item.json",
      artifactRole: "provider_response",
      payloadFidelity: "exact",
      containerKind: "single",
      lineageDisposition: "not_applicable",
      sha256: object.sha256,
      byteSize: object.byteSize,
    });
    const descriptorSha256 = String(
      (await artifactResponse.json() as { descriptorSha256: string }).descriptorSha256,
    );
    const items = [{ artifactKey: "staged-item.json", sha256: object.sha256, descriptorSha256 }];
    const inventorySha256 = await sha256Hex(canonicalJson(items));
    const begin = await post(`/v1/runs/${runId}/inventories`, {
      inventorySha256,
      expectedArtifactCount: 1,
      declarationBasis: "capture_index",
    });
    const { inventoryId } = await begin.json() as { inventoryId: number };
    const batchSpy = vi.spyOn(env.DB, "batch")
      .mockRejectedValueOnce(new Error("synthetic transient D1 staged-item failure"));
    expect((await post(`/v1/runs/${runId}/inventories/${inventoryId}/items`, { items })).status)
      .toBe(500);
    batchSpy.mockRestore();
    expect(await env.DB.prepare(
      "SELECT count(*) AS count FROM run_inventory_items WHERE inventory_id = ?",
    ).bind(inventoryId).first<{ count: number }>()).toEqual({ count: 0 });
    expect((await post(`/v1/runs/${runId}/inventories/${inventoryId}/items`, { items })).status)
      .toBe(201);
  });

  it("resumes a staged inventory and seals it after exact chunk replay", async () => {
    const runId = await createTestRun("api-session-staged");
    const object = await uploadText(runId, "staged");
    const artifacts: Array<{ artifactKey: string; sha256: string; descriptorSha256: string }> = [];
    for (let index = 0; index < 35; index += 1) {
      const artifactKey = `staged-${String(index).padStart(3, "0")}.json`;
      const response = await post(`/v1/runs/${runId}/artifacts`, {
        artifactKey,
        artifactRole: "provider_response",
        payloadFidelity: "exact",
        containerKind: "single",
        lineageDisposition: "not_applicable",
        sequence: index,
        sha256: object.sha256,
        byteSize: object.byteSize,
      });
      expect(response.status).toBe(201);
      artifacts.push({
        artifactKey,
        sha256: object.sha256,
        descriptorSha256: String((await response.json() as { descriptorSha256: string }).descriptorSha256),
      });
    }
    const inventorySha256 = await sha256Hex(canonicalJson(artifacts));
    const begin = await post(`/v1/runs/${runId}/inventories`, {
      inventorySha256,
      expectedArtifactCount: artifacts.length,
      declarationBasis: "capture_index",
    });
    expect(begin.status).toBe(201);
    const { inventoryId } = await begin.json() as { inventoryId: number };
    const firstChunk = { items: artifacts.slice(0, 30) };
    expect((await post(`/v1/runs/${runId}/inventories/${inventoryId}/items`, firstChunk)).status).toBe(201);
    const replay = await post(`/v1/runs/${runId}/inventories/${inventoryId}/items`, firstChunk);
    expect(replay.status).toBe(201);
    expect((await replay.json() as { accepted: number }).accepted).toBe(0);
    expect((await post(`/v1/runs/${runId}/inventories/${inventoryId}/items`, {
      items: artifacts.slice(30),
    })).status).toBe(201);
    const status = await SELF.fetch(
      `https://example.test/v1/runs/${runId}/inventories/${inventoryId}`,
      { headers: { authorization: AUTH } },
    );
    expect(await status.json()).toMatchObject({
      expectedArtifactCount: 35,
      receivedArtifactCount: 35,
      sealed: false,
    });
    await post(`/v1/runs/${runId}/reports`, {
      reportKey: "terminal",
      reportKind: "terminal",
      normalizedOutcome: "success",
      declaredArtifactCount: 35,
      artifactCountScope: "all_catalogued",
    });
    const seal = await post(`/v1/runs/${runId}/inventories/${inventoryId}/seal`, {
      externalAttemptId: "attempt-staged",
    });
    expect(seal.status).toBe(201);
    expect((await seal.json() as { sealed: boolean }).sealed).toBe(true);
  }, 30_000);

  it("keeps one acquisition session across multiple source-specific runs", async () => {
    const externalSessionId = "api-session-multi-source";
    const first = await post("/v1/runs", {
      producerId: "api-producer",
      sourceId: "api-source",
      externalIdNamespace: "test",
      externalSessionId,
    });
    const second = await post("/v1/runs", {
      producerId: "api-producer",
      sourceId: "api-source-2",
      externalIdNamespace: "test",
      externalSessionId,
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const ids = await env.DB.prepare(`
      SELECT acquisition_session_id FROM fetch_runs
      WHERE id IN (?, ?) ORDER BY id
    `).bind(
      Number((await first.json() as { runId: number }).runId),
      Number((await second.json() as { runId: number }).runId),
    ).all<{ acquisition_session_id: number }>();
    expect(new Set(ids.results.map((row) => row.acquisition_session_id)).size).toBe(1);
  });

  it("catalogues reviewed storage, file, direct-mail, and forwarded-mail origins", async () => {
    const runId = await createTestRun("api-session-origin-shapes");
    const content = await uploadText(runId, "origin-shapes");
    const fingerprint = "1".repeat(64);
    const origins = [
      {
        artifactKey: "storage.json",
        artifactRole: "provider_response",
        storage: {
          storageKind: "r2",
          containerName: "collector-staging",
          objectKeyTemplate: "runs/{redacted}/artifact",
          objectKeyFingerprint: fingerprint,
          fingerprintKeyVersion: "test-hmac-v1",
          redactionVersion: "v1",
        },
      },
      {
        artifactKey: "file.json",
        artifactRole: "user_capture",
        file: {
          basenameTemplate: "{redacted}.{extension}",
          filenameFingerprint: fingerprint,
          fingerprintKeyVersion: "test-hmac-v1",
          redactionVersion: "v1",
          sourceModifiedAtMs: 1_788_324_000_000,
        },
      },
      {
        artifactKey: "direct.eml",
        artifactRole: "provider_message",
        email: {
          transportShape: "direct",
          senderDomain: "provider.example",
          receivedAtMs: 1_788_324_000_000,
          receivedAtBasis: "delivery_internal_date",
          messageIdSha256: "2".repeat(64),
          filenameTemplate: "{redacted}.{extension}",
          filenameFingerprint: fingerprint,
          fingerprintKeyVersion: "test-hmac-v1",
          redactionVersion: "v1",
        },
      },
      {
        artifactKey: "forwarded.eml",
        artifactRole: "provider_message",
        email: {
          transportShape: "forwarded_rfc822",
          senderDomain: "forwarder.example",
          receivedAtMs: 1_788_324_000_000,
          receivedAtBasis: "forwarded_inner_date",
          messageIdSha256: "3".repeat(64),
          innerMessageSha256: "4".repeat(64),
          innerSenderDomain: "provider.example",
          partIndex: 1,
          mimePartPath: "1.2",
          redactionVersion: "v1",
        },
      },
    ];
    for (const origin of origins) {
      const response = await post(`/v1/runs/${runId}/artifacts`, {
        artifactKey: origin.artifactKey,
        artifactRole: origin.artifactRole,
        payloadFidelity: origin.artifactRole === "user_capture" ? "unknown" : "exact",
        containerKind: "single",
        lineageDisposition: "not_applicable",
        sha256: content.sha256,
        byteSize: content.byteSize,
        ...(origin.storage ? { storage: origin.storage } : {}),
        ...(origin.file ? { file: origin.file } : {}),
        ...(origin.email ? { email: origin.email } : {}),
      });
      expect(response.status).toBe(201);
    }
    const counts = await env.DB.prepare(`
      SELECT
        (SELECT count(*) FROM artifact_storage_metadata) AS storage_count,
        (SELECT count(*) FROM artifact_file_metadata) AS file_count,
        (SELECT count(*) FROM artifact_email_metadata) AS email_count
    `).first();
    expect(counts).toMatchObject({ storage_count: 1, file_count: 1, email_count: 2 });
  });

  it("verifies only objects already attached to an authorized run", async () => {
    const runId = await createTestRun("api-session-verification");
    const object = await uploadText(runId, "verify-me");
    expect((await post(`/v1/runs/${runId}/objects/${object.sha256}/verify`, {})).status).toBe(404);
    await post(`/v1/runs/${runId}/artifacts`, {
      artifactKey: "verify.json",
      artifactRole: "provider_response",
      payloadFidelity: "exact",
      containerKind: "single",
      lineageDisposition: "not_applicable",
      sha256: object.sha256,
      byteSize: object.byteSize,
    });
    const first = await post(`/v1/runs/${runId}/objects/${object.sha256}/verify`, {});
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ result: "ok", reused: false });
    const replay = await post(`/v1/runs/${runId}/objects/${object.sha256}/verify`, {});
    expect(await replay.json()).toMatchObject({ result: "ok", reused: true });
  });
});
