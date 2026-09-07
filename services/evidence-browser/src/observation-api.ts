import * as queries from "./observations";
import { HttpError, json } from "./http";
import { raw } from "./read";
import type { ApiMetadata } from "../../../poc/observation-pipeline/shared/api-contract";

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
  const paged = ["/api/transactions", "/api/balances", "/api/positions"].includes(path);
  const allowed = paged
    ? [
        "source",
        "account",
        "offset",
        ...(path === "/api/transactions" ? ["from", "to", "q"] : []),
        ...(path === "/api/balances" ? ["instrument", "metric", "latestOffset"] : []),
      ]
    : path === "/api/artifacts"
      ? ["source", "cursor"]
      : path === "/api/filter-options"
        ? ["kind"]
        : [];
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
  const offset = Number(offsetText);
  if (!/^(0|[1-9]\d*)$/.test(offsetText) || !Number.isSafeInteger(offset) || offset > 1_000_000)
    throw new HttpError(400, "invalid_offset");
  const filter = {
    source: url.searchParams.get("source") ?? undefined,
    account: url.searchParams.get("account") ?? undefined,
    offset,
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
    q: url.searchParams.get("q")?.trim() || undefined,
    instrument: url.searchParams.get("instrument") ?? undefined,
    metric: url.searchParams.get("metric") ?? undefined,
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
  const store = queries.observationStore(env.DB);
  if (path === "/api/filter-options") {
    const kind = url.searchParams.get("kind");
    if (!kind || !["transactions", "balances", "positions", "artifacts"].includes(kind))
      throw new HttpError(400, "invalid_query");
    return json(await queries.filterOptions(store, kind));
  }
  if (path === "/api/meta") {
    await env.DB.prepare("SELECT id FROM observation_fetch_artifacts LIMIT 1").first();
    const jobs =
      await env.DB.prepare(`SELECT j.status, count(*) AS count FROM observation_parse_jobs j
      WHERE j.status IN ('pending','running','failed')
        AND coalesce(j.last_error_code, '') <> 'parser_version_retired'
        AND (j.status <> 'failed' OR NOT EXISTS (
          SELECT 1 FROM parse_runs success
          WHERE success.fetch_artifact_id = j.fetch_artifact_id
            AND success.parser_name = j.parser_name
            AND success.status = 'ok' AND success.superseded_by_parse_run_id IS NULL
            AND success.parsed_at > coalesce((
              SELECT max(failed.parsed_at) FROM parse_runs failed
              WHERE failed.fetch_artifact_id = j.fetch_artifact_id
                AND failed.parser_name = j.parser_name
                AND failed.parser_version = j.parser_version AND failed.status = 'error'
            ), '')
        )) GROUP BY j.status`).all<{ status: "pending" | "running" | "failed"; count: number }>();
    const parsingHealth = { pending: 0, running: 0, failed: 0 };
    for (const job of jobs.results) parsingHealth[job.status] = job.count;
    return json({
      apiVersion: 1,
      parsingHealth,
      source: { kind: "central-store", classification: "financial" },
      capabilities: { readOnly: true, rawEvidence: true, liveCollectors: false },
    } satisfies ApiMetadata);
  }
  if (path === "/api/overview") return boundedCollections({ ...(await queries.overview(store)) });
  if (path === "/api/transactions")
    return boundedCollections(
      { transactions: await queries.currentTransactions(store, filter) },
      offset,
    );
  if (path === "/api/balances") {
    const value = url.searchParams.get("latestOffset") ?? "0";
    const latestOffset = Number(value);
    if (
      !/^(0|[1-9]\d*)$/.test(value) ||
      !Number.isSafeInteger(latestOffset) ||
      latestOffset > 1_000_000
    )
      throw new HttpError(400, "invalid_offset");
    const latest = await queries.latestBalances(store, { ...filter, offset: latestOffset });
    const history = await queries.balanceHistory(store, filter);
    return json({
      latest: latest.slice(0, 500),
      history: history.slice(0, 500),
      coverage: {
        limit: 500,
        truncated: latest.length > 500 || history.length > 500,
        nextOffset: history.length > 500 ? offset + 500 : null,
        latestNextOffset: latest.length > 500 ? latestOffset + 500 : null,
      },
    });
  }
  if (path === "/api/positions")
    return boundedCollections(
      { positions: await queries.positionsWithValuations(store, filter) },
      offset,
    );
  if (path === "/api/artifacts") {
    const cursor = url.searchParams.get("cursor");
    const before = cursor === null ? Number.MAX_SAFE_INTEGER : Number(cursor);
    if ((cursor !== null && !/^[1-9]\d*$/.test(cursor)) || !Number.isSafeInteger(before))
      throw new HttpError(400, "invalid_cursor");
    const rows = await queries.artifacts(store, before, filter.source);
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
      ? await queries.artifactDetail(store, id)
      : await queries.observationDetail(store, observation![1] as queries.ObservationKind, id);
    if (!result) throw new HttpError(404, "not_found");
    return json(result);
  }
  const hash = /^\/api\/raw\/([a-f0-9]{64})$/.exec(path);
  if (hash) {
    // A hash is downloadable only when reachable through the sealed read view.
    const row = await env.DB.prepare(`SELECT o.sha256, o.blob_key, o.byte_size
      FROM raw_objects o WHERE o.sha256 = ? AND EXISTS (
        SELECT 1 FROM observation_fetch_artifacts a WHERE a.sha256 = o.sha256
      )`)
      .bind(hash[1])
      .first<{ sha256: string; blob_key: string; byte_size: number }>();
    if (!row) throw new HttpError(404, "not_found");
    return raw(env.EVIDENCE, row, request.method === "HEAD");
  }
  throw new HttpError(404, "not_found");
}
