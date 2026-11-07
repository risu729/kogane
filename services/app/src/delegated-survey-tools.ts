// `kogane.schedules.survey.decide` on `/mcp` (ADR 0050 as amended 2026-11-07,
// ADR 0063, ADR 0081): the schedules page's 採用 / 却下 of one re-survey
// proposal, for a principal whose resolved delegation holds
// `schedules.survey.decide`. The decision is the Processor's
// `decideSurveyProposal`, reached over the private `/internal/delegated-survey`
// route; this adapter checks authority, binds the key or the confirmation and
// runs no SQL of its own.
import { z } from "zod";
import {
  delegatedSurveySchema,
  delegatedSurveyResultSchema,
  executionFor,
  d1CommandStore,
  bindDelegatedWrite,
  prepareDelegatedOperation,
  confirmDelegatedOperation,
  replayDelegatedConfirmation,
  DelegatedOperationError,
  delegatedWritesRemaining,
  OPERATOR_ONLY_HEADER,
  type DelegatedSurveyPayload,
  type DelegationResolution,
  type OperationCall,
} from "../../../packages/application/src/index";
import { HttpError } from "./http";
import { parseRequest } from "./ops-api";
import { upstreamOutcome, UpstreamLost } from "./audit";
import { delegatedSchedulesServed } from "./delegated-schedule-tools";
import type { ToolResult } from "./agent-service";
import { mcpInputSchema } from "./mcp-input-schema";
const SURVEY_DECIDE_TOOL = "kogane.schedules.survey.decide";
const CAPABILITY = "schedules.survey.decide";
export const EXECUTABLE_SURVEY_CAPABILITIES = [CAPABILITY] as const;
export function isDelegatedSurveyTool(name: string): name is typeof SURVEY_DECIDE_TOOL {
  return name === SURVEY_DECIDE_TOOL;
}
export function delegatedSurveyTools(env: Env, resolution: DelegationResolution) {
  if (
    !delegatedSchedulesServed(env) ||
    !resolution.ok ||
    !resolution.principal.capabilities.includes(CAPABILITY)
  )
    return [];
  const inputSchema = mcpInputSchema(delegatedSurveySchema);
  return [
    {
      name: SURVEY_DECIDE_TOOL,
      title: "Accept or reject a maintenance re-survey proposal",
      description:
        "Reject one proposal in one call (step apply, R1), or accept it by prepare then confirm within ten minutes against its baseRevision (R2). Read proposals with kogane.schedules.survey.read. An acceptance is one maintenance revision through the shared writer, under the delegated 31-day deferral ceiling and daily caps; a proposal carrying rule_absent_from_page, rule_disabled_by_operator, ambiguous_rule_match, cancellation_stated or contradictory_windows is refused operation_not_delegable and stays with the operator. Rejection is final for that reading. An exact retry answers replayed true without writing again.",
      inputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
  ];
}
/** The replayed answer, read back from the earlier effect's own record. */
function replayed(payload: DelegatedSurveyPayload, refs: readonly string[]) {
  if (payload.decision === "reject") return { decided: "rejected" as const, replayed: true };
  const match =
    refs.length === 1 ? /^maintenance-rule:([a-z0-9-]+)@([1-9][0-9]*)$/u.exec(refs[0]!) : null;
  if (!match) throw new UpstreamLost(503, "scheduling_unavailable");
  return {
    decided: "accepted" as const,
    ruleId: match[1]!,
    revision: Number(match[2]),
    reservation: null,
    replayed: true,
  };
}
export async function callDelegatedSurveyTool(
  body: unknown,
  env: Env,
  resolution: DelegationResolution,
  audit: OperationCall,
): Promise<ToolResult> {
  if (!resolution.ok)
    return {
      status: resolution.code === "delegation_misconfigured" ? 503 : 403,
      body: { error: resolution.code },
    };
  try {
    if (!delegatedSchedulesServed(env)) throw new HttpError(403, "schedules_disabled");
    const principal = resolution.principal;
    if (!principal.capabilities.includes(CAPABILITY))
      throw new HttpError(403, "delegation_capability_denied");
    const parsed = parseRequest<z.infer<typeof delegatedSurveySchema>>(
      delegatedSurveySchema,
      body ?? {},
    );
    const step = parsed.step;
    const idempotencyKey = parsed.idempotencyKey;
    const confirmationDigest = parsed.decision === "accept" ? parsed.confirmationDigest : undefined;
    if (step !== "confirm" && confirmationDigest) throw new HttpError(400, "invalid_request");
    const payload: DelegatedSurveyPayload =
      parsed.decision === "reject"
        ? { decision: "reject", source: parsed.source, proposalId: parsed.proposalId }
        : {
            decision: "accept",
            source: parsed.source,
            proposalId: parsed.proposalId,
            baseRevision: parsed.baseRevision,
          };
    const scope = { namespace: "schedule-source" as const, source: payload.source };
    if (
      principal.scopes.scheduleSources !== "*" &&
      !principal.scopes.scheduleSources.includes(payload.source)
    )
      throw new HttpError(403, "source_not_granted");
    // Scope is resolved before a completed receipt may be read.
    audit.delegate(principal, executionFor(principal, CAPABILITY, scope));
    audit.setRisk(step === "apply" ? "R1" : "R2");
    const store = d1CommandStore(env.DB);
    const targetRef = `maintenance-survey-proposal:${payload.proposalId}`;
    const intent = {
      idempotencyKey,
      payload,
      scope,
      targetRef,
      ...(payload.decision === "accept" ? { expectedRevision: payload.baseRevision } : {}),
    };
    const replay =
      step === "apply"
        ? await bindDelegatedWrite(store, audit, principal, {
            capability: CAPABILITY,
            idempotencyKey,
            payload,
            scope,
          })
        : step === "confirm"
          ? await replayDelegatedConfirmation(
              store,
              audit,
              principal,
              CAPABILITY,
              intent,
              confirmationDigest ?? "",
            )
          : null;
    if (replay) {
      const refs = JSON.parse(replay.refs_json) as string[];
      return {
        status: 200,
        body: replayed(payload, refs),
        auditOutcome: { result: "replayed", targetRef: replay.target_ref, scope, refs },
      };
    }
    if (step === "confirm") {
      if (!confirmationDigest) throw new DelegatedOperationError("confirmation_required");
      await confirmDelegatedOperation(
        store,
        audit,
        principal,
        CAPABILITY,
        intent,
        confirmationDigest,
      );
    }
    let response: Response, text: string;
    try {
      response = await env.PIPELINE.fetch(
        new Request("https://observation-pipeline.internal/internal/delegated-survey", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-kogane-internal-caller": "kogane-evidence-browser",
            "x-kogane-verified-actor": principal.id,
            "x-kogane-actor-kind": "delegated",
            ...audit.envelopeHeaders(),
          },
          body: JSON.stringify({ step, payload }),
        }),
      );
      text = await response.text();
    } catch {
      throw new UpstreamLost(503, "scheduling_unavailable");
    }
    let result: unknown;
    try {
      result = JSON.parse(text);
    } catch {
      throw new UpstreamLost(503, "scheduling_unavailable");
    }
    // An acceptance the owner kept with the operator is recorded at R3; the
    // Processor marks that refusal apart from any other `operation_not_delegable`.
    if (
      response.status === 403 &&
      response.headers.get(OPERATOR_ONLY_HEADER) === "1" &&
      (result as { error?: unknown } | null)?.error === "operation_not_delegable"
    )
      audit.setRisk("R3");
    if (step === "prepare" && payload.decision === "accept" && response.ok) {
      const preview = z
        .strictObject({
          ok: z.literal(true),
          proposalId: z.int(),
          source: z.string(),
          kind: z.enum(["new", "changed", "absent"]),
          status: z.enum(["proposed", "review_pending"]),
          reasons: z.array(z.string()),
          ruleId: z.string(),
          baseRevision: z.int(),
          currentRevision: z.int(),
          change: z.record(z.string(), z.unknown()),
          deferralClass: z.enum(["within-7d", "within-31d"]),
          budgetRemaining: z.int(),
        })
        .safeParse(result);
      if (
        !preview.success ||
        preview.data.proposalId !== payload.proposalId ||
        preview.data.source !== payload.source ||
        preview.data.baseRevision !== payload.baseRevision ||
        preview.data.currentRevision !== payload.baseRevision
      )
        throw new UpstreamLost(503, "scheduling_unavailable");
      const prepared = await prepareDelegatedOperation(
        store,
        audit,
        principal,
        CAPABILITY,
        intent,
        preview.data.currentRevision,
      );
      return {
        status: 200,
        body: {
          ...prepared,
          preview: {
            ...prepared.preview,
            ...preview.data,
            // The tighter of the writer's daily cap and the delegation's own budget.
            budgetRemaining: Math.min(
              preview.data.budgetRemaining,
              await delegatedWritesRemaining(store, principal),
            ),
            // Undoing an acceptance is a further maintenance revision: the
            // operator's, or kogane.schedules.maintenance.update within its bounds.
            revert: "maintenance-revision",
          },
        },
      };
    }
    if (step !== "prepare" && response.ok) {
      const saved = delegatedSurveyResultSchema.safeParse(result);
      if (
        !saved.success ||
        saved.data.replayed ||
        saved.data.decided !== (payload.decision === "accept" ? "accepted" : "rejected") ||
        // An acceptance wrote the revision after the one it was prepared against.
        (saved.data.decided === "accepted" &&
          payload.decision === "accept" &&
          saved.data.revision !== payload.baseRevision + 1)
      )
        throw new UpstreamLost(503, "scheduling_unavailable");
      result = saved.data;
    }
    return {
      status: response.status,
      body: result,
      ...(step === "prepare"
        ? {}
        : {
            auditOutcome: upstreamOutcome(response.status, response.headers, text, {
              result: "replayed",
              targetRef,
            }),
          }),
    };
  } catch (error) {
    if (error instanceof DelegatedOperationError)
      return {
        status: error.code === "delegation_budget_exceeded" ? 429 : 403,
        body: { error: error.code },
      };
    if (error instanceof HttpError && !(error instanceof UpstreamLost))
      return { status: error.status, body: { error: error.code } };
    throw error;
  }
}
