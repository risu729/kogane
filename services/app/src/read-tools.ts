// Additional read adapters over the existing history, instrument coverage
// (ADR 0073), dated reported state, account correspondence candidates and
// one source account's correction history (ADR 0077), card statements
// without a settlement candidate (ADR 0074's 2026-11-07 amendment) and common
// audit readers.
import { z } from "zod";
import {
  type Grant,
  grantAllows,
  d1CommandStore,
  ERROR_STATUS,
  auditPageFilters,
  financialError,
  readEconomicRowReadinessForGrant,
  readCardSettlementsForGrant,
  readCardSettlementStatementsForGrant,
  readCardOwnershipForGrant,
  CARD_SETTLEMENT_PROPOSAL_ID,
  CARD_SETTLEMENTS_MAX_OFFSET,
  CARD_SETTLEMENT_STATEMENT_KEY_MAX,
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
  reviewUnmatchedCardStatements,
  UNMATCHED_MAX_OFFSET,
} from "../../../packages/application/src/query/card-statements-unmatched.ts";
import { readInstrumentCoverage } from "../../../packages/application/src/query/instrument-coverage.ts";
import { readInstrumentHistoryForGrant } from "../../../packages/application/src/query/instrument-history-read.ts";
import { readAccountHistoryForGrant } from "../../../packages/application/src/query/account-history-read.ts";
import { ECONOMIC_ROW_READINESS_SCHEMA } from "../../../packages/domain/src/economic-row-readiness.ts";
import { INSTRUMENT_IDENTIFIER_ID } from "../../../packages/application/src/query/instrument-candidates-review.ts";
import { d1Executor } from "../../../packages/read-model/src/d1.ts";
import type { ToolResult } from "./agent-service";
import { HttpError } from "./http";
import { parseRequest } from "./ops-api";
import {
  readReportedState,
  REPORTED_STATE_ACCOUNT,
  REPORTED_STATE_DATE,
  REPORTED_STATE_SOURCE,
} from "./reported-state-api";
import { mcpInputSchema } from "./mcp-input-schema";

/**
 * `kogane.reported-state.read` (plan D5): `GET /api/v2/reported-state` for an
 * agent. Served exactly while that route is (its views exist); otherwise the
 * path is 404 and the MCP name `unknown_tool`.
 */
export const REPORTED_STATE_TOOL_NAME = "kogane.reported-state.read";
/**
 * The カード照合 reads: served exactly while
 * `GET /api/v2/reconciliation/card-settlements` and
 * `GET /api/v2/reconciliation/card-statements-unmatched` are (both need the
 * settlement views, `cardSettlementsAvailable`); otherwise the path is 404 and
 * the MCP name `unknown_tool`.
 */
export const CARD_SETTLEMENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "kogane.card-settlements.read",
  "kogane.card-settlements.statements",
  "kogane.card-settlements.ownership",
  "kogane.card-settlements.unmatched",
]);

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
  // The route's one parameter, with the service's own pattern.
  "kogane.accounts.history": z.strictObject({
    sourceAccountId: z.string().regex(ACCOUNT_SOURCE_ACCOUNT_ID),
  }),
  // The route's one parameter, with the service's own limit.
  "kogane.card-settlements.unmatched": z.strictObject({
    offset: z.number().int().min(0).max(UNMATCHED_MAX_OFFSET).optional(),
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
  // The page route's query parameters, as a body: the published shape of the
  // service's request rules (`readCardSettlementsForGrant`), which decide.
  "kogane.card-settlements.read": z.strictObject({
    offset: z.number().int().min(0).max(CARD_SETTLEMENTS_MAX_OFFSET).optional(),
    proposalId: z.string().regex(CARD_SETTLEMENT_PROPOSAL_ID).optional(),
    statementKey: z.string().min(1).max(CARD_SETTLEMENT_STATEMENT_KEY_MAX).optional(),
    relatedTo: z.string().regex(CARD_SETTLEMENT_PROPOSAL_ID).optional(),
  }),
  // The grouped route's one parameter: the published shape of the service's
  // request rules (`readCardSettlementStatementsForGrant`), which decide.
  "kogane.card-settlements.statements": z.strictObject({
    offset: z.number().int().min(0).max(CARD_SETTLEMENTS_MAX_OFFSET).optional(),
  }),
  "kogane.card-settlements.ownership": z.strictObject({
    proposalId: z.string().regex(CARD_SETTLEMENT_PROPOSAL_ID),
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
  "kogane.accounts.history":
    "The append-only correction history of one source account, the same answer as GET /api/identity/account-history on the 口座の対応候補 page: every revision of its account mapping, every assignment or override release decided about it, and every relation row naming it on either side (connection_contains acceptances and withdrawals, same_account decisions), each with its decision kind, reason and closed origin, oldest first. Under records.read and a whole-store read grant; refused past the grant's maxRows, never truncated. Read-only; correcting it is a plan through the change lifecycle.",
  "kogane.card-settlements.unmatched":
    "One page of the card statement totals no settlement candidate cites, the same answer as the operator's カード照合 page: each statement's closed reason (statement_total_refund_or_zero, statement_not_comparable, no_debit_in_window, no_equal_amount_debit, equal_amount_debit_awaiting_sweep) and, for no_equal_amount_debit, the ADR 0074 planner's read-only answer (window three days either side of the due date, at most three debits) with closed codes, listing at most the first 50 exact allocations per statement with allocationCount and allocationsTruncated. Under records.read and a whole-store read grant. Read-only; no allocation listed is acceptable, since the acceptance writer claims one debit.",
  "kogane.economic-readiness.read":
    "Read current economic-row readiness as closed reasons, counts and digests. Requires records.read and whole-store source/account scope; at most 64 rows within the grant budget. No proposal, writer, financial value or historical coverage is enabled.",
  "kogane.card-settlements.read":
    "The card statement to bank debit reviews of the カード照合 pages: one page (offset), one statement's candidates (statementKey, with offset), one review (proposalId, alone), or the candidates a review competes with (relatedTo, with offset: those sharing its statement key, its bank debit key, or its statement's source, resolved account and period, every status, never the review itself; not_found when it names no candidate), with the source facts, evidence references, acceptance blockers, debit-account evidence and decision history, the same answer as GET /api/v2/reconciliation/card-settlements, under records.read and a whole-store read grant. Read-only; deciding a review, or correcting a wrong acceptance by withdrawing it and accepting a competitor, is a card-settlement.accept, card-settlement.reject or card-settlement.withdraw plan through the change lifecycle, graded there.",
  "kogane.card-settlements.statements":
    "One page of the カード照合 page's review list grouped by statement (offset, counted in statements, 10 per page): each statement key with how many candidates it has and its newest five candidates and any accepted one, plus its newest older ready candidate when none of those is accepted or ready (searching at most coverage.olderCandidatesSearched older ones; leadSearch says not_searched, found, none_ready or truncated, and truncated means older ones were not judged, not that none is ready), the one the page leads with first, each with the source facts, evidence references, acceptance blockers, debit-account evidence and decision history; the statement's other candidates are kogane.card-settlements.read with statementKey. The same answer as GET /api/v2/reconciliation/card-settlements/statements, under records.read and a whole-store read grant. Read-only; deciding a review is a card-settlement.accept, card-settlement.reject or card-settlement.withdraw plan through the change lifecycle, graded there.",
  "kogane.card-settlements.ownership":
    "The ownership review of one card settlement candidate: both accounts' current mappings, recorded ownership claims, self-declaration and owner-default blockers, the same answer as GET /api/v2/reconciliation/card-settlements/ownership, under records.read and a whole-store read grant. Read-only; recording ownership is a relation plan through the change lifecycle, graded there.",
  "kogane.audit.search":
    "Read permitted audit records, scoped before paging, with other subjects pseudonymized.",
  "kogane.audit.get":
    "Read permitted audit records, scoped before paging, with other subjects pseudonymized.",
};
export const READ_MCP_TOOLS = Object.entries(schemas).map(([name, schema]) => {
  const inputSchema = mcpInputSchema(schema);
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
 * serves `GET /api/v2/reported-state`; `cardSettlements`: whether it serves
 * `GET /api/v2/reconciliation/card-settlements` (`cardSettlementsAvailable`).
 */
export function readMcpTools(
  grant: Grant,
  served: { reportedState: boolean; cardSettlements: boolean },
) {
  return READ_MCP_TOOLS.filter((tool) => {
    switch (tool.name as ReadToolName) {
      case "kogane.instruments.history":
        return grantAllows(grant, "records.read") && wholeStore(grant);
      case "kogane.reported-state.read":
        return served.reportedState && grantAllows(grant, "records.read") && wholeStore(grant);
      case "kogane.instruments.coverage":
        return grantAllows(grant, "summary.read") && wholeStore(grant);
      case "kogane.accounts.candidates":
      case "kogane.accounts.history":
      case "kogane.economic-readiness.read":
        return grantAllows(grant, "records.read") && wholeStore(grant);
      case "kogane.card-settlements.read":
      case "kogane.card-settlements.statements":
      case "kogane.card-settlements.ownership":
      case "kogane.card-settlements.unmatched":
        return served.cardSettlements && grantAllows(grant, "records.read") && wholeStore(grant);
      case "kogane.audit.search":
      case "kogane.audit.get":
        return grantAllows(grant, "audit.read") && grant.scopes.accounts === "*";
    }
  });
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
      case "kogane.accounts.history": {
        // The route's own service: capability, perimeter, existence and the
        // row budget are decided there, once for both transports.
        const input = parseRequest(schemas[name], body ?? {});
        const outcome = await readAccountHistoryForGrant({
          grant,
          sql: d1Executor(env.DB),
          sourceAccountId: input.sourceAccountId,
        });
        return outcome.ok
          ? { status: 200, body: outcome.history }
          : { status: ERROR_STATUS[outcome.error.code], body: outcome.error };
      }
      case "kogane.card-settlements.read":
      case "kogane.card-settlements.statements":
      case "kogane.card-settlements.ownership": {
        // The page's own services; capability and perimeter are graded there,
        // before validation or database access, for both transports.
        const input = { grant, sql: d1Executor(env.DB), request: body };
        const outcome =
          name === "kogane.card-settlements.read"
            ? await readCardSettlementsForGrant(input)
            : name === "kogane.card-settlements.statements"
              ? await readCardSettlementStatementsForGrant(input)
              : await readCardOwnershipForGrant(input);
        if (outcome.status === "refused")
          return { status: ERROR_STATUS[outcome.error.code], body: outcome.error };
        if (outcome.status === "not_found") throw new HttpError(404, "not_found");
        return { status: 200, body: { apiVersion: 2, ...outcome.answer } };
      }
      case "kogane.card-settlements.unmatched": {
        // The page's own service: capability, perimeter and bounds are
        // decided there, once for both transports.
        const input = parseRequest(schemas[name], body ?? {});
        const outcome = await reviewUnmatchedCardStatements({
          grant,
          sql: d1Executor(env.DB),
          request: { offset: input.offset ?? 0 },
        });
        return outcome.ok
          ? { status: 200, body: { apiVersion: 2, ...outcome.review } }
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
