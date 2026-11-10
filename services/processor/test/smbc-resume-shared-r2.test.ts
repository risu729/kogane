import { applyTestReadMigrations, applyTestSql } from "./migration-setup.ts";
// ADR 0044: partial SMBC catalogs are evidence, but do not produce parse jobs.
// A resumed success must expose their earlier months in its eligible snapshot.
// Everything below is synthetic; no bank or production service is contacted.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import {
  CORE_MIGRATIONS_URL,
  migrationFiles,
  migrationSql,
} from "../../../packages/storage-d1/src/migrations.ts";
import { readTerminal, terminalKey } from "../../../packages/collection/src/index.ts";
import {
  dataBucket,
  manifestBytes,
  persistBackfillRun,
  persistSharedRun,
} from "../../collector-smbc-direct/src/shared-collection.ts";
import { runPrefix, sha256Hex } from "../../collector-smbc-direct/src/storage.ts";
import type { BackfillManifest, StoredArtifact } from "../../collector-smbc-direct/src/types.ts";
import { registerCollectionRun } from "../src/collection/index.ts";
import { sweep } from "../src/worker.ts";
import { CURRENT_SNAPSHOT, snapshotCtes } from "../../../packages/parsers/src/snapshot-query.ts";

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
    SHARED_R2_INGEST_ENABLED: "true",
    COLLECTION_INGEST_CLIENT: "processor-shared-r2",
  } as unknown as Env;
}, 60000);

afterAll(async () => {
  await mf?.dispose();
});

const RUN_ID = "00000000-0000-4000-8000-00000000a044";
const STARTED = "2001-03-01T00:00:00.000Z";
const PREFIX = runPrefix(STARTED, RUN_ID);
const ACCOUNT = {
  basis: "authenticated-request-v1",
  accountType: "ordinary",
  branchCode: "123",
  accountNumber: "0012345",
};
const bodies = new Map<string, Uint8Array>();

async function artifact(
  dataset: StoredArtifact["dataset"],
  relativeKey: string,
  value: unknown,
  range?: { start: string; end: string },
): Promise<StoredArtifact> {
  const bytes = new TextEncoder().encode(JSON.stringify(value) + "\n");
  const key = PREFIX + "/" + relativeKey;
  bodies.set(key, bytes);
  return {
    dataset,
    key,
    bytes: bytes.length,
    sha256: await sha256Hex(bytes),
    mediaType: "application/json",
    ...(range
      ? { range, transactionCount: dataset === "foreign-ordinary-aud-history" ? 0 : 1 }
      : {}),
  };
}

async function balance(amount = 1000): Promise<StoredArtifact[]> {
  return [
    await artifact("balance-raw", "balance.raw.json.sjis", { synthetic: "balance-response" }),
    await artifact("balance-normalized", "balance.normalized.json", {
      observedAt: STARTED,
      account: ACCOUNT,
      currency: "JPY",
      amount,
    }),
  ];
}

async function month(number: 1 | 2): Promise<StoredArtifact[]> {
  const range =
    number === 1
      ? { start: "2001-01-01", end: "2001-01-31" }
      : { start: "2001-02-01", end: "2001-02-28" };
  const key =
    "transactions/" + range.start.replaceAll("-", "") + "-" + range.end.replaceAll("-", "");
  return [
    await artifact(
      "transactions-raw",
      key + ".raw.json.sjis",
      { synthetic: "month-" + number },
      range,
    ),
    await artifact(
      "transactions-normalized",
      key + ".normalized.json",
      {
        range,
        account: ACCOUNT,
        depositsTotal: 0,
        withdrawalsTotal: 100,
        transactions: [
          {
            id: "synthetic-month-" + number,
            date: range.start + "T00:00:00+09:00",
            amount: 100,
            balanceAfter: 900,
            description: "synthetic debit",
            direction: "debit",
          },
        ],
      },
      range,
    ),
  ];
}

function manifest(artifacts: StoredArtifact[], success: boolean): BackfillManifest {
  return {
    schemaVersion: "smbc-direct-backfill-worker-poc-v2",
    source: "smbc-direct",
    runId: RUN_ID,
    startedAt: STARTED,
    completedAt: success ? "2001-03-01T00:02:00.000Z" : "2001-03-01T00:01:00.000Z",
    status: success ? "success" : "partial",
    requestedRange: { start: "2001-01-01", end: "2001-02-28" },
    completedChunks: success ? 2 : 1,
    totalChunks: 2,
    transactionCount: success ? 2 : 1,
    artifacts,
    failureCodes: success ? [] : ["session_missing"],
    logoutSucceeded: success,
  };
}

function input(value: BackfillManifest) {
  return {
    manifest: value,
    manifestBytes: manifestBytes(value),
    prefix: PREFIX,
    bytesByKey: bodies,
    identity: {
      attemptId: "synthetic-attempt",
      acquisitionSessionRef: "synthetic-initial-session",
      continuationSessionRef: "synthetic-resumed-session",
    },
  };
}

const fetchRun = (runId: string) =>
  env.DB.prepare(
    "SELECT fetch_run_id FROM collection_runs WHERE source='smbc-direct' AND run_id=? AND registered_at IS NOT NULL",
  )
    .bind(runId)
    .first<number>("fetch_run_id");

const observationCounts = () =>
  env.DB.prepare(`SELECT
    (SELECT COUNT(*) FROM transaction_observations) AS transactions,
    (SELECT COUNT(*) FROM balance_observations) AS balances,
    (SELECT COUNT(*) FROM published_parse_runs) AS published`).first<{
    transactions: number;
    balances: number;
    published: number;
  }>();

test("partial months remain unparsed until cumulative success even with failed logout; retries parse nothing twice", async () => {
  const bucket = dataBucket(env.EVIDENCE);
  const firstArtifacts = [...(await balance()), ...(await month(1))];
  // Reproduce the immutable terminal written by the previously shipped code.
  expect((await persistSharedRun(bucket, input(manifest(firstArtifacts, false)))).outcome).toBe(
    "persisted",
  );
  const originalKey = terminalKey("smbc-direct", RUN_ID);
  const originalBytes = new Uint8Array(await (await env.EVIDENCE.get(originalKey))!.arrayBuffer());
  expect(await registerCollectionRun(env, { source: "smbc-direct", runId: RUN_ID })).toMatchObject({
    outcome: "registered",
    artifacts: 5,
  });
  const initialFetchRun = await fetchRun(RUN_ID);
  expect(
    await env.DB.prepare(
      "SELECT r.status,ur.normalized_outcome AS unit_outcome FROM observation_fetch_runs r JOIN fetch_units u ON u.fetch_run_id=r.id JOIN fetch_unit_reports ur ON ur.fetch_unit_id=u.id WHERE r.id=?",
    )
      .bind(initialFetchRun)
      .first<{ status: string; unit_outcome: string }>(),
  ).toEqual({ status: "partial", unit_outcome: "failed" });
  expect(await sweep(env)).toMatchObject({ parsed: 0, error: 0 });
  expect(
    await env.DB.prepare(
      "SELECT outcome,jobs_created FROM observation_work_items WHERE fetch_run_id=?",
    )
      .bind(initialFetchRun)
      .first<{ outcome: string; jobs_created: number }>(),
  ).toEqual({ outcome: "not_eligible", jobs_created: 0 });
  expect(await observationCounts()).toEqual({ transactions: 0, balances: 0, published: 0 });

  const fullInput = input({
    ...manifest([...firstArtifacts, ...(await month(2))], true),
    logoutSucceeded: false,
  });
  const published = await persistBackfillRun(bucket, fullInput);
  expect(published.outcome).toBe("persisted");
  const continuationId = published.terminalKey.slice(
    "runs/smbc-direct/".length,
    -"/terminal.json".length,
  );
  const read = await readTerminal(bucket, "smbc-direct", continuationId);
  if (read.outcome !== "found") throw new Error("missing synthetic continuation");
  expect(read.manifest.requestedScope).toMatchObject({
    startValue: "2001-01-01",
    endValue: "2001-02-28",
  });
  expect(read.manifest.acquisitionSessionRef).toBe("synthetic-initial-session");
  expect(read.manifest.reports).toContainEqual({
    reportRef: "logout",
    reportKind: "logout",
    scope: "run",
    outcome: "failed",
    safeErrorCode: "logout_failed",
  });
  expect(
    await registerCollectionRun(env, { source: "smbc-direct", runId: continuationId }),
  ).toMatchObject({ outcome: "registered", artifacts: 8 });
  const completeFetchRun = await fetchRun(continuationId);
  expect(
    await env.DB.prepare("SELECT status,failure_count FROM observation_fetch_runs WHERE id=?")
      .bind(completeFetchRun)
      .first<{ status: string; failure_count: number }>(),
  ).toEqual({ status: "success", failure_count: 0 });
  expect(await sweep(env)).toMatchObject({ parsed: 3, error: 0 });
  expect(await observationCounts()).toEqual({ transactions: 2, balances: 1, published: 3 });
  expect(
    (
      await env.DB.prepare(
        "SELECT o.external_id,json_extract(o.extra_json,'$._kogane.bankAccount') AS account FROM transaction_observations o JOIN parse_runs p ON p.id=o.parse_run_id JOIN fetch_artifacts a ON a.id=p.fetch_artifact_id WHERE a.fetch_run_id=? ORDER BY o.external_id",
      )
        .bind(completeFetchRun)
        .all<{ external_id: string; account: string }>()
    ).results,
  ).toEqual([
    { external_id: "synthetic-month-1", account: JSON.stringify(ACCOUNT) },
    { external_id: "synthetic-month-2", account: JSON.stringify(ACCOUNT) },
  ]);
  expect(new Uint8Array(await (await env.EVIDENCE.get(originalKey))!.arrayBuffer())).toEqual(
    originalBytes,
  );

  expect((await persistBackfillRun(bucket, fullInput)).outcome).toBe("already_persisted");
  expect(
    await registerCollectionRun(env, { source: "smbc-direct", runId: continuationId }),
  ).toMatchObject({ outcome: "already_registered" });
  expect(await sweep(env)).toMatchObject({ parsed: 0, error: 0 });
  expect(await observationCounts()).toEqual({ transactions: 2, balances: 1, published: 3 });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM observation_parse_jobs j JOIN fetch_artifacts a ON a.id=j.fetch_artifact_id WHERE a.fetch_run_id=?",
    )
      .bind(initialFetchRun)
      .first<number>("n"),
  ).toBe(0);
}, 60000);

async function foreign(complete: boolean, amount = "123.45"): Promise<StoredArtifact[]> {
  const entries = [
    await artifact("foreign-ordinary-aud-balance", "foreign-ordinary-aud/balance.json", {
      currency: "AUD",
      amount,
      yenEquivalent: "12000",
      referenceRate: "97.205",
      observedAt: STARTED,
    }),
  ];
  if (complete)
    for (const range of [
      { start: "2001-01-01", end: "2001-01-31" },
      { start: "2001-02-01", end: "2001-02-28" },
    ]) {
      entries.push(
        await artifact(
          "foreign-ordinary-aud-history",
          `foreign-ordinary-aud/history/${range.start.replaceAll("-", "")}-${range.end.replaceAll("-", "")}.json`,
          { currency: "AUD", range, emptyCode: "PC-AIFDDT1-00134-E", transactions: [] },
          range,
        ),
      );
    }
  return entries;
}

async function currentSmbcBalances() {
  const ctes = snapshotCtes({
    fetchArtifacts: "observation_fetch_artifacts",
    fetchRuns: "observation_fetch_runs",
    parseRuns: "parse_runs",
    publishedParseRuns: "published_parse_runs",
  });
  return (
    await env.DB.prepare(`WITH ${ctes}
    SELECT p.parser_name, b.amount_minor FROM balance_observations b
    JOIN parse_runs p ON p.id=b.parse_run_id
    JOIN observation_fetch_artifacts fa ON fa.id=p.fetch_artifact_id
    WHERE fa.source_id='smbc-bank' AND ${CURRENT_SNAPSHOT}
      AND EXISTS(SELECT 1 FROM published_parse_runs published WHERE published.parse_run_id=p.id)
    ORDER BY p.parser_name`).all<{ parser_name: string; amount_minor: number }>()
  ).results;
}

test("independent yen, AUD balance and history units publish only complete data through failures and resumes", async () => {
  const bucket = dataBucket(env.EVIDENCE);
  const completeForeign = {
    range: { start: "2001-01-01", end: "2001-02-28" },
    balance: { status: "success" as const },
    history: { status: "success" as const },
  };
  const clean = {
    ...manifest(
      [...(await balance()), ...(await month(1)), ...(await month(2)), ...(await foreign(true))],
      true,
    ),
    runId: "00000000-0000-4000-8000-00000000a045",
    foreignOrdinary: completeForeign,
  };
  expect((await persistSharedRun(bucket, input(clean))).outcome).toBe("persisted");
  expect(
    await registerCollectionRun(env, { source: "smbc-direct", runId: clean.runId }),
  ).toMatchObject({ outcome: "registered" });
  expect(await sweep(env)).toMatchObject({ parsed: 6, error: 0 });
  expect(await currentSmbcBalances()).toEqual([
    { parser_name: "smbc-direct-balance", amount_minor: 1000 },
    { parser_name: "smbc-foreign-ordinary-balance", amount_minor: 12345 },
  ]);

  const failure = "foreign_nonempty_unreviewed";
  const partial = {
    ...manifest(
      [
        ...(await balance(2000)),
        ...(await month(1)),
        ...(await month(2)),
        ...(await foreign(false, "234.56")),
      ],
      true,
    ),
    runId: "00000000-0000-4000-8000-00000000a046",
    status: "partial" as const,
    failureCodes: [failure],
    foreignOrdinary: {
      ...completeForeign,
      history: { status: "partial" as const, failureCode: failure },
    },
  };
  expect((await persistSharedRun(bucket, input(partial))).outcome).toBe("persisted");
  expect(
    await registerCollectionRun(env, { source: "smbc-direct", runId: partial.runId }),
  ).toMatchObject({ outcome: "registered" });
  expect(await sweep(env)).toMatchObject({ parsed: 4, error: 0 });
  expect(await currentSmbcBalances()).toEqual([
    { parser_name: "smbc-direct-balance", amount_minor: 2000 },
    { parser_name: "smbc-foreign-ordinary-balance", amount_minor: 23456 },
  ]);
  expect(
    await registerCollectionRun(env, { source: "smbc-direct", runId: partial.runId }),
  ).toMatchObject({ outcome: "already_registered" });
  expect(await sweep(env)).toMatchObject({ parsed: 0, error: 0 });

  const badYen = {
    ...partial,
    runId: "00000000-0000-4000-8000-00000000a047",
    artifacts: [...(await balance(3000)), ...(await month(1)), ...(await foreign(false, "345.67"))],
    completedChunks: 1,
    failureCodes: [failure, "transactions_rejected"],
  };
  expect((await persistSharedRun(bucket, input(badYen))).outcome).toBe("persisted");
  expect(
    await registerCollectionRun(env, { source: "smbc-direct", runId: badYen.runId }),
  ).toMatchObject({ outcome: "registered" });
  expect(await sweep(env)).toMatchObject({ parsed: 1, error: 0 });
  expect(await currentSmbcBalances()).toEqual([
    { parser_name: "smbc-direct-balance", amount_minor: 2000 },
    { parser_name: "smbc-foreign-ordinary-balance", amount_minor: 34567 },
  ]);
  const completeAud = {
    ...badYen,
    runId: "00000000-0000-4000-8000-00000000a049",
    artifacts: [...(await balance(3500)), ...(await month(1)), ...(await foreign(true, "456.78"))],
    failureCodes: ["transactions_rejected"],
    foreignOrdinary: completeForeign,
  };
  expect((await persistSharedRun(bucket, input(completeAud))).outcome).toBe("persisted");
  expect(
    await registerCollectionRun(env, { source: "smbc-direct", runId: completeAud.runId }),
  ).toMatchObject({ outcome: "registered" });
  expect(await sweep(env)).toMatchObject({ parsed: 3, error: 0 });
  expect(await currentSmbcBalances()).toEqual([
    { parser_name: "smbc-direct-balance", amount_minor: 2000 },
    { parser_name: "smbc-foreign-ordinary-balance", amount_minor: 45678 },
  ]);

  // A stopped yen backfill with an independently failed AUD unit must carry
  // its earlier unparsed yen month into the final AUD-partial continuation.
  const stopped = {
    ...badYen,
    runId: "00000000-0000-4000-8000-00000000a048",
    artifacts: [...(await balance(4000)), ...(await month(1)), ...(await foreign(false, "567.89"))],
  };
  expect((await persistSharedRun(bucket, input(stopped))).outcome).toBe("persisted");
  expect(
    await registerCollectionRun(env, { source: "smbc-direct", runId: stopped.runId }),
  ).toMatchObject({ outcome: "registered" });
  expect(await sweep(env)).toMatchObject({ parsed: 1, error: 0 });
  const audPublishedCount = async () =>
    env.DB.prepare(
      "SELECT COUNT(*) AS n FROM balance_observations b JOIN parse_runs p ON p.id=b.parse_run_id WHERE p.parser_name='smbc-foreign-ordinary-balance'",
    ).first<number>("n");
  const priorAudCount = await audPublishedCount();
  const resumed = {
    ...stopped,
    artifacts: [...stopped.artifacts, ...(await month(2))],
    completedChunks: 2,
    failureCodes: [failure],
  };
  const continued = await persistBackfillRun(bucket, input(resumed));
  expect(continued.outcome).toBe("persisted");
  const continuationId = continued.terminalKey.slice(
    "runs/smbc-direct/".length,
    -"/terminal.json".length,
  );
  expect(
    await registerCollectionRun(env, { source: "smbc-direct", runId: continuationId }),
  ).toMatchObject({ outcome: "registered" });
  expect(await sweep(env)).toMatchObject({ parsed: 3, error: 0 });
  expect(await currentSmbcBalances()).toEqual([
    { parser_name: "smbc-direct-balance", amount_minor: 4000 },
    { parser_name: "smbc-foreign-ordinary-balance", amount_minor: 56789 },
  ]);
  expect(await audPublishedCount()).toBe(priorAudCount);
  expect((await persistBackfillRun(bucket, input(resumed))).outcome).toBe("already_persisted");
  expect(
    await registerCollectionRun(env, { source: "smbc-direct", runId: continuationId }),
  ).toMatchObject({ outcome: "already_registered" });
  expect(await sweep(env)).toMatchObject({ parsed: 0, error: 0 });
}, 60000);
