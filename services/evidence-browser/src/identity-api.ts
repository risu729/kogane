import { HttpError, json } from "./http";
import type { IdentityOrigin } from "../../../poc/observation-pipeline/shared/identity-contract";
import {
  IDENTITY_PAGE_LIMIT,
  nextIdentityOffset,
} from "../../../poc/observation-pipeline/shared/identity-contract";

const LIMIT = IDENTITY_PAGE_LIMIT;
// The denominator includes eligible B observations that have no completed C run.
const ELIGIBLE = `WITH all_observations AS (
 SELECT 'transaction' kind,id,parse_run_id FROM transaction_observations UNION ALL
 SELECT 'balance',id,parse_run_id FROM balance_observations UNION ALL
 SELECT 'position',id,parse_run_id FROM position_observations UNION ALL
 SELECT 'valuation',id,parse_run_id FROM valuation_observations
), eligible AS (
 SELECT b.*,a.source_id FROM all_observations b JOIN parse_runs p ON p.id=b.parse_run_id
 JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id
 JOIN observation_fetch_runs f ON f.id=a.fetch_run_id
 WHERE p.status='ok' AND p.superseded_by_parse_run_id IS NULL AND f.status='success' AND f.failure_count=0
), current AS (
 SELECT o.*,b.source_id FROM current_identity_observations o JOIN eligible b
 ON b.kind=o.kind AND b.id=o.observation_id AND b.parse_run_id=o.parse_run_id
)`;
function page<T>(rows: T[], offset: number) {
  return {
    rows: rows.slice(0, LIMIT),
    coverage: {
      limit: LIMIT,
      truncated: rows.length > LIMIT,
      nextOffset: nextIdentityOffset(offset, rows.length > LIMIT),
    },
  };
}
function origin(row: Record<string, unknown>): Record<string, unknown> {
  const { originKey, ...rest } = row;
  const [kind, id] = String(originKey).split(":");
  return { ...rest, origin: { kind, id: Number(id) } as IdentityOrigin };
}
/** Call only after the existing Access authentication gate. No mutations. */
export async function identityApi(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/identity/")) return null;
  if (request.method !== "GET" && request.method !== "HEAD")
    throw new HttpError(405, "method_not_allowed");
  if (
    !["/api/identity/accounts", "/api/identity/instruments", "/api/identity/coverage"].includes(
      url.pathname,
    )
  )
    throw new HttpError(404, "not_found");
  for (const [key, value] of url.searchParams) {
    if (
      !["source", "offset"].includes(key) ||
      url.searchParams.getAll(key).length !== 1 ||
      !value ||
      value.length > 128 ||
      /[\u0000-\u001f]/u.test(value)
    )
      throw new HttpError(400, "invalid_query");
  }
  const text = url.searchParams.get("offset") ?? "0";
  const offset = Number(text);
  if (!/^(0|[1-9]\d*)$/u.test(text) || !Number.isSafeInteger(offset))
    throw new HttpError(400, "invalid_offset");
  const source = url.searchParams.get("source");
  const filter = source === null ? "1" : "o.source_id=?";
  const bindings = source === null ? [offset] : [source, offset];
  let sql: string;
  if (url.pathname.endsWith("/accounts")) {
    sql = `${ELIGIBLE} SELECT s.id referenceId,m.account_id targetId,m.label,a.role,m.status,o.source_id source,
      s.reference_json reference,m.reason,m.revision,count(*) observedCount,min(o.kind||':'||o.observation_id) originKey
      FROM current o JOIN source_accounts s ON s.id=o.source_account_id
      JOIN current_account_mappings m ON m.source_account_id=s.id JOIN accounts a ON a.id=m.account_id
      WHERE ${filter} GROUP BY s.id,o.source_id ORDER BY o.source_id,s.id LIMIT 101 OFFSET ?`;
  } else if (url.pathname.endsWith("/instruments")) {
    sql = `${ELIGIBLE} SELECT d.id referenceId,m.instrument_id targetId,m.label,i.kind,m.status,o.source_id source,
      d.namespace,d.scope,d.value,m.reason,m.revision,count(DISTINCT o.id) observedCount,min(o.kind||':'||o.observation_id) originKey
      FROM current o JOIN identity_instrument_uses u ON u.identity_observation_id=o.id
      JOIN instrument_identifiers d ON d.id=u.identifier_id JOIN current_instrument_mappings m ON m.identifier_id=d.id
      JOIN instruments i ON i.id=m.instrument_id WHERE ${filter}
      GROUP BY d.id,o.source_id ORDER BY o.source_id,d.id LIMIT 101 OFFSET ?`;
  } else {
    sql = `${ELIGIBLE} SELECT o.source_id source,count(*) eligible,count(c.id) organized,
      sum(CASE WHEN m.status='identified' THEN 1 ELSE 0 END) identified,
      sum(CASE WHEN m.status='provider-local' THEN 1 ELSE 0 END) providerLocal,
      sum(CASE WHEN m.status='aggregate' THEN 1 ELSE 0 END) aggregate,
      sum(CASE WHEN m.status='unresolved' THEN 1 ELSE 0 END) unresolved
      FROM eligible o LEFT JOIN current c ON c.kind=o.kind AND c.observation_id=o.id AND c.parse_run_id=o.parse_run_id
      LEFT JOIN current_account_mappings m ON m.source_account_id=c.source_account_id LEFT JOIN accounts a ON a.id=m.account_id
      WHERE ${filter} GROUP BY o.source_id ORDER BY o.source_id LIMIT 101 OFFSET ?`;
  }
  const result = await env.DB.prepare(sql)
    .bind(...bindings)
    .all<Record<string, unknown>>();
  return json(
    page(url.pathname.endsWith("/coverage") ? result.results : result.results.map(origin), offset),
  );
}
