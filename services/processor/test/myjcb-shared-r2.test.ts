// ADR 0025 end to end: a MyJCB run the collector persisted to the shared
// bucket - built by its real `myJcbRunPlan`, so the manifest carries no
// `connectionId` or `filename` - registers, and its ledger and statement
// pages parse with the statement state and period its manifest states. Those
// values reach `observation_fetch_artifacts`, the ledgers are the current
// MyJCB snapshots, and purchase recognition recognises their rows.
//
// Needs ADR 0021 (the collector states the ledger's lineage, so the run
// registers) and ADR 0022 (registration gives the artifacts their parser
// datasets). Everything is synthetic: no amount, merchant, account label or
// date here is a production value.
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
import { resolveIdentity } from "../../../packages/identity/src/index.ts";
import { MYJCB_LEDGER_SNAPSHOT_CTES } from "../../../packages/read-model/src/sql.ts";
import { currentCardUsageSql } from "../../../packages/read-model/src/card-usage.ts";
import { myJcbRunPlan, PRODUCER } from "../../collector-myjcb/src/shared-collection.ts";
import type { RawArtifact } from "../../collector-myjcb/src/types.ts";
import { registerCollectionRun } from "../src/collection/index.ts";
import { cardPurchaseSweep } from "../src/card-purchase-job.ts";
import { identitySweep } from "../src/identity-store.ts";
import { sweep } from "../src/worker.ts";

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
  // The ingest registry exactly as an operator applies it.
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

const RUN_ID = "00000000-0000-4000-8000-00000000a025";
const CONNECTION = "synthetic-conn";

/** A redacted statement page in the shape `redactedStatementHtml` leaves. */
function statementPage(heading: string): string {
  return `<!doctype html><html><body><h1>MyJCB</h1>${heading}<div class="detail-list-01"></div></body></html>`;
}
const CONFIRMED_PAGE = statementPage(
  "<h1>カードご利用代金明細(確定分)</h1><h2>2026年10月お支払い分のカードご利用明細</h2><dl><dt>2026年10月10日(土)お支払い金額合計</dt><dd>1,500円</dd></dl>",
);
const UNCONFIRMED_PAGE = statementPage("<h1>カードご利用代金明細(未確定分)</h1>");

/** A `credit-ledger-NN.json` in the collector's shape (`collectCredit`). */
function ledger(
  detailMonth: number,
  period: string,
  state: "confirmed" | "unconfirmed",
  rows: readonly { date: string; merchant: string; amount: string }[],
): string {
  return JSON.stringify({
    schemaVersion: 1,
    detailMonth,
    period,
    state,
    headers:
      state === "confirmed"
        ? ["ご利用日", "ご利用先など", "支払区分", "今回のお支払い金額"]
        : ["ご利用日", "ご利用先など", "支払区分", "ご利用金額"],
    rows: rows.map((row) => ({
      summaryCells: [row.date, `${row.merchant} 1回払`, "架空", row.amount],
      expanded:
        state === "confirmed"
          ? { ご利用金額: row.amount, 今回回数: "", 摘要: "", 備考: "", 訂正サイン: "" }
          : { 今回のお支払い金額: row.amount, 今回回数: "" },
    })),
  });
}

const HTML = "text/html; charset=utf-8";
const JSON_TYPE = "application/json";
const artifacts: RawArtifact[] = [
  {
    dataset: "credit-detail",
    filename: "credit-detail-00.html",
    body: UNCONFIRMED_PAGE,
    mediaType: HTML,
    statementState: "unconfirmed",
    period: "detailMonth-0",
  },
  {
    dataset: "credit-ledger",
    filename: "credit-ledger-00.json",
    body: ledger(0, "detailMonth-0", "unconfirmed", [
      { date: "2026/09/15", merchant: "架空店舗P", amount: "300" },
    ]),
    mediaType: JSON_TYPE,
    statementState: "unconfirmed",
    period: "detailMonth-0",
  },
  {
    dataset: "credit-detail",
    filename: "credit-detail-01.html",
    body: CONFIRMED_PAGE,
    mediaType: HTML,
    statementState: "confirmed",
    period: "2026-10",
  },
  {
    dataset: "credit-ledger",
    filename: "credit-ledger-01.json",
    body: ledger(1, "2026-10", "confirmed", [
      { date: "2026/08/02", merchant: "架空店舗Q", amount: "1,000" },
      { date: "2026/08/09", merchant: "架空店舗R", amount: "500" },
    ]),
    mediaType: JSON_TYPE,
    statementState: "confirmed",
    period: "2026-10",
  },
];

/** The collector's own plan for one successful single-connection run. */
function runPlan(runId: string, startedAt: string, completedAt: string) {
  return myJcbRunPlan({
    schemaVersion: "myjcb-worker-poc-v1",
    runId,
    startedAt,
    completedAt,
    status: "success",
    trigger: "scheduled",
    connections: [
      {
        summary: {
          connectionId: CONNECTION,
          bootstrapMode: "password",
          status: "success",
          cardCount: 1,
          periodCount: 2,
          artifactCount: artifacts.length,
        },
        artifacts,
      },
    ],
    failures: [],
  });
}

/** The fetch run CORE registered for a collector run id. */
const fetchRun = (runId: string) =>
  env.DB.prepare("SELECT id FROM observation_fetch_runs WHERE external_run_id=?")
    .bind(runId)
    .first<number>("id");
const workItem = async (runId: string) =>
  env.DB.prepare("SELECT outcome,jobs_created FROM observation_work_items WHERE fetch_run_id=?")
    .bind(await fetchRun(runId))
    .first();

test("open limit: the collector's successful run registers but is not eligible, because every unit reports partial coverage", async () => {
  // `myJcbRunPlan` downgrades a successful connection's unit coverage to
  // `partial` (a card exposes a rolling set of periods), registration maps a
  // partial unit to the unit outcome `partial` (`unitReportRequest`), and a
  // run with a non-success unit report is `partial` in
  // `observation_fetch_runs`, which neither the run scope nor the unit scope
  // (`unit-independent-v1`) admits. No parse job is created, so the metadata
  // extractor is never reached. This blocker is separate from ADR 0025's.
  const runId = "00000000-0000-4000-8000-00000000a024";
  const plan = await runPlan(runId, "2026-09-19T00:00:00.000Z", "2026-09-19T00:05:00.000Z");
  expect(plan.run.units.map((unit) => unit.coverageStatus)).toEqual(["partial"]);
  expect((await persistRun(env.EVIDENCE, plan)).outcome).toBe("persisted");
  expect(await registerCollectionRun(env, { source: "myjcb", runId })).toMatchObject({
    outcome: "registered",
    artifacts: 5,
  });
  expect(
    (
      await env.DB.prepare(
        "SELECT r.status,ur.normalized_outcome AS unit_outcome FROM observation_fetch_runs r JOIN fetch_units u ON u.fetch_run_id=r.id JOIN fetch_unit_reports ur ON ur.fetch_unit_id=u.id WHERE r.external_run_id=?",
      )
        .bind(runId)
        .all()
    ).results,
  ).toEqual([{ status: "partial", unit_outcome: "partial" }]);
  expect(await sweep(env)).toMatchObject({ parsed: 0, error: 0 });
  expect(await workItem(runId)).toEqual({ outcome: "not_eligible", jobs_created: 0 });
}, 60000);

test("a shared-R2 MyJCB run parses with the statement state and period its manifest states", async () => {
  const plan = await runPlan(RUN_ID, "2026-09-20T00:00:00.000Z", "2026-09-20T00:05:00.000Z");
  // The manifest the collector wrote is the shared shape: no entry names a
  // connection or a file.
  const manifest = plan.artifacts.find((entry) => entry.artifactKey === "manifest.json")!;
  const manifestJson = JSON.parse(
    new TextDecoder().decode((manifest.body as { bytes: Uint8Array }).bytes),
  ) as { artifacts: Record<string, unknown>[] };
  expect(manifestJson.artifacts).toHaveLength(4);
  for (const entry of manifestJson.artifacts) {
    expect(entry).not.toHaveProperty("connectionId");
    expect(entry).not.toHaveProperty("filename");
  }
  // The one field changed from the collector's plan: the successful
  // connection's unit claims complete coverage, so its unit report is
  // `success` as the importer's was, standing in for the fix of the open limit
  // above. Every byte, key, role, lineage step and the manifest are the
  // collector's own.
  const eligible = {
    ...plan,
    run: {
      ...plan.run,
      units: plan.run.units.map((unit) => ({ ...unit, coverageStatus: "complete" as const })),
    },
  };

  expect((await persistRun(env.EVIDENCE, eligible)).outcome).toBe("persisted");
  expect(await registerCollectionRun(env, { source: "myjcb", runId: RUN_ID })).toMatchObject({
    outcome: "registered",
    artifacts: 5,
  });

  expect(await sweep(env)).toMatchObject({ parsed: 4, error: 0 });
  expect(await workItem(RUN_ID)).toEqual({ outcome: "jobs_created", jobs_created: 4 });
  expect(
    (
      await env.DB.prepare(
        "SELECT j.status,j.last_error_code,COUNT(*) AS n FROM observation_parse_jobs j JOIN fetch_artifacts a ON a.id=j.fetch_artifact_id WHERE a.source_id='myjcb' GROUP BY 1,2",
      ).all()
    ).results,
  ).toEqual([{ status: "done", last_error_code: null, n: 4 }]);

  // The manifest's values, and only those, reach the observation view; the
  // artifacts the manifest gives none have none.
  expect(
    (
      await env.DB.prepare(
        "SELECT artifact_key,dataset,statement_state,period FROM observation_fetch_artifacts WHERE fetch_run_id=? ORDER BY artifact_key",
      )
        .bind(await fetchRun(RUN_ID))
        .all()
    ).results,
  ).toEqual([
    { artifact_key: "manifest.json", dataset: null, statement_state: null, period: null },
    {
      artifact_key: `${CONNECTION}/credit-detail-00.html`,
      dataset: "credit-detail",
      statement_state: "unconfirmed",
      period: "detailMonth-0",
    },
    {
      artifact_key: `${CONNECTION}/credit-detail-01.html`,
      dataset: "credit-detail",
      statement_state: "confirmed",
      period: "2026-10",
    },
    {
      artifact_key: `${CONNECTION}/credit-ledger-00.json`,
      dataset: "credit-ledger",
      statement_state: "unconfirmed",
      period: "detailMonth-0",
    },
    {
      artifact_key: `${CONNECTION}/credit-ledger-01.json`,
      dataset: "credit-ledger",
      statement_state: "confirmed",
      period: "2026-10",
    },
  ]);
  // Each extraction is recorded against the run's manifest.
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM metadata_projections p JOIN fetch_artifacts a ON a.id=p.fetch_artifact_id WHERE a.source_id='myjcb' AND p.status='ok' AND p.extractor_release='legacy-metadata-v1'",
    ).first<number>("n"),
  ).toBe(4);

  // Both ledgers are current: the pending one in the connection's single
  // unconfirmed slot, the confirmed one in its named payment month.
  expect(
    (
      await env.DB.prepare(
        `WITH ${MYJCB_LEDGER_SNAPSHOT_CTES} SELECT a.artifact_key,s.statement_slot FROM current_myjcb_snapshots s JOIN fetch_artifacts a ON a.id=s.fetch_artifact_id ORDER BY a.artifact_key`,
      ).all()
    ).results,
  ).toEqual([
    { artifact_key: `${CONNECTION}/credit-ledger-00.json`, statement_slot: "" },
    { artifact_key: `${CONNECTION}/credit-ledger-01.json`, statement_slot: "2026-10" },
  ]);
  // The confirmed page's statement total is published once.
  expect(
    await env.DB.prepare(
      "SELECT period,payment_date,coefficient FROM card_statement_facts WHERE source_id='myjcb'",
    )
      .all()
      .then((result) => result.results),
  ).toEqual([{ period: "2026-10", payment_date: "2026-10-10", coefficient: "1500" }]);

  // Identified, then recognised: three purchases, each once, under the
  // collector's producer.
  await identitySweep(env.DB, resolveIdentity, 40);
  const usage = currentCardUsageSql({ afterId: 0, limit: 1000 });
  const usageRows = (
    await env.DB.prepare(usage.sql)
      .bind(...usage.args)
      .all<{ producer_id: string }>()
  ).results;
  expect(usageRows).toHaveLength(3);
  expect(new Set(usageRows.map((row) => row.producer_id))).toEqual(new Set([PRODUCER]));
  const result = await cardPurchaseSweep(env.DB, { now: "2026-09-21T00:00:00.000Z" });
  expect(result).toMatchObject({ recognized: 3, retired: 0, conflicts: 0, failed: 0 });
  expect(
    (
      await env.DB.prepare(
        "SELECT c.state,COUNT(*) AS n FROM current_card_purchase_recognitions c GROUP BY c.state ORDER BY c.state",
      ).all()
    ).results,
  ).toEqual([
    { state: "authorized", n: 1 },
    { state: "captured", n: 2 },
  ]);
  // A second pass changes nothing: nothing is counted twice.
  expect(await cardPurchaseSweep(env.DB, { now: "2026-09-21T00:00:00.000Z" })).toMatchObject({
    recognized: 0,
    retired: 0,
  });
}, 60000);
