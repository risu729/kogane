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
import { createD1ObservationReader, d1Executor } from "../../../packages/read-model/src/d1.ts";
import {
  DATED_STATEMENTS_SQL,
  type DatedStatementRow,
} from "../../../packages/read-model/src/dated-state.ts";
import { summarizeHolding } from "../../../packages/domain/src/rewards.ts";
import {
  syntheticJPointHistory,
  syntheticJPointHistoryHtml,
} from "../../../packages/parsers/test/myjcb-jpoint-history-fixture.ts";
import type { JPointHistory } from "../../../packages/domain/src/myjcb-jpoint-history.ts";
import { collectJPointHistory } from "../../collector-myjcb/src/jpoint-history.ts";
import { collectCredit } from "../../collector-myjcb/src/credit.ts";
import { creditMenu } from "../../collector-myjcb/test/synthetic-myjcb.ts";
import type { ReadResponse } from "../../collector-myjcb/src/client.ts";
import type { SharedConnectionRun } from "../../collector-myjcb/src/shared-collection.ts";
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
  const periodMeasures = await createD1ObservationReader(env.DB).listLatestBalances({
    source: "myjcb",
    measureView: "summaries",
    offset: 0,
    limit: 501,
  });
  expect(periodMeasures).toHaveLength(9);
  expect([...new Set(periodMeasures.map((row) => row.metric))].sort()).toEqual([
    "jpoint_acquisition_earned",
    "jpoint_acquisition_expired",
    "jpoint_acquisition_used",
  ]);
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

const readResponse = (body: string, contentType = "text/html; charset=utf-8"): ReadResponse => ({
  url: new URL("https://my.jcb.co.jp/"),
  status: 200,
  contentType,
  body: new TextEncoder().encode(body).buffer,
});
async function collectedCredit(
  connectionId: string,
  mode: "success" | "stopped" | "malformed" = "success",
): Promise<SharedConnectionRun> {
  const page = `<!doctype html><html><body><h1>MyJCB</h1><h1>カードご利用代金明細(確定分)</h1>
    <h2>2026年10月お支払い分のカードご利用明細</h2><dl><dt>2026年10月10日(土)お支払い金額合計</dt><dd>1,000円</dd></dl>
    <input name="generalJsonShikibetuId" value="synthetic-discriminator">
    <div class="detail-list-01"><div class="head">ご利用日 ご利用先など 支払区分 今回のお支払い金額</div>
    <div class="content"><div class="item-cell"><div class="cell">2026/09/01</div><div class="cell">架空店舗</div><div class="cell">一回払い</div><div class="cell">1,000円</div></div>
    <div class="item-more"><ul class="list"><li><span>ご利用金額</span><span>1,000円</span></li><li><span>今回回数</span><span>1</span></li></ul></div></div></div></body></html>`;
  const result = await collectCredit(
    {
      get: async (operation, query) => {
        if (operation === "credit-menu")
          return readResponse(creditMenu(mode === "stopped" ? [1, 2] : [1]));
        if (operation !== "credit-detail") throw new Error("synthetic_unexpected_route");
        if (query?.get("detailMonth") === "2") throw new Error("synthetic_read_failure");
        return readResponse(mode === "malformed" ? page.replace("(確定分)", "") : page);
      },
      postCreditPastJson: async () =>
        readResponse(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "030100601",
            result: { errId: "0", errMessage: "", detailPastJsonInfo: [] },
          }),
          "application/json",
        ),
    },
    "myj_main_detailMenu",
  );
  expect(result.artifacts.some((a) => a.dataset === "credit-ledger")).toBe(mode !== "malformed");
  expect(result.stop === undefined && result.unreadMonths.length === 0).toBe(mode === "success");
  return {
    summary: {
      connectionId,
      bootstrapMode: "session",
      status: mode === "success" ? "success" : "partial",
      cardCount: 1,
      periodCount: result.periodCount,
      artifactCount: result.artifacts.length,
      unreadMonths: result.unreadMonths,
      ...(result.stop ? { stopCode: result.stop.code } : {}),
    },
    artifacts: result.artifacts,
  };
}
async function persistCredit(
  index: number,
  connections: readonly SharedConnectionRun[],
  status: "success" | "partial",
) {
  const runId = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  const at = `2026-10-0${index}T00:01:00.000Z`;
  const plan = await myJcbRunPlan({
    schemaVersion: "myjcb-worker-poc-v1",
    runId,
    startedAt: at,
    completedAt: at,
    status,
    trigger: "scheduled",
    failures: [],
    connections,
  });
  expect((await persistRun(env.EVIDENCE, plan)).outcome).toBe("persisted");
  expect(await registerCollectionRun(env, { source: "myjcb", runId })).toMatchObject({
    outcome: "registered",
  });
  expect(await sweep(env)).toMatchObject({ error: 0 });
  await identitySweep(env.DB, resolveIdentity, 40);
  return runId;
}
async function publishedCreditConnections() {
  const transactions = await createD1ObservationReader(env.DB).listTransactions({
    source: "myjcb",
    offset: 0,
  });
  const statements = await d1Executor(env.DB).all<DatedStatementRow>(DATED_STATEMENTS_SQL, [
    "2026-11-01T00:00:00.000Z",
    "2026-10-01",
    "2026-10-01T00:00:00.000Z",
  ]);
  return {
    transactions: transactions.map((r) => r.source_account).sort(),
    statements: statements.map((r) => r.source_account).sort(),
  };
}
test("a failed history remains visible without hiding complete credit, while failed or malformed connections publish nothing", async () => {
  const credit = await collectedCredit("credit-a");
  const point: RawArtifact = {
    dataset: "jpoint-balance",
    filename: "jpoint-balance.json",
    mediaType: "application/json",
    body: readFileSync(
      new URL(
        "../../../tests/fixtures/observation-pipeline/myjcb-jpoint/jpoint-balance.json",
        import.meta.url,
      ),
      "utf8",
    ),
  };
  const history = await collectJPointHistory(
    {
      get: async (operation) =>
        readResponse(
          operation === "jpoint-inquiry"
            ? '<!doctype html><html><body><a href="/iss-pc/member/point/pointHistoryInquiry.html">履歴</a></body></html>'
            : "<!doctype html><html><body>unavailable</body></html>",
        ),
    },
    '<p class="user-stage"><span class="txt">JCBカードW</span></p>',
    [point],
  );
  expect(history.code).toBe("unavailable");
  const combined = [...credit.artifacts, point, ...history.artifacts];
  const firstRun = await persistCredit(
    4,
    [
      {
        summary: {
          ...credit.summary,
          artifactCount: combined.length,
          jpointCode: "collected",
          jpointHistoryCode: history.code,
        },
        artifacts: combined,
      },
    ],
    "success",
  );
  expect(
    await env.DB.prepare("SELECT status FROM observation_fetch_runs WHERE external_run_id=?")
      .bind(firstRun)
      .first(),
  ).toEqual({ status: "partial" });
  expect(
    await env.DB.prepare(
      "SELECT r.normalized_outcome,r.safe_failure_code FROM fetch_unit_reports r JOIN fetch_units u ON u.id=r.fetch_unit_id JOIN observation_fetch_runs f ON f.id=u.fetch_run_id WHERE f.external_run_id=? AND u.unit_key='credit-a:j-point-history'",
    )
      .bind(firstRun)
      .first(),
  ).toEqual({ normalized_outcome: "failed", safe_failure_code: "jpoint_history_unavailable" });
  expect(await publishedCreditConnections()).toEqual({
    transactions: ["myjcb:credit-a:root"],
    statements: ["myjcb:credit-a:root"],
  });
  const good = await collectedCredit("credit-b");
  const stopped = await collectedCredit("credit-stopped", "stopped");
  const malformed = await collectedCredit("credit-malformed", "malformed");
  const failed = await collectedCredit("credit-failed");
  await persistCredit(
    5,
    [good, stopped, malformed, { ...failed, summary: { ...failed.summary, status: "failed" } }],
    "partial",
  );
  expect(await publishedCreditConnections()).toEqual({
    transactions: ["myjcb:credit-a:root", "myjcb:credit-b:root"],
    statements: ["myjcb:credit-a:root", "myjcb:credit-b:root"],
  });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM published_parse_runs p JOIN parse_runs r ON r.id=p.parse_run_id JOIN fetch_artifacts a ON a.id=r.fetch_artifact_id WHERE a.artifact_key LIKE 'credit-stopped/%' OR a.artifact_key LIKE 'credit-malformed/%' OR a.artifact_key LIKE 'credit-failed/%'",
    ).first(),
  ).toEqual({ n: 0 });
}, 60000);
