import { env as testEnv } from "cloudflare:test";
import { beforeAll, expect, test, vi } from "vitest";
import {
  OperationCall,
  d1CommandStore,
  appendAnswerRecord,
  type DelegatedPrincipal,
  type OperationName,
} from "../../../packages/application/src/index.ts";
import { callDelegatedScheduleTool } from "../src/delegated-schedule-tools.ts";
import { callDelegatedOpsTool, type OpsToolName } from "../src/ops-tools.ts";
import { auditedTool } from "../src/audit.ts";
import { delegatedScheduleRoute } from "../../processor/src/delegated-schedules.ts";
import { updateSchedule } from "../../processor/src/schedule-store.ts";

type AppEnv = Parameters<typeof callDelegatedScheduleTool>[2];
type ProcessorEnv = Parameters<typeof delegatedScheduleRoute>[1];
let processor: ProcessorEnv,
  app: AppEnv,
  relays = 0,
  alarms = 0;
beforeAll(() => {
  vi.useRealTimers();
  processor = {
    ...testEnv,
    SCHEDULES_ENABLED: "true",
    SCHEDULE_ALARMS: {
      getByName: () => ({
        reconcile: async () => {
          alarms++;
          return null;
        },
        alarmTime: async () => null,
      }),
    },
  } as unknown as ProcessorEnv;
  app = {
    ...processor,
    OPS_API_ENABLED: "true",
    PIPELINE: {
      fetch: async (request: Request) => {
        relays++;
        const answer = await delegatedScheduleRoute(request, processor, new URL(request.url));
        if (!answer) throw Error("unexpected private route");
        return answer;
      },
    },
  } as unknown as AppEnv;
});
function principal(suffix: string): DelegatedPrincipal {
  const owner = "cross-jobs-" + suffix;
  return {
    kind: "delegated",
    id: "mcp-client:" + owner,
    delegator: owner,
    capabilities: [
      "schedules.job.update",
      "operations.import.request",
      "operations.collection.request",
    ],
    scopes: { sources: ["vpass"], accounts: "*", scheduleSources: ["vpass"] },
    notAfter: new Date(Date.now() + 3600_000).toISOString(),
    delegationRef: "dlg_" + "d".repeat(64),
    budget: { writesPerDay: 1 },
  };
}
async function job() {
  return (await testEnv.DB.prepare("SELECT * FROM collection_schedules WHERE id='vpass'").first())!;
}
async function count(sql: string, ...binds: unknown[]) {
  return (await testEnv.DB.prepare(sql)
    .bind(...binds)
    .first<number>("n"))!;
}
async function invoke(
  name: "kogane.schedules.job.update" | OpsToolName,
  body: unknown,
  p: DelegatedPrincipal,
) {
  const operation = name.slice("kogane.".length) as OperationName;
  const answer = await auditedTool(
    {
      path: "mcp",
      subject: p.delegator,
      principal: p.id,
      correlationId: crypto.randomUUID(),
      sink: { append: (row) => appendAnswerRecord(d1CommandStore(testEnv.DB), row) },
    },
    operation,
    (audit) =>
      name === "kogane.schedules.job.update"
        ? callDelegatedScheduleTool(name, body, app, { ok: true, principal: p }, audit)
        : callDelegatedOpsTool(name, body, app, { ok: true, principal: p }, audit),
  );
  if (!answer) throw Error("unexpected missing tool");
  return answer;
}
async function jobPayload(key: string) {
  const before = await job();
  return {
    jobId: "vpass",
    source: "vpass",
    revision: Number(before.revision),
    enabled: before.enabled !== 1,
    timezone: before.timezone,
    pattern: JSON.parse(before.pattern_json as string),
    idempotencyKey: key,
  };
}
async function prepareJob(body: Awaited<ReturnType<typeof jobPayload>>, p: DelegatedPrincipal) {
  const prepared = await invoke("kogane.schedules.job.update", { ...body, step: "prepare" }, p);
  expect(prepared.status).toBe(200);
  return (prepared.body as { confirmation: { digest: string } }).confirmation.digest;
}
for (const kind of ["import", "collection"] as const)
  for (const order of ["job-first", "ops-first"] as const)
    test(
      "actual job writer shares rolling budget with " + kind + " in " + order + " order",
      async () => {
        const p = principal(kind + "-" + order);
        const body = await jobPayload("job-" + kind + "-" + order),
          before = await job();
        const revisions = await count(
          "SELECT count(*) n FROM collection_schedule_revisions WHERE schedule_id='vpass'",
        );
        const cfm = await prepareJob(body, p);
        const opsName =
          kind === "import" ? "kogane.ops.import.request" : "kogane.ops.collection.request";
        const opsBody =
          kind === "import"
            ? {
                source: "vpass",
                runId: "synthetic-run",
                idempotencyKey: "ops-" + kind + "-" + order,
              }
            : {
                source: "vpass",
                requestedScope: { from: "2026-10-01", to: "2026-10-02" },
                idempotencyKey: "ops-" + kind + "-" + order,
              };
        let opsCfm: string | undefined;
        if (kind === "collection") {
          const preparation = await invoke(opsName, { ...opsBody, step: "prepare" }, p);
          expect(preparation.status).toBe(200);
          opsCfm = (preparation.body as { confirmation: { digest: string } }).confirmation.digest;
        }
        const applyJob = () =>
          invoke(
            "kogane.schedules.job.update",
            { ...body, step: "confirm", confirmationDigest: cfm },
            p,
          );
        const applyOps = () =>
          invoke(
            opsName,
            kind === "import"
              ? opsBody
              : { ...opsBody, step: "confirm", confirmationDigest: opsCfm },
            p,
          );
        const winner = await (order === "job-first" ? applyJob() : applyOps());
        expect(winner.status).toBe(order === "job-first" ? 200 : 202);
        const loser = await (order === "job-first" ? applyOps() : applyJob());
        expect(loser.status).toBe(429);
        expect(loser.body).toEqual({ error: "delegation_budget_exceeded" });
        expect(
          await count(
            "SELECT count(*) n FROM audit_records WHERE principal=? AND principal_kind='delegated' AND result IN ('applied','accepted')",
            p.id,
          ),
        ).toBe(1);
        expect(
          await count(
            "SELECT count(*) n FROM audit_records WHERE principal=? AND result='refused' AND result_code='delegation_budget_exceeded'",
            p.id,
          ),
        ).toBe(1);
        expect(await count("SELECT count(*) n FROM ops_requests WHERE principal=?", p.id)).toBe(
          order === "ops-first" ? 1 : 0,
        );
        expect(
          await count(
            "SELECT count(*) n FROM collection_schedule_revisions WHERE schedule_id='vpass'",
          ),
        ).toBe(revisions + (order === "job-first" ? 1 : 0));
        if (order === "job-first") {
          expect(await job()).toMatchObject({ revision: body.revision + 1, updated_by: p.id });
          const record = await testEnv.DB.prepare(
            "SELECT * FROM audit_records WHERE principal=? AND result='applied'",
          )
            .bind(p.id)
            .first();
          expect(record).toMatchObject({
            subject: p.delegator,
            principal: p.id,
            principal_kind: "delegated",
            delegation_ref: p.delegationRef,
            path: "mcp",
            operation: "schedules.job.update",
            step: "confirm",
            target_ref: "schedule:vpass",
            scope_source: "vpass",
          });
          expect(record!.confirms_audit_id).toMatch(/^aud_/u);
        } else expect(await job()).toEqual(before);
      },
      60_000,
    );

test("actual completed job replay survives exhausted budget and later native revision without another relay or alarm", async () => {
  const p = principal("completed-retry");
  const body = await jobPayload("completed-job");
  const cfm = await prepareJob(body, p);
  const saved = await invoke(
    "kogane.schedules.job.update",
    { ...body, step: "confirm", confirmationDigest: cfm },
    p,
  );
  expect(saved.status).toBe(200);
  const human = new OperationCall("schedules.job.update", {
    path: "ui",
    subject: "cross-jobs-human",
    principal: "cross-jobs-human",
    principalKind: "human",
    correlationId: crypto.randomUUID(),
  });
  await updateSchedule(
    processor,
    "vpass",
    {
      revision: body.revision + 1,
      enabled: !body.enabled,
      timezone: "UTC",
      pattern: body.pattern,
    },
    "cross-jobs-human",
    human,
  );
  const current = await job(),
    relayCount = relays,
    alarmCount = alarms;
  const replay = await invoke(
    "kogane.schedules.job.update",
    { ...body, step: "confirm", confirmationDigest: cfm },
    p,
  );
  expect(replay.status).toBe(200);
  expect(replay.body).toEqual({
    saved: true,
    jobId: "vpass",
    revision: body.revision + 1,
    reservation: null,
    actualAlarmAt: null,
    replayed: true,
  });
  expect(await job()).toEqual(current);
  expect(relays).toBe(relayCount);
  expect(alarms).toBe(alarmCount);
  expect(
    await count(
      "SELECT count(*) n FROM audit_records WHERE principal=? AND result='applied'",
      p.id,
    ),
  ).toBe(1);
  expect(
    await count(
      "SELECT count(*) n FROM audit_records WHERE principal=? AND result='replayed'",
      p.id,
    ),
  ).toBe(1);
  const changed = await invoke(
    "kogane.schedules.job.update",
    { ...body, enabled: !body.enabled, step: "confirm", confirmationDigest: cfm },
    p,
  );
  expect(changed.body).toEqual({ error: "idempotency_conflict" });
  expect(await job()).toEqual(current);
}, 60_000);

test("concurrent actual job and import reservations cannot both spend the last principal write", async () => {
  const p = principal("concurrent-import");
  const body = await jobPayload("race-job"),
    cfm = await prepareJob(body, p);
  const before = await job();
  const snapshots = await count(
    "SELECT count(*) n FROM collection_schedule_revisions WHERE schedule_id='vpass'",
  );
  const results = await Promise.all([
    invoke("kogane.schedules.job.update", { ...body, step: "confirm", confirmationDigest: cfm }, p),
    invoke(
      "kogane.ops.import.request",
      { source: "vpass", runId: "synthetic-raced-run", idempotencyKey: "race-import" },
      p,
    ),
  ]);
  expect(results.filter((result) => result.status === 429)).toHaveLength(1);
  expect(results.filter((result) => result.status === 200 || result.status === 202)).toHaveLength(
    1,
  );
  expect(
    await count(
      "SELECT count(*) n FROM audit_records WHERE principal=? AND result IN ('applied','accepted')",
      p.id,
    ),
  ).toBe(1);
  expect(
    await count(
      "SELECT count(*) n FROM audit_records WHERE principal=? AND result='refused' AND result_code='delegation_budget_exceeded'",
      p.id,
    ),
  ).toBe(1);
  const jobWon = results[0]!.status === 200;
  expect(await count("SELECT count(*) n FROM ops_requests WHERE principal=?", p.id)).toBe(
    jobWon ? 0 : 1,
  );
  expect(
    await count("SELECT count(*) n FROM collection_schedule_revisions WHERE schedule_id='vpass'"),
  ).toBe(snapshots + (jobWon ? 1 : 0));
  if (!jobWon) expect(await job()).toEqual(before);
}, 60_000);

test("actual job budget follows the verified MCP principal across delegation revisions, while another principal has its own budget", async () => {
  const p = principal("declaration-revision");
  const body = await jobPayload("declaration-job"),
    cfm = await prepareJob(body, p);
  expect(
    (
      await invoke(
        "kogane.schedules.job.update",
        { ...body, step: "confirm", confirmationDigest: cfm },
        p,
      )
    ).status,
  ).toBe(200);
  const changedDeclaration = { ...p, delegationRef: "dlg_" + "e".repeat(64) };
  const refused = await invoke(
    "kogane.ops.import.request",
    {
      source: "vpass",
      runId: "synthetic-new-declaration",
      idempotencyKey: "after-new-declaration",
    },
    changedDeclaration,
  );
  expect(refused.status).toBe(429);
  expect(refused.body).toEqual({ error: "delegation_budget_exceeded" });
  expect(await count("SELECT count(*) n FROM ops_requests WHERE principal=?", p.id)).toBe(0);
  const other = principal("separate-owner");
  const accepted = await invoke(
    "kogane.ops.import.request",
    {
      source: "vpass",
      runId: "synthetic-other-owner",
      idempotencyKey: "after-new-declaration",
    },
    other,
  );
  expect(accepted.status).toBe(202);
  expect(await count("SELECT count(*) n FROM ops_requests WHERE principal=?", other.id)).toBe(1);
  expect(
    await count(
      "SELECT count(*) n FROM audit_records WHERE principal=? AND result IN ('applied','accepted')",
      p.id,
    ),
  ).toBe(1);
  expect(
    await count(
      "SELECT count(*) n FROM audit_records WHERE principal=? AND result IN ('applied','accepted')",
      other.id,
    ),
  ).toBe(1);
}, 60_000);
