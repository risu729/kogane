// Private binding adapter for a delegated survey decision (ADR 0050 as amended
// 2026-11-07, ADR 0063). The decision is the screen's own `decideSurveyProposal`
// and an acceptance goes through the one maintenance writer; this route only
// verifies the delegated envelope and hands it the verified decision.
import { z } from "zod";
import {
  delegatedSurveyPayloadSchema,
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
  maintenanceRules,
  prepareMaintenanceRevision,
  writeMaintenanceRevision,
  ScheduleError,
  type MaintenanceWriteOptions,
} from "./schedule-store";
import { decideSurveyProposal } from "./maintenance-survey/decisions";
import { boundedText, INTERNAL_BODY_LIMIT } from "./bounded-body";
const schema = z.strictObject({
  step: z.enum(["apply", "prepare", "confirm"]),
  payload: delegatedSurveyPayloadSchema,
});
function refusal(error: unknown): Response {
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
export async function delegatedSurveyRoute(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response | null> {
  if (url.pathname !== "/internal/delegated-survey") return null;
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
    audit = processorCall(envelope, "schedules.survey.decide", actor, "delegated");
    const text = await boundedText(request, INTERNAL_BODY_LIMIT);
    if (text === null) throw new ScheduleError("request_too_large", 413);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new ScheduleError("invalid_request");
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new ScheduleError("invalid_request");
    const { step, payload } = parsed.data;
    if ((payload.decision === "reject") !== (step === "apply"))
      throw new ScheduleError("invalid_request");
    if (
      auth.schedule?.operation !== "schedules.survey.decide" ||
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
    const call = audit;
    const store = d1CommandStore(env.DB);
    const response = await decideSurveyProposal(
      env,
      payload.proposalId,
      { decision: payload.decision },
      actor,
      writeMaintenanceRevision,
      call,
      {
        source: payload.source,
        step,
        ...(payload.decision === "accept" ? { baseRevision: payload.baseRevision } : {}),
        // A confirm cites the prepare record that authorized it; a prepare
        // validates against a reference of the same shape and writes nothing.
        ...(payload.decision === "accept"
          ? {
              decisionRef: `delegated-audit:${step === "confirm" ? auth.confirmsAuditId! : call.reserveAuditId()}`,
            }
          : {}),
        // The trusted options of an R2 acceptance: the confirmed 31-day bound,
        // and the proposal, which alone lets a delegated actor give the
        // survey's reason and create its derived rule id.
        writerOptions: (proposal): MaintenanceWriteOptions => ({
          deferralBound: "confirmed-31d",
          surveyProposal: proposal,
        }),
        prepare: prepareMaintenanceRevision,
        rules: (source) => maintenanceRules(env.DB, source),
        batchFailure: async () => {
          const error = await delegatedBatchFailure(store, call);
          return error ? refusal(error) : null;
        },
      },
    );
    if (step === "prepare" || !response.ok) return response;
    if (!call.recorded) throw new ScheduleError("audit_record_failed", 503);
    const result = (await response.json()) as Record<string, unknown>;
    return Response.json(
      { ...result, replayed: false },
      { headers: { [AUDIT_RECORDED_HEADER]: "1" } },
    );
  } catch (caught) {
    let error = caught;
    if (audit && !(error instanceof ScheduleError) && !(error instanceof DelegatedOperationError))
      error = (await delegatedBatchFailure(d1CommandStore(env.DB), audit)) ?? error;
    return refusal(error);
  }
}
