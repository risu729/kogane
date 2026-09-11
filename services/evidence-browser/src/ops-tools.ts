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
import { z } from "zod";
import type { ToolResult } from "./agent-service";
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
  /** The subject `authenticate` proved; never a body or header claim. */
  subject: string,
): Promise<ToolResult> {
  try {
    const context = opsContext(env, subject);
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
