// An operator's decision on a survey proposal (ADR 0050), and what happens to
// the schedule after an acceptance: the rule is written by the maintenance
// writer, and the next run and the one run after the window are computed by
// the existing schedule code (ScheduleAlarm, `afterMaintenance`), not by the
// survey. Synthetic pages, synthetic collector stubs, no provider contact.
import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import type { Miniflare } from "miniflare";
import { nextNominal } from "../../../packages/collection/src/schedule-model.ts";
import { loadSurveyConfig } from "../src/maintenance-survey/config.ts";
import {
  ACCEPTED_REASON,
  decideSurveyProposal,
  maintenanceSurveyView,
  proposalRef,
  proposedRuleId,
  type MaintenanceRevisionWriter,
  type RevisionWrite,
} from "../src/maintenance-survey/decisions.ts";
import { maintenanceSurveyLane } from "../src/maintenance-survey/lane.ts";
import { scheduleRoute } from "../src/schedule-store.ts";
import { startPipeline } from "./harness.ts";

const MIZUHO = "https://www.mizuhobank.co.jp/direct/time.html";
const CONFIG = loadSurveyConfig({
  targetsPerTick: 1,
  targets: [
    {
      id: "mizuho-bank",
      source: "mizuho-bank",
      url: MIZUHO,
      scope: "collection",
      timezone: "Asia/Tokyo",
      cadenceHours: 24,
      terms: "confirmed",
      cost: "confirmed",
      fetch: "enabled",
    },
  ],
});
const OPERATOR = "operator@example.test";

interface Storage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  getAlarm(): Promise<number | null>;
  setAlarm(value: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}
interface State {
  storage: Storage;
  blockConcurrencyWhile<T>(action: () => Promise<T>): Promise<T>;
}
interface Alarm {
  alarm(): Promise<void>;
  reconcile(id: string): Promise<string | null>;
  alarmTime(): Promise<string | null>;
}

let mf: Miniflare, base: Env, AlarmClass: new (state: State, env: Env) => Alarm;
beforeAll(async () => {
  ({ mf, env: base } = await startPipeline());
  // The production alarm, bundled unchanged; only the platform base class is replaced.
  const bundle = await Bun.build({
    entrypoints: [new URL("../src/schedule-alarm.ts", import.meta.url).pathname],
    target: "bun",
    format: "esm",
    plugins: [
      {
        name: "review-durable-base",
        setup(build) {
          build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "base",
            namespace: "review",
          }));
          build.onLoad({ filter: /.*/, namespace: "review" }, () => ({
            contents:
              "export class DurableObject { constructor(ctx,env) { this.ctx=ctx; this.env=env; } }",
            loader: "js",
          }));
        },
      },
    ],
  });
  if (!bundle.success) throw new Error("review_alarm_bundle_failed");
  const module = (await import(
    `data:text/javascript;base64,${Buffer.from(await bundle.outputs[0]!.text()).toString("base64")}`
  )) as { ScheduleAlarm: new (state: State, env: Env) => Alarm };
  AlarmClass = module.ScheduleAlarm;
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});
let clock: ReturnType<typeof spyOn> | undefined;
afterEach(() => {
  clock?.mockRestore();
  clock = undefined;
});

function state(job: string): State {
  const values = new Map<string, unknown>([["job", job]]);
  let alarm: number | null = null;
  return {
    storage: {
      async get<T>(key: string) {
        return values.get(key) as T | undefined;
      },
      async put(key: string, value: unknown) {
        values.set(key, value);
      },
      async getAlarm() {
        return alarm;
      },
      async setAlarm(value: number) {
        alarm = value;
      },
      async deleteAlarm() {
        alarm = null;
      },
    },
    async blockConcurrencyWhile<T>(action: () => Promise<T>) {
      return action();
    },
  };
}

/** The Processor env with real alarm objects per job and a counting synthetic collector. */
function world() {
  const states = new Map<string, State>();
  const dispatched: { cron: string; nominal: number }[] = [];
  const env = {
    ...base,
    SCHEDULES_ENABLED: "true",
    MAINTENANCE_SURVEY_ENABLED: "true",
    SCHEDULE_MIZUHO: {
      async runScheduled(cron: string, nominal: number) {
        dispatched.push({ cron, nominal });
        return { status: "completed", runIds: [], failureCode: null };
      },
    },
  } as unknown as Env & Record<string, unknown>;
  const alarm = (id: string) => {
    if (!states.has(id)) states.set(id, state(id));
    return new AlarmClass(states.get(id)!, env);
  };
  (env as Record<string, unknown>)["SCHEDULE_ALARMS"] = { getByName: (id: string) => alarm(id) };
  return { env, alarm, dispatched, states };
}

const page = (line: string) => () =>
  new Response(`<html><body><p>${line}</p></body></html>`, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
/** A dated window in Japan time, as a notice would write it. */
function jst(ms: number): string {
  const d = new Date(ms + 9 * 3_600_000);
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}
async function survey(env: Env, line: string, now: number) {
  await env.DB.prepare("DELETE FROM maintenance_survey_cursors").run();
  return maintenanceSurveyLane(env, {
    config: CONFIG,
    now: () => now,
    transport: async (url) => {
      expect(url).toBe(MIZUHO);
      return page(line)();
    },
  });
}
async function newestProposal(env: Env) {
  return env.DB.prepare(
    "SELECT * FROM maintenance_survey_proposals ORDER BY id DESC LIMIT 1",
  ).first<{ id: number; rule_id: string | null; base_revision: number; kind: string }>();
}
function decide(env: Env, id: number, decision: string, headers: Record<string, string> = {}) {
  return scheduleRoute(
    new Request(`https://pipeline.internal/internal/schedules/proposals/${id}`, {
      method: "POST",
      headers: {
        "x-kogane-internal-caller": "kogane-evidence-browser",
        "x-kogane-operator": OPERATOR,
        ...headers,
      },
      body: JSON.stringify({ decision }),
    }),
    env,
    new URL(`https://pipeline.internal/internal/schedules/proposals/${id}`),
  ) as Promise<Response>;
}

test("an accepted window defers the next run through the alarm code, which then runs once after it", async () => {
  const { env, alarm, dispatched } = world();
  const now = Date.now();
  // The next nominal 06:25 occurrence at least a day ahead, as the schedule code computes it.
  const nominal = nextNominal(
    { kind: "daily", time: "06:25", weekdays: [0, 1, 2, 3, 4, 5, 6] },
    "Asia/Tokyo",
    now + 86_400_000,
  );
  await env.DB.prepare(
    "UPDATE collection_schedules SET enabled=1,next_nominal_at=?,next_run_at=? WHERE id='mizuho-bank'",
  )
    .bind(new Date(nominal).toISOString(), new Date(nominal).toISOString())
    .run();
  // Keep the seeded weekly rule out of this occurrence's way.
  await env.DB.prepare(
    "INSERT INTO provider_maintenance_rules(id,revision,source,timezone,pattern_json,enabled,reference_url,verified_at,scope,actor,created_at) SELECT id,revision+1,source,timezone,pattern_json,0,reference_url,verified_at,scope,'synthetic',created_at FROM provider_maintenance_rules WHERE id='mizuho-weekly' AND revision=1",
  ).run();
  const from = nominal - 30 * 60_000,
    to = nominal + 2 * 3_600_000;
  const result = await survey(env, `${jst(from)}～${jst(to)} システムメンテナンス`, now);
  expect(result).toMatchObject({ extracted: 1, proposed: 1 });
  // Proposing changed nothing: same due time, no alarm reserved or moved.
  const untouched = await env.DB.prepare(
    "SELECT next_nominal_at,next_run_at FROM collection_schedules WHERE id='mizuho-bank'",
  ).first<Record<string, unknown>>();
  expect(untouched).toEqual({
    next_nominal_at: new Date(nominal).toISOString(),
    next_run_at: new Date(nominal).toISOString(),
  });
  expect(await alarm("mizuho-bank").alarmTime()).toBeNull();

  const proposal = (await newestProposal(env))!;
  expect(proposal).toMatchObject({ kind: "new", rule_id: null, base_revision: 0 });
  const response = await decide(env, proposal.id, "accept");
  expect(response.status).toBe(200);
  const ruleId = proposedRuleId("mizuho-bank", proposal.id);
  expect((await response.json()) as unknown).toEqual({
    decided: "accepted",
    ruleId,
    revision: 1,
    reservation: "armed",
  });
  // The writer's revision: the page and fetch time as provenance, the operator as actor.
  expect(
    await env.DB.prepare(
      "SELECT revision,source,pattern_json,enabled,reference_url,verified_at,scope,actor FROM provider_maintenance_rules WHERE id=?",
    )
      .bind(ruleId)
      .first<Record<string, unknown>>(),
  ).toEqual({
    revision: 1,
    source: "mizuho-bank",
    pattern_json: JSON.stringify({
      kind: "once",
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
    }),
    enabled: 1,
    reference_url: MIZUHO,
    verified_at: new Date(now).toISOString(),
    scope: "collection",
    actor: OPERATOR,
  });
  expect(
    await env.DB.prepare(
      "SELECT decision,actor,rule_id,rule_revision FROM maintenance_survey_decisions WHERE proposal_id=?",
    )
      .bind(proposal.id)
      .first<Record<string, unknown>>(),
  ).toEqual({ decision: "accepted", actor: OPERATOR, rule_id: ruleId, rule_revision: 1 });
  // The existing alarm code moved the due time to the window's end and kept
  // the nominal occurrence it belongs to.
  expect(
    await env.DB.prepare(
      "SELECT next_nominal_at,next_run_at FROM collection_schedules WHERE id='mizuho-bank'",
    ).first<Record<string, unknown>>(),
  ).toEqual({
    next_nominal_at: new Date(nominal).toISOString(),
    next_run_at: new Date(to).toISOString(),
  });
  expect(await alarm("mizuho-bank").alarmTime()).toBe(new Date(to).toISOString());

  // At the window's end the alarm runs the deferred occurrence once, then moves on.
  clock = spyOn(Date, "now").mockReturnValue(to + 1000);
  await alarm("mizuho-bank").alarm();
  await alarm("mizuho-bank").alarm();
  expect(dispatched).toEqual([{ cron: "25 21 * * *", nominal }]);
  const after = await env.DB.prepare(
    "SELECT next_nominal_at FROM collection_schedules WHERE id='mizuho-bank'",
  ).first<string>("next_nominal_at");
  expect(Date.parse(after!)).toBeGreaterThan(to);
  expect(
    await env.DB.prepare(
      "SELECT status FROM collection_schedule_occurrences WHERE schedule_id='mizuho-bank' AND nominal_at=?",
    )
      .bind(new Date(nominal).toISOString())
      .first<string>("status"),
  ).toBe("completed");
  // Decided proposals no longer ask for attention.
  const view = await maintenanceSurveyView(env, Date.now(), CONFIG);
  expect(view.proposals.some((p) => p.id === proposal.id)).toBe(false);
}, 60000);

test("a rejection changes no rule, is final, and the same reading is not proposed again", async () => {
  const { env } = world();
  const now = Date.parse("2026-10-08T00:00:00.000Z");
  const before = await env.DB.prepare(
    "SELECT count(*) AS n FROM provider_maintenance_rules",
  ).first<number>("n");
  await survey(env, "毎週水曜日 2:00～3:00", now);
  const proposal = (await newestProposal(env))!;
  const rejected = await decide(env, proposal.id, "reject");
  expect(rejected.status).toBe(200);
  expect((await rejected.json()) as unknown).toEqual({ decided: "rejected" });
  expect(
    await env.DB.prepare("SELECT count(*) AS n FROM provider_maintenance_rules").first<number>("n"),
  ).toBe(before);
  const again = await decide(env, proposal.id, "accept");
  expect(again.status).toBe(409);
  expect((await again.json()) as unknown).toEqual({ error: "proposal_already_decided" });
  expect(await survey(env, "毎週水曜日 2:00～3:00", now + 86_400_000)).toMatchObject({
    proposed: 0,
    known: 1,
  });
  expect(
    await env.DB.prepare("SELECT count(*) AS n FROM provider_maintenance_rules").first<number>("n"),
  ).toBe(before);
}, 60000);

test("a proposal read against a rule revision that has moved cannot be accepted", async () => {
  const { env } = world();
  const now = Date.parse("2026-10-08T00:00:00.000Z");
  const revise = (enabled: number) =>
    env.DB.prepare(
      "INSERT INTO provider_maintenance_rules(id,revision,source,timezone,pattern_json,enabled,reference_url,verified_at,scope,actor,created_at) SELECT id,revision+1,source,timezone,pattern_json,?,reference_url,verified_at,scope,'synthetic',created_at FROM provider_maintenance_rules WHERE id='mizuho-weekly' AND revision=(SELECT max(revision) FROM provider_maintenance_rules WHERE id='mizuho-weekly')",
    )
      .bind(enabled)
      .run();
  // The seeded weekly rule, enabled (an earlier test of this file disabled it).
  await revise(1);
  await survey(env, "毎週土曜日 23:00～翌7:00", now);
  const proposal = (await newestProposal(env))!;
  expect(proposal).toMatchObject({ kind: "changed", rule_id: "mizuho-weekly" });
  // Someone revises the rule first.
  await revise(1);
  const view = await maintenanceSurveyView(env, now, CONFIG);
  expect(view.proposals.find((p) => p.id === proposal.id)?.current).toBe(false);
  const response = await decide(env, proposal.id, "accept");
  expect(response.status).toBe(409);
  expect((await response.json()) as unknown).toEqual({ error: "revision_conflict" });
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM maintenance_survey_decisions WHERE proposal_id=?",
    )
      .bind(proposal.id)
      .first<number>("n"),
  ).toBe(0);
  // It can still be rejected, which records the judgement and changes nothing.
  expect((await decide(env, proposal.id, "reject")).status).toBe(200);
}, 60000);

test("only an operator decides, with a closed body", async () => {
  const { env } = world();
  await survey(env, "毎週木曜日 2:00～3:00", Date.parse("2026-10-08T00:00:00.000Z"));
  const proposal = (await newestProposal(env))!;
  const anonymous = await scheduleRoute(
    new Request(`https://pipeline.internal/internal/schedules/proposals/${proposal.id}`, {
      method: "POST",
      headers: { "x-kogane-internal-caller": "kogane-evidence-browser" },
      body: JSON.stringify({ decision: "accept" }),
    }),
    env,
    new URL(`https://pipeline.internal/internal/schedules/proposals/${proposal.id}`),
  );
  expect(anonymous!.status).toBe(403);
  for (const [body, status, code] of [
    [{ decision: "approve" }, 400, "invalid_request"],
    [{ decision: "accept", pattern: { kind: "weekly" } }, 400, "invalid_request"],
  ] as const) {
    const response = await decideSurveyProposal(env, proposal.id, body, OPERATOR, async () => {
      throw new Error("the writer must not be reached");
    });
    expect([response.status, ((await response.json()) as { error: string }).error]).toEqual([
      status,
      code,
    ]);
  }
  const missing = await decide(env, 999_999, "accept");
  expect(missing.status).toBe(404);
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM maintenance_survey_decisions WHERE proposal_id=?",
    )
      .bind(proposal.id)
      .first<number>("n"),
  ).toBe(0);
}, 60000);

test("acceptance hands the maintenance writer exactly the #560 write, and its refusal stands", async () => {
  const { env } = world();
  const fetchedAt = Date.parse("2026-10-08T00:00:00.000Z");
  await survey(env, "毎週金曜日 2:00～3:00", fetchedAt);
  const proposal = (await newestProposal(env))!;
  const writes: RevisionWrite[] = [];
  const refusing: MaintenanceRevisionWriter = async (_env, write) => {
    writes.push(write);
    return { ok: false, code: "maintenance_deferral_too_long", status: 422 };
  };
  const refused = await decideSurveyProposal(
    env,
    proposal.id,
    { decision: "accept" },
    OPERATOR,
    refusing,
  );
  expect(refused.status).toBe(422);
  expect((await refused.json()) as unknown).toEqual({ error: "maintenance_deferral_too_long" });
  expect(writes).toEqual([
    {
      source: "mizuho-bank",
      ruleId: proposedRuleId("mizuho-bank", proposal.id),
      expectedRevision: 0,
      change: {
        timezone: "Asia/Tokyo",
        pattern: { kind: "weekly", weekdays: [5], start: "02:00", end: "03:00" },
        enabled: true,
        scope: "collection",
      },
      provenance: {
        referenceUrl: MIZUHO,
        verifiedAt: "2026-10-08T00:00:00.000Z",
        decisionRef: proposalRef(proposal.id),
      },
      actor: { kind: "operator", id: OPERATOR },
      reason: ACCEPTED_REASON,
    },
  ]);
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM maintenance_survey_decisions WHERE proposal_id=?",
    )
      .bind(proposal.id)
      .first<number>("n"),
  ).toBe(0);
  // A writer that saves records the acceptance with the revision it produced.
  const saving: MaintenanceRevisionWriter = async (_env, write) => ({
    ok: true,
    ruleId: write.ruleId,
    revision: 1,
    reconciled: false,
  });
  const accepted = await decideSurveyProposal(
    env,
    proposal.id,
    { decision: "accept" },
    OPERATOR,
    saving,
  );
  expect((await accepted.json()) as unknown).toEqual({
    decided: "accepted",
    ruleId: proposedRuleId("mizuho-bank", proposal.id),
    revision: 1,
    reservation: "pending",
  });
}, 60000);

test("an acceptance whose decision row fails leaves the revision once and the proposal not current", async () => {
  const { env } = world();
  const now = Date.parse("2026-10-08T00:00:00.000Z");
  // The Processor env whose acceptance row cannot be written; every other
  // statement, the writer's included, runs on the real database.
  const failingDecision = {
    ...env,
    DB: new Proxy(env.DB, {
      get(target, key) {
        if (key !== "prepare") {
          const value = Reflect.get(target, key, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (sql: string) =>
          /INSERT INTO maintenance_survey_decisions[\s\S]*'accepted'/u.test(sql)
            ? {
                bind: () => ({
                  run: () => Promise.reject(new Error("synthetic_d1_failure")),
                }),
              }
            : target.prepare(sql);
      },
    }),
  } as Env;
  const revisions = async (ruleId: string) =>
    (await env.DB.prepare("SELECT count(*) AS n FROM provider_maintenance_rules WHERE id=?")
      .bind(ruleId)
      .first<number>("n")) ?? 0;
  for (const line of ["毎週火曜日 2:00～3:00", "毎週土曜日 23:00～翌7:30"]) {
    await survey(env, line, now);
    const proposal = (await newestProposal(env))!;
    const ruleId = proposal.rule_id ?? proposedRuleId("mizuho-bank", proposal.id);
    const before = await revisions(ruleId);
    const failed = await decide(failingDecision, proposal.id, "accept");
    expect([failed.status, ((await failed.json()) as { error: string }).error]).toEqual([
      503,
      "decision_record_failed",
    ]);
    // The writer's revision stands, once, and no decision was recorded.
    expect(await revisions(ruleId)).toBe(before + 1);
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM maintenance_survey_decisions WHERE proposal_id=?",
      )
        .bind(proposal.id)
        .first<number>("n"),
    ).toBe(0);
    // The proposal reads as not current, new or changed alike.
    const view = await maintenanceSurveyView(env, now, CONFIG);
    expect(view.proposals.find((p) => p.id === proposal.id)?.current).toBe(false);
    // A retry cannot apply it a second time: the writer's version check refuses it.
    const retried = await decide(env, proposal.id, "accept");
    expect([retried.status, ((await retried.json()) as { error: string }).error]).toEqual([
      409,
      "revision_conflict",
    ]);
    expect(await revisions(ruleId)).toBe(before + 1);
    // It can still be rejected, which records the judgement only.
    expect((await decide(env, proposal.id, "reject")).status).toBe(200);
    expect(await revisions(ruleId)).toBe(before + 1);
  }
}, 60000);
