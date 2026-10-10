// Real local D1, App adapter and the unchanged #564 writer. Alarm RPC is synthetic.
import { env as testEnv } from "cloudflare:test";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import {
  OperationCall,
  d1CommandStore,
  appendAnswerRecord,
  type DelegatedPrincipal,
} from "../../../packages/application/src/index";
import { callDelegatedMaintenanceTool } from "../src/delegated-maintenance-tools";
import { callDelegatedScheduleTool } from "../src/delegated-schedule-tools";
import { auditedTool } from "../src/audit";
import { delegatedMaintenanceRoute } from "../../processor/src/delegated-maintenance";
import { delegatedScheduleRoute } from "../../processor/src/delegated-schedules";
import { updateMaintenance } from "../../processor/src/schedule-store";
type AppEnv = Parameters<typeof callDelegatedMaintenanceTool>[1];
let native: Parameters<typeof delegatedMaintenanceRoute>[1], app: AppEnv;
let p: DelegatedPrincipal,
  relays = 0,
  alarms = 0,
  pending = false;
const DAY = 86400000,
  REFERENCE = "https://maintenance.synthetic.test/notices";
beforeAll(() => {
  vi.useRealTimers();
  native = {
    ...testEnv,
    SCHEDULES_ENABLED: "true",
    SCHEDULE_ALARMS: {
      getByName: () => ({
        reconcile: async () => {
          alarms++;
          if (pending) throw Error("synthetic alarm unavailable");
          return null;
        },
        alarmTime: async () => null,
      }),
    },
  } as unknown as typeof native;
  app = {
    ...native,
    PIPELINE: {
      fetch: async (request: Request) => {
        relays++;
        const response =
          (await delegatedMaintenanceRoute(request, native, new URL(request.url))) ??
          (await delegatedScheduleRoute(request, native, new URL(request.url)));
        if (!response) throw Error("unexpected route");
        return response;
      },
    },
  } as unknown as AppEnv;
});
beforeEach(async () => {
  const subject = `maintenance-${crypto.randomUUID()}`;
  p = {
    kind: "delegated",
    id: `mcp-client:${subject}`,
    delegator: subject,
    capabilities: ["schedules.maintenance.update", "schedules.job.update"],
    scopes: { sources: [], accounts: [], scheduleSources: ["vpass", "myjcb"] },
    notAfter: new Date(Date.now() + 3600000).toISOString(),
    delegationRef: `dlg_${"b".repeat(64)}`,
    budget: { writesPerDay: 200 },
  };
  relays = 0;
  alarms = 0;
  pending = false;
  await native.DB.prepare(
    "UPDATE provider_maintenance_references SET reference_url=?, status='not-found'",
  )
    .bind(REFERENCE)
    .run();
  // Preserve test evidence by appending disabled revisions, including seeded rules.
  await native.DB.prepare(
    "INSERT INTO provider_maintenance_rules(id,revision,source,timezone,pattern_json,enabled,reference_url,verified_at,scope,actor,created_at) SELECT r.id,r.revision+1,r.source,r.timezone,r.pattern_json,0,?,r.verified_at,r.scope,'migration:synthetic','2026-01-01T00:00:00.000Z' FROM provider_maintenance_rules r WHERE r.revision=(SELECT max(x.revision) FROM provider_maintenance_rules x WHERE x.id=r.id) AND r.enabled=1",
  )
    .bind(REFERENCE)
    .run();
});
type Answer = {
  saved?: boolean;
  ruleId?: string;
  revision?: number;
  replayed?: boolean;
  reconciliation?: string | null;
  error?: string;
  confirmation?: { digest: string };
  preview?: { budgetRemaining: number; deferralClass: string };
};
const payload = (duration = DAY) => {
  const from = Date.now() + DAY;
  return {
    source: "vpass",
    revision: 0,
    timezone: "Asia/Tokyo",
    enabled: true,
    scope: "collection",
    pattern: {
      kind: "once",
      from: new Date(from).toISOString(),
      to: new Date(from + duration).toISOString(),
    },
    referenceUrl: REFERENCE,
    verifiedAt: new Date(Date.now() - 60000).toISOString(),
    reason: "owner-instructed",
    idempotencyKey: crypto.randomUUID(),
  };
};
async function invoke(body: unknown, who = p, config = app) {
  const answer = await auditedTool(
    {
      path: "mcp",
      subject: who.delegator,
      principal: who.id,
      correlationId: crypto.randomUUID(),
      sink: { append: (row) => appendAnswerRecord(d1CommandStore(native.DB), row) },
      onWriteFailure: () => {},
    },
    "schedules.maintenance.update",
    (audit) => callDelegatedMaintenanceTool(body, config, { ok: true, principal: who }, audit),
  );
  if (!answer) throw Error("missing tool");
  return { ...answer, body: answer.body as Answer };
}
async function count(sql: string, ...binds: unknown[]) {
  return (await native.DB.prepare(sql)
    .bind(...binds)
    .first<number>("n"))!;
}
const effects = () =>
  count("SELECT count(*) n FROM audit_records WHERE principal=? AND result='applied'", p.id);
const revisions = () =>
  count("SELECT count(*) n FROM provider_maintenance_rules WHERE actor=?", p.id);
async function operatorEdit(id: string, revision: number) {
  const row = (await native.DB.prepare(
    "SELECT * FROM provider_maintenance_rules WHERE id=? AND revision=?",
  )
    .bind(id, revision)
    .first())!;
  const actor = "maintenance-human-synthetic";
  return updateMaintenance(
    native,
    {
      id,
      revision,
      source: row.source,
      timezone: row.timezone,
      pattern: JSON.parse(row.pattern_json as string),
      enabled: false,
      scope: row.scope,
      referenceUrl: REFERENCE,
      verifiedAt: row.verified_at,
    },
    actor,
    new OperationCall("schedules.maintenance.update", {
      path: "ui",
      subject: actor,
      principal: actor,
      principalKind: "human",
      correlationId: crypto.randomUUID(),
    }),
  );
}
test("R1 reserves the exact effect audit reference; completed retry skips newer native revision, budget and alarm", async () => {
  p.budget.writesPerDay = 1;
  const input = { ...payload(), step: "apply" };
  pending = true;
  const saved = await invoke(input);
  expect(saved.status).toBe(200);
  expect(saved.body.reconciliation).toBe("pending");
  const row = (await native.DB.prepare(
    "SELECT * FROM provider_maintenance_rules WHERE id=? AND revision=1",
  )
    .bind(saved.body.ruleId)
    .first())!;
  const audit = (await native.DB.prepare(
    "SELECT * FROM audit_records WHERE principal=? AND result='applied'",
  )
    .bind(p.id)
    .first())!;
  expect(row.decision_ref).toBe(`delegated-audit:${audit.audit_id}`);
  expect(audit.risk_class).toBe("R1");
  expect(audit.step).toBe("call");
  expect(JSON.stringify(audit)).not.toContain(REFERENCE);
  expect(audit.target_ref).toBe("source:vpass");
  expect(audit.scope_namespace).toBe("schedule-source");
  await operatorEdit(saved.body.ruleId!, 1);
  const previous = { relays, alarms };
  const replay = await invoke(input);
  expect(replay.body).toEqual({ ...saved.body, replayed: true, reconciliation: null });
  expect({ relays, alarms }).toEqual(previous);
  expect(await effects()).toBe(1);
  expect(await revisions()).toBe(1);
  expect((await invoke({ ...input, reason: "correction" })).body.error).toBe(
    "idempotency_conflict",
  );
  expect((await invoke(input, { ...p, capabilities: [] })).body.error).toBe(
    "delegation_capability_denied",
  );
  expect(
    (await invoke(input, { ...p, scopes: { ...p.scopes, scheduleSources: [] } })).body.error,
  ).toBe("source_not_granted");
  expect({ relays, alarms }).toEqual(previous);
});
test("R2 preparation is inert; confirmed 31-day write binds prepared and effect audit records", async () => {
  const input = payload(31 * DAY);
  expect((await invoke({ ...input, step: "apply" })).body.error).toBe(
    "maintenance_deferral_too_long",
  );
  const prepared = await invoke({ ...input, step: "prepare" });
  expect(prepared.status).toBe(200);
  expect(prepared.body.preview?.deferralClass).toBe("within-31d");
  expect(prepared.body.preview?.budgetRemaining).toBe(30);
  expect(await revisions()).toBe(0);
  expect(alarms).toBe(0);
  const confirmed = {
    ...input,
    step: "confirm",
    confirmationDigest: prepared.body.confirmation!.digest,
  };
  const saved = await invoke(confirmed);
  expect(saved.status).toBe(200);
  const audit = (await native.DB.prepare(
    "SELECT * FROM audit_records WHERE principal=? AND result='applied'",
  )
    .bind(p.id)
    .first())!;
  const prepare = (await native.DB.prepare(
    "SELECT * FROM audit_records WHERE principal=? AND result='prepared'",
  )
    .bind(p.id)
    .first())!;
  const row = (await native.DB.prepare(
    "SELECT decision_ref FROM provider_maintenance_rules WHERE id=? AND revision=1",
  )
    .bind(saved.body.ruleId)
    .first())!;
  expect(row.decision_ref).toBe(`delegated-audit:${prepare.audit_id}`);
  expect(audit.confirms_audit_id).toBe(prepare.audit_id);
  expect(audit.risk_class).toBe("R2");
  expect(audit.step).toBe("confirm");
  await operatorEdit(saved.body.ruleId!, 1);
  const previous = { relays, alarms };
  expect((await invoke(confirmed)).body).toEqual({
    ...saved.body,
    replayed: true,
    reconciliation: null,
  });
  expect({ relays, alarms }).toEqual(previous);
  expect(
    (await invoke({ ...confirmed, confirmationDigest: `cfm_${"f".repeat(64)}` })).body.error,
  ).toBe("confirmation_invalid");
  expect(
    (await invoke(confirmed, { ...p, delegationRef: `dlg_${"c".repeat(64)}` })).body.error,
  ).toBe("confirmation_invalid");
});
test.each([
  [7 * DAY, "apply", 200],
  [7 * DAY + 1, "apply", 422],
  [31 * DAY, "prepare", 200],
  [31 * DAY + 1, "prepare", 422],
] as const)("deferral edge %i via %s is %i", async (duration, step, status) => {
  const result = await invoke({ ...payload(duration), step });
  expect(result.status).toBe(status);
  if (status !== 200) {
    expect(result.body.error).toBe("maintenance_deferral_too_long");
    expect(await revisions()).toBe(0);
  }
});
test("exact revision, forged fields, host, source and confirmation changes refuse without effects", async () => {
  const input = payload();
  for (const extra of [
    { decisionRef: "delegated-audit:aud_00000000-0000-0000-0000-000000000000" },
    { deferralBound: "confirmed-31d" },
    { revertsAuditId: "aud_00000000-0000-0000-0000-000000000000" },
  ])
    expect((await invoke({ ...input, step: "apply", ...extra })).status).toBe(400);
  expect(relays).toBe(0);
  expect((await invoke({ ...input, step: "apply", source: "sony-bank" })).status).toBe(403);
  expect(
    (await invoke({ ...input, step: "apply", referenceUrl: "https://untrusted.synthetic.test" }))
      .status,
  ).not.toBe(200);
  const prepared = await invoke({ ...input, step: "prepare" });
  expect(prepared.status).toBe(200);
  expect(
    (
      await invoke({
        ...input,
        step: "confirm",
        reason: "correction",
        confirmationDigest: prepared.body.confirmation!.digest,
      })
    ).body.error,
  ).toBe("confirmation_invalid");
  const saved = await invoke({ ...input, idempotencyKey: crypto.randomUUID(), step: "apply" });
  expect(saved.status).toBe(200);
  const edit = {
    ...input,
    ruleId: saved.body.ruleId,
    revision: 1,
    idempotencyKey: crypto.randomUUID(),
    enabled: false,
  };
  const pendingEdit = await invoke({ ...edit, step: "prepare" });
  expect(pendingEdit.status).toBe(200);
  await operatorEdit(saved.body.ruleId!, 1);
  expect(
    (
      await invoke({
        ...edit,
        step: "confirm",
        confirmationDigest: pendingEdit.body.confirmation!.digest,
      })
    ).body.error,
  ).toBe("revision_conflict");
  expect(await effects()).toBe(1);
});
test("concurrent maintenance writes atomically share one budget slot and rollback provenance on audit failure", async () => {
  p.budget.writesPerDay = 1;
  const input = payload();
  const results = await Promise.all([
    invoke({ ...input, step: "apply" }),
    invoke({ ...payload(), source: "myjcb", step: "apply" }),
  ]);
  expect(results.map((x) => x.status).sort()).toEqual([200, 429]);
  expect(await effects()).toBe(1);
  expect(await revisions()).toBe(1);
  expect(
    (
      await invoke(
        { ...payload(), step: "apply" },
        { ...p, delegationRef: `dlg_${"c".repeat(64)}` },
      )
    ).body.error,
  ).toBe("delegation_budget_exceeded");
  const failedPrincipal = {
    ...p,
    id: "mcp-client:synthetic-audit-failure",
    delegator: "synthetic-audit-failure",
  };
  await native.DB.exec(
    "CREATE TRIGGER synthetic_audit_failure BEFORE INSERT ON audit_records WHEN NEW.principal='mcp-client:synthetic-audit-failure' AND NEW.result='applied' BEGIN SELECT RAISE(ABORT,'synthetic'); END",
  );
  try {
    expect((await invoke({ ...payload(), step: "apply" }, failedPrincipal)).status).toBe(503);
    expect(
      await count(
        "SELECT count(*) n FROM provider_maintenance_rules WHERE actor=?",
        failedPrincipal.id,
      ),
    ).toBe(0);
  } finally {
    await native.DB.exec("DROP TRIGGER synthetic_audit_failure");
  }
});
test("maintenance and native jobs consume the same actual writesPerDay budget", async () => {
  p.budget.writesPerDay = 1;
  const job = (await native.DB.prepare(
    "SELECT * FROM collection_schedules WHERE id='vpass'",
  ).first())!;
  const input = {
    jobId: "vpass",
    source: "vpass",
    revision: job.revision,
    enabled: false,
    timezone: job.timezone,
    pattern: JSON.parse(job.pattern_json as string),
    idempotencyKey: crypto.randomUUID(),
  };
  const jobCall = (body: unknown) =>
    auditedTool(
      {
        path: "mcp",
        subject: p.delegator,
        principal: p.id,
        correlationId: crypto.randomUUID(),
        sink: { append: (row) => appendAnswerRecord(d1CommandStore(native.DB), row) },
        onWriteFailure: () => {},
      },
      "schedules.job.update",
      (audit) =>
        callDelegatedScheduleTool(
          "kogane.schedules.job.update",
          body,
          app,
          { ok: true, principal: p },
          audit,
        ),
    );
  const prepared = await jobCall({ ...input, step: "prepare" });
  expect(prepared?.status).toBe(200);
  expect((await invoke({ ...payload(), step: "apply" })).status).toBe(200);
  const result = await jobCall({
    ...input,
    step: "confirm",
    confirmationDigest: (prepared!.body as Answer).confirmation!.digest,
  });
  expect(result?.status).toBe(429);
  expect(await effects()).toBe(1);
  expect(
    (await native.DB.prepare("SELECT revision FROM collection_schedules WHERE id='vpass'").first())
      ?.revision,
  ).toBe(job.revision);
});

test.each(["apply", "confirm"] as const)(
  "same-key %s race has one persisted effect and retry returns that receipt",
  async (step) => {
    const input = payload();
    const confirmationDigest =
      step === "confirm"
        ? (await invoke({ ...input, step: "prepare" })).body.confirmation!.digest
        : undefined;
    const request = { ...input, step, ...(confirmationDigest ? { confirmationDigest } : {}) };
    const results = await Promise.all([invoke(request), invoke(request)]);
    expect(results.some((x) => x.status === 200)).toBe(true);
    expect(await effects()).toBe(1);
    expect(await revisions()).toBe(1);
    expect(alarms).toBe(1);
    const before = { relays, alarms };
    const retry = await invoke(request);
    expect(retry.status).toBe(200);
    expect(retry.body.replayed).toBe(true);
    expect(retry.body.reconciliation).toBeNull();
    expect({ relays, alarms }).toEqual(before);
  },
);
