// `kogane.schedules.survey.decide` over real local D1: the App adapter, the
// private Processor route and the screen's own `decideSurveyProposal` with the
// unchanged maintenance writer. Proposals are inserted as the survey lane
// would store them; no page is fetched. Alarm RPC is synthetic. Every source
// page, principal and window is synthetic.
import { env as testEnv } from "cloudflare:test";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import {
  d1CommandStore,
  appendAnswerRecord,
  type DelegatedPrincipal,
} from "../../../packages/application/src/index";
import { callDelegatedSurveyTool } from "../src/delegated-survey-tools";
import { auditedTool } from "../src/audit";
import { delegatedSurveyRoute } from "../../processor/src/delegated-survey";
type AppEnv = Parameters<typeof callDelegatedSurveyTool>[1];
let native: Parameters<typeof delegatedSurveyRoute>[1], app: AppEnv;
let p: DelegatedPrincipal,
  relays = 0;
const DAY = 86_400_000;
const REFERENCE = "https://maintenance.synthetic.test/notices";
beforeAll(() => {
  vi.useRealTimers();
  native = {
    ...testEnv,
    SCHEDULES_ENABLED: "true",
    SCHEDULE_ALARMS: {
      getByName: () => ({ reconcile: async () => null, alarmTime: async () => null }),
    },
  } as unknown as typeof native;
  app = {
    ...native,
    PIPELINE: {
      fetch: async (request: Request) => {
        relays++;
        const response = await delegatedSurveyRoute(request, native, new URL(request.url));
        if (!response) throw Error("unexpected route");
        return response;
      },
    },
  } as unknown as AppEnv;
});
beforeEach(async () => {
  const subject = `survey-${crypto.randomUUID()}`;
  p = {
    kind: "delegated",
    id: `mcp-client:${subject}`,
    delegator: subject,
    capabilities: ["schedules.survey.decide"],
    scopes: { sources: [], accounts: [], scheduleSources: ["vpass"] },
    notAfter: new Date(Date.now() + 3_600_000).toISOString(),
    delegationRef: `dlg_${"c".repeat(64)}`,
    budget: { writesPerDay: 200 },
  };
  relays = 0;
  await native.DB.prepare("UPDATE provider_maintenance_references SET reference_url=?")
    .bind(REFERENCE)
    .run();
});

let sequence = 0;
/** One stored fetch and one undecided proposal, as the lane writes them. */
async function proposal(
  options: {
    source?: string;
    kind?: "new" | "changed" | "absent";
    ruleId?: string | null;
    baseRevision?: number;
    reasons?: string[];
    duration?: number;
    offset?: number;
    enabled?: boolean;
  } = {},
): Promise<number> {
  const source = options.source ?? "vpass";
  const kind = options.kind ?? "new";
  const reasons = options.reasons ?? [];
  // Windows three hours apart: a rule one test accepts never overlaps the next
  // test's proposal (a delegated acceptance beside an overlapping rule is the operator's).
  const from = Date.now() + DAY + ++sequence * 3 * 3_600_000 + (options.offset ?? 0);
  const pattern = {
    kind: "once",
    from: new Date(from).toISOString(),
    to: new Date(from + (options.duration ?? 2 * 3_600_000)).toISOString(),
  };
  const sha = crypto.randomUUID().replaceAll("-", "").padEnd(64, "0");
  const fetch = await native.DB.prepare(
    `INSERT INTO maintenance_survey_fetches(target_id,source,url,fetched_at,outcome,http_status,media_type,byte_size,sha256,object_key,extractor_version,windows)
     VALUES(?,?,?,?, 'extracted',200,'text/html',100,?,?, 'synthetic-1',1) RETURNING id`,
  )
    .bind(
      source,
      source,
      `${REFERENCE}/${source}`,
      new Date(Date.now() - 60_000).toISOString(),
      sha,
      `maintenance-survey/objects/${sha.slice(0, 2)}/${sha}`,
    )
    .first<number>("id");
  const id = await native.DB.prepare(
    `INSERT INTO maintenance_survey_proposals(fetch_id,target_id,source,kind,rule_id,base_revision,timezone,pattern_json,enabled,scope,status,reasons_json,proposal_key,created_at)
     VALUES(?,?,?,?,?,?, 'Asia/Tokyo',?,?, 'collection',?,?,?,?) RETURNING id`,
  )
    .bind(
      fetch,
      source,
      source,
      kind,
      options.ruleId ?? null,
      options.baseRevision ?? 0,
      JSON.stringify(pattern),
      kind === "absent" ? 0 : Number(options.enabled ?? true),
      reasons.length === 0 ? "proposed" : "review_pending",
      JSON.stringify(reasons),
      crypto.randomUUID().replaceAll("-", "").padEnd(64, "a"),
      new Date().toISOString(),
    )
    .first<number>("id");
  return id!;
}
type Answer = {
  decided?: string;
  ruleId?: string;
  revision?: number;
  replayed?: boolean;
  error?: string;
  confirmation?: { digest: string };
  preview?: Record<string, unknown>;
};
async function invoke(body: unknown, who = p) {
  const answer = await auditedTool(
    {
      path: "mcp",
      subject: who.delegator,
      principal: who.id,
      correlationId: crypto.randomUUID(),
      sink: { append: (row) => appendAnswerRecord(d1CommandStore(native.DB), row) },
      onWriteFailure: () => {},
    },
    "schedules.survey.decide",
    (audit) => callDelegatedSurveyTool(body, app, { ok: true, principal: who }, audit),
  );
  if (!answer) throw Error("missing tool");
  return { ...answer, body: answer.body as Answer };
}
async function rows(sql: string, ...binds: unknown[]) {
  return (
    await native.DB.prepare(sql)
      .bind(...binds)
      .all<Record<string, unknown>>()
  ).results;
}
const records = () =>
  rows(
    "SELECT * FROM audit_records WHERE principal=? AND operation='schedules.survey.decide' ORDER BY recorded_at,audit_id",
    p.id,
  );
const decision = (id: number) =>
  rows("SELECT * FROM maintenance_survey_decisions WHERE proposal_id=?", id);
async function accept(id: number, baseRevision = 0, key: string = crypto.randomUUID()) {
  const args = { decision: "accept", source: "vpass", proposalId: id, baseRevision };
  const prepared = await invoke({ ...args, step: "prepare", idempotencyKey: key });
  return { args, key, prepared };
}

test("a rejection is one direct call, recorded R1, and an exact retry replays it", async () => {
  const id = await proposal();
  const key = crypto.randomUUID();
  const body = { decision: "reject", source: "vpass", proposalId: id, step: "apply" };
  const first = await invoke({ ...body, idempotencyKey: key });
  expect(first).toMatchObject({ status: 200, body: { decided: "rejected", replayed: false } });
  expect(await decision(id)).toMatchObject([{ decision: "rejected", actor: p.id }]);
  const again = await invoke({ ...body, idempotencyKey: key });
  expect(again).toMatchObject({ status: 200, body: { decided: "rejected", replayed: true } });
  expect(relays).toBe(1);
  // The same key for another proposal is a conflict, and writes nothing.
  const other = await proposal();
  const conflict = await invoke({ ...body, proposalId: other, idempotencyKey: key });
  expect(conflict).toMatchObject({ status: 403, body: { error: "idempotency_conflict" } });
  expect(await decision(other)).toEqual([]);
  const written = await records();
  expect(written.map((row) => [row["result"], row["risk_class"], row["target_ref"]])).toEqual([
    ["applied", "R1", `maintenance-survey-proposal:${id}`],
    ["replayed", "R1", `maintenance-survey-proposal:${id}`],
    ["refused", "R1", null],
  ]);
  expect(written[0]).toMatchObject({
    principal_kind: "delegated",
    delegation_ref: p.delegationRef,
    scope_source: "vpass",
  });
});

test("an acceptance is prepared, then confirmed once, through the maintenance writer", async () => {
  const id = await proposal();
  const { args, key, prepared } = await accept(id);
  expect(prepared.status).toBe(200);
  expect(prepared.body.preview).toMatchObject({
    proposalId: id,
    kind: "new",
    status: "proposed",
    reasons: [],
    ruleId: `vpass-survey-${id}`,
    baseRevision: 0,
    currentRevision: 0,
    deferralClass: "within-7d",
    revert: "maintenance-revision",
  });
  // A prepare writes no rule and no decision.
  expect(
    await rows("SELECT * FROM provider_maintenance_rules WHERE id=?", `vpass-survey-${id}`),
  ).toEqual([]);
  expect(await decision(id)).toEqual([]);
  const digest = prepared.body.confirmation!.digest;
  const confirmed = await invoke({
    ...args,
    step: "confirm",
    idempotencyKey: key,
    confirmationDigest: digest,
  });
  expect(confirmed).toMatchObject({
    status: 200,
    body: { decided: "accepted", ruleId: `vpass-survey-${id}`, revision: 1, replayed: false },
  });
  const [rule] = await rows(
    "SELECT * FROM provider_maintenance_rules WHERE id=?",
    `vpass-survey-${id}`,
  );
  const [prepareRecord] = (await records()).filter((row) => row["result"] === "prepared");
  expect(rule).toMatchObject({
    revision: 1,
    actor: p.id,
    actor_kind: "delegated",
    change_reason: "maintenance-survey-proposal-accepted",
    decision_ref: `delegated-audit:${prepareRecord!["audit_id"]}`,
  });
  expect(await decision(id)).toMatchObject([
    { decision: "accepted", actor: p.id, rule_id: `vpass-survey-${id}`, rule_revision: 1 },
  ]);
  // The exact confirm again replays from the record; a second write never happens.
  const again = await invoke({
    ...args,
    step: "confirm",
    idempotencyKey: key,
    confirmationDigest: digest,
  });
  expect(again).toMatchObject({
    status: 200,
    body: { decided: "accepted", ruleId: `vpass-survey-${id}`, revision: 1, replayed: true },
  });
  expect(
    await rows("SELECT * FROM provider_maintenance_rules WHERE id=?", `vpass-survey-${id}`),
  ).toHaveLength(1);
  const applied = (await records()).filter((row) => row["result"] === "applied");
  expect(applied).toMatchObject([
    {
      risk_class: "R2",
      step: "confirm",
      confirms_audit_id: prepareRecord!["audit_id"],
      target_ref: `maintenance-survey-proposal:${id}`,
      refs_json: JSON.stringify([`maintenance-rule:vpass-survey-${id}@1`]),
    },
  ]);
});

test("a changed proposal revises its rule at the proposal's base revision", async () => {
  const created = await proposal();
  const first = await accept(created);
  await invoke({
    ...first.args,
    step: "confirm",
    idempotencyKey: first.key,
    confirmationDigest: first.prepared.body.confirmation!.digest,
  });
  const ruleId = `vpass-survey-${created}`;
  const changed = await proposal({ kind: "changed", ruleId, baseRevision: 1 });
  // A stale base revision is refused before anything is prepared.
  expect((await accept(changed, 0)).prepared).toMatchObject({
    status: 409,
    body: { error: "revision_conflict" },
  });
  const second = await accept(changed, 1);
  expect(second.prepared.body.preview).toMatchObject({
    ruleId,
    baseRevision: 1,
    currentRevision: 1,
  });
  const confirmed = await invoke({
    ...second.args,
    step: "confirm",
    idempotencyKey: second.key,
    confirmationDigest: second.prepared.body.confirmation!.digest,
  });
  expect(confirmed.body).toMatchObject({ decided: "accepted", ruleId, revision: 2 });
});

test("the owner kept five reasons with the operator: refused at R3, rejection still allowed", async () => {
  for (const reason of [
    "rule_absent_from_page",
    "rule_disabled_by_operator",
    "ambiguous_rule_match",
    "cancellation_stated",
    "contradictory_windows",
  ]) {
    const id = await proposal({ reasons: [reason, "year_inferred"] });
    const { prepared } = await accept(id);
    expect([reason, prepared.status, prepared.body.error]).toEqual([
      reason,
      403,
      "operation_not_delegable",
    ]);
    expect(await decision(id)).toEqual([]);
    const rejected = await invoke({
      decision: "reject",
      source: "vpass",
      proposalId: id,
      step: "apply",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(rejected.body).toMatchObject({ decided: "rejected" });
  }
  const refused = (await records()).filter((row) => row["result"] === "refused");
  expect(refused.map((row) => [row["risk_class"], row["result_code"]])).toEqual(
    Array(5).fill(["R3", "operation_not_delegable"]),
  );
  // Another review reason alone may be accepted.
  const id = await proposal({ reasons: ["year_inferred", "long_window"] });
  expect((await accept(id)).prepared.body.preview).toMatchObject({
    status: "review_pending",
    reasons: ["year_inferred", "long_window"],
  });
});

const confirm = (accepted: Awaited<ReturnType<typeof accept>>) =>
  invoke({
    ...accepted.args,
    step: "confirm",
    idempotencyKey: accepted.key,
    confirmationDigest: accepted.prepared.body.confirmation!.digest,
  });
const ruleRows = (id: string) => rows("SELECT * FROM provider_maintenance_rules WHERE id=?", id);

test("the same reservation holds against the rules now: a rule overlapping one accepted since, or a disable", async () => {
  const before = (await records()).length;
  // Two readings of one window, neither with a reason: the second would sit
  // beside the rule the first became.
  const firstReading = await proposal();
  const secondReading = await proposal({ offset: -3 * 3_600_000 + 30 * 60_000 });
  expect((await confirm(await accept(firstReading))).body).toMatchObject({ decided: "accepted" });
  expect((await accept(secondReading)).prepared).toMatchObject({
    status: 403,
    body: { error: "operation_not_delegable" },
  });
  // Checked again at confirm: an overlapping rule accepted between the steps.
  const prepared = await accept(await proposal());
  expect(prepared.prepared.status).toBe(200);
  const overlapping = await proposal({ offset: -3 * 3_600_000 + 30 * 60_000 });
  expect((await confirm(await accept(overlapping))).body).toMatchObject({ decided: "accepted" });
  expect(await confirm(prepared)).toMatchObject({
    status: 403,
    body: { error: "operation_not_delegable" },
  });
  expect(await ruleRows(`vpass-survey-${prepared.args.proposalId}`)).toEqual([]);
  expect(await decision(prepared.args.proposalId)).toEqual([]);
  // A disable is the operator's even when no reason says so.
  const rule = `vpass-survey-${firstReading}`;
  const disable = await proposal({ kind: "absent", ruleId: rule, baseRevision: 1 });
  expect((await accept(disable, 1)).prepared).toMatchObject({
    status: 403,
    body: { error: "operation_not_delegable" },
  });
  expect(await ruleRows(rule)).toHaveLength(1);
  const refused = (await records()).slice(before).filter((row) => row["result"] === "refused");
  expect(refused.map((row) => [row["risk_class"], row["result_code"]])).toEqual(
    Array(3).fill(["R3", "operation_not_delegable"]),
  );
});

test("between prepare and confirm: an operator's decision or a moved rule wins, and nothing is written", async () => {
  // The operator decided first.
  const decided = await accept(await proposal());
  await native.DB.prepare(
    "INSERT INTO maintenance_survey_decisions(proposal_id,decision,actor,decided_at) VALUES(?,'rejected','operator:synthetic',?)",
  )
    .bind(decided.args.proposalId, new Date().toISOString())
    .run();
  expect(await confirm(decided)).toMatchObject({
    status: 409,
    body: { error: "proposal_already_decided" },
  });
  expect(await ruleRows(`vpass-survey-${decided.args.proposalId}`)).toEqual([]);
  // Two readings revising one rule: the one confirmed first moves it.
  const created = await proposal();
  await confirm(await accept(created));
  const ruleId = `vpass-survey-${created}`;
  const late = await accept(await proposal({ kind: "changed", ruleId, baseRevision: 1 }), 1);
  const early = await accept(await proposal({ kind: "changed", ruleId, baseRevision: 1 }), 1);
  expect((await confirm(early)).body).toMatchObject({ decided: "accepted", revision: 2 });
  expect(await confirm(late)).toMatchObject({ status: 409, body: { error: "revision_conflict" } });
  expect(await decision(late.args.proposalId)).toEqual([]);
  expect(await ruleRows(ruleId)).toHaveLength(2);
  // A confirmation prepared for one proposal does not confirm another.
  const one = await accept(await proposal());
  const other = await accept(await proposal());
  const crossed = await invoke({
    ...other.args,
    step: "confirm",
    idempotencyKey: other.key,
    confirmationDigest: one.prepared.body.confirmation!.digest,
  });
  expect(crossed).toMatchObject({ status: 403, body: { error: "confirmation_invalid" } });
  expect(await decision(other.args.proposalId)).toEqual([]);
});

test("the delegation's own budget: the preview shows the tighter figure, and a spent budget at confirm writes nothing", async () => {
  p = { ...p, budget: { writesPerDay: 2 } };
  const reject = (id: number) =>
    invoke({
      decision: "reject",
      source: "vpass",
      proposalId: id,
      step: "apply",
      idempotencyKey: crypto.randomUUID(),
    });
  expect((await reject(await proposal())).body).toMatchObject({ decided: "rejected" });
  const prepared = await accept(await proposal());
  expect(prepared.prepared.body.preview).toMatchObject({ budgetRemaining: 1 });
  expect((await reject(await proposal())).body).toMatchObject({ decided: "rejected" });
  expect(await confirm(prepared)).toMatchObject({
    status: 429,
    body: { error: "delegation_budget_exceeded" },
  });
  expect(await ruleRows(`vpass-survey-${prepared.args.proposalId}`)).toEqual([]);
  expect(await decision(prepared.args.proposalId)).toEqual([]);
});

test("scope: another source's proposal is not found, a source outside the delegation is refused", async () => {
  const theirs = await proposal({ source: "myjcb" });
  const probe = await invoke({
    decision: "reject",
    source: "vpass",
    proposalId: theirs,
    step: "apply",
    idempotencyKey: crypto.randomUUID(),
  });
  const missing = await invoke({
    decision: "reject",
    source: "vpass",
    proposalId: 999_999_999,
    step: "apply",
    idempotencyKey: crypto.randomUUID(),
  });
  expect(probe).toMatchObject({ status: 404, body: { error: "proposal_not_found" } });
  expect(missing).toMatchObject({ status: 404, body: { error: "proposal_not_found" } });
  // The same at prepare: an acceptance of another source's proposal is not found.
  expect((await accept(theirs)).prepared).toMatchObject({
    status: 404,
    body: { error: "proposal_not_found" },
  });
  const outside = await invoke({
    decision: "reject",
    source: "myjcb",
    proposalId: theirs,
    step: "apply",
    idempotencyKey: crypto.randomUUID(),
  });
  expect(outside).toMatchObject({ status: 403, body: { error: "source_not_granted" } });
  expect(await decision(theirs)).toEqual([]);
});

test("bounds and shape: the 31-day ceiling, the closed steps and the capability", async () => {
  const long = await proposal({ duration: 40 * DAY });
  expect((await accept(long)).prepared).toMatchObject({
    status: 422,
    body: { error: "maintenance_deferral_too_long" },
  });
  const id = await proposal();
  for (const body of [
    // Reject is the direct step only; accept is never direct.
    { decision: "reject", source: "vpass", proposalId: id, step: "prepare" },
    { decision: "accept", source: "vpass", proposalId: id, baseRevision: 0, step: "apply" },
    { decision: "accept", source: "vpass", proposalId: id, step: "prepare" },
    { decision: "reject", source: "vpass", proposalId: id, step: "apply", extra: 1 },
  ])
    expect((await invoke({ ...body, idempotencyKey: crypto.randomUUID() })).body.error).toBe(
      "invalid_request",
    );
  const without = { ...p, capabilities: ["schedules.maintenance.update" as const] };
  const denied = await invoke(
    {
      decision: "reject",
      source: "vpass",
      proposalId: id,
      step: "apply",
      idempotencyKey: crypto.randomUUID(),
    },
    without,
  );
  expect(denied).toMatchObject({ status: 403, body: { error: "delegation_capability_denied" } });
  expect(await decision(id)).toEqual([]);
});
