// Additional read adapters over the existing history, instrument coverage
// (ADR 0073), dated reported state, account correspondence candidates
// (ADR 0077), collection quality (ADR 0045: the summary and one source's
// cells; ADR 0082: the cells per account) and common audit readers.
import { z } from "zod";
import {
  type Grant,
  grantAllows,
  d1CommandStore,
  ERROR_STATUS,
  auditPageFilters,
  financialError,
  readEconomicRowReadinessForGrant,
} from "../../../packages/application/src/index";
import {
  readAuditForGrant,
  readAuditRecordForGrant,
} from "../../../packages/application/src/audit/read.ts";
import {
  ACCOUNT_CANDIDATE_VIEWS,
  ACCOUNT_CANDIDATES_MAX_OFFSET,
  ACCOUNT_SOURCE_ACCOUNT_ID,
  reviewAccountCandidates,
} from "../../../packages/application/src/query/account-candidates.ts";
import {
  COLLECTION_QUALITY_MAX_OFFSET,
  COLLECTION_QUALITY_SOURCE,
  readAccountCoverageForGrant,
  readCollectionQualityCellsForGrant,
  readCollectionQualitySummaryForGrant,
  type CollectionQualityOutcome,
} from "../../../packages/application/src/query/collection-quality.ts";
import { readInstrumentCoverage } from "../../../packages/application/src/query/instrument-coverage.ts";
import { readInstrumentHistoryForGrant } from "../../../packages/application/src/query/instrument-history-read.ts";
import { ECONOMIC_ROW_READINESS_SCHEMA } from "../../../packages/domain/src/economic-row-readiness.ts";
import { INSTRUMENT_IDENTIFIER_ID } from "../../../packages/application/src/query/instrument-candidates-review.ts";
import { d1Executor } from "../../../packages/read-model/src/d1.ts";
import type { ToolResult } from "./agent-service";
import { collectionQualityAlarms } from "./collection-quality-alarms";
import { HttpError } from "./http";
import { parseRequest } from "./ops-api";
import {
  readReportedState,
  REPORTED_STATE_ACCOUNT,
  REPORTED_STATE_DATE,
  REPORTED_STATE_SOURCE,
} from "./reported-state-api";

/**
 * `kogane.reported-state.read` (plan D5): `GET /api/v2/reported-state` for an
 * agent. Served exactly while that route is (its views exist); otherwise the
 * path is 404 and the MCP name `unknown_tool`.
 */
export const REPORTED_STATE_TOOL_NAME = "kogane.reported-state.read";

const schemas = {
  "kogane.instruments.history": z.strictObject({
    identifierId: z.string().regex(INSTRUMENT_IDENTIFIER_ID),
  }),
  // The route's query parameters, as a body; the patterns are the route's own.
  "kogane.reported-state.read": z.strictObject({
    date: z.string().regex(REPORTED_STATE_DATE),
    source: z.string().regex(REPORTED_STATE_SOURCE).optional(),
    account: z.string().regex(REPORTED_STATE_ACCOUNT).optional(),
  }),
  // The route's one parameter, with the identity catalogue's limits.
  "kogane.instruments.coverage": z.strictObject({
    source: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[^\u0000-\u001f]+$/u)
      .optional(),
  }),
  // The route's parameters, with the service's own limits.
  "kogane.accounts.candidates": z.strictObject({
    view: z.enum(ACCOUNT_CANDIDATE_VIEWS).optional(),
    offset: z.number().int().min(0).max(ACCOUNT_CANDIDATES_MAX_OFFSET).optional(),
    sourceAccountId: z.string().regex(ACCOUNT_SOURCE_ACCOUNT_ID).optional(),
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
  // The routes' path segment and query (ADR 0045), with the service's own limits.
  "kogane.collection-quality.summary": z.strictObject({}),
  "kogane.collection-quality.cells": z.strictObject({
    source: z.string().regex(COLLECTION_QUALITY_SOURCE),
    offset: z.number().int().min(0).max(COLLECTION_QUALITY_MAX_OFFSET).optional(),
  }),
  // The route's one path segment (ADR 0082): the source whose cells are regrouped.
  "kogane.collection-quality.accounts": z.strictObject({
    source: z.string().regex(COLLECTION_QUALITY_SOURCE),
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
const DESCRIPTIONS: Record<ReadToolName, string> = {
  "kogane.instruments.history":
    "Read the same append-only instrument history as the owner UI, under records.read and a whole-store read grant.",
  "kogane.reported-state.read":
    "What each provider last reported on a date (YYYY-MM-DD, Asia/Tokyo, not after today), per account, from the latest complete capture before the end of that date, beside the card statements due around it; optionally one source or one account. The same answer as GET /api/v2/reported-state, under records.read and a whole-store read grant. Provider figures only: nothing is added, converted or netted, and a container without a capture is named in the coverage, never shown as zero.",
  "kogane.instruments.coverage":
    "Count each source's instrument identifiers by candidate state, the same counts as the owner UI, under summary.read and a whole-store read grant.",
  "kogane.accounts.candidates":
    "One page of the ADR 0077 account correspondence candidates: which direct provider source accounts a reviewed aggregator connection contains, on which evidence, with closed status, hold and same-account reasons, under records.read and a whole-store read grant. Read-only; never proposes same_account. A candidate names the relation.accept or relation.reject payload that would decide it; deciding is a plan through the change lifecycle, graded there.",
  "kogane.economic-readiness.read":
    "Read current economic-row readiness as closed reasons, counts and digests. Requires records.read and whole-store source/account scope; at most 64 rows within the grant budget. No proposal, writer, financial value or historical coverage is enabled.",
  "kogane.collection-quality.summary":
    "Collection quality across the store (ADR 0045): every configured collection job with its enabled and supported settings, held lease, newest receipt and the runs it names as CORE has them, and the actual Alarm reservation where the relay answers; and every visible CORE source with its collectors, newest fetch run, never-registered terminals and closed reasons. The same answer as GET /api/collection-quality, under evidence.read and a whole-store read grant. Identifiers, times, counts and closed codes only; no amount. A missing stage is a reason, never a zero or a success.",
  "kogane.collection-quality.cells":
    "One page (500) of one source's collection quality cells (ADR 0045): per dataset, parser, fetch unit and period, the newest capture's run, unit, artifact, raw, parse and coverage facts, the current capture, the state (current, older-current, no-current) and closed reasons; offset pages on (coverage.nextOffset). The same answer as GET /api/collection-quality/<source>?offset=N, under evidence.read and a whole-store read grant. A fetch unit key is not an account; no amount; a period no capture has is not listed.",
  "kogane.collection-quality.accounts":
    "One source's collection quality cells regrouped by the accounts their newest or current capture's observations name (ADR 0082): per account its mapping statuses and data types (dataset, parser, observation kind), each with its periods, closed standing and reasons, and apart the cells no observation attributes to an account. The same answer as GET /api/collection-quality/<source>/accounts, under evidence.read and a whole-store read grant. A period no capture has is not listed and not claimed missing; nothing is inferred from a unit key.",
  "kogane.audit.search":
    "Read permitted audit records, scoped before paging, with other subjects pseudonymized.",
  "kogane.audit.get":
    "Read permitted audit records, scoped before paging, with other subjects pseudonymized.",
};
export const READ_MCP_TOOLS = Object.entries(schemas).map(([name, schema]) => {
  const inputSchema = z.toJSONSchema(schema) as Record<string, unknown>;
  delete inputSchema["$schema"];
  return {
    name,
    title: name.slice(7),
    description: DESCRIPTIONS[name as ReadToolName],
    inputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  };
});
/** Whether the grant reaches the whole store on both axes. */
const wholeStore = (grant: Grant) => grant.scopes.sources === "*" && grant.scopes.accounts === "*";
/**
 * The read tools listed to this grant: each only to a grant its service would
 * answer. A call by any other grant is refused by the service itself, with the
 * same closed code on both transports. `reportedState`: whether this deployment
 * serves `GET /api/v2/reported-state`.
 */
export function readMcpTools(grant: Grant, served: { reportedState: boolean }) {
  return READ_MCP_TOOLS.filter((tool) => {
    switch (tool.name as ReadToolName) {
      case "kogane.instruments.history":
        return grantAllows(grant, "records.read") && wholeStore(grant);
      case "kogane.reported-state.read":
        return served.reportedState && grantAllows(grant, "records.read") && wholeStore(grant);
      case "kogane.instruments.coverage":
        return grantAllows(grant, "summary.read") && wholeStore(grant);
      case "kogane.accounts.candidates":
      case "kogane.economic-readiness.read":
        return grantAllows(grant, "records.read") && wholeStore(grant);
      case "kogane.collection-quality.summary":
      case "kogane.collection-quality.cells":
      case "kogane.collection-quality.accounts":
        return grantAllows(grant, "evidence.read") && wholeStore(grant);
      case "kogane.audit.search":
      case "kogane.audit.get":
        return grantAllows(grant, "audit.read") && grant.scopes.accounts === "*";
    }
  });
}
/** A collection quality service's answer: its value, or its `FinancialError` at that code's status. */
function collectionQualityResult<T>(outcome: CollectionQualityOutcome<T>): ToolResult {
  return outcome.ok
    ? { status: 200, body: outcome.value }
    : { status: ERROR_STATUS[outcome.error.code], body: outcome.error };
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
      case "kogane.reported-state.read": {
        // The grant first, before the body is validated: records.read over the
        // whole store (plan D5, ADR 0063 decision 10).
        if (!grantAllows(grant, "records.read"))
          return {
            status: ERROR_STATUS.unauthorized,
            body: financialError("unauthorized", "reported-state.read", [
              "capability:records.read",
            ]),
          };
        const narrowed = [
          ...(grant.scopes.sources === "*" ? [] : ["scope:source"]),
          ...(grant.scopes.accounts === "*" ? [] : ["scope:account"]),
        ];
        if (narrowed.length > 0)
          return {
            status: ERROR_STATUS.evidence_restricted,
            body: financialError("evidence_restricted", "reported-state.read", narrowed),
          };
        const input = parseRequest(schemas[name], body ?? {});
        // The route's own request rules and reader; its refusals keep their codes.
        const state = await readReportedState(env, {
          date: input.date,
          source: input.source ?? null,
          account: input.account ?? null,
        });
        return { status: 200, body: { apiVersion: 2, ...state } };
      }
      case "kogane.instruments.coverage": {
        const input = parseRequest(schemas[name], body ?? {});
        const outcome = await readInstrumentCoverage({
          grant,
          sql: d1Executor(env.DB),
          source: input.source ?? null,
        });
        return outcome.ok
          ? { status: 200, body: outcome.coverage }
          : { status: ERROR_STATUS[outcome.error.code], body: outcome.error };
      }
      case "kogane.accounts.candidates": {
        // The page's own service and request: capability, perimeter, bounds
        // and refusals are decided there, once for both transports.
        const input = parseRequest(schemas[name], body ?? {});
        const outcome = await reviewAccountCandidates({
          grant,
          sql: d1Executor(env.DB),
          request: {
            view: input.view ?? "open",
            offset: input.offset ?? 0,
            sourceAccountId: input.sourceAccountId ?? null,
          },
        });
        return outcome.ok
          ? { status: 200, body: outcome.review }
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
      // The page's own services (ADR 0081): grant, perimeter, store, source,
      // offset and bounds are decided there, once for both transports.
      case "kogane.collection-quality.summary": {
        const input = parseRequest(schemas[name], body ?? {});
        return collectionQualityResult(
          await readCollectionQualitySummaryForGrant({
            grant,
            sql: d1Executor(env.DB),
            request: input,
            alarms: collectionQualityAlarms(env),
          }),
        );
      }
      case "kogane.collection-quality.cells": {
        const input = parseRequest(schemas[name], body ?? {});
        return collectionQualityResult(
          await readCollectionQualityCellsForGrant({
            grant,
            sql: d1Executor(env.DB),
            request: input,
          }),
        );
      }
      case "kogane.collection-quality.accounts": {
        const input = parseRequest(schemas[name], body ?? {});
        return collectionQualityResult(
          await readAccountCoverageForGrant({ grant, sql: d1Executor(env.DB), request: input }),
        );
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
