// Every shared-R2 collector's real run plan, registered end to end (ADR 0021).
//
// Each case below calls the collector's own `*RunPlan` function — the code the
// deployed Worker runs, not a hand-written terminal — with synthetic inputs in
// the shapes the collector produces, persists the plan with the collection
// writer into an in-memory R2, and registers it through the Processor's
// in-process port against the whole CORE schema plus the operator bootstrap
// (`infra/bootstrap/ingest-clients.sql`). A case passes only when the run is
// registered, sealed and unblocked with every artifact catalogued.
//
// This is the test whose absence let every shared-R2 source except Mizuho stop
// registering on 2026-09-12: the collectors' own suites read their terminals,
// and the Processor's suite registered a synthetic vocabulary, so a derived
// artifact with no stated lineage (`artifact_lineage_unstated`) and a unit
// count that left out the run manifest (`run_inventory_incomplete` at the
// seal) were each correct on one side and refused on the other.
//
// Everything is synthetic. No amount, merchant, account label or date here is
// a production value; the bodies are placeholders in the observed shapes.
import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { fullCoreDatabase, sqliteD1 } from "../../../packages/storage-d1/test/sqlite.ts";
import { splitSqlStatements } from "../../../packages/storage-d1/src/migrations.ts";
import { FakeR2Bucket } from "../../../packages/collection/test/fake-bucket.ts";
import { persistRun, type PersistRunPlan } from "../../../packages/collection/src/writer.ts";
import { sha256Hex } from "../../../packages/collection/src/digest.ts";
import { registerCollectionRun, type CollectionEnv } from "../src/collection/index.ts";
import { sanitizeMizuhoPage } from "../../../packages/parsers/src/parsers/mizuho-html.ts";
import { mizuhoAccountHtml } from "../../../packages/parsers/test/mizuho-fixture.ts";
import { buildSharedRunPlan as globalPassRunPlan } from "../../collector-globalpass/src/shared-collection.ts";
import {
  GLOBALPASS_DATASET,
  GLOBALPASS_MEDIA_TYPE,
  GLOBALPASS_PAGINATION_STATUS,
  GLOBALPASS_SCHEMA_VERSION,
  type CollectionManifest as GlobalPassManifest,
} from "../../collector-globalpass/src/model.ts";
import { mizuhoRunPlan } from "../../collector-mizuho/src/storage.ts";
import { mobileSuicaRunPlan } from "../../collector-mobile-suica/src/shared-run.ts";
import { moneyForwardRunPlan } from "../../collector-moneyforward/src/shared-collection.ts";
import { myJcbRunPlan } from "../../collector-myjcb/src/shared-collection.ts";
import { sbiRunPlan } from "../../collector-sbi-securities/src/shared-run.ts";
import { buildSharedRunPlan as sbiShinseiRunPlan } from "../../collector-sbi-shinsei/src/shared-collection.ts";
import { buildSharedRunPlan as sbiVcTradeRunPlan } from "../../collector-sbi-vc-trade/src/shared-collection.ts";
import type { CollectionManifest as SbiVcTradeManifest } from "../../collector-sbi-vc-trade/src/types.ts";
import { buildSharedRunPlan as smbcDirectRunPlan } from "../../collector-smbc-direct/src/shared-collection.ts";
import type {
  BackfillManifest,
  StoredArtifact as SmbcStoredArtifact,
} from "../../collector-smbc-direct/src/types.ts";
import { sonyBankRunPlan } from "../../collector-sony-bank/src/shared-collection.ts";
import { buildSharedRunPlan as stGeorgeRunPlan } from "../../collector-st-george/src/shared-collection.ts";
import { snapshot as stGeorgeSnapshot } from "../../collector-st-george/test/fixture.ts";
import { vpassCardRunPlan } from "../../collector-vpass/src/shared-collection.ts";
import { vPointPayRunPlan } from "../../collector-vpoint-pay/src/shared-run.ts";
import { vPointPayEmailRunPlan, vPointRunPlan } from "../../collector-vpoint/src/shared-run.ts";
import type { PreparedVPointPayEmail } from "../../collector-vpoint/src/vpoint-pay-email.ts";

const CLIENT = "processor-shared-r2";
const RUN_ID = "00000000-0000-4000-8000-000000000000";
const STARTED_AT = "2026-09-01T00:00:00.000Z";
const COMPLETED_AT = "2026-09-01T00:05:00.000Z";
const encoder = new TextEncoder();

interface Harness {
  db: Database;
  bucket: FakeR2Bucket;
  env: CollectionEnv;
}

function harness(): Harness {
  const db = fullCoreDatabase();
  // The registry exactly as an operator applies it: every route is the
  // declared one, nothing is inserted for the test's convenience.
  const bootstrap = readFileSync(
    new URL("../../../infra/bootstrap/ingest-clients.sql", import.meta.url),
    "utf8",
  );
  for (const statement of splitSqlStatements(bootstrap)) db.exec(statement);
  const bucket = new FakeR2Bucket();
  return {
    db,
    bucket,
    env: {
      DB: sqliteD1(db) as CollectionEnv["DB"],
      EVIDENCE: bucket as unknown as CollectionEnv["EVIDENCE"],
      SHARED_R2_INGEST_ENABLED: "true",
      COLLECTION_INGEST_CLIENT: CLIENT,
      COLLECTION_DATA_BUCKET: "kogane-raw-evidence",
      COLLECTION_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    },
  };
}

/** The producer the Processor's route for this terminal source accepts. */
function routeProducer(source: string): string {
  return `collector-${source}`;
}

interface Registered {
  roles: string[];
  units: { unit_key: string; artifacts: number; declared: number | null }[];
}

/**
 * Persist the plan as the collector would and register it. Asserts the whole
 * contract: registered, sealed, not blocked, every artifact catalogued.
 */
async function registerPlan(plan: PersistRunPlan, expectedArtifacts: number): Promise<Registered> {
  const { run } = plan;
  const { source } = run;
  // The producer the collector names is the one its route declares (ADR 0014);
  // nothing here is stubbed.
  expect(run.producer).toBe(routeProducer(source));
  expect(plan.artifacts).toHaveLength(expectedArtifacts);

  const h = harness();
  const persisted = await persistRun(h.bucket, plan);
  expect(persisted.outcome).toBe("persisted");
  const result = await registerCollectionRun(h.env, { source, runId: run.runId });
  expect(result).toMatchObject({ outcome: "registered", artifacts: expectedArtifacts });
  if (result.outcome !== "registered") throw new Error(`unreachable: ${result.outcome}`);

  const count = (sql: string, ...binds: unknown[]): number =>
    (h.db.query(sql).get(...(binds as never[])) as { n: number }).n;
  expect(
    count("SELECT count(*) AS n FROM fetch_run_seals WHERE fetch_run_id=?", result.fetchRunId),
  ).toBe(1);
  expect(
    count("SELECT count(*) AS n FROM fetch_artifacts WHERE fetch_run_id=?", result.fetchRunId),
  ).toBe(expectedArtifacts);
  expect(count("SELECT count(*) AS n FROM collection_runs WHERE blocked_code IS NOT NULL")).toBe(0);
  expect(
    count("SELECT count(*) AS n FROM collection_run_stages WHERE state IN ('blocked','retryable')"),
  ).toBe(0);
  // Every derived artifact says what it was derived from: a step, and either a
  // link to a kept input or the statement that the input was not kept.
  expect(
    count(
      `SELECT count(*) AS n FROM fetch_artifacts a
        WHERE a.fetch_run_id=? AND a.artifact_role='collector_derived'
          AND (a.lineage_disposition NOT IN ('linked','source_bytes_not_available')
               OR NOT EXISTS (SELECT 1 FROM artifact_transform_steps t WHERE t.fetch_artifact_id=a.id))`,
      result.fetchRunId,
    ),
  ).toBe(0);
  // A collector's own run manifest belongs to the run, never to one unit.
  expect(
    count(
      `SELECT count(*) AS n FROM fetch_artifacts
        WHERE fetch_run_id=? AND artifact_role='collector_manifest' AND fetch_unit_id IS NOT NULL`,
      result.fetchRunId,
    ),
  ).toBe(0);

  const roles = (
    h.db
      .query(
        "SELECT artifact_role||'/'||payload_fidelity||'/'||lineage_disposition AS shape FROM fetch_artifacts WHERE fetch_run_id=? GROUP BY shape ORDER BY shape",
      )
      .all(result.fetchRunId) as { shape: string }[]
  ).map((row) => row.shape);
  const units = h.db
    .query(
      `SELECT u.unit_key,
              (SELECT count(*) FROM fetch_artifacts a WHERE a.fetch_unit_id=u.id) AS artifacts,
              r.declared_artifact_count AS declared
         FROM fetch_units u
         JOIN fetch_unit_reports r ON r.fetch_unit_id=u.id AND r.report_kind='terminal'
        WHERE u.fetch_run_id=? ORDER BY u.unit_key`,
    )
    .all(result.fetchRunId) as Registered["units"];
  for (const unit of units) expect(unit.artifacts).toBe(unit.declared!);
  return { roles, units };
}

// --- Sources that registered before this change -------------------------------

test("mizuho-bank: sanitized pages register and seal", async () => {
  const body = sanitizeMizuhoPage(mizuhoAccountHtml());
  const plan = await mizuhoRunPlan({
    runId: RUN_ID,
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
    version: "1.0.0",
    artifacts: [
      {
        artifactKey: "account-list.html",
        unitKey: "account-list",
        dataset: "mizuho-account-list-html",
        body,
        mediaType: "text/html",
        partial: false,
      },
    ],
    failedUnits: [],
    partial: false,
    failed: false,
  });
  const registered = await registerPlan(plan, 1);
  expect(registered.roles).toEqual([
    "sanitized_provider_capture/transformed/source_not_retained_for_security",
  ]);
});

test("mobile-suica: the redacted page, its extraction and the summary register and seal", async () => {
  const plan = await mobileSuicaRunPlan({
    runId: RUN_ID,
    producerVersion: "mobile-suica-worker-v1",
    attemptId: "attempt-0000",
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
    status: "success",
    asOfDateJst: "2099-01-01",
    complete: true,
    artifacts: [
      {
        dataset: "sf-history-html",
        filename: "sf-history-page-0001.html",
        mediaType: "text/html; charset=Shift_JIS",
        body: encoder.encode("<html>synthetic</html>"),
      },
      {
        dataset: "sf-history",
        filename: "sf-history.json",
        mediaType: "application/json",
        body: '{"synthetic":true}',
      },
      {
        dataset: "collection-summary",
        filename: "collection-summary.json",
        mediaType: "application/json",
        body: '{"synthetic":"summary"}',
      },
    ],
    failureCodes: [],
  });
  const registered = await registerPlan(plan, 3);
  expect(registered.roles).toEqual([
    "collector_derived/transformed/linked",
    "collector_summary/generated/not_applicable",
    "sanitized_provider_capture/transformed/source_not_retained_for_security",
  ]);
  expect(registered.units).toEqual([{ unit_key: "account", artifacts: 3, declared: 3 }]);
});

test("st-george: the DOM projection and the run manifest register and seal", async () => {
  const plan = await stGeorgeRunPlan({
    runId: RUN_ID,
    attemptId: "attempt-0000",
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
    snapshot: stGeorgeSnapshot(),
  });
  const registered = await registerPlan(plan, 2);
  expect(registered.roles).toEqual([
    "collector_manifest/generated/not_applicable",
    "sanitized_provider_capture/transformed/source_not_retained_for_security",
  ]);
});

test("smbc-direct: responses, their extractions and the run manifest register and seal", async () => {
  const prefix = `raw/smbc-direct/2099/01/01/${RUN_ID}`;
  const bytesByKey = new Map<string, Uint8Array>();
  const stored = async (
    dataset: SmbcStoredArtifact["dataset"],
    name: string,
    text: string,
    mediaType: string,
    range?: { start: string; end: string },
  ): Promise<SmbcStoredArtifact> => {
    const bytes = encoder.encode(text);
    const key = `${prefix}/${name}`;
    bytesByKey.set(key, bytes);
    return {
      dataset,
      key,
      mediaType,
      bytes: bytes.byteLength,
      sha256: await sha256Hex(bytes),
      ...(range ? { range } : {}),
    };
  };
  const range = { start: "2099-01-01", end: "2099-01-31" };
  const manifest: BackfillManifest = {
    schemaVersion: "smbc-direct-backfill-worker-poc-v1",
    source: "smbc-direct",
    runId: RUN_ID,
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
    status: "success",
    requestedRange: range,
    completedChunks: 1,
    totalChunks: 1,
    transactionCount: 0,
    artifacts: [
      await stored("balance-raw", "balance.raw.json.sjis", '{"b":"1"}', "application/json"),
      await stored(
        "balance-normalized",
        "balance.normalized.json",
        '{"a":"1"}',
        "application/json",
      ),
      await stored(
        "transactions-raw",
        "transactions/20990101-20990131.raw.json.sjis",
        '{"rows":[]}',
        "application/json",
        range,
      ),
      await stored(
        "transactions-normalized",
        "transactions/20990101-20990131.normalized.json",
        '{"transactions":[]}',
        "application/json",
        range,
      ),
    ],
    failureCodes: [],
    logoutSucceeded: true,
  };
  const plan = await smbcDirectRunPlan({
    manifest,
    manifestBytes: encoder.encode(JSON.stringify(manifest)),
    prefix,
    bytesByKey,
    identity: { attemptId: "attempt-0000" },
  });
  const registered = await registerPlan(plan, 5);
  expect(registered.roles).toEqual([
    "collector_derived/transformed/linked",
    "collector_manifest/generated/not_applicable",
    "provider_response/exact/not_applicable",
  ]);
  expect(registered.units).toEqual([{ unit_key: "account", artifacts: 4, declared: 4 }]);
});

// --- Sources blocked from 2026-09-12 until ADR 0021 ---------------------------

test("sbi-securities: every re-encoded dataset states its extraction and registers", async () => {
  const dataset = (name: string) => ({
    dataset: name,
    mediaType: "application/json" as const,
    body: { synthetic: name },
  });
  const plan = await sbiRunPlan({
    runId: RUN_ID,
    producerVersion: "sbi-securities-worker-v1",
    attemptId: "attempt-0000",
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
    status: "success",
    scope: "all",
    window: { from: "2098-10-03", to: "2099-01-01" },
    artifacts: [
      dataset("domestic-cash-positions"),
      dataset("account-assets-current"),
      dataset("yen-detail-history"),
      dataset("domestic-trade-records"),
      dataset("foreign-cash-positions"),
      dataset("foreign-cash-balances"),
      dataset("foreign-trade-records"),
    ],
    failures: [],
  });
  const registered = await registerPlan(plan, 7);
  expect(registered.roles).toEqual(["collector_derived/transformed/source_bytes_not_available"]);
  expect(registered.units).toEqual([
    { unit_key: "domestic", artifacts: 4, declared: 4 },
    { unit_key: "foreign", artifacts: 3, declared: 3 },
  ]);
});

test("sbi-shinsei: redacted captures, the normalized view and the run manifest register", async () => {
  const provider = JSON.stringify({ header: { adapterResultCode: "0" }, responseParam: {} });
  const plan = await sbiShinseiRunPlan({
    manifest: {
      schemaVersion: "sbi-shinsei-worker-poc-v1",
      source: "sbi-shinsei",
      runId: RUN_ID,
      startedAt: STARTED_AT,
      completedAt: COMPLETED_AT,
      status: "success",
      liveReadsEnabled: true,
      artifacts: [],
      failures: [],
    },
    artifacts: [
      {
        dataset: "top-accounts-balance-and-activity",
        filename: "raw-top-accounts-balance-and-activity.json",
        mediaType: "application/json",
        body: provider,
      },
      {
        dataset: "normalized",
        filename: "normalized.json",
        mediaType: "application/json",
        body: '{"synthetic":"normalized"}',
      },
    ],
    identity: { attemptId: "attempt-0000" },
  });
  const registered = await registerPlan(plan, 3);
  expect(registered.roles).toEqual([
    "collector_derived/transformed/linked",
    "collector_manifest/generated/not_applicable",
    "sanitized_provider_capture/transformed/source_not_retained_for_security",
  ]);
});

test("sbi-vc-trade: the run manifest belongs to the run and the account unit seals", async () => {
  const captures = ["assets", "trade-history-page-0001"].map((dataset) => ({
    dataset,
    body: JSON.stringify({ meta: {}, data: { synthetic: dataset } }),
  }));
  const manifest: SbiVcTradeManifest = {
    schemaVersion: "sbi-vc-trade-worker-v1",
    source: "sbi-vc-trade",
    runId: RUN_ID,
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
    status: "success",
    artifacts: captures.map((capture) => ({
      dataset: capture.dataset,
      key: `raw/sbi-vc-trade/${capture.dataset}.json`,
      sha256: "a".repeat(64),
      bytes: capture.body.length,
    })),
    failures: [],
  };
  const plan = await sbiVcTradeRunPlan({
    manifest,
    manifestJson: JSON.stringify(manifest),
    captures,
    identity: { attemptId: "attempt-0000" },
  });
  const registered = await registerPlan(plan, 3);
  expect(registered.units).toEqual([{ unit_key: "account", artifacts: 2, declared: 2 }]);
});

test("prestia-globalpass: the run manifest belongs to the run and the account unit seals", async () => {
  const html = "<!doctype html><html><body>synthetic</body></html>";
  const months = ["2099-01", "2098-12"];
  const manifest: GlobalPassManifest = {
    schemaVersion: GLOBALPASS_SCHEMA_VERSION,
    source: "prestia-globalpass",
    runId: RUN_ID,
    mode: "daily",
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
    status: "success",
    availableMonths: months,
    selectedMonths: months,
    captureComplete: true,
    paginationStatus: GLOBALPASS_PAGINATION_STATUS,
    artifacts: months.map((month) => ({
      dataset: GLOBALPASS_DATASET,
      month,
      key: `raw/prestia-globalpass/activity-${month}.html`,
      mediaType: GLOBALPASS_MEDIA_TYPE,
      bytes: html.length,
      sha256: "a".repeat(64),
    })),
    failures: [],
  };
  const plan = await globalPassRunPlan({
    manifest,
    manifestJson: JSON.stringify(manifest),
    captures: months.map((month) => ({ month, sanitizedHtml: html })),
    identity: { attemptId: "attempt-0000" },
  });
  const registered = await registerPlan(plan, 3);
  expect(registered.units).toEqual([{ unit_key: "account", artifacts: 2, declared: 2 }]);
});

test("myjcb: the ledger links the page it was parsed from, discovery states its extraction", async () => {
  // Already in the redacted shape `assertRedactedHtml` accepts: no script, no
  // URL-bearing attribute, no unredacted value. (The collector's own
  // `redactedStatementHtml` is not imported: its module does not compile
  // under this workspace's `exactOptionalPropertyTypes`.)
  const page = '<html><body><p>synthetic statement</p><input value="[redacted]"></body></html>';
  const plan = await myJcbRunPlan({
    schemaVersion: "myjcb-worker-poc-v1",
    runId: RUN_ID,
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
    status: "success",
    trigger: "scheduled",
    connections: [
      {
        summary: {
          connectionId: "account-one",
          bootstrapMode: "password",
          status: "success",
          cardCount: 1,
          periodCount: 1,
          artifactCount: 5,
        },
        artifacts: [
          {
            dataset: "credit-menu",
            filename: "credit-menu.html",
            body: page,
            mediaType: "text/html; charset=utf-8",
          },
          {
            dataset: "credit-past-months",
            filename: "credit-past-months.json",
            body: '{"jsonrpc":"2.0"}',
            mediaType: "application/json",
          },
          {
            dataset: "credit-detail",
            filename: "credit-detail-00.html",
            body: page,
            mediaType: "text/html; charset=utf-8",
            statementState: "unconfirmed",
          },
          {
            dataset: "credit-ledger",
            filename: "credit-ledger-00.json",
            body: '{"schemaVersion":1,"detailMonth":0}',
            mediaType: "application/json",
            statementState: "unconfirmed",
          },
          {
            dataset: "discovery",
            filename: "discovery.json",
            body: '{"schemaVersion":1}',
            mediaType: "application/json",
          },
        ],
      },
    ],
    failures: [],
  });
  const registered = await registerPlan(plan, 6);
  expect(registered.roles).toEqual([
    "collector_derived/transformed/linked",
    "collector_derived/transformed/source_bytes_not_available",
    "collector_manifest/generated/not_applicable",
    "provider_response/exact/not_applicable",
    "sanitized_provider_capture/transformed/source_not_retained_for_security",
  ]);
  expect(registered.units).toEqual([{ unit_key: "account-one", artifacts: 5, declared: 5 }]);
});

test("v-point: re-encoded API responses state their step, and the summary registers", async () => {
  const response = (name: string) => ({
    dataset: name,
    filename: `${name}.json`,
    mediaType: "application/json",
    body: JSON.stringify({ status: { code: "0000" }, results: {} }),
  });
  const plan = await vPointRunPlan({
    runId: RUN_ID,
    producerVersion: "vpoint-worker-poc-v2",
    attemptId: "attempt-0000",
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
    status: "success",
    artifacts: [
      response("balance-info"),
      response("smfg-point"),
      response("history-page-0001"),
      response("vmoney-history-page-0001"),
      {
        dataset: "collection-summary",
        filename: "collection-summary.json",
        mediaType: "application/json",
        body: '{"synthetic":"summary"}',
      },
    ],
    failureCodes: [],
  });
  const registered = await registerPlan(plan, 5);
  expect(registered.roles).toEqual([
    "collector_derived/transformed/source_bytes_not_available",
    "collector_summary/generated/not_applicable",
  ]);
  expect(registered.units).toEqual([{ unit_key: "account", artifacts: 5, declared: 5 }]);
});

test("v-point-pay: re-encoded responses and a YYYY-MM month range register and seal", async () => {
  const plan = await vPointPayRunPlan({
    runId: RUN_ID,
    producerVersion: "vpoint-pay-worker-v1",
    attemptId: "attempt-0000",
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
    status: "success",
    artifacts: [
      {
        dataset: "balance",
        filename: "balance.json",
        mediaType: "application/json",
        body: '{"inquiry_period":"209901"}',
      },
      {
        dataset: "transactions-209901",
        filename: "transactions-209901.json",
        mediaType: "application/json",
        body: '{"tran_list":[]}',
      },
      {
        dataset: "collection-summary",
        filename: "collection-summary.json",
        mediaType: "application/json",
        body: '{"synthetic":"summary"}',
      },
    ],
    earliestMonth: "209901",
    latestMonth: "209901",
    failureCodes: [],
  });
  const registered = await registerPlan(plan, 3);
  expect(registered.roles).toEqual([
    "collector_derived/transformed/source_bytes_not_available",
    "collector_summary/generated/not_applicable",
  ]);
});

// --- Sources the producer fix (ADR 0014) alone stood between -----------------

test("v-point-pay-email: the message and the event extracted from it register and seal", async () => {
  const raw = encoder.encode("From: synthetic\r\n\r\nsynthetic body\r\n");
  const normalized = encoder.encode('{"synthetic":"event"}\n');
  const prepared: PreparedVPointPayEmail = {
    event: {
      schemaVersion: "vpoint-pay-email-event-v2",
      id: "vpoint-pay-email-synthetic-0001",
      sourceMessageId: null,
      occurredAt: STARTED_AT,
      eventType: "usage",
      subject: "synthetic",
      merchant: null,
      detail: null,
      amountYen: null,
      usedPoints: null,
      balanceYen: null,
    },
    raw,
    rawSha256: await sha256Hex(raw),
    rawKey: "raw/synthetic.eml",
    normalized,
    normalizedSha256: await sha256Hex(normalized),
    normalizedKey: "normalized/synthetic.json",
    delivery: "direct",
    outerMessageSha256: await sha256Hex(raw),
  };
  const registered = await registerPlan(
    await vPointPayEmailRunPlan(prepared, "vpoint-worker-poc-v2"),
    2,
  );
  expect(registered.roles).toEqual([
    "collector_derived/transformed/linked",
    "user_capture/unknown/not_applicable",
  ]);
});

test("moneyforward-me: pages and the run manifest register and seal", async () => {
  const page = (dataset: string, filename: string) => ({
    dataset,
    filename,
    mediaType: "text/html; charset=utf-8",
    body: `<html>synthetic ${filename}</html>`,
  });
  const plan = await moneyForwardRunPlan({
    schemaVersion: "moneyforward-worker-poc-v1",
    runId: RUN_ID,
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
    status: "success",
    accountDetailCount: 1,
    monthlyFragmentCount: 1,
    artifacts: [
      page("accounts-index", "accounts.html"),
      page("account-detail", "account-detail-01.html"),
      page("monthly-transactions", "account-01-month-2099-01.html"),
    ],
    failures: [],
  });
  await registerPlan(plan, 4);
});

test("sony-bank: responses, exports, redacted statements and the summary register and seal", async () => {
  const plan = await sonyBankRunPlan({
    schemaVersion: "sony-bank-worker-poc-v2",
    runId: RUN_ID,
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
    status: "success",
    window: { from: "2098-12-01", to: "2099-01-01" },
    transactionCount: 0,
    artifacts: [
      {
        dataset: "gross-balance",
        filename: "gross-balance.json",
        mediaType: "application/json",
        body: '{"synthetic":"balance"}',
      },
      {
        dataset: "yen-history-csv",
        filename: "yen-history.csv",
        mediaType: "text/csv",
        body: "synthetic,csv\n",
      },
      {
        dataset: "wallet-history-209901",
        filename: "wallet-history-2099-01.html",
        mediaType: "text/html; charset=UTF-8",
        body: "<html><body>synthetic</body></html>",
      },
      {
        dataset: "collection-summary",
        filename: "collection-summary.json",
        mediaType: "application/json",
        body: '{"synthetic":"summary"}',
      },
    ],
    failures: [],
  });
  const registered = await registerPlan(plan, 5);
  expect(registered.units).toEqual([{ unit_key: "account", artifacts: 4, declared: 4 }]);
});

test("vpass: one card's sanitized envelopes and the run manifest register and seal", async () => {
  const envelope = (content: Record<string, unknown>) =>
    JSON.stringify({ header: { resultCode: 0 }, body: { content } });
  const plan = await vpassCardRunPlan({
    sessionRunId: "2099-01-01T00-00-00-000Z",
    cardLabel: "card-001",
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
    cardListRawJson: envelope({
      DropdownListInitDisplayServiceBean: {
        multiCardInfoList: [{ name: "SYNTHETIC", value: "synthetic-key" }],
      },
    }),
    selectCardRawJson: envelope({ MultiCardUpdateBean: {} }),
    webMeisaiTopRawJson: envelope({ WebMeisaiTopDisplayServiceBean: {} }),
    months: {
      "209901": {
        pages: [
          {
            kind: "top",
            index: 0,
            rawJson: envelope({ WebMeisaiTopDisplayServiceBean: { meisaiList: [] } }),
          },
        ],
        transactionCount: 0,
      },
    },
  });
  const registered = await registerPlan(plan, 5);
  expect(registered.roles).toEqual([
    "collector_manifest/generated/not_applicable",
    "sanitized_provider_capture/transformed/source_not_retained_for_security",
  ]);
  expect(registered.units).toEqual([{ unit_key: "card-001", artifacts: 4, declared: 4 }]);
});
