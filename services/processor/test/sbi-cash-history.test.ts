// Synthetic collector -> shared storage -> real registration/publication -> reader.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import {
  CORE_MIGRATIONS_URL,
  migrationFiles,
  migrationSql,
} from "../../../packages/storage-d1/src/migrations.ts";
import { applyTestSql } from "./migration-setup.ts";
import { persistRun } from "../../../packages/collection/src/writer.ts";
import { collectCashHistory } from "../../collector-sbi-securities/src/cash-history.ts";
import { sbiRunPlan } from "../../collector-sbi-securities/src/shared-run.ts";
import type { Artifact } from "../../collector-sbi-securities/src/types.ts";
import { registerCollectionRun } from "../src/collection/index.ts";
import { parseJob } from "../src/worker.ts";
import { createD1ObservationReader } from "../../../packages/read-model/src/d1.ts";
import { sbiForeignCashHistory } from "../../../packages/parsers/src/parsers/sbi-foreign-cash-history.ts";
import { sbiYenDetailHistory } from "../../../packages/parsers/src/parsers/sbi-yen-detail-history.ts";
import type { CashHistoryKind } from "../../../packages/parsers/src/parsers/sbi-cash-history-schema.ts";

let mf: Miniflare;
let env: Env;
beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default {};",
      compatibilityDate: "2026-09-07",
      d1Databases: ["DB"],
      r2Buckets: ["EVIDENCE"],
    }),
  );
  const db = await mf.getD1Database("DB");
  for (const file of migrationFiles(CORE_MIGRATIONS_URL))
    await applyTestSql(db, migrationSql(CORE_MIGRATIONS_URL, file));
  await applyTestSql(
    db,
    readFileSync(new URL("../../../infra/bootstrap/ingest-clients.sql", import.meta.url), "utf8"),
  );
  env = {
    DB: db,
    EVIDENCE: await mf.getR2Bucket("EVIDENCE"),
    SHARED_R2_INGEST_ENABLED: "true",
    COLLECTION_INGEST_CLIENT: "processor-shared-r2",
  } as unknown as Env;
}, 60_000);
afterAll(async () => {
  await mf?.dispose();
});

const fixture = () =>
  JSON.parse(
    readFileSync(
      new URL(
        "../../../tests/fixtures/observation-pipeline/sbi-parser-boundaries/foreign-cash-history.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
function yenPages() {
  const records = Array.from({ length: 11 }, (_, i) => ({
    did: 2001 + i,
    detailKbn: "金融機関からの入金",
    payDepKbn: "入金",
    payDepDate: "2099/09/03",
    payAmount: "100",
    dispAbstract: "synthetic deposit",
  }));
  return [records.slice(0, 10), records.slice(10)].map((depositRecordList, i) => ({
    depositRecordList,
    detailsConditions: ["入金：すべて", "出金：すべて"],
    exceededMaxCount: false,
    isExceededMaxCount: false,
    pageCount: 2,
    pageNumber: i + 1,
    pageSize: 10,
    totalCount: 11,
    totalDepositAmount: "1100",
    totalDepositCount: "11",
    totalPaymentAmount: "0",
    totalPaymentCount: "0",
    totalTransDepositAmount: "0",
    totalTransDepositCount: "0",
    totalTransPaymentAmount: "0",
    totalTransPaymentCount: "0",
  }));
}
async function capture(runId: string, kind: CashHistoryKind) {
  const artifacts: Artifact[] = [];
  const pages = kind === "yen" ? yenPages() : fixture().pages;
  await collectCashHistory({
    kind,
    today: "2099-12-31",
    retain: (a) => artifacts.push(a),
    fetchPage: async (_, pageNumber) =>
      new TextEncoder().encode(JSON.stringify(pages[pageNumber - 1])),
  });
  const plan = await sbiRunPlan({
    runId,
    producerVersion: "synthetic-v1",
    attemptId: `attempt-${runId}`,
    startedAt: "2020-01-01T00:00:00Z",
    completedAt: "2020-01-01T00:01:00Z",
    status: "success",
    scope: "domestic",
    artifacts,
    failures: [],
  });
  expect(plan.run.providerOutcome).toBe("success");
  expect((await persistRun(env.EVIDENCE, plan)).outcome).toBe("persisted");
  expect(await registerCollectionRun(env, { source: "sbi-securities", runId })).toMatchObject({
    outcome: "registered",
  });
  const parser = kind === "yen" ? sbiYenDetailHistory : sbiForeignCashHistory;
  const dataset = kind === "yen" ? "yen-detail-history" : "foreign-cash-history";
  const artifactId = (await env.DB.prepare(
    "SELECT id FROM fetch_artifacts WHERE source_id='sbi-securities' AND dataset=? ORDER BY id DESC LIMIT 1",
  )
    .bind(dataset)
    .first<number>("id"))!;
  expect(artifactId).toBeGreaterThan(0);
  await env.DB.prepare(
    "INSERT INTO observation_parse_jobs(fetch_artifact_id,parser_name,parser_version,status) VALUES(?,?,?,'pending')",
  )
    .bind(artifactId, parser.name, parser.version)
    .run();
  expect(
    await parseJob(
      env,
      {
        fetch_artifact_id: artifactId,
        parser_name: parser.name,
        parser_version: parser.version,
        attempts: 0,
      },
      parser,
    ),
  ).toBe("parsed");
  return artifactId;
}

test("JPY pages and USD duplicate occurrences publish once through the production reader across overlapping runs", async () => {
  const reader = createD1ObservationReader(env.DB);
  await capture("cash-yen-first", "yen");
  await capture("cash-usd-first", "foreign");
  const before = await reader.listTransactions({ source: "sbi-securities", offset: 0 });
  expect(before).toHaveLength(14);
  expect(before.filter((row) => row.currency === "JPY")).toHaveLength(11);
  expect(
    before
      .filter((row) => row.currency === "USD")
      .map((row) => row.amount_minor)
      .sort(),
  ).toEqual(["1234", "1234", "567"]);
  await capture("cash-yen-overlap", "yen");
  await capture("cash-usd-overlap", "foreign");
  const after = await reader.listTransactions({ source: "sbi-securities", offset: 0 });
  expect(after).toHaveLength(14);
  expect(new Set(after.map((row) => row.external_id)).size).toBe(14);
  expect(
    await env.DB.prepare("SELECT COUNT(*) n FROM transaction_observations").first<number>("n"),
  ).toBe(28);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM published_parse_runs WHERE parser_name IN ('sbi-yen-detail-history','sbi-foreign-cash-history')",
    ).first<number>("n"),
  ).toBe(4);
}, 60_000);
