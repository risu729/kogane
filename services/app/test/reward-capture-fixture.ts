// Synthetic reward captures with their declared dataset families.
// Uses the ingest fixture contract; no sealed artifact is edited afterwards.
import { env } from "cloudflare:test";
import { seedFixturePost, seedFixtureObject } from "./ingest-fixtures";
import { publishParse } from "./fixtures";

export async function seedRewardCapture(
  sourceId = "v-point",
  datasets = ["balance-info", "smfg-point", "history-page-0001"],
  connection = "",
) {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO producer_sources(producer_id,source_id) VALUES('evidence-test',?)",
    ).bind(sourceId),
    env.DB.prepare(
      "INSERT OR IGNORE INTO ingest_client_routes(ingest_client_id,producer_id,source_id) VALUES('evidence-test','evidence-test',?)",
    ).bind(sourceId),
  ]);
  const post = (path: string, body: unknown) => seedFixturePost("evidence-test", path, body);
  const { runId } = await post("/v1/runs", {
    producerId: "evidence-test",
    sourceId,
    externalIdNamespace: "fixture",
    externalSessionId: crypto.randomUUID(),
  });
  const inventory = [];
  for (const dataset of datasets) {
    const unit =
      sourceId === "myjcb" && dataset === "jpoint-balance"
        ? await post(`/v1/runs/${runId}/units`, {
            unitKind: "reward-balance",
            unitKey: `${connection}:j-point`,
            terminalReportRequired: true,
          })
        : null;
    const bytes = new TextEncoder().encode(JSON.stringify({ synthetic: true, dataset }));
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join(
      "",
    );
    await seedFixtureObject("evidence-test", runId, sha256, bytes);
    const artifactKey = `${connection ? `${connection}/` : ""}${dataset}.json`;
    const result = await post(`/v1/runs/${runId}/artifacts`, {
      artifactKey,
      dataset,
      ...(unit ? { fetchUnitId: unit.unitId } : {}),
      artifactRole: "provider_response",
      payloadFidelity: "exact",
      containerKind: "single",
      lineageDisposition: "not_applicable",
      sha256,
      byteSize: bytes.length,
      declaredMediaType: "application/json",
      mediaTypeBasis: "response_header",
    });
    inventory.push({ artifactKey, sha256, descriptorSha256: result.descriptorSha256 });
    if (unit)
      await post(`/v1/units/${unit.unitId}/reports`, {
        reportKey: "terminal",
        reportKind: "terminal",
        normalizedOutcome: "success",
        completedAtMs: 1_788_324_000_000,
        completedAtBasis: "manifest",
        declaredArtifactCount: 1,
        artifactCountScope: "direct",
      });
  }
  await post(`/v1/runs/${runId}/reports`, {
    reportKey: "terminal",
    reportKind: "terminal",
    normalizedOutcome: "success",
    completedAtMs: 1_788_324_000_000,
    completedAtBasis: "manifest",
    declaredArtifactCount: inventory.length,
    artifactCountScope: "all_catalogued",
  });
  await post(`/v1/runs/${runId}/seal`, {
    artifacts: inventory,
    declarationBasis: "producer_manifest",
    externalAttemptId: crypto.randomUUID(),
    startedAtMs: 1_788_323_900_000,
  });
  const rows = await env.DB.prepare(
    "SELECT id,dataset FROM fetch_artifacts WHERE fetch_run_id=? ORDER BY id",
  )
    .bind(runId)
    .all<{ id: number; dataset: string }>();
  for (const artifact of sourceId === "v-point" ? rows.results.slice(1) : []) {
    const name = artifact.dataset === "smfg-point" ? "v-point-smfg-point" : "v-point-history-page";
    const parsed =
      await env.DB.prepare(`INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
      VALUES(?,?,'1.0.0','2026-09-07','ok','[]') RETURNING id`)
        .bind(artifact.id, name)
        .first<{ id: number }>();
    await publishParse(parsed!.id);
  }
  return { id: Number(runId), artifacts: rows.results };
}
