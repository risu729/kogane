import { applyTestReadMigrations, applyTestSql } from "./migration-setup.ts";
// ADR 0027 end to end: a MoneyForward run the collector persisted to the
// shared bucket - built by its real `moneyForwardRunPlan` - registers, seals,
// and parses only when its units are the account identity the parser
// requires. Since ADR 0029 the collector needs no secret: from the detail
// page's tuple the account's unit is `moneyforward-account-v2-<64 hex>`, and
// the monthly fragments parse under `moneyforward-monthly-transactions` 2.0.3
// and the index and detail under `moneyforward-canonical-evidence-boundary`
// 1.0.2 with no error. When the detail page carries no tuple the units stay
// positional (`account-NN`) and every one of those parses is
// `parser_rejected`, which is the production finding ADR 0027 answered.
//
// Everything is synthetic: the pages are the anonymous observation-pipeline
// fixtures.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import {
  CORE_MIGRATIONS_URL,
  migrationFiles,
  migrationSql,
} from "../../../packages/storage-d1/src/migrations.ts";
import { persistRun } from "../../../packages/collection/src/writer.ts";
import { resolveIdentity } from "../../../packages/identity/src/index.ts";
import { moneyForwardRunPlan } from "../../collector-moneyforward/src/shared-collection.ts";
import type { RawArtifact } from "../../collector-moneyforward/src/types.ts";
import { registerCollectionRun } from "../src/collection/index.ts";
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
    await applyTestSql(db, migrationSql(CORE_MIGRATIONS_URL, file));
  // The ingest registry exactly as an operator applies it.
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

const fixture = (name: string) =>
  readFileSync(
    new URL(`../../../tests/fixtures/observation-pipeline/moneyforward/${name}`, import.meta.url),
    "utf8",
  );
/** The fixture detail page's `account[id_hash]` and `service[id]`, synthetic. */
const TOKEN = `moneyforward-account-v2-${createHash("sha256")
  .update(JSON.stringify(["moneyforward-account-v2", "anonymous-account", "anonymous-service"]))
  .digest("hex")}`;

/** The identity check in docs/identity-operations.md, as the owner runs it. */
const IDENTITY_CHECK_SQL = `SELECT r.producer_id, substr(u.unit_key,1,24) AS version,
       count(DISTINCT u.unit_key) AS identities,
       count(DISTINCT CASE WHEN EXISTS(
         SELECT 1 FROM fetch_units i JOIN fetch_runs ir ON ir.id=i.fetch_run_id
         WHERE ir.source_id='moneyforward-me' AND ir.producer_id='collector-r2-importer'
           AND i.unit_key=u.unit_key)
       THEN u.unit_key END) AS known_to_importer
FROM fetch_units u JOIN fetch_runs r ON r.id=u.fetch_run_id
WHERE r.source_id='moneyforward-me' AND u.unit_key GLOB 'moneyforward-account-v[12]-*'
GROUP BY r.producer_id, version;`;

const HTML = "text/html; charset=utf-8";
const artifacts: RawArtifact[] = [
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
  {
    dataset: "monthly-transactions",
    filename: "account-01-month-2099-02.html",
    mediaType: HTML,
    body: fixture("account-01-month-2099-02.html"),
  },
  {
    dataset: "monthly-transactions",
    filename: "account-01-month-2099-03.html",
    mediaType: HTML,
    body: fixture("account-01-month-2099-03-empty.html"),
  },
];

/** The detail page without its hidden inputs: no tuple to derive from. */
const withoutTuple: RawArtifact[] = artifacts.map((artifact) =>
  artifact.dataset === "account-detail"
    ? { ...artifact, body: "<!doctype html><html><body>synthetic detail</body></html>" }
    : artifact,
);

/** The collector's own plan for one successful run, with or without a tuple. */
function runPlan(runId: string, tuple: boolean) {
  return moneyForwardRunPlan({
    schemaVersion: "moneyforward-worker-poc-v1",
    runId,
    startedAt: "2026-09-20T00:00:00.000Z",
    completedAt: "2026-09-20T00:05:00.000Z",
    status: "success",
    accountDetailCount: 1,
    monthlyFragmentCount: 2,
    artifacts: tuple ? artifacts : withoutTuple,
    failures: [],
  });
}

const fetchRun = (runId: string) =>
  env.DB.prepare("SELECT id FROM observation_fetch_runs WHERE external_run_id=?")
    .bind(runId)
    .first<number>("id");

/** Parse jobs of one run, by parser, status and error code. */
async function jobs(runId: string) {
  return (
    await env.DB.prepare(
      `SELECT j.parser_name,j.parser_version,j.status,j.last_error_code,COUNT(*) AS n
         FROM observation_parse_jobs j JOIN fetch_artifacts a ON a.id=j.fetch_artifact_id
        WHERE a.fetch_run_id=? GROUP BY 1,2,3,4 ORDER BY 1`,
    )
      .bind(await fetchRun(runId))
      .all()
  ).results;
}

async function registerRun(runId: string, tuple: boolean) {
  const plan = await runPlan(runId, tuple);
  expect((await persistRun(env.EVIDENCE, plan)).outcome).toBe("persisted");
  expect(await registerCollectionRun(env, { source: "moneyforward-me", runId })).toMatchObject({
    outcome: "registered",
    artifacts: 5,
  });
  const fetchRunId = await fetchRun(runId);
  // Sealed, successful, and every unit holds exactly the artifacts naming it.
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM fetch_run_seals WHERE fetch_run_id=?")
      .bind(fetchRunId)
      .first<number>("n"),
  ).toBe(1);
  expect(
    (
      await env.DB.prepare(
        `SELECT r.status,u.unit_key,ur.normalized_outcome AS unit_outcome,ur.declared_artifact_count AS declared,
                (SELECT COUNT(*) FROM fetch_artifacts a WHERE a.fetch_unit_id=u.id) AS artifacts
           FROM observation_fetch_runs r JOIN fetch_units u ON u.fetch_run_id=r.id
           JOIN fetch_unit_reports ur ON ur.fetch_unit_id=u.id AND ur.report_kind='terminal'
          WHERE r.id=?`,
      )
        .bind(fetchRunId)
        .all()
    ).results,
  ).toEqual([
    {
      status: "success",
      unit_key: tuple ? TOKEN : "account-01",
      unit_outcome: "success",
      declared: 3,
      artifacts: 3,
    },
  ]);
  return fetchRunId;
}

test("with no secret the run's pages parse with no error under the v2 account identity", async () => {
  const runId = "00000000-0000-4000-8000-00000000a027";
  const fetchRunId = await registerRun(runId, true);
  expect(await sweep(env)).toMatchObject({ parsed: 4, error: 0 });
  expect(await jobs(runId)).toEqual([
    {
      parser_name: "moneyforward-canonical-evidence-boundary",
      parser_version: "1.0.2",
      status: "done",
      last_error_code: null,
      n: 2,
    },
    {
      parser_name: "moneyforward-monthly-transactions",
      parser_version: "2.0.3",
      status: "done",
      last_error_code: null,
      n: 2,
    },
  ]);
  // Only the declared month's rows, on the identity's source account.
  const rows = (
    await env.DB.prepare(
      `SELECT o.source_account,o.amount_minor FROM transaction_observations o
         JOIN parse_runs p ON p.id=o.parse_run_id JOIN fetch_artifacts a ON a.id=p.fetch_artifact_id
        WHERE a.fetch_run_id=? AND p.status='ok' ORDER BY o.amount_minor`,
    )
      .bind(fetchRunId)
      .all()
  ).results;
  expect(rows).toEqual([
    { source_account: `moneyforward-me:${TOKEN}`, amount_minor: -1234 },
    { source_account: `moneyforward-me:${TOKEN}`, amount_minor: 500 },
  ]);
  await identitySweep(env.DB, resolveIdentity, 40);
  // It resolves as a v1 identity did: one provider-local
  // aggregator-mirror account, on the collector's own source-account reference.
  expect(
    (
      await env.DB.prepare(
        `SELECT s.producer_id,s.reference_json,a.role,a.status
           FROM source_accounts s JOIN current_account_mappings m ON m.source_account_id=s.id
           JOIN accounts a ON a.id=m.account_id WHERE s.source_id='moneyforward-me'`,
      ).all()
    ).results,
  ).toEqual([
    {
      producer_id: "collector-moneyforward-me",
      reference_json: JSON.stringify([`moneyforward-me:${TOKEN}`]),
      role: "aggregator-mirror",
      status: "provider-local",
    },
  ]);
  // The owner's read-only check (docs/identity-operations.md), byte for byte:
  // with no importer run in this store, the collector's identity is not known
  // to the importer.
  expect((await env.DB.prepare(IDENTITY_CHECK_SQL).all()).results).toEqual([
    {
      producer_id: "collector-moneyforward-me",
      version: "moneyforward-account-v2-",
      identities: 1,
      known_to_importer: 0,
    },
  ]);
}, 60000);

test("without a tuple the units stay positional and every parse is parser_rejected", async () => {
  const runId = "00000000-0000-4000-8000-00000000b027";
  const fetchRunId = await registerRun(runId, false);
  expect(await sweep(env)).toMatchObject({ parsed: 1, error: 3 });
  // The index carries no account, so it parses; every page that names an
  // account is rejected, as in production.
  expect(await jobs(runId)).toEqual([
    {
      parser_name: "moneyforward-canonical-evidence-boundary",
      parser_version: "1.0.2",
      status: "done",
      last_error_code: null,
      n: 1,
    },
    {
      parser_name: "moneyforward-canonical-evidence-boundary",
      parser_version: "1.0.2",
      status: "failed",
      last_error_code: "parser_rejected",
      n: 1,
    },
    {
      parser_name: "moneyforward-monthly-transactions",
      parser_version: "2.0.3",
      status: "failed",
      last_error_code: "parser_rejected",
      n: 2,
    },
  ]);
  expect(
    await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM transaction_observations o JOIN parse_runs p ON p.id=o.parse_run_id
        JOIN fetch_artifacts a ON a.id=p.fetch_artifact_id WHERE a.fetch_run_id=?`,
    )
      .bind(fetchRunId)
      .first<number>("n"),
  ).toBe(0);
}, 60000);
