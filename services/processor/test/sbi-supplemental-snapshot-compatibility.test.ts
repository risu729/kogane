import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import {
  CORE_MIGRATIONS_URL,
  migrationFiles,
  migrationSql,
} from "../../../packages/storage-d1/src/migrations.ts";
import { persistRun } from "../../../packages/collection/src/writer.ts";
import { sbiRunPlan } from "../../collector-sbi-securities/src/shared-run.ts";
import { collectIncomeHistory } from "../../collector-sbi-securities/src/income-history.ts";
import type { Artifact } from "../../collector-sbi-securities/src/types.ts";
import { incomeBundle } from "../../../packages/parsers/test/fixtures/sbi-income.ts";
import {
  sbiIncomePayments,
  sbiRealisedGains,
} from "../../../packages/parsers/src/parsers/sbi-income-history.ts";
import type { IncomeHistoryBundle } from "../../../packages/parsers/src/parsers/sbi-income-history-schema.ts";
import { createD1ObservationReader } from "../../../packages/read-model/src/index.ts";
import { snapshotCtes, CURRENT_SNAPSHOT } from "../../../packages/parsers/src/snapshot-query.ts";
import { registerCollectionRun } from "../src/collection/index.ts";
import { parseJob } from "../src/worker.ts";
import { applyTestSql } from "./migration-setup.ts";
let mf: Miniflare;
let env: Env;
beforeEach(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default {};",
      compatibilityDate: "2026-09-07",
      d1Databases: ["DB"],
      r2Buckets: ["EVIDENCE"],
    }),
  );
  const DB = await mf.getD1Database("DB");
  for (const file of migrationFiles(CORE_MIGRATIONS_URL))
    await applyTestSql(DB, migrationSql(CORE_MIGRATIONS_URL, file));
  await applyTestSql(
    DB,
    readFileSync(new URL("../../../infra/bootstrap/ingest-clients.sql", import.meta.url), "utf8"),
  );
  env = {
    DB,
    EVIDENCE: await mf.getR2Bucket("EVIDENCE"),
    SHARED_R2_INGEST_ENABLED: "true",
    COLLECTION_INGEST_CLIENT: "processor-shared-r2",
  } as unknown as Env;
}, 60_000);
afterEach(async () => {
  await mf?.dispose();
});
let sequence = 0;
async function capture(bundle: IncomeHistoryBundle, day: number, legacy = false, refused = false) {
  const artifacts: Artifact[] = [];
  await collectIncomeHistory({
    kind: bundle.kind,
    today: bundle.requestedRange.to,
    retain: (a) => artifacts.push(a),
    fetch: async (role) =>
      new TextEncoder().encode(
        role === "rows"
          ? bundle.rowsText
          : role === "all-summary"
            ? bundle.allSummaryText!
            : bundle.summaryText,
      ),
  });
  const runId = `snapshot-compatibility-${++sequence}`;
  const at = `2020-02-${String(day).padStart(2, "0")}T00:00:00.000Z`;
  const unitKey = bundle.kind === "income" ? "income-history-income" : "income-history-gains";
  let plan = await sbiRunPlan({
    runId,
    producerVersion: "synthetic",
    attemptId: runId,
    scope: "domestic",
    status: refused ? "partial" : "success",
    startedAt: at,
    completedAt: at,
    artifacts,
    failures: refused
      ? [{ scope: "domestic", unitKey, code: "sbi_income_history_fetch_failed" }]
      : [],
  });
  // A frozen old manifest has one domestic unit for its raw and derived bytes.
  if (legacy)
    plan = {
      artifacts: plan.artifacts.map((a) => ({ ...a, unitKey: "domestic" })),
      run: {
        ...plan.run,
        units: [
          {
            unitKey: "domestic",
            unitKind: "scope",
            artifactCount: plan.artifacts.length,
            coverageStatus: "complete",
          },
        ],
        requestedScope: { ...plan.run.requestedScope, unitKeys: ["domestic"] },
        ranges: plan.run.ranges.map((r) =>
          r.unitKey === undefined ? r : { ...r, unitKey: "domestic" },
        ),
      },
    };
  expect((await persistRun(env.EVIDENCE, plan)).outcome).toBe("persisted");
  const registration = await registerCollectionRun(env, { source: "sbi-securities", runId });
  expect(registration.outcome).toBe("registered");
  const parser = bundle.kind === "income" ? sbiIncomePayments : sbiRealisedGains;
  const dataset = bundle.kind === "income" ? "income-payments" : "realised-gains";
  const id = await env.DB.prepare(
    "SELECT a.id FROM observation_fetch_artifacts a WHERE a.fetch_run_id=? AND a.dataset=?",
  )
    .bind(registration.outcome === "registered" ? registration.fetchRunId : 0, dataset)
    .first<number>("id");
  expect(id).not.toBeNull();
  await env.DB.prepare(
    "INSERT INTO observation_parse_jobs(fetch_artifact_id,parser_name,parser_version,status) VALUES(?,?,?,'pending')",
  )
    .bind(id, parser.name, parser.version)
    .run();
  expect(
    await parseJob(
      env,
      {
        fetch_artifact_id: id!,
        parser_name: parser.name,
        parser_version: parser.version,
        attempts: 0,
      },
      parser,
    ),
  ).toBe(refused ? "error" : "parsed");
  return id!;
}
const relations = {
  fetchArtifacts: "observation_fetch_artifacts",
  fetchRuns: "observation_fetch_runs",
  parseRuns: "parse_runs",
  publishedParseRuns: "published_parse_runs",
};
async function selected(parser: string, cutoff?: string) {
  const sql = `WITH ${snapshotCtes(relations, cutoff ? { cutoffParam: "?2" } : {})} SELECT fa.id FROM observation_fetch_artifacts fa JOIN parse_runs p ON p.fetch_artifact_id=fa.id WHERE p.parser_name=?1 AND ${CURRENT_SNAPSHOT} ORDER BY fa.id`;
  return (
    await (
      cutoff ? env.DB.prepare(sql).bind(parser, cutoff) : env.DB.prepare(sql).bind(parser)
    ).all<{ id: number }>()
  ).results.map((row) => row.id);
}
for (const kind of ["income", "gains"] as const)
  for (const behavior of ["nonempty", "refused", "empty"] as const)
    test(`${kind}: legacy domestic snapshot to ${behavior} successor retains one current partition and historical cutoff`, async () => {
      const parser = kind === "income" ? sbiIncomePayments : sbiRealisedGains;
      const query =
        kind === "income"
          ? { kind, metric: "income_net" as const, offset: 0 }
          : { kind, metric: "realised_gain_before_tax" as const, offset: 0 };
      const reader = createD1ObservationReader(env.DB);
      const old = await capture(incomeBundle(kind), 1, true);
      const first = await reader.listSbiIncomeHistory(query);
      expect(first).toHaveLength(kind === "income" ? 3 : 1);
      const successor = incomeBundle(kind);
      if (behavior === "nonempty")
        successor.rowsText =
          kind === "income"
            ? successor.rowsText.replace('"receivedAmount":14', '"receivedAmount":16')
            : successor.rowsText.replace('"profitLoss":20', '"profitLoss":21');
      if (behavior === "empty") {
        if (kind === "income") {
          successor.rowsText = '{"dividends":[]}';
          successor.summaryText = '{"dividendsSummaries":[],"receivedTotal":0,"countTotal":0}';
        } else {
          const summary = JSON.parse(successor.summaryText);
          Object.assign(summary.profitLossSummary, { total: 0, profitLoss: 0, profit: 0, loss: 0 });
          summary.profitLossSummaryDetails = [];
          successor.summaryText = JSON.stringify(summary);
          successor.allSummaryText = successor.summaryText;
          successor.rowsText = '{"profitLosses":[]}';
        }
      }
      const next = await capture(successor, 2, false, behavior === "refused");
      const current = await reader.listSbiIncomeHistory(query);
      if (behavior === "nonempty") {
        expect(current).toHaveLength(first.length);
        expect(
          current.filter((row) => row.currency === "JPY").map((row) => row.amount_minor),
        ).toEqual([kind === "income" ? "16" : "21"]);
      } else if (behavior === "refused") expect(current).toEqual(first);
      else expect(current).toEqual([]);
      expect(await selected(parser.name)).toEqual([behavior === "refused" ? old : next]);
      expect(await selected(parser.name, "2020-02-02T00:00:00.000Z")).toEqual([old]);
    }, 60_000);
