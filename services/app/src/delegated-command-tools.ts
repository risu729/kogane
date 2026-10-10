// MCP command adapters use the existing Processor command routes over PIPELINE.
import { z } from "zod";
import {
  bindDelegatedWrite,
  d1CommandStore,
  delegatedCan,
  DelegatedOperationError,
  executionFor,
  type DelegationResolution,
  type DelegationCapability,
  type OperationCall,
  CHANGE_KINDS,
  loadPlan,
} from "../../../packages/application/src/index";
import type { ToolResult } from "./agent-service";
import { HttpError } from "./http";
import { commandsEnabled } from "./command-api";
import { parseRequest } from "./ops-api";
import { upstreamOutcome, UpstreamLost } from "./audit";

const ID = z.string().regex(/^[0-9a-f]{64}$/u);
const KEY = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const schemas = {
  "kogane.command.plan": z.strictObject({
    kind: z.enum(CHANGE_KINDS),
    payload: z.record(z.string(), z.unknown()),
    baseContextId: z.string().min(1).max(256).optional(),
    idempotencyKey: KEY,
  }),
  "kogane.command.simulate": z.strictObject({ planId: ID }),
  "kogane.command.operation.get": z.strictObject({
    operationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u),
  }),
};
export type DelegatedCommandTool = keyof typeof schemas;
export const EXECUTABLE_COMMAND_CAPABILITIES = [
  "commands.plan",
] as const satisfies readonly DelegationCapability[];
export function isDelegatedCommandTool(name: string): name is DelegatedCommandTool {
  return Object.hasOwn(schemas, name);
}
export const DELEGATED_COMMAND_TOOLS = Object.entries(schemas).map(([name, schema]) => {
  const generated = z.toJSONSchema(schema) as Record<string, unknown>;
  delete generated["$schema"];
  return {
    name,
    title: name.slice(7),
    description:
      "Use the same planning, simulation and own-receipt service as the owner UI. Planning adopts no financial state.",
    inputSchema: generated,
    annotations: {
      readOnlyHint: name !== "kogane.command.plan",
      destructiveHint: false,
      openWorldHint: false,
    },
  };
});
export function delegatedCommandTools(env: Env, resolution: DelegationResolution) {
  return commandsEnabled(env) &&
    env.PIPELINE &&
    resolution.ok &&
    resolution.principal.capabilities.includes("commands.plan")
    ? DELEGATED_COMMAND_TOOLS
    : [];
}
export async function callDelegatedCommandTool(
  name: DelegatedCommandTool,
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
    if (!env.PIPELINE || typeof env.PIPELINE.fetch !== "function")
      throw new HttpError(503, "command_executor_unavailable");
    const principal = resolution.principal;
    delegatedCan(principal, "commands.plan");
    const input: unknown = parseRequest<unknown>(schemas[name], body ?? {});
    if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 16_384)
      throw new HttpError(413, "request_too_large");
    audit.delegate(principal, executionFor(principal));
    if (name === "kogane.command.plan") {
      const parsed = input as z.infer<(typeof schemas)["kogane.command.plan"]>;
      const replay = await bindDelegatedWrite(d1CommandStore(env.DB), audit, principal, {
        capability: "commands.plan",
        idempotencyKey: parsed.idempotencyKey,
        payload: parsed,
      });
      if (replay) {
        const id = replay.target_ref?.slice(5);
        const plan = id ? await loadPlan(d1CommandStore(env.DB), id) : null;
        if (plan)
          return {
            status: 200,
            body: { plan, created: false },
            auditOutcome: {
              result: "replayed",
              targetRef: replay.target_ref,
              refs: JSON.parse(replay.refs_json) as string[],
            },
          };
      }
    }
    const route =
      name === "kogane.command.operation.get" ? "operation" : name.slice("kogane.command.".length);
    let upstream: Response, text: string;
    try {
      upstream = await env.PIPELINE.fetch(
        new Request(`https://observation-pipeline.internal/command/v1/${route}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-kogane-verified-actor": principal.id,
            "x-kogane-actor-kind": "delegated",
            ...audit.envelopeHeaders(),
          },
          body: JSON.stringify(input),
        }),
      );
      text = await upstream.text();
    } catch {
      throw new UpstreamLost(500, "internal_error");
    }
    let result: unknown;
    try {
      result = JSON.parse(text);
    } catch {
      throw new UpstreamLost(500, "internal_error");
    }
    const planId = (result as { plan?: { planId?: string } })?.plan?.planId;
    return {
      status: upstream.status,
      body: result,
      auditOutcome: upstreamOutcome(
        upstream.status,
        upstream.headers,
        text,
        name === "kogane.command.plan"
          ? { result: "replayed", targetRef: typeof planId === "string" ? `plan:${planId}` : null }
          : { result: "read", rows: 1, truncated: false },
      ),
    };
  } catch (error) {
    if (error instanceof DelegatedOperationError)
      return { status: 403, body: { error: error.code } };
    if (error instanceof HttpError && !(error instanceof UpstreamLost))
      return {
        status: error.status,
        body: { error: error.code, ...(error.refs.length ? { refs: error.refs } : {}) },
      };
    throw error;
  }
}
