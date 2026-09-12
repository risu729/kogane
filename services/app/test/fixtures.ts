import { env } from "cloudflare:test";
import { seedFixturePost, seedFixtureObject } from "./ingest-fixtures";

export async function seedRegistry() {
  await env.DB.batch([
    // Historical Vpass fixtures are synthetic and explicitly re-enable their test client.
    env.DB.prepare("UPDATE ingest_clients SET active=1 WHERE id='collector-r2-vpass'"),
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
 * result until this runs, and no normal reader shows it. Like the writer it
 * does nothing for a run that is already the pointer, so it can never append
 * the self-referencing event migration 0036 rejects.
 */
export async function publishParse(parseRunId: number, publishedAt = "2026-09-07T00:00:00Z") {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO publication_events(fetch_artifact_id,parser_name,previous_parse_run_id,new_parse_run_id,kind,actor,reason,occurred_at)
       SELECT p.fetch_artifact_id,p.parser_name,
         (SELECT x.parse_run_id FROM published_parse_runs x WHERE x.fetch_artifact_id=p.fetch_artifact_id AND x.parser_name=p.parser_name),
         p.id,'normal','pipeline','parse_ok',?2 FROM parse_runs p WHERE p.id=?1
         AND NOT EXISTS(SELECT 1 FROM published_parse_runs x WHERE x.parse_run_id=p.id)`,
    ).bind(parseRunId, publishedAt),
    env.DB.prepare(
      `INSERT INTO published_parse_runs(fetch_artifact_id,parser_name,parse_run_id,parser_version,published_at,publication_kind)
       SELECT p.fetch_artifact_id,p.parser_name,p.id,p.parser_version,?2,'normal' FROM parse_runs p WHERE p.id=?1
         AND NOT EXISTS(SELECT 1 FROM published_parse_runs x WHERE x.parse_run_id=p.id)
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
const post = (path: string, body: unknown) => seedFixturePost("evidence-test", path, body);
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
    /**
     * Several independent fetch units in one run, each with its own terminal
     * report and its own artifacts (design review D13). `count` artifacts are
     * created per unit; `options.count` still creates unattributed artifacts.
     */
    units?: { key: string; outcome: "success" | "failed"; count: number }[];
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
  const extraUnits: { unitId: number; spec: { key: string; outcome: string; count: number } }[] =
    [];
  for (const spec of options.units ?? []) {
    const created = await post(`/v1/runs/${runId}/units`, {
      unitKind: "connection",
      unitKey: spec.key,
      terminalReportRequired: true,
    });
    extraUnits.push({ unitId: created.unitId, spec });
  }
  const plan: { index: number; unitId: number | null }[] = [];
  for (let i = 0; i < (options.count ?? 0); i++)
    plan.push({ index: i, unitId: unit?.unitId ?? null });
  for (const entry of extraUnits)
    for (let i = 0; i < entry.spec.count; i++)
      plan.push({ index: plan.length, unitId: entry.unitId });
  for (const step of plan) {
    const i = step.index;
    const bytes = new TextEncoder().encode(
      options.body ?? JSON.stringify({ synthetic: true, index: i }),
    );
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join(
      "",
    );
    await seedFixtureObject("evidence-test", runId, sha256, bytes);
    const artifactKey = `synthetic-${i}.json`;
    const result = await post(`/v1/runs/${runId}/artifacts`, {
      artifactKey,
      ...(options.dataset ? { dataset: options.dataset } : {}),
      ...(step.unitId === null ? {} : { fetchUnitId: step.unitId }),
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
  for (const entry of extraUnits)
    await post(`/v1/units/${entry.unitId}/reports`, {
      reportKey: "terminal",
      reportKind: "terminal",
      normalizedOutcome: entry.spec.outcome,
      completedAtMs: 1_788_324_000_000,
      completedAtBasis: "manifest",
      declaredArtifactCount: entry.spec.count,
      artifactCountScope: "direct",
      ...(entry.spec.outcome === "success" ? {} : { safeFailureCode: "collector-failed" }),
    });
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
