// Synthetic capture -> real registration -> parse/publication -> production
// reader. No test-only selection SQL stands in for the live deduplication.
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
import { assetHistoryArtifacts } from "../../collector-sbi-securities/src/asset-history.ts";
import { ASSET_HISTORY_SOURCE_KEY } from "../../../packages/parsers/src/parsers/sbi-asset-history-schema.ts";
import { sbiRunPlan } from "../../collector-sbi-securities/src/shared-run.ts";
import { registerCollectionRun } from "../src/collection/index.ts";
import { parseJob } from "../src/worker.ts";
import { createD1ObservationReader } from "../../../packages/read-model/src/d1.ts";
import { sbiAccountAssetsHistory as parser } from "../../../packages/parsers/src/parsers/sbi-account-assets-history.ts";
import { assetHistoryViews } from "../../../packages/parsers/src/parsers/sbi-asset-history-schema.ts";
import { artifactDataset } from "../../../packages/application/src/collection/descriptors.ts";

let mf: Miniflare;
let env: Env;
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
}, 60_000);
afterAll(async () => {
  await mf?.dispose();
});
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

import type { PortfolioValuationHistoryRow } from "../../../packages/read-model/src/portfolio-valuation-history.ts";
let first = 0;
let second = 0;
let after: PortfolioValuationHistoryRow[] = [];
let reparsed: PortfolioValuationHistoryRow[] = [];
const query = { profile: "full" as const, metric: "valuation" as const, offset: 0 };
const capture = async (runId: string, body: unknown, capturedAt: string) => {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const derived = await assetHistoryArtifacts({
    body,
    bytes,
    capturedAt: new Date(capturedAt).toISOString(),
  });
  const plan = await sbiRunPlan({
    runId,
    producerVersion: "synthetic-v1",
    attemptId: `attempt-${runId}`,
    startedAt: capturedAt,
    completedAt: capturedAt,
    status: "success",
    scope: "domestic",
    artifacts: [
      {
        artifactKey: ASSET_HISTORY_SOURCE_KEY,
        dataset: "account-assets-history-source",
        mediaType: "application/json",
        role: "provider_response",
        body,
        bytes,
      },
      ...derived,
    ],
    failures: [],
  });
  expect((await persistRun(env.EVIDENCE, plan)).outcome).toBe("persisted");
  expect(await registerCollectionRun(env, { source: "sbi-securities", runId })).toMatchObject({
    outcome: "registered",
  });
  const artifact = (await env.DB.prepare(
    "SELECT id,dataset FROM fetch_artifacts WHERE source_id='sbi-securities' AND artifact_key='account-assets-history-2099.json' ORDER BY id DESC LIMIT 1",
  ).first<{ id: number; dataset: string }>())!;
  expect(artifact.dataset).toBe("account-assets-history");
  return artifact.id;
};
const publish = async (artifactId: number, version: string) => {
  await env.DB.prepare(
    "INSERT INTO observation_parse_jobs(fetch_artifact_id,parser_name,parser_version,status) VALUES(?,?,?,'pending')",
  )
    .bind(artifactId, parser.name, version)
    .run();
  const outcome = await parseJob(
    env,
    {
      fetch_artifact_id: artifactId,
      parser_name: parser.name,
      parser_version: version,
      attempts: 0,
    },
    { ...parser, version },
  );
  expect({
    outcome,
    failures: (
      await env.DB.prepare(
        "SELECT last_error_code FROM observation_parse_jobs WHERE fetch_artifact_id=? AND parser_version=?",
      )
        .bind(artifactId, version)
        .all()
    ).results,
  }).toEqual({ outcome: "parsed", failures: [{ last_error_code: null }] });
};

test("an initial weekly capture registers, publishes and reads each point once", async () => {
  const reader = createD1ObservationReader(env.DB);
  first = await capture("weekly-synthetic-1", fixture(), "2020-01-10T01:00:00Z");
  await publish(first, parser.version);
  const before = await reader.listPortfolioValuationHistory({
    profile: "full",
    metric: "valuation",
    offset: 0,
  });
  expect(before.map((r) => [r.as_of, r.amount_minor])).toEqual([
    ["2099-01-10", "155"],
    ["2099-01-03", "150"],
  ]);
});

test("a shorter corrected capture updates one point, retains old weeks and does not revive null metrics", async () => {
  const reader = createD1ObservationReader(env.DB);
  const corrected = fixture();
  for (const view of assetHistoryViews(corrected)) {
    if (view.transitions === null) continue;
    const times = Object.keys(view.transitions).sort();
    delete view.transitions[times[0]!];
    view.balances.shift();
    view.acquisitionCosts.shift();
    const rows = view.transitions[times[1]!]!;
    rows.DOMESTIC_STOCK_SPOT!.valuation += 100;
    rows.ALL!.valuation += 100;
    rows.ALL!.profitLoss = null;
    view.balances[0]![1] += 100;
  }
  second = await capture("weekly-synthetic-2", corrected, "2020-01-17T01:00:00Z");
  await publish(second, parser.version);
  after = await reader.listPortfolioValuationHistory(query);
  expect(after.map((r) => [r.as_of, r.amount_minor])).toEqual([
    ["2099-01-10", "255"],
    ["2099-01-03", "150"],
  ]);
  expect(after.map((r) => r.fetch_artifact_id)).toEqual([second, first]);
  expect(
    await reader.listPortfolioValuationHistory({ ...query, from: "2099-01-10", to: "2099-01-10" }),
  ).toHaveLength(1);
  expect(
    (await reader.listPortfolioValuationHistory({ ...query, offset: 1 })).map((r) => r.as_of),
  ).toEqual(["2099-01-03"]);
  const profits = await reader.listPortfolioValuationHistory({ ...query, metric: "profit_loss" });
  expect(profits.map((r) => r.as_of)).toEqual(["2099-01-03"]);
  expect(
    await reader.listPortfolioValuationHistory({
      ...query,
      profile: "without-deposit",
      category: "DOMESTIC_DEPOSIT",
    }),
  ).toEqual([]);
});

test("a newer parser publication keeps logical keys unique and old evidence archived", async () => {
  const reader = createD1ObservationReader(env.DB);
  await publish(second, "0.1.2");
  reparsed = await reader.listPortfolioValuationHistory(query);
  expect(reparsed.map((r) => [r.as_of, r.amount_minor])).toEqual(
    after.map((r) => [r.as_of, r.amount_minor]),
  );
  expect(reparsed[0]!.parser_version).toBe("0.1.2");
  expect(
    new Set(
      reparsed.map((r) =>
        [r.source_id, r.source_account, r.subject, r.metric, r.currency, r.as_of].join("/"),
      ),
    ).size,
  ).toBe(2);
  // Revision evidence stays append-only, including superseded parse rows.
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM valuation_observations").first<number>("n"),
  ).toBe(92);
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM published_parse_runs WHERE parser_name=?")
      .bind(parser.name)
      .first<number>("n"),
  ).toBe(2);
  expect((await reader.getArtifact(second))?.parseRuns).toHaveLength(2);
});

test("a newer failed parse cannot displace published history", async () => {
  const reader = createD1ObservationReader(env.DB);
  const version = "0.1.3";
  await env.DB.prepare(
    "INSERT INTO observation_parse_jobs(fetch_artifact_id,parser_name,parser_version,status) VALUES(?,?,?,'pending')",
  )
    .bind(second, parser.name, version)
    .run();
  expect(
    await parseJob(
      env,
      { fetch_artifact_id: second, parser_name: parser.name, parser_version: version, attempts: 0 },
      {
        ...parser,
        version,
        parse: () => {
          throw new Error("synthetic_parser_rejection");
        },
      },
    ),
  ).toBe("error");
  expect(await reader.listPortfolioValuationHistory(query)).toEqual(reparsed);
});

test("v5 adds only weekly history and keeps every older registration unmapped for it", () => {
  const artifact = {
    artifactKey: "account-assets-history-2099.json",
    role: "collector_derived",
    mediaType: "application/json",
  };
  for (const version of [
    "terminal-registration-v1",
    "terminal-registration-v2",
    "terminal-registration-v3",
    "terminal-registration-v4",
  ])
    expect(artifactDataset("sbi-securities", artifact, version)).toBeNull();
  expect(artifactDataset("sbi-securities", artifact)).toBe("account-assets-history");
});
