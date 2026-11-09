// Synthetic publication through the production collector plan, registration,
// parser registry, sweep and shared current-container selection policy.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import {
  CORE_MIGRATIONS_URL,
  migrationFiles,
  migrationSql,
} from "../../../packages/storage-d1/src/migrations";
import { persistSharedRun, sharedBucket } from "../../collector-sony-bank/src/shared-collection";
import type { RawArtifact } from "../../collector-sony-bank/src/types";
import { registerCollectionRun } from "../src/collection/index";
import { sweep } from "../src/worker";
import { applyTestSql, applyTestReadMigrations } from "./migration-setup";
import {
  activeStateProjection,
  completeSnapshotCandidates,
} from "../../../packages/read-model/src/concepts";
let mf: Miniflare;
let env: Env;
const template = JSON.parse(
  readFileSync(
    new URL(
      "../../../tests/fixtures/observation-pipeline/sony-bank-parser-boundaries/realised-gains.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default {};",
      compatibilityDate: "2026-09-07",
      d1Databases: ["DB", "READ"],
      r2Buckets: ["EVIDENCE", "DATA"],
    }),
  );
  const db = await mf.getD1Database("DB");
  const read = await mf.getD1Database("READ");
  for (const file of migrationFiles(CORE_MIGRATIONS_URL))
    await applyTestSql(db, migrationSql(CORE_MIGRATIONS_URL, file));
  await applyTestSql(
    db,
    readFileSync(new URL("../../../infra/bootstrap/ingest-clients.sql", import.meta.url), "utf8"),
  );
  await applyTestReadMigrations(read);
  env = {
    DB: db,
    READ: read,
    EVIDENCE: await mf.getR2Bucket("EVIDENCE"),
    DATA: await mf.getR2Bucket("DATA"),
    SHARED_R2_INGEST_ENABLED: "true",
    COLLECTION_INGEST_CLIENT: "processor-shared-r2",
  } as unknown as Env;
}, 60000);
afterAll(async () => {
  await mf?.dispose();
});
async function persist(runId: string, at: string, artifacts: RawArtifact[], partial = false) {
  const result = await persistSharedRun(sharedBucket(env.EVIDENCE), {
    schemaVersion: "sony-bank-worker-poc-v3",
    runId,
    startedAt: at,
    completedAt: at,
    status: partial ? "partial" : "success",
    window: { from: null, to: null },
    transactionCount: 0,
    artifacts,
    failures: partial
      ? [
          {
            operation: "documents",
            errorType: "SonyBankError",
            message: "collector_request_failed",
            diagnostics: { stage: "delivered-documents", reason: "document_retention_unconfirmed" },
          },
        ]
      : [],
  });
  expect(result.result.outcome).toBe("persisted");
  expect(await registerCollectionRun(env, { source: "sony-bank", runId })).toMatchObject({
    outcome: "registered",
  });
  return result;
}
function annualArtifacts(body: typeof template): RawArtifact[] {
  return [body.rliztnPrftLsCy, body.rliztnPrftLsLy].map((year) => ({
    dataset: "realised-gains",
    filename: `realised-gains-${year}.json`,
    mediaType: "application/json",
    body: JSON.stringify(body),
    unitKey: `realised-year-${year}`,
  }));
}
async function currentAnnual() {
  // These are the same production concepts used by current positions/balances,
  // rather than a test-owned ROW_NUMBER or a version-specific dedup rule.
  return (
    await env.DB.prepare(`WITH ${completeSnapshotCandidates.ctes}
    SELECT v.subject, v.metric, v.amount_minor FROM ${activeStateProjection.observationChain("valuation_observations", "v")}
    WHERE ${activeStateProjection.predicate} AND ${completeSnapshotCandidates.currentMember}
      AND p.parser_name='sony-bank-realised-gains' ORDER BY v.subject,v.metric`).all<{
      subject: string;
      metric: string;
      amount_minor: number;
    }>()
  ).results;
}
test("annual publication replaces overlapping revisions and retains older years after rollover", async () => {
  await persist("sony-realised-first", "2001-06-01T00:00:00.000Z", annualArtifacts(template));
  expect(await sweep(env)).toMatchObject({ parsed: 2, error: 0 });
  expect(await currentAnnual()).toHaveLength(4);
  const revised = {
    ...template,
    cyCcySepRliztnPrftLsFcplSi: [{ currencyCd: "USD", cyRliztnPrftLs: "-124", cyItrAmt: "9" }],
  };
  await persist("sony-realised-repeat", "2001-06-02T00:00:00.000Z", annualArtifacts(revised));
  expect(await sweep(env)).toMatchObject({ parsed: 2, error: 0 });
  expect(await currentAnnual()).toHaveLength(4);
  expect(
    (await currentAnnual()).find(
      (row) => row.subject.includes("2099") && row.metric === "annual_realised_fx_gain",
    )?.amount_minor,
  ).toBe(-124);
  const rollover = {
    ...template,
    rliztnPrftLsCy: "2100",
    rliztnPrftLsLy: "2099",
    cyCcySepRliztnPrftLsFcplSi: [{ currencyCd: "USD", cyRliztnPrftLs: "10", cyItrAmt: "2" }],
    lyCcySepRliztnPrftLsFcplSi: [{ currencyCd: "USD", lyRliztnPrftLs: "-125", lyItrAmt: "11" }],
  };
  await persist("sony-realised-rollover", "2002-01-02T00:00:00.000Z", annualArtifacts(rollover));
  expect(await sweep(env)).toMatchObject({ parsed: 2, error: 0 });
  const rows = await currentAnnual();
  expect(rows).toHaveLength(6);
  expect(
    rows.find((row) => row.subject.includes("2098") && row.metric === "annual_realised_fx_gain")
      ?.amount_minor,
  ).toBe(456);
  expect(
    rows.find((row) => row.subject.includes("2099") && row.metric === "annual_realised_fx_gain")
      ?.amount_minor,
  ).toBe(-125);
  expect(
    await env.DB.prepare("SELECT count(*) n FROM valuation_observations").first<number>("n"),
  ).toBe(12);
  expect(
    await env.DB.prepare("SELECT count(*) n FROM transaction_observations").first<number>("n"),
  ).toBe(0);
  expect(await sweep(env)).toMatchObject({ parsed: 0, error: 0 });
}, 60000);
test("delivered PDFs keep one DATA object across runs and changed bytes create an immutable revision", async () => {
  const pdf = (text: string): RawArtifact => ({
    dataset: "delivered-document-pdf",
    filename: "delivered-document-0001.pdf",
    unitKey: "delivered-document-0001",
    mediaType: "application/pdf",
    body: new TextEncoder().encode(text).buffer,
  });
  for (const [index, body] of [
    "%PDF-synthetic-one",
    "%PDF-synthetic-one",
    "%PDF-synthetic-two",
  ].entries()) {
    await persist(
      `sony-documents-${index}`,
      `2002-02-0${index + 1}T00:00:00.000Z`,
      [pdf(body)],
      true,
    );
    expect(await sweep(env)).toMatchObject({ parsed: 1, error: 0 });
    expect(
      await env.DB.prepare(
        "SELECT count(DISTINCT a.sha256) n FROM fetch_artifacts a WHERE a.artifact_key='delivered-document-0001.pdf'",
      ).first<number>("n"),
    ).toBe(index === 2 ? 2 : 1);
  }
  expect(
    await env.DB.prepare(
      "SELECT count(*) n FROM fetch_artifacts WHERE artifact_key='delivered-document-0001.pdf'",
    ).first<number>("n"),
  ).toBe(3);
  expect(await currentAnnual()).toHaveLength(6);
}, 60000);
