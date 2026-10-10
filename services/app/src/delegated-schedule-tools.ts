// MCP settings prepare/confirm, through the existing native schedule writer.
import { z } from "zod";
import {
  assertDelegatedJobReversal,
  delegatedJobSchema,
  delegatedJobResultSchema,
  type DelegatedJobResult,
  delegatedCan,
  executionFor,
  d1CommandStore,
  prepareDelegatedOperation,
  confirmDelegatedOperation,
  replayDelegatedConfirmation,
  DelegatedOperationError,
  type DelegationResolution,
  type OperationCall,
  type DelegationCapability,
} from "../../../packages/application/src/index";
import { HttpError } from "./http";
import { parseRequest } from "./ops-api";
import { upstreamOutcome, UpstreamLost } from "./audit";
import type { ToolResult } from "./agent-service";
const TOOL = "kogane.schedules.job.update";
const CAPABILITY = "schedules.job.update";
export const EXECUTABLE_SCHEDULE_CAPABILITIES = [
  CAPABILITY,
] as const satisfies readonly DelegationCapability[];
export function delegatedSchedulesServed(env: Pick<Env, "SCHEDULES_ENABLED" | "PIPELINE">) {
  return (env.SCHEDULES_ENABLED as string | undefined) === "true" && !!env.PIPELINE;
}
export function isDelegatedScheduleTool(name: string): name is typeof TOOL {
  return name === TOOL;
}
export function delegatedScheduleTools(env: Env, resolution: DelegationResolution) {
  if (
    !delegatedSchedulesServed(env) ||
    !resolution.ok ||
    !resolution.principal.capabilities.includes(CAPABILITY)
  )
    return [];
  const inputSchema = z.toJSONSchema(delegatedJobSchema) as Record<string, unknown>;
  delete inputSchema["$schema"];
  return [
    {
      name: TOOL,
      title: "Prepare and confirm a schedule revision",
      description:
        "Read-only preparation of the exact source, current revision and change, then one confirmed write within ten minutes. The original job writer and atomic audit/budget guard are reused. Does not start a collection or release a lease; the existing writer still reconciles its normal alarm. A fresh saved response reports reservation pending/armed/disabled and the native actualAlarmAt. Saved does not mean armed. On an exact completed retry, replayed is true and reservation/actualAlarmAt are null because reservation was not re-observed.",
      inputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
  ];
}
export async function callDelegatedScheduleTool(
  name: typeof TOOL,
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
    if (name !== TOOL || !delegatedSchedulesServed(env))
      throw new HttpError(403, "schedules_disabled");
    const principal = resolution.principal;
    delegatedCan(principal, CAPABILITY);
    const parsed = parseRequest<z.infer<typeof delegatedJobSchema>>(delegatedJobSchema, body ?? {});
    const { step, confirmationDigest, idempotencyKey, revertsAuditId, ...payload } = parsed;
    const scope =
      payload.source === null
        ? null
        : { namespace: "schedule-source" as const, source: payload.source };
    audit.delegate(principal, {
      ...executionFor(principal, audit.operation, scope),
      ...(revertsAuditId ? { revertsAuditId } : {}),
    });
    const store = d1CommandStore(env.DB);
    const intent = {
      idempotencyKey,
      payload,
      targetRef: `schedule:${payload.jobId}`,
      scope,
      expectedRevision: payload.revision,
      ...(revertsAuditId ? { revertsAuditId } : {}),
    };
    if (step === "prepare" && confirmationDigest) throw new HttpError(400, "invalid_request");
    if (step === "confirm") {
      if (!confirmationDigest) throw new DelegatedOperationError("confirmation_required");
      const replay = await replayDelegatedConfirmation(
        store,
        audit,
        principal,
        CAPABILITY,
        intent,
        confirmationDigest,
      );
      if (replay)
        return {
          status: 200,
          body: {
            saved: true,
            jobId: payload.jobId,
            revision: payload.revision + 1,
            reservation: null,
            actualAlarmAt: null,
            replayed: true,
          } satisfies DelegatedJobResult,
          auditOutcome: {
            result: "replayed",
            targetRef: replay.target_ref,
            scope,
            refs: JSON.parse(replay.refs_json) as string[],
          },
        };
    }
    // A completed exact replay is read-only even after its own reverse advanced revision.
    if (revertsAuditId)
      await assertDelegatedJobReversal(
        store,
        principal.delegator,
        principal.id,
        payload,
        revertsAuditId,
      );
    const relay = async (phase: "preview" | "apply"): Promise<ToolResult> => {
      let response: Response, text: string;
      try {
        response = await env.PIPELINE.fetch(
          new Request("https://observation-pipeline.internal/internal/delegated-schedules/job", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-kogane-internal-caller": "kogane-evidence-browser",
              "x-kogane-verified-actor": principal.id,
              "x-kogane-actor-kind": "delegated",
              ...audit.envelopeHeaders(),
            },
            body: JSON.stringify({ phase, payload }),
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
      if (phase === "apply" && response.ok) {
        const saved = delegatedJobResultSchema.safeParse(result);
        if (
          !saved.success ||
          saved.data.replayed ||
          saved.data.jobId !== payload.jobId ||
          saved.data.revision !== payload.revision + 1
        )
          throw new UpstreamLost(503, "scheduling_unavailable");
        result = saved.data;
      }
      return {
        status: response.status,
        body: result,
        ...(phase === "apply"
          ? {
              auditOutcome: upstreamOutcome(response.status, response.headers, text, {
                result: "replayed",
                targetRef: intent.targetRef,
              }),
            }
          : {}),
      };
    };
    if (step === "prepare") {
      const preview = await relay("preview");
      if (preview.status !== 200) return preview;
      const used = await store.first<{ n: number }>(
        "SELECT count(*) n FROM audit_records WHERE principal=? AND principal_kind='delegated' AND result IN ('applied','accepted') AND recorded_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-24 hours')",
        [principal.id],
      );
      const prepared = await prepareDelegatedOperation(
        store,
        audit,
        principal,
        CAPABILITY,
        intent,
        payload.revision,
      );
      return {
        status: 200,
        body: {
          ...prepared,
          preview: {
            ...prepared.preview,
            ...(preview.body as Record<string, unknown>),
            budgetRemaining: Math.max(0, principal.budget.writesPerDay - (used?.n ?? 0)),
            revertAvailable: true,
          },
        },
      };
    }
    await confirmDelegatedOperation(
      store,
      audit,
      principal,
      CAPABILITY,
      intent,
      confirmationDigest!,
    );
    return await relay("apply");
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
