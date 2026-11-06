// Additional read adapters over the existing history, economic events and
// common audit readers.
import { z } from "zod";
import {
  type Grant,
  grantAllows,
  d1CommandStore,
  ERROR_STATUS,
  auditPageFilters,
  financialError,
} from "../../../packages/application/src/index";
import {
  readAuditForGrant,
  readAuditRecordForGrant,
} from "../../../packages/application/src/audit/read.ts";
import { readInstrumentHistoryForGrant } from "../../../packages/application/src/query/instrument-history-read.ts";
import { INSTRUMENT_IDENTIFIER_ID } from "../../../packages/application/src/query/instrument-candidates-review.ts";
import { d1Executor } from "../../../packages/read-model/src/d1.ts";
import { ACTIVITY_BASES } from "../../../packages/read-model/src/index";
import type { ToolResult } from "./agent-service";
import { HttpError } from "./http";
import { parseRequest } from "./ops-api";
import { readEvents } from "./events-api";

/**
 * `kogane.events.read` (plan D19): `GET /api/v2/activity` and
 * `GET /api/v2/obligations` for an agent. Served exactly while those routes
 * are (`eventsV2`, the A10 projection exists); otherwise the path is 404 and
 * the MCP name `unknown_tool`.
 */
export const EVENTS_TOOL_NAME = "kogane.events.read";

/** Whole-store `records.read`: the listing rule of the record reads (ADR 0063 decision 10). */
function wholeStoreRecords(grant: Grant): boolean {
  return (
    grantAllows(grant, "records.read") &&
    grant.scopes.sources === "*" &&
    grant.scopes.accounts === "*"
  );
}

/**
 * The grant refusal of a whole-store record read, before its body is
 * validated: `records.read`, then `"*"` on both scope axes (plan section 5.3,
 * ADR 0063 decision 10). Null when the grant may read.
 */
function wholeStoreRefusal(grant: Grant, operation: string): ToolResult | null {
  if (!grantAllows(grant, "records.read"))
    return {
      status: ERROR_STATUS.unauthorized,
      body: financialError("unauthorized", operation, ["capability:records.read"]),
    };
  const narrowed = [
    ...(grant.scopes.sources === "*" ? [] : ["scope:source"]),
    ...(grant.scopes.accounts === "*" ? [] : ["scope:account"]),
  ];
  return narrowed.length === 0
    ? null
    : {
        status: ERROR_STATUS.evidence_restricted,
        body: financialError("evidence_restricted", operation, narrowed),
      };
}

const schemas = {
  "kogane.instruments.history": z.strictObject({
    identifierId: z.string().regex(INSTRUMENT_IDENTIFIER_ID),
  }),
  "kogane.audit.search": z.strictObject({
    filters: z.record(z.string(), z.string()).optional(),
    cursor: z.string().min(1).max(400).nullable().optional(),
  }),
  "kogane.audit.get": z.strictObject({
    auditId: z
      .string()
      .regex(/^aud_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
  }),
  // The routes' query parameters, as a body. The basis is the reader's closed
  // list; what depends on the route (a basis for obligations, the offset's
  // range) is checked by the routes' own rules (`readEvents`), so that refusal
  // keeps the route's code.
  "kogane.events.read": z.strictObject({
    list: z.enum(["activity", "obligations"]),
    basis: z.enum(ACTIVITY_BASES).optional(),
    offset: z.number().int().optional(),
  }),
};
export type ReadToolName = keyof typeof schemas;
export function isReadToolName(name: string): name is ReadToolName {
  return Object.hasOwn(schemas, name);
}
export const READ_MCP_TOOLS = Object.entries(schemas).map(([name, schema]) => {
  const inputSchema = z.toJSONSchema(schema) as Record<string, unknown>;
  delete inputSchema["$schema"];
  return {
    name,
    title: name.slice(7),
    description:
      name === "kogane.instruments.history"
        ? "Read the same append-only instrument history as the owner UI, under records.read and a whole-store read grant."
        : name === EVENTS_TOOL_NAME
          ? "Adopted economic events (list: activity, on one basis: cash-movement by default or purchase-recognition) or obligations with their settlements, 200 a page from offset. The same answer as GET /api/v2/activity or /api/v2/obligations, under records.read and a whole-store read grant. Every quantity keeps its basis and unit; bases are never merged, and an outstanding amount that is not exact is null with a reason, never zero."
          : "Read permitted audit records, scoped before paging, with other subjects pseudonymized.",
    inputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  };
});
/** `events`: whether this deployment serves `GET /api/v2/activity` and `/api/v2/obligations`. */
export function readMcpTools(grant: Grant, served: { events: boolean }) {
  return READ_MCP_TOOLS.filter((tool) =>
    tool.name === "kogane.instruments.history"
      ? wholeStoreRecords(grant)
      : tool.name === EVENTS_TOOL_NAME
        ? served.events && wholeStoreRecords(grant)
        : grantAllows(grant, "audit.read") && grant.scopes.accounts === "*",
  );
}
export async function callReadTool(
  name: ReadToolName,
  body: unknown,
  env: Env,
  grant: Grant,
): Promise<ToolResult> {
  try {
    switch (name) {
      case "kogane.instruments.history": {
        const input = parseRequest(schemas[name], body ?? {});
        const outcome = await readInstrumentHistoryForGrant({
          grant,
          sql: d1Executor(env.DB),
          identifierId: input.identifierId,
        });
        return outcome.ok
          ? { status: 200, body: outcome.history }
          : { status: ERROR_STATUS[outcome.error.code], body: outcome.error };
      }
      case "kogane.events.read": {
        const refusal = wholeStoreRefusal(grant, "events.read");
        if (refusal) return refusal;
        const input = parseRequest(schemas[name], body ?? {});
        // The route's own request rules and reader; its refusals keep their codes.
        const parameters = new URLSearchParams();
        if (input.basis !== undefined) parameters.set("basis", input.basis);
        if (input.offset !== undefined) parameters.set("offset", String(input.offset));
        return {
          status: 200,
          body: await readEvents(env, `/api/v2/${input.list}`, parameters),
        };
      }
      case "kogane.audit.search": {
        const input = parseRequest(schemas[name], body ?? {});
        const filters = auditPageFilters(input.filters ?? {});
        if (!filters) throw new HttpError(400, "invalid_query");
        const outcome = await readAuditForGrant({
          store: d1CommandStore(env.DB),
          grant,
          filters,
          cursor: input.cursor ?? null,
        });
        return outcome.ok
          ? {
              status: 200,
              body: {
                schemaVersion: "kogane-audit-page-v1",
                records: outcome.records,
                cursor: outcome.cursor,
              },
            }
          : {
              status:
                outcome.code === "invalid_query"
                  ? 400
                  : outcome.code === "stale_context"
                    ? 409
                    : 403,
              body: { error: outcome.code },
            };
      }
      case "kogane.audit.get": {
        const input = parseRequest(schemas[name], body ?? {});
        const outcome = await readAuditRecordForGrant({
          store: d1CommandStore(env.DB),
          grant,
          auditId: input.auditId,
        });
        return outcome.ok
          ? {
              status: 200,
              body: { schemaVersion: "kogane-audit-record-v1", record: outcome.record },
            }
          : { status: outcome.code === "invalid_query" ? 400 : 403, body: { error: outcome.code } };
      }
    }
  } catch (error) {
    if (error instanceof HttpError) return { status: error.status, body: { error: error.code } };
    throw error;
  }
}
