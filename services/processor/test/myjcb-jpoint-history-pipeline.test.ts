// Synthetic collector -> shared R2 -> registration -> publication -> promotion -> reader.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import {
  CORE_MIGRATIONS_URL,
  migrationFiles,
  migrationSql,
} from "../../../packages/storage-d1/src/migrations.ts";
import { persistRun } from "../../../packages/collection/src/writer.ts";
import { createRewardReader } from "../../../packages/read-model/src/rewards.ts";
import { d1Executor } from "../../../packages/read-model/src/d1.ts";
import { summarizeHolding } from "../../../packages/domain/src/rewards.ts";
import {
  syntheticJPointHistory,
  syntheticJPointHistoryHtml,
} from "../../../packages/parsers/test/myjcb-jpoint-history-fixture.ts";
import type { JPointHistory } from "../../../packages/domain/src/myjcb-jpoint-history.ts";
import { collectJPointHistory } from "../../collector-myjcb/src/jpoint-history.ts";
import { myJcbRunPlan } from "../../collector-myjcb/src/shared-collection.ts";
import { allowedUrl } from "../../collector-myjcb/src/policy.ts";
import type { RawArtifact } from "../../collector-myjcb/src/types.ts";
import { registerCollectionRun } from "../src/collection/index.ts";
import { sweep } from "../src/worker.ts";
import { promoteRewardClaims } from "../src/reward-claims-job.ts";
import { resolveIdentity } from "../../../packages/identity/src/index.ts";
import { identitySweep } from "../src/identity-store.ts";
import { captureRewardInput } from "../src/reward-read-projection.ts";
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
  const READ = await mf.getD1Database("READ");
  for (const file of migrationFiles(CORE_MIGRATIONS_URL))
    await applyTestSql(DB, migrationSql(CORE_MIGRATIONS_URL, file));
  await applyTestSql(
    DB,
    readFileSync(new URL("../../../infra/bootstrap/ingest-clients.sql", import.meta.url), "utf8"),
  );
  await applyTestReadMigrations(READ);
  const EVIDENCE = await mf.getR2Bucket("EVIDENCE");
  env = {
    DB,
    READ,
    EVIDENCE,
    DATA: EVIDENCE,
    SHARED_R2_INGEST_ENABLED: "true",
    COLLECTION_INGEST_CLIENT: "processor-shared-r2",
  } as unknown as Env;
}, 60000);
afterAll(async () => await mf?.dispose());

async function capture(index: number, total: string, history?: JPointHistory) {
  const balance = JSON.parse(
    readFileSync(
      new URL(
        "../../../tests/fixtures/observation-pipeline/myjcb-jpoint/jpoint-balance.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  balance.result.pointJsonInfo.totalPointInfo.point = total;
  balance.result.pointJsonInfo.normalPointInfo.point = total;
  balance.result.pointJsonInfo.specialPointInfo.point = "0";
  for (const section of ["totalPointInfo", "normalPointInfo", "specialPointInfo"])
    balance.result.pointJsonInfo[section].expirePoint = "0";
  const point: RawArtifact = {
    dataset: "jpoint-balance",
    filename: "jpoint-balance.json",
    mediaType: "application/json",
    body: JSON.stringify(balance),
  };
  const calls: string[] = [];
  const result = await collectJPointHistory(
    {
      get: async (operation) => {
        calls.push(operation);
        const body =
          operation === "jpoint-inquiry"
            ? '<!doctype html><html><body><a href="/iss-pc/member/point/pointHistoryInquiry.html">履歴</a></body></html>'
            : history
              ? syntheticJPointHistoryHtml(history)
              : "<!doctype html><html><body>unavailable</body></html>";
        return {
          url:
            operation === "jpoint-inquiry"
              ? allowedUrl(operation, new URLSearchParams({ link_id: "myj_main_pointInquiry" }))
              : allowedUrl(operation),
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: new TextEncoder().encode(body).buffer,
        };
      },
    },
    '<p class="user-stage"><span class="txt">JCBカードW</span></p>',
    [point],
  );
  expect(calls).toEqual(["jpoint-inquiry", "jpoint-history"]);
  expect(result.code).toBe(history ? "collected" : "unavailable");
  const runId = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  const at = `2026-10-0${index}T00:01:00.000Z`;
  const artifacts = [point, ...result.artifacts];
  const plan = await myJcbRunPlan({
    schemaVersion: "myjcb-worker-poc-v1",
    runId,
    startedAt: at,
    completedAt: at,
    status: "success",
    trigger: "scheduled",
    failures: [],
    connections: [
      {
        summary: {
          connectionId: "synthetic",
          bootstrapMode: "session",
          status: "success",
          cardCount: 1,
          periodCount: 0,
          artifactCount: artifacts.length,
          jpointCode: "collected",
          jpointHistoryCode: result.code,
        },
        artifacts,
      },
    ],
  });
  expect((await persistRun(env.EVIDENCE, plan)).outcome).toBe("persisted");
  expect(await registerCollectionRun(env, { source: "myjcb", runId })).toMatchObject({
    outcome: "registered",
  });
  expect(await sweep(env)).toMatchObject({ error: 0 });
  await identitySweep(env.DB, resolveIdentity, 40);
  await promoteRewardClaims(env.DB);
  expect((await promoteRewardClaims(env.DB)).promoted).toBe(0);
  return at;
}

test("real registration selects same-capture history once, falls back on a failed newer history and retires removed lots", async () => {
  const reader = createRewardReader(d1Executor(env.DB));
  const completeAt = await capture(1, "100", syntheticJPointHistory());
  const first = (await reader.holdings({ programId: "program:j-point", offset: 0 })).rows;
  expect(first).toHaveLength(1);
  expect(first[0]!.holding.buckets).toHaveLength(3);
  expect(summarizeHolding(first[0]!.holding).consumable.value).toMatchObject({
    status: "exact",
    value: { coefficient: "100" },
  });
  expect(first[0]!.pointHistoryCoverage?.state).toBe("current");
  const input = await captureRewardInput(env.DB, { now: () => "2026-10-02T00:00:00.000Z" });
  expect(input.ok).toBe(true);
  if (!input.ok) throw new Error("synthetic_reward_input_unavailable");
  expect(input.captured.input.content.buckets).toHaveLength(3);
  await capture(2, "200");
  const newer = (await reader.holdings({ programId: "program:j-point", offset: 0 })).rows[0]!;
  expect(newer.holding.buckets).toHaveLength(1);
  expect(newer.holding.buckets[0]!.quantity.value).toMatchObject({
    status: "exact",
    value: { coefficient: "200" },
  });
  expect(summarizeHolding(newer.holding).consumable.value.status).toBe("missing");
  expect(newer.pointHistoryCoverage).toMatchObject({
    state: "stale",
    observedAt: completeAt,
    reasonCode: "history_not_current",
  });
  const smaller = syntheticJPointHistory();
  smaller.rows = [smaller.rows[1]!];
  smaller.reportedTotal = "40";
  await capture(3, "40", smaller);
  const current = (await reader.holdings({ programId: "program:j-point", offset: 0 })).rows[0]!;
  expect(current.holding.buckets).toHaveLength(1);
  expect(summarizeHolding(current.holding).consumable.value).toMatchObject({
    status: "exact",
    value: { coefficient: "40" },
  });
  expect(current.pointHistoryCoverage?.state).toBe("current");
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM balance_observations WHERE metric='jpoint_acquisition_remaining'",
    ).first(),
  ).toEqual({ n: 4 });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM collection_runs WHERE registration_contract_version='terminal-registration-v10' AND registered_at IS NOT NULL",
    ).first(),
  ).toEqual({ n: 3 });
}, 60000);
