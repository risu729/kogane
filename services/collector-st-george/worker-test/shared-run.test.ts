import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { expect, test } from "vitest";
import { readTerminal, type R2BucketLike } from "../../../packages/collection/src/index";
import { registerTerminal } from "../../../packages/application/src/collection/register-terminal";
import { directRegistrationPort } from "../../../packages/application/src/ingest/port";
import type { IngestEnv } from "../../../packages/application/src/ingest/contract";
import {
  stGeorgeBalances,
  stGeorgeTransactions,
} from "../../../packages/parsers/src/parsers/st-george";
import type { ArtifactMeta } from "../../../packages/parsers/src/types";
import { persistSharedRun } from "../src/shared-collection";
import { snapshot } from "../test/fixture";

interface TestBindings {
  DATA: R2Bucket;
  TEST_DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
  TEST_BOOTSTRAP: string;
}

test("real D1/R2 registration seals the terminal and its actual metadata feeds both St.George parsers", async () => {
  const testEnv = env as unknown as TestBindings;
  await applyD1Migrations(testEnv.TEST_DB, testEnv.TEST_MIGRATIONS);
  // The bootstrap consists of single-line statements; comments are never executed.
  for (const statement of testEnv.TEST_BOOTSTRAP.split(";")) {
    const sql = statement.replace(/^--.*$/gm, "").trim();
    if (sql) await testEnv.TEST_DB.prepare(sql).run();
  }
  const bucket = testEnv.DATA as unknown as R2BucketLike;
  const run = {
    runId: crypto.randomUUID(),
    attemptId: "attempt-worker-test",
    startedAt: "2026-09-12T07:59:00.000Z",
    completedAt: "2026-09-12T08:00:00.000Z",
    snapshot: snapshot(),
  };
  expect((await persistSharedRun(bucket, run)).outcome).toBe("persisted");
  const read = await readTerminal(bucket, "st-george", run.runId);
  if (read.outcome !== "found") throw new Error("terminal missing");
  const ingestEnv = { DB: testEnv.TEST_DB, EVIDENCE: testEnv.DATA } as unknown as IngestEnv;
  const registration = await registerTerminal({
    env: ingestEnv,
    bucket,
    clientId: "processor-shared-r2",
    port: directRegistrationPort(ingestEnv, "processor-shared-r2"),
    source: "st-george",
    runId: run.runId,
  });
  expect(registration).toMatchObject({ outcome: "registered", artifacts: 2 });
  if (registration.outcome !== "registered") throw new Error("registration incomplete");
  expect(
    await testEnv.TEST_DB.prepare(
      "SELECT count(*) AS count FROM fetch_run_seals WHERE fetch_run_id=?",
    )
      .bind(registration.fetchRunId)
      .first("count"),
  ).toBe(1);
  const capture = read.manifest.artifacts.find(
    (artifact) => artifact.artifactKey === "account-snapshot.json",
  )!;
  const row = await testEnv.TEST_DB.prepare(`
    SELECT a.id,a.source_id,a.dataset,a.artifact_key,a.mime,a.fetched_at,a.sha256,
      r.status AS run_status,r.failure_count AS run_failure_count
    FROM observation_fetch_artifacts a
    JOIN observation_fetch_runs r ON r.id=a.fetch_run_id
    WHERE a.fetch_run_id=? AND a.artifact_key=?
  `)
    .bind(registration.fetchRunId, capture.artifactKey)
    .first<{
      id: number;
      source_id: string;
      dataset: string | null;
      artifact_key: string;
      mime: string;
      fetched_at: string;
      sha256: string;
      run_status: ArtifactMeta["runStatus"];
      run_failure_count: number;
    }>();
  expect(row).toMatchObject({
    dataset: "account-snapshot",
    run_status: "success",
    run_failure_count: 0,
  });
  if (!row) throw new Error("artifact unavailable to observations");
  const metadata: ArtifactMeta = {
    id: row.id,
    sourceId: row.source_id,
    runStatus: row.run_status,
    runFailureCount: row.run_failure_count,
    dataset: row.dataset,
    artifactKey: row.artifact_key,
    mime: row.mime,
    fetchedAt: row.fetched_at,
    sha256: row.sha256,
    url: null,
  };
  const bytes = new Uint8Array(
    await (await testEnv.DATA.get(capture.storageRef.key))!.arrayBuffer(),
  );
  expect(stGeorgeBalances.parse(bytes, metadata).observations).toHaveLength(2);
  expect(stGeorgeTransactions.parse(bytes, metadata).observations).toHaveLength(1);
  expect(read.manifest.coverageStatus).toBe("partial");
  expect((await persistSharedRun(bucket, run)).outcome).toBe("already_persisted");
});
