// R2 MCP decisions share the owner's immutable plan, approval and commit services.
import { z } from "zod";
import { AUDIT_ID } from "../../../packages/application/src/audit/vocabulary";
import {
  confirmDelegatedOperation,
  assertDelegatedReversal,
  prepareDelegatedOperation,
  delegatedCan,
  DelegatedOperationError,
  d1CommandStore,
  executionFor,
  loadPlan,
  readOwnApproval,
  simulate,
  getReceipt,
  statusForCommandError,
  replayDelegatedConfirmation,
  type DelegationCapability,
  type DelegationResolution,
  type OperationCall,
} from "../../../packages/application/src/index";
import type { ToolResult } from "./agent-service";
import { HttpError } from "./http";
import { parseRequest } from "./ops-api";
import { commandsEnabled } from "./command-api";
import { upstreamOutcome, UpstreamLost } from "./audit";

const ID = z.string().regex(/^[0-9a-f]{64}$/u);
const KEY = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const CFM = z.string().regex(/^cfm_[0-9a-f]{64}$/u);
const common = { step: z.enum(["prepare", "confirm"]), confirmationDigest: CFM.optional() };
const schemas = {
  "kogane.command.approve": z.strictObject({
    ...common,
    planId: ID,
    planDigest: ID,
    scope: z.array(z.string().min(1).max(512)).max(50).default([]),
    idempotencyKey: KEY,
  }),
  "kogane.command.commit": z.strictObject({
    ...common,
    planId: ID,
    approvalId: z.string().regex(/^ap_[0-9a-f]{64}$/u),
    operationId: KEY,
    revertsAuditId: z.string().regex(AUDIT_ID).optional(),
  }),
};
export type DelegatedDecisionTool = keyof typeof schemas;
export const EXECUTABLE_DECISION_CAPABILITIES = [
  "commands.decide.card-settlement",
  "commands.decide.relation",
  "commands.decide.identity",
] as const satisfies readonly DelegationCapability[];
export function isDelegatedDecisionTool(name: string): name is DelegatedDecisionTool {
  return Object.hasOwn(schemas, name);
}
const descriptors = Object.entries(schemas).map(([name, schema]) => {
  const inputSchema = z.toJSONSchema(schema) as Record<string, unknown>;
  delete inputSchema["$schema"];
  return {
    name,
    title: name.slice(7),
    description:
      "Prepare a pinned owner-equivalent decision, then confirm its exact digest within ten minutes. Preparation changes no adopted state. Reversal is a new explicit decision, never deletion of history.",
    inputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  };
});
export function delegatedDecisionTools(env: Env, resolution: DelegationResolution) {
  return commandsEnabled(env) &&
    env.PIPELINE &&
    resolution.ok &&
    EXECUTABLE_DECISION_CAPABILITIES.some((c) => resolution.principal.capabilities.includes(c))
    ? descriptors
    : [];
}
function capability(kind: string): DelegationCapability {
  const family = kind.split(".")[0];
  if (family === "identity" || family === "relation" || family === "card-settlement")
    return `commands.decide.${family}`;
  throw new DelegatedOperationError("operation_not_delegable");
}
export async function callDelegatedDecisionTool(
  name: DelegatedDecisionTool,
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
    if (!commandsEnabled(env)) throw new HttpError(403, "commands_disabled");
    const principal = resolution.principal;
    if (!EXECUTABLE_DECISION_CAPABILITIES.some((c) => principal.capabilities.includes(c)))
      throw new DelegatedOperationError("capability_not_delegated");
    if (!env.PIPELINE || typeof env.PIPELINE.fetch !== "function")
      throw new HttpError(503, "command_executor_unavailable");
    const parsed = parseRequest<z.infer<(typeof schemas)[DelegatedDecisionTool]>>(
      schemas[name],
      body ?? {},
    );
    audit.delegate(principal, executionFor(principal));
    const store = d1CommandStore(env.DB);
    const plan = await loadPlan(store, parsed.planId);
    if (!plan) throw new HttpError(404, "plan_not_found");
    const cap = capability(plan.kind);
    delegatedCan(principal, cap);
    const { step, confirmationDigest, ...payload } = parsed;
    const key = "operationId" in payload ? payload.operationId : payload.idempotencyKey;
    const revertsAuditId = "revertsAuditId" in payload ? payload.revertsAuditId : undefined;
    const intent = {
      idempotencyKey: key,
      payload,
      targetRef: `plan:${plan.planId}`,
      scope: null,
      ...(revertsAuditId ? { revertsAuditId } : {}),
    };
    if (step === "prepare" && confirmationDigest) throw new HttpError(400, "invalid_request");
    if (step === "confirm") {
      if (!confirmationDigest) throw new DelegatedOperationError("confirmation_required");
      const replay = await replayDelegatedConfirmation(
        store,
        audit,
        principal,
        cap,
        intent,
        confirmationDigest,
      );
      if (replay) {
        let result: unknown;
        if (name === "kogane.command.approve") {
          const approval = await readOwnApproval(
            store,
            principal.id,
            (JSON.parse(replay.refs_json) as string[])
              .find((r) => r.startsWith("approval:"))
              ?.slice(9) ?? "",
          );
          if (!approval) throw new HttpError(404, "approval_not_found");
          result = { approval, plan };
        } else {
          const receipt = await getReceipt(
            store,
            principal.id,
            "operationId" in payload ? payload.operationId : "",
          );
          if (!receipt.ok) throw new HttpError(statusForCommandError(receipt.error), receipt.error);
          result = { receipt: receipt.receipt, replayed: true };
        }
        return {
          status: 200,
          body: result,
          auditOutcome: {
            result: "replayed",
            targetRef: replay.target_ref,
            refs: JSON.parse(replay.refs_json) as string[],
          },
        };
      }
    }
    if (revertsAuditId)
      await assertDelegatedReversal(store, principal.delegator, principal.id, plan, revertsAuditId);
    if (plan.expiresAt <= new Date().toISOString()) throw new HttpError(409, "plan_expired");
    if (plan.status !== "planned" && plan.status !== "approved")
      throw new HttpError(409, "plan_not_open");
    if ("planDigest" in payload && payload.planDigest !== plan.planDigest)
      throw new HttpError(409, "stale_context");
    const simulation = await simulate(plan, store);
    if (!simulation.ok)
      throw new HttpError(statusForCommandError(simulation.error), simulation.error);
    if (simulation.report.stale) throw new HttpError(409, "stale_context");
    if ("approvalId" in payload) {
      const approval = await readOwnApproval(store, principal.id, payload.approvalId);
      if (!approval) throw new HttpError(404, "approval_not_found");
      if (approval.planId !== plan.planId || approval.planDigest !== plan.planDigest)
        throw new HttpError(409, "stale_context");
      if (approval.expiresAt <= new Date().toISOString())
        throw new HttpError(409, "approval_expired");
      if (approval.usesRemaining < 1) throw new HttpError(409, "approval_exhausted");
      if (
        approval.scope.length > 0 &&
        !Object.keys(plan.expectedRevisions).every((ref) => approval.scope.includes(ref))
      )
        throw new HttpError(403, "approval_scope_mismatch");
    }
    if (step === "prepare") {
      const prepared = await prepareDelegatedOperation(
        store,
        audit,
        principal,
        cap,
        intent,
        undefined,
      );
      return {
        status: 200,
        body: { ...prepared, preview: { ...prepared.preview, report: simulation.report } },
      };
    }
    await confirmDelegatedOperation(store, audit, principal, cap, intent, confirmationDigest!);
    let response: Response, text: string;
    try {
      response = await env.PIPELINE.fetch(
        new Request(
          `https://observation-pipeline.internal/command/v1/${name.slice("kogane.command.".length)}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-kogane-verified-actor": principal.id,
              "x-kogane-actor-kind": "delegated",
              ...audit.envelopeHeaders(),
            },
            body: JSON.stringify(payload),
          },
        ),
      );
      text = await response.text();
    } catch {
      throw new UpstreamLost(500, "internal_error");
    }
    let result: unknown;
    try {
      result = JSON.parse(text);
    } catch {
      throw new UpstreamLost(500, "internal_error");
    }
    return {
      status: response.status,
      body: result,
      auditOutcome: upstreamOutcome(response.status, response.headers, text, {
        result: "replayed",
        targetRef: `plan:${plan.planId}`,
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
