// The single writer of the change lifecycle (architecture addendum A09).
//
// Decision, approval, receipt and outbox rows are written here and nowhere
// else: the evidence browser authenticates the human, decides the grant, and
// forwards to these routes over its private service binding, exactly as it
// already does nothing else with write access. Addendum 12 §2 asks for one
// write owner per area, not for a binding that happens to allow UPDATE.
//
// The identity mutation itself is `executeIdentityCommand`'s own statements:
// `prepareIdentityCommand` hands them over so the commit puts them in its own
// batch, under its own receipt reservation. There is no second copy of what an
// identity command writes.
import {
  approve,
  commit,
  createPlan,
  d1CommandStore,
  getReceipt,
  isChangeKind,
  loadPlan,
  type MutationInput,
  type MutationPlanners,
  type MutationWrites,
  type Principal,
  PLAN_TTL_SECONDS_DEFAULT,
  APPROVAL_TTL_SECONDS_DEFAULT,
  relationMutation,
  simulate,
  statusForCommandError,
  type CommandErrorCode,
  AUDIT_RECORDED_HEADER,
  type AuditEnvelope,
  type OperationCall,
  type OperationName,
  parseAuditEnvelope,
  processorCall,
  delegatedBatchFailure,
} from "../../../packages/application/src/index.ts";
import { IDENTITY_POLICY_VERSION } from "./identity-store.ts";
import { identitySubjectRef } from "../../../packages/application/src/operations/sql.ts";
import { prepareIdentityCommand } from "./identity-commands.ts";

import { cardSettlementMutation } from "./card-settlement-commands.ts";

import { canonicalDigest } from "../../../packages/domain/src/context.ts";

const BODY_LIMIT = 16 * 1024;
const ACTOR = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;
const COMMAND_PATH = /^\/command\/v1\/(plan|simulate|approve|commit|operation)$/u;

/**
 * The identity kinds reuse the existing command. `expectedRevision` comes from
 * the plan, so the mapping revision is checked twice for the same value: once
 * by the plan's own expected-revision guard and once by the identity command's
 * `revisionGuard`, both inside the commit batch.
 */
function identityMutation(db: D1Database) {
  return async (input: MutationInput): Promise<MutationWrites | null> => {
    const { plan, principal, operationId, now, guard } = input;
    if (plan.kind !== "identity.assign" && plan.kind !== "identity.release-override") return null;
    const assign = plan.kind === "identity.assign";
    const payload = plan.payload as {
      subject: "account" | "instrument";
      referenceId: string;
      targetId?: string;
      reason: string;
    };
    const subjectRef = identitySubjectRef(payload.subject, payload.referenceId);
    const expectedRevision = plan.expectedRevisions[subjectRef];
    if (expectedRevision === undefined) return null;
    const prepared = await prepareIdentityCommand(
      db,
      {
        operationId,
        actorId: principal.id,
        actorVerification: "server",
        action: assign ? "assign" : "release-override",
        kind: payload.subject,
        referenceId: payload.referenceId,
        expectedRevision,
        targetId: assign ? (payload.targetId ?? null) : null,
        reason: payload.reason,
      },
      IDENTITY_POLICY_VERSION,
      { guard, now },
    );
    if ("error" in prepared) return null;
    return {
      writes: prepared.writes.map((write) => ({ sql: write.sql, binds: write.binds })),
      decisionRevisionId: prepared.receipt.decisionRevisionId,
      result: {
        action: prepared.receipt.action,
        kind: prepared.receipt.kind,
        referenceId: prepared.receipt.referenceId,
        revision: prepared.receipt.revision,
        mappingId: prepared.receipt.mappingId,
        decisionRevisionId: prepared.receipt.decisionRevisionId,
      },
    };
  };
}

/**
 * The card purchase review kinds (ADR 0017) have no writer yet. Their slot
 * answers null, so a commit writes nothing and reports why through the plan's
 * re-simulation; no plan of these kinds can exist until a planner is
 * registered in `REVIEW_PLANNERS`, and each later change fills in its own
 * kind here.
 */
export async function cardReviewMutation(_input: MutationInput): Promise<MutationWrites | null> {
  return null;
}

/**
 * The economic-event kinds (ADR 0054, G2; CORE 0071) are vocabulary only: no
 * planner is registered in `ECONOMIC_EVENT_PLANNERS`, so no plan of them can
 * be made or approved, and their slot answers null, so a plan row that
 * reached the table any other way commits nothing (`unsupported_semantics`).
 * The own-transfer writer (G3) fills these slots in.
 */
export async function economicEventMutation(_input: MutationInput): Promise<MutationWrites | null> {
  return null;
}

export function changeMutationPlanners(db: D1Database): MutationPlanners {
  const identity = identityMutation(db);
  return {
    "identity.assign": identity,
    "identity.release-override": identity,
    "relation.accept": relationMutation,
    "relation.reject": relationMutation,
    "card-settlement.accept": cardSettlementMutation,
    "card-settlement.reject": cardSettlementMutation,
    "card-settlement.withdraw": cardSettlementMutation,
    "card-purchase.exclude": cardReviewMutation,
    "card-purchase.restore": cardReviewMutation,
    "card-refund.allocate": cardReviewMutation,
    "card-refund.withdraw": cardReviewMutation,
    "card-installment.link": cardReviewMutation,
    "card-installment.unlink": cardReviewMutation,
    "economic-event.adopt": economicEventMutation,
    "economic-event.correct": economicEventMutation,
    "economic-event.withdraw": economicEventMutation,
    "economic-event.move": economicEventMutation,
  };
}

interface CommandBody {
  [key: string]: unknown;
}

async function body(request: Request): Promise<CommandBody | null> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isSafeInteger(length) || length > BODY_LIMIT) return null;
  const text = await request.text();
  if (text.length > BODY_LIMIT) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as CommandBody)
      : null;
  } catch {
    return null;
  }
}

/**
 * The principal, from the private binding's verified-actor headers. The
 * evidence browser proved the identity with its Access JWT; this route trusts
 * those headers at the same level as `/sweep` and `/identity-revise`, and
 * still refuses an agent's approval itself rather than assuming the caller did.
 */
function principalOf(request: Request, envelope: AuditEnvelope): Principal | null {
  const id = request.headers.get("x-kogane-verified-actor");
  const kind = request.headers.get("x-kogane-actor-kind");
  if (id === null) return null;
  if (kind === "delegated") {
    const auth = envelope.delegatedExecution;
    if (
      envelope.path !== "mcp" ||
      !auth ||
      !id.startsWith("mcp-client:") ||
      !ACTOR.test(id.slice(11))
    )
      return null;
    return {
      id,
      kind,
      verification: "server",
      capabilities: [
        ...(auth.commandFamilies.includes("plan") ? ["interpretation.propose" as const] : []),
        ...(auth.commandFamilies.some((family) => family !== "plan")
          ? ["interpretation.accept" as const]
          : []),
      ],
    };
  }
  if (!ACTOR.test(id) || envelope.delegatedExecution || id.startsWith("mcp-client:")) return null;
  if (kind !== "human" && kind !== "agent") return null;
  return {
    id,
    kind,
    verification: "server",
    capabilities:
      kind === "human"
        ? ["interpretation.propose", "interpretation.accept"]
        : ["interpretation.propose"],
  };
}

/**
 * The writer's answer, marked when its batch wrote the effect's audit record
 * (ADR 0064). The App records every other outcome — a read, a replay, a
 * refusal — after this answer, so a refusal made here is recorded once.
 */
function answered(body: unknown, call?: OperationCall): Response {
  const response = Response.json(body);
  if (call?.recorded) response.headers.set(AUDIT_RECORDED_HEADER, "1");
  return response;
}

/** The audit call of a writing route, built from the App's envelope and the verified actor. */
function writerCall(
  envelope: AuditEnvelope,
  operation: OperationName,
  principal: Principal,
): OperationCall {
  return processorCall(envelope, operation, principal.id, principal.kind);
}

function fail(code: CommandErrorCode, refs?: readonly string[]): Response {
  return Response.json(refs && refs.length > 0 ? { error: code, refs } : { error: code }, {
    status: statusForCommandError(code),
  });
}

/** POST-only, one closed path set; anything else is not this module's. */
export async function changeCommandRoute(
  env: Env,
  request: Request,
  path: string,
): Promise<Response | undefined> {
  const match = COMMAND_PATH.exec(path);
  if (!match) return undefined;
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  // The audit envelope (ADR 0064) is required like the actor headers: the
  // App forwards it on every command, and a request without it is refused
  // exactly as one without a verified actor is.
  const envelope = parseAuditEnvelope(request.headers);
  if (!envelope) return fail("invalid_command");
  const principal = principalOf(request, envelope);
  if (!principal) return fail("invalid_command");
  const input = await body(request);
  if (!input) return fail("invalid_command");
  if (principal.kind === "delegated") {
    const auth = envelope.delegatedExecution!;
    if (auth.notAfter <= new Date().toISOString())
      return Response.json({ error: "delegation_expired" }, { status: 403 });
    const decision = match[1] === "approve" || match[1] === "commit";
    if (decision) {
      if (!auth.confirmsAuditId || !auth.confirmationDigest)
        return Response.json({ error: "confirmation_required" }, { status: 403 });
      const plan = await loadPlan(d1CommandStore(env.DB), input.planId);
      if (!plan) return fail("plan_not_found");
      if (auth.revertsAuditId !== input.revertsAuditId) return fail("invalid_command");
      const family = plan.kind.split(".")[0];
      if (
        (family !== "identity" && family !== "relation" && family !== "card-settlement") ||
        !auth.commandFamilies.includes(family)
      )
        return Response.json({ error: "capability_not_delegated" }, { status: 403 });
    } else if (!auth.commandFamilies.includes("plan"))
      return Response.json({ error: "capability_not_delegated" }, { status: 403 });
    if (match[1] === "plan" || decision) {
      if (
        match[1] === "plan" &&
        (typeof input.kind !== "string" ||
          !["identity", "relation", "card-settlement"].includes(input.kind.split(".")[0]!))
      )
        return fail("unsupported_semantics");
      if (
        auth.idempotencyKey !==
          (match[1] === "commit" ? input.operationId : input.idempotencyKey) ||
        !auth.payloadDigest ||
        auth.payloadDigest !==
          (await canonicalDigest({
            v: "kogane-delegated-payload-v1",
            operation: `command.${match[1]}`,
            payload: input,
          }))
      )
        return Response.json({ error: "idempotency_conflict" }, { status: 409 });
    } else if (auth.idempotencyKey || auth.confirmsAuditId) return fail("invalid_command");
  }
  const store = d1CommandStore(env.DB);
  const now = new Date().toISOString();
  switch (match[1]) {
    case "plan": {
      if (!isChangeKind(input.kind)) return fail("unsupported_semantics");
      const baseContextId = input.baseContextId;
      // Only omission selects the existing current context. Invalid explicit
      // provenance must not be silently downgraded to a manual current command.
      if (
        Object.hasOwn(input, "baseContextId") &&
        (typeof baseContextId !== "string" ||
          baseContextId.length === 0 ||
          baseContextId.length > 256)
      )
        return fail("invalid_command");
      const audit = writerCall(envelope, "command.plan", principal);
      let result;
      try {
        result = await createPlan(
          input.kind,
          input.payload,
          {
            actor: principal,
            baseContextId:
              typeof baseContextId === "string" &&
              baseContextId.length > 0 &&
              baseContextId.length <= 256
                ? baseContextId
                : "identity-current-v1",
            now,
            ttlSeconds: PLAN_TTL_SECONDS_DEFAULT,
            audit,
          },
          store,
        );
      } catch (error) {
        const guard = await delegatedBatchFailure(store, audit);
        if (guard)
          return Response.json(
            { error: guard.code },
            { status: guard.code === "delegation_budget_exceeded" ? 429 : 403 },
          );
        throw error;
      }
      return result.ok
        ? answered({ plan: result.plan, created: result.created }, audit)
        : fail(result.error, result.refs);
    }
    case "simulate": {
      const plan = await loadPlan(store, input.planId);
      if (!plan) return fail("plan_not_found");
      const result = await simulate(plan, store);
      return result.ok ? Response.json({ report: result.report }) : fail(result.error, result.refs);
    }
    case "approve": {
      const scope = Array.isArray(input.scope) ? (input.scope as string[]) : [];
      const audit = writerCall(envelope, "command.approve", principal);
      let result;
      try {
        result = await approve(store, {
          planId: input.planId,
          planDigest: input.planDigest,
          actor: principal,
          scope,
          ttlSeconds: APPROVAL_TTL_SECONDS_DEFAULT,
          now,
          audit,
        });
      } catch (error) {
        const refusal = await delegatedBatchFailure(store, audit);
        if (refusal)
          return Response.json(
            { error: refusal.code },
            { status: refusal.code === "delegation_budget_exceeded" ? 429 : 403 },
          );
        throw error;
      }
      return result.ok
        ? answered({ approval: result.approval, plan: result.plan }, audit)
        : fail(result.error, result.refs);
    }
    case "commit": {
      const audit = writerCall(envelope, "command.commit", principal);
      let result;
      try {
        result = await commit(store, {
          operationId: input.operationId,
          principal,
          planId: input.planId,
          approvalId: input.approvalId,
          ...(input.idempotencyPayloadDigest === undefined
            ? {}
            : { idempotencyPayloadDigest: input.idempotencyPayloadDigest }),
          planners: changeMutationPlanners(env.DB),
          now,
          audit,
        });
      } catch (error) {
        const refusal = await delegatedBatchFailure(store, audit);
        if (refusal)
          return Response.json(
            { error: refusal.code },
            { status: refusal.code === "delegation_budget_exceeded" ? 429 : 403 },
          );
        throw error;
      }
      return result.ok
        ? answered({ receipt: result.receipt, replayed: result.replayed }, audit)
        : fail(result.error, result.refs);
    }
    default: {
      const result = await getReceipt(store, principal.id, input.operationId);
      return result.ok
        ? Response.json({ receipt: result.receipt })
        : fail(result.error, result.refs);
    }
  }
}
