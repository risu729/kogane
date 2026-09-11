// U05 parity: the legacy HTTP route and the in-process registration port are
// the same registration.
//
// This is the whole point of the extraction (unified plan 02 §3): the
// Processor will register a terminal run by calling
// `directRegistrationPort(env, clientId)` instead of posting to
// `kogane-ingest`, and nothing about what lands in CORE may depend on which
// of the two it used. So the same synthetic fixture is registered twice — once
// through `SELF.fetch`, once through the port — and the rows are compared
// column by column, with only the keys that must differ (the run key, the
// artifact key, the ids) allowed to differ.
//
// Everything here is synthetic: no provider, no account, no amount.
import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { directRegistrationPort } from "../../../packages/application/src/ingest/index.ts";
import { sha256Hex } from "../src/canonical";

const AUTH = "Bearer parity.test-secret-at-least-twenty-chars";
const CLIENT = "parity";
const PRODUCER = "parity-producer";
const SOURCE = "parity-source";

const port = () => directRegistrationPort(env as never, CLIENT);

async function post(path: string, body: unknown): Promise<Response> {
  return SELF.fetch(`https://example.test${path}`, {
    method: "POST",
    headers: { authorization: AUTH, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const TERMINAL_REPORT = {
  reportKey: "terminal",
  reportKind: "terminal",
  normalizedOutcome: "success",
  completedAtMs: 1_788_324_000_000,
  completedAtBasis: "manifest",
  declaredArtifactCount: 1,
  artifactCountScope: "all_catalogued",
};

function descriptor(artifactKey: string, sha256: string, byteSize: number) {
  return {
    artifactKey,
    artifactRole: "provider_response",
    payloadFidelity: "exact",
    containerKind: "single",
    lineageDisposition: "not_applicable",
    sha256,
    byteSize,
    storage: {
      storageKind: "r2",
      containerName: "parity-staging",
      objectKeyTemplate: "runs/{redacted}/artifact",
      objectKeyFingerprint: "1".repeat(64),
      fingerprintKeyVersion: "test-hmac-v1",
      redactionVersion: "v1",
    },
  };
}

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO sources (id, provider, display_name) VALUES ('parity-source', 'Provider', 'Parity Source')",
    ),
    env.DB.prepare(
      "INSERT INTO producers (id, kind, display_name) VALUES ('parity-producer', 'collector', 'Parity Producer')",
    ),
    env.DB.prepare(
      "INSERT INTO producer_sources (producer_id, source_id) VALUES ('parity-producer', 'parity-source')",
    ),
    env.DB.prepare(
      "INSERT INTO ingest_clients (id, display_name) VALUES ('parity', 'Parity client')",
    ),
    env.DB.prepare(
      "INSERT INTO ingest_client_producers (ingest_client_id, producer_id) VALUES ('parity', 'parity-producer')",
    ),
    env.DB.prepare(
      "INSERT INTO ingest_client_routes (ingest_client_id, producer_id, source_id) VALUES ('parity', 'parity-producer', 'parity-source')",
    ),
    env.DB.prepare(
      "INSERT INTO origin_template_policies (source_id, origin_kind, template, redaction_version, fingerprint_key_version) VALUES ('parity-source', 'storage', 'runs/{redacted}/artifact', 'v1', 'test-hmac-v1')",
    ),
  ]);
});

/** Every column of a run, minus the ones that identify which run it is. */
async function runRow(runId: number): Promise<Record<string, unknown>> {
  const row = await env.DB.prepare(
    "SELECT producer_id, source_id, first_recorded_by_client_id FROM fetch_runs WHERE id = ?",
  )
    .bind(runId)
    .first<Record<string, unknown>>();
  return row!;
}

/** Every column of an artifact, minus its own ids and keys. */
async function artifactRow(runId: number): Promise<Record<string, unknown>> {
  const row = await env.DB.prepare(
    `SELECT producer_id, source_id, first_ingested_by_client_id, artifact_role, payload_fidelity,
            container_kind, lineage_disposition, dataset, format_id, format_version,
            declared_media_type, media_type_basis, fetched_at_ms, fetched_at_basis,
            page_index, sequence, sha256, byte_size, descriptor_version, descriptor_sha256
     FROM fetch_artifacts WHERE fetch_run_id = ?`,
  )
    .bind(runId)
    .first<Record<string, unknown>>();
  return row!;
}

describe("registration parity: HTTP route vs in-process port (U05)", () => {
  it("registers, catalogues and seals identically either way", async () => {
    const bytes = new TextEncoder().encode('{"parity":true}');
    const sha256 = await sha256Hex(bytes);

    // ── through the legacy HTTP protocol ────────────────────────────────
    const created = await post("/v1/runs", {
      producerId: PRODUCER,
      sourceId: SOURCE,
      externalIdNamespace: "test",
      externalSessionId: "parity-http",
    });
    expect(created.status).toBe(201);
    const httpRunId = ((await created.json()) as { runId: number }).runId;
    const upload = await SELF.fetch(`https://example.test/v1/runs/${httpRunId}/objects/${sha256}`, {
      method: "PUT",
      headers: {
        authorization: AUTH,
        "content-length": String(bytes.byteLength),
        "x-kogane-byte-size": String(bytes.byteLength),
      },
      body: bytes,
    });
    expect([200, 201]).toContain(upload.status);
    const catalogued = await post(
      `/v1/runs/${httpRunId}/artifacts`,
      descriptor("parity.json", sha256, bytes.byteLength),
    );
    expect(catalogued.status).toBe(201);
    const httpDigest = ((await catalogued.json()) as { descriptorSha256: string }).descriptorSha256;
    expect((await post(`/v1/runs/${httpRunId}/reports`, TERMINAL_REPORT)).status).toBe(201);
    const sealed = await post(`/v1/runs/${httpRunId}/seal`, {
      artifacts: [{ artifactKey: "parity.json", sha256, descriptorSha256: httpDigest }],
      declarationBasis: "producer_manifest",
      externalAttemptId: "parity-http-attempt",
      startedAtMs: 1_700_000_000_000,
    });
    expect(sealed.status).toBe(201);

    // ── through the in-process port, no HTTP at all ─────────────────────
    const registration = port();
    const directRunId = await registration.createRun({
      producerId: PRODUCER,
      sourceId: SOURCE,
      externalIdNamespace: "test",
      externalSessionId: "parity-direct",
    });
    await registration.uploadObject(directRunId, sha256, bytes);
    const directDigest = await registration.addArtifact(
      directRunId,
      descriptor("parity.json", sha256, bytes.byteLength) as never,
    );
    await registration.addRunReport(directRunId, TERMINAL_REPORT as never);
    await registration.seal(
      directRunId,
      [{ artifactKey: "parity.json", sha256, descriptorSha256: directDigest }],
      "parity-direct-attempt",
      1_700_000_000_000,
    );

    // ── the rows must agree ─────────────────────────────────────────────
    expect(directRunId).not.toBe(httpRunId);
    // The descriptor digest is recomputed server-side from the same validated
    // parse either way, so it is the same 64 hex characters.
    expect(directDigest).toBe(httpDigest);
    expect(await runRow(directRunId)).toEqual(await runRow(httpRunId));
    expect(await artifactRow(directRunId)).toEqual(await artifactRow(httpRunId));

    const seals = await env.DB.prepare(
      "SELECT fetch_run_id, sealed_by_client_id FROM fetch_run_seals WHERE fetch_run_id IN (?, ?) ORDER BY fetch_run_id",
    )
      .bind(httpRunId, directRunId)
      .all<{ fetch_run_id: number; sealed_by_client_id: string }>();
    expect(seals.results.map((row) => row.sealed_by_client_id)).toEqual([CLIENT, CLIENT]);

    const attempts = await env.DB.prepare(
      `SELECT expected_artifact_count, observed_artifact_count, accepted_artifact_count,
              reused_artifact_count, rejected_artifact_count, outcome, error_code
       FROM ingestion_attempts WHERE fetch_run_id = ?`,
    );
    expect(await attempts.bind(directRunId).first()).toEqual(
      await attempts.bind(httpRunId).first(),
    );
  });

  it("refuses an unauthorized route the same way through the port", async () => {
    // The port performs the same CORE authorization the HTTP path does; it is
    // not a bypass of it.
    await expect(
      directRegistrationPort(env as never, "parity").createRun({
        producerId: PRODUCER,
        sourceId: "api-source",
        externalIdNamespace: "test",
        externalSessionId: "parity-denied",
      }),
    ).rejects.toThrow("inactive_ingest_route");
    const denied = await post("/v1/runs", {
      producerId: PRODUCER,
      sourceId: "api-source",
      externalIdNamespace: "test",
      externalSessionId: "parity-denied-http",
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "inactive_ingest_route" });
  });
});
