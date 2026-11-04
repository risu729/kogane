import { applyTestReadMigrations, applyTestSql } from "./migration-setup.ts";
// Synthetic PRESTIA page only: terminal -> real CORE registration -> parser
// publication through Miniflare D1. No bank or authentication request occurs.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import {
  CORE_MIGRATIONS_URL,
  migrationFiles,
  migrationSql,
} from "../../../packages/storage-d1/src/migrations.ts";
import { persistRun } from "../../../packages/collection/src/writer.ts";
import { sanitizePrestiaBankPage } from "../../../packages/parsers/src/parsers/prestia-bank-html.ts";
import { prestiaBankHtml } from "../../../packages/parsers/test/prestia-bank-fixture.ts";
import { resolveMetric } from "../../../packages/domain/src/metrics.ts";
import { createD1ObservationReader, PAGE_LIMIT } from "../../../packages/read-model/src/index.ts";
import { registerCollectionRun } from "../src/collection/index.ts";
import { sweep } from "../src/worker.ts";
import { prestiaBankRunPlan } from "../../collector-prestia-bank/src/storage.ts";

let mf: Miniflare;
let env: Env;
beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default {};",
      compatibilityDate: "2026-09-07",
      d1Databases: ["DB", "READ"],
      r2Buckets: ["EVIDENCE", "DATA"],
    }),
  );
  const db = await mf.getD1Database("DB");
  const read = await mf.getD1Database("READ");
  for (const file of migrationFiles(CORE_MIGRATIONS_URL))
    await applyTestSql(db, migrationSql(CORE_MIGRATIONS_URL, file));
  const bootstrap = readFileSync(
    new URL("../../../infra/bootstrap/ingest-clients.sql", import.meta.url),
    "utf8",
  );
  await applyTestSql(db, bootstrap);
  await applyTestReadMigrations(read);
  env = {
    DB: db,
    READ: read,
    EVIDENCE: await mf.getR2Bucket("EVIDENCE"),
    DATA: await mf.getR2Bucket("DATA"),
    SHARED_R2_INGEST_ENABLED: "true",
    COLLECTION_INGEST_CLIENT: "processor-shared-r2",
  } as unknown as Env;
}, 60000);
afterAll(async () => {
  await mf?.dispose();
});

test("PRESTIA sanitized snapshot registers and publishes native, bank-yen and monthly qualification evidence", async () => {
  const clean = sanitizePrestiaBankPage(prestiaBankHtml());
  expect(clean).not.toContain("synthetic-secret");
  expect(clean).not.toContain("synthetic-owner");
  const plan = await prestiaBankRunPlan({
    runId: "prestia-bank-synthetic-1",
    startedAt: "2026-10-01T00:00:00.000Z",
    completedAt: "2026-10-01T00:00:01.000Z",
    version: "prestia-bank-collector-v1",
    body: clean,
  });
  expect(plan.run.requestedScope).toEqual({
    scopeKind: "unspecified",
    startValue: null,
    endValue: null,
    unitKeys: ["balance-summary"],
  });
  expect(plan.run.units).toEqual([
    {
      unitKey: "balance-summary",
      unitKind: "container",
      artifactCount: 1,
      coverageStatus: "complete",
    },
  ]);
  const persisted = await persistRun(env.EVIDENCE, plan);
  expect(persisted.outcome).not.toBe("conflict");
  expect(
    await registerCollectionRun(env, { source: "prestia-bank", runId: "prestia-bank-synthetic-1" }),
  ).toMatchObject({ outcome: "registered", artifacts: 1 });
  expect(
    (await env.DB.prepare("SELECT source_id,producer_id FROM fetch_runs").all()).results,
  ).toEqual([{ source_id: "prestia", producer_id: "collector-prestia-bank" }]);
  expect(
    (await env.DB.prepare("SELECT unit_key,unit_kind FROM fetch_units").all()).results,
  ).toEqual([{ unit_key: "balance-summary", unit_kind: "container" }]);
  expect(
    (
      await env.DB.prepare(
        "SELECT dataset,artifact_key,artifact_role,payload_fidelity,lineage_disposition FROM fetch_artifacts",
      ).all()
    ).results,
  ).toEqual([
    {
      dataset: "prestia-bank-balance-html",
      artifact_key: "balance.html",
      artifact_role: "sanitized_provider_capture",
      payload_fidelity: "transformed",
      lineage_disposition: "source_not_retained_for_security",
    },
  ]);
  expect(await sweep(env)).toMatchObject({ parsed: 1, error: 0 });
  expect(
    (await env.DB.prepare("SELECT parser_name,parser_version FROM published_parse_runs").all())
      .results,
  ).toEqual([{ parser_name: "prestia-bank-balances", parser_version: "1.0.0" }]);
  expect(
    (
      await env.DB.prepare(
        "SELECT completeness,membership_complete,observed_count,parent_run_status,parent_run_failure_count FROM parse_coverage_claims",
      ).all()
    ).results,
  ).toEqual([
    {
      completeness: "complete",
      membership_complete: 1,
      observed_count: 12,
      parent_run_status: "success",
      parent_run_failure_count: 0,
    },
  ]);

  const native = (
    await env.DB.prepare(
      "SELECT source_account,metric,instrument,amount_text,amount_scale FROM balance_observations ORDER BY id",
    ).all<{
      source_account: string;
      metric: string;
      instrument: string;
      amount_text: string;
      amount_scale: number;
    }>()
  ).results;
  expect(native).toHaveLength(6);
  expect(native.filter((r) => r.metric === "available_balance")).toHaveLength(5);
  expect(native.find((r) => r.instrument === "KWD")).toMatchObject({
    amount_text: "0.00750",
    amount_scale: 5,
  });
  expect(
    native.find((r) => r.instrument === "EUR" && r.metric === "available_balance"),
  ).toMatchObject({ amount_text: "12.3400", amount_scale: 4 });
  expect(native.find((r) => r.metric === "term_deposit_principal")).toMatchObject({
    source_account: "prestia-bank:account:24682468:EUR:deposit:54321",
    amount_text: "700.230",
    amount_scale: 3,
  });

  const provider = (
    await env.DB.prepare(
      "SELECT id,source_account,subject,metric,currency,amount_text,extra_json FROM valuation_observations ORDER BY metric,subject",
    ).all<{
      id: number;
      source_account: string;
      subject: string;
      metric: string;
      currency: string;
      amount_text: string;
      extra_json: string;
    }>()
  ).results;
  expect(provider).toHaveLength(6);
  expect(provider.find((r) => r.metric === "provider_yen_equivalent")).toMatchObject({
    source_account: "prestia-bank:group:foreign-deposits",
    currency: "JPY",
    amount_text: "98765",
  });
  const monthly = provider.filter((r) => r.metric.startsWith("provider_monthly_average_"));
  expect(monthly.map((r) => r.metric)).toEqual([
    "provider_monthly_average_foreign_currency_balance",
    "provider_monthly_average_liquid_deposit_balance",
    "provider_monthly_average_total_relationship_balance",
  ]);
  for (const row of provider) {
    const definition = resolveMetric({
      family: "valuation",
      sourceId: "prestia",
      parserName: "prestia-bank-balances",
      metric: row.metric,
      sourceAccount: row.source_account,
      amountBasis: null,
    });
    expect(definition.metricId).not.toBe("unknown");
    expect(definition.aggregationRule).toBe("non-additive");
    expect(definition.netAssetEligible).toBe(false);
  }
  for (const row of monthly) {
    expect(row.source_account).toBe("prestia-bank:relationship");
    expect(JSON.parse(row.extra_json)._kogane).toMatchObject({
      timeBasis: "provider-monthly-average",
      periodBasis: "provider-reference-at-previous-business-day",
      periodStatus: "not-stated",
      aggregationRule: "non-additive",
    });
  }
  const fx = provider.find((r) => r.metric === "provider_yen_equivalent")!;
  expect(JSON.parse(fx.extra_json)._kogane).toMatchObject({
    valuationBasis: "bank-latest-ttb",
    allocation: "not-stated",
  });
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM balance_observations b JOIN published_parse_runs p ON p.parse_run_id=b.parse_run_id",
    ).first<number>("n"),
  ).toBe(6);
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM valuation_observations v JOIN published_parse_runs p ON p.parse_run_id=v.parse_run_id",
    ).first<number>("n"),
  ).toBe(6);
  expect(
    await env.DB.prepare("SELECT count(*) AS n FROM transaction_observations").first<number>("n"),
  ).toBe(0);
  // Existing evidence/detail readers expose bank valuations without inventing positions
  // or adding provider totals/monthly averages to the native balance screen.
  const reader = createD1ObservationReader(env.DB);
  const nativeRead = await reader.listLatestBalances({
    source: "prestia",
    offset: 0,
    limit: PAGE_LIMIT,
  });
  expect(nativeRead).toHaveLength(6);
  const artifactId = await env.DB.prepare("SELECT id FROM fetch_artifacts").first<number>("id");
  const detail = await reader.getArtifact(artifactId!);
  expect(detail?.parseRuns).toHaveLength(1);
  expect(detail?.parseRuns[0]?.observations).toHaveLength(12);
  expect(detail?.parseRuns[0]?.observations.filter((r) => r.kind === "valuation")).toHaveLength(6);
  for (const row of provider) {
    const observed = await reader.getObservation({ kind: "valuation", id: row.id });
    expect(observed?.row).toMatchObject({
      metric: row.metric,
      amount_text: row.amount_text,
      currency: "JPY",
    });
    expect(observed?.extraParsed).toBe(true);
    expect(observed?.provenance).toBeDefined();
    expect(observed?.extra).toEqual(JSON.parse(row.extra_json));
  }
});
