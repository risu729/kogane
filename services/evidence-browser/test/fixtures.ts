import { env } from "cloudflare:test";
import { expect } from "vitest";
import ingest from "../../raw-evidence/src/worker";

const secret = "synthetic-test-secret-at-least-twenty-characters";
const ingestEnv = () => ({
  ...env,
  INGEST_CLIENT_KEYS: JSON.stringify({ "evidence-test": secret }),
});
export async function seedRegistry() {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO producers (id,kind,display_name) VALUES ('evidence-test','collector','Synthetic fixture')",
    ),
    env.DB.prepare(
      "INSERT INTO sources (id,provider,display_name) VALUES ('other-test','Fixture','Fixture')",
    ),
    env.DB.prepare(
      "INSERT INTO ingest_clients (id,display_name) VALUES ('evidence-test','Fixture')",
    ),
    env.DB.prepare(
      "INSERT INTO ingest_client_producers (ingest_client_id,producer_id) VALUES ('evidence-test','evidence-test')",
    ),
    ...["sony-bank", "other-test", "kogane-synthetic"].flatMap((source) => [
      env.DB.prepare(
        "INSERT INTO producer_sources (producer_id,source_id) VALUES ('evidence-test',?)",
      ).bind(source),
      env.DB.prepare(
        "INSERT INTO ingest_client_routes (ingest_client_id,producer_id,source_id) VALUES ('evidence-test','evidence-test',?)",
      ).bind(source),
    ]),
  ]);
}
/**
 * Publish a successful parse run the way the pipeline writer does
 * (docs/publication-gate.md): move the (artifact, parser) pointer and record
 * the event. A parse run seeded directly with status 'ok' is an unadopted
 * result until this runs, and no normal reader shows it.
 */
export async function publishParse(parseRunId: number, publishedAt = "2026-09-07T00:00:00Z") {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO publication_events(fetch_artifact_id,parser_name,previous_parse_run_id,new_parse_run_id,kind,actor,reason,occurred_at)
       SELECT p.fetch_artifact_id,p.parser_name,
         (SELECT x.parse_run_id FROM published_parse_runs x WHERE x.fetch_artifact_id=p.fetch_artifact_id AND x.parser_name=p.parser_name),
         p.id,'normal','pipeline','parse_ok',?2 FROM parse_runs p WHERE p.id=?1`,
    ).bind(parseRunId, publishedAt),
    env.DB.prepare(
      `INSERT INTO published_parse_runs(fetch_artifact_id,parser_name,parse_run_id,parser_version,published_at,publication_kind)
       SELECT p.fetch_artifact_id,p.parser_name,p.id,p.parser_version,?2,'normal' FROM parse_runs p WHERE p.id=?1
       ON CONFLICT(fetch_artifact_id,parser_name) DO UPDATE SET parse_run_id=excluded.parse_run_id,
         parser_version=excluded.parser_version,published_at=excluded.published_at,publication_kind='normal',release_id=NULL`,
    ).bind(parseRunId, publishedAt),
  ]);
}
/**
 * Replace one published run by a later run of the same artifact and parser:
 * the supersession pointer and the publication pointer move together, as the
 * writer's publish batch does.
 */
export async function supersedeParse(oldId: number, newId: number) {
  await env.DB.prepare("UPDATE parse_runs SET superseded_by_parse_run_id=? WHERE id=?")
    .bind(newId, oldId)
    .run();
  await publishParse(newId);
}
async function post(path: string, body: unknown) {
  const response = await ingest.fetch(
    new Request(`https://fixture.test${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer evidence-test.${secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    ingestEnv(),
  );
  expect(response.status, `synthetic seed ${path}: ${await response.clone().text()}`).toBe(201);
  return response.json() as Promise<Record<string, any>>;
}
export async function seedRun(
  options: {
    source?: string;
    outcome?: string;
    count?: number;
    sealed?: boolean;
    excluded?: boolean;
    body?: string;
    dataset?: string;
    fetchUnitKey?: string;
  } = {},
) {
  const { runId } = await post("/v1/runs", {
    producerId: "evidence-test",
    sourceId: options.source ?? "sony-bank",
    externalIdNamespace: "fixture",
    externalSessionId: crypto.randomUUID(),
  });
  const artifacts = [];
  const unit = options.fetchUnitKey
    ? await post(`/v1/runs/${runId}/units`, {
        unitKind: "account",
        unitKey: options.fetchUnitKey,
        terminalReportRequired: false,
      })
    : null;
  for (let i = 0; i < (options.count ?? 0); i++) {
    const bytes = new TextEncoder().encode(
      options.body ?? JSON.stringify({ synthetic: true, index: i }),
    );
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join(
      "",
    );
    const put = await ingest.fetch(
      new Request(`https://fixture.test/v1/runs/${runId}/objects/${sha256}`, {
        method: "PUT",
        headers: {
          authorization: `Bearer evidence-test.${secret}`,
          "content-length": String(bytes.length),
          "x-kogane-byte-size": String(bytes.length),
        },
        body: bytes,
      }),
      ingestEnv(),
    );
    expect([200, 201]).toContain(put.status);
    const artifactKey = `synthetic-${i}.json`;
    const result = await post(`/v1/runs/${runId}/artifacts`, {
      artifactKey,
      ...(options.dataset ? { dataset: options.dataset } : {}),
      ...(unit ? { fetchUnitId: unit.unitId } : {}),
      artifactRole: "collector_summary",
      payloadFidelity: "generated",
      containerKind: "single",
      lineageDisposition: "not_applicable",
      sha256,
      byteSize: bytes.length,
      declaredMediaType: options.body ? "text/html" : "application/json",
      mediaTypeBasis: "manifest",
    });
    artifacts.push({ artifactKey, sha256, descriptorSha256: result.descriptorSha256 });
  }
  await post(`/v1/runs/${runId}/reports`, {
    reportKey: "terminal",
    reportKind: "terminal",
    normalizedOutcome: options.outcome ?? "success",
    completedAtMs: 1_788_324_000_000,
    completedAtBasis: "manifest",
    declaredArtifactCount: artifacts.length,
    artifactCountScope: "all_catalogued",
  });
  if (options.sealed !== false)
    await post(`/v1/runs/${runId}/seal`, {
      artifacts,
      declarationBasis: "producer_manifest",
      externalAttemptId: crypto.randomUUID(),
      startedAtMs: 1_788_323_900_000,
    });
  if (options.excluded)
    await env.DB.prepare(
      "INSERT INTO fetch_run_annotations VALUES (?, 'exclude_from_financial_views', 'synthetic-fixture', 0)",
    )
      .bind(runId)
      .run();
  const rows = await env.DB.prepare(
    "SELECT id,sha256,byte_size FROM fetch_artifacts WHERE fetch_run_id=? ORDER BY id",
  )
    .bind(runId)
    .all<{ id: number; sha256: string; byte_size: number }>();
  return { id: Number(runId), artifacts: rows.results };
}
