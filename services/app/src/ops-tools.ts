// The operations API as MCP tools (unified plan 02 §4, U06).
//
// Six tools, one per route, and not one line of semantics of its own: each
// tool validates with the *same* Zod schema its HTTP route uses and calls the
// same application service with the same verified principal, so the two
// transports write one operation record for one request (G3-05). The tool
// list is published only while `OPS_API_ENABLED` is on, exactly like the
// routes: a client is never shown a tool this deployment refuses.
//
// Every input schema is generated from the Zod schema, so a widening of the
// wire contract cannot leave the published schema behind. They are closed
// objects of bounded identifier patterns: no URL, no host, no bucket key, no
// table name, no ordering, no SQL (G3-13).
import {
  type OperationCall,
  type DelegatedPrincipal,
  type DelegationCapability,
  type DelegationResolution,
  d1CommandStore,
  bindDelegatedWrite,
  delegatedCan,
  DelegatedOperationError,
  delegatedBatchFailure,
  executionFor,
  sessionRefreshPolicy,
  prepareDelegatedOperation,
  confirmDelegatedOperation,
  replayDelegatedConfirmation,
  previewProviderOperation,
  operationIdFor,
  SESSION_REFRESH_MODES,
  statusForCommandError,
} from "../../../packages/application/src/index";

import { z } from "zod";
import type { ToolResult } from "./agent-service";
import type { AgentCaller } from "./auth";
import { HttpError } from "./http";
import {
  collectionSchema,
  importSchema,
  operationIdSchema,
  opsContext,
  opsServices,
  parseRequest,
  projectionSchema,
  replaySchema,
  sessionRefreshSchema,
  type OpsContext,
} from "./ops-api";

export const OPS_TOOL_NAMES = [
  "kogane.ops.collection.request",
  "kogane.ops.import.request",
  "kogane.ops.replay.request",
  "kogane.ops.projection.request",
  "kogane.ops.session.refresh",
  "kogane.ops.operation.get",
] as const;
export type OpsToolName = (typeof OPS_TOOL_NAMES)[number];

export function isOpsToolName(value: string): value is OpsToolName {
  return (OPS_TOOL_NAMES as readonly string[]).includes(value);
}

/** The published JSON Schema of one request schema, without the meta key. */
function inputSchema(schema: z.ZodType): Record<string, unknown> {
  const generated = z.toJSONSchema(schema) as Record<string, unknown>;
  delete generated["$schema"];
  return generated;
}

/**
 * A request tool accepts work; it is not read-only, it destroys nothing, and
 * re-sending the same request under the same key is the same operation rather
 * than a second one — which is what `idempotentHint` states. The tool itself
 * touches only this store: the provider session, the parse and the rebuild
 * happen later, in the collector and the Processor.
 */
const REQUEST_HINTS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
const READ_HINTS = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

export const OPS_MCP_TOOLS = [
  {
    name: "kogane.ops.collection.request",
    title: "Request collection of a declared source",
    description:
      "Record a request to collect a declared source over a date window. Accepted means the request is stored, not that a provider was contacted; the collector runs it later.",
    inputSchema: inputSchema(collectionSchema),
    annotations: REQUEST_HINTS,
  },
  {
    name: "kogane.ops.import.request",
    title: "Request re-registration of a persisted run",
    description:
      "Record a request to re-register an already persisted run of a declared source. Names a run identifier, never a storage key; it re-reads what is stored and never re-collects from the provider.",
    inputSchema: inputSchema(importSchema),
    annotations: REQUEST_HINTS,
  },
  {
    name: "kogane.ops.replay.request",
    title: "Request a replay at a fixed parser release",
    description:
      "Record a replay plan for a scope at one registered parser release. The evidence in range is fixed when the plan is stored, so evidence collected afterwards is not pulled into this replay.",
    inputSchema: inputSchema(replaySchema),
    annotations: REQUEST_HINTS,
  },
  {
    name: "kogane.ops.projection.request",
    title: "Request a read-model rebuild",
    description:
      "Record a request to rebuild the read model from valid inputs. A rebuild creates a new snapshot; it never deletes a database, a bucket or stored evidence.",
    inputSchema: inputSchema(projectionSchema),
    annotations: REQUEST_HINTS,
  },
  {
    name: "kogane.ops.session.refresh",
    title: "Request a session refresh for one source",
    description:
      "Ask the party that holds a source's credentials to renew its session. Never returns or accepts a credential, and never retries a login: when the source policy needs a person the operation is stored as waiting_for_human.",
    inputSchema: inputSchema(sessionRefreshSchema),
    annotations: REQUEST_HINTS,
  },
  {
    name: "kogane.ops.operation.get",
    title: "Read the progress of one accepted operation",
    description:
      "Report the stored stage progress and failure code of one operation this principal accepted. Stages nobody has reported are pending: enqueued work is never reported as done.",
    inputSchema: inputSchema(operationIdSchema),
    annotations: READ_HINTS,
  },
] as const;

/**
 * Runs one operations tool. Errors become a result rather than an exception,
 * carrying the same safe code and safe refs the HTTP route would answer with;
 * nothing else of the failure crosses the boundary (G3-08).
 */
export async function callOpsTool(
  name: OpsToolName,
  body: unknown,
  env: Env,
  /** The caller the boundary proved (`src/auth.ts`); never a body or header claim. */
  caller: AgentCaller,
  /** The tool call's audit record (ADR 0064); an accepted request's joins its batch. */
  audit?: OperationCall,
): Promise<ToolResult> {
  // An MCP client is agent-only (ADR 0047): it is refused here, from the
  // caller object, before any grader could look at a subject.
  if (caller.kind === "mcp-client")
    return { status: 403, body: { error: "delegation_not_configured" } };
  try {
    const context = opsContext(env, caller.principal, audit);
    const argument: unknown = body ?? {};
    switch (name) {
      case "kogane.ops.collection.request":
        return await opsServices.collection(context, parseRequest(collectionSchema, argument));
      case "kogane.ops.import.request":
        return await opsServices.import(context, parseRequest(importSchema, argument));
      case "kogane.ops.replay.request":
        return await opsServices.replay(context, parseRequest(replaySchema, argument));
      case "kogane.ops.projection.request":
        return await opsServices.projection(context, parseRequest(projectionSchema, argument));
      case "kogane.ops.session.refresh":
        return await opsServices.sessionRefresh(
          context,
          parseRequest(sessionRefreshSchema, argument),
        );
      case "kogane.ops.operation.get":
        return await opsServices.operation(
          context,
          parseRequest(operationIdSchema, argument).operationId,
        );
    }
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    return {
      status: error.status,
      body: {
        error: error.code,
        ...(error.refs.length > 0 ? { refs: error.refs } : {}),
      },
    };
  }
}

export const DELEGATED_OPS_CAPABILITIES: Readonly<Record<OpsToolName, DelegationCapability>> = {
  "kogane.ops.collection.request": "operations.collection.request",
  "kogane.ops.import.request": "operations.import.request",
  "kogane.ops.replay.request": "operations.replay.request",
  "kogane.ops.projection.request": "operations.projection.request",
  "kogane.ops.session.refresh": "operations.session.refresh",
  "kogane.ops.operation.get": "operations.read",
};
export const EXECUTABLE_OPS_CAPABILITIES = [
  "operations.import.request",
  "operations.replay.request",
  "operations.projection.request",
  "operations.read",
  "operations.collection.request",
  "operations.session.refresh",
] as const satisfies readonly DelegationCapability[];

const R2_CONTROLS = {
  step: z.enum(["prepare", "confirm"]),
  confirmationDigest: z
    .string()
    .regex(/^cfm_[0-9a-f]{64}$/u)
    .optional(),
};
const delegatedCollectionSchema = collectionSchema.extend({
  ...R2_CONTROLS,
  idempotencyKey: collectionSchema.shape.idempotencyKey.unwrap(),
});
const delegatedSessionSchema = sessionRefreshSchema.extend({
  ...R2_CONTROLS,
  idempotencyKey: sessionRefreshSchema.shape.idempotencyKey.unwrap(),
});
export function delegatedOpsTools(resolution: DelegationResolution) {
  return resolution.ok
    ? OPS_MCP_TOOLS.filter(
        (tool) =>
          resolution.principal.capabilities.includes(DELEGATED_OPS_CAPABILITIES[tool.name]) &&
          (EXECUTABLE_OPS_CAPABILITIES as readonly string[]).includes(
            DELEGATED_OPS_CAPABILITIES[tool.name],
          ),
      ).map((tool) =>
        tool.name === "kogane.ops.collection.request"
          ? {
              ...tool,
              inputSchema: inputSchema(delegatedCollectionSchema),
              description:
                tool.description +
                " Requires prepare then exact confirmation; external collection cannot be undone.",
            }
          : tool.name === "kogane.ops.session.refresh"
            ? {
                ...tool,
                inputSchema: inputSchema(delegatedSessionSchema),
                description:
                  tool.description +
                  " Requires prepare then exact confirmation; human session policy and MFA boundary remain unchanged.",
              }
            : tool,
      )
    : [];
}

function delegatedContext(
  env: Env,
  principal: DelegatedPrincipal,
  audit: OperationCall,
): OpsContext {
  return {
    store: d1CommandStore(env.DB),
    principal: {
      id: principal.id,
      kind: "delegated",
      verification: "server",
      capabilities: ["interpretation.accept"],
    },
    audit,
    now: new Date().toISOString().replace(/\.\d{3}Z$/u, "Z"),
    nowMs: Date.now(),
    policy: sessionRefreshPolicy(env.SESSION_REFRESH_POLICY),
  };
}
function sourceAllowed(principal: DelegatedPrincipal, source: string): boolean {
  return principal.scopes.sources === "*" || principal.scopes.sources.includes(source);
}

/** Transport only: shared schemas, registry checks, requests and receipts remain the existing services'. */
export async function callDelegatedOpsTool(
  name: OpsToolName,
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
  const principal = resolution.principal;
  const context = delegatedContext(env, principal, audit);
  try {
    audit.delegate(principal, executionFor(principal));
    delegatedCan(principal, DELEGATED_OPS_CAPABILITIES[name]);
    if (
      !(EXECUTABLE_OPS_CAPABILITIES as readonly string[]).includes(DELEGATED_OPS_CAPABILITIES[name])
    )
      throw new DelegatedOperationError("operation_not_delegable");
    if (name === "kogane.ops.collection.request" || name === "kogane.ops.session.refresh") {
      const parsed = parseRequest<
        z.infer<typeof delegatedCollectionSchema> | z.infer<typeof delegatedSessionSchema>
      >(
        name === "kogane.ops.collection.request"
          ? delegatedCollectionSchema
          : delegatedSessionSchema,
        body ?? {},
      );
      if (!sourceAllowed(principal, parsed.source))
        throw new HttpError(400, "target_missing", ["source"]);
      const { step, confirmationDigest, ...request } = parsed;
      if (step === "prepare" && confirmationDigest) throw new HttpError(400, "invalid_request");
      const kind = name === "kogane.ops.collection.request" ? "collection" : "session-refresh";
      if (step === "confirm") {
        if (!confirmationDigest) throw new DelegatedOperationError("confirmation_required");
        const operationId = await operationIdFor(kind, principal.id, request.idempotencyKey);
        // A completed retry reads its immutable acceptance before mutable source
        // activation or policy checks. The stored prepare already binds the old
        // policy: try only the shared closed modes, never a client-selected one.
        // This does not relax a fresh confirm's current policy validation below.
        const policies = kind === "collection" ? [null] : SESSION_REFRESH_MODES;
        for (let index = 0; index < policies.length; index++) {
          const intent = {
            idempotencyKey: request.idempotencyKey,
            payload: { request, policy: policies[index] },
            targetRef: operationId,
            scope: { namespace: "core-source" as const, source: request.source },
          };
          let replay;
          try {
            replay = await replayDelegatedConfirmation(
              context.store,
              audit,
              principal,
              DELEGATED_OPS_CAPABILITIES[name],
              intent,
              confirmationDigest,
            );
          } catch (error) {
            if (
              error instanceof DelegatedOperationError &&
              error.code === "idempotency_conflict" &&
              index + 1 < policies.length
            )
              continue;
            throw error;
          }
          // No completed effect: the current source and policy remain required.
          if (!replay) break;
          const receipt = await opsServices.operation(context, operationId);
          return {
            status: 202,
            body: {
              operationId,
              status: (receipt.body as { status: string }).status,
            },
            auditOutcome: { result: "replayed", targetRef: operationId, scope: intent.scope },
          };
        }
      }
      const preview = await previewProviderOperation({ ...context, request }, kind, context.policy);
      if (!preview.ok)
        throw new HttpError(
          statusForCommandError(preview.error),
          preview.error,
          preview.refs ?? [],
        );
      // Bind the current server-selected session policy as well as the wire request.
      const intent = {
        idempotencyKey: request.idempotencyKey,
        payload: { request, policy: preview.policy },
        targetRef: preview.operationId,
        scope: { namespace: "core-source" as const, source: request.source },
      };
      if (step === "prepare") {
        const prepared = await prepareDelegatedOperation(
          context.store,
          audit,
          principal,
          DELEGATED_OPS_CAPABILITIES[name],
          intent,
          undefined,
        );
        return {
          status: 200,
          body: {
            ...prepared,
            preview: {
              ...prepared.preview,
              status: preview.status,
              policy: preview.policy,
              externalEffect: true,
              revertAvailable: false,
            },
          },
        };
      }
      await confirmDelegatedOperation(
        context.store,
        audit,
        principal,
        DELEGATED_OPS_CAPABILITIES[name],
        intent,
        confirmationDigest!,
      );
      return await (name === "kogane.ops.collection.request"
        ? opsServices.collection(context, request as z.infer<typeof collectionSchema>)
        : opsServices.sessionRefresh(context, request));
    }
    if (name === "kogane.ops.operation.get") {
      const input = parseRequest(operationIdSchema, body ?? {});
      // Resolve the caller's own row before reading progress; denied and absent are identical.
      const row = await context.store.first<{ source_id: string | null }>(
        "SELECT source_id FROM ops_requests WHERE operation_id=? AND principal=?",
        [input.operationId, principal.id],
      );
      if (
        !row ||
        (row.source_id === null
          ? principal.scopes.sources !== "*" || principal.scopes.accounts !== "*"
          : !sourceAllowed(principal, row.source_id))
      )
        throw new HttpError(400, "target_missing");
      return await opsServices.operation(context, input.operationId);
    }
    if (name === "kogane.ops.import.request") {
      const input = parseRequest(importSchema, body ?? {});
      if (!sourceAllowed(principal, input.source))
        throw new HttpError(400, "target_missing", ["source"]);
      await bindDelegatedWrite(context.store, audit, principal, {
        capability: "operations.import.request",
        idempotencyKey: input.idempotencyKey,
        payload: input,
      });
      return await opsServices.import(context, input);
    }
    if (name === "kogane.ops.replay.request") {
      const input = parseRequest(replaySchema, body ?? {});
      if (!sourceAllowed(principal, input.scope.source))
        throw new HttpError(400, "target_missing", ["scope.source"]);
      await bindDelegatedWrite(context.store, audit, principal, {
        capability: "operations.replay.request",
        idempotencyKey: input.idempotencyKey,
        payload: input,
      });
      return await opsServices.replay(context, input);
    }
    const input = parseRequest(projectionSchema, body ?? {});
    if (principal.scopes.sources !== "*" || principal.scopes.accounts !== "*")
      throw new HttpError(400, "target_missing");
    await bindDelegatedWrite(context.store, audit, principal, {
      capability: "operations.projection.request",
      idempotencyKey: input.idempotencyKey,
      payload: input,
    });
    return await opsServices.projection(context, input);
  } catch (error) {
    const guard =
      error instanceof DelegatedOperationError || error instanceof HttpError
        ? null
        : await delegatedBatchFailure(context.store, audit);
    const failure = guard ?? error;
    if (failure instanceof DelegatedOperationError)
      return {
        status:
          failure.code === "delegation_budget_exceeded"
            ? 429
            : [
                  "idempotency_conflict",
                  "confirmation_used",
                  "confirmation_expired",
                  "revision_conflict",
                ].includes(failure.code)
              ? 409
              : 403,
        body: { error: failure.code },
      };
    if (failure instanceof HttpError)
      return {
        status: failure.status,
        body: { error: failure.code, ...(failure.refs.length ? { refs: failure.refs } : {}) },
      };
    throw failure;
  }
}
