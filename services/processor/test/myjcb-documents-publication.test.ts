import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import {
  CORE_MIGRATIONS_URL,
  migrationFiles,
  migrationSql,
} from "../../../packages/storage-d1/src/migrations.ts";
import { applyTestSql } from "./migration-setup.ts";
import { collectCredit } from "../../collector-myjcb/src/credit.ts";
import { creditMenu } from "../../collector-myjcb/test/synthetic-myjcb.ts";
import { myJcbRunPlan } from "../../collector-myjcb/src/shared-collection.ts";
import { objectKey } from "../../../packages/collection/src/keys.ts";
import { persistRun } from "../../../packages/collection/src/writer.ts";
import { registerCollectionRun } from "../src/collection/index.ts";
import { parseJob } from "../src/worker.ts";
import { myJcbDocuments } from "../../../packages/parsers/src/parsers/myjcb-documents.ts";
import { myJcbCreditLedger } from "../../../packages/parsers/src/parsers/myjcb.ts";
import { creditExportBytes } from "../../../packages/parsers/test/myjcb-document-fixture.ts";
import { createD1ObservationReader } from "../../../packages/read-model/src/d1.ts";
import type { ReadResponse } from "../../collector-myjcb/src/client.ts";
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
}, 60_000);
afterAll(async () => {
  await mf?.dispose();
});
const response = (body: string | Uint8Array): ReadResponse => ({
  url: new URL("https://my.jcb.co.jp/"),
  status: 200,
  contentType: "text/html; charset=utf-8",
  body: (typeof body === "string" ? new TextEncoder().encode(body) : Uint8Array.from(body)).buffer,
});

test("original files persist once, register and read as evidence beside a healthy ledger on partial captures", async () => {
  const html = readFileSync(
    new URL("../../collector-myjcb/test/fixtures/credit-detail.html", import.meta.url),
    "utf8",
  ).replace("</h1>", "</h1><h2>2098年1月お支払い分のカードご利用明細</h2>");
  let pdfHash = "";
  for (let capture = 0; capture < 2; capture += 1) {
    const credit = await collectCredit(
      {
        get: async (operation) =>
          operation === "credit-menu"
            ? response(creditMenu([10]))
            : operation === "credit-detail"
              ? response(html)
              : operation === "credit-csv"
                ? response("<html>synthetic unavailable</html>")
                : response(creditExportBytes(operation === "credit-pdf" ? "pdf" : "ofx")),
        postCreditPastJson: async () =>
          response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: "030100601",
              result: { errId: "0", errMessage: "", detailPastJsonInfo: [] },
            }),
          ),
      },
      "synthetic",
      { exports: "fetch" },
    );
    expect(credit.stop).toBeUndefined();
    expect(credit.documentResults.filter((doc) => doc.code === "collected")).toHaveLength(2);
    const runId = `synthetic-myjcb-original-${capture}`;
    const plan = await myJcbRunPlan({
      schemaVersion: "synthetic-original-v1",
      runId,
      startedAt: `2098-02-0${capture + 1}T00:00:00Z`,
      completedAt: `2098-02-0${capture + 1}T00:01:00Z`,
      status: "partial",
      trigger: "manual",
      failures: [],
      connections: [
        {
          summary: {
            connectionId: "synthetic",
            bootstrapMode: "session",
            status: "success",
            cardCount: 1,
            periodCount: credit.periodCount,
            artifactCount: credit.artifacts.length,
            exportOffers: credit.exportOffers,
            documentResults: credit.documentResults,
          },
          artifacts: credit.artifacts,
        },
      ],
    });
    const pdf = plan.artifacts.find((artifact) => artifact.artifactKey.endsWith(".pdf"))!;
    if (capture === 0) pdfHash = pdf.sha256;
    expect(pdf.sha256).toBe(pdfHash);
    expect((await persistRun(env.EVIDENCE, plan)).outcome).toBe("persisted");
    const stored = await env.EVIDENCE.get(objectKey(pdfHash));
    expect(stored).not.toBeNull();
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(
      Uint8Array.from(creditExportBytes("pdf")),
    );
    const registration = await registerCollectionRun(env, { source: "myjcb", runId });
    expect(registration.outcome).toBe("registered");
    if (registration.outcome !== "registered") throw new Error("synthetic_registration_failed");
    const artifacts = (
      await env.DB.prepare(
        "SELECT id,dataset FROM fetch_artifacts WHERE fetch_run_id=? AND dataset IN ('credit-pdf','credit-ofx','credit-ledger') ORDER BY dataset",
      )
        .bind(registration.fetchRunId)
        .all<{ id: number; dataset: string }>()
    ).results;
    expect(artifacts).toHaveLength(3);
    for (const artifact of artifacts) {
      const parser = artifact.dataset === "credit-ledger" ? myJcbCreditLedger : myJcbDocuments;
      await env.DB.prepare(
        "INSERT INTO observation_parse_jobs(fetch_artifact_id,parser_name,parser_version,status) VALUES(?,?,?,'pending')",
      )
        .bind(artifact.id, parser.name, parser.version)
        .run();
      expect(
        await parseJob(
          env,
          {
            fetch_artifact_id: artifact.id,
            parser_name: parser.name,
            parser_version: parser.version,
            attempts: 0,
          },
          parser,
        ),
      ).toBe("parsed");
      if (artifact.dataset !== "credit-ledger") {
        const detail = await createD1ObservationReader(env.DB).getArtifact(artifact.id);
        expect(detail?.parseRuns).toHaveLength(1);
        expect(
          (
            await env.DB.prepare(
              "SELECT c.mode,c.completeness,c.unit_scope,c.unit_report_outcome FROM parse_coverage_claims c JOIN published_parse_runs x ON x.parse_run_id=c.parse_run_id JOIN parse_runs p ON p.id=x.parse_run_id WHERE p.fetch_artifact_id=?",
            )
              .bind(artifact.id)
              .all()
          ).results,
        ).toEqual([
          {
            mode: "evidence-only",
            completeness: "complete",
            unit_scope: "unit",
            unit_report_outcome: "success",
          },
        ]);
      }
    }
    expect((await registerCollectionRun(env, { source: "myjcb", runId })).outcome).toBe(
      "already_registered",
    );
  }
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM raw_objects WHERE sha256=?")
      .bind(pdfHash)
      .first(),
  ).toEqual({ n: 1 });
  expect(
    (await createD1ObservationReader(env.DB).listTransactions({ source: "myjcb", offset: 0 }))
      .length,
  ).toBe(1);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM transaction_observations t JOIN parse_runs p ON p.id=t.parse_run_id WHERE p.parser_name='myjcb-statement-document-metadata'",
    ).first(),
  ).toEqual({ n: 0 });
}, 60_000);
