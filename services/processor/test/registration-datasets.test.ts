// ADR 0022 against every real migration: registration gives a shared-R2
// artifact the dataset its parser reads, and the bump to
// `terminal-registration-v2` makes a run sealed under v1 without datasets
// parseable while never parsing one capture twice (INV06).
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
  PREAMBLE_RESERVE,
  REGISTRATION_CONTRACT_VERSION,
  RegistrationBudget,
  registerTerminal,
  STRUCTURE_STEP_RESERVE,
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

/** The version production registered under until ADR 0022. */
const V1 = "terminal-registration-v1";

/** One registration under an explicit contract version (the current one when omitted). */
function register(source: string, runId: string, contractVersion?: string) {
  return registerTerminal({
    env: { DB: env.DB, EVIDENCE: env.EVIDENCE },
    bucket: env.EVIDENCE,
    clientId: "processor-shared-r2",
    source,
    runId,
    ...(contractVersion === undefined ? {} : { contractVersion }),
  });
}

async function rows(query: { sql: string; args: readonly unknown[] }): Promise<unknown[]> {
  return (
    await env.DB.prepare(query.sql)
      .bind(...query.args)
      .all()
  ).results;
}

test("a Mobile Suica run sealed under v1 without datasets registers again under v2 and parses once", async () => {
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
  const runId = "suica-synthetic-1";
  const datasets = () =>
    env.DB.prepare(
      "SELECT fetch_run_id,artifact_key,dataset FROM fetch_artifacts WHERE source_id='mobile-suica' ORDER BY fetch_run_id,artifact_key",
    )
      .all()
      .then((result) => result.results);
  const transactions = transactionsSql({ source: "mobile-suica" }, 0);
  const balances = latestBalancesSql({ source: "mobile-suica" }, 0, PAGE_LIMIT);

  // Production today: sealed under v1, every artifact without a dataset, and
  // nothing parses it.
  const v1 = await register("mobile-suica", runId, V1);
  expect(v1).toMatchObject({ outcome: "registered", artifacts: 3 });
  const v1Run = (v1 as { fetchRunId: number }).fetchRunId;
  expect(await datasets()).toEqual([
    { fetch_run_id: v1Run, artifact_key: "collection-summary.json", dataset: null },
    { fetch_run_id: v1Run, artifact_key: "sf-history-page-0001.html", dataset: null },
    { fetch_run_id: v1Run, artifact_key: "sf-history.json", dataset: null },
  ]);
  expect(await sweep(env)).toMatchObject({ parsed: 0, error: 0 });
  expect(await rows(transactions)).toEqual([]);

  // Under v2 its descriptors change, so it registers again: a second fetch
  // run over the same objects, whose normalized rows carry `sf-history`.
  const v2 = await registerCollectionRun(env, { source: "mobile-suica", runId });
  expect(v2).toMatchObject({ outcome: "registered", artifacts: 3 });
  const v2Run = (v2 as { fetchRunId: number }).fetchRunId;
  expect(v2Run).not.toBe(v1Run);
  expect(await datasets()).toEqual([
    { fetch_run_id: v1Run, artifact_key: "collection-summary.json", dataset: null },
    { fetch_run_id: v1Run, artifact_key: "sf-history-page-0001.html", dataset: null },
    { fetch_run_id: v1Run, artifact_key: "sf-history.json", dataset: null },
    { fetch_run_id: v2Run, artifact_key: "collection-summary.json", dataset: null },
    { fetch_run_id: v2Run, artifact_key: "sf-history-page-0001.html", dataset: null },
    { fetch_run_id: v2Run, artifact_key: "sf-history.json", dataset: "sf-history" },
  ]);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(DISTINCT sha256) AS n FROM fetch_artifacts WHERE source_id='mobile-suica'",
    ).first<number>("n"),
  ).toBe(3);
  expect(await sweep(env)).toMatchObject({ parsed: 1, error: 0 });
  // One parse of one capture: the fixture's two transactions and one current
  // post-transaction balance, each listed once.
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM parse_runs p JOIN fetch_artifacts a ON a.id=p.fetch_artifact_id WHERE a.source_id='mobile-suica'",
    ).first<number>("n"),
  ).toBe(1);
  const listed = await rows(transactions);
  expect(listed).toHaveLength(2);
  expect(await rows(balances)).toHaveLength(1);

  // Delivered again, it is the same registration: nothing new, the same rows.
  expect(await registerCollectionRun(env, { source: "mobile-suica", runId })).toMatchObject({
    outcome: "already_registered",
    fetchRunId: v2Run,
  });
  expect(await sweep(env)).toMatchObject({ parsed: 0, error: 0 });
  expect(await rows(transactions)).toEqual(listed);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM fetch_runs WHERE source_id='mobile-suica'",
    ).first<number>("n"),
  ).toBe(2);
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
  // Registered under v1, then under v2, which withholds the same dataset and
  // so carries the registration over.
  expect(await register("vpass", "vpass-synthetic-card-001", V1)).toMatchObject({
    outcome: "registered",
    artifacts: 4,
  });
  expect(
    await registerCollectionRun(env, { source: "vpass", runId: "vpass-synthetic-card-001" }),
  ).toMatchObject({ outcome: "already_registered" });
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

test("a Mizuho capture parsed under v1 is carried over by v2, not registered and listed twice", async () => {
  // A bump makes every persisted terminal a new (source, run, digest,
  // version) row. Registered again, a capture parsed under v1 would be a
  // second fetch run, second artifacts and second parses; Mizuho history rows
  // have no provider identity in the transaction list, so each would be
  // listed twice. v2 does not change a Mizuho descriptor, so the v2 row is
  // linked to the fetch run the terminal already is.
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
  expect(await register("mizuho-bank", runId, V1)).toMatchObject({
    outcome: "registered",
    artifacts: 2,
  });
  expect(await sweep(env)).toMatchObject({ parsed: 2, error: 0 });
  const transactions = transactionsSql({ source: "mizuho-bank" }, 0);
  const balances = latestBalancesSql({ source: "mizuho-bank" }, 0, PAGE_LIMIT);
  const history = { sql: `${BALANCE_HISTORY_SQL} WHERE fa.source_id = ?`, args: ["mizuho-bank"] };
  const listed = async () => ({
    transactions: (await rows(transactions)).length,
    balances: (await rows(balances)).length,
    history: (await rows(history)).length,
  });
  expect(await listed()).toEqual({ transactions: 2, balances: 2, history: 2 });
  const fetchRun = await env.DB.prepare(
    "SELECT fetch_run_id FROM collection_runs WHERE source='mizuho-bank' AND run_id=?",
  )
    .bind(runId)
    .first<number>("fetch_run_id");

  // The carry-over is one bounded step: the preamble and one structure step.
  const budget = new RegistrationBudget();
  expect(
    await registerCollectionRun(env, { source: "mizuho-bank", runId }, { budget }),
  ).toMatchObject({ outcome: "already_registered", fetchRunId: fetchRun });
  expect(budget.meter.total).toBeLessThanOrEqual(PREAMBLE_RESERVE + STRUCTURE_STEP_RESERVE);
  expect(
    (
      await env.DB.prepare(
        "SELECT registration_contract_version AS version, fetch_run_id FROM collection_runs WHERE source='mizuho-bank' AND run_id=? ORDER BY id",
      )
        .bind(runId)
        .all()
    ).results,
  ).toEqual([
    { version: V1, fetch_run_id: fetchRun },
    { version: REGISTRATION_CONTRACT_VERSION, fetch_run_id: fetchRun },
  ]);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(DISTINCT sha256) AS objects, COUNT(*) AS artifacts, COUNT(DISTINCT fetch_run_id) AS runs FROM fetch_artifacts WHERE source_id='mizuho-bank'",
    ).first<Record<string, number>>(),
  ).toEqual({ objects: 2, artifacts: 2, runs: 1 });
  expect(await sweep(env)).toMatchObject({ parsed: 0, error: 0 });
  expect(await listed()).toEqual({ transactions: 2, balances: 2, history: 2 });
  // Asked again, still one registration.
  expect(await registerCollectionRun(env, { source: "mizuho-bank", runId })).toMatchObject({
    outcome: "already_registered",
    fetchRunId: fetchRun,
  });
}, 60000);
