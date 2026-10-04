// ADR 0025 end to end: a MyJCB run the collector persisted to the shared
// bucket - built by its real `myJcbRunPlan`, so the manifest carries no
// `connectionId` or `filename` - registers, and its ledger and statement
// pages parse with the statement state and period its manifest states. Those
// values reach `observation_fetch_artifacts`, the ledgers are the current
// MyJCB snapshots, and purchase recognition recognises their rows.
//
// Needs ADR 0021 (the collector states the ledger's lineage, so the run
// registers), ADR 0022 (registration gives the artifacts their parser
// datasets) and ADR 0026 (a whole connection's unit claims complete
// coverage, so the run is eligible for parse jobs). Everything is synthetic: no amount, merchant, account label or
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
import { scheduledPaymentRows, sweep } from "../src/worker.ts";

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

test("a terminal written before ADR 0026 registers but is not eligible: its units report partial coverage", async () => {
  // Before ADR 0026 `myJcbRunPlan` downgraded a successful connection's unit
  // coverage to `partial`. Registration maps a partial unit to the unit
  // outcome `partial` (`unitReportRequest`), a run with a non-success unit
  // report is `partial` in `observation_fetch_runs`, and neither the run
  // scope nor the unit scope (`unit-independent-v1`) admits it. Terminals are
  // immutable, so such a run stays `not_eligible`; this reproduces one by
  // restoring the old unit claim on today's plan.
  const runId = "00000000-0000-4000-8000-00000000a024";
  const plan = await runPlan(runId, "2026-09-19T00:00:00.000Z", "2026-09-19T00:05:00.000Z");
  const before0026 = {
    ...plan,
    run: {
      ...plan.run,
      units: plan.run.units.map((unit) => ({ ...unit, coverageStatus: "partial" as const })),
    },
  };
  expect((await persistRun(env.EVIDENCE, before0026)).outcome).toBe("persisted");
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
  // The collector's plan, unchanged (ADR 0026): the successful connection's
  // unit claims complete coverage, so its unit report is `success` as the
  // importer's was, and the run is `success` in `observation_fetch_runs`.
  expect(plan.run.units.map((unit) => unit.coverageStatus)).toEqual(["complete"]);
  expect((await persistRun(env.EVIDENCE, plan)).outcome).toBe("persisted");
  expect(await registerCollectionRun(env, { source: "myjcb", runId: RUN_ID })).toMatchObject({
    outcome: "registered",
    artifacts: 5,
  });
  expect(
    (
      await env.DB.prepare(
        "SELECT r.status,ur.normalized_outcome AS unit_outcome FROM observation_fetch_runs r JOIN fetch_units u ON u.fetch_run_id=r.id JOIN fetch_unit_reports ur ON ur.fetch_unit_id=u.id WHERE r.external_run_id=?",
      )
        .bind(RUN_ID)
        .all()
    ).results,
  ).toEqual([{ status: "success", unit_outcome: "success" }]);

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

  // Both ledgers are current, each in the statement it belongs to (ADR 0016):
  // the pending `detailMonth-0` capture fetched on the 20th resolves to the
  // payment month after next, the confirmed one to the month its page names.
  expect(
    (
      await env.DB.prepare(
        `WITH ${MYJCB_LEDGER_SNAPSHOT_CTES} SELECT a.artifact_key,s.statement_slot FROM current_myjcb_snapshots s JOIN fetch_artifacts a ON a.id=s.fetch_artifact_id ORDER BY a.artifact_key`,
      ).all()
    ).results,
  ).toEqual([
    { artifact_key: `${CONNECTION}/credit-ledger-00.json`, statement_slot: "2026-11" },
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

test("ADR 0005 amendment: a connection that stopped at a month registers and seals its captured months, and stays not_eligible", async () => {
  // The collector's real plan for a connection that stopped at position 1
  // (`month_fetch`) after keeping position 0: its page and ledger. The unit is
  // `partial` with the stop code, which registration turns into a `failed`
  // unit report, so the run is `partial` and nothing is parsed (ADR 0026's
  // eligibility is unchanged). The evidence and the cause are kept.
  const runId = "00000000-0000-4000-8000-00000000a005";
  const kept = artifacts.slice(0, 2);
  const plan = await myJcbRunPlan({
    schemaVersion: "myjcb-worker-poc-v1",
    runId,
    startedAt: "2026-09-22T00:00:00.000Z",
    completedAt: "2026-09-22T00:05:00.000Z",
    status: "partial",
    trigger: "scheduled",
    connections: [
      {
        summary: {
          connectionId: CONNECTION,
          bootstrapMode: "password",
          status: "partial",
          cardCount: 1,
          periodCount: 2,
          artifactCount: kept.length,
          stopCode: "month_fetch",
          stopPosition: 1,
          capturedMonthCount: 1,
        },
        artifacts: kept,
      },
    ],
    failures: [
      { connectionId: CONNECTION, operation: "collect", code: "month_fetch", position: 1 },
    ],
  });
  expect(plan.run.units).toEqual([
    {
      unitKey: CONNECTION,
      unitKind: "connection",
      artifactCount: 2,
      coverageStatus: "partial",
      safeErrorCode: "month_fetch",
    },
  ]);
  expect((await persistRun(env.EVIDENCE, plan)).outcome).toBe("persisted");
  expect(await registerCollectionRun(env, { source: "myjcb", runId })).toMatchObject({
    outcome: "registered",
    artifacts: 3,
  });
  const fetchRunId = await fetchRun(runId);
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM fetch_run_seals WHERE fetch_run_id=?")
      .bind(fetchRunId)
      .first<number>("n"),
  ).toBe(1);
  // Sealed under the current registration contract (ADR 0022).
  expect(
    await env.DB.prepare(
      "SELECT registration_contract_version AS v FROM collection_runs WHERE source='myjcb' AND run_id=?",
    )
      .bind(runId)
      .first<string>("v"),
  ).toBe("terminal-registration-v2");
  expect(
    (
      await env.DB.prepare(
        "SELECT r.status,ur.normalized_outcome AS unit_outcome,ur.safe_failure_code AS code FROM observation_fetch_runs r JOIN fetch_units u ON u.fetch_run_id=r.id JOIN fetch_unit_reports ur ON ur.fetch_unit_id=u.id WHERE r.external_run_id=?",
      )
        .bind(runId)
        .all()
    ).results,
  ).toEqual([{ status: "partial", unit_outcome: "failed", code: "month_fetch" }]);
  // Every captured artifact is catalogued under the run.
  expect(
    (
      await env.DB.prepare(
        "SELECT artifact_key FROM fetch_artifacts WHERE fetch_run_id=? ORDER BY artifact_key",
      )
        .bind(fetchRunId)
        .all()
    ).results,
  ).toEqual([
    { artifact_key: "manifest.json" },
    { artifact_key: `${CONNECTION}/credit-detail-00.html` },
    { artifact_key: `${CONNECTION}/credit-ledger-00.json` },
  ]);
  expect(await sweep(env)).toMatchObject({ parsed: 0, error: 0 });
  expect(await workItem(runId)).toEqual({ outcome: "not_eligible", jobs_created: 0 });
}, 60000);

test("ADR 0005 amendment: a failed run's stopped units carry their codes and the run is recorded, not sealed", async () => {
  // Every connection stopped before its first month: the plan persists only
  // the terminal, whose unit is `unknown` with the stop code and no artifact.
  // Registration refuses a failed run with no provider bytes as before
  // (`provider_run_failed`): recorded, nothing sealed, nothing to parse.
  const runId = "00000000-0000-4000-8000-00000000a006";
  const plan = await myJcbRunPlan({
    schemaVersion: "myjcb-worker-poc-v1",
    runId,
    startedAt: "2026-09-22T00:00:00.000Z",
    completedAt: "2026-09-22T00:05:00.000Z",
    status: "failed",
    trigger: "scheduled",
    connections: [
      {
        summary: {
          connectionId: CONNECTION,
          bootstrapMode: "password",
          status: "failed",
          cardCount: 0,
          periodCount: 0,
          artifactCount: 0,
          stopCode: "credit_past_months",
          capturedMonthCount: 0,
        },
        artifacts: [],
      },
    ],
    failures: [{ connectionId: CONNECTION, operation: "collect", code: "credit_past_months" }],
  });
  expect(plan.artifacts).toEqual([]);
  expect(plan.run.units).toEqual([
    {
      unitKey: CONNECTION,
      unitKind: "connection",
      artifactCount: 0,
      coverageStatus: "unknown",
      safeErrorCode: "credit_past_months",
    },
  ]);
  expect((await persistRun(env.EVIDENCE, plan)).outcome).toBe("persisted");
  expect(await registerCollectionRun(env, { source: "myjcb", runId })).toMatchObject({
    outcome: "blocked",
    code: "provider_run_failed",
  });
  expect(await fetchRun(runId)).toBeNull();
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM collection_runs WHERE source='myjcb' AND run_id=?",
    )
      .bind(runId)
      .first<number>("n"),
  ).toBe(1);
  expect(await sweep(env)).toMatchObject({ parsed: 0, error: 0 });
}, 60000);

test("ADR 0005 second amendment: a month under the third ledger header registers unread, the run stays not_eligible", async () => {
  // The collector's real plan for a connection that read positions 0 and 1
  // and kept position 2 unread: its page shows rows under
  // `ご利用日 / ご利用先など お支払日 / 今後のお支払い金額` (three cells, as the
  // ショッピングスキップ払い schedule page shows it), so it is stored
  // as `unknown` evidence with no ledger, and the connection went on. The unit
  // is `partial` with `scheduled_payments_page`: registration turns it into a
  // `failed` unit report, the run is `partial`, and nothing of it is parsed,
  // so no parser reads the unread month (ADR 0026's eligibility, unchanged).
  const runId = "00000000-0000-4000-8000-00000000a007";
  const scheduledPage =
    '<!doctype html><html><body><h1>MyJCB</h1><div class="detail-list-01"><div class="head"><div class="cell">ご利用日</div><div class="cell">ご利用先など<br>お支払日</div><div class="cell">今後のお支払い金額</div></div><div class="content"><div class="item-cell"><div class="cell">2026/03/10</div><div class="cell">架空分割店</div><div class="cell">2026/04/10</div><div class="cell">3,000円</div></div></div></div></body></html>';
  const kept: RawArtifact[] = [
    ...artifacts,
    {
      dataset: "credit-detail",
      filename: "credit-detail-02.html",
      body: scheduledPage,
      mediaType: HTML,
      statementState: "unknown",
      period: "detailMonth-2",
    },
  ];
  const plan = await myJcbRunPlan({
    schemaVersion: "myjcb-worker-poc-v1",
    runId,
    startedAt: "2026-09-23T00:00:00.000Z",
    completedAt: "2026-09-23T00:05:00.000Z",
    status: "partial",
    trigger: "scheduled",
    connections: [
      {
        summary: {
          connectionId: CONNECTION,
          bootstrapMode: "password",
          status: "partial",
          cardCount: 1,
          periodCount: 3,
          artifactCount: kept.length,
          unreadMonths: [{ position: 2, code: "scheduled_payments_page" }],
          exportOffers: [{ position: 1, kinds: ["pdf", "csv", "ofx"] }],
        },
        artifacts: kept,
      },
    ],
    failures: [],
  });
  expect(plan.run.units).toEqual([
    {
      unitKey: CONNECTION,
      unitKind: "connection",
      artifactCount: 5,
      coverageStatus: "partial",
      safeErrorCode: "scheduled_payments_page",
    },
  ]);
  expect((await persistRun(env.EVIDENCE, plan)).outcome).toBe("persisted");
  expect(await registerCollectionRun(env, { source: "myjcb", runId })).toMatchObject({
    outcome: "registered",
    artifacts: 6,
  });
  const fetchRunId = await fetchRun(runId);
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM fetch_run_seals WHERE fetch_run_id=?")
      .bind(fetchRunId)
      .first<number>("n"),
  ).toBe(1);
  expect(
    (
      await env.DB.prepare(
        "SELECT r.status,ur.normalized_outcome AS unit_outcome,ur.safe_failure_code AS code FROM observation_fetch_runs r JOIN fetch_units u ON u.fetch_run_id=r.id JOIN fetch_unit_reports ur ON ur.fetch_unit_id=u.id WHERE r.external_run_id=?",
      )
        .bind(runId)
        .all()
    ).results,
  ).toEqual([{ status: "partial", unit_outcome: "failed", code: "scheduled_payments_page" }]);
  // The unread month is catalogued as evidence, with no ledger beside it.
  expect(
    (
      await env.DB.prepare(
        "SELECT artifact_key FROM fetch_artifacts WHERE fetch_run_id=? AND artifact_key LIKE ? ORDER BY artifact_key",
      )
        .bind(fetchRunId, `${CONNECTION}/credit-%-02.%`)
        .all()
    ).results,
  ).toEqual([{ artifact_key: `${CONNECTION}/credit-detail-02.html` }]);
  expect(await sweep(env)).toMatchObject({ parsed: 0, error: 0 });
  expect(await workItem(runId)).toEqual({ outcome: "not_eligible", jobs_created: 0 });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM observation_parse_jobs j JOIN fetch_artifacts a ON a.id=j.fetch_artifact_id WHERE a.fetch_run_id=?",
    )
      .bind(fetchRunId)
      .first<number>("n"),
  ).toBe(0);
}, 60000);

test("ADR 0005 amendment (c): a whole connection with a stored schedule page is eligible; only its month pages are parsed", async () => {
  // The collector's real plan for a connection that read its two months
  // whole and, beside them, stored the ショッピングスキップ払い page (menu
  // position 8, rows under the third header) as `credit-schedule-08.html`,
  // the name every schedule page had before amendment (e). Schedule pages
  // are not months: the unit is `complete`, the run `success`, and parse
  // jobs are created for the month artifacts only. A page under this name
  // gets no dataset, whatever it shows: only `credit-skip-payment-NN.html`
  // is read (the next test).
  const runId = "00000000-0000-4000-8000-00000000a0c8";
  const connectionId = "synthetic-sched";
  const schedulePage =
    '<!doctype html><html><body><h1>ショッピングスキップ払いご利用明細(未確定分)</h1><div class="detail-list-01"><div class="head"><div class="cell">ご利用日</div><div class="cell">ご利用先など<br>お支払日</div><div class="cell">今後のお支払い金額</div></div><div class="content"><div class="item-cell"><div class="cell">2026/03/10</div><div class="cell">架空分割店</div><div class="cell">2026/04/10</div><div class="cell">3,000円</div></div></div></div></body></html>';
  const kept: RawArtifact[] = [
    ...artifacts,
    {
      dataset: "credit-schedule",
      filename: "credit-schedule-08.html",
      body: schedulePage,
      mediaType: HTML,
      statementState: "unknown",
      period: "detailMonth-8",
    },
  ];
  const plan = await myJcbRunPlan({
    schemaVersion: "myjcb-worker-poc-v1",
    runId,
    startedAt: "2026-09-24T00:00:00.000Z",
    completedAt: "2026-09-24T00:05:00.000Z",
    status: "success",
    trigger: "scheduled",
    connections: [
      {
        summary: {
          connectionId,
          bootstrapMode: "password",
          status: "success",
          cardCount: 1,
          periodCount: 2,
          artifactCount: kept.length,
          schedulePages: [
            { position: 7, code: "schedule_page_fetch" },
            { position: 8, code: "scheduled_payments_page" },
          ],
          schedulePageCount: 1,
        },
        artifacts: kept,
      },
    ],
    failures: [],
  });
  expect(plan.run.units).toEqual([
    { unitKey: connectionId, unitKind: "connection", artifactCount: 5, coverageStatus: "complete" },
  ]);
  expect((await persistRun(env.EVIDENCE, plan)).outcome).toBe("persisted");
  expect(await registerCollectionRun(env, { source: "myjcb", runId })).toMatchObject({
    outcome: "registered",
    artifacts: 6,
  });
  const fetchRunId = await fetchRun(runId);
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM fetch_run_seals WHERE fetch_run_id=?")
      .bind(fetchRunId)
      .first<number>("n"),
  ).toBe(1);
  expect(
    (
      await env.DB.prepare(
        "SELECT r.status,ur.normalized_outcome AS unit_outcome,ur.safe_failure_code AS code FROM observation_fetch_runs r JOIN fetch_units u ON u.fetch_run_id=r.id JOIN fetch_unit_reports ur ON ur.fetch_unit_id=u.id WHERE r.external_run_id=?",
      )
        .bind(runId)
        .all()
    ).results,
  ).toEqual([{ status: "success", unit_outcome: "success", code: null }]);
  // The schedule page is catalogued as evidence with no parser dataset.
  expect(
    (
      await env.DB.prepare(
        "SELECT artifact_key,dataset FROM observation_fetch_artifacts WHERE fetch_run_id=? ORDER BY artifact_key",
      )
        .bind(fetchRunId)
        .all()
    ).results,
  ).toEqual([
    { artifact_key: "manifest.json", dataset: null },
    { artifact_key: `${connectionId}/credit-detail-00.html`, dataset: "credit-detail" },
    { artifact_key: `${connectionId}/credit-detail-01.html`, dataset: "credit-detail" },
    { artifact_key: `${connectionId}/credit-ledger-00.json`, dataset: "credit-ledger" },
    { artifact_key: `${connectionId}/credit-ledger-01.json`, dataset: "credit-ledger" },
    { artifact_key: `${connectionId}/credit-schedule-08.html`, dataset: null },
  ]);
  expect(await sweep(env)).toMatchObject({ parsed: 4, error: 0 });
  expect(await workItem(runId)).toEqual({ outcome: "jobs_created", jobs_created: 4 });
  expect(
    (
      await env.DB.prepare(
        "SELECT a.artifact_key,j.status FROM observation_parse_jobs j JOIN fetch_artifacts a ON a.id=j.fetch_artifact_id WHERE a.fetch_run_id=? ORDER BY a.artifact_key",
      )
        .bind(fetchRunId)
        .all()
    ).results,
  ).toEqual([
    { artifact_key: `${connectionId}/credit-detail-00.html`, status: "done" },
    { artifact_key: `${connectionId}/credit-detail-01.html`, status: "done" },
    { artifact_key: `${connectionId}/credit-ledger-00.json`, status: "done" },
    { artifact_key: `${connectionId}/credit-ledger-01.json`, status: "done" },
  ]);
}, 60000);

test("ADR 0005 amendment (e): only the ショッピングスキップ払い page gets a parse job, and its rows are scheduled payments, not purchases", async () => {
  // The collector names a schedule page by its h1: the skip page (two rows,
  // each one item-cell of three cells mirroring the observed three-cell
  // head, the middle cell two lines) is `credit-skip-payment-08.html`; the
  // bonus page, never observed with rows, stays `credit-schedule-07.html`.
  // Every value is synthetic.
  const runId = "00000000-0000-4000-8000-00000000a0e8";
  const connectionId = "synthetic-skip";
  const skipRow = (usage: string, merchant: string, due: string, amount: string) =>
    `<div class="content"><div class="item-cell"><div class="cell">${usage}</div><div class="cell">${merchant}<br>${due}</div><div class="cell">${amount}</div></div></div>`;
  const skipPage = `<!doctype html><html><body><h1>MyJCB</h1><h1>ショッピングスキップ払いご利用明細(未確定分)</h1><h2>2026年3月20日(金)時点のショッピングスキップ払いご利用明細(2026年5月以降のお支払い分)</h2><div class="detail-list-01"><div class="head"><div class="cell">ご利用日</div><div class="cell">ご利用先など<br>お支払日</div><div class="cell">今後のお支払い金額</div></div>${skipRow("2026/03/02", "架空スキップ店", "2026/05/11", "12,000円")}${skipRow("2026/03/05", "架空スキップ商会", "2026/06/10", "3,400円")}</div></body></html>`;
  const bonusPage =
    '<!doctype html><html><body><h1>MyJCB</h1><h1>ボーナス払いご利用明細(未確定分)</h1><div class="detail-list-01"><div class="head">ご利用日 ご利用先など 支払区分 ご利用金額</div></div></body></html>';
  const kept: RawArtifact[] = [
    ...artifacts,
    {
      dataset: "credit-schedule",
      filename: "credit-schedule-07.html",
      body: bonusPage,
      mediaType: HTML,
      statementState: "unknown",
      period: "detailMonth-7",
    },
    {
      dataset: "credit-schedule",
      filename: "credit-skip-payment-08.html",
      body: skipPage,
      mediaType: HTML,
      statementState: "unknown",
      period: "detailMonth-8",
    },
  ];
  const plan = await myJcbRunPlan({
    schemaVersion: "myjcb-worker-poc-v1",
    runId,
    startedAt: "2026-09-24T00:00:00.000Z",
    completedAt: "2026-09-24T00:05:00.000Z",
    status: "success",
    trigger: "scheduled",
    connections: [
      {
        summary: {
          connectionId,
          bootstrapMode: "password",
          status: "success",
          cardCount: 1,
          periodCount: 2,
          artifactCount: kept.length,
          schedulePages: [
            { position: 7, code: "scheduled_payments_page" },
            { position: 8, code: "scheduled_payments_page" },
          ],
          schedulePageCount: 2,
        },
        artifacts: kept,
      },
    ],
    failures: [],
  });
  expect(plan.run.units[0]?.coverageStatus).toBe("complete");
  expect((await persistRun(env.EVIDENCE, plan)).outcome).toBe("persisted");
  expect(await registerCollectionRun(env, { source: "myjcb", runId })).toMatchObject({
    outcome: "registered",
    artifacts: 7,
  });
  const fetchRunId = await fetchRun(runId);
  expect(
    (
      await env.DB.prepare(
        "SELECT artifact_key,dataset FROM observation_fetch_artifacts WHERE fetch_run_id=? AND artifact_key LIKE '%credit-s%' ORDER BY artifact_key",
      )
        .bind(fetchRunId)
        .all()
    ).results,
  ).toEqual([
    {
      artifact_key: `${connectionId}/credit-schedule-07.html`,
      dataset: null,
    },
    {
      artifact_key: `${connectionId}/credit-skip-payment-08.html`,
      dataset: "credit-schedule",
    },
  ]);
  expect(await sweep(env)).toMatchObject({ parsed: 5, error: 0 });
  expect(await workItem(runId)).toEqual({ outcome: "jobs_created", jobs_created: 5 });
  expect(
    (
      await env.DB.prepare(
        "SELECT a.artifact_key,j.parser_name,j.parser_version,j.status FROM observation_parse_jobs j JOIN fetch_artifacts a ON a.id=j.fetch_artifact_id WHERE a.fetch_run_id=? AND a.artifact_key LIKE '%credit-s%'",
      )
        .bind(fetchRunId)
        .all()
    ).results,
  ).toEqual([
    {
      artifact_key: `${connectionId}/credit-skip-payment-08.html`,
      parser_name: "myjcb-skip-payment-schedule",
      parser_version: "0.1.1",
      status: "done",
    },
  ]);
  // The rows are scheduled payments in their own table, exact decimal text,
  // and the parse run wrote nothing any transaction or balance reader sees.
  expect(
    (
      await env.DB.prepare(
        `SELECT o.source_account,o.schedule_kind,o.usage_date,o.due_date,o.amount_text,o.amount_scale,o.currency,o.counterparty,o.as_of,
                json_extract(o.extra_json,'$._kogane.paymentFromMonth') AS from_month
           FROM scheduled_payment_observations o JOIN parse_runs p ON p.id=o.parse_run_id
           JOIN fetch_artifacts a ON a.id=p.fetch_artifact_id
          WHERE a.fetch_run_id=? AND p.status='ok' ORDER BY o.id`,
      )
        .bind(fetchRunId)
        .all()
    ).results,
  ).toEqual([
    {
      source_account: `myjcb:${connectionId}:root`,
      schedule_kind: "card-skip-payment",
      usage_date: "2026-03-02",
      due_date: "2026-05-11",
      amount_text: "12000",
      amount_scale: 0,
      currency: "JPY",
      counterparty: "架空スキップ店",
      as_of: "2026-03-20",
      from_month: "2026-05",
    },
    {
      source_account: `myjcb:${connectionId}:root`,
      schedule_kind: "card-skip-payment",
      usage_date: "2026-03-05",
      due_date: "2026-06-10",
      amount_text: "3400",
      amount_scale: 0,
      currency: "JPY",
      counterparty: "架空スキップ商会",
      as_of: "2026-03-20",
      from_month: "2026-05",
    },
  ]);
  for (const table of [
    "transaction_observations",
    "balance_observations",
    "position_observations",
    "valuation_observations",
  ])
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM ${table} o JOIN parse_runs p ON p.id=o.parse_run_id WHERE p.parser_name='myjcb-skip-payment-schedule'`,
      ).first<number>("n"),
      table,
    ).toBe(0);
  // Append-only, as every observation table.
  await expect(env.DB.prepare("DELETE FROM scheduled_payment_observations").run()).rejects.toThrow(
    /append-only/u,
  );
  await expect(
    env.DB.prepare("UPDATE scheduled_payment_observations SET amount_text='0'").run(),
  ).rejects.toThrow(/append-only/u);
}, 60000);

test("ADR 0005 amendment (e): a scheduled payment is checked at the persist boundary, since the type system does not check it", () => {
  // Synthetic values only.
  const row = {
    kind: "scheduled_payment",
    sourceAccount: "myjcb:synthetic-skip:root",
    externalId: "myjcb-skip-payment:00:0",
    scheduleKind: "card-skip-payment",
    usageDate: "2026-03-02",
    dueDate: "2026-05-11",
    amountText: "-1200",
    amountScale: 0,
    currency: "JPY",
    counterparty: "架空スキップ店",
    asOf: "2026-03-20",
    observedAt: "2026-03-20T01:00:00.000Z",
    rawLocator: "html:div.detail-list-01>div.content[0]",
    extra: {},
  };
  const other = { kind: "balance", anything: 1 };
  expect(() => scheduledPaymentRows("myjcb-skip-payment-schedule", [row, other])).not.toThrow();
  // Another parser may not emit the kind at all.
  expect(() => scheduledPaymentRows("myjcb-credit-statement", [row])).toThrow(
    /^parse_contract_invalid$/u,
  );
  for (const broken of [
    { ...row, amountText: "12000.5" },
    { ...row, amountText: "012" },
    { ...row, amountText: "-0" },
    { ...row, amountText: 12000 },
    { ...row, amountScale: 2 },
    { ...row, currency: "USD" },
    { ...row, scheduleKind: "bonus" },
    { ...row, dueDate: "2026-02-30" },
    { ...row, usageDate: "2026/03/02" },
    { ...row, asOf: null },
    { ...row, counterparty: "" },
    { ...row, extra: [] },
    { ...row, unexpected: 1 },
    Object.fromEntries(Object.entries(row).filter(([key]) => key !== "rawLocator")),
  ])
    expect(
      () => scheduledPaymentRows("myjcb-skip-payment-schedule", [broken]),
      JSON.stringify(broken),
    ).toThrow(/^parse_contract_invalid$/u);
});

test("ADR 0005 amendment (h): one page at four positions parses once its entries state one thing", async () => {
  // A no-bill page, the same bytes at positions 3 to 6. Before amendment (h)
  // the collector gave each entry its position's label, so the entries naming
  // the one object disagreed and the extractor refused every one of them
  // (`manifest_artifact_ambiguous`, ADR 0025). Since (h) an `unknown` page's
  // entry states no period (collectCredit, tested in the collector), and the
  // unchanged extractor reads the one thing they all state.
  const noBill = statementPage("");
  const repeated = (period: (position: number) => string | undefined): RawArtifact[] =>
    [3, 4, 5, 6].map((position) => {
      const label = period(position);
      return {
        dataset: "credit-detail",
        filename: `credit-detail-0${position}.html`,
        body: noBill,
        mediaType: HTML,
        statementState: "unknown" as const,
        ...(label === undefined ? {} : { period: label }),
      };
    });
  const plan = (runId: string, kept: RawArtifact[]) =>
    myJcbRunPlan({
      schemaVersion: "myjcb-worker-poc-v1",
      runId,
      startedAt: "2026-09-29T21:00:00.000Z",
      completedAt: "2026-09-29T21:05:00.000Z",
      status: "success",
      trigger: "scheduled",
      connections: [
        {
          summary: {
            connectionId: "synthetic-repeat",
            bootstrapMode: "password",
            status: "success",
            cardCount: 1,
            periodCount: 4,
            artifactCount: kept.length,
          },
          artifacts: kept,
        },
      ],
      failures: [],
    });
  const outcomes = async (runId: string) =>
    (
      await env.DB.prepare(
        "SELECT a.artifact_key,j.status,j.last_error_code AS code FROM observation_parse_jobs j JOIN fetch_artifacts a ON a.id=j.fetch_artifact_id WHERE a.fetch_run_id=? ORDER BY a.artifact_key",
      )
        .bind(await fetchRun(runId))
        .all()
    ).results;

  const before = "00000000-0000-4000-8000-00000000a0f1";
  expect(
    (
      await persistRun(
        env.EVIDENCE,
        await plan(
          before,
          repeated((p) => `detailMonth-${p}`),
        ),
      )
    ).outcome,
  ).toBe("persisted");
  expect(await registerCollectionRun(env, { source: "myjcb", runId: before })).toMatchObject({
    outcome: "registered",
  });
  await sweep(env);
  const refused = await outcomes(before);
  expect(refused).toHaveLength(4);
  for (const job of refused) expect(job).toMatchObject({ code: "manifest_artifact_ambiguous" });

  const after = "00000000-0000-4000-8000-00000000a0f2";
  expect(
    (
      await persistRun(
        env.EVIDENCE,
        await plan(
          after,
          repeated(() => undefined),
        ),
      )
    ).outcome,
  ).toBe("persisted");
  expect(await registerCollectionRun(env, { source: "myjcb", runId: after })).toMatchObject({
    outcome: "registered",
  });
  await sweep(env);
  expect(await outcomes(after)).toEqual(
    [3, 4, 5, 6].map((position) => ({
      artifact_key: `synthetic-repeat/credit-detail-0${position}.html`,
      status: "done",
      code: null,
    })),
  );
  expect(
    (
      await env.DB.prepare(
        "SELECT statement_state,period,COUNT(*) AS n FROM observation_fetch_artifacts WHERE fetch_run_id=? AND dataset='credit-detail' GROUP BY 1,2",
      )
        .bind(await fetchRun(after))
        .all()
    ).results,
  ).toEqual([{ statement_state: "unknown", period: null, n: 4 }]);
}, 60000);
