// Public intent only: authority, audit references and deferral options are server-owned.
import { z } from "zod";
import {
  delegatedMaintenanceSchema,
  delegatedMaintenanceResultSchema,
  executionFor,
  d1CommandStore,
  bindDelegatedWrite,
  prepareDelegatedOperation,
  confirmDelegatedOperation,
  replayDelegatedConfirmation,
  DelegatedOperationError,
  type DelegationResolution,
  type OperationCall,
} from "../../../packages/application/src/index";
import { HttpError } from "./http";
import { parseRequest } from "./ops-api";
import { upstreamOutcome, UpstreamLost } from "./audit";
import { delegatedSchedulesServed } from "./delegated-schedule-tools";
import type { ToolResult } from "./agent-service";
const CAPABILITY = "schedules.maintenance.update";
export function delegatedMaintenanceTools(env: Env, resolution: DelegationResolution) {
  if (
    !delegatedSchedulesServed(env) ||
    !resolution.ok ||
    !resolution.principal.capabilities.includes(CAPABILITY)
  )
    return [];
  const inputSchema = z.toJSONSchema(delegatedMaintenanceSchema) as Record<string, unknown>;
  delete inputSchema["$schema"];
  return [
    {
      name: "kogane.schedules.maintenance.update",
      title: "Apply or confirm a maintenance revision",
      description:
        "Apply within the seven-day bound, or prepare and confirm within ten minutes up to 31 days. Reuses the versioned writer, source scope, audit and rolling budgets. Saved and alarm reconciliation are separate; an exact retry returns the saved revision and null reconciliation without reconciling again.",
      inputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
  ];
}
export async function callDelegatedMaintenanceTool(
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
    const parsed = parseRequest<z.infer<typeof delegatedMaintenanceSchema>>(
      delegatedMaintenanceSchema,
      body ?? {},
    );
    const { step, idempotencyKey, confirmationDigest, ...payload } = parsed;
    if (step !== "confirm" && confirmationDigest) throw new HttpError(400, "invalid_request");
    const scope = { namespace: "schedule-source" as const, source: payload.source };
    if (
      principal.scopes.scheduleSources !== "*" &&
      !principal.scopes.scheduleSources.includes(payload.source)
    )
      throw new HttpError(403, "source_not_granted");
    // Scope must be resolved even before a completed receipt may be read.
    audit.delegate(principal, executionFor(principal, CAPABILITY, scope));
    audit.setRisk(step === "apply" ? "R1" : "R2");
    const store = d1CommandStore(env.DB);
    const intent = {
      idempotencyKey,
      payload,
      scope,
      expectedRevision: payload.revision,
      targetRef: payload.ruleId ? `maintenance-rule:${payload.ruleId}` : `source:${payload.source}`,
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
      const match =
        refs.length === 1 ? /^maintenance-rule:([a-z0-9-]+)@([0-9]+)$/u.exec(refs[0]!) : null;
      if (!match) throw new UpstreamLost(503, "scheduling_unavailable");
      return {
        status: 200,
        body: {
          saved: true,
          ruleId: match[1],
          revision: Number(match[2]),
          replayed: true,
          reconciliation: null,
        },
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
        new Request("https://observation-pipeline.internal/internal/delegated-maintenance", {
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
    if (step === "prepare" && response.ok) {
      const preview = z
        .strictObject({
          ok: z.literal(true),
          source: z.string(),
          ruleId: z.string().nullable(),
          expectedRevision: z.int(),
          currentRevision: z.int(),
          deferralClass: z.enum(["within-7d", "within-31d"]),
          budgetRemaining: z.int(),
        })
        .safeParse(result);
      if (
        !preview.success ||
        preview.data.source !== payload.source ||
        preview.data.ruleId !== (payload.ruleId ?? null) ||
        preview.data.currentRevision !== payload.revision ||
        preview.data.expectedRevision !== payload.revision
      )
        throw new UpstreamLost(503, "scheduling_unavailable");
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
        preview.data.currentRevision,
      );
      return {
        status: 200,
        body: {
          ...prepared,
          preview: {
            ...prepared.preview,
            ...preview.data,
            budgetRemaining: Math.min(
              preview.data.budgetRemaining,
              Math.max(0, principal.budget.writesPerDay - (used?.n ?? 0)),
            ),
          },
        },
      };
    }
    if (step !== "prepare" && response.ok) {
      const saved = delegatedMaintenanceResultSchema.safeParse(result);
      if (
        !saved.success ||
        saved.data.replayed ||
        saved.data.revision !== payload.revision + 1 ||
        (payload.ruleId && saved.data.ruleId !== payload.ruleId)
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
              targetRef: intent.targetRef,
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
