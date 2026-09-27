// ADR 0027: the producer switch from the retired importer to the collector,
// for one MoneyForward account-month captured by both (INV06).
//
// The importer registered each account under its HMAC identity
// (`collector-r2-importer`, unit key `moneyforward-account-v1-<64 hex>`); the
// collector now registers the same identity under `collector-moneyforward-me`
// when it holds the importer's key. MoneyForward rows reach one reader, the
// transactions read, whose current snapshot is ranked per unit key and month
// and ignores the producer. So under the importer's key the collector's
// capture replaces the importer's for the months both captured, each provider
// row is read once, and months only the importer captured stay current. The
// two producers' source accounts map to one account entity
// (`accountEntityId`). Under another key the identities differ: that is the
// stated limit, pinned here so a change to it is seen.
//
// Everything is synthetic: the pages are the anonymous observation-pipeline
// fixtures, and the keys are made up.
import { afterEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
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
import { transactionsSql } from "../../../packages/read-model/src/sql.ts";
import { moneyForwardRunPlan } from "../../collector-moneyforward/src/shared-collection.ts";
import type { RawArtifact } from "../../collector-moneyforward/src/types.ts";
import { registerCollectionRun } from "../src/collection/index.ts";
import { identitySweep } from "../src/identity-store.ts";
import { sweep } from "../src/worker.ts";

const IMPORTER = "collector-r2-importer";
const COLLECTOR = "collector-moneyforward-me";
const KEY = "5a".repeat(32);
const OTHER_KEY = "c3".repeat(32);
const token = (key: string) =>
  `moneyforward-account-v1-${createHmac("sha256", Buffer.from(key, "hex"))
    .update(JSON.stringify(["moneyforward-account-v1", "anonymous-account", "anonymous-service"]))
    .digest("hex")}`;

const fixture = (name: string) =>
  readFileSync(
    new URL(`../../../tests/fixtures/observation-pipeline/moneyforward/${name}`, import.meta.url),
    "utf8",
  );
const FEBRUARY = fixture("account-01-month-2099-02.html");
/** The same synthetic fragment moved one month back: a month only the importer captured. */
const JANUARY = FEBRUARY.replace("2099-02-03", "2099-01-03").replace("2099-01-31", "2098-12-31");

let mf: Miniflare | undefined;
afterEach(async () => {
  await mf?.dispose();
  mf = undefined;
});

async function store(): Promise<Env> {
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
  return {
    DB: db,
    READ: read,
    EVIDENCE: await mf.getR2Bucket("EVIDENCE"),
    SHARED_R2_INGEST_ENABLED: "true",
    COLLECTION_INGEST_CLIENT: "processor-shared-r2",
  } as unknown as Env;
}

const HTML = "text/html; charset=utf-8";
const pages = (months: [string, string][]): RawArtifact[] => [
  {
    dataset: "accounts-index",
    filename: "accounts.html",
    mediaType: HTML,
    body: fixture("accounts.html"),
  },
  {
    dataset: "account-detail",
    filename: "account-detail-01.html",
    mediaType: HTML,
    body: fixture("account-detail-01.html"),
  },
  ...months.map(([month, body]) => ({
    dataset: "monthly-transactions",
    filename: `account-01-month-${month}.html`,
    mediaType: HTML,
    body,
  })),
];

/**
 * One successful run, built by the collector's own `moneyForwardRunPlan` and
 * registered. `producer` overrides the plan's producer: an importer-era run is
 * registered the same way under `collector-r2-importer` (through a test-only
 * route), which gives what the readers use of the importer's runs: the
 * producer, the identity unit key, the positional artifact keys, the dataset,
 * the capture time and a successful run.
 */
async function registeredRun(
  env: Env,
  input: {
    runId: string;
    key: string;
    at: string;
    months: [string, string][];
    producer?: string;
  },
): Promise<number> {
  const plan = await moneyForwardRunPlan(
    {
      schemaVersion: "moneyforward-worker-poc-v1",
      runId: input.runId,
      startedAt: input.at,
      completedAt: input.at,
      status: "success",
      accountDetailCount: 1,
      monthlyFragmentCount: input.months.length,
      artifacts: pages(input.months),
      failures: [],
    },
    input.key,
  );
  const run =
    input.producer === undefined
      ? plan
      : { ...plan, run: { ...plan.run, producer: input.producer } };
  expect((await persistRun(env.EVIDENCE, run)).outcome).toBe("persisted");
  expect(
    await registerCollectionRun(env, { source: "moneyforward-me", runId: input.runId }),
  ).toMatchObject({ outcome: "registered" });
  const row = await env.DB.prepare(
    "SELECT r.id,f.producer_id FROM observation_fetch_runs r JOIN fetch_runs f ON f.id=r.id WHERE r.external_run_id=?",
  )
    .bind(input.runId)
    .first<{ id: number; producer_id: string }>();
  expect(row!.producer_id).toBe(input.producer ?? COLLECTOR);
  return row!.id;
}

/** The importer's route, for the test only: the importer no longer runs. */
async function importerRoute(env: Env): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO ingest_client_producers (ingest_client_id, producer_id) SELECT 'processor-shared-r2', ?1 WHERE NOT EXISTS (SELECT 1 FROM ingest_client_producers WHERE ingest_client_id='processor-shared-r2' AND producer_id=?1)",
    ).bind(IMPORTER),
    env.DB.prepare(
      "INSERT INTO producer_sources (producer_id, source_id) SELECT ?1, 'moneyforward-me' WHERE NOT EXISTS (SELECT 1 FROM producer_sources WHERE producer_id=?1 AND source_id='moneyforward-me')",
    ).bind(IMPORTER),
    env.DB.prepare(
      "INSERT INTO ingest_client_routes (ingest_client_id, producer_id, source_id, active) VALUES ('processor-shared-r2', ?1, 'moneyforward-me', 1)",
    ).bind(IMPORTER),
  ]);
}

/** The importer's August capture of January and February. */
async function importerRun(env: Env): Promise<number> {
  await importerRoute(env);
  return registeredRun(env, {
    runId: "00000000-0000-4000-8000-00000000d027",
    key: KEY,
    at: "2026-08-01T00:00:00.000Z",
    months: [
      ["2099-01", JANUARY],
      ["2099-02", FEBRUARY],
    ],
    producer: IMPORTER,
  });
}

/** The collector's September capture of February, under `key`. */
async function collectorRun(env: Env, key: string): Promise<number> {
  return registeredRun(env, {
    runId: "00000000-0000-4000-8000-00000000c027",
    key,
    at: "2026-09-20T00:00:00.000Z",
    months: [["2099-02", FEBRUARY]],
  });
}

async function all<T = Record<string, unknown>>(
  env: Env,
  sql: string,
  ...args: unknown[]
): Promise<T[]> {
  return (
    await env.DB.prepare(sql)
      .bind(...args)
      .all<T>()
  ).results;
}

/**
 * The MoneyForward transactions read, each row with the producer and run it
 * was read from. The read itself is the shipped `transactionsSql`.
 */
async function transactions(env: Env) {
  const page = transactionsSql({ source: "moneyforward-me" }, 0);
  const rows = await all<{
    id: number;
    source_account: string;
    as_of: string;
    amount_minor: string;
  }>(env, page.sql, ...page.args);
  const origin = new Map(
    (
      await all<{ id: number; producer_id: string; fetch_run_id: number }>(
        env,
        `SELECT t.id,f.producer_id,a.fetch_run_id FROM transaction_observations t
           JOIN parse_runs p ON p.id=t.parse_run_id JOIN fetch_artifacts a ON a.id=p.fetch_artifact_id
           JOIN fetch_runs f ON f.id=a.fetch_run_id`,
      )
    ).map((row) => [row.id, row]),
  );
  return rows
    .map((row) => ({
      producer: origin.get(row.id)!.producer_id,
      source_account: row.source_account,
      as_of: row.as_of,
      amount_minor: row.amount_minor,
    }))
    .sort((a, b) =>
      `${a.as_of}${a.producer}${a.amount_minor}`.localeCompare(
        `${b.as_of}${b.producer}${b.amount_minor}`,
      ),
    );
}

/** Each MoneyForward source account, its producer and the entity it maps to. */
const MAPPINGS = `SELECT s.producer_id,s.reference_json,m.account_id,m.status
  FROM source_accounts s JOIN current_account_mappings m ON m.source_account_id=s.id
 WHERE s.source_id='moneyforward-me' ORDER BY s.producer_id`;

test("under the importer's key each provider row is read once, and both producers map to one account entity", async () => {
  const env = await store();
  const identity = token(KEY);
  const account = `moneyforward-me:${identity}`;
  const importerFetchRun = await importerRun(env);
  expect(await sweep(env)).toMatchObject({ parsed: 4, error: 0 });
  await identitySweep(env.DB, resolveIdentity, 40);
  const importerEra = [
    { producer: IMPORTER, source_account: account, as_of: "2099-01-03", amount_minor: "-1234" },
    { producer: IMPORTER, source_account: account, as_of: "2099-01-03", amount_minor: "500" },
    { producer: IMPORTER, source_account: account, as_of: "2099-02-03", amount_minor: "-1234" },
    { producer: IMPORTER, source_account: account, as_of: "2099-02-03", amount_minor: "500" },
  ];
  expect(await transactions(env)).toEqual(importerEra);
  const [importerMapping] = await all<{ account_id: string }>(env, MAPPINGS);

  await collectorRun(env, KEY);
  expect(await sweep(env)).toMatchObject({ parsed: 3, error: 0 });
  await identitySweep(env.DB, resolveIdentity, 40);

  // February, captured by both, is read once, from the collector's newer
  // capture; January, captured only by the importer, stays current.
  expect(await transactions(env)).toEqual([
    importerEra[0],
    importerEra[1],
    { producer: COLLECTOR, source_account: account, as_of: "2099-02-03", amount_minor: "-1234" },
    { producer: COLLECTOR, source_account: account, as_of: "2099-02-03", amount_minor: "500" },
  ]);
  // The importer's February rows are kept (evidence is append-only), only
  // no longer current.
  expect(
    (
      await all<{ n: number }>(
        env,
        `SELECT count(*) AS n FROM transaction_observations t JOIN parse_runs p ON p.id=t.parse_run_id
           JOIN fetch_artifacts a ON a.id=p.fetch_artifact_id
          WHERE a.fetch_run_id=? AND a.artifact_key='account-01-month-2099-02.html'`,
        importerFetchRun,
      )
    )[0]!.n,
  ).toBe(2);
  // Two source accounts, one per producer, and one account entity: the one
  // the importer's source account already mapped to.
  expect(await all(env, MAPPINGS)).toEqual([
    {
      producer_id: COLLECTOR,
      reference_json: JSON.stringify([account]),
      account_id: importerMapping!.account_id,
      status: "provider-local",
    },
    {
      producer_id: IMPORTER,
      reference_json: JSON.stringify([account]),
      account_id: importerMapping!.account_id,
      status: "provider-local",
    },
  ]);
  expect(await all(env, "SELECT count(*) AS n FROM accounts")).toEqual([{ n: 1 }]);
}, 60_000);

test("under another key the identities differ: the months both captured are read under two source accounts (the stated limit)", async () => {
  const env = await store();
  const importer = `moneyforward-me:${token(KEY)}`;
  const collector = `moneyforward-me:${token(OTHER_KEY)}`;
  await importerRun(env);
  expect(await sweep(env)).toMatchObject({ parsed: 4, error: 0 });
  await collectorRun(env, OTHER_KEY);
  expect(await sweep(env)).toMatchObject({ parsed: 3, error: 0 });
  await identitySweep(env.DB, resolveIdentity, 40);

  // Nothing merges a different identity: February shows once per identity.
  // The identity check in docs/identity-operations.md is how the owner sees it
  // (identities not known to the importer) before relying on the read.
  expect(
    (await transactions(env)).map((row) => [row.producer, row.source_account, row.as_of]),
  ).toEqual([
    [IMPORTER, importer, "2099-01-03"],
    [IMPORTER, importer, "2099-01-03"],
    [COLLECTOR, collector, "2099-02-03"],
    [COLLECTOR, collector, "2099-02-03"],
    [IMPORTER, importer, "2099-02-03"],
    [IMPORTER, importer, "2099-02-03"],
  ]);
  const mappings = await all<{ account_id: string }>(env, MAPPINGS);
  expect(mappings).toHaveLength(2);
  expect(mappings[0]!.account_id).not.toBe(mappings[1]!.account_id);
}, 60_000);
