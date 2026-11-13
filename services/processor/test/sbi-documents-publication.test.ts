import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import {
  CORE_MIGRATIONS_URL,
  migrationFiles,
  migrationSql,
} from "../../../packages/storage-d1/src/migrations.ts";
import { applyTestSql } from "./migration-setup.ts";
import { persistSbiRun } from "../../collector-sbi-securities/src/shared-run.ts";
import { sbiDocumentFixture } from "../../../packages/parsers/test/sbi-documents-fixture.ts";
import { registerCollectionRun } from "../src/collection/index.ts";
import { parseJob } from "../src/worker.ts";
import { createD1ObservationReader } from "../../../packages/read-model/src/d1.ts";
import { sbiDocuments } from "../../../packages/parsers/src/parsers/sbi-documents.ts";
import { persistSbiAcquisition } from "../../collector-sbi-securities/src/acquisition.ts";
import { sbiForeignCashBalances } from "../../../packages/parsers/src/parsers/sbi-foreign-cash-balances.ts";
import type { SbiSharedRun } from "../../collector-sbi-securities/src/shared-run.ts";
import { terminalKey } from "../../../packages/collection/src/keys.ts";
import {
  scheduledFailure,
  scheduledResult,
} from "../../../packages/collection/src/schedule-result.ts";

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
  const DB = await mf.getD1Database("DB");
  for (const file of migrationFiles(CORE_MIGRATIONS_URL))
    await applyTestSql(DB, migrationSql(CORE_MIGRATIONS_URL, file));
  await applyTestSql(
    DB,
    readFileSync(new URL("../../../infra/bootstrap/ingest-clients.sql", import.meta.url), "utf8"),
  );
  env = {
    DB,
    EVIDENCE: await mf.getR2Bucket("EVIDENCE"),
    SHARED_R2_INGEST_ENABLED: "true",
    COLLECTION_INGEST_CLIENT: "processor-shared-r2",
  } as unknown as Env;
}, 60000);

test("separate mailbox terminals preserve healthy financial publication and never rescue a failed core", async () => {
  for (const rejectedCore of [false, true]) {
    const runId = `synthetic-separated-${rejectedCore ? "bad-core" : "good-core"}`;
    const base = {
      runId,
      producerVersion: "synthetic-mailbox-v1",
      attemptId: `attempt-${runId}`,
      acquisitionSessionRef: `session-${runId}`,
      startedAt: "2020-01-02T00:00:00Z",
      completedAt: "2020-01-02T00:01:00Z",
    };
    const core: SbiSharedRun = {
      ...base,
      scope: "foreign",
      status: rejectedCore ? "partial" : "success",
      artifacts: [
        {
          dataset: "foreign-cash-balances",
          mediaType: "application/json",
          body: {
            listForeignScheduleCashBalances: {
              foreignCashBalances: [
                {
                  currencyCashBalances: [
                    {
                      currencyCode: "USD",
                      foreignScheduleCashBalances: [
                        { businessDate: "2020-01-02", keepCash: "10.00" },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        },
      ],
      failures: rejectedCore
        ? [{ scope: "foreign", code: "sbi_foreign_history_page_invalid" }]
        : [],
    };
    const fixture = sbiDocumentFixture("d".repeat(64));
    const traced: string[] = [];
    const acquisition = await persistSbiAcquisition({
      bucket: env.EVIDENCE,
      core,
      signal: new AbortController().signal,
      onRunPersisted: (id) => traced.push(id),
      mailbox: async () => {
        expect(await env.EVIDENCE.head(terminalKey("sbi-securities", runId))).not.toBeNull();
        expect(traced).toEqual([runId]);
        return {
          ...base,
          runId: `${runId}-mailbox`,
          scope: "domestic",
          status: rejectedCore ? "success" : "failed",
          artifacts: rejectedCore
            ? [
                {
                  artifactKey: fixture.meta.artifactKey!,
                  dataset: "delivered-document-pdf",
                  mediaType: "application/pdf",
                  role: "provider_document",
                  unitKey: fixture.meta.fetchUnitKey!,
                  bytes: fixture.bytes,
                  body: null,
                },
              ]
            : [],
          failures: rejectedCore
            ? []
            : [{ scope: "mailbox", code: "sbi_mailbox_handoff_unobserved" }],
          mailboxUnits: rejectedCore
            ? [{ unitKey: fixture.meta.fetchUnitKey!, coverageStatus: "complete" }]
            : [
                {
                  unitKey: "mailbox-index",
                  coverageStatus: "partial",
                  safeErrorCode: "sbi_mailbox_handoff_unobserved",
                },
              ],
        };
      },
    });
    expect(acquisition.runIds).toEqual([runId, `${runId}-mailbox`]);
    expect(traced).toEqual(acquisition.runIds);
    expect(
      scheduledResult({ runId, status: acquisition.status, runIds: acquisition.runIds }).runIds,
    ).toEqual(acquisition.runIds);
    if (
      (acquisition.core.outcome !== "persisted" &&
        acquisition.core.outcome !== "already_persisted") ||
      (acquisition.mailbox?.outcome !== "persisted" &&
        acquisition.mailbox?.outcome !== "already_persisted")
    )
      throw new Error("synthetic_persistence_failed");
    expect(acquisition.core.manifest.providerOutcome).toBe(rejectedCore ? "partial" : "success");
    expect(
      acquisition.core.manifest.artifacts.every(
        (artifact) => artifact.artifactKey === "foreign-cash-balances.json",
      ),
    ).toBe(true);
    expect(
      acquisition.mailbox.manifest.artifacts.every(
        (artifact) => artifact.role === "provider_document",
      ),
    ).toBe(true);
    expect(
      acquisition.mailbox.manifest.units.some(
        (unit) => unit.unitKey === "domestic" || unit.unitKey === "foreign",
      ),
    ).toBe(false);
    expect(acquisition.mailbox.manifest.requestedScope.unitKeys).toEqual(
      acquisition.mailbox.manifest.units.map((unit) => unit.unitKey),
    );
    expect(acquisition.mailbox.manifest.ranges).toEqual([]);
    expect(acquisition.mailbox.manifest.acquisitionSessionRef).toBe(
      acquisition.core.manifest.acquisitionSessionRef,
    );
    for (const id of acquisition.runIds) {
      const registration = await registerCollectionRun(env, {
        source: "sbi-securities",
        runId: id,
      });
      expect(registration).toMatchObject(
        id.endsWith("-mailbox") && !rejectedCore
          ? { outcome: "blocked", code: "provider_run_failed" }
          : { outcome: "registered" },
      );
    }
    const financial = await env.DB.prepare(
      "SELECT a.id FROM fetch_artifacts a JOIN fetch_runs r ON r.id=a.fetch_run_id WHERE r.source_run_key=? AND a.dataset='foreign-cash-balances'",
    )
      .bind(`${runId}:terminal-registration-v12`)
      .first<{ id: number }>();
    expect(financial).not.toBeNull();
    await env.DB.prepare(
      "INSERT INTO observation_parse_jobs(fetch_artifact_id,parser_name,parser_version,status) VALUES(?,?,?,'pending')",
    )
      .bind(financial!.id, sbiForeignCashBalances.name, sbiForeignCashBalances.version)
      .run();
    const outcome = await parseJob(
      env,
      {
        fetch_artifact_id: financial!.id,
        parser_name: sbiForeignCashBalances.name,
        parser_version: sbiForeignCashBalances.version,
        attempts: 0,
      },
      sbiForeignCashBalances,
    );
    expect(outcome).toBe(rejectedCore ? "error" : "parsed");
    const published = await env.DB.prepare(
      "SELECT count(*) AS n FROM published_parse_runs x JOIN parse_runs p ON p.id=x.parse_run_id WHERE p.fetch_artifact_id=?",
    )
      .bind(financial!.id)
      .first<{ n: number }>();
    expect(published?.n).toBe(rejectedCore ? 0 : 1);
    if (rejectedCore) {
      const document = await env.DB.prepare(
        "SELECT a.id FROM fetch_artifacts a JOIN fetch_runs r ON r.id=a.fetch_run_id WHERE r.source_run_key=? AND a.dataset='delivered-document-pdf'",
      )
        .bind(`${runId}-mailbox:terminal-registration-v12`)
        .first<{ id: number }>();
      expect(document).not.toBeNull();
      await env.DB.prepare(
        "INSERT INTO observation_parse_jobs(fetch_artifact_id,parser_name,parser_version,status) VALUES(?,?,?,'pending')",
      )
        .bind(document!.id, sbiDocuments.name, sbiDocuments.version)
        .run();
      expect(
        await parseJob(
          env,
          {
            fetch_artifact_id: document!.id,
            parser_name: sbiDocuments.name,
            parser_version: sbiDocuments.version,
            attempts: 0,
          },
          sbiDocuments,
        ),
      ).toBe("parsed");
    }
    expect(scheduledFailure(new Error("collection_lease_lost"), traced).runIds).toEqual(
      acquisition.runIds,
    );
  }
}, 60000);
afterAll(async () => {
  await mf?.dispose();
});

test("native SBI PDFs survive a failed sibling and register, publish and read as evidence only", async () => {
  const fixture = sbiDocumentFixture();
  const runId = "synthetic-sbi-document-publication";
  const result = await persistSbiRun(env.EVIDENCE, {
    runId,
    producerVersion: "synthetic-mailbox-v1",
    attemptId: "synthetic-attempt",
    startedAt: "2020-01-02T00:00:00Z",
    completedAt: "2020-01-02T00:01:00Z",
    status: "partial",
    scope: "domestic",
    artifacts: [
      {
        artifactKey: fixture.meta.artifactKey!,
        dataset: "delivered-document-pdf",
        mediaType: "application/pdf",
        role: "provider_document",
        unitKey: fixture.meta.fetchUnitKey!,
        bytes: fixture.bytes,
        body: null,
      },
    ],
    failures: [{ scope: "mailbox", code: "sbi_mailbox_document_unobserved" }],
    mailboxUnits: [
      { unitKey: fixture.meta.fetchUnitKey!, coverageStatus: "complete" },
      {
        unitKey: `mailbox-document-${"c".repeat(64)}`,
        coverageStatus: "partial",
        safeErrorCode: "sbi_mailbox_document_unobserved",
      },
    ],
  });
  expect(result.outcome).toBe("persisted");
  const registration = await registerCollectionRun(env, { source: "sbi-securities", runId });
  expect(registration.outcome).toBe("registered");
  if (registration.outcome !== "registered") throw new Error("synthetic_registration_failed");
  const artifacts = (
    await env.DB.prepare(
      "SELECT id FROM fetch_artifacts WHERE fetch_run_id=? AND dataset='delivered-document-pdf'",
    )
      .bind(registration.fetchRunId)
      .all<{ id: number }>()
  ).results;
  expect(artifacts).toHaveLength(1);
  const artifactId = artifacts[0]!.id;
  await env.DB.prepare(
    "INSERT INTO observation_parse_jobs(fetch_artifact_id,parser_name,parser_version,status) VALUES(?,?,?,'pending')",
  )
    .bind(artifactId, sbiDocuments.name, sbiDocuments.version)
    .run();
  expect(
    await parseJob(
      env,
      {
        fetch_artifact_id: artifactId,
        parser_name: sbiDocuments.name,
        parser_version: sbiDocuments.version,
        attempts: 0,
      },
      sbiDocuments,
    ),
  ).toBe("parsed");
  const reader = createD1ObservationReader(env.DB);
  const detail = await reader.getArtifact(artifacts[0]!.id);
  expect(detail?.artifact.mime).toBe("application/pdf");
  expect(detail?.parseRuns).toHaveLength(1);
  const claims = (
    await env.DB.prepare(
      "SELECT c.mode,c.completeness,c.unit_scope,c.unit_report_outcome FROM parse_coverage_claims c JOIN published_parse_runs x ON x.parse_run_id=c.parse_run_id JOIN parse_runs p ON p.id=x.parse_run_id WHERE p.fetch_artifact_id=?",
    )
      .bind(artifacts[0]!.id)
      .all()
  ).results;
  expect(claims).toEqual([
    {
      mode: "evidence-only",
      completeness: "complete",
      unit_scope: "unit",
      unit_report_outcome: "success",
    },
  ]);
  expect(await reader.listTransactions({ source: "sbi-securities", offset: 0 })).toEqual([]);
  const again = await registerCollectionRun(env, { source: "sbi-securities", runId });
  expect(again.outcome).toBe("already_registered");
  expect(
    (
      await env.DB.prepare(
        "SELECT count(*) AS n FROM observation_fetch_artifacts WHERE fetch_run_id=?",
      )
        .bind(registration.fetchRunId)
        .first<{ n: number }>()
    )?.n,
  ).toBe(1);
}, 60000);
