// Synthetic HTML only. Exercise the production terminal, registry, parser,
// publication and READ projection boundaries against every real migration.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import {
  CORE_MIGRATIONS_URL,
  applyReadMigrations,
  migrationFiles,
  migrationSql,
  splitSqlStatements,
} from "../../../packages/storage-d1/src/migrations.ts";
import { persistRun } from "../../../packages/collection/src/writer.ts";
import { registerCollectionRun } from "../src/collection/index.ts";
import { sweep } from "../src/worker.ts";
import { runBalanceProjection } from "../src/balance-projection-job.ts";
import { artifact, run } from "./collection-harness.ts";
import {
  mizuhoAccountHtml,
  mizuhoAccountCard,
  mizuhoHistoryHtml,
  mizuhoHistoryRow,
} from "../../../packages/parsers/test/mizuho-fixture.ts";
import { latestBalancesSql, transactionsSql } from "../../../packages/read-model/src/sql.ts";
import { PAGE_LIMIT } from "../../../packages/read-model/src/scope.ts";

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
    for (const sql of splitSqlStatements(migrationSql(CORE_MIGRATIONS_URL, file)))
      await db.prepare(sql).run();
  const bootstrap = readFileSync(
    new URL("../../../infra/bootstrap/ingest-clients.sql", import.meta.url),
    "utf8",
  );
  for (const sql of splitSqlStatements(bootstrap)) await db.prepare(sql).run();
  await applyReadMigrations(read);
  env = {
    DB: db,
    READ: read,
    EVIDENCE: await mf.getR2Bucket("EVIDENCE"),
    DATA: await mf.getR2Bucket("DATA"),
    BALANCE_PROJECTION_ENABLED: "1",
    SHARED_R2_INGEST_ENABLED: "true",
    COLLECTION_INGEST_CLIENT: "processor-shared-r2",
  } as unknown as Env;
}, 60000);

afterAll(async () => {
  await mf?.dispose();
});

async function persistPages(
  runId: string,
  pages: readonly { key: string; unit: string; html: string }[],
  producer = "collector-mizuho-bank",
  providerOutcome: "success" | "partial" = "success",
  completedAt = "2026-09-01T00:01:00.000Z",
) {
  return persistRun(env.EVIDENCE, {
    run: run({
      source: "mizuho-bank",
      producer,
      producerVersion: "1.0.0",
      runId,
      completedAt,
      // A complete captured page never asserts that all bank history was read.
      providerOutcome,
      ...(providerOutcome === "partial" ? { safeErrorCode: "history-request-failed" } : {}),
      coverageStatus: "partial",
      units: pages.map((page) => ({
        unitKey: page.unit,
        unitKind: "page",
        artifactCount: 1,
        coverageStatus: "complete",
      })),
      transformations: pages.map((page, index) => ({
        transformationId: `redact-${String(index)}`,
        stepKind: "redacted",
        transformerId: "mizuho-bank-html-sanitizer",
        transformerVersion: "1.0.0",
        inputArtifactKeys: [],
        outputArtifactKey: page.key,
      })),
    }),
    artifacts: await Promise.all(
      pages.map((page) =>
        artifact(page.key, page.html, {
          role: "sanitized_provider_capture",
          mediaType: "text/html",
          unitKey: page.unit,
        }),
      ),
    ),
  });
}

test("Mizuho terminal registers, publishes exact observations and projects balances without summing availability", async () => {
  const pages = [
    { key: "account-list.html", unit: "account-list", html: mizuhoAccountHtml() },
    {
      key: "ordinary/001-1234567/history/1-2.html",
      unit: "ordinary:001:1234567:page:1:2",
      html: mizuhoHistoryHtml(
        mizuhoHistoryRow("000", "+ 5", "1,234") + mizuhoHistoryRow("001", "- 2", "1,229"),
        "1&nbsp;-&nbsp;2&nbsp;件",
        "3",
      ),
    },
  ];
  expect((await persistPages("mizuho-synthetic-1", pages)).outcome).not.toBe("conflict");
  const registration = await registerCollectionRun(env, {
    source: "mizuho-bank",
    runId: "mizuho-synthetic-1",
  });
  expect(registration).toMatchObject({ outcome: "registered", artifacts: 2 });
  expect(
    (
      await env.DB.prepare("SELECT source_id,producer_id FROM fetch_runs ORDER BY id").all<{
        source_id: string;
        producer_id: string;
      }>()
    ).results,
  ).toEqual([{ source_id: "mizuho-bank", producer_id: "collector-mizuho-bank" }]);
  const registered = await env.DB.prepare(
    "SELECT dataset,artifact_role,payload_fidelity,lineage_disposition FROM fetch_artifacts ORDER BY id",
  ).all<Record<string, unknown>>();
  expect(registered.results).toEqual(
    pages.map(() => ({
      dataset: null,
      artifact_role: "sanitized_provider_capture",
      payload_fidelity: "transformed",
      lineage_disposition: "source_not_retained_for_security",
    })),
  );
  expect(await sweep(env)).toMatchObject({ parsed: 2, error: 0 });
  const publications = await env.DB.prepare(
    "SELECT parser_name,parser_version FROM published_parse_runs ORDER BY parser_name",
  ).all<{ parser_name: string; parser_version: string }>();
  expect(publications.results).toEqual([
    { parser_name: "mizuho-account-list", parser_version: "1.0.0" },
    { parser_name: "mizuho-ordinary-history", parser_version: "1.0.0" },
  ]);
  const balances = await env.DB.prepare(
    "SELECT source_account,metric,amount_minor,instrument FROM balance_observations ORDER BY metric",
  ).all<Record<string, unknown>>();
  expect(balances.results).toEqual([
    {
      source_account: "mizuho-bank:ordinary:001:1234567",
      metric: "account_balance",
      amount_minor: 1234,
      instrument: "JPY",
    },
    {
      source_account: "mizuho-bank:ordinary:001:1234567",
      metric: "available_balance",
      amount_minor: 1234,
      instrument: "JPY",
    },
  ]);
  const transactions = await env.DB.prepare(
    "SELECT source_account,status,amount_minor,currency,extra_json FROM transaction_observations ORDER BY id",
  ).all<{
    source_account: string;
    status: string;
    amount_minor: number;
    currency: string;
    extra_json: string;
  }>();
  expect(transactions.results.map(({ extra_json: _extra, ...row }) => row)).toEqual([
    {
      source_account: "mizuho-bank:ordinary:001:1234567",
      status: "posted",
      amount_minor: 5,
      currency: "JPY",
    },
    {
      source_account: "mizuho-bank:ordinary:001:1234567",
      status: "posted",
      amount_minor: -2,
      currency: "JPY",
    },
  ]);
  expect(transactions.results.map((row) => JSON.parse(row.extra_json)._kogane)).toEqual(
    transactions.results.map(() =>
      expect.objectContaining({ coverageScope: "observed-page-only", hasMore: true }),
    ),
  );
  const projection = await runBalanceProjection(env);
  expect(projection).toMatchObject({ enabled: true, status: "complete", rowCount: 2 });
  const projected = await env.READ.prepare(
    "SELECT metric_id,quantity_coefficient,state FROM current_balance_projection WHERE snapshot_id=? ORDER BY metric_id",
  )
    .bind(projection.snapshotId)
    .all<{ metric_id: string; quantity_coefficient: string; state: string }>();
  expect(
    projected.results.map(({ metric_id, quantity_coefficient }) => ({
      metric_id,
      quantity_coefficient,
    })),
  ).toEqual([
    { metric_id: "deposit.available-balance", quantity_coefficient: "1234" },
    { metric_id: "deposit.balance", quantity_coefficient: "1234" },
  ]);
  expect(projected.results.find((row) => row.metric_id === "deposit.balance")?.state).toBe(
    "adopted",
  );
  // Queue redelivery never creates another parse or doubles the displayed amount.
  expect(
    await registerCollectionRun(env, { source: "mizuho-bank", runId: "mizuho-synthetic-1" }),
  ).toMatchObject({ outcome: "already_registered" });
  expect(await sweep(env)).toMatchObject({ parsed: 0, error: 0 });
  expect(await runBalanceProjection(env)).toMatchObject({ status: "unchanged" });
}, 60000);

test("a different bank's collector cannot register Mizuho evidence", async () => {
  await persistPages(
    "mizuho-wrong-producer",
    [{ key: "account-list.html", unit: "account-list", html: mizuhoAccountHtml() }],
    "collector-smbc-direct",
  );
  expect(
    await registerCollectionRun(env, { source: "mizuho-bank", runId: "mizuho-wrong-producer" }),
  ).toMatchObject({ outcome: "retryable", code: "inactive_ingest_route" });
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM fetch_runs").first<number>("n")).toBe(1);
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM published_parse_runs").first<number>("n"),
  ).toBe(2);
}, 30000);

async function accountRemovalRegression() {
  const historyB = {
    key: "ordinary/002-7654321/history/1-1.html",
    unit: "ordinary:002:7654321:page:1:1",
    html: mizuhoHistoryHtml().replace("1234567", "7654321"),
  };
  await persistPages(
    "mizuho-account-removal-before",
    [
      {
        key: "account-list.html",
        unit: "account-list",
        html: mizuhoAccountHtml(mizuhoAccountCard() + mizuhoAccountCard("001", "002-7654321")),
      },
      historyB,
    ],
    "collector-mizuho-bank",
    "success",
    "2026-09-02T00:01:00.000Z",
  );
  expect(
    await registerCollectionRun(env, {
      source: "mizuho-bank",
      runId: "mizuho-account-removal-before",
    }),
  ).toMatchObject({ outcome: "registered", artifacts: 2 });
  expect(await sweep(env)).toMatchObject({ parsed: 2, error: 0 });
  const before = await runBalanceProjection(env);
  expect(before).toMatchObject({ status: "complete", rowCount: 4 });

  await persistPages(
    "mizuho-account-removal-after",
    [{ key: "account-list.html", unit: "account-list", html: mizuhoAccountHtml() }],
    "collector-mizuho-bank",
    "success",
    "2026-09-03T00:01:00.000Z",
  );
  expect(
    await registerCollectionRun(env, {
      source: "mizuho-bank",
      runId: "mizuho-account-removal-after",
    }),
  ).toMatchObject({ outcome: "registered", artifacts: 1 });
  // Registered bytes alone must not replace an adopted complete snapshot.
  const balances = latestBalancesSql({ source: "mizuho-bank" }, 0, PAGE_LIMIT);
  expect(
    (
      await env.DB.prepare(balances.sql)
        .bind(...balances.args)
        .all()
    ).results,
  ).toHaveLength(4);
  expect(await sweep(env)).toMatchObject({ parsed: 1, error: 0 });
  const after = await runBalanceProjection(env);
  expect(after).toMatchObject({ status: "complete", rowCount: 2 });

  const current = await env.DB.prepare(balances.sql)
    .bind(...balances.args)
    .all<{ source_account: string }>();
  expect(current.results.map((row) => row.source_account)).toEqual([
    "mizuho-bank:ordinary:001:1234567",
    "mizuho-bank:ordinary:001:1234567",
  ]);
  // Account membership replaces current balances, never append-only history.
  const history = transactionsSql(
    { source: "mizuho-bank", account: "mizuho-bank:ordinary:002:7654321" },
    0,
  );
  const retained = await env.DB.prepare(history.sql)
    .bind(...history.args)
    .all<{ source_account: string }>();
  expect(retained.results).toHaveLength(1);
  expect(retained.results[0]?.source_account).toBe("mizuho-bank:ordinary:002:7654321");
}

test("an acquisition failure preserves evidence without publishing the successful page as a complete run", async () => {
  await persistPages(
    "mizuho-partial-acquisition",
    [{ key: "account-list.html", unit: "account-list", html: mizuhoAccountHtml() }],
    "collector-mizuho-bank",
    "partial",
  );
  expect(
    await registerCollectionRun(env, {
      source: "mizuho-bank",
      runId: "mizuho-partial-acquisition",
    }),
  ).toMatchObject({ outcome: "registered", artifacts: 1 });
  expect(await sweep(env)).toMatchObject({ parsed: 0, error: 0 });
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM published_parse_runs").first<number>("n"),
  ).toBe(2);
  // The failed collection updates freshness provenance, but contributes no
  // replacement balance to the new projection.
  const projection = await runBalanceProjection(env);
  expect(projection).toMatchObject({ status: "complete", rowCount: 2 });
  expect(
    (
      await env.READ.prepare(
        "SELECT quantity_coefficient FROM current_balance_projection WHERE snapshot_id=? ORDER BY metric_id",
      )
        .bind(projection.snapshotId)
        .all<{ quantity_coefficient: string }>()
    ).results,
  ).toEqual([{ quantity_coefficient: "1234" }, { quantity_coefficient: "1234" }]);
}, 30000);

test(
  "a later complete account list removes absent balances while preserving their history",
  accountRemovalRegression,
  60000,
);
