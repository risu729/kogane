// Synthetic transport drives the actual collector DO in a subprocess, then
// its native R2 bytes pass through production registration and ordinary reads.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import {
  CORE_MIGRATIONS_URL,
  migrationFiles,
  migrationSql,
} from "../../../packages/storage-d1/src/migrations.ts";
import type { TerminalManifest } from "../../../packages/collection/src/manifest.ts";
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
const documents = (run: Capture) =>
  run.terminal.artifacts.filter((artifact) => artifact.role === "provider_document");
async function capture(scenario: "valid" | "bad-zip", session: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      new URL("../../collector-sbi-vc-trade/test/document-capture-fixture.ts", import.meta.url)
        .pathname,
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
  if (exit !== 0) throw new Error(`synthetic document collector failed: ${stderr}`);
  const result = JSON.parse(stdout) as Capture;
  const documentKeys = new Set(documents(result).map((artifact) => artifact.storageRef.key));
  let newDocumentObjects = 0;
  for (const object of result.objects) {
    const previous = await env.EVIDENCE.head(object.key);
    if (previous !== null) {
      // Native content-addressed objects must retain their verified checksum.
      if (object.sha256 !== null)
        expect(Buffer.from(previous.checksums.sha256!).toString("hex")).toBe(object.sha256);
      continue;
    }
    if (documentKeys.has(object.key)) newDocumentObjects += 1;
    await env.EVIDENCE.put(object.key, Buffer.from(object.body, "base64"), {
      ...(object.sha256 === null ? {} : { sha256: object.sha256 }),
      ...(object.contentType === undefined
        ? {}
        : { httpMetadata: { contentType: object.contentType } }),
      ...(object.customMetadata === undefined ? {} : { customMetadata: object.customMetadata }),
    });
  }
  const registration = {
    source: "sbi-vc-trade",
    runId: result.summary.runId,
  };
  let registered = await registerCollectionRun(env, registration);
  // The yearly indexes exceed one production operation budget. Continue the
  // persisted registration just as the shared-R2 scan does on its next tick.
  for (
    let continuation = 0;
    registered.outcome === "pending" && continuation < result.terminal.artifacts.length + 1;
    continuation += 1
  )
    registered = await registerCollectionRun(env, registration);
  expect(registered).toMatchObject({ outcome: "registered" });
  if (registered.outcome !== "registered") throw new Error("synthetic_registration_failed");
  return { ...result, fetchRunId: registered.fetchRunId, newDocumentObjects };
}
async function publishedFor(run: number) {
  return (
    await env.DB.prepare(
      `SELECT p.parser_name FROM published_parse_runs x JOIN parse_runs p ON p.id=x.parse_run_id JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id WHERE a.fetch_run_id=? ORDER BY p.parser_name`,
    )
      .bind(run)
      .all<{ parser_name: string }>()
  ).results.map((row) => row.parser_name);
}
async function documentDetails(run: number) {
  const reader = createD1ObservationReader(env.DB);
  const ids = (
    await env.DB.prepare(
      `SELECT id FROM observation_fetch_artifacts WHERE fetch_run_id=? AND dataset IN ('monthly-report-pdf','pnl-data-zip') ORDER BY dataset`,
    )
      .bind(run)
      .all<{ id: number }>()
  ).results.map((row) => row.id);
  expect(ids).toHaveLength(2);
  const listedIds = new Set<number>();
  let before = Number.MAX_SAFE_INTEGER;
  for (;;) {
    const page = await reader.listArtifacts({ source: "sbi-vc-trade", before });
    for (const row of page) listedIds.add(row.id);
    if (page.length < PAGE_LIMIT) break;
    before = page.at(-1)!.id;
  }
  for (const id of ids) expect(listedIds.has(id)).toBe(true);
  return Promise.all(
    ids.map(async (id) => {
      const detail = await reader.getArtifact(id);
      if (!detail) throw new Error("ordinary_document_detail_missing");
      return detail;
    }),
  );
}
async function economicReaders() {
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
async function coverageFor(run: number) {
  return (
    await env.DB.prepare(
      `SELECT a.dataset,c.mode,c.completeness,c.membership_complete,c.observed_count,c.expected_count,c.unit_scope,c.unit_report_outcome,f.status AS parent_status FROM parse_coverage_claims c JOIN published_parse_runs x ON x.parse_run_id=c.parse_run_id JOIN parse_runs p ON p.id=x.parse_run_id JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id JOIN observation_fetch_runs f ON f.id=a.fetch_run_id WHERE f.id=? AND p.parser_name='sbi-vc-document-metadata' ORDER BY a.dataset`,
    )
      .bind(run)
      .all()
  ).results;
}
const classicParsers = [
  "sbi-vc-account-margin",
  "sbi-vc-cash-balances",
  "sbi-vc-cashflows",
  "sbi-vc-executions",
  "sbi-vc-executions",
  "sbi-vc-position-summary",
];
const completeCoverage = {
  mode: "evidence-only",
  completeness: "complete",
  membership_complete: 0,
  observed_count: 1,
  expected_count: 1,
  unit_scope: "unit",
  unit_report_outcome: "success",
  parent_status: "partial",
};

test("actual DO documents require their own policy and successful unit, remain evidence only, and reuse native bytes", async () => {
  // A parser alone must not admit documents from the intentionally partial run.
  await env.DB.prepare(
    `DELETE FROM dataset_snapshot_policies WHERE source_id='sbi-vc-trade' AND dataset IN ('monthly-report-pdf','pnl-data-zip') AND parser_name='sbi-vc-document-metadata'`,
  ).run();
  const first = await capture("valid", "synthetic-document-session-a");
  expect(first.summary.status).toBe("partial");
  expect(first.terminal.coverageStatus).toBe("partial");
  expect(first.terminal.units).toContainEqual({
    unitKey: "report-annual-index",
    unitKind: "collection",
    artifactCount: 1,
    coverageStatus: "complete",
  });
  expect(first.terminal.artifacts).toContainEqual(
    expect.objectContaining({
      artifactKey: "report-annual-list-page-0001.json",
      unitKey: "report-annual-index",
      role: "collector_derived",
    }),
  );
  expect(first.terminal.units).toContainEqual({
    unitKey: "full-cashflows",
    unitKind: "collection",
    artifactCount: 0,
    coverageStatus: "partial",
    safeErrorCode: "collector_http_503",
  });
  expect(first.terminal.units).toContainEqual({
    unitKey: "pnl-check-20260930",
    unitKind: "collection",
    artifactCount: 1,
    coverageStatus: "partial",
    safeErrorCode: "pnl_api_incomplete",
  });
  for (const unitKey of ["monthly-report-20260930", "pnl-data-20260930"])
    expect(first.terminal.units).toContainEqual({
      unitKey,
      unitKind: "collection",
      artifactCount: 1,
      coverageStatus: "complete",
    });
  expect(first.newDocumentObjects).toBe(2);
  const native = documents(first);
  expect(native).toHaveLength(2);
  for (const artifact of native) {
    expect(artifact.artifactKey).toMatch(
      new RegExp(`-20260930-${artifact.sha256}\\.(pdf|zip)$`, "u"),
    );
    const stored = await env.EVIDENCE.get(artifact.storageRef.key);
    // The shared content-addressed store uses octet-stream; the terminal and
    // CORE catalogue preserve each document's declared native media type.
    expect(stored?.httpMetadata?.contentType).toBe("application/octet-stream");
    const bytes = new Uint8Array(await stored!.arrayBuffer());
    expect(Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex")).toBe(
      artifact.sha256,
    );
    expect(
      Buffer.from(bytes.subarray(0, artifact.mediaType === "application/pdf" ? 5 : 4)).toString(
        "hex",
      ),
    ).toBe(artifact.mediaType === "application/pdf" ? "255044462d" : "504b0304");
  }
  expect(await sweep(env)).toMatchObject({ parsed: 6, error: 0 });
  expect(await publishedFor(first.fetchRunId)).toEqual(classicParsers);
  for (const detail of await documentDetails(first.fetchRunId))
    expect(detail.parseRuns).toEqual([]);
  expect(await coverageFor(first.fetchRunId)).toEqual([]);
  const initial = await economicReaders();
  expect(initial.balances.length).toBeGreaterThan(0);
  for (const parser of ["sbi-vc-executions@", "sbi-vc-cashflows@"])
    expect(initial.transactions.some((row) => row.parser.startsWith(parser))).toBe(true);

  await applyTestSql(
    env.DB,
    migrationSql(CORE_MIGRATIONS_URL, "0097_sbi_vc_document_unit_eligibility.sql"),
  );
  expect(
    (
      await env.DB.prepare(
        `SELECT dataset,policy_id,required_parser_version,unit_scope,snapshot_selection,replaces_previous_on_complete_empty FROM dataset_snapshot_policies WHERE source_id='sbi-vc-trade' AND parser_name='sbi-vc-document-metadata' ORDER BY dataset`,
      ).all()
    ).results,
  ).toEqual(
    ["monthly-report-pdf", "pnl-data-zip"].map((dataset) => ({
      dataset,
      policy_id: "coverage-v1",
      required_parser_version: "1.0.0",
      unit_scope: "unit",
      snapshot_selection: 0,
      replaces_previous_on_complete_empty: 0,
    })),
  );
  await env.DB.prepare("UPDATE observation_scan_state SET cursor=0").run();
  expect(await sweep(env)).toMatchObject({ parsed: 2, error: 0 });
  expect(await publishedFor(first.fetchRunId)).toEqual(
    [...classicParsers, "sbi-vc-document-metadata", "sbi-vc-document-metadata"].sort(),
  );
  expect(await coverageFor(first.fetchRunId)).toEqual([
    { dataset: "monthly-report-pdf", ...completeCoverage },
    { dataset: "pnl-data-zip", ...completeCoverage },
  ]);
  for (const detail of await documentDetails(first.fetchRunId)) {
    expect(detail.artifact).toMatchObject({
      fetch_run_id: first.fetchRunId,
      fetch_status: "partial",
      mime:
        detail.artifact.dataset === "monthly-report-pdf" ? "application/pdf" : "application/zip",
    });
    expect(detail.parseRuns).toHaveLength(1);
    expect(detail.parseRuns[0]).toMatchObject({
      parser_name: "sbi-vc-document-metadata",
      status: "ok",
      observations: [],
    });
  }
  expect(await economicReaders()).toEqual(initial);

  // The same literal unit key in another session cannot borrow the first
  // session's successful ZIP report, even though the raw archive is retained.
  const failed = await capture("bad-zip", "synthetic-document-session-b");
  expect(failed.terminal.acquisitionSessionRef).not.toBe(first.terminal.acquisitionSessionRef);
  expect(failed.terminal.units).toContainEqual({
    unitKey: "pnl-data-20260930",
    unitKind: "collection",
    artifactCount: 1,
    coverageStatus: "partial",
    safeErrorCode: "pnl_zip_invalid",
  });
  expect(failed.newDocumentObjects).toBe(1);
  expect(await sweep(env)).toMatchObject({ parsed: 7, error: 0 });
  expect(await publishedFor(failed.fetchRunId)).toEqual(
    [...classicParsers, "sbi-vc-document-metadata"].sort(),
  );
  expect(await coverageFor(failed.fetchRunId)).toEqual([
    { dataset: "monthly-report-pdf", ...completeCoverage },
  ]);
  for (const detail of await documentDetails(failed.fetchRunId))
    expect(detail.parseRuns).toHaveLength(detail.artifact.dataset === "monthly-report-pdf" ? 1 : 0);
  expect(
    await env.DB.prepare(
      `SELECT p.id FROM parse_runs p JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id WHERE a.fetch_run_id=? AND a.dataset='pnl-data-zip'`,
    )
      .bind(failed.fetchRunId)
      .all(),
  ).toMatchObject({ results: [] });

  const recapture = await capture("valid", "synthetic-document-session-c");
  expect(recapture.newDocumentObjects).toBe(0);
  expect(
    documents(recapture).map(({ artifactKey, storageRef, sha256 }) => ({
      artifactKey,
      storageRef,
      sha256,
    })),
  ).toEqual(
    native.map(({ artifactKey, storageRef, sha256 }) => ({ artifactKey, storageRef, sha256 })),
  );
  expect(await sweep(env)).toMatchObject({ parsed: 8, error: 0 });
  expect(await coverageFor(recapture.fetchRunId)).toEqual([
    { dataset: "monthly-report-pdf", ...completeCoverage },
    { dataset: "pnl-data-zip", ...completeCoverage },
  ]);
  for (const detail of await documentDetails(recapture.fetchRunId))
    expect(detail.parseRuns).toHaveLength(1);
  for (const table of [
    "transaction_observations",
    "balance_observations",
    "position_observations",
    "valuation_observations",
  ])
    expect(
      await env.DB.prepare(
        `SELECT count(*) AS n FROM ${table} o JOIN parse_runs p ON p.id=o.parse_run_id WHERE p.parser_name='sbi-vc-document-metadata'`,
      ).first<number>("n"),
    ).toBe(0);
  const final = await economicReaders();
  expect(final.transactions).toHaveLength(initial.transactions.length);
  expect(final.balances).toHaveLength(initial.balances.length);
  for (const parser of ["sbi-vc-executions@", "sbi-vc-cashflows@"])
    expect(final.transactions.filter((row) => row.parser.startsWith(parser))).toHaveLength(
      initial.transactions.filter((row) => row.parser.startsWith(parser)).length,
    );
}, 60_000);
