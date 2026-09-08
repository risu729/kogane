import { env } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import { observationApi } from "../src/observation-api";
import { seedRegistry, seedRun } from "./fixtures";
import { validApiResponse } from "../../../poc/observation-pipeline/shared/api-validation";
import type { BalanceInterpretation } from "../../../poc/observation-pipeline/shared/balance-semantics";

beforeAll(seedRegistry);
async function seedBalances(
  options: { conflict?: boolean; statement?: boolean; months?: number } = {},
) {
  const source = options.statement ? "myjcb" : "sbi-shinsei-bank";
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO producer_sources(producer_id,source_id) VALUES ('evidence-test',?)",
    ).bind(source),
    env.DB.prepare(
      "INSERT OR IGNORE INTO ingest_client_routes(ingest_client_id,producer_id,source_id) VALUES ('evidence-test','evidence-test',?)",
    ).bind(source),
  ]);
  const run = await seedRun({
    source,
    count: 1,
    dataset: options.statement ? "credit-past-months" : "yen-deposit-account",
  });
  const parse = await env.DB.prepare(
    "INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES (?,?,'0.1.1','2099','ok','[]') RETURNING id",
  )
    .bind(
      run.artifacts[0]!.id,
      options.statement ? "myjcb-credit-past-month-balances" : "sbi-shinsei-yen-deposit-account",
    )
    .first<{ id: number }>();
  const prefix = `balance-${parse!.id}`;
  const rawAccount = options.statement ? `myjcb:${prefix}:root` : `sbi-shinsei:${prefix}`;
  const rows: Array<{ id: number; metric: string }> = [];
  for (const [index, section] of (options.statement
    ? Array.from({ length: options.months ?? 1 }, () => "statement")
    : ["debitAccountDetails", "savingsDetails"]
  ).entries()) {
    const metric = options.statement
      ? "credit_statement_payment_amount"
      : index === 0
        ? "yen_deposit_account_balance"
        : "yen_deposit_savings_balance";
    const extra = options.statement
      ? { _kogane: { detailMonth: index } }
      : {
          accountNo: prefix,
          productCode: "601",
          currency: "JPY",
          _kogane: { sourceView: section, productCode: "601" },
        };
    const amount = options.conflict && index === 1 ? 4568 : 4567;
    const row = await env.DB.prepare(
      "INSERT INTO balance_observations(parse_run_id,source_account,metric,instrument,amount_minor,amount_text,amount_scale,as_of,observed_at,raw_locator,extra_json) VALUES (?,?,?,'JPY',?,?,0,'2026-09-08T00:00:00Z','2026-09-08T00:00:00Z',?,?) RETURNING id",
    )
      .bind(
        parse!.id,
        rawAccount,
        metric,
        amount,
        String(amount),
        options.statement
          ? `json:$.months[${index}].payAmount`
          : `json:$.responseParam.${section}[0].balance`,
        JSON.stringify(extra),
      )
      .first<{ id: number }>();
    rows.push({ id: row!.id, metric });
  }
  await env.DB.batch([
    env.DB.prepare("INSERT INTO source_accounts VALUES (?,?, 'evidence-test',?)").bind(
      `${prefix}-ref`,
      source,
      JSON.stringify([rawAccount]),
    ),
    env.DB.prepare(
      "INSERT INTO accounts VALUES (?, 'Synthetic account','cash','provider-local')",
    ).bind(`${prefix}-account`),
    env.DB.prepare(
      "INSERT INTO account_mappings VALUES (?,?,1,?,'rule','provider-scope',1,'2099','Synthetic account','provider-local')",
    ).bind(`${prefix}-mapping`, `${prefix}-ref`, `${prefix}-account`),
    env.DB.prepare("INSERT INTO identity_runs VALUES (?,?,1,'2099')").bind(
      `${prefix}-identity`,
      parse!.id,
    ),
    ...rows.map(({ id }) =>
      env.DB.prepare("INSERT INTO identity_observations VALUES (?,?,'balance',?,?,?,'[]')").bind(
        `${prefix}-observation-${id}`,
        `${prefix}-identity`,
        id,
        `${prefix}-ref`,
        `${prefix}-mapping`,
      ),
    ),
    env.DB.prepare("INSERT INTO identity_run_seals VALUES (?,?,'2099')").bind(
      `${prefix}-identity`,
      rows.length,
    ),
  ]);
  return { source, rawAccount, rows };
}
interface PresentedRow {
  id: number;
  metric: string;
  amount_minor: string;
  amount_text: string;
  interpretation: BalanceInterpretation;
}
async function balances(
  fixture: { source: string; rawAccount: string },
  metric?: string,
  view?: string,
) {
  const url = new URL("https://fixture.test/api/balances");
  url.searchParams.set("source", fixture.source);
  url.searchParams.set("account", fixture.rawAccount);
  if (metric) url.searchParams.set("metric", metric);
  if (view) url.searchParams.set("view", view);
  const response = await observationApi(new Request(url), env, url);
  expect(response?.status).toBe(200);
  const body = (await response!.json()) as { latest: PresentedRow[]; history: PresentedRow[] };
  expect(validApiResponse("/api/balances", body)).toBe(true);
  return body;
}

it("projects an exact Shinsei pair once in latest but preserves both historical B rows", async () => {
  const fixture = await seedBalances();
  const body = await balances(fixture);
  expect(body.latest).toHaveLength(1);
  expect(body.history).toHaveLength(2);
  expect(body.latest[0]!.interpretation).toMatchObject({
    policyVersion: "financial-measures-v2",
    semantic: { kind: "asset", netAssetEligible: false },
    duplicateCount: 1,
    conflict: false,
  });
  expect(body.latest[0]!.interpretation.evidence.map((r) => r.id).sort()).toEqual(
    fixture.rows.map((r) => r.id).sort(),
  );
  expect(
    body.history.every(
      (r) => r.interpretation.duplicateCount === 0 && r.interpretation.evidence.length === 1,
    ),
  ).toBe(true);
  expect(
    (await env.DB.prepare("SELECT count(*) n FROM balance_observations WHERE source_account=?")
      .bind(fixture.rawAccount)
      .first<{ n: number }>())!.n,
  ).toBe(2);
});

it("either original metric filter retains the grouped latest row with both evidence refs", async () => {
  const fixture = await seedBalances();
  for (const metric of fixture.rows.map((r) => r.metric)) {
    const body = await balances(fixture, metric);
    expect(body.latest).toHaveLength(1);
    expect(body.latest[0]!.interpretation.evidence).toHaveLength(2);
    expect(body.latest[0]!.interpretation.evidence.some((r) => r.metric === metric)).toBe(true);
    expect(body.history).toHaveLength(1);
    expect(body.history[0]!.metric).toBe(metric);
  }
});

it("conflicting own-view amounts remain distinct and explicitly flagged", async () => {
  const fixture = await seedBalances({ conflict: true });
  const body = await balances(fixture);
  expect(body.latest).toHaveLength(2);
  expect(body.history).toHaveLength(2);
  expect(body.latest.map((r) => r.amount_minor).sort()).toEqual(["4567", "4568"]);
  expect(
    body.latest.every((r) => r.interpretation.conflict && r.interpretation.duplicateCount === 0),
  ).toBe(true);
});

it("MyJCB billing amount stays positive and is a statement, not unpaid debt", async () => {
  const fixture = await seedBalances({ statement: true });
  const body = await balances(fixture);
  expect(body.latest).toHaveLength(1);
  expect(body.latest[0]!.amount_minor).toBe("4567");
  expect(body.latest[0]!.amount_text).toBe("4567");
  expect(body.latest[0]!.interpretation).toMatchObject({
    semantic: { kind: "statement", label: "請求額", netAssetEligible: false },
    duplicateCount: 0,
    conflict: false,
  });
});

it("summary view preserves all displayed MyJCB months while balance view excludes them", async () => {
  const fixture = await seedBalances({ statement: true, months: 18 });
  const summary = await balances(fixture, undefined, "summaries");
  expect(summary.latest).toHaveLength(18);
  expect(summary.history).toHaveLength(18);
  expect(
    summary.latest.every(
      (row) => row.interpretation.semantic.measurementKind === "statement_amount",
    ),
  ).toBe(true);
  expect(new Set(summary.latest.map((row) => row.id)).size).toBe(18);
  const stock = await balances(fixture, undefined, "balances");
  expect(stock.latest).toHaveLength(0);
  expect(stock.history).toHaveLength(0);
  expect((await balances(fixture)).latest).toHaveLength(1);
});
