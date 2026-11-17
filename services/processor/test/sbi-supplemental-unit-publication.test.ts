// Synthetic provider-shaped captures use the production terminal and publication path.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import {
  CORE_MIGRATIONS_URL,
  migrationFiles,
  migrationSql,
} from "../../../packages/storage-d1/src/migrations.ts";
import { persistRun } from "../../../packages/collection/src/writer.ts";
import { collectCashHistory } from "../../collector-sbi-securities/src/cash-history.ts";
import { collectIncomeHistory } from "../../collector-sbi-securities/src/income-history.ts";
import { assetHistoryArtifacts } from "../../collector-sbi-securities/src/asset-history.ts";
import {
  sbiRunPlan,
  safeFailureCode,
  type SharedFailure,
  type SupplementalUnit,
} from "../../collector-sbi-securities/src/shared-run.ts";
import type { Artifact } from "../../collector-sbi-securities/src/types.ts";
import { incomeBundle } from "../../../packages/parsers/test/fixtures/sbi-income.ts";
import { auditAssetHistoryJson } from "../../../packages/parsers/src/parsers/sbi-asset-history-json.ts";
import {
  sanitizeAssetHistory,
  assetHistoryViews,
  ASSET_HISTORY_SOURCE_KEY,
} from "../../../packages/parsers/src/parsers/sbi-asset-history-schema.ts";
import { createD1ObservationReader, PAGE_LIMIT } from "../../../packages/read-model/src/index.ts";
import { registerCollectionRun } from "../src/collection/index.ts";
import { parseJob } from "../src/worker.ts";
import { PARSERS } from "../../../packages/parsers/src/parsers/registry.ts";
import { unitScopedEligibilitySql } from "../../../packages/parsers/src/snapshot-query.ts";
import { applyTestSql } from "./migration-setup.ts";

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
afterAll(async () => {
  await mf?.dispose();
});
const encode = (body: unknown) => new TextEncoder().encode(JSON.stringify(body));
const fixture = (name: string, original = false) =>
  JSON.parse(
    readFileSync(
      new URL(
        `../../../tests/fixtures/observation-pipeline/${original ? "sbi-securities/2026-08-20/run-20260820-210000-poc01" : "sbi-parser-boundaries"}/${name}.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  );
const artifact = (dataset: string, original = false): Artifact => ({
  dataset,
  mediaType: "application/json",
  body: fixture(dataset, original),
});
const core = (): Artifact[] => [
  artifact("domestic-cash-positions"),
  artifact("account-assets-current"),
  artifact("domestic-trade-records", true),
  artifact("foreign-cash-positions", true),
  {
    dataset: "foreign-cash-balances",
    mediaType: "application/json",
    body: {
      listForeignScheduleCashBalances: {
        foreignCashBalances: [
          {
            currencyCashBalances: [
              {
                currencyCode: "USD",
                foreignScheduleCashBalances: [{ businessDate: "2099-09-03", keepCash: "10.00" }],
              },
            ],
          },
        ],
      },
    },
  },
  artifact("foreign-trade-records"),
];
const coreParsers = core()
  .map((a) => `sbi-${a.dataset}`)
  .sort();
interface Scenario {
  name: string;
  unit: SupplementalUnit;
  code: string;
}
const scenarios: Scenario[] = [
  {
    name: "foreign-second-page",
    unit: "cash-history-foreign",
    code: "sbi_foreign_cash_pagination_unobserved",
  },
  { name: "foreign-gain", unit: "income-history-gains", code: "sbi_income_history_count" },
  {
    name: "fund-distribution",
    unit: "income-history-income",
    code: "sbi_income_history_unknown_code",
  },
  {
    name: "income-over-thirty",
    unit: "income-history-income",
    code: "sbi_income_history_pagination_unobserved",
  },
  { name: "weekly-ideco", unit: "weekly-assets", code: "sbi_asset_history_schema" },
  { name: "weekly-gap", unit: "weekly-assets", code: "sbi_asset_history_weekly_gap" },
  { name: "weekly-inexact", unit: "weekly-assets", code: "sbi_asset_history_money" },
];

async function supplements(scenario?: Scenario) {
  const artifacts: Artifact[] = [];
  const failures: SharedFailure[] = [];
  async function collect(unitKey: SupplementalUnit, run: () => Promise<unknown>) {
    try {
      await run();
    } catch (cause) {
      if (unitKey !== scenario?.unit) throw cause;
      expect(unitKey).toBe(scenario?.unit);
      expect(safeFailureCode(cause)).toBe(scenario?.code);
      failures.push({ scope: "domestic", unitKey, code: safeFailureCode(cause) });
    }
  }
  for (const kind of ["yen", "foreign"] as const)
    await collect(`cash-history-${kind}`, async () => {
      const body = fixture(kind === "yen" ? "yen-detail-history" : "foreign-cash-history");
      // The older yen fixture is the exact provider page; the foreign fixture is its bundle.
      const page =
        kind === "yen"
          ? {
              depositRecordList: [
                {
                  did: 2001,
                  detailKbn: "金融機関からの入金",
                  payDepKbn: "入金",
                  payDepDate: "2099/09/03",
                  payAmount: "100",
                  dispAbstract: "synthetic deposit",
                },
              ],
              detailsConditions: ["入金：すべて", "出金：すべて"],
              exceededMaxCount: false,
              isExceededMaxCount: false,
              pageCount: 1,
              pageNumber: 1,
              pageSize: 10,
              totalCount: 1,
              totalDepositAmount: "100",
              totalDepositCount: "1",
              totalPaymentAmount: "0",
              totalPaymentCount: "0",
              totalTransDepositAmount: "0",
              totalTransDepositCount: "0",
              totalTransPaymentAmount: "0",
              totalTransPaymentCount: "0",
            }
          : body.pages[0];
      if (scenario?.name === "foreign-second-page" && kind === "foreign") {
        page.items = Array.from({ length: 10 }, () => page.items[0]);
        page.pageCount = 2;
        page.totalCount = 11;
      }
      await collectCashHistory({
        kind,
        today: "2099-12-31",
        retain: (a) => artifacts.push(a),
        fetchPage: async () => encode(page),
      });
    });
  for (const kind of ["income", "gains"] as const)
    await collect(`income-history-${kind}`, async () => {
      const bundle = incomeBundle(kind);
      if (kind === "income") {
        const rows = JSON.parse(bundle.rowsText);
        rows.dividends = rows.dividends.slice(0, 1);
        bundle.rowsText = JSON.stringify(rows);
        const summary = JSON.parse(bundle.summaryText);
        summary.dividendsSummaries = summary.dividendsSummaries.slice(0, 1);
        summary.countTotal = 1;
        summary.receivedTotal = 14;
        bundle.summaryText = JSON.stringify(summary);
      }
      if (scenario?.name === "fund-distribution" && kind === "income")
        bundle.rowsText = bundle.rowsText.replace(
          '"category":"DOMESTIC_STOCK_SPOT"',
          '"category":"FUND"',
        );
      if (scenario?.name === "income-over-thirty" && kind === "income") {
        const summary = JSON.parse(bundle.summaryText);
        summary.countTotal = 31;
        summary.dividendsSummaries[0].count = 31;
        bundle.summaryText = JSON.stringify(summary);
      }
      if (scenario?.name === "foreign-gain" && kind === "gains") {
        const all = JSON.parse(bundle.allSummaryText!);
        all.profitLossSummary.total = 2;
        all.profitLossSummaryDetails[0].total = 2;
        bundle.allSummaryText = JSON.stringify(all);
      }
      await collectIncomeHistory({
        kind,
        today: "2099-12-31",
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
    });
  await collect("weekly-assets", async () => {
    let body = fixture("account-assets-history");
    // One complete weekly point is enough to test sibling publication. Keep
    // both original points for the gap refusal and trim every native series
    // consistently, so the fixture still satisfies whole-history controls.
    if (scenario?.name !== "weekly-gap")
      for (const view of assetHistoryViews(body)) {
        if (view.transitions === null) continue;
        const newest = Object.keys(view.transitions).sort().at(-1)!;
        for (const key of Object.keys(view.transitions))
          if (key !== newest) delete view.transitions[key];
        for (const rows of [view.balances, view.acquisitionCosts])
          rows.splice(0, rows.length, ...rows.filter((row) => String(row[0]) === newest));
      }
    if (scenario?.name === "weekly-ideco") body.valuationsTransitionsWithoutIdeco = {};
    if (scenario?.name === "weekly-gap")
      for (const view of assetHistoryViews(body)) {
        if (view.transitions === null) continue;
        const old = Object.keys(view.transitions).sort()[0]!;
        const next = String(Number(old) - 7 * 86400000);
        view.transitions[next] = view.transitions[old]!;
        delete view.transitions[old];
        view.balances[0]![0] = Number(next);
        view.acquisitionCosts[0]![0] = Number(next);
      }
    let text = JSON.stringify(body);
    if (scenario?.name === "weekly-inexact")
      text = text.replace('"profitLoss":10', '"profitLoss":0.99999999999999999');
    body = sanitizeAssetHistory(auditAssetHistoryJson(text));
    const bytes = new TextEncoder().encode(text);
    artifacts.push({
      artifactKey: ASSET_HISTORY_SOURCE_KEY,
      dataset: "account-assets-history-source",
      role: "provider_response",
      mediaType: "application/json",
      bytes,
      body,
    });
    artifacts.push(
      ...(await assetHistoryArtifacts({ body, bytes, capturedAt: "2020-01-01T00:00:00.000Z" })),
    );
  });
  return { artifacts, failures };
}
let sequence = 0;
async function publish(artifacts: Artifact[], failures: SharedFailure[]) {
  const runId = `unit-isolation-${++sequence}`;
  const at = `2020-01-${String(sequence).padStart(2, "0")}T00:00:00Z`;
  const plan = await sbiRunPlan({
    runId,
    producerVersion: "synthetic-v1",
    attemptId: `attempt-${runId}`,
    startedAt: at,
    completedAt: at,
    scope: "all",
    status: failures.length ? "partial" : "success",
    artifacts,
    failures,
  });
  expect((await persistRun(env.EVIDENCE, plan)).outcome).toBe("persisted");
  let registered = await registerCollectionRun(env, { source: "sbi-securities", runId });
  for (let i = 0; registered.outcome === "pending" && i < artifacts.length; i++)
    registered = await registerCollectionRun(env, { source: "sbi-securities", runId });
  expect(registered.outcome).toBe("registered");
  if (registered.outcome !== "registered") throw new Error("synthetic_registration_failed");
  // Select with the dispatcher's shared production eligibility predicate, then
  // exercise the actual parse/publication job without unrelated sweep maintenance.
  const eligible = (
    await env.DB.prepare(
      `SELECT a.id,a.dataset FROM observation_fetch_artifacts a JOIN observation_fetch_runs r ON r.id=a.fetch_run_id WHERE a.fetch_run_id=? AND ${unitScopedEligibilitySql("r", "a")}`,
    )
      .bind(registered.fetchRunId)
      .all<{ id: number; dataset: string | null }>()
  ).results;
  for (const row of eligible) {
    const parser = PARSERS.find((entry) => entry.name === `sbi-${row.dataset}`);
    if (parser === undefined) continue;
    await env.DB.prepare(
      "INSERT INTO observation_parse_jobs(fetch_artifact_id,parser_name,parser_version,status) VALUES(?,?,?,'pending')",
    )
      .bind(row.id, parser.name, parser.version)
      .run();
    const outcome = await parseJob(
      env,
      {
        fetch_artifact_id: row.id,
        parser_name: parser.name,
        parser_version: parser.version,
        attempts: 0,
      },
      parser,
    );
    expect({ parser: parser.name, outcome }).toEqual({ parser: parser.name, outcome: "parsed" });
  }
  const rows = (
    await env.DB.prepare(
      "SELECT p.parser_name,a.dataset,a.fetch_unit_key FROM published_parse_runs x JOIN parse_runs p ON p.id=x.parse_run_id JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id WHERE a.fetch_run_id=? ORDER BY p.parser_name",
    )
      .bind(registered.fetchRunId)
      .all<{ parser_name: string; dataset: string; fetch_unit_key: string }>()
  ).results;
  return { plan, rows, run: registered.fetchRunId };
}
for (const scenario of scenarios)
  test(`${scenario.name}: only its supplement refuses while core and healthy supplements publish`, async () => {
    const captured = await supplements(scenario);
    expect(captured.failures).toHaveLength(1);
    const result = await publish([...core(), ...captured.artifacts], captured.failures);
    expect(result.plan.run.providerOutcome).toBe("partial");
    expect(
      result.plan.run.units.find((unit) => unit.unitKey === scenario.unit)?.coverageStatus,
    ).not.toBe("complete");
    expect(
      result.rows
        .filter((row) => coreParsers.includes(row.parser_name))
        .map((row) => row.parser_name)
        .sort(),
    ).toEqual(coreParsers);
    expect(result.rows.some((row) => row.fetch_unit_key === scenario.unit)).toBe(false);
    for (const unit of [
      "cash-history-yen",
      "cash-history-foreign",
      "income-history-income",
      "income-history-gains",
      "weekly-assets",
    ])
      if (unit !== scenario.unit)
        expect(result.rows.some((row) => row.fetch_unit_key === unit)).toBe(true);
    const reader = createD1ObservationReader(env.DB);
    expect(
      (await reader.listLatestBalances({ source: "sbi-securities", offset: 0, limit: PAGE_LIMIT }))
        .length,
    ).toBeGreaterThan(0);
    const transactions = await reader.listTransactions({ source: "sbi-securities", offset: 0 });
    expect(transactions.some((row) => row.parser.startsWith("sbi-domestic-trade-records@"))).toBe(
      true,
    );
    expect(transactions.some((row) => row.parser.startsWith("sbi-foreign-trade-records@"))).toBe(
      true,
    );
  }, 60_000);
for (const scope of ["domestic", "foreign"] as const)
  test(`partial ${scope} core blocks its positions, executions and cash while independent units publish`, async () => {
    const captured = await supplements();
    const result = await publish(
      [...core(), ...captured.artifacts],
      [{ scope, code: "sbi_history_page_invalid" }],
    );
    expect(result.plan.run.units.find((unit) => unit.unitKey === scope)?.coverageStatus).toBe(
      "partial",
    );
    expect(result.rows.filter((row) => row.fetch_unit_key === scope)).toEqual([]);
    const other = scope === "domestic" ? "foreign" : "domestic";
    expect(result.rows.filter((row) => row.fetch_unit_key === other)).toHaveLength(3);
    expect(
      result.rows.filter((row) => row.fetch_unit_key.startsWith("income-history-")),
    ).toHaveLength(2);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) n FROM observation_parse_jobs j JOIN observation_fetch_artifacts a ON a.id=j.fetch_artifact_id WHERE a.fetch_run_id=? AND a.fetch_unit_key=?",
      )
        .bind(result.run, scope)
        .first<number>("n"),
    ).toBe(0);
  }, 60_000);
