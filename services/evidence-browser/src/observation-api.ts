import { evidenceReader, type FilterOptionsKind, type ObservationKind } from "./observations";
import { decimalRows } from "./normalized-decimals";
import { describeActivities } from "./activity-presentation";
import { organizedFilterOptions } from "./organized-filter-options";
import { presentLatestBalances, describeBalanceRows } from "./balance-presentation";
import { HttpError, json } from "./http";
import { raw } from "./read";
import {
  organizeRows,
  observationOrganizations,
  organizationContext,
  organizationKey,
} from "./observation-organization";
import type { ApiMetadata } from "../../../poc/observation-pipeline/shared/api-contract";
import {
  allowedQueryParameters,
  CENTRAL_STORE_CAPABILITIES,
  validMeasureView,
} from "../../../poc/observation-pipeline/shared/api-schema";
import { DEFAULT_IDENTITY_READ_MODE } from "../../../packages/read-model/src/index";
import { eventsV2Available } from "./events-api";
import { identityReadMode } from "./identity-read";
import { commandsEnabled } from "./command-api";

/** Validated request scope. Each route passes only the keys its reader query accepts. */
interface RequestScope {
  source?: string;
  account?: string;
  offset: number;
  from?: string;
  to?: string;
  q?: string;
  instrument?: string;
  metric?: string;
  measureView?: "balances" | "summaries";
}

export function boundedCollections(value: Record<string, unknown>, offset?: number): Response {
  let truncated = false;
  const bounded = Object.fromEntries(
    Object.entries(value).map(([key, rows]) => {
      if (!Array.isArray(rows)) return [key, rows];
      if (rows.length > 500) truncated = true;
      return [key, rows.slice(0, 500)];
    }),
  );
  return json({
    ...bounded,
    coverage: {
      limit: 500,
      truncated,
      ...(offset === undefined ? {} : { nextOffset: truncated ? offset + 500 : null }),
    },
  });
}

// Called only after the existing Access JWT gate and read-only method check.
export async function observationApi(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response | null> {
  const path = url.pathname;
  if (
    !/^\/api\/(meta|overview|transactions|balances|positions|artifacts|observations|raw|filter-options)(\/|$)/.test(
      path,
    )
  )
    return null;
  // Accepted parameters come from the shared schema and the capabilities this
  // Worker advertises in /api/meta, so the two cannot drift apart.
  const allowed = allowedQueryParameters(path, CENTRAL_STORE_CAPABILITIES);
  for (const key of url.searchParams.keys()) {
    const value = url.searchParams.get(key)!;
    if (
      !allowed.includes(key) ||
      url.searchParams.getAll(key).length !== 1 ||
      !value ||
      value.length > 512 ||
      /[\u0000-\u001f]/.test(value)
    )
      throw new HttpError(400, "invalid_query");
  }
  const offsetText = url.searchParams.get("offset") ?? "0";
  const measureView = url.searchParams.get("view");
  if (measureView !== null && !validMeasureView(measureView, CENTRAL_STORE_CAPABILITIES))
    throw new HttpError(400, "invalid_query");
  const identityRead = identityReadMode(url);
  const offset = Number(offsetText);
  if (!/^(0|[1-9]\d*)$/.test(offsetText) || !Number.isSafeInteger(offset) || offset > 1_000_000)
    throw new HttpError(400, "invalid_offset");
  const filter: RequestScope = {
    source: url.searchParams.get("source") ?? undefined,
    account: url.searchParams.get("account") ?? undefined,
    offset,
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
    q: url.searchParams.get("q")?.trim() || undefined,
    instrument: url.searchParams.get("instrument") ?? undefined,
    metric: url.searchParams.get("metric") ?? undefined,
    measureView: measureView ?? undefined,
  };
  for (const date of [filter.from, filter.to]) {
    if (
      date &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !Number.isFinite(Date.parse(date)) ||
        new Date(date).toISOString().slice(0, 10) !== date)
    )
      throw new HttpError(400, "invalid_date");
  }
  if (filter.from && filter.to && filter.from > filter.to)
    throw new HttpError(400, "invalid_date_range");
  const reader = evidenceReader(env.DB);
  if (path === "/api/filter-options") {
    const kind = url.searchParams.get("kind");
    if (!kind || !["transactions", "balances", "positions", "artifacts"].includes(kind))
      throw new HttpError(400, "invalid_query");
    if (measureView && kind !== "balances") throw new HttpError(400, "invalid_query");
    return json(
      await organizedFilterOptions(
        env.DB,
        kind,
        await reader.filterOptions({
          kind: kind as FilterOptionsKind,
          measureView: filter.measureView,
        }),
      ),
    );
  }
  if (path === "/api/meta") {
    return json({
      apiVersion: 1,
      parsingHealth: await reader.parsingHealth(),
      source: { kind: "central-store", classification: "financial" },
      // What this server can actually serve, not what the contract defaults
      // to: `commands` follows the deployment's flag (A09) and `eventsV2`
      // depends on the A10 projection being present.
      capabilities: {
        ...CENTRAL_STORE_CAPABILITIES,
        commands: commandsEnabled(env),
        eventsV2: await eventsV2Available(env),
      },
    } satisfies ApiMetadata);
  }
  if (path === "/api/overview") return boundedCollections({ ...(await reader.overview()) });
  if (path === "/api/transactions") {
    const transactions = await organizeRows(
      env.DB,
      "transaction",
      await decimalRows(
        env.DB,
        "transaction",
        await describeActivities(
          env.DB,
          await reader.listTransactions({
            source: filter.source,
            account: filter.account,
            from: filter.from,
            to: filter.to,
            q: filter.q,
            offset,
          }),
        ),
      ),
      identityRead,
    );
    return boundedCollections(
      {
        transactions,
        interpretationContext: organizationContext(
          identityRead,
          transactions.slice(0, 500).map((row) => row.organization),
        ),
      },
      offset,
    );
  }
  if (path === "/api/balances") {
    const value = url.searchParams.get("latestOffset") ?? "0";
    const latestOffset = Number(value);
    if (
      !/^(0|[1-9]\d*)$/.test(value) ||
      !Number.isSafeInteger(latestOffset) ||
      latestOffset > 1_000_000
    )
      throw new HttpError(400, "invalid_offset");
    // Grouping needs the complete bounded candidate set before paging; the
    // reader refuses more than 5,000 candidates rather than grouping a page.
    const candidates = await reader.listLatestBalances({
      source: filter.source,
      account: filter.account,
      instrument: filter.instrument,
      measureView: filter.measureView,
      offset: 0,
      limit: 5001,
    });
    // Source/account/unit boundaries can be applied before grouping because
    // duplicates must agree on all three. A metric can describe either witness.
    const projected = presentLatestBalances(
      await organizeRows(env.DB, "balance", candidates, identityRead),
      filter.metric,
    );
    const latest = projected.slice(latestOffset, latestOffset + 501);
    const history = await reader.listBalanceHistory({
      source: filter.source,
      account: filter.account,
      instrument: filter.instrument,
      metric: filter.metric,
      measureView: filter.measureView,
      offset,
    });
    const organizedHistory = await organizeRows(
      env.DB,
      "balance",
      history.slice(0, 500),
      identityRead,
    );
    return json({
      latest: await decimalRows(env.DB, "balance", latest.slice(0, 500)),
      history: await decimalRows(env.DB, "balance", describeBalanceRows(organizedHistory)),
      interpretationContext: organizationContext(identityRead, [
        ...latest.slice(0, 500).map((row) => row.organization),
        ...organizedHistory.map((row) => row.organization),
      ]),
      coverage: {
        limit: 500,
        truncated: latest.length > 500 || history.length > 500,
        nextOffset: history.length > 500 ? offset + 500 : null,
        latestNextOffset: latest.length > 500 ? latestOffset + 500 : null,
      },
    });
  }
  if (path === "/api/positions") {
    const entries = await reader.listPositions({
      source: filter.source,
      account: filter.account,
      offset,
    });
    const normalizedPositions = await decimalRows(
      env.DB,
      "position",
      entries.map((entry) => entry.position),
    );
    const normalizedValuations = new Map(
      (
        await decimalRows(
          env.DB,
          "valuation",
          entries.flatMap((entry) => entry.valuations),
        )
      ).map((row) => [row.id, row.normalized]),
    );
    const organizations = await observationOrganizations(
      env.DB,
      entries.flatMap((entry) => [
        { kind: "position" as const, id: entry.position.id },
        ...entry.valuations.map(({ id }) => ({ kind: "valuation" as const, id })),
      ]),
      identityRead,
    );
    return boundedCollections(
      {
        positions: entries.map((entry, index) => ({
          position: {
            ...entry.position,
            normalized: normalizedPositions[index]!.normalized,
            organization: organizations.get(
              organizationKey({ kind: "position", id: entry.position.id }),
            )!,
          },
          valuations: entry.valuations.map((row) => ({
            ...row,
            normalized: normalizedValuations.get(row.id)!,
            organization: organizations.get(organizationKey({ kind: "valuation", id: row.id }))!,
          })),
        })),
        interpretationContext: organizationContext(identityRead, organizations.values()),
      },
      offset,
    );
  }
  if (path === "/api/artifacts") {
    const cursor = url.searchParams.get("cursor");
    const before = cursor === null ? Number.MAX_SAFE_INTEGER : Number(cursor);
    if ((cursor !== null && !/^[1-9]\d*$/.test(cursor)) || !Number.isSafeInteger(before))
      throw new HttpError(400, "invalid_cursor");
    const rows = await reader.listArtifacts({ before, source: filter.source });
    return json({
      artifacts: rows.slice(0, 500),
      coverage: {
        limit: 500,
        truncated: rows.length > 500 || cursor !== null,
        nextCursor: rows.length > 500 ? String(rows[499].id) : null,
      },
    });
  }
  const artifact = /^\/api\/artifacts\/([1-9]\d*)$/.exec(path);
  const observation =
    /^\/api\/observations\/(transaction|balance|position|valuation)\/([1-9]\d*)$/.exec(path);
  if (artifact || observation) {
    const id = Number(artifact ? artifact[1] : observation![2]);
    if (!Number.isSafeInteger(id)) throw new HttpError(400, "invalid_identifier");
    const result = artifact
      ? await reader.getArtifact(id)
      : await reader.getObservation({ kind: observation![1] as ObservationKind, id });
    if (!result) throw new HttpError(404, "not_found");
    if (observation) {
      // Detail routes accept no parameters, so they always read `latest`.
      const ref = { kind: observation[1] as ObservationKind, id };
      const organizations = await observationOrganizations(env.DB, [ref]);
      const [decimal] = await decimalRows(env.DB, ref.kind, [{ id }]);
      return json({
        ...result,
        normalized: decimal!.normalized,
        organization: organizations.get(organizationKey(ref))!,
        interpretationContext: organizationContext(
          DEFAULT_IDENTITY_READ_MODE,
          organizations.values(),
        ),
      });
    }
    return json(result);
  }
  const hash = /^\/api\/raw\/([a-f0-9]{64})$/.exec(path);
  if (hash) {
    // A hash is downloadable only when reachable through the sealed read view.
    // The reader re-checks that for this one hash, independent of list limits.
    const row = await reader.getRawDownload({ sha256: hash[1] });
    if (!row) throw new HttpError(404, "not_found");
    return raw(env.EVIDENCE, row, request.method === "HEAD");
  }
  throw new HttpError(404, "not_found");
}
