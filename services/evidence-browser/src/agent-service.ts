// The five tools of the agent API, bound to this Worker's read model.
//
// There is exactly one implementation of each: the HTTP route, the MCP
// adapter and the human UI's shared-query route all call `callTool`, so no
// transport can hold semantics of its own and the UI cannot compute a figure
// the agent API would compute differently (AT72).
//
// Everything below is composed from the application service and the explicit
// read repository. No route in this file names a table, an ordering, a column
// or a URL, and nothing it returns carries a credential or provider prose
// outside the `data` field of a result.
import {
  capabilitiesFor,
  type ContextInputs,
  ERROR_STATUS,
  executeQuery,
  explain,
  financialError,
  type Grant,
  openContext,
  parseExplainRequest,
  parseProposalRequest,
  parseQueryRequest,
  proposeReconciliation,
  type QueryRequest,
} from "../../../packages/application/src/index";
import { canonicalDigest } from "../../../packages/domain/src/context.ts";
import {
  interpretationContext,
  LATEST_IDENTITY_RELEASE,
} from "../../../packages/read-model/src/index";
import { balanceProjectionReader, projectionFlagOn } from "./balances-v2";
import { evidenceReader, type ObservationReader, type Overview } from "./observations";
// One description of what this deployment serves, shared with /api/meta and
// with the request validator, so an agent is never told about a route this
// store cannot serve (see server-capabilities.ts).
import { serverCapabilities } from "./server-capabilities";
import { proposalStore } from "./proposals";

export const AGENT_TOOL_NAMES = [
  "kogane.capabilities",
  "kogane.context.open",
  "kogane.financial.query",
  "kogane.explain",
  "kogane.reconcile.propose",
] as const;
export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

/** Largest request body any agent route reads, in bytes. */
export const MAX_REQUEST_BYTES = 65_536;

export function isAgentToolName(value: string): value is AgentToolName {
  return (AGENT_TOOL_NAMES as readonly string[]).includes(value);
}

export interface ToolResult {
  status: number;
  body: unknown;
}

interface ToolContext {
  reader: ObservationReader;
  db: D1Database;
  /** Resolves what this server can actually serve; see `serverCapabilities`. */
  env: Env;
  grant: Grant;
  now: string;
}

function failure(
  code: Parameters<typeof financialError>[0],
  requestId: string,
  refs: string[],
): ToolResult {
  return { status: ERROR_STATUS[code], body: financialError(code, requestId, refs) };
}

/**
 * Everything the context pins, read from the shared read model once per call.
 * `publicationHighWater` is the highest visible parse run: what "current"
 * means for this answer. `parserBuildDigest` covers the visible parse-run
 * window the overview reports, which is bounded by the read model's page
 * limit; it identifies the builds behind the rows this answer can contain.
 */
async function contextInputs(context: ToolContext, overview: Overview): Promise<ContextInputs> {
  const parseRuns = overview.parseRuns;
  const builds = [
    ...new Set(parseRuns.map((run) => `${run.parser_name}@${run.parser_version}`)),
  ].sort();
  return {
    now: context.now,
    publicationHighWater: `published-parse-runs@${String(parseRuns[0]?.id ?? 0)}`,
    parserBuildDigest: await canonicalDigest(builds),
    visibleSources: overview.sources.map((source) => source.id).sort(),
    interpretation: interpretationContext("latest", LATEST_IDENTITY_RELEASE),
  };
}

/** `resultRef`: the hand-off id for one answer. Equal inputs give an equal ref. */
async function resultRef(value: unknown): Promise<string> {
  return `result:${await canonicalDigest(value)}`;
}

export async function callTool(
  name: AgentToolName,
  body: unknown,
  context: ToolContext,
): Promise<ToolResult> {
  switch (name) {
    case "kogane.capabilities": {
      if (body !== undefined && body !== null && Object.keys(body as object).length > 0)
        return failure("unsupported_semantics", "capabilities", ["body"]);
      return {
        status: 200,
        body: capabilitiesFor(
          context.grant,
          await serverCapabilities(context.env),
          MAX_REQUEST_BYTES,
        ),
      };
    }
    case "kogane.context.open": {
      const parsed = parseOpenBody(body);
      if (!parsed.ok) return failure(parsed.code, "context.open", parsed.refs);
      const overview = await context.reader.overview();
      const opened = await openContext(
        context.grant,
        await contextInputs(context, overview),
        parsed.value,
      );
      return {
        status: 200,
        body: {
          schemaVersion: "kogane-context-v1",
          contextId: opened.context.contextId,
          context: opened.context,
          interpretation: opened.interpretation,
          resolvedQuery: opened.resolvedQuery,
          unresolvedInputs: opened.unresolvedInputs,
        },
      };
    }
    case "kogane.financial.query": {
      const parsed = parseQueryRequest(body);
      if (!parsed.ok) return failure(parsed.code, "financial.query", parsed.refs);
      return queryResponse(context, parsed.value);
    }
    case "kogane.explain": {
      const parsed = parseExplainRequest(body);
      if (!parsed.ok) return failure(parsed.code, "explain", parsed.refs);
      const overview = await context.reader.overview();
      const opened = await openContext(context.grant, await contextInputs(context, overview));
      const outcome = await explain({
        grant: context.grant,
        opened,
        reader: context.reader,
        request: parsed.value,
      });
      if (!outcome.ok) return { status: ERROR_STATUS[outcome.error.code], body: outcome.error };
      return { status: 200, body: outcome.graph };
    }
    case "kogane.reconcile.propose": {
      const parsed = parseProposalRequest(body, context.grant.budget.maxProposalTargets);
      if (!parsed.ok) return failure(parsed.code, "reconcile.propose", parsed.refs);
      const overview = await context.reader.overview();
      const opened = await openContext(context.grant, await contextInputs(context, overview));
      const outcome = await proposeReconciliation({
        grant: context.grant,
        opened,
        store: proposalStore(context.db),
        request: parsed.value,
        now: context.now,
      });
      if (!outcome.ok) return { status: ERROR_STATUS[outcome.error.code], body: outcome.error };
      return { status: 200, body: outcome.receipt };
    }
  }
}

/** One query, one response envelope: the result plus its hand-off references. */
export async function queryResponse(
  context: ToolContext,
  request: QueryRequest,
): Promise<ToolResult> {
  const overview = await context.reader.overview();
  const opened = await openContext(context.grant, await contextInputs(context, overview), {
    query: request,
  });
  const outcome = await executeQuery({
    grant: context.grant,
    opened,
    request,
    reader: context.reader,
    // `holdings` reads the adopted balance projection and nothing else; it
    // answers `unavailable` while the reader flag is off or no snapshot is
    // sealed, rather than summing the observation rows behind it.
    projection: projectionFlagOn(context.env) ? balanceProjectionReader(context.env) : undefined,
    overview,
  });
  if (!outcome.ok) return { status: ERROR_STATUS[outcome.error.code], body: outcome.error };
  return {
    status: 200,
    body: {
      schemaVersion: "kogane-query-response-v1",
      contextId: outcome.result.contextId,
      resultRef: await resultRef({
        contextId: outcome.result.contextId,
        resolvedQuery: outcome.result.resolvedQuery,
        data: outcome.result.data,
      }),
      unresolvedInputs: opened.unresolvedInputs,
      result: outcome.result,
    },
  };
}

const OPEN_KEYS = ["query", "knowledgeCutoff", "identityRead"] as const;

function parseOpenBody(value: unknown):
  | {
      ok: true;
      value: {
        query?: QueryRequest;
        knowledgeCutoff?: string;
        identityRead?: "latest" | "as-recorded";
      };
    }
  | { ok: false; code: "unsupported_semantics" | "invalid_query"; refs: string[] } {
  if (value === undefined || value === null) return { ok: true, value: {} };
  if (typeof value !== "object" || Array.isArray(value))
    return { ok: false, code: "invalid_query", refs: [] };
  const body = value as Record<string, unknown>;
  const unknown = Object.keys(body).filter(
    (key) => !(OPEN_KEYS as readonly string[]).includes(key),
  );
  if (unknown.length > 0)
    return { ok: false, code: "unsupported_semantics", refs: unknown.slice(0, 10) };
  const resolved: {
    query?: QueryRequest;
    knowledgeCutoff?: string;
    identityRead?: "latest" | "as-recorded";
  } = {};
  if (body["query"] !== undefined) {
    const parsed = parseQueryRequest(body["query"]);
    if (!parsed.ok)
      return {
        ok: false,
        code: parsed.code === "unsupported_semantics" ? "unsupported_semantics" : "invalid_query",
        refs: parsed.refs,
      };
    resolved.query = parsed.value;
  }
  const cutoff = body["knowledgeCutoff"];
  if (cutoff !== undefined) {
    if (
      typeof cutoff !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(cutoff)
    )
      return { ok: false, code: "invalid_query", refs: ["knowledgeCutoff"] };
    resolved.knowledgeCutoff = cutoff;
  }
  const mode = body["identityRead"];
  if (mode !== undefined) {
    // `as-recorded` needs the recorded-run join the shared query path does not
    // do yet; asking for it is refused rather than answered as `latest`.
    if (mode !== "latest")
      return { ok: false, code: "unsupported_semantics", refs: ["identityRead"] };
    resolved.identityRead = "latest";
  }
  return { ok: true, value: resolved };
}

export function toolContext(env: Env, grant: Grant, now: string): ToolContext {
  return { reader: evidenceReader(env.DB), db: env.DB, env, grant, now };
}
