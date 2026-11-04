// Shared maintenance reads over HTTP and MCP; delegated writes live in delegated-maintenance-tools.ts.
import { z } from "zod";
import {
  ACTOR_PATTERN,
  type Grant,
  grantAllows,
  grantAllowsScheduleSource,
} from "../../../packages/application/src/index";
import type { ToolResult } from "./agent-service";

/** On `/mcp` and, as `schedules.maintenance.read`, on `/api/agent/v1/*`. */
export const SCHEDULE_READ_TOOL = "kogane.schedules.maintenance.read";
/** On `/mcp` only: a browser session yields no delegation. */
export const SCHEDULE_UPDATE_TOOL = "kogane.schedules.maintenance.update";

/** The tools exist exactly while the settings routes do (`SCHEDULES_ENABLED`). */
export function schedulesServed(env: Pick<Env, "SCHEDULES_ENABLED">): boolean {
  return (env.SCHEDULES_ENABLED as string | undefined) === "true";
}

const sourceId = z.string().regex(/^[a-z0-9-]{1,100}$/u);
const scheduleReadSchema = z.strictObject({ source: sourceId.optional() });

/** The published JSON Schema of one argument schema, without the meta key. */
function inputSchema(schema: z.ZodType): Record<string, unknown> {
  const generated = z.toJSONSchema(schema) as Record<string, unknown>;
  delete generated["$schema"];
  return generated;
}

export const SCHEDULE_MCP_TOOLS = [
  {
    name: SCHEDULE_READ_TOOL,
    title: "Read maintenance settings of the granted sources",
    description:
      "Public maintenance rules with their revision history (actor kind and closed reason), the registered maintenance reference, and per schedule the original next occurrence, the maintenance-adjusted due time, the actual alarm, whether the reservation is armed or pending, and the latest receipt's outcome. Only sources in this grant's scheduleSources; no financial data.",
    inputSchema: inputSchema(scheduleReadSchema),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
] as const;

/** The tools this grant can use: the read, with `schedules.read`. The delegated adapter publishes the update separately. */
export function scheduleToolsFor(grant: Grant): (typeof SCHEDULE_MCP_TOOLS)[number][] {
  return grantAllows(grant, "schedules.read") ? [...SCHEDULE_MCP_TOOLS] : [];
}

function refusal(status: number, error: string): ToolResult {
  return { status, body: { error } };
}

async function relayRead(
  env: Pick<Env, "PIPELINE">,
  principal: string,
  body: unknown,
): Promise<ToolResult> {
  let response: Response;
  try {
    response = await env.PIPELINE.fetch(
      new Request("https://observation-pipeline.internal/internal/schedules/agent/read", {
        method: "POST",
        headers: {
          "x-kogane-internal-caller": "kogane-evidence-browser",
          // The reader travels in its own header; the operator header is never set.
          "x-kogane-agent": principal,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
    );
  } catch {
    return refusal(503, "scheduling_unavailable");
  }
  try {
    return { status: response.status, body: await response.json() };
  } catch {
    return refusal(503, "scheduling_unavailable");
  }
}

/**
 * `kogane.schedules.maintenance.read` for a grant, on either agent path. The
 * reader is the grant's principal, the caller the boundary verified; no
 * argument names one.
 */
export async function readScheduleTool(
  body: unknown,
  env: Pick<Env, "PIPELINE">,
  grant: Grant,
): Promise<ToolResult> {
  if (!grantAllows(grant, "schedules.read")) return refusal(403, "unauthorized");
  if (!ACTOR_PATTERN.test(grant.principal)) return refusal(403, "actor_not_supported");
  const parsed = scheduleReadSchema.safeParse(body ?? {});
  if (!parsed.success) return refusal(400, "invalid_request");
  const { source } = parsed.data;
  if (source === undefined) {
    const scope = grant.scopes.scheduleSources ?? [];
    return relayRead(env, grant.principal, { sources: scope === "*" ? "*" : [...scope] });
  }
  // Any source outside the grant is refused alike, whether or not it exists.
  if (!grantAllowsScheduleSource(grant, source)) return refusal(403, "source_not_granted");
  return relayRead(env, grant.principal, { sources: [source] });
}
