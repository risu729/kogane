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
    ...(range ? { range, transactionCount: 1 } : {}),
  };
}

async function balance(): Promise<StoredArtifact[]> {
  return [
    await artifact("balance-raw", "balance.raw.json.sjis", { synthetic: "balance-response" }),
    await artifact("balance-normalized", "balance.normalized.json", {
      observedAt: STARTED,
      account: ACCOUNT,
      currency: "JPY",
      amount: 1000,
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

test("partial months remain unparsed until cumulative success; publication retries parse nothing twice", async () => {
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

  const fullInput = input(manifest([...firstArtifacts, ...(await month(2))], true));
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
