// Shared maintenance reads over HTTP and MCP; delegated writes live in delegated-maintenance-tools.ts.
import { z } from "zod";
import {
  ACTOR_PATTERN,
  type Grant,
  grantAllows,
  grantAllowsScheduleSource,
} from "../../../packages/application/src/index";
import type { ToolResult } from "./agent-service";
import { mcpInputSchema } from "./mcp-input-schema";

/** On `/mcp` and, as `schedules.maintenance.read`, on `/api/agent/v1/*`. */
export const SCHEDULE_READ_TOOL = "kogane.schedules.maintenance.read";
/** On `/mcp` only: a browser session yields no delegation. */
export const SCHEDULE_UPDATE_TOOL = "kogane.schedules.maintenance.update";
/** On `/mcp`: the schedules page's re-survey section (ADR 0050). */
export const SURVEY_READ_TOOL = "kogane.schedules.survey.read";

/** The tools exist exactly while the settings routes do (`SCHEDULES_ENABLED`). */
export function schedulesServed(env: Pick<Env, "SCHEDULES_ENABLED">): boolean {
  return (env.SCHEDULES_ENABLED as string | undefined) === "true";
}

const sourceId = z.string().regex(/^[a-z0-9-]{1,100}$/u);
const scheduleReadSchema = z.strictObject({ source: sourceId.optional() });

/** The published JSON Schema of one argument schema, without the meta key. */
function inputSchema(schema: z.ZodType): Record<string, unknown> {
  const generated = mcpInputSchema(schema);
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
  {
    name: SURVEY_READ_TOOL,
    title: "Read maintenance re-survey proposals of the granted sources",
    description:
      "The schedules page's re-survey section: whether the lane runs, each allowlisted page's freshness and last failure code, and the undecided proposals (id, source, kind, rule, baseRevision, whether it is still current, timezone, pattern, enabled, scope, status, closed reasons, page URL, fetch time and SHA-256). Never page text. Only sources in this grant's scheduleSources. truncated is true when the page's bound on shown proposals was reached. Decide a proposal with kogane.schedules.survey.decide.",
    inputSchema: inputSchema(scheduleReadSchema),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
] as const;

/** The tools this grant can use: the reads, with `schedules.read`. The delegated adapters publish the writes separately. */
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
  path: "read" | "survey" = "read",
): Promise<ToolResult> {
  let response: Response;
  try {
    response = await env.PIPELINE.fetch(
      new Request(`https://observation-pipeline.internal/internal/schedules/agent/${path}`, {
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
  path: "read" | "survey" = "read",
): Promise<ToolResult> {
  if (!grantAllows(grant, "schedules.read")) return refusal(403, "unauthorized");
  if (!ACTOR_PATTERN.test(grant.principal)) return refusal(403, "actor_not_supported");
  const parsed = scheduleReadSchema.safeParse(body ?? {});
  if (!parsed.success) return refusal(400, "invalid_request");
  const { source } = parsed.data;
  if (source === undefined) {
    const scope = grant.scopes.scheduleSources ?? [];
    return relayRead(env, grant.principal, { sources: scope === "*" ? "*" : [...scope] }, path);
  }
  // Any source outside the grant is refused alike, whether or not it exists.
  if (!grantAllowsScheduleSource(grant, source)) return refusal(403, "source_not_granted");
  return relayRead(env, grant.principal, { sources: [source] }, path);
}

/**
 * `kogane.schedules.lease.release` on `/mcp` (ADR 0081 point 3): the schedules
 * page's 停止した実行を解除 button exists as a tool, and refuses every call. Releasing a
 * lease asserts that its execution stopped, which the server cannot verify, so
 * the release stays R3, the operator's in the UI (ADR 0063 item 5). The tool
 * reads no argument, relays nothing to the Processor and touches no store; the
 * call is recorded as refused under `schedules.lease.release` on `mcp`.
 */
export const LEASE_RELEASE_TOOL = "kogane.schedules.lease.release";
/** The one answer of the lease release tool: the delegation layer's code for an R3 operation. */
export const LEASE_RELEASE_REFUSAL = "operation_not_delegable";
const leaseReleaseSchema = z.strictObject({
  source: sourceId,
  leaseRef: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u),
  // The page's confirmation that the execution stopped, as its route requires.
  confirmedStopped: z.literal(true),
});
export const LEASE_RELEASE_MCP_TOOLS = [
  {
    name: LEASE_RELEASE_TOOL,
    title: "Release a stopped collection's lease (operator only)",
    description:
      "Refuses every call with operation_not_delegable. Releasing a collection lease asserts that the execution holding it stopped, which the server cannot verify, so only the operator releases it on the schedules page (risk class R3). The call is recorded; nothing is released and the Processor is not contacted.",
    inputSchema: inputSchema(leaseReleaseSchema),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
] as const;
/** Every call, whatever its arguments or its caller's grant and delegation. */
export function leaseReleaseTool(): ToolResult {
  return refusal(403, LEASE_RELEASE_REFUSAL);
}
