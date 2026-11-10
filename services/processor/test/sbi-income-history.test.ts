// Synthetic capture -> shared R2 -> registration -> parse/publication -> current reader.
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
import { objectKey } from "../../../packages/collection/src/keys.ts";
import { sha256Hex } from "../../../packages/collection/src/digest.ts";
import { collectIncomeHistory } from "../../collector-sbi-securities/src/income-history.ts";
import { sbiRunPlan, safeFailureCode } from "../../collector-sbi-securities/src/shared-run.ts";
import type { Artifact } from "../../collector-sbi-securities/src/types.ts";
import { registerCollectionRun } from "../src/collection/index.ts";
import { parseJob } from "../src/worker.ts";
import { createD1ObservationReader } from "../../../packages/read-model/src/d1.ts";
import {
  sbiIncomePayments,
  sbiRealisedGains,
} from "../../../packages/parsers/src/parsers/sbi-income-history.ts";
import { incomeBundle } from "../../../packages/parsers/test/fixtures/sbi-income.ts";
import type { IncomeHistoryBundle } from "../../../packages/parsers/src/parsers/sbi-income-history-schema.ts";

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

let sequence = 0;
async function capture(bundle: IncomeHistoryBundle) {
  const kind = bundle.kind;
  const runId = `income-synthetic-${++sequence}`;
  const artifacts: Artifact[] = [];
  let failure: unknown;
  try {
    await collectIncomeHistory({
      kind,
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
  } catch (error) {
    failure = error;
  }
  const capturedAt = `2020-01-01T00:${String(sequence).padStart(2, "0")}:00Z`;
  const plan = await sbiRunPlan({
    runId,
    producerVersion: "synthetic-v1",
    attemptId: `attempt-${runId}`,
    startedAt: capturedAt,
    completedAt: capturedAt,
    status: failure === undefined ? "success" : "partial",
    scope: "domestic",
    artifacts,
    failures: failure === undefined ? [] : [{ scope: "domestic", code: safeFailureCode(failure) }],
  });
  expect(plan.run.providerOutcome).toBe(failure === undefined ? "success" : "partial");
  expect((await persistRun(env.EVIDENCE, plan)).outcome).toBe("persisted");
  expect(await registerCollectionRun(env, { source: "sbi-securities", runId })).toMatchObject({
    outcome: "registered",
  });
  if (failure !== undefined) {
    expect(artifacts.every((a) => a.role === "provider_response")).toBe(true);
    return { failure: safeFailureCode(failure), rawCount: artifacts.length };
  }
  const parser = kind === "income" ? sbiIncomePayments : sbiRealisedGains;
  const dataset = kind === "income" ? "income-payments" : "realised-gains";
  const artifactId = (await env.DB.prepare(
    "SELECT id FROM fetch_artifacts WHERE source_id='sbi-securities' AND dataset=? ORDER BY id DESC LIMIT 1",
  )
    .bind(dataset)
    .first<number>("id"))!;
  await env.DB.prepare(
    "INSERT INTO observation_parse_jobs(fetch_artifact_id,parser_name,parser_version,status) VALUES(?,?,?,'pending')",
  )
    .bind(artifactId, parser.name, parser.version)
    .run();
  expect(
    await parseJob(
      env,
      {
        fetch_artifact_id: artifactId,
        parser_name: parser.name,
        parser_version: parser.version,
        attempts: 0,
      },
      parser,
    ),
  ).toBe("parsed");
  expect(
    await env.DB.prepare(
      "SELECT warnings_json FROM parse_runs WHERE fetch_artifact_id=? AND status='ok' ORDER BY id DESC LIMIT 1",
    )
      .bind(artifactId)
      .first<string>("warnings_json"),
  ).toBe("[]");
  return { artifactId };
}

test("full retained containers deduplicate, correct and remove rows; partial capture preserves the last complete current history", async () => {
  const reader = createD1ObservationReader(env.DB);
  const incomeQuery = { kind: "income" as const, metric: "income_net" as const, offset: 0 };
  const gainQuery = {
    kind: "gains" as const,
    metric: "realised_gain_before_tax" as const,
    offset: 0,
  };
  await capture(incomeBundle("income"));
  await capture(incomeBundle("gains"));
  const first = await reader.listSbiIncomeHistory(incomeQuery);
  expect(first).toHaveLength(3);
  expect(new Set(first.map((row) => row.subject)).size).toBe(3);
  expect(first.filter((row) => row.currency === "USD").map((row) => row.amount_minor)).toEqual([
    "29",
    "29",
  ]);
  await capture(incomeBundle("income"));
  await capture(incomeBundle("gains"));
  expect((await reader.listSbiIncomeHistory(incomeQuery)).map((row) => row.subject)).toEqual(
    first.map((row) => row.subject),
  );
  expect(await reader.listSbiIncomeHistory(gainQuery)).toHaveLength(1);
  expect(await reader.listTransactions({ source: "sbi-securities", offset: 0 })).toEqual([]);

  // A changed identifying net/date/quantity must retire the old row rather
  // than unioning both fingerprints into current financial history.
  const corrected = incomeBundle("income");
  const paymentRows = JSON.parse(corrected.rowsText).dividends;
  paymentRows[0].receivedAmount = 16;
  paymentRows[0].quantity = 12;
  paymentRows[0].dispositionDate = "20990904";
  paymentRows.pop();
  corrected.rowsText = JSON.stringify({ dividends: paymentRows });
  const summary = JSON.parse(corrected.summaryText);
  summary.countTotal = 2;
  summary.dividendsSummaries[1].count = 1;
  corrected.summaryText = JSON.stringify(summary);
  await capture(corrected);
  const current = await reader.listSbiIncomeHistory(incomeQuery);
  expect(current).toHaveLength(2);
  expect(current.filter((row) => row.currency === "JPY").map((row) => row.amount_minor)).toEqual([
    "16",
  ]);
  expect(
    current.some((row) => row.subject === first.find((row) => row.currency === "JPY")!.subject),
  ).toBe(false);
  expect(
    await reader.listSbiIncomeHistory({ ...incomeQuery, from: "2099-09-04", to: "2099-09-04" }),
  ).toHaveLength(1);
  expect(
    (await reader.listSbiIncomeHistory({ ...incomeQuery, offset: 1 })).map((row) => row.subject),
  ).toEqual(current.slice(1).map((row) => row.subject));

  const gains = incomeBundle("gains");
  gains.rowsText = gains.rowsText
    .replace('"profitLoss":20', '"profitLoss":21')
    .replace('"amount":120', '"amount":121');
  await capture(gains);
  expect((await reader.listSbiIncomeHistory(gainQuery)).map((row) => row.amount_minor)).toEqual([
    "21",
  ]);
  const prices = await reader.listSbiIncomeHistory({
    kind: "gains",
    metric: "sale_unit_price",
    offset: 0,
  });
  expect(prices.map((row) => [row.amount_text, row.amount_minor])).toEqual([["12.3456", null]]);

  const bad = incomeBundle("income");
  bad.rowsText = bad.rowsText.replace(
    '"receivedAmountLc":0.29',
    '"receivedAmountLc":0.99999999999999999',
  );
  expect(await capture(bad)).toEqual({ failure: "sbi_income_history_money", rawCount: 2 });
  expect(await reader.listSbiIncomeHistory(incomeQuery)).toEqual(current);
  const secret = incomeBundle("income");
  secret.rowsText =
    '{"divid\\u0065nds":{"accessToken":"SYNTHETIC_SENTINEL"},' + secret.rowsText.slice(1);
  expect(await capture(secret)).toEqual({ failure: "sbi_income_history_schema", rawCount: 1 });
  expect(
    await env.EVIDENCE.get(objectKey(await sha256Hex(new TextEncoder().encode(secret.rowsText)))),
  ).toBeNull();
  expect(await reader.listSbiIncomeHistory(incomeQuery)).toEqual(current);
  expect(
    await env.DB.prepare("SELECT COUNT(*) n FROM valuation_observations").first<number>("n"),
  ).toBeGreaterThan(19);

  const empty = incomeBundle("income");
  empty.rowsText = JSON.stringify({ dividends: [] });
  empty.summaryText = JSON.stringify({ dividendsSummaries: [], receivedTotal: 0, countTotal: 0 });
  await capture(empty);
  expect(await reader.listSbiIncomeHistory(incomeQuery)).toEqual([]);
  expect(await reader.listSbiIncomeHistory(gainQuery)).toHaveLength(1);
}, 60_000);
