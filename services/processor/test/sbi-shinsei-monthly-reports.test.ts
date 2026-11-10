// Synthetic report evidence follows the actual collector plan and registration path.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import {
  CORE_MIGRATIONS_URL,
  migrationFiles,
  migrationSql,
} from "../../../packages/storage-d1/src/migrations.ts";
import { persistRun } from "../../../packages/collection/src/writer.ts";
import { buildSharedRunPlan } from "../../collector-sbi-shinsei/src/shared-collection.ts";
import { parseCollectionResult } from "../../collector-sbi-shinsei/src/local/windows-chrome-collector.ts";
import { storedReportPeriods } from "../../collector-sbi-shinsei/src/monthly-reports.ts";
import {
  PDF_TEXT,
  reportListFixture,
  reportDownloadFixture,
} from "../../collector-sbi-shinsei/test/monthly-report-fixtures.ts";
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
afterAll(async () => {
  await mf?.dispose();
});
const core = JSON.parse(
  readFileSync(
    new URL("../../collector-sbi-shinsei/test/fixtures/core-responses.json", import.meta.url),
    "utf8",
  ),
) as Record<string, unknown>;
async function capture(runId: string, stored: string[], failed = false, changed = false) {
  const offered = ["2099-01", "2099-02"];
  const selected = stored.length === 0 ? [...offered].reverse() : ["2099-02"];
  const documents = {
    list: JSON.stringify(reportListFixture(offered)),
    downloads: selected.map((period) => ({
      year: period.slice(0, 4),
      month: period.slice(5),
      ...(failed && period === "2099-01"
        ? { errorCode: "report_read_failed" }
        : {
            raw: JSON.stringify(
              reportDownloadFixture(period, PDF_TEXT + period + (changed ? " revision" : "")),
            ),
          }),
    })),
  };
  const output = parseCollectionResult(
    JSON.stringify({
      ok: true,
      responses: Object.fromEntries(
        ["topBalances", "balanceSummary", "exchangeRate", "yenDeposit"].map((key) => [
          key,
          JSON.stringify(core[key]),
        ]),
      ),
      documents,
    }),
    new Date("2026-08-31T00:00:00.000Z"),
    stored,
  );
  const plan = await buildSharedRunPlan({
    manifest: {
      schemaVersion: "sbi-shinsei-worker-poc-v1",
      source: "sbi-shinsei",
      runId,
      startedAt: "2026-08-31T00:00:00.000Z",
      completedAt: "2026-08-31T00:00:01.000Z",
      status: output.failures.length > 0 ? "partial" : "success",
      liveReadsEnabled: true,
      artifacts: [],
      failures: output.failures,
    },
    artifacts: output.artifacts,
    identity: { attemptId: `attempt-${runId}` },
  });
  expect((await persistRun(env.EVIDENCE, plan)).outcome).toBe("persisted");
  expect(await registerCollectionRun(env, { source: "sbi-shinsei", runId })).toMatchObject({
    outcome: "registered",
  });
  return plan;
}
test("all offered reports are private immutable month/hash evidence with metadata-only publication", async () => {
  const first = await capture("00000000-0000-4000-8000-000000001247", []);
  expect(first.run.units.map((unit) => unit.unitKey).sort()).toEqual([
    "monthly-report-2099-01",
    "monthly-report-2099-02",
  ]);
  expect(first.run.ranges.map((range) => range.startValue).sort()).toEqual(["2099-01", "2099-02"]);
  const pdfs = first.artifacts.filter((artifact) => artifact.role === "provider_document");
  expect(pdfs).toHaveLength(2);
  expect(pdfs.every((artifact) => artifact.artifactKey.endsWith(`-${artifact.sha256}.pdf`))).toBe(
    true,
  );
  expect(await storedReportPeriods(env.DB)).toEqual(["2099-02", "2099-01"]);
  expect(await sweep(env)).toMatchObject({ parsed: 6, error: 0 });
  expect(
    (
      await env.DB.prepare(
        `SELECT c.mode,c.completeness,c.membership_complete,c.observed_count,c.expected_count FROM parse_coverage_claims c JOIN published_parse_runs x ON x.parse_run_id=c.parse_run_id JOIN parse_runs p ON p.id=x.parse_run_id WHERE p.parser_name='sbi-shinsei-monthly-report-metadata'`,
      ).all()
    ).results,
  ).toEqual(
    Array(2).fill({
      mode: "evidence-only",
      completeness: "complete",
      membership_complete: 0,
      observed_count: 1,
      expected_count: 1,
    }),
  );
  const before = new Set((await env.EVIDENCE.list()).objects.map((object) => object.key));
  const later = await capture(
    "00000000-0000-4000-8000-000000001248",
    await storedReportPeriods(env.DB),
  );
  const latest = later.artifacts.filter((artifact) => artifact.role === "provider_document");
  expect(latest).toHaveLength(1);
  expect(latest[0]!.sha256).toBe(pdfs[0]!.sha256);
  expect(
    (await env.EVIDENCE.list()).objects.filter((object) => !before.has(object.key)),
  ).toHaveLength(2);
  expect(await sweep(env)).toMatchObject({ parsed: 5, error: 0 });
  for (const table of [
    "transaction_observations",
    "balance_observations",
    "position_observations",
    "valuation_observations",
  ])
    expect(
      await env.DB.prepare(
        `SELECT count(*) AS n FROM ${table} o JOIN parse_runs p ON p.id=o.parse_run_id WHERE p.parser_name='sbi-shinsei-monthly-report-metadata'`,
      ).first<number>("n"),
    ).toBe(0);
  const revision = await capture(
    "00000000-0000-4000-8000-000000001249",
    await storedReportPeriods(env.DB),
    false,
    true,
  );
  expect(
    revision.artifacts.find((artifact) => artifact.role === "provider_document")!.sha256,
  ).not.toBe(latest[0]!.sha256);
  expect(
    await env.EVIDENCE.head(`objects/${latest[0]!.sha256.slice(0, 2)}/${latest[0]!.sha256}`),
  ).not.toBeNull();
}, 60_000);
test("a successful document sibling is eligible even when the report run is partial", async () => {
  const plan = await capture("00000000-0000-4000-8000-000000001250", [], true);
  expect(plan.run.providerOutcome).toBe("partial");
  expect(plan.run.units).toHaveLength(1);
  await sweep(env);
  expect(
    (
      await env.DB.prepare(
        `SELECT c.unit_scope,c.unit_report_outcome,c.mode FROM parse_coverage_claims c JOIN parse_runs p ON p.id=c.parse_run_id JOIN fetch_artifacts a ON a.id=p.fetch_artifact_id JOIN observation_fetch_runs r ON r.id=a.fetch_run_id WHERE r.external_run_id=? AND p.parser_name='sbi-shinsei-monthly-report-metadata' AND p.status='ok'`,
      )
        .bind(plan.run.runId)
        .all()
    ).results,
  ).toEqual([{ unit_scope: "unit", unit_report_outcome: "success", mode: "evidence-only" }]);
}, 60_000);
