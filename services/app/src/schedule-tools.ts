// Maintenance-window tools for agents (ADR 0046 as amended by ADR 0063,
// item 8; plan slice S4).
//
// Two tools over the Processor's settings service, each recorded through the
// common chokepoint (`executeOperation`, ADR 0064) by the dispatcher that
// calls it:
//
// * `kogane.schedules.maintenance.read` (`schedules.maintenance.read`, R0):
//   the maintenance settings of the sources a grant names. Graded by this
//   API's grant (`AGENT_API_GRANTS`): `schedules.read`, scoped by
//   `scopes.scheduleSources`. Served on `/mcp` and on
//   `POST /api/agent/v1/schedules.maintenance.read`, one function for both, so
//   the two answer the same object.
// * `kogane.schedules.maintenance.update` (`schedules.maintenance.update`,
//   R1; R3 beyond the seven-day bound): one maintenance revision. It is an
//   operation the owner may delegate, never an agent-API capability: only an
//   MCP client (`mcp-client:<sub>`, ADR 0047) holding a delegation that
//   #628's resolver answers (`resolveDelegation`) with
//   `schedules.maintenance.update` could reach it, and only on `/mcp`. No
//   delegation executes yet: `delegationExecutionReadiness` answers
//   `available: false` for every capability until plan slice S3 connects the
//   delegated audit record, operation path and Processor guards. So the tool
//   is published to nobody, every call is refused with a closed code before
//   anything is relayed, and there is no code here that relays a delegated
//   write. When S3 lands, the relay goes where the last refusal is, to the
//   Processor's single writer (`writeMaintenanceRevision`).
//
// This module decides only what the grant or the delegation decides — the
// capability, the source scope and the caller's shape — and checks the
// arguments with the same Zod schema it publishes (as `ops-tools.ts` does).
// What a maintenance window means — its registered reference host, the
// expected revision, the calendar validity of the period, the closed reason,
// the deferral bound and the budget — is decided once, by the Processor's
// writer, which the operator page uses too. The operator HTTP routes in
// `schedules-api.ts` are untouched: neither tool reaches them.
import { z } from "zod";
import {
  ACTOR_PATTERN,
  delegationExecutionReadiness,
  type DelegationResolution,
  type Grant,
  grantAllows,
  grantAllowsScheduleSource,
  parseGrants,
  resolveDelegation,
} from "../../../packages/application/src/index";
import {
  DELEGATED_MAINTENANCE_REASONS,
  TIME,
  ZONES,
} from "../../../packages/collection/src/schedule-model";
import type { ToolResult } from "./agent-service";
import type { AgentCaller } from "./auth";
import type { DelegationVars } from "./delegation";

/** On `/mcp` and, as `schedules.maintenance.read`, on `/api/agent/v1/*`. */
export const SCHEDULE_READ_TOOL = "kogane.schedules.maintenance.read";
/** On `/mcp` only: a browser session yields no delegation. */
export const SCHEDULE_UPDATE_TOOL = "kogane.schedules.maintenance.update";
/** The capability a delegation must hold for the update tool (ADR 0063). */
const UPDATE_CAPABILITY = "schedules.maintenance.update";

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
  /** Why, as a closed code; never free text. */
  reason: z.enum(DELEGATED_MAINTENANCE_REASONS),
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
      "Public maintenance rules with their revision history (actor kind and closed reason), the registered maintenance reference, and per schedule the original next occurrence, the maintenance-adjusted due time, the actual alarm, whether the reservation is armed or pending, and the latest receipt's outcome. Only sources in this grant's scheduleSources; no financial data.",
    inputSchema: inputSchema(scheduleReadSchema),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
] as const;

/** The tools this grant can use: the read, with `schedules.read`. The update is published to nobody yet. */
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

/** The HTTP status of a delegation refusal: a table that cannot be read is the deployment's fault. */
function delegationStatus(code: string): number {
  return code === "delegation_misconfigured" ? 503 : 403;
}

/**
 * `kogane.schedules.maintenance.update` for an MCP caller. Its gates, in
 * order: the caller's delegation (#628's resolver; no bare subject, no
 * browser session and no `AGENT_API_GRANTS` entry stands in for one), the
 * delegated capability, the arguments, the delegation's schedule scope, and
 * then whether delegated execution is connected at all — which it is not
 * (`delegationExecutionReadiness` is `available: false` by type). Every call
 * therefore ends in a closed refusal, and nothing is relayed or written.
 */
export async function updateScheduleTool(
  body: unknown,
  env: DelegationVars,
  caller: AgentCaller,
  now: string,
): Promise<ToolResult> {
  const resolution: DelegationResolution = await resolveDelegation({
    configured: env.MCP_DELEGATIONS,
    operatorSubjects: env.OPERATOR_SUBJECTS,
    readGrants: parseGrants(env.AGENT_API_GRANTS),
    caller,
    now,
  });
  if (!resolution.ok) return refusal(delegationStatus(resolution.code), resolution.code);
  const delegated = resolution.principal;
  if (!delegated.capabilities.includes(UPDATE_CAPABILITY))
    return refusal(403, "delegation_capability_denied");
  const parsed = scheduleUpdateSchema.safeParse(body ?? {});
  if (!parsed.success) return refusal(400, "invalid_request");
  // Any source outside the delegation is refused alike, whether or not it exists.
  const scope = delegated.scopes.scheduleSources;
  if (scope !== "*" && !scope.includes(parsed.data.source))
    return refusal(403, "source_not_granted");
  // Plan slice S3 connects delegated execution here. Until it does, readiness
  // is `available: false` for every capability, and this is the answer.
  const readiness = delegationExecutionReadiness(resolution, UPDATE_CAPABILITY);
  return refusal(delegationStatus(readiness.reason), readiness.reason);
}
