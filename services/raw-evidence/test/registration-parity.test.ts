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

/**
 * The columns that must differ between two registrations of one fixture, or
 * that a server clock sets: row ids and the references to them, the external
 * ids the fixture chose to tell the two apart, and recording timestamps.
 * Everything else the two paths write is compared, column by column.
 */
const IDENTIFYING_COLUMNS: Record<string, readonly string[]> = {
  acquisition_sessions: ["id", "external_session_id", "first_recorded_at_ms"],
  fetch_runs: ["id", "acquisition_session_id", "first_recorded_at_ms"],
  fetch_run_reports: ["id", "fetch_run_id", "recorded_at_ms"],
  fetch_artifacts: ["id", "fetch_run_id", "recorded_at_ms"],
  run_inventories: ["id", "fetch_run_id", "created_at_ms"],
  run_inventory_items: ["inventory_id", "fetch_run_id"],
  fetch_run_seals: ["inventory_id", "fetch_run_id", "sealed_at_ms"],
  ingestion_attempts: [
    "id",
    "fetch_run_id",
    "sealed_inventory_id",
    "external_attempt_id",
    "completed_at_ms",
    "recorded_at_ms",
  ],
};

/** Every column of a table's rows for one run, minus the identifying ones. */
async function rows(table: string, runId: number): Promise<Record<string, unknown>[]> {
  const where =
    table === "fetch_runs"
      ? "id = ?1"
      : table === "acquisition_sessions"
        ? "id = (SELECT acquisition_session_id FROM fetch_runs WHERE id = ?1)"
        : "fetch_run_id = ?1";
  const result = await env.DB.prepare(`SELECT * FROM ${table} WHERE ${where}`)
    .bind(runId)
    .all<Record<string, unknown>>();
  const hidden = new Set(IDENTIFYING_COLUMNS[table]);
  return result.results
    .map((row) => Object.fromEntries(Object.entries(row).filter(([column]) => !hidden.has(column))))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
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
    for (const table of Object.keys(IDENTIFYING_COLUMNS)) {
      const direct = await rows(table, directRunId);
      // Never vacuous: each table the registration touches holds a row.
      expect(direct.length, table).toBeGreaterThan(0);
      expect(direct, table).toEqual(await rows(table, httpRunId));
    }
    // What the comparison hides is exactly the identifying set, no more: a
    // column added to a table joins the comparison unless it is listed here.
    for (const [table, hidden] of Object.entries(IDENTIFYING_COLUMNS)) {
      const columns = await env.DB.prepare(`SELECT name FROM pragma_table_info(?1)`)
        .bind(table)
        .all<{ name: string }>();
      expect(
        columns.results.map((column) => column.name),
        table,
      ).toEqual(expect.arrayContaining([...hidden]));
    }
  });

  it("refuses an unauthorized route with the same code and status through the port", async () => {
    // The port performs the same CORE authorization the HTTP path does; it is
    // not a bypass of it.
    await expect(
      directRegistrationPort(env as never, "parity").createRun({
        producerId: PRODUCER,
        sourceId: "api-source",
        externalIdNamespace: "test",
        externalSessionId: "parity-denied",
      }),
    ).rejects.toMatchObject({ status: 403, code: "inactive_ingest_route" });
    const denied = await post("/v1/runs", {
      producerId: PRODUCER,
      sourceId: "api-source",
      externalIdNamespace: "test",
      externalSessionId: "parity-denied-http",
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "inactive_ingest_route" });
  });

  it("refuses a deactivated client with the same code and status through the port", async () => {
    // Revocation is a row, not a key: the client still holds a valid secret
    // and an active route row, and both paths must answer with the client's
    // code, before either looks at the route.
    await env.DB.prepare("UPDATE ingest_clients SET active = 0 WHERE id = ?1").bind(CLIENT).run();
    try {
      const request = {
        producerId: PRODUCER,
        sourceId: SOURCE,
        externalIdNamespace: "test",
        externalSessionId: "parity-revoked",
      };
      await expect(
        directRegistrationPort(env as never, CLIENT).createRun(request),
      ).rejects.toMatchObject({ status: 403, code: "inactive_ingest_client" });
      // Not only the first operation: a port handed out earlier is refused too.
      const port = directRegistrationPort(env as never, CLIENT);
      await expect(port.addRunReport(1, TERMINAL_REPORT as never)).rejects.toMatchObject({
        status: 403,
        code: "inactive_ingest_client",
      });
      const denied = await post("/v1/runs", {
        ...request,
        externalSessionId: "parity-revoked-http",
      });
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({ error: "inactive_ingest_client" });
    } finally {
      await env.DB.prepare("UPDATE ingest_clients SET active = 1 WHERE id = ?1").bind(CLIENT).run();
    }
  });
});
