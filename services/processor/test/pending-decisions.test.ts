// What waits for the owner's decision (packages/application/src/query/
// pending-decisions.ts, ADR 0126) on the complete CORE schema under workerd's
// SQLite: the re-survey line counts exactly what the schedules page's survey
// read (`maintenanceSurveyView`) counts and lists, for every source and for a
// grant's sources; every line's query is planned by key or by one index range
// without table statistics; and the read writes nothing. Every value is
// synthetic.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Miniflare } from "miniflare";
import type { Grant } from "../../../packages/application/src/index.ts";
import {
  PENDING_CARD_OWNERSHIP_SQL,
  PENDING_CARD_SETTLEMENTS_SQL,
  PENDING_CHANGE_PLANS_SQL,
  PENDING_POSTED_LINKS_SQL,
  PENDING_SURVEY_PROPOSALS_SQL,
  readPendingDecisions,
} from "../../../packages/application/src/query/pending-decisions.ts";
import { d1Executor } from "../../../packages/read-model/src/d1.ts";
import { loadSurveyConfig } from "../src/maintenance-survey/config.ts";
import { maintenanceSurveyView } from "../src/maintenance-survey/decisions.ts";
import { startPipeline } from "./harness.ts";

let mf: Miniflare, env: Env, db: D1Database;
beforeAll(async () => {
  ({ mf, env } = await startPipeline());
  db = env.DB;
}, 60000);
afterAll(async () => {
  await mf?.dispose();
});

const WHOLE: Grant = {
  principal: "synthetic-owner",
  scopes: { sources: "*", accounts: "*", scheduleSources: "*" },
  capabilities: ["records.read", "schedules.read"],
  budget: { maxRows: 1000, maxProposalTargets: 1, maxExplainDepth: 6 },
};
const SERVED = { cardSettlements: true, cardPurchases: true, schedules: true, commands: true };
const CONFIG = loadSurveyConfig({ targetsPerTick: 1, targets: [] });
const digest = (n: number) => String(n).padStart(64, "0");

async function survey(id: number, source: string, decided: boolean) {
  await db.batch([
    db
      .prepare(`INSERT INTO maintenance_survey_fetches(id,target_id,source,url,fetched_at,outcome,sha256,object_key,extractor_version,windows)
        VALUES(?,'synthetic-target',?,'https://synthetic.invalid/notice','2098-01-01T00:00:00Z','extracted',?,?,'synthetic-v1',1)`)
      .bind(id, source, digest(id), `maintenance-survey/objects/00/${digest(id)}`),
    db
      .prepare(`INSERT INTO maintenance_survey_proposals(id,fetch_id,target_id,source,kind,rule_id,base_revision,timezone,pattern_json,enabled,scope,status,reasons_json,proposal_key,created_at)
        VALUES(?,?,'synthetic-target',?,'new',NULL,0,'Asia/Tokyo','{}',1,'collection','proposed','[]',?,?)`)
      .bind(id, id, source, digest(1000 + id), `2098-01-${String(id).padStart(2, "0")}T00:00:00Z`),
    ...(decided
      ? [
          db
            .prepare(
              "INSERT INTO maintenance_survey_decisions(proposal_id,decision,actor,decided_at) VALUES(?,'rejected','synthetic-owner','2098-02-01T00:00:00Z')",
            )
            .bind(id),
        ]
      : []),
  ]);
}

async function tableCounts(): Promise<Record<string, number>> {
  const names = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name",
    )
    .all<{ name: string }>();
  const counts: Record<string, number> = {};
  for (const { name } of names.results)
    counts[name] = (await db.prepare(`SELECT count(*) AS n FROM "${name}"`).first<number>("n"))!;
  return counts;
}

async function surveyLine(grant: Grant) {
  const outcome = await readPendingDecisions({
    grant,
    sql: d1Executor(db),
    served: SERVED,
    now: "2098-03-01T00:00:00.000Z",
  });
  if (!outcome.ok) throw new Error(outcome.error.code);
  return outcome.answer.kinds.find((line) => line.kind === "maintenance-survey.proposal")!;
}

test("the survey line is the survey read's count and list, for every source and for a grant's", async () => {
  // Absent: nothing waits.
  expect(await surveyLine(WHOLE)).toMatchObject({ count: 0, ids: [], oldestAt: null });
  for (const [id, source, decided] of [
    [1, "vpass", true],
    [2, "vpass", false],
    [3, "myjcb", false],
    [4, "mizuho-bank", false],
    [5, "vpass", true],
    [6, "myjcb", false],
  ] as const)
    await survey(id, source, decided);
  const before = await tableCounts();
  for (const sources of [undefined, ["myjcb"], ["vpass", "mizuho-bank"], []] as const) {
    const view = await maintenanceSurveyView(
      env,
      Date.parse("2098-03-01T00:00:00Z"),
      CONFIG,
      sources,
    );
    const line = await surveyLine({
      ...WHOLE,
      scopes: { ...WHOLE.scopes, scheduleSources: sources === undefined ? "*" : sources },
    });
    expect(line.count).toBe(view.attention);
    expect(line.ids).toEqual(view.proposals.slice(0, 5).map((proposal) => String(proposal.id)));
    expect(line.oldestAt).toBe(
      view.proposals.length === 0
        ? null
        : view.proposals.map((proposal) => proposal.createdAt).sort()[0]!,
    );
  }
  expect(await tableCounts()).toEqual(before);
});

test("every line's query reaches rows by key or by one index range, without table statistics", async () => {
  expect(
    await db
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'sqlite_stat%'")
      .first("n"),
  ).toBe(0);
  // Base tables a plan may scan whole: the candidates once (as the カード照合
  // statement page does) and the survey proposals (as the survey read does).
  const scannedTables =
    /^SCAN (card_settlement_decisions|entity_relations|decision_revisions|reconciliation_proposals|change_plans|maintenance_survey_decisions|n|r|d)\b/u;
  for (const [name, sql, binds] of [
    ["statements", PENDING_CARD_SETTLEMENTS_SQL, [5]],
    ["ownership", PENDING_CARD_OWNERSHIP_SQL, [5]],
    ["links", PENDING_POSTED_LINKS_SQL, [1001, 5]],
    ["survey", PENDING_SURVEY_PROPOSALS_SQL, [1001, 5, null]],
    ["plans", PENDING_CHANGE_PLANS_SQL, [1001, 5, "2098", "2098"]],
  ] as const) {
    const plan = (
      await db
        .prepare("EXPLAIN QUERY PLAN " + sql)
        .bind(...binds)
        .all<{ detail: string }>()
    ).results.map((row) => row.detail);
    expect({ name, scans: plan.filter((detail) => scannedTables.test(detail)) }).toEqual({
      name,
      scans: [],
    });
  }
});
