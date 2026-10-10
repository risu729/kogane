// The authenticated command boundary (architecture addendum A09, 11 §5).
//
// The evidence browser stays a read-only reader of every table. What this
// module adds is one explicit, authenticated, POST-only path set that forwards
// a verified actor to the observation pipeline, which remains the single
// writer of the decision, approval, receipt and outbox tables. The GET-only
// boundary is not relaxed anywhere else: `worker.ts` still rejects every other
// non-GET request with 405.
//
// Three gates in order: the feature flag, the Access identity, and the grant.
// The grant is an allow-list on both sides (`src/grants.ts`): a subject listed
// in OPERATOR_SUBJECTS is the human operator, a subject listed in AGENT_GRANTS
// is an agent and may plan and simulate, and a subject in neither reaches
// nothing — `approve` and `commit` answer `approval_required` for an agent
// before anything is forwarded, because an agent asserting its own approval is
// not an approval (addendum 10 §5).
//
// Every command reaching a known path is recorded (ADR 0064, path `ui`): the
// Processor appends the `applied` record of a plan, an approval or a commit to
// its own batch, and this module records everything else — a read, a replay,
// a refusal here or there — once, after the answer.
import { principalCan } from "../../../packages/application/src/command/contract";
import type {
  AnswerOutcome,
  OperationCall,
  OperationName,
} from "../../../packages/application/src/index";
import { type Answer, auditContext, auditedRoute, UpstreamLost, upstreamOutcome } from "./audit";
import { principalFor } from "./grants";
import { HttpError, json } from "./http";

const PREFIX = "/api/command/v1/";
export const COMMAND_OPERATIONS = ["plan", "simulate", "approve", "commit", "operation"] as const;
export type CommandOperation = (typeof COMMAND_OPERATIONS)[number];
/** Operations that accept a judgement; agents never reach these. */
const ACCEPTING: readonly string[] = ["approve", "commit"];
const BODY_LIMIT = 16 * 1024;

/** The catalogued operation each command path records under. */
const COMMAND_AUDIT: Record<CommandOperation, OperationName> = {
  plan: "command.plan",
  simulate: "command.simulate",
  approve: "command.approve",
  commit: "command.commit",
  operation: "command.operation.get",
};

export function isCommandPath(path: string): boolean {
  return path === "/api/command/v1" || path.startsWith(PREFIX);
}

/**
 * The flag is off unless it is exactly "true"; absent means off. Typed on the
 * variable rather than on `Env`, because the generated `Env` narrows a var
 * declared in wrangler.jsonc to its configured literal.
 */
export function commandsEnabled(env: { COMMANDS_ENABLED?: string }): boolean {
  return env.COMMANDS_ENABLED === "true";
}

/**
 * Handles a command request. `subject` is the Access JWT subject the caller
 * already verified; nothing in the request body can change it.
 */
export async function commandApi(
  request: Request,
  env: Env,
  url: URL,
  subject: string,
): Promise<Response | undefined> {
  if (!isCommandPath(url.pathname)) return undefined;
  // A closed route set: an unknown command path is 404, never a pass-through.
  const operation = url.pathname.slice(PREFIX.length);
  if (!(COMMAND_OPERATIONS as readonly string[]).includes(operation))
    throw new HttpError(404, "not_found");
  const command = operation as CommandOperation;
  return auditedRoute(auditContext(request, env, "ui", subject), COMMAND_AUDIT[command], (call) =>
    commandRoute(request, env, url, subject, command, call),
  );
}

/** What a successful forwarded command that wrote no effect record was. */
function quietOutcome(command: CommandOperation, text: string): AnswerOutcome {
  if (command === "simulate" || command === "operation")
    return { result: "read", rows: 1, truncated: false };
  // A replay of a plan, an approval or a commit: the earlier effect, named by
  // the ids the Processor answered with (server-resolved, never refused values).
  let body: {
    plan?: { planId?: unknown };
    receipt?: { planId?: unknown; operationId?: unknown };
    approval?: { approvalId?: unknown };
  } = {};
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    /* No ids to name. */
  }
  const planId = body.plan?.planId ?? body.receipt?.planId;
  const refs = [
    ...(typeof body.approval?.approvalId === "string"
      ? [`approval:${body.approval.approvalId}`]
      : []),
    ...(typeof body.receipt?.operationId === "string"
      ? [`operation:${body.receipt.operationId}`]
      : []),
  ];
  return {
    result: "replayed",
    targetRef:
      typeof planId === "string" && /^[0-9a-f]{64}$/u.test(planId) ? `plan:${planId}` : null,
    refs,
  };
}

async function commandRoute(
  request: Request,
  env: Env,
  url: URL,
  subject: string,
  operation: CommandOperation,
  call: OperationCall,
): Promise<Answer> {
  if (request.method !== "POST") throw new HttpError(405, "method_not_allowed");
  if (url.search) throw new HttpError(400, "invalid_query");
  // Flag before identity detail: a deployment with commands off says so and
  // does nothing else.
  if (!commandsEnabled(env)) throw new HttpError(403, "commands_disabled");
  // Grades the verified subject, checking the actor shape the decision log
  // accepts on the way. A subject this deployment grants nothing, and a
  // deployment whose grant lists cannot be read, both refuse here — before a
  // body is read and before anything is forwarded.
  const principal = principalFor(env, subject);
  call.grade(principal.id, principal.kind);
  if (ACCEPTING.includes(operation) && !principalCan(principal, "interpretation.accept"))
    return {
      response: json({ error: "approval_required" }, 403),
      outcome: { result: "refused", code: "approval_required" },
    };
  const length = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isSafeInteger(length) || length > BODY_LIMIT)
    throw new HttpError(413, "request_too_large");
  const body = await request.text();
  if (body.length > BODY_LIMIT) throw new HttpError(413, "request_too_large");
  try {
    const parsed: unknown = JSON.parse(body === "" ? "{}" : body);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      throw new HttpError(400, "invalid_request");
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "invalid_request");
  }
  const executor = env.PIPELINE;
  // The writer is a separate Worker on purpose (addendum 12 §2). Without the
  // binding there is no fallback write path from this Worker.
  if (!executor || typeof executor.fetch !== "function")
    throw new HttpError(503, "command_executor_unavailable");
  let upstream: Response;
  let text: string;
  try {
    upstream = await executor.fetch(
      new Request(`https://observation-pipeline.internal/command/v1/${operation}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-kogane-verified-actor": principal.id,
          "x-kogane-actor-kind": principal.kind,
          // The audit envelope (ADR 0064): the Processor's record of the
          // effect carries this request's correlation id and path.
          ...call.envelopeHeaders(),
        },
        body: body === "" ? "{}" : body,
      }),
    );
    text = await upstream.text();
  } catch {
    // The answer is the one a thrown executor always produced (500
    // internal_error); the record says the Processor's answer was lost.
    throw new UpstreamLost(500, "internal_error");
  }
  // Only the status and the JSON body cross back: no upstream headers, no
  // exception text, no provider content.
  return {
    response: new Response(text, {
      status: upstream.status,
      headers: { "content-type": "application/json" },
    }),
    outcome: upstreamOutcome(
      upstream.status,
      upstream.headers,
      text,
      quietOutcome(operation, text),
    ),
  };
}
