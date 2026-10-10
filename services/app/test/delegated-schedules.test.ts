// Actual D1 + native schedule writer, with the App adapter in front. No
// provider contact, queue dispatch or production identity is involved.
import { env as testEnv } from "cloudflare:test";
import { beforeAll, expect, test, vi } from "vitest";
import {
  OperationCall,
  d1CommandStore,
  prepareDelegatedOperation,
  confirmDelegatedOperation,
  appendAnswerRecord,
  type DelegatedPrincipal,
} from "../../../packages/application/src/index.ts";
import { callDelegatedScheduleTool } from "../src/delegated-schedule-tools.ts";
import { auditedTool } from "../src/audit.ts";
import { delegatedScheduleRoute } from "../../processor/src/delegated-schedules.ts";
import { updateSchedule } from "../../processor/src/schedule-store.ts";
let env: Parameters<typeof delegatedScheduleRoute>[1],
  relays = 0,
  alarms = 0,
  reconcileFails = false,
  reconciledAlarmAt: string | null = null;
type AppEnv = Parameters<typeof callDelegatedScheduleTool>[2];
let appEnv: AppEnv;
const p: DelegatedPrincipal = {
  kind: "delegated",
  id: "mcp-client:job-synthetic",
  delegator: "job-synthetic",
  capabilities: ["schedules.job.update"],
  scopes: {
    sources: "*",
    accounts: "*",
    scheduleSources: ["vpass", "myjcb", "sony-bank", "sbi-vc-trade", "smbc-direct"],
  },
  notAfter: new Date(Date.now() + 3600_000).toISOString(),
  delegationRef: `dlg_${"b".repeat(64)}`,
  budget: { writesPerDay: 200 },
};
beforeAll(async () => {
  vi.useRealTimers();
  env = {
    ...testEnv,
    SCHEDULES_ENABLED: "true",
    SCHEDULE_ALARMS: {
      getByName: () => ({
        reconcile: async () => {
          alarms++;
          if (reconcileFails) throw Error("synthetic private provider detail");
          return reconciledAlarmAt;
        },
        alarmTime: async () => null,
      }),
    },
  } as unknown as Parameters<typeof delegatedScheduleRoute>[1];
  appEnv = {
    ...env,
    PIPELINE: {
      fetch: async (request: Request) => {
        relays++;
        const response = await delegatedScheduleRoute(request, env, new URL(request.url));
        if (!response) throw Error("unexpected private route");
        return response;
      },
    },
  } as unknown as AppEnv;
}, 60_000);
function call(who = p) {
  return new OperationCall("schedules.job.update", {
    path: "mcp",
    subject: who.delegator,
    principal: who.id,
    principalKind: "agent",
    correlationId: crypto.randomUUID(),
  });
}
async function invoke(body: unknown, who = p, configuration = appEnv) {
  const result = await auditedTool(
    {
      path: "mcp",
      subject: who.delegator,
      principal: who.id,
      correlationId: crypto.randomUUID(),
      sink: { append: (row) => appendAnswerRecord(d1CommandStore(env.DB), row) },
      onWriteFailure: () => {},
    },
    "schedules.job.update",
    (audit) =>
      callDelegatedScheduleTool(
        "kogane.schedules.job.update",
        body,
        configuration,
        { ok: true, principal: who },
        audit,
      ),
  );
  if (!result) throw Error("unexpected missing tool");
  return result;
}
async function job(id = "vpass") {
  return (await env.DB.prepare("SELECT * FROM collection_schedules WHERE id=?").bind(id).first())!;
}
async function count(sql: string, ...binds: unknown[]) {
  return (await env.DB.prepare(sql)
    .bind(...binds)
    .first<number>("n"))!;
}
async function payload(jobId = "vpass", key: string = crypto.randomUUID()) {
  const row = await job(jobId);
  return {
    jobId,
    source: row.source,
    revision: row.revision,
    enabled: false,
    timezone: row.timezone,
    pattern: JSON.parse(row.pattern_json as string),
    idempotencyKey: key,
  };
}
function digest(result: Awaited<ReturnType<typeof invoke>>) {
  expect(result.status).toBe(200);
  return (result.body as { confirmation: { digest: string } }).confirmation.digest;
}
async function prepare(body: Awaited<ReturnType<typeof payload>>, who = p) {
  return digest(await invoke({ ...body, step: "prepare" }, who));
}
async function privateCall(
  audit: OperationCall,
  body: unknown,
  changes: Record<string, string> = {},
  path = "/internal/delegated-schedules/job",
) {
  const req = new Request(`https://pipeline.internal${path}`, {
    method: "POST",
    headers: {
      "x-kogane-internal-caller": "kogane-evidence-browser",
      "x-kogane-verified-actor": audit.actor.principal,
      "x-kogane-actor-kind": "delegated",
      ...audit.envelopeHeaders(),
      ...changes,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const response = await delegatedScheduleRoute(req, env, new URL(req.url));
  if (!response) throw Error("unexpected missing route");
  return response;
}
test("prepare is settings-read-only; one confirmed native revision has atomic audit, exact retry never relays", async () => {
  const body = await payload("vpass", "native-one"),
    before = await job();
  const revisions = await count(
    "SELECT count(*) n FROM collection_schedule_revisions WHERE schedule_id='vpass'",
  );
  const confirmationDigest = await prepare(body);
  expect(await job()).toEqual(before);
  expect(
    await count("SELECT count(*) n FROM collection_schedule_revisions WHERE schedule_id='vpass'"),
  ).toBe(revisions);
  const relayCount = relays,
    alarmCount = alarms;
  const saved = await invoke({ ...body, step: "confirm", confirmationDigest });
  expect(saved.status).toBe(200);
  expect(saved.body).toEqual({
    saved: true,
    jobId: "vpass",
    revision: Number(body.revision) + 1,
    reservation: "disabled",
    actualAlarmAt: null,
    replayed: false,
  });
  expect((await job()).updated_by).toBe(p.id);
  const effect = await env.DB.prepare(
    "SELECT * FROM audit_records WHERE principal=? AND operation='schedules.job.update' AND idempotency_key=? AND result='applied'",
  )
    .bind(p.id, body.idempotencyKey)
    .first();
  expect(effect).toMatchObject({
    principal_kind: "delegated",
    subject: p.delegator,
    delegation_ref: p.delegationRef,
    risk_class: "R2",
    step: "confirm",
    target_ref: "schedule:vpass",
    scope_namespace: "schedule-source",
    scope_source: "vpass",
  });
  expect(effect!.confirms_audit_id).toMatch(/^aud_/u);
  expect(JSON.parse(effect!.refs_json as string)).toEqual([
    `schedule:vpass@${Number(body.revision) + 1}`,
  ]);
  expect(alarms).toBe(alarmCount + 1);
  const after = await job(),
    retried = await invoke({ ...body, step: "confirm", confirmationDigest });
  expect(retried.body).toEqual({
    ...(saved.body as object),
    reservation: null,
    actualAlarmAt: null,
    replayed: true,
  });
  expect(await job()).toEqual(after);
  expect(relays).toBe(relayCount + 1);
  expect(alarms).toBe(alarmCount + 1);
  expect(
    await count(
      "SELECT count(*) n FROM audit_records WHERE idempotency_key=? AND result='applied'",
      body.idempotencyKey,
    ),
  ).toBe(1);
  expect(
    await count(
      "SELECT count(*) n FROM audit_records WHERE idempotency_key=? AND result='replayed'",
      body.idempotencyKey,
    ),
  ).toBe(1);
}, 60_000);
test("changed payload/revision/key/principal/delegation/confirmation, revoked capability and source scope write nothing", async () => {
  const body = await payload("myjcb", "changed-fields"),
    cfm = await prepare(body),
    before = await job("myjcb"),
    start = relays;
  for (const change of [
    { enabled: !body.enabled },
    { revision: Number(body.revision) + 1 },
    { idempotencyKey: "other-key" },
    { confirmationDigest: `cfm_${"0".repeat(64)}` },
    { source: "sony-bank" },
  ])
    expect(
      (await invoke({ ...body, step: "confirm", confirmationDigest: cfm, ...change })).status,
    ).toBe(403);
  for (const who of [
    { ...p, id: "mcp-client:other", delegator: "other" },
    { ...p, delegationRef: `dlg_${"c".repeat(64)}` },
    { ...p, capabilities: [] },
    { ...p, scopes: { ...p.scopes, scheduleSources: ["vpass"] } },
  ])
    expect((await invoke({ ...body, step: "confirm", confirmationDigest: cfm }, who)).status).toBe(
      403,
    );
  expect(await job("myjcb")).toEqual(before);
  expect(relays).toBe(start);
  expect(
    await count(
      "SELECT count(*) n FROM audit_records WHERE idempotency_key=? AND result='applied'",
      body.idempotencyKey,
    ),
  ).toBe(0);
}, 60_000);
test("a native human edit after prepare defeats confirm without an extra revision", async () => {
  const body = await payload("sony-bank", "stale-native"),
    cfm = await prepare(body);
  const human = new OperationCall("schedules.job.update", {
    path: "ui",
    subject: "human-synthetic",
    principal: "human-synthetic",
    principalKind: "human",
    correlationId: crypto.randomUUID(),
  });
  await updateSchedule(
    env,
    "sony-bank",
    { revision: body.revision, enabled: false, timezone: body.timezone, pattern: body.pattern },
    "human-synthetic",
    human,
  );
  const before = await job("sony-bank");
  const result = await invoke({ ...body, step: "confirm", confirmationDigest: cfm });
  expect(result.status).toBe(409);
  expect(result.body).toEqual({ error: "revision_conflict" });
  expect(await job("sony-bank")).toEqual(before);
  expect(
    await count(
      "SELECT count(*) n FROM audit_records WHERE idempotency_key=? AND result='applied'",
      body.idempotencyKey,
    ),
  ).toBe(0);
}, 60_000);
test("a spent atomic delegation budget rolls back native settings and their revision row", async () => {
  const body = await payload("myjcb", "budget-rollback"),
    before = await job("myjcb");
  const spent = await count(
    "SELECT count(*) n FROM audit_records WHERE principal=? AND principal_kind='delegated' AND result IN ('applied','accepted') AND recorded_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-24 hours')",
    p.id,
  );
  const limited = { ...p, budget: { writesPerDay: spent } },
    cfm = await prepare(body, limited);
  const revisions = await count(
    "SELECT count(*) n FROM collection_schedule_revisions WHERE schedule_id='myjcb'",
  );
  const result = await invoke({ ...body, step: "confirm", confirmationDigest: cfm }, limited);
  expect(result.status).toBe(429);
  expect(result.body).toEqual({ error: "delegation_budget_exceeded" });
  expect(await job("myjcb")).toEqual(before);
  expect(
    await count("SELECT count(*) n FROM collection_schedule_revisions WHERE schedule_id='myjcb'"),
  ).toBe(revisions);
}, 60_000);
test("an audit storage failure rolls back the native job update", async () => {
  const body = await payload("myjcb", "audit-rollback"),
    cfm = await prepare(body),
    before = await job("myjcb"),
    alarmCount = alarms;
  await env.DB.prepare(
    "CREATE TRIGGER job_review_audit_fails BEFORE INSERT ON audit_records WHEN NEW.result='applied' BEGIN SELECT RAISE(ABORT,'synthetic'); END",
  ).run();
  try {
    const result = await invoke({ ...body, step: "confirm", confirmationDigest: cfm });
    expect(result.status).toBe(503);
  } finally {
    await env.DB.prepare("DROP TRIGGER job_review_audit_fails").run();
  }
  expect(await job("myjcb")).toEqual(before);
  expect(alarms).toBe(alarmCount);
  expect(
    await count(
      "SELECT count(*) n FROM audit_records WHERE idempotency_key=? AND result='applied'",
      body.idempotencyKey,
    ),
  ).toBe(0);
}, 60_000);
test("same prepare raced through two native confirmations commits at most once", async () => {
  const args = await payload("myjcb", "race-confirm"),
    { idempotencyKey, ...body } = args;
  const intent = {
    idempotencyKey,
    payload: body,
    targetRef: "schedule:myjcb",
    scope: { namespace: "schedule-source" as const, source: "myjcb" },
    expectedRevision: Number(body.revision),
  };
  const store = d1CommandStore(env.DB),
    prep = await prepareDelegatedOperation(
      store,
      call(),
      p,
      "schedules.job.update",
      intent,
      intent.expectedRevision,
    );
  const a = call(),
    b = call();
  for (const c of [a, b])
    await confirmDelegatedOperation(
      store,
      c,
      p,
      "schedules.job.update",
      intent,
      prep.confirmation.digest,
    );
  const result = await Promise.all([
    privateCall(a, { phase: "apply", payload: body }),
    privateCall(b, { phase: "apply", payload: body }),
  ]);
  expect(result.filter((r) => r.status === 200)).toHaveLength(1);
  expect(result.some((r) => r.status === 403 || r.status === 409)).toBe(true);
  expect((await job("myjcb")).revision).toBe(intent.expectedRevision + 1);
  expect(
    await count(
      "SELECT count(*) n FROM audit_records WHERE idempotency_key=? AND result='applied'",
      idempotencyKey,
    ),
  ).toBe(1);
}, 60_000);
test("expiry crossing before the native effect refuses with no settings write", async () => {
  const args = await payload("myjcb", "expire-private"),
    { idempotencyKey, ...body } = args,
    before = await job("myjcb");
  const intent = {
    idempotencyKey,
    payload: body,
    targetRef: "schedule:myjcb",
    scope: { namespace: "schedule-source" as const, source: "myjcb" },
    expectedRevision: Number(body.revision),
  };
  const now = new Date(Date.now() - 601_000),
    store = d1CommandStore(env.DB);
  const prep = await prepareDelegatedOperation(
      store,
      call(),
      p,
      "schedules.job.update",
      intent,
      intent.expectedRevision,
      now,
    ),
    c = call();
  await confirmDelegatedOperation(
    store,
    c,
    p,
    "schedules.job.update",
    intent,
    prep.confirmation.digest,
    now,
  );
  const response = await privateCall(c, { phase: "apply", payload: body });
  expect(response.status).toBe(403);
  expect((await response.json()) as unknown).toEqual({ error: "confirmation_expired" });
  expect(await job("myjcb")).toEqual(before);
}, 60_000);
test("private route rejects actor/header spoofing, missing confirm, malformed body, source lies and unknown authority", async () => {
  const args = await payload("vpass", "private-refusals"),
    { idempotencyKey: _idempotencyKey, ...body } = args,
    before = await job();
  const c = call();
  c.delegate(p, {
    delegationRef: p.delegationRef,
    writesPerDay: 200,
    notAfter: p.notAfter,
    commandFamilies: [],
    schedule: { operation: "schedules.job.update", source: "vpass" },
  });
  for (const changes of [
    { "cf-connecting-ip": "192.0.2.1" },
    { "x-kogane-operator": "human-synthetic" },
    { "x-kogane-agent": p.id },
    { "x-kogane-verified-actor": "human-synthetic" },
    { "x-kogane-actor-kind": "human" },
    { "x-kogane-internal-caller": "not-the-app" },
    { "x-kogane-delegated-execution": '{"unknown":true}' },
  ])
    expect((await privateCall(c, { phase: "preview", payload: body }, changes)).status).toBe(403);
  expect((await privateCall(c, { phase: "apply", payload: body })).status).toBe(403);
  expect((await privateCall(c, "{")).status).toBe(400);
  expect(
    (await privateCall(c, { phase: "preview", payload: { ...body, jobId: "sony-bank" } })).status,
  ).toBe(404);
  expect(
    (await privateCall(c, { phase: "preview", payload: { ...body, source: "sony-bank" } })).status,
  ).toBe(403);
  expect((await privateCall(c, { phase: "preview", payload: body, actor: p.id })).status).toBe(400);
  expect(
    (
      await privateCall(
        c,
        { phase: "preview", payload: body },
        {},
        "/internal/delegated-schedules/leases",
      )
    ).status,
  ).toBe(400);
  expect(await job()).toEqual(before);
}, 60_000);
test("source-less global jobs require wildcard; interval/native unsupported rules remain authoritative", async () => {
  const global = await payload("processor-tick", "global-job");
  expect((await invoke({ ...global, step: "prepare" })).status).toBe(403);
  const wide = { ...p, scopes: { ...p.scopes, scheduleSources: "*" as const } };
  const cfm = await prepare(global, wide),
    saved = await invoke({ ...global, step: "confirm", confirmationDigest: cfm }, wide);
  expect(saved.status).toBe(200);
  expect((await job("processor-tick")).enabled).toBe(0);
  const keepalive = await payload("sbi-vc-keepalive", "keepalive-job"),
    keepCfm = await prepare(keepalive);
  expect(
    (await invoke({ ...keepalive, step: "confirm", confirmationDigest: keepCfm })).status,
  ).toBe(200);
  const wrong = await payload("sbi-vc-keepalive", "wrong-native-kind");
  expect(
    (
      await invoke({
        ...wrong,
        pattern: { kind: "daily", time: "06:00", weekdays: [1] },
        step: "prepare",
      })
    ).status,
  ).toBe(400);
  const unsupported = await payload("smbc-direct", "unsupported-native");
  expect((await invoke({ ...unsupported, step: "prepare" })).status).toBe(409);
}, 60_000);

test("explicit reversal restores only the still-current original effect; its completed retry remains exact", async () => {
  const before = await job("myjcb"),
    body = { ...(await payload("myjcb", "reverse-original")), enabled: before.enabled !== 1 };
  const originalDigest = await prepare(body);
  expect(
    (await invoke({ ...body, step: "confirm", confirmationDigest: originalDigest })).status,
  ).toBe(200);
  const original = (await env.DB.prepare(
    "SELECT audit_id FROM audit_records WHERE idempotency_key=? AND result='applied'",
  )
    .bind(body.idempotencyKey)
    .first<{ audit_id: string }>())!;
  const inverse = {
    ...(await payload("myjcb", "reverse-exact")),
    enabled: before.enabled === 1,
    timezone: before.timezone,
    pattern: JSON.parse(before.pattern_json as string),
    revertsAuditId: original.audit_id,
  };
  expect((await invoke({ ...inverse, enabled: !inverse.enabled, step: "prepare" })).body).toEqual({
    error: "revert_invalid",
  });
  expect(
    (
      await invoke({
        ...inverse,
        revertsAuditId: "aud_11111111-2222-4333-8444-555555555555",
        step: "prepare",
      })
    ).body,
  ).toEqual({ error: "revert_invalid" });
  const prepared = await prepare(inverse),
    saved = await invoke({ ...inverse, step: "confirm", confirmationDigest: prepared });
  expect(saved.status).toBe(200);
  expect((await job("myjcb")).enabled).toBe(before.enabled);
  const effect = (await env.DB.prepare(
    "SELECT reverts_audit_id FROM audit_records WHERE idempotency_key=? AND result='applied'",
  )
    .bind(inverse.idempotencyKey)
    .first())!;
  expect(effect.reverts_audit_id).toBe(original.audit_id);
  const relayCount = relays,
    replay = await invoke({ ...inverse, step: "confirm", confirmationDigest: prepared });
  expect(replay.status).toBe(200);
  expect(replay.body).toEqual({
    ...(saved.body as object),
    reservation: null,
    actualAlarmAt: null,
    replayed: true,
  });
  expect(relays).toBe(relayCount);
}, 60_000);
test("historical A cannot revert later B, including a human change between inverse preparation and confirm", async () => {
  const before = await job("myjcb"),
    body = { ...(await payload("myjcb", "historical-a")), enabled: before.enabled !== 1 };
  const cfm = await prepare(body);
  expect((await invoke({ ...body, step: "confirm", confirmationDigest: cfm })).status).toBe(200);
  const original = (await env.DB.prepare(
    "SELECT audit_id FROM audit_records WHERE idempotency_key=? AND result='applied'",
  )
    .bind(body.idempotencyKey)
    .first<{ audit_id: string }>())!;
  const inverse = {
    ...(await payload("myjcb", "historical-inverse")),
    enabled: before.enabled === 1,
    timezone: before.timezone,
    pattern: JSON.parse(before.pattern_json as string),
    revertsAuditId: original.audit_id,
  };
  const inverseDigest = await prepare(inverse);
  const human = new OperationCall("schedules.job.update", {
    path: "ui",
    subject: "human-synthetic",
    principal: "human-synthetic",
    principalKind: "human",
    correlationId: crypto.randomUUID(),
  });
  await updateSchedule(
    env,
    "myjcb",
    { revision: inverse.revision, enabled: false, timezone: "UTC", pattern: inverse.pattern },
    "human-synthetic",
    human,
  );
  const current = await job("myjcb");
  expect(
    (await invoke({ ...inverse, step: "confirm", confirmationDigest: inverseDigest })).body,
  ).toEqual({ error: "revert_invalid" });
  expect((await invoke({ ...inverse, revision: current.revision, step: "prepare" })).body).toEqual({
    error: "revert_invalid",
  });
  expect(await job("myjcb")).toEqual(current);
}, 60_000);

test("enabled save reports native pending on reconciliation failure; exact retry neither re-observes nor spends a second budget", async () => {
  const body = { ...(await payload("myjcb", "pending-reservation")), enabled: true };
  const beforeApplied = await count(
    "SELECT count(*) n FROM audit_records WHERE principal=? AND result='applied'",
    p.id,
  );
  const cfm = await prepare(body),
    relayCount = relays,
    alarmCount = alarms;
  reconcileFails = true;
  try {
    const saved = await invoke({ ...body, step: "confirm", confirmationDigest: cfm });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({
      saved: true,
      jobId: body.jobId,
      revision: Number(body.revision) + 1,
      reservation: "pending",
      actualAlarmAt: null,
      replayed: false,
    });
    expect(JSON.stringify(saved.body)).not.toContain("private provider");
    const after = await job(body.jobId);
    expect(after.enabled).toBe(1);
    expect(after.revision).toBe(Number(body.revision) + 1);
    reconcileFails = false;
    reconciledAlarmAt = "2099-01-01T00:00:00.000Z";
    const retry = await invoke({ ...body, step: "confirm", confirmationDigest: cfm });
    expect(retry.body).toEqual({
      saved: true,
      jobId: body.jobId,
      revision: Number(body.revision) + 1,
      reservation: null,
      actualAlarmAt: null,
      replayed: true,
    });
    expect(await job(body.jobId)).toEqual(after);
    expect(relays).toBe(relayCount + 1);
    expect(alarms).toBe(alarmCount + 1);
    expect(
      await count(
        "SELECT count(*) n FROM audit_records WHERE principal=? AND result='applied'",
        p.id,
      ),
    ).toBe(beforeApplied + 1);
    expect(
      await count(
        "SELECT count(*) n FROM audit_records WHERE idempotency_key=? AND result='replayed'",
        body.idempotencyKey,
      ),
    ).toBe(1);
  } finally {
    reconcileFails = false;
    reconciledAlarmAt = null;
  }
}, 60_000);
test("enabled save returns the native successful reservation and actual alarm instant", async () => {
  const body = { ...(await payload("myjcb", "armed-reservation")), enabled: true };
  const cfm = await prepare(body);
  reconciledAlarmAt = "2099-01-01T00:00:00.000Z";
  try {
    const saved = await invoke({ ...body, step: "confirm", confirmationDigest: cfm });
    expect(saved.body).toEqual({
      saved: true,
      jobId: body.jobId,
      revision: Number(body.revision) + 1,
      reservation: "armed",
      actualAlarmAt: reconciledAlarmAt,
      replayed: false,
    });
  } finally {
    reconciledAlarmAt = null;
  }
}, 60_000);
