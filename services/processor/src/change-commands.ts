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
} from "../../../packages/application/src/index.ts";
import { IDENTITY_POLICY_VERSION } from "./identity-store.ts";
import { identitySubjectRef } from "../../../packages/application/src/operations/sql.ts";
import { prepareIdentityCommand } from "./identity-commands.ts";

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

export function changeMutationPlanners(db: D1Database): MutationPlanners {
  const identity = identityMutation(db);
  return {
    "identity.assign": identity,
    "identity.release-override": identity,
    "relation.accept": relationMutation,
    "relation.reject": relationMutation,
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
function principalOf(request: Request): Principal | null {
  const id = request.headers.get("x-kogane-verified-actor");
  const kind = request.headers.get("x-kogane-actor-kind");
  if (id === null || !ACTOR.test(id)) return null;
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
  const principal = principalOf(request);
  if (!principal) return fail("invalid_command");
  const input = await body(request);
  if (!input) return fail("invalid_command");
  const store = d1CommandStore(env.DB);
  const now = new Date().toISOString();
  switch (match[1]) {
    case "plan": {
      if (!isChangeKind(input.kind)) return fail("unsupported_semantics");
      const baseContextId = input.baseContextId;
      const result = await createPlan(
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
        },
        store,
      );
      return result.ok
        ? Response.json({ plan: result.plan, created: result.created })
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
      const result = await approve(store, {
        planId: input.planId,
        planDigest: input.planDigest,
        actor: principal,
        scope,
        ttlSeconds: APPROVAL_TTL_SECONDS_DEFAULT,
        now,
      });
      return result.ok
        ? Response.json({ approval: result.approval, plan: result.plan })
        : fail(result.error, result.refs);
    }
    case "commit": {
      const result = await commit(store, {
        operationId: input.operationId,
        principal,
        planId: input.planId,
        approvalId: input.approvalId,
        ...(input.idempotencyPayloadDigest === undefined
          ? {}
          : { idempotencyPayloadDigest: input.idempotencyPayloadDigest }),
        planners: changeMutationPlanners(env.DB),
        now,
      });
      return result.ok
        ? Response.json({ receipt: result.receipt, replayed: result.replayed })
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
