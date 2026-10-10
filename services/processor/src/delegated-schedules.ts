// A private delegated adapter; all effects still use the existing schedule writer.
import {
  assertDelegatedJobReversal,
  delegatedJobPayloadSchema,
  delegatedJobResultSchema,
  parseAuditEnvelope,
  processorCall,
  d1CommandStore,
  AUDIT_RECORDED_HEADER,
  delegatedBatchFailure,
  DelegatedOperationError,
  type OperationCall,
} from "../../../packages/application/src/index";
import { canonicalDigest } from "../../../packages/domain/src/context";
import { jobFor, readSchedule, updateSchedule, ScheduleError } from "./schedule-store";
export async function delegatedScheduleRoute(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/internal/delegated-schedules")) return null;
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
    if (url.search || url.pathname !== "/internal/delegated-schedules/job")
      throw new ScheduleError("invalid_request");
    if (request.method !== "POST") throw new ScheduleError("method_not_allowed", 405);
    const actor = request.headers.get("x-kogane-verified-actor");
    const envelope = parseAuditEnvelope(request.headers);
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
    audit = processorCall(envelope, "schedules.job.update", actor, "delegated");
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > 16 * 1024)
      throw new ScheduleError("request_too_large", 413);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new ScheduleError("invalid_request");
    }
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some((k) => !["phase", "payload"].includes(k)) ||
      (body.phase !== "preview" && body.phase !== "apply")
    )
      throw new ScheduleError("invalid_request");
    const parsed = delegatedJobPayloadSchema.safeParse(body.payload);
    if (!parsed.success) throw new ScheduleError("invalid_request");
    const payload = parsed.data;
    if (
      !auth.schedule ||
      auth.schedule.operation !== "schedules.job.update" ||
      auth.schedule.source !== payload.source
    )
      throw new ScheduleError("source_not_granted", 403);
    const job = jobFor(payload.jobId);
    if (job.source !== payload.source) throw new ScheduleError("schedule_not_found", 404);
    const row = await readSchedule(env.DB, payload.jobId);
    if (!row.supported) throw new ScheduleError("schedule_not_supported", 409);
    if (row.revision !== payload.revision) throw new ScheduleError("revision_conflict", 409);
    if ((row.kind === "collection") !== (payload.pattern.kind === "daily"))
      throw new ScheduleError("invalid_request");
    if (auth.revertsAuditId)
      await assertDelegatedJobReversal(
        d1CommandStore(env.DB),
        actor.slice("mcp-client:".length),
        audit.actor.principal,
        payload,
        auth.revertsAuditId,
      );
    if (body.phase === "preview")
      return Response.json({
        jobId: payload.jobId,
        source: row.source,
        currentRevision: row.revision,
        before: {
          enabled: row.enabled === 1,
          timezone: row.timezone,
          pattern: JSON.parse(row.pattern_json) as unknown,
        },
        after: { enabled: payload.enabled, timezone: payload.timezone, pattern: payload.pattern },
      });
    if (
      !auth.confirmsAuditId ||
      !auth.confirmationDigest ||
      !auth.idempotencyKey ||
      auth.payloadDigest !==
        (await canonicalDigest({
          v: "kogane-delegated-payload-v1",
          operation: audit.operation,
          payload,
        }))
    )
      throw new DelegatedOperationError("confirmation_invalid");
    const saved = await updateSchedule(
      env,
      payload.jobId,
      {
        revision: payload.revision,
        enabled: payload.enabled,
        timezone: payload.timezone,
        pattern: payload.pattern,
      },
      actor,
      audit,
    );
    const result = delegatedJobResultSchema.safeParse({
      saved: true,
      jobId: payload.jobId,
      revision: saved.revision,
      reservation: saved.reservation,
      actualAlarmAt: saved.actualAlarmAt,
      replayed: false,
    });
    if (!result.success) throw new ScheduleError("scheduling_unavailable", 503);
    const response = Response.json(result.data);
    if (!audit.recorded) throw new ScheduleError("audit_record_failed", 503);
    response.headers.set(AUDIT_RECORDED_HEADER, "1");
    return response;
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
