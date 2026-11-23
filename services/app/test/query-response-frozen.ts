// `queryResponse` of services/app/src/agent-service.ts as it shipped before
// ADR 0128 slice S7 added `next` and `paging` beside `result`, frozen with the
// private helpers it calls, so the differential test can show the shipped
// answer is this one plus those two fields and not a byte else. Do not edit
// this file to follow a later change of the shipped function: a change that
// moves the rest of the answer is a new decision, and its own differential.
// The one exception is the context's publication basis, which #1502
// (financial-context-v2, ADR 0091 amendment) moved on main while S7 was in
// review: it is copied here as shipped, so the frozen text answers the same
// context and only `next` and `paging` differ.
import {
  type ContextInputs,
  ERROR_STATUS,
  executeQuery,
  type Grant,
  grantAllowsSource,
  type HoldingsProjection,
  openContext,
  type QueryRequest,
} from "../../../packages/application/src/index";
import { canonicalDigest } from "../../../packages/domain/src/context.ts";
import {
  type BalanceProjectionReader,
  interpretationContext,
  LATEST_IDENTITY_RELEASE,
} from "../../../packages/read-model/src/index";
import {
  balanceProjectionReader,
  balanceReadConfigured,
  servableSnapshot,
} from "../src/balances-v2";
import type { ObservationReader, Overview } from "../src/observations";

interface FrozenToolContext {
  reader: ObservationReader;
  env: Env;
  grant: Grant;
  now: string;
}

async function contextInputs(
  context: FrozenToolContext,
  overview: Overview,
): Promise<ContextInputs> {
  const grant = context.grant;
  const visibleSources = overview.sources
    .map((source) => source.id)
    .filter((id) => grantAllowsSource(grant, id))
    .sort();
  const parseRuns =
    grant.scopes.sources === "*"
      ? overview.parseRuns
      : await context.reader.sourceParseRuns(visibleSources);
  const marks = await context.reader.publicationMarks(
    grant.scopes.sources === "*" ? null : visibleSources,
  );
  const builds = [
    ...new Set(parseRuns.map((run) => `${run.parser_name}@${run.parser_version}`)),
  ].sort();
  return {
    now: context.now,
    publicationHighWater: `published-parse-runs@${String(parseRuns[0]?.id ?? 0)}+publication-events@${String(marks.publicationEvent)}+exclusions@${String(marks.exclusions)}+snapshot-policies@${await canonicalDigest(marks.snapshotPolicies)}`,
    parserBuildDigest: await canonicalDigest(builds),
    visibleSources,
    interpretation: interpretationContext("latest", LATEST_IDENTITY_RELEASE),
  };
}

async function resultRef(value: unknown): Promise<string> {
  return `result:${await canonicalDigest(value)}`;
}

function holdingsProjection(reader: BalanceProjectionReader): HoldingsProjection {
  return { reader, servable: async () => await servableSnapshot(reader) };
}

export async function frozenQueryResponse(
  context: FrozenToolContext,
  request: QueryRequest,
): Promise<{ status: number; body: unknown }> {
  const overview = await context.reader.overview();
  const opened = await openContext(context.grant, await contextInputs(context, overview), {
    query: request,
  });
  const outcome = await executeQuery({
    grant: context.grant,
    opened,
    request,
    reader: context.reader,
    projection: balanceReadConfigured(context.env)
      ? holdingsProjection(balanceProjectionReader(context.env))
      : undefined,
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
