// Private binding adapter. The maintenance writer remains the only domain writer.
import { z } from "zod";
import {
  delegatedMaintenancePayloadSchema,
  parseAuditEnvelope,
  processorCall,
  d1CommandStore,
  AUDIT_RECORDED_HEADER,
  delegatedBatchFailure,
  DelegatedOperationError,
  type OperationCall,
} from "../../../packages/application/src/index";
import { canonicalDigest } from "../../../packages/domain/src/context";
import {
  prepareMaintenanceRevision,
  writeMaintenanceRevision,
  ScheduleError,
  type MaintenanceWrite,
} from "./schedule-store";
const schema = z.strictObject({
  step: z.enum(["apply", "prepare", "confirm"]),
  payload: delegatedMaintenancePayloadSchema,
});
export async function delegatedMaintenanceRoute(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response | null> {
  if (url.pathname !== "/internal/delegated-maintenance") return null;
  if (
    request.headers.has("cf-connecting-ip") ||
    request.headers.get("x-kogane-internal-caller") !== "kogane-evidence-browser" ||
    request.headers.has("x-kogane-operator") ||
    request.headers.has("x-kogane-agent") ||
    (env.SCHEDULES_ENABLED as string | undefined) !== "true"
  )
    return Response.json({ error: "service_binding_required" }, { status: 403 });
  let audit: OperationCall | undefined;
  try {
    if (url.search) throw new ScheduleError("invalid_request");
    if (request.method !== "POST") throw new ScheduleError("method_not_allowed", 405);
    const actor = request.headers.get("x-kogane-verified-actor"),
      envelope = parseAuditEnvelope(request.headers);
    if (
      !actor ||
      !/^mcp-client:[A-Za-z0-9._:@-]+$/u.test(actor) ||
      actor.length > 200 ||
      request.headers.get("x-kogane-actor-kind") !== "delegated" ||
      !envelope?.delegatedExecution
    )
      throw new ScheduleError("delegation_required", 403);
    const auth = envelope.delegatedExecution;
    if (auth.notAfter <= new Date().toISOString())
      throw new DelegatedOperationError("delegation_expired");
    audit = processorCall(envelope, "schedules.maintenance.update", actor, "delegated");
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > 16 * 1024)
      throw new ScheduleError("request_too_large", 413);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new ScheduleError("invalid_request");
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new ScheduleError("invalid_request");
    const { step, payload } = parsed.data;
    if (
      auth.schedule?.operation !== "schedules.maintenance.update" ||
      auth.schedule.source !== payload.source
    )
      throw new ScheduleError("source_not_granted", 403);
    audit.setRisk(step === "apply" ? "R1" : "R2");
    if (step === "prepare") audit.setStep("prepare");
    if (step === "confirm" ? !auth.confirmsAuditId : !!auth.confirmsAuditId)
      throw new DelegatedOperationError("confirmation_invalid");
    if (
      step !== "prepare" &&
      (!auth.idempotencyKey ||
        auth.payloadDigest !==
          (await canonicalDigest({
            v: "kogane-delegated-payload-v1",
            operation: audit.operation,
            payload,
          })))
    )
      throw new DelegatedOperationError("idempotency_required");
    const write: MaintenanceWrite = {
      source: payload.source,
      ruleId: payload.ruleId ?? null,
      expectedRevision: payload.revision,
      change: {
        timezone: payload.timezone,
        pattern: payload.pattern,
        enabled: payload.enabled,
        scope: payload.scope,
      },
      provenance: {
        referenceUrl: payload.referenceUrl,
        verifiedAt: payload.verifiedAt,
        decisionRef: `delegated-audit:${step === "confirm" ? auth.confirmsAuditId! : audit.reserveAuditId()}`,
      },
      actor: { kind: "delegated", id: actor },
      reason: payload.reason,
    };
    // Only a confirmed private call can write with the wider bound. Preview never writes.
    const options = {
      deferralBound: step === "apply" ? ("delegated-7d" as const) : ("confirmed-31d" as const),
    };
    if (step === "prepare") {
      const preview = await prepareMaintenanceRevision(env, write, options);
      return preview.ok
        ? Response.json(preview)
        : Response.json({ error: preview.code }, { status: preview.status });
    }
    const call = audit;
    const result = await writeMaintenanceRevision(
      env,
      write,
      (revision) => {
        const ref = `maintenance-rule:${revision.ruleId}@${revision.revision}`;
        const record = call.effect(
          {
            targetRef: payload.ruleId
              ? `maintenance-rule:${payload.ruleId}`
              : `source:${payload.source}`,
            refs: [ref],
            scope: { namespace: "schedule-source", source: payload.source },
            reasonCode: revision.reason,
            diff: {
              kind: "revision",
              from: revision.previous,
              to: revision.revision,
              fields: revision.fields,
            },
          },
          revision.guard,
          { kind: "target-ref", ref },
        );
        return {
          statements: [env.DB.prepare(record.sql).bind(...record.binds)],
          settle: (results) => call.settle(results[0]?.meta.changes),
        };
      },
      options,
    );
    if (!result.ok) throw new ScheduleError(result.code, result.status);
    if (!audit.recorded) throw new ScheduleError("audit_record_failed", 503);
    return Response.json(
      {
        saved: true,
        ruleId: result.ruleId,
        revision: result.revision,
        reconciliation: result.reconciled ? "completed" : "pending",
        replayed: false,
      },
      { headers: { [AUDIT_RECORDED_HEADER]: "1" } },
    );
  } catch (caught) {
    let error = caught;
    if (audit && !(error instanceof ScheduleError) && !(error instanceof DelegatedOperationError))
      error = (await delegatedBatchFailure(d1CommandStore(env.DB), audit)) ?? error;
    if (error instanceof DelegatedOperationError)
      return Response.json(
        { error: error.code },
        { status: error.code === "delegation_budget_exceeded" ? 429 : 403 },
      );
    return Response.json(
      { error: error instanceof ScheduleError ? error.code : "scheduling_unavailable" },
      { status: error instanceof ScheduleError ? error.status : 503 },
    );
  }
}
