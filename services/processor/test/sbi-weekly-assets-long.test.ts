// A response larger than the fixed 2 MiB parse budget, partitioned locally.
// All values are generated from the synthetic two-week fixture.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import {
  CORE_MIGRATIONS_URL,
  migrationFiles,
  migrationSql,
} from "../../../packages/storage-d1/src/migrations.ts";
import { applyTestSql } from "./migration-setup.ts";
import { persistRun } from "../../../packages/collection/src/writer.ts";
import { sbiRunPlan } from "../../collector-sbi-securities/src/shared-run.ts";
import { assetHistoryArtifacts } from "../../collector-sbi-securities/src/asset-history.ts";
import {
  ASSET_HISTORY_SOURCE_KEY,
  assetHistoryViews,
} from "../../../packages/parsers/src/parsers/sbi-asset-history-schema.ts";
import { sbiAccountAssetsHistory as parser } from "../../../packages/parsers/src/parsers/sbi-account-assets-history.ts";
import { registerCollectionRun } from "../src/collection/index.ts";
import { parseJob } from "../src/worker.ts";
import { createD1ObservationReader } from "../../../packages/read-model/src/d1.ts";
import type { Artifact } from "../../collector-sbi-securities/src/types.ts";
import type { ArtifactMeta } from "../../../packages/parsers/src/types.ts";

let mf: Miniflare;
let env: Env;
let longBytes = 0;
let shardBytes: number[] = [];
let yearCount = 0;
let latestArtifact = 0;
const WEEKS = 312;
const fixture = () =>
  JSON.parse(
    readFileSync(
      new URL(
        "../../../tests/fixtures/observation-pipeline/sbi-parser-boundaries/account-assets-history.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as unknown;
const meta: ArtifactMeta = {
  id: 1,
  sourceId: "sbi-securities",
  dataset: "account-assets-history",
  runStatus: "success",
  runFailureCount: 0,
  url: null,
  mime: "application/json",
  fetchedAt: "2021-01-01T00:00:00Z",
  sha256: "0".repeat(64),
};

// Migration/bootstrap and bounded publication are fixture setup, separately
// budgeted like the existing Processor integration harnesses.
beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default {};",
      compatibilityDate: "2026-09-07",
      d1Databases: ["DB"],
      r2Buckets: ["EVIDENCE"],
    }),
  );
  const db = await mf.getD1Database("DB");
  for (const file of migrationFiles(CORE_MIGRATIONS_URL))
    await applyTestSql(db, migrationSql(CORE_MIGRATIONS_URL, file));
  await applyTestSql(
    db,
    readFileSync(new URL("../../../infra/bootstrap/ingest-clients.sql", import.meta.url), "utf8"),
  );
  env = {
    DB: db,
    EVIDENCE: await mf.getR2Bucket("EVIDENCE"),
    SHARED_R2_INGEST_ENABLED: "true",
    COLLECTION_INGEST_CLIENT: "processor-shared-r2",
  } as unknown as Env;
  const long = fixture();
  for (const view of assetHistoryViews(long)) {
    if (view.transitions === null) continue;
    const template = structuredClone(view.transitions[Object.keys(view.transitions).sort()[0]!]!);
    for (const key of Object.keys(view.transitions)) delete view.transitions[key];
    view.balances.length = 0;
    view.acquisitionCosts.length = 0;
    for (let i = 0; i < WEEKS; i++) {
      const time = 4071654000000 - (WEEKS - 1 - i) * 7 * 86400000;
      view.transitions[String(time)] = structuredClone(template);
      view.balances.push([time, template.ALL!.valuation]);
      view.acquisitionCosts.push([time, template.ALL!.acquisitionCost]);
    }
  }
  longBytes = new TextEncoder().encode(
    JSON.stringify(parser.parse(new TextEncoder().encode(JSON.stringify(long)), meta).observations),
  ).byteLength;
  const capture = async (runId: string, body: unknown, capturedAt: string) => {
    const bytes = new TextEncoder().encode(JSON.stringify(body, null, 2));
    const derived = await assetHistoryArtifacts({ body, bytes, capturedAt });
    const artifacts: Artifact[] = [
      {
        artifactKey: ASSET_HISTORY_SOURCE_KEY,
        dataset: "account-assets-history-source",
        mediaType: "application/json",
        role: "provider_response",
        body,
        bytes,
      },
      ...derived,
    ];
    const plan = await sbiRunPlan({
      runId,
      producerVersion: "synthetic-v1",
      attemptId: `attempt-${runId}`,
      startedAt: capturedAt,
      completedAt: capturedAt,
      status: "success",
      scope: "domestic",
      artifacts,
      failures: [],
    });
    expect(plan.run.providerOutcome).toBe("success");
    expect((await persistRun(env.EVIDENCE, plan)).outcome).toBe("persisted");
    let registered = await registerCollectionRun(env, { source: "sbi-securities", runId });
    // Continue only the protocol's persisted pending stages, never a refusal.
    for (let n = 0; registered.outcome === "pending" && n < 10; n++)
      registered = await registerCollectionRun(env, { source: "sbi-securities", runId });
    expect(registered).toMatchObject({ outcome: "registered", artifacts: artifacts.length });
    if (registered.outcome !== "registered") throw new Error("synthetic_registration_incomplete");
    const children = (
      await env.DB.prepare(
        "SELECT id,artifact_key FROM fetch_artifacts WHERE fetch_run_id=? AND dataset='account-assets-history' ORDER BY artifact_key",
      )
        .bind(registered.fetchRunId)
        .all<{ id: number; artifact_key: string }>()
    ).results;
    for (const child of children) {
      await env.DB.prepare(
        "INSERT INTO observation_parse_jobs(fetch_artifact_id,parser_name,parser_version,status) VALUES(?,?,?,'pending')",
      )
        .bind(child.id, parser.name, parser.version)
        .run();
      expect(
        await parseJob(
          env,
          {
            fetch_artifact_id: child.id,
            parser_name: parser.name,
            parser_version: parser.version,
            attempts: 0,
          },
          parser,
        ),
      ).toBe("parsed");
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM artifact_relations WHERE child_artifact_id=? AND relation='input'",
        )
          .bind(child.id)
          .first<number>("n"),
      ).toBe(2);
    }
    const raw = (await env.DB.prepare(
      "SELECT sha256,dataset,payload_fidelity,artifact_role FROM fetch_artifacts WHERE fetch_run_id=? AND artifact_key=?",
    )
      .bind(registered.fetchRunId, ASSET_HISTORY_SOURCE_KEY)
      .first<{
        sha256: string;
        dataset: string | null;
        payload_fidelity: string;
        artifact_role: string;
      }>())!;
    expect(raw).toMatchObject({
      dataset: null,
      payload_fidelity: "exact",
      artifact_role: "provider_response",
    });
    const stored = await env.EVIDENCE.get(`objects/${raw.sha256.slice(0, 2)}/${raw.sha256}`);
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(bytes);
    return { children, derived };
  };
  const first = await capture("weekly-long-synthetic", long, "2021-01-10T01:00:00.000Z");
  yearCount = first.children.length;
  shardBytes = first.derived
    .filter((a) => a.dataset === "account-assets-history")
    .map(
      (a) =>
        new TextEncoder().encode(
          JSON.stringify(
            parser.parse(new TextEncoder().encode(JSON.stringify(a.body)), meta).observations,
          ),
        ).byteLength,
    );
  const overlap = await capture("weekly-long-overlap", fixture(), "2021-01-17T01:00:00.000Z");
  latestArtifact = overlap.children[0]!.id;
}, 60_000);
afterAll(async () => {
  await mf?.dispose();
});

test("all retained weeks publish through bounded year shards and remain unique after overlap", async () => {
  expect(longBytes).toBeGreaterThan(2 * 1024 * 1024);
  expect(yearCount).toBeGreaterThan(5);
  expect(shardBytes).toHaveLength(yearCount);
  for (const bytes of shardBytes) expect(bytes).toBeLessThan(2 * 1024 * 1024);
  const reader = createD1ObservationReader(env.DB);
  for (const profile of ["full", "without-deposit"] as const) {
    const rows = await reader.listPortfolioValuationHistory({
      profile,
      metric: "valuation",
      offset: 0,
    });
    expect(rows).toHaveLength(WEEKS);
    expect(new Set(rows.map((r) => r.as_of)).size).toBe(WEEKS);
    expect(rows.slice(0, 2).map((r) => r.fetch_artifact_id)).toEqual([
      latestArtifact,
      latestArtifact,
    ]);
  }
  const firstPage = await reader.listPortfolioValuationHistory({ profile: "full", offset: 0 });
  expect(firstPage).toHaveLength(501);
  const nextPage = await reader.listPortfolioValuationHistory({ profile: "full", offset: 500 });
  const all = [...firstPage.slice(0, 500), ...nextPage];
  expect(all).toHaveLength(WEEKS * 3);
  expect(new Set(all.map((r) => `${r.as_of}/${r.metric}`)).size).toBe(WEEKS * 3);
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM valuation_observations").first<number>("n"),
  ).toBe(WEEKS * 24 + 48);
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM published_parse_runs WHERE parser_name=?")
      .bind(parser.name)
      .first<number>("n"),
  ).toBe(yearCount + 1);
});
