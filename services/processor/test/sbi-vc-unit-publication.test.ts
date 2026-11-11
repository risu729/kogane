// The real collector DO runs in a subprocess with its own generated Env. Its
// synthetic R2 bytes then take the production registration, parse/publication
// and reader paths on local D1. No provider or credential is contacted.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import {
  CORE_MIGRATIONS_URL,
  migrationFiles,
  migrationSql,
} from "../../../packages/storage-d1/src/migrations.ts";
import type { TerminalManifest } from "../../../packages/collection/src/manifest.ts";
import { unitScopedEligibilitySql } from "../../../packages/parsers/src/snapshot-query.ts";
import { createD1ObservationReader, PAGE_LIMIT } from "../../../packages/read-model/src/index.ts";
import { registerCollectionRun } from "../src/collection/index.ts";
import { sweep } from "../src/worker.ts";
import { applyTestReadMigrations, applyTestSql } from "./migration-setup.ts";

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
  const DB = await mf.getD1Database("DB");
  for (const file of migrationFiles(CORE_MIGRATIONS_URL))
    await applyTestSql(DB, migrationSql(CORE_MIGRATIONS_URL, file));
  await applyTestSql(
    DB,
    readFileSync(new URL("../../../infra/bootstrap/ingest-clients.sql", import.meta.url), "utf8"),
  );
  const READ = await mf.getD1Database("READ");
  await applyTestReadMigrations(READ);
  env = {
    DB,
    READ,
    EVIDENCE: await mf.getR2Bucket("EVIDENCE"),
    SHARED_R2_INGEST_ENABLED: "true",
    COLLECTION_INGEST_CLIENT: "processor-shared-r2",
  } as unknown as Env;
}, 60_000);
afterAll(async () => {
  await mf?.dispose();
});

interface Capture {
  summary: { runId: string; status: string };
  terminal: TerminalManifest;
  objects: {
    key: string;
    body: string;
    contentType?: string;
    customMetadata?: Record<string, string>;
    sha256: string | null;
  }[];
}
async function capture(
  scenario: string,
  session: string,
): Promise<Capture & { fetchRunId: number }> {
  const child = Bun.spawn(
    [
      process.execPath,
      new URL("../../collector-sbi-vc-trade/test/capture-fixture.ts", import.meta.url).pathname,
      scenario,
      session,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exit !== 0) throw new Error(`synthetic collector fixture failed: ${stderr}`);
  const result = JSON.parse(stdout) as Capture;
  for (const object of result.objects)
    await env.EVIDENCE.put(object.key, Buffer.from(object.body, "base64"), {
      ...(object.sha256 === null ? {} : { sha256: object.sha256 }),
      ...(object.contentType === undefined
        ? {}
        : { httpMetadata: { contentType: object.contentType } }),
      ...(object.customMetadata === undefined ? {} : { customMetadata: object.customMetadata }),
    });
  const registration = { source: "sbi-vc-trade", runId: result.summary.runId };
  let registered = await registerCollectionRun(env, registration);
  // Yearly report indices exceed one production registration budget. Resume
  // its persisted progress as the ordinary shared-R2 scan does on later ticks.
  for (
    let continuation = 0;
    registered.outcome === "pending" && continuation < result.terminal.artifacts.length + 1;
    continuation += 1
  )
    registered = await registerCollectionRun(env, registration);
  expect(registered).toMatchObject({ outcome: "registered" });
  if (registered.outcome !== "registered") throw new Error("synthetic_registration_failed");
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM observation_fetch_artifacts WHERE fetch_run_id=?",
    )
      .bind(registered.fetchRunId)
      .first(),
  ).toEqual({ count: result.terminal.artifacts.length });
  return { ...result, fetchRunId: registered.fetchRunId };
}
async function publishedFor(run: number): Promise<string[]> {
  return (
    await env.DB.prepare(
      `SELECT p.parser_name FROM published_parse_runs x JOIN parse_runs p ON p.id=x.parse_run_id JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id JOIN observation_fetch_runs f ON f.id=a.fetch_run_id WHERE f.id=? ORDER BY p.parser_name`,
    )
      .bind(run)
      .all<{ parser_name: string }>()
  ).results.map((row) => row.parser_name);
}
async function readers() {
  const reader = createD1ObservationReader(env.DB);
  return {
    balances: await reader.listLatestBalances({
      source: "sbi-vc-trade",
      offset: 0,
      limit: PAGE_LIMIT,
    }),
    transactions: await reader.listTransactions({ source: "sbi-vc-trade", offset: 0 }),
  };
}

test("raw failures preserve fresh classic publications without rescuing a failed account or publishing unknown raw rows", async () => {
  const expected = [
    "sbi-vc-account-margin",
    "sbi-vc-cash-balances",
    "sbi-vc-cashflows",
    "sbi-vc-executions",
    "sbi-vc-executions",
    "sbi-vc-position-summary",
  ];
  const first = await capture("success", "synthetic-connection-a");
  expect(first.summary.status).toBe("success");
  expect(await sweep(env)).toMatchObject({ parsed: 6, error: 0 });
  expect(await publishedFor(first.fetchRunId)).toEqual(expected);
  const initial = await readers();
  expect(initial.balances.length).toBeGreaterThan(0);
  expect(initial.transactions.some((row) => row.parser.startsWith("sbi-vc-executions@"))).toBe(
    true,
  );
  expect(initial.transactions.some((row) => row.parser.startsWith("sbi-vc-cashflows@"))).toBe(true);

  const partial = await capture("raw-error", "synthetic-connection-a");
  expect(partial.summary.status).toBe("partial");
  expect(partial.terminal.coverageStatus).toBe("partial");
  expect(partial.terminal.units).toContainEqual({
    unitKey: "account",
    unitKind: "collection",
    artifactCount: 6,
    coverageStatus: "complete",
  });
  expect(partial.terminal.units).toContainEqual({
    unitKey: "full-cashflows",
    unitKind: "collection",
    artifactCount: 0,
    coverageStatus: "partial",
    safeErrorCode: "collector_http_503",
  });
  expect(await sweep(env)).toMatchObject({ parsed: 6, error: 0 });
  expect(await publishedFor(partial.fetchRunId)).toEqual(expected);
  const fresh = await readers();
  const freshIds = new Set(
    (
      await env.DB.prepare(
        `SELECT b.id FROM balance_observations b JOIN parse_runs p ON p.id=b.parse_run_id JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id JOIN observation_fetch_runs f ON f.id=a.fetch_run_id WHERE f.id=?`,
      )
        .bind(partial.fetchRunId)
        .all<{ id: number }>()
    ).results.map((row) => row.id),
  );
  expect(
    fresh.balances.some(
      (row) => row.parser.startsWith("sbi-vc-cash-balances@") && freshIds.has(row.id),
    ),
  ).toBe(true);
  expect(
    fresh.transactions.filter((row) => row.parser.startsWith("sbi-vc-executions@")),
  ).toHaveLength(
    initial.transactions.filter((row) => row.parser.startsWith("sbi-vc-executions@")).length,
  );
  expect(
    fresh.transactions.filter((row) => row.parser.startsWith("sbi-vc-cashflows@")),
  ).toHaveLength(
    initial.transactions.filter((row) => row.parser.startsWith("sbi-vc-cashflows@")).length,
  );

  // The same literal account unit in another acquisition session must not
  // borrow the successful report of connection A's partial run.
  const failed = await capture("classic-error", "synthetic-connection-b");
  expect(failed.summary.status).toBe("partial");
  expect(failed.terminal.acquisitionSessionRef).not.toBe(partial.terminal.acquisitionSessionRef);
  expect(failed.terminal.units).toHaveLength(1);
  expect(failed.terminal.units[0]?.coverageStatus).toBe("partial");
  expect(await sweep(env)).toMatchObject({ parsed: 0, error: 0 });
  expect(await publishedFor(failed.fetchRunId)).toEqual([]);
  expect(
    (
      await env.DB.prepare(
        `SELECT a.id FROM observation_fetch_artifacts a JOIN observation_fetch_runs f ON f.id=a.fetch_run_id WHERE f.id=? AND ${unitScopedEligibilitySql("f", "a")}`,
      )
        .bind(failed.fetchRunId)
        .all()
    ).results,
  ).toEqual([]);
  expect(await readers()).toEqual(fresh);

  const invalid = await capture("raw-invalid", "synthetic-connection-a");
  expect(invalid.terminal.units.find((unit) => unit.unitKey === "full-cashflows")).toMatchObject({
    coverageStatus: "partial",
    artifactCount: 1,
    safeErrorCode: "cashflows_all_recent_invalid_identity",
  });
  expect(await sweep(env)).toMatchObject({ parsed: 6, error: 0 });
  expect(await publishedFor(invalid.fetchRunId)).toEqual(expected);
  expect(
    (
      await env.DB.prepare(
        `SELECT p.id FROM parse_runs p JOIN fetch_artifacts a ON a.id=p.fetch_artifact_id WHERE a.artifact_key LIKE 'cashflows-all-%'`,
      ).all()
    ).results,
  ).toEqual([]);
  expect(
    (await readers()).transactions.some((row) => row.description === "UNKNOWN_SYNTHETIC_TYPE"),
  ).toBe(false);
}, 60_000);
