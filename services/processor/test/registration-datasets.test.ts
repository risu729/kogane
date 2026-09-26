// ADR 0022 against every real migration: registration gives a shared-R2
// artifact the dataset its parser reads, and what a registration contract
// version bump would do to a capture that is already registered.
//
// Synthetic bytes only: the shared parser fixtures and the Mizuho fixture.
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
import {
  REGISTRATION_CONTRACT_VERSION,
  registerTerminal,
} from "../../../packages/application/src/collection/index.ts";
import { mobileSuicaRunPlan } from "../../collector-mobile-suica/src/shared-run.ts";
import { registerCollectionRun } from "../src/collection/index.ts";
import { sweep } from "../src/worker.ts";
import { artifact, run } from "./collection-harness.ts";
import {
  mizuhoAccountHtml,
  mizuhoHistoryHtml,
  mizuhoHistoryRow,
} from "../../../packages/parsers/test/mizuho-fixture.ts";
import { FIXTURES_ROOT } from "../../../packages/parsers/test/fixture-root.ts";
import {
  BALANCE_HISTORY_SQL,
  latestBalancesSql,
  transactionsSql,
  VPASS_STATEMENT_SNAPSHOT_CTES,
} from "../../../packages/read-model/src/sql.ts";
import { currentCardUsageSql } from "../../../packages/read-model/src/card-usage.ts";
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
      r2Buckets: ["EVIDENCE"],
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
    SHARED_R2_INGEST_ENABLED: "true",
    COLLECTION_INGEST_CLIENT: "processor-shared-r2",
  } as unknown as Env;
}, 60000);

afterAll(async () => {
  await mf?.dispose();
});

async function rows(query: { sql: string; args: readonly unknown[] }): Promise<unknown[]> {
  return (
    await env.DB.prepare(query.sql)
      .bind(...query.args)
      .all()
  ).results;
}

test("a Mobile Suica terminal registers its normalized rows as `sf-history` and they parse once", async () => {
  const sfHistory = readFileSync(`${FIXTURES_ROOT}mobile-suica-parser-boundaries/sf-history.json`);
  const plan = await mobileSuicaRunPlan({
    runId: "suica-synthetic-1",
    producerVersion: "synthetic-v1",
    attemptId: "attempt-suica-synthetic-1",
    startedAt: "2026-08-30T01:00:00.000Z",
    completedAt: "2026-08-30T01:01:00.000Z",
    status: "success",
    asOfDateJst: "2026-08-30",
    complete: true,
    artifacts: [
      {
        dataset: "sf-history-html",
        filename: "sf-history-page-0001.html",
        mediaType: "text/html; charset=shift_jis",
        body: "<html><body>synthetic</body></html>",
      },
      {
        dataset: "sf-history",
        filename: "sf-history.json",
        mediaType: "application/json",
        body: new Uint8Array(sfHistory),
      },
      {
        dataset: "collection-summary",
        filename: "collection-summary.json",
        mediaType: "application/json",
        body: "{}",
      },
    ],
    failureCodes: [],
  });
  expect((await persistRun(env.EVIDENCE, plan)).outcome).toBe("persisted");
  const source = { source: "mobile-suica", runId: "suica-synthetic-1" };
  expect(await registerCollectionRun(env, source)).toMatchObject({
    outcome: "registered",
    artifacts: 3,
  });
  expect(
    (
      await env.DB.prepare(
        "SELECT artifact_key,dataset FROM fetch_artifacts WHERE source_id='mobile-suica' ORDER BY artifact_key",
      ).all()
    ).results,
  ).toEqual([
    { artifact_key: "collection-summary.json", dataset: null },
    { artifact_key: "sf-history-page-0001.html", dataset: null },
    { artifact_key: "sf-history.json", dataset: "sf-history" },
  ]);
  expect(await sweep(env)).toMatchObject({ parsed: 1, error: 0 });
  const transactions = transactionsSql({ source: "mobile-suica" }, 0);
  const listed = await rows(transactions);
  expect(listed.length).toBeGreaterThan(0);

  // The same terminal again is the same registration: no second fetch run,
  // no second parse, the same rows.
  expect(await registerCollectionRun(env, source)).toMatchObject({
    outcome: "already_registered",
  });
  expect(await sweep(env)).toMatchObject({ parsed: 0, error: 0 });
  expect(await rows(transactions)).toEqual(listed);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM fetch_runs WHERE source_id='mobile-suica'",
    ).first<number>("n"),
  ).toBe(1);
}, 60000);

test("a collector-vpass capture registers without a dataset, is never parsed and moves no card snapshot", async () => {
  // ADR 0022 withholds Vpass until the collector derives the trusted card
  // binding (ADR 0023). A parsed collector capture would become the current
  // statement snapshot of its card-month and retire the importer-era rows;
  // an unparsed one is never an eligible snapshot.
  const cardUsage = currentCardUsageSql({ afterId: 0, limit: 1000 });
  const eligible = {
    sql: `WITH ${VPASS_STATEMENT_SNAPSHOT_CTES} SELECT COUNT(*) AS n FROM eligible_vpass_snapshots`,
    args: [],
  };
  const before = { usage: await rows(cardUsage), eligible: await rows(eligible) };
  const page = readFileSync(`${FIXTURES_ROOT}vpass-parser-boundaries/web.json`, "utf8");
  const keys = [
    ["card-list.json", "sanitized_provider_capture", '{"synthetic":1}'],
    ["select-card.json", "sanitized_provider_capture", '{"synthetic":2}'],
    ["web-meisai-top.json", "sanitized_provider_capture", '{"synthetic":3}'],
    ["months/202605/top-001.json", "provider_response", page],
  ] as const;
  await persistRun(env.EVIDENCE, {
    run: run({
      source: "vpass",
      producer: "collector-vpass",
      producerVersion: "vpass-worker-card-v1",
      runId: "vpass-synthetic-card-001",
      startedAt: "2026-06-09T23:59:00.000Z",
      completedAt: "2026-06-10T00:00:00.000Z",
      providerOutcome: "success",
      coverageStatus: "partial",
      units: [
        { unitKey: "card-001", unitKind: "card", artifactCount: 4, coverageStatus: "partial" },
      ],
      // A redaction step only on the sanitized captures: CORE refuses to seal
      // a provider response that states one (the collector's current shape
      // is the lineage finding the collector-side PR addresses).
      transformations: keys
        .filter(([, role]) => role === "sanitized_provider_capture")
        .map(([key]) => ({
          transformationId: `redacted:${key}`,
          stepKind: "redacted",
          transformerId: "vpass-json-sanitizer",
          transformerVersion: "1",
          inputArtifactKeys: [],
          outputArtifactKey: key,
        })),
    }),
    artifacts: await Promise.all(
      keys.map(([key, role, body]) =>
        artifact(key, body, { role, mediaType: "application/json", unitKey: "card-001" }),
      ),
    ),
  });
  expect(
    await registerCollectionRun(env, { source: "vpass", runId: "vpass-synthetic-card-001" }),
  ).toMatchObject({ outcome: "registered", artifacts: 4 });
  expect(
    (
      await env.DB.prepare(
        "SELECT COUNT(*) AS artifacts, COUNT(dataset) AS with_dataset FROM fetch_artifacts WHERE source_id='vpass'",
      ).all()
    ).results,
  ).toEqual([{ artifacts: 4, with_dataset: 0 }]);
  expect(await sweep(env)).toMatchObject({ parsed: 0, error: 0 });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM observation_parse_jobs j JOIN fetch_artifacts a ON a.id=j.fetch_artifact_id WHERE a.source_id='vpass'",
    ).first<number>("n"),
  ).toBe(0);
  expect({ usage: await rows(cardUsage), eligible: await rows(eligible) }).toEqual(before);
  expect(before.eligible).toEqual([{ n: 0 }]);
}, 60000);

test("a contract version bump registers a parsed capture again and lists its Mizuho transactions twice", async () => {
  // Why ADR 0022 does not bump REGISTRATION_CONTRACT_VERSION. A bump makes
  // every persisted terminal a new (source, run, digest, version) row: a
  // second fetch run over the same objects, second artifacts, second parses.
  // Container snapshots and latest balances still pick one capture, but a
  // Mizuho history row has no provider identity in the transaction list, so
  // each registration of one capture contributes its rows once more. When a
  // later change resolves that, this test is where it shows.
  const runId = "mizuho-synthetic-bump";
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
  await persistRun(env.EVIDENCE, {
    run: run({
      source: "mizuho-bank",
      producer: "collector-mizuho-bank",
      producerVersion: "1.0.0",
      runId,
      completedAt: "2026-09-01T00:01:00.000Z",
      providerOutcome: "success",
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
  const register = (contractVersion?: string) =>
    registerTerminal({
      env: { DB: env.DB, EVIDENCE: env.EVIDENCE },
      bucket: env.EVIDENCE,
      clientId: "processor-shared-r2",
      source: "mizuho-bank",
      runId,
      ...(contractVersion === undefined ? {} : { contractVersion }),
    });
  expect(await register()).toMatchObject({ outcome: "registered", artifacts: 2 });
  expect(await sweep(env)).toMatchObject({ parsed: 2, error: 0 });
  const transactions = transactionsSql({ source: "mizuho-bank" }, 0);
  const balances = latestBalancesSql({ source: "mizuho-bank" }, 0, PAGE_LIMIT);
  const history = { sql: `${BALANCE_HISTORY_SQL} WHERE fa.source_id = ?`, args: ["mizuho-bank"] };
  const once = {
    transactions: (await rows(transactions)).length,
    balances: (await rows(balances)).length,
    history: (await rows(history)).length,
  };
  expect(once).toEqual({ transactions: 2, balances: 2, history: 2 });

  const bumped = `${REGISTRATION_CONTRACT_VERSION}-bump-probe`;
  expect(await register(bumped)).toMatchObject({ outcome: "registered", artifacts: 2 });
  expect(
    (
      await env.DB.prepare(
        "SELECT registration_contract_version AS version, fetch_run_id IS NOT NULL AS linked FROM collection_runs WHERE source='mizuho-bank' AND run_id=? ORDER BY id",
      )
        .bind(runId)
        .all()
    ).results,
  ).toEqual([
    { version: REGISTRATION_CONTRACT_VERSION, linked: 1 },
    { version: bumped, linked: 1 },
  ]);
  // The objects are the same; the fetch runs, artifacts and parses are new.
  expect(
    await env.DB.prepare(
      "SELECT COUNT(DISTINCT sha256) AS objects, COUNT(*) AS artifacts, COUNT(DISTINCT fetch_run_id) AS runs FROM fetch_artifacts WHERE source_id='mizuho-bank'",
    ).first(),
  ).toEqual({ objects: 2, artifacts: 4, runs: 2 });
  expect(await sweep(env)).toMatchObject({ parsed: 2, error: 0 });
  expect({
    transactions: (await rows(transactions)).length,
    balances: (await rows(balances)).length,
    history: (await rows(history)).length,
  }).toEqual({ transactions: 4, balances: 2, history: 4 });
}, 60000);
