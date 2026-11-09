// Synthetic collector handoffs reach shared DATA registration and publication.
// The stage ignores summary aggregates; one successful savings unit publishes
// independently from another account's failed read.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import {
  CORE_MIGRATIONS_URL,
  migrationFiles,
  migrationSql,
} from "../../../packages/storage-d1/src/migrations.ts";
import { persistRun } from "../../../packages/collection/src/writer.ts";
import { collectSbiShinsei } from "../../collector-sbi-shinsei/src/collector.ts";
import { buildSharedRunPlan } from "../../collector-sbi-shinsei/src/shared-collection.ts";
import { registerCollectionRun } from "../src/collection/index.ts";
import { sweep } from "../src/worker.ts";
import { applyTestReadMigrations, applyTestSql } from "./migration-setup.ts";

let mf: Miniflare;
let env: Env;
beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default {};",
      compatibilityDate: "2026-09-07",
      d1Databases: ["DB", "READ"],
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
  const read = await mf.getD1Database("READ");
  await applyTestReadMigrations(read);
  env = {
    DB: db,
    READ: read,
    EVIDENCE: await mf.getR2Bucket("EVIDENCE"),
    SHARED_R2_INGEST_ENABLED: "true",
    COLLECTION_INGEST_CLIENT: "processor-shared-r2",
  } as unknown as Env;
}, 60_000);

test("a complete history unit publishes from shared DATA when another savings account failed", async () => {
  const fixtures = JSON.parse(
    readFileSync(
      new URL("../../collector-sbi-shinsei/test/fixtures/core-responses.json", import.meta.url),
      "utf8",
    ),
  );
  const history = JSON.parse(
    readFileSync(
      new URL(
        "../../../tests/fixtures/observation-pipeline/sbi-shinsei-parser-boundaries/savings-activity.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  // Registration receipt time follows collection time; keep this synthetic run in the past.
  const now = new Date("2001-01-15T03:00:00Z");
  history.scope.fromDate = "19990101";
  history.scope.toDate = "20010115";
  const activity = history.response.responseParam.activity.responseParam;
  activity.fromDate = "1999/01/01";
  activity.toDate = "2001/01/15";
  for (const row of activity.activityDetails) row.postingDate = "2000/12/01";
  history.response.responseParam.sysTimeForCsvDownload = "20010115120000";
  fixtures.topBalances.responseParam.overview.responseParam.savingsDetails = [
    {
      accountNo: history.scope.accountNo,
      currency: history.scope.currency,
      productCode: history.scope.productCode,
      balance: "1000",
      yenEqui: "1000",
    },
    {
      accountNo: "000000000000002",
      currency: "USD",
      productCode: "621",
      balance: "10.00",
      yenEqui: "1000",
    },
  ];
  const output = await collectSbiShinsei({
    credentialJson: JSON.stringify({
      branchNumber: "000",
      accountNumber: "0000000",
      powerDirectPassword: "synthetic-password",
    }),
    collectHandoff: async () =>
      JSON.stringify({
        ok: true,
        responses: Object.fromEntries(
          ["topBalances", "balanceSummary", "exchangeRate", "yenDeposit"].map((key) => [
            key,
            JSON.stringify(fixtures[key]),
          ]),
        ),
        history: {
          fromDate: history.scope.fromDate,
          toDate: history.scope.toDate,
          accounts: [
            {
              accountNo: history.scope.accountNo,
              currency: history.scope.currency,
              productCode: history.scope.productCode,
              raw: JSON.stringify(history.response),
            },
            {
              accountNo: "000000000000002",
              currency: "USD",
              productCode: "621",
              errorCode: "history_read_failed",
            },
          ],
        },
      }),
    now: () => now,
  });
  expect(output.failures).toMatchObject([
    { operation: "read:history-0002", errorType: "ProviderReadError" },
  ]);
  const runId = "00000000-0000-4000-8000-000000001230";
  const plan = await buildSharedRunPlan({
    manifest: {
      schemaVersion: "sbi-shinsei-worker-poc-v1",
      source: "sbi-shinsei",
      runId,
      startedAt: now.toISOString(),
      completedAt: now.toISOString(),
      status: "partial",
      liveReadsEnabled: true,
      artifacts: [],
      failures: output.failures,
    },
    artifacts: output.artifacts,
    identity: { attemptId: "synthetic-attempt-1230" },
  });
  expect(plan.run.units).toMatchObject([
    { coverageStatus: "complete", artifactCount: 2 },
    { coverageStatus: "partial", artifactCount: 0 },
  ]);
  expect((await persistRun(env.EVIDENCE, plan)).outcome).toBe("persisted");
  expect(await registerCollectionRun(env, { source: "sbi-shinsei", runId })).toMatchObject({
    outcome: "registered",
    artifacts: 8,
  });
  expect(await sweep(env, { lane: "incremental" })).toMatchObject({ parsed: 1, error: 0 });
  expect(
    (
      await env.DB.prepare(`SELECT p.parser_version,p.status,r.status AS run_status,
    (SELECT COUNT(*) FROM transaction_observations t WHERE t.parse_run_id=p.id) AS money_rows,
    c.unit_scope,c.unit_report_outcome,c.parent_run_status,c.parent_run_failure_count
    FROM published_parse_runs x JOIN parse_runs p ON p.id=x.parse_run_id
    JOIN fetch_artifacts a ON a.id=p.fetch_artifact_id
    JOIN observation_fetch_runs r ON r.id=a.fetch_run_id
    JOIN parse_coverage_claims c ON c.parse_run_id=p.id
    WHERE p.parser_name='sbi-shinsei-savings-activity'`).all()
    ).results,
  ).toEqual([
    {
      parser_version: "0.1.0",
      status: "ok",
      run_status: "partial",
      money_rows: 31,
      unit_scope: "unit",
      unit_report_outcome: "success",
      parent_run_status: "partial",
      parent_run_failure_count: 1,
    },
  ]);
}, 60_000);
afterAll(async () => {
  await mf?.dispose();
});

test("the observed summary fields survive capture and publish only one amount-free stage", async () => {
  const fixtures = JSON.parse(
    readFileSync(
      new URL("../../collector-sbi-shinsei/test/fixtures/core-responses.json", import.meta.url),
      "utf8",
    ),
  ) as Record<string, unknown>;
  const now = new Date("2026-08-31T00:00:00.000Z");
  const output = await collectSbiShinsei({
    credentialJson: JSON.stringify({
      branchNumber: "000",
      accountNumber: "0000000",
      powerDirectPassword: "synthetic-password",
    }),
    collectHandoff: async () =>
      JSON.stringify({
        ok: true,
        responses: Object.fromEntries(
          ["topBalances", "balanceSummary", "exchangeRate", "yenDeposit"].map((key) => [
            key,
            JSON.stringify(fixtures[key]),
          ]),
        ),
      }),
    now: () => now,
  });
  expect(output.failures).toEqual([]);
  expect(output.artifacts).toHaveLength(5);
  const runId = "00000000-0000-4000-8000-000000001215";
  const plan = await buildSharedRunPlan({
    manifest: {
      schemaVersion: "sbi-shinsei-worker-poc-v1",
      source: "sbi-shinsei",
      runId,
      startedAt: now.toISOString(),
      completedAt: now.toISOString(),
      status: "success",
      liveReadsEnabled: true,
      artifacts: [],
      failures: output.failures,
    },
    artifacts: output.artifacts,
    identity: { attemptId: "synthetic-attempt-1215" },
  });
  expect((await persistRun(env.EVIDENCE, plan)).outcome).toBe("persisted");
  expect(await registerCollectionRun(env, { source: "sbi-shinsei", runId })).toMatchObject({
    outcome: "registered",
    artifacts: 6,
  });
  expect(await sweep(env)).toMatchObject({ parsed: 4, error: 0 });
  expect(
    (
      await env.DB.prepare(
        `SELECT p.parser_version,p.status,r.status AS run_status,v.metric,v.amount_text
         FROM published_parse_runs x JOIN parse_runs p ON p.id=x.parse_run_id
         JOIN fetch_artifacts a ON a.id=p.fetch_artifact_id
         JOIN observation_fetch_runs r ON r.id=a.fetch_run_id
         JOIN valuation_observations v ON v.parse_run_id=p.id
         WHERE p.parser_name='sbi-shinsei-balance-summary-and-stage'`,
      ).all()
    ).results,
  ).toEqual([
    {
      parser_version: "0.1.2",
      status: "ok",
      run_status: "success",
      metric: "provider_customer_category",
      amount_text: null,
    },
  ]);
  expect(
    await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM balance_observations b JOIN parse_runs p ON p.id=b.parse_run_id
       WHERE p.parser_name='sbi-shinsei-balance-summary-and-stage'`,
    ).first<number>("n"),
  ).toBe(0);
  expect(await sweep(env)).toMatchObject({ parsed: 0, error: 0 });
}, 60_000);
