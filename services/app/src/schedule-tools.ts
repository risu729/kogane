// Maintenance-window tools for agents (ADR 0046).
//
// Two MCP tools over the Processor's existing settings service: read the
// maintenance settings of the sources a grant names, and append one revision
// of one maintenance rule of one of them. They are graded by this API's grant
// (`AGENT_API_GRANTS`): `schedules.read` and `schedules.maintenance.update`,
// scoped by `scopes.scheduleSources`. No financial capability implies either,
// and neither reaches a job edit, enable/disable, lease release, collection,
// observation or evidence.
//
// This module decides only what the grant decides — the capability, the
// source scope and the caller's actor shape — and checks the arguments'
// shape with the same Zod schema it publishes (as `ops-tools.ts` does), so
// the advertised and the enforced contract cannot drift. What a maintenance
// window means — its registered reference host, the expected revision, the
// calendar validity of the period, the reason, the deferral bound and the
// budget — is decided once, by the Processor's writer
// (`writeMaintenanceRevision` in services/processor/src/schedule-store.ts),
// which the operator page uses too. The operator HTTP routes in
// `schedules-api.ts` are untouched: an agent grant still reaches none of them.
//
// `referenceUrl` is stored provenance: it must be https on the source's
// already registered maintenance host, and nothing here or in the Processor
// fetches it.
import { z } from "zod";
import {
  ACTOR_PATTERN,
  type Grant,
  grantAllows,
  grantAllowsScheduleSource,
} from "../../../packages/application/src/index";
import { TIME, ZONES } from "../../../packages/collection/src/schedule-model";
import type { ToolResult } from "./agent-service";

const SCHEDULE_READ_TOOL = "kogane.schedules.maintenance.read";
const SCHEDULE_UPDATE_TOOL = "kogane.schedules.maintenance.update";
export const SCHEDULE_TOOL_NAMES = [SCHEDULE_READ_TOOL, SCHEDULE_UPDATE_TOOL] as const;
export type ScheduleToolName = (typeof SCHEDULE_TOOL_NAMES)[number];

export function isScheduleToolName(value: string): value is ScheduleToolName {
  return (SCHEDULE_TOOL_NAMES as readonly string[]).includes(value);
}

/** The tools exist exactly while the settings routes do (`SCHEDULES_ENABLED`). */
export function schedulesServed(env: Pick<Env, "SCHEDULES_ENABLED">): boolean {
  return (env.SCHEDULES_ENABLED as string | undefined) === "true";
}

const sourceId = z.string().regex(/^[a-z0-9-]{1,100}$/u);
const clock = z.string().regex(TIME);
const instant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
const weekday = z.int().min(0).max(6);

/** `kogane.schedules.maintenance.read`: one granted source, or all of them. */
const scheduleReadSchema = z.strictObject({ source: sourceId.optional() });

/** `kogane.schedules.maintenance.update`: one revision of one rule of one source. */
export const scheduleUpdateSchema = z.strictObject({
  source: sourceId,
  /** Omitted to create a rule; the writer then chooses its id. */
  ruleId: sourceId.optional(),
  /** The rule's current revision; 0 to create. */
  revision: z.int().min(0),
  timezone: z.enum(ZONES),
  pattern: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("weekly"),
      weekdays: z.array(weekday).min(1).max(7),
      start: clock,
      end: clock,
    }),
    z.strictObject({
      kind: z.literal("monthly"),
      weekday,
      nth: z.int().min(1).max(5),
      offsetDays: z.int().min(0).max(6),
      start: clock,
      end: clock,
    }),
    z.strictObject({ kind: z.literal("once"), from: instant, to: instant }),
  ]),
  enabled: z.boolean(),
  scope: z.enum(["collection", "session", "feature-only"]),
  referenceUrl: z
    .string()
    .regex(/^https:\/\//u)
    .max(1500),
  verifiedAt: instant,
  reason: z.string().min(1).max(500),
});

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
      "Public maintenance rules with their revision history, the registered maintenance reference, and per schedule the original next occurrence, the maintenance-adjusted due time, the actual alarm, whether the reservation is armed or pending, and the latest receipt's outcome. Only sources in this grant's scheduleSources; no financial data.",
    inputSchema: inputSchema(scheduleReadSchema),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: SCHEDULE_UPDATE_TOOL,
    title: "Append one maintenance-rule revision for a granted source",
    description:
      "Create a rule (omit ruleId, revision 0) or revise one (ruleId and its current revision). A stale revision is refused. Requires a reason, the announcement's https page on the source's registered maintenance site (stored, never fetched) and when it was checked. The joined deferral a revision creates is bounded. Answers with the saved revision and the source's next run and reservation state. Never edits a job, enables or disables one, releases a lease or starts collection.",
    inputSchema: inputSchema(scheduleUpdateSchema),
    annotations: {
      readOnlyHint: false,
      // Revisions are appended; nothing is deleted or overwritten.
      destructiveHint: false,
      // A create chooses a new rule id each time.
      idempotentHint: false,
      openWorldHint: false,
    },
  },
] as const;

const REQUIRES: Record<ScheduleToolName, "schedules.read" | "schedules.maintenance.update"> = {
  [SCHEDULE_READ_TOOL]: "schedules.read",
  [SCHEDULE_UPDATE_TOOL]: "schedules.maintenance.update",
};

/** The tools this grant can use; a tool whose capability it lacks is not listed. */
export function scheduleToolsFor(grant: Grant): (typeof SCHEDULE_MCP_TOOLS)[number][] {
  return SCHEDULE_MCP_TOOLS.filter((tool) => grantAllows(grant, REQUIRES[tool.name]));
}

function refusal(status: number, error: string): ToolResult {
  return { status, body: { error } };
}

async function relay(
  env: Pick<Env, "PIPELINE">,
  suffix: "/agent/read" | "/agent/maintenance",
  principal: string,
  body: unknown,
): Promise<ToolResult> {
  let response: Response;
  try {
    response = await env.PIPELINE.fetch(
      new Request(`https://observation-pipeline.internal/internal/schedules${suffix}`, {
        method: "POST",
        headers: {
          "x-kogane-internal-caller": "kogane-evidence-browser",
          // The agent travels in its own header; the operator header is never set.
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
 * Runs one maintenance tool for a grant. The principal recorded as the
 * revision's actor is the grant's, which is the verified Access principal; no
 * argument names an actor.
 */
export async function callScheduleTool(
  name: ScheduleToolName,
  body: unknown,
  env: Pick<Env, "PIPELINE">,
  grant: Grant,
): Promise<ToolResult> {
  if (!grantAllows(grant, REQUIRES[name])) return refusal(403, "unauthorized");
  if (!ACTOR_PATTERN.test(grant.principal)) return refusal(403, "actor_not_supported");
  if (name === SCHEDULE_READ_TOOL) {
    const parsed = scheduleReadSchema.safeParse(body ?? {});
    if (!parsed.success) return refusal(400, "invalid_request");
    const { source } = parsed.data;
    if (source === undefined) {
      const scope = grant.scopes.scheduleSources ?? [];
      return relay(env, "/agent/read", grant.principal, {
        sources: scope === "*" ? "*" : [...scope],
      });
    }
    // Any source outside the grant is refused alike, whether or not it exists.
    if (!grantAllowsScheduleSource(grant, source)) return refusal(403, "source_not_granted");
    return relay(env, "/agent/read", grant.principal, { sources: [source] });
  }
  const parsed = scheduleUpdateSchema.safeParse(body ?? {});
  if (!parsed.success) return refusal(400, "invalid_request");
  if (!grantAllowsScheduleSource(grant, parsed.data.source))
    return refusal(403, "source_not_granted");
  return relay(env, "/agent/maintenance", grant.principal, parsed.data);
}
