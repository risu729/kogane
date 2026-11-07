// MCP reads of the web UI's read pages (ADR 0081 point 1): each tool here
// answers what one UI read route answers, by calling the same reader that
// route calls with the same request. The route and the tool are two adapters
// over one function, so they cannot disagree on a row, a page bound or a
// refusal code; this file only translates a closed tool argument into that
// reader's request and the reader's answer into a tool result.
//
// Authority: the UI serves these pages to a signed-in reader over the whole
// store (`readerGrant`). An agent reads them only with the matching agent
// capability over the whole store, so no grant reads more here than its
// capability already reaches elsewhere. A source- or account-scoped grant is
// refused, never served a filtered page: these readers have no grant scope.
//
// Provider-derived strings (labels, descriptions, names) are part of the
// route's answer, so the whole answer travels under `data`
// (docs/agent-api.md, "Untrusted content and leakage").
import { z } from "zod";
import {
  type AgentCapability,
  ERROR_STATUS,
  financialError,
  type Grant,
  grantAllows,
} from "../../../packages/application/src/index";
import type { ToolResult } from "./agent-service";
import { HttpError } from "./http";
import { IDENTITY_COLLECTIONS } from "../../../packages/application/src/query/identity-pages.ts";
import { readIdentityCollection } from "./identity-api";
import { parseRequest } from "./ops-api";
import { readObservationRoute } from "./observation-api";
import {
  readHoldingsChange,
  reportedHoldingsChangeAvailable,
} from "./reported-holdings-change-api";
import { readRewardRoute } from "./rewards-api";
import { eventsV2Available, readEventsRoute } from "./events-api";
import { ACTIVITY_BASES } from "../../../packages/read-model/src/index";
import { readReportRoute, reportArtifactsAvailable } from "./reports-api";
import { collectionQualityAvailable, readCollectionQuality } from "./collection-quality-api";
import { catalogue } from "./read";
import { mcpInputSchema } from "./mcp-input-schema";

/** The result envelope of every page read: the route's answer, under `data`. */
const PAGE_READ_SCHEMA_VERSION = "kogane-page-read-v1";

/** A free query value a route accepts: bounded, non-empty, no control character. */
const routeText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[^\u0000-\u001f]+$/u);
/** The identity pages' bound on a query value. */
const ROUTE_TEXT = routeText(128);
/** The observation routes' bound on a query value. */
const FILTER_TEXT = routeText(512);
const IDENTITY_READ = z.enum(["latest", "as-recorded"]);
const MEASURE_VIEW = z.enum(["balances", "summaries"]);
const OFFSET = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

interface PageReadTool<Schema extends z.ZodType> {
  title: string;
  description: string;
  schema: Schema;
  /** The agent capability that reaches this page, always over the whole store. */
  capability: AgentCapability;
  /** The UI route paths this tool answers, for the parity inventory. */
  routes: readonly string[];
  /**
   * The part of the store a route needs, for a route that exists only where
   * the store has its tables or views: without it the tool is neither listed
   * nor callable, as the route answers 404.
   */
  needs?: PageReadStoreFeature;
  /** The shared reader, called with the request the route would build. */
  read(env: Env, input: z.infer<Schema>): Promise<unknown>;
}

/** Query parameters from a tool argument: absent values stay absent, numbers are decimal text. */
function query(input: Record<string, string | number | undefined>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input))
    if (value !== undefined) params.set(key, String(value));
  return params;
}

function tool<Schema extends z.ZodType>(definition: PageReadTool<Schema>) {
  return definition;
}

const TOOLS = {
  "kogane.identity.read": tool({
    title: "Identity pages: connections, account and instrument mappings, coverage",
    description:
      "One page of the owner UI's identity read: `connections` (aggregator connections and the source accounts they hold), `accounts` or `instruments` (each source reference with its current mapping, label, status, reason, revision and first observation), or `coverage` (per source, how many eligible observations are organized and how they resolved). The same answer as GET /api/identity/<collection>, under records.read and a whole-store read grant. `identityRead` is `latest` (default) or `as-recorded`; `connections` takes no other argument. Read-only.",
    schema: z.strictObject({
      collection: z.enum(IDENTITY_COLLECTIONS),
      source: ROUTE_TEXT.optional(),
      offset: OFFSET.optional(),
      identityRead: IDENTITY_READ.optional(),
    }),
    capability: "records.read",
    routes: IDENTITY_COLLECTIONS.map((collection) => `/api/identity/${collection}`),
    read: (env, { collection, ...params }) =>
      readIdentityCollection(env, collection, query(params)),
  }),
  "kogane.store.read": tool({
    title: "Store metadata, overview and filter options",
    description:
      "One of the evidence browser's page reads: `meta` (what this deployment serves, parsing health and months with no rows), `overview` (row counts per table, the sources with their artifact counts, and the latest fetch and parse runs), or `filter-options` (the sources, accounts, instruments and metrics a `kind` of list can be filtered by; `view` only for balances). The same answer as GET /api/meta, /api/overview or /api/filter-options, under records.read and a whole-store read grant. Read-only.",
    schema: z.strictObject({
      page: z.enum(["meta", "overview", "filter-options"]),
      kind: z.enum(["transactions", "balances", "positions", "artifacts"]).optional(),
      view: MEASURE_VIEW.optional(),
    }),
    capability: "records.read",
    routes: ["/api/meta", "/api/overview", "/api/filter-options"],
    read: (env, { page, ...params }) => observationBody(env, `/api/${page}`, params),
  }),
  "kogane.observations.list": tool({
    title: "Lists of transactions, balances, positions or artifacts",
    description:
      "One page of an evidence browser list: `transactions`, `balances` (the latest grouped balances and their history), `positions` (with valuations) or `artifacts` (stored captures, newest first). Each observation row carries its normalized decimal and its identity organization. The same answer as GET /api/<kind>, under records.read and a whole-store read grant. Filters are the route's: `source`, `account`, `from`/`to` (YYYY-MM-DD) and `q` for transactions; `instrument`, `metric` and `view` for balances; `offset` (and `latestOffset` for balances) pages up to 500 rows; `cursor` pages artifacts. A filter the list does not take is refused, as on the route. Read-only.",
    schema: z.strictObject({
      kind: z.enum(["transactions", "balances", "positions", "artifacts"]),
      source: FILTER_TEXT.optional(),
      account: FILTER_TEXT.optional(),
      from: FILTER_TEXT.optional(),
      to: FILTER_TEXT.optional(),
      q: FILTER_TEXT.optional(),
      instrument: FILTER_TEXT.optional(),
      metric: FILTER_TEXT.optional(),
      view: MEASURE_VIEW.optional(),
      offset: OFFSET.optional(),
      latestOffset: OFFSET.optional(),
      cursor: FILTER_TEXT.optional(),
      identityRead: IDENTITY_READ.optional(),
    }),
    capability: "records.read",
    routes: ["/api/transactions", "/api/balances", "/api/positions", "/api/artifacts"],
    read: (env, { kind, ...params }) => observationBody(env, `/api/${kind}`, params),
  }),
  "kogane.observations.get": tool({
    title: "One observation or artifact with its detail",
    description:
      "One stored observation (`transaction`, `balance`, `position` or `valuation`) with its normalized decimal, identity organization and evidence links, or one `artifact` with its run and its parse runs with the observations each produced. The same answer as GET /api/observations/<kind>/<id> or /api/artifacts/<id>, under records.read and a whole-store read grant. An id the store does not hold is 404 not_found. Read-only; raw bytes are not part of it.",
    schema: z.strictObject({
      kind: z.enum(["transaction", "balance", "position", "valuation", "artifact"]),
      id: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    }),
    capability: "records.read",
    routes: ["/api/observations/:kind/:id", "/api/artifacts/:id"],
    read: (env, { kind, id }) =>
      observationBody(
        env,
        kind === "artifact" ? `/api/artifacts/${id}` : `/api/observations/${kind}/${id}`,
        {},
      ),
  }),
  "kogane.balances.read": tool({
    title: "Latest balances and balance history of the published snapshot",
    description:
      "One page of the v2 balance read: `latest` (each adopted balance of the published snapshot with its quantity, metric, adoption state, evidence, freshness, coverage and known-asset subtotals) or `history` (the visible balance observations up to that snapshot). The same answer as GET /api/v2/balances/latest or /api/v2/balances/history, under records.read and a whole-store read grant. Filters `source`, `account`, `instrument`, `metric`, `view`; `limit` is one of the route's page sizes; `cursor` is the previous page's `nextCursor`. 503 read_model_unavailable while no snapshot is published. Read-only.",
    schema: z.strictObject({
      collection: z.enum(["latest", "history"]),
      source: FILTER_TEXT.optional(),
      account: FILTER_TEXT.optional(),
      instrument: FILTER_TEXT.optional(),
      metric: FILTER_TEXT.optional(),
      view: MEASURE_VIEW.optional(),
      identityRead: IDENTITY_READ.optional(),
      limit: z.number().int().min(1).max(1000).optional(),
      cursor: FILTER_TEXT.optional(),
    }),
    capability: "records.read",
    routes: ["/api/v2/balances/latest", "/api/v2/balances/history"],
    read: (env, { collection, ...params }) =>
      observationBody(env, `/api/v2/balances/${collection}`, params),
  }),
  "kogane.rewards.read": tool({
    title: "Reward holdings and expiry",
    description:
      "One page of the reward read: `holdings` (each programme's provider-observed quantity in its own unit, with membership) or `expiry` (the published reward snapshot's expiry estimates, with the provider's own display sections). The same answer as GET /api/v2/rewards/holdings or /api/v2/rewards/expiry, under records.read and a whole-store read grant. `program` narrows to one programme; `offset` pages holdings, `limit` and `cursor` page expiry. Expiry is 503 while no reward snapshot is published. Read-only; no exchange or simulation is run.",
    schema: z.strictObject({
      collection: z.enum(["holdings", "expiry"]),
      program: ROUTE_TEXT.optional(),
      offset: OFFSET.optional(),
      limit: z.number().int().min(1).max(1000).optional(),
      cursor: FILTER_TEXT.optional(),
    }),
    capability: "records.read",
    routes: ["/api/v2/rewards/holdings", "/api/v2/rewards/expiry"],
    read: (env, { collection, ...params }) =>
      readRewardRoute(env, {
        pathname: `/api/v2/rewards/${collection}`,
        searchParams: query(params),
      }),
  }),
  "kogane.reported-holdings-change.read": tool({
    title: "Reported holdings of two dates side by side",
    description:
      "The holdings each provider reported on two dates (YYYY-MM-DD, Asia/Tokyo, not after today), side by side per provider holding key, with the exact change where both dates list a holding; optionally one source or one account. The same answer as GET /api/v2/reported-holdings-change, under records.read and a whole-store read grant. Provider figures only: nothing is added up, valued or netted. Served where GET /api/v2/reported-state is. Read-only.",
    schema: z.strictObject({
      from: ROUTE_TEXT,
      to: ROUTE_TEXT,
      source: ROUTE_TEXT.optional(),
      account: ROUTE_TEXT.optional(),
    }),
    capability: "records.read",
    routes: ["/api/v2/reported-holdings-change"],
    needs: "reportedState",
    read: (env, params) => readHoldingsChange(env, query(params)),
  }),
  "kogane.events.read": tool({
    title: "Economic activity by basis, and obligations",
    description:
      "One page of the economic event projection: `activity` (the current event revisions with a leg on the requested `basis`: `cash-movement` (default; money that left or entered an account, e.g. an accepted card settlement debit) or `purchase-recognition` (cost recognised at purchase); each event with its legs, allocations, per-basis totals, evidence and explanation refs) or `obligations` (current obligations with their principal, settlements and remaining amount; takes no `basis`). The two bases are never mixed in one list. The same answer as GET /api/v2/activity or /api/v2/obligations, under records.read and a whole-store read grant. `offset` pages 200 rows; `nextCursor` is the next offset. Served where the projection exists. Read-only.",
    schema: z.strictObject({
      collection: z.enum(["activity", "obligations"]),
      basis: z.enum(ACTIVITY_BASES).optional(),
      offset: OFFSET.optional(),
    }),
    capability: "records.read",
    routes: ["/api/v2/activity", "/api/v2/obligations"],
    needs: "economicEvents",
    read: (env, { collection, ...params }) =>
      readEventsRoute(env, { pathname: `/api/v2/${collection}`, searchParams: query(params) }),
  }),
  "kogane.reports.read": tool({
    title: "Fixed report artifacts (評価レポート): list, body and explanation",
    description:
      "The stored report artifacts: without `reportId`, one page of the catalogue, newest first (`offset` pages by 50); with `reportId`, that report's stored body (`view: body`, the default) or its cached explanation (`view: explanation`), with its calculation run, replayability and events. The same answer as GET /api/v2/reports and /api/v2/reports/{id}[/explanation], under records.read and a whole-store read grant, except that a restricted or unavailable report is refused here on every view, with the codes the export answers (403 evidence_restricted where its explanation is refused, 404 not_found where only its body is gone), where the operator page still re-displays it (ADR 0072). Re-display only: nothing is recomputed, and the export view is not offered. Served while the store has report artifacts.",
    schema: z.strictObject({
      reportId: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u)
        .optional(),
      view: z.enum(["body", "explanation"]).optional(),
      offset: OFFSET.optional(),
      decimalPolicy: ROUTE_TEXT.optional(),
    }),
    capability: "records.read",
    routes: ["/api/v2/reports", "/api/v2/reports/:id", "/api/v2/reports/:id/explanation"],
    needs: "reportArtifacts",
    read: (env, { reportId, view, ...params }) => {
      // A view or a policy names one report; the list takes neither.
      if (reportId === undefined && (view !== undefined || params.decimalPolicy !== undefined))
        throw new HttpError(400, "invalid_request", [
          view === undefined ? "decimalPolicy" : "view",
        ]);
      return readReportRoute(
        env,
        {
          pathname:
            reportId === undefined
              ? "/api/v2/reports"
              : `/api/v2/reports/${encodeURIComponent(reportId)}${view === "explanation" ? "/explanation" : ""}`,
          searchParams: query(params),
        },
        { refuseRestricted: true },
      );
    },
  }),
  "kogane.collection-quality.read": tool({
    title: "Collection quality per job, source and dataset",
    description:
      "What each collection stage last did, in closed codes: without `source`, the summary per configured job and per source (schedules, the actual alarm where known, latest runs and stage outcomes); with `source`, that source's cells per unit, dataset and period (`offset` pages them). Identifiers, capture times, counts and codes only, no amount. The same answer as GET /api/collection-quality and /api/collection-quality/{source}, under evidence.read and a whole-store read grant, as on the route. Served while the store has the scheduling tables. Read-only.",
    schema: z.strictObject({
      source: z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]{0,99}$/u)
        .optional(),
      offset: OFFSET.optional(),
    }),
    capability: "evidence.read",
    routes: ["/api/collection-quality", "/api/collection-quality/:source"],
    needs: "collectionQuality",
    read: (env, { source, ...params }) =>
      readCollectionQuality(env, {
        pathname:
          source === undefined ? "/api/collection-quality" : `/api/collection-quality/${source}`,
        searchParams: query(params),
      }),
  }),
} as const;

/** The JSON answer of one observation route; a raw download is not a page read. */
async function observationBody(
  env: Env,
  pathname: string,
  params: Record<string, string | number | undefined>,
): Promise<unknown> {
  const answer = await readObservationRoute(env, { pathname, searchParams: query(params) });
  if ("raw" in answer) throw new HttpError(404, "not_found");
  return answer.body;
}

export type PageReadToolName = keyof typeof TOOLS;

export function isPageReadToolName(name: string): name is PageReadToolName {
  return Object.hasOwn(TOOLS, name);
}

/** The UI routes each page read answers (ADR 0081 point 4). */
export const PAGE_READ_ROUTES: Record<PageReadToolName, readonly string[]> = Object.fromEntries(
  Object.entries(TOOLS).map(([name, definition]) => [name, definition.routes]),
) as Record<PageReadToolName, readonly string[]>;

const PAGE_READ_MCP_TOOLS = Object.entries(TOOLS).map(([name, definition]) => {
  const inputSchema = mcpInputSchema(definition.schema);
  return {
    name,
    title: definition.title,
    description: definition.description,
    inputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  };
});

/** Why this grant may not read a whole-store page, as refs; empty when it may. */
function refusedRefs(grant: Grant, capability: AgentCapability): string[] {
  if (!grantAllows(grant, capability)) return [`capability:${capability}`];
  return [
    ...(grant.scopes.sources === "*" ? [] : ["scope:source"]),
    ...(grant.scopes.accounts === "*" ? [] : ["scope:account"]),
  ];
}

/** The tables or views a page read's route exists by, and each one's probe. */
const STORE_FEATURES = {
  reportedState: reportedHoldingsChangeAvailable,
  reportArtifacts: reportArtifactsAvailable,
  collectionQuality: collectionQualityAvailable,
  economicEvents: eventsV2Available,
} as const satisfies Record<string, (env: Env) => Promise<boolean>>;
export type PageReadStoreFeature = keyof typeof STORE_FEATURES;
/** Whether this store has a feature, each probe asked at most once. */
export type PageReadStore = (feature: PageReadStoreFeature) => Promise<boolean>;

/**
 * This store's features for one request, each probed at most once. `known`
 * supplies an answer the caller already asks for (the reported state's views,
 * which the reported and reconstructed state's reads share), so one tool list
 * asks the schema once per feature.
 */
export function pageReadStore(
  env: Env,
  known: Partial<Record<PageReadStoreFeature, () => Promise<boolean>>> = {},
): PageReadStore {
  const asked = new Map<PageReadStoreFeature, Promise<boolean>>();
  return (feature) => {
    let answer = asked.get(feature);
    if (!answer) {
      answer = known[feature]?.() ?? STORE_FEATURES[feature](env);
      asked.set(feature, answer);
    }
    return answer;
  };
}

/** Whether this deployment serves the page read: exactly where it serves its route. */
export async function pageReadServed(
  name: PageReadToolName,
  store: PageReadStore,
): Promise<boolean> {
  const needs = (TOOLS[name] as PageReadTool<z.ZodType>).needs;
  return needs === undefined || (await store(needs));
}

/**
 * The page reads listed to this grant: exactly those it may call, and of
 * those whose route exists only with some tables or views, only where it does.
 */
export async function pageReadMcpTools(grant: Grant, store: PageReadStore) {
  const listed = [];
  for (const definition of PAGE_READ_MCP_TOOLS) {
    const name = definition.name as PageReadToolName;
    if (refusedRefs(grant, TOOLS[name].capability).length > 0) continue;
    if (await pageReadServed(name, store)) listed.push(definition);
  }
  return listed;
}

/**
 * Call one page read for `grant`. The grant is graded before the argument is
 * read; then the argument is validated against the closed schema; then the
 * route's reader answers, with the route's own status and closed code on a
 * refusal (`{ error, refs? }`, as the Worker answers an `HttpError`).
 */
export async function callPageReadTool(
  name: PageReadToolName,
  body: unknown,
  env: Env,
  grant: Grant,
): Promise<ToolResult> {
  const definition = TOOLS[name] as PageReadTool<z.ZodType>;
  const operation = name.slice("kogane.".length);
  const refused = refusedRefs(grant, definition.capability);
  if (refused.length > 0) {
    const code = refused[0]!.startsWith("capability:") ? "unauthorized" : "evidence_restricted";
    return { status: ERROR_STATUS[code], body: financialError(code, operation, refused) };
  }
  try {
    const input = parseRequest(definition.schema, body ?? {});
    const data = await catalogue(() => definition.read(env, input));
    return { status: 200, body: { schemaVersion: PAGE_READ_SCHEMA_VERSION, data } };
  } catch (error) {
    if (error instanceof HttpError)
      return {
        status: error.status,
        body: { error: error.code, ...(error.refs.length > 0 ? { refs: error.refs } : {}) },
      };
    throw error;
  }
}
