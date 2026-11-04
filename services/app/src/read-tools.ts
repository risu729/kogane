// Additional read adapters over the existing history and common audit readers.
import { z } from "zod";
import {
  type Grant,
  grantAllows,
  d1CommandStore,
  ERROR_STATUS,
  auditPageFilters,
  readEconomicRowReadinessForGrant,
} from "../../../packages/application/src/index";
import {
  readAuditForGrant,
  readAuditRecordForGrant,
} from "../../../packages/application/src/audit/read.ts";
import { readInstrumentHistoryForGrant } from "../../../packages/application/src/query/instrument-history-read.ts";
import { ECONOMIC_ROW_READINESS_SCHEMA } from "../../../packages/domain/src/economic-row-readiness.ts";
import { INSTRUMENT_IDENTIFIER_ID } from "../../../packages/application/src/query/instrument-candidates-review.ts";
import { d1Executor } from "../../../packages/read-model/src/d1.ts";
import type { ToolResult } from "./agent-service";
import { HttpError } from "./http";
import { parseRequest } from "./ops-api";

const schemas = {
  "kogane.instruments.history": z.strictObject({
    identifierId: z.string().regex(INSTRUMENT_IDENTIFIER_ID),
  }),
  "kogane.economic-readiness.read": z.strictObject({
    schema: z.literal(ECONOMIC_ROW_READINESS_SCHEMA),
    family: z.enum(["bank-movement", "securities-execution"]),
    rows: z
      .array(
        z.strictObject({
          observationId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
          parseRunId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        }),
      )
      .min(1)
      .max(64),
    knowledge: z.literal("current"),
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
        : name === "kogane.economic-readiness.read"
          ? "Read current economic-row readiness as closed reasons, counts and digests. Requires records.read and whole-store source/account scope; at most 64 rows within the grant budget. No proposal, writer, financial value or historical coverage is enabled."
          : "Read permitted audit records, scoped before paging, with other subjects pseudonymized.",
    inputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  };
});
export function readMcpTools(grant: Grant) {
  return READ_MCP_TOOLS.filter((tool) =>
    tool.name === "kogane.instruments.history" || tool.name === "kogane.economic-readiness.read"
      ? grantAllows(grant, "records.read") &&
        grant.scopes.sources === "*" &&
        grant.scopes.accounts === "*"
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
      case "kogane.economic-readiness.read": {
        // The shared service grades scope before validation or database access.
        const outcome = await readEconomicRowReadinessForGrant({
          grant,
          sql: d1Executor(env.DB),
          request: body,
        });
        if (outcome.status === "refused")
          return { status: ERROR_STATUS[outcome.error.code], body: outcome.error };
        if (outcome.status === "unavailable")
          return {
            status: 503,
            body: outcome,
            auditOutcome: { result: "failed", code: outcome.reason },
          };
        return { status: 200, body: outcome };
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
