import { HttpError, json } from "./http";
import { preferredInstrumentNames } from "./preferred-instrument-names";
import type { IdentityOrigin } from "../../../poc/observation-pipeline/shared/identity-contract";
import {
  IDENTITY_PAGE_LIMIT,
  nextIdentityOffset,
} from "../../../poc/observation-pipeline/shared/identity-contract";

const LIMIT = IDENTITY_PAGE_LIMIT;
// Evaluate the canonical eligibility view once, before joining instrument roles.
// Source-account provenance is enforced on every immutable identity observation.
const CURRENT = `current AS MATERIALIZED (
 SELECT o.id,o.kind,o.observation_id,o.parse_run_id,o.source_account_id,s.source_id
 FROM current_identity_observations o JOIN source_accounts s ON s.id=o.source_account_id
 WHERE FILTER
)`;
// Only coverage needs the B denominator (including observations without C).
const ELIGIBLE = `all_observations AS (
 SELECT 'transaction' kind,id,parse_run_id FROM transaction_observations UNION ALL
 SELECT 'balance',id,parse_run_id FROM balance_observations UNION ALL
 SELECT 'position',id,parse_run_id FROM position_observations UNION ALL
 SELECT 'valuation',id,parse_run_id FROM valuation_observations
), eligible AS MATERIALIZED (
 SELECT b.*,a.source_id FROM all_observations b JOIN parse_runs p ON p.id=b.parse_run_id
 JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id
 JOIN observation_fetch_runs f ON f.id=a.fetch_run_id
 WHERE p.status='ok' AND p.superseded_by_parse_run_id IS NULL AND f.status='success' AND f.failure_count=0
)`;

export function identityQuery(
  collection: "accounts" | "instruments" | "coverage",
  filtered: boolean,
): string {
  const current = CURRENT.replace("FILTER", filtered ? "s.source_id=?1" : "1");
  const offset = filtered ? "?2" : "?1";
  if (collection === "accounts")
    return `WITH ${current}, counts AS MATERIALIZED (
    SELECT source_account_id,source_id,count(*) observedCount,min(kind||':'||observation_id) originKey
    FROM current GROUP BY source_account_id,source_id
  ) SELECT s.id referenceId,m.account_id targetId,m.label,a.role,m.status,c.source_id source,
    s.reference_json reference,m.reason,m.revision,c.observedCount,c.originKey
    FROM counts c JOIN source_accounts s ON s.id=c.source_account_id
    JOIN current_account_mappings m ON m.source_account_id=s.id JOIN accounts a ON a.id=m.account_id
    ORDER BY c.source_id,s.id LIMIT 101 OFFSET ${offset}`;
  if (collection === "instruments")
    return `WITH ${current}, counts AS MATERIALIZED (
    SELECT u.identifier_id,o.source_id,count(DISTINCT o.id) observedCount,min(o.kind||':'||o.observation_id) originKey
    FROM current o JOIN identity_instrument_uses u ON u.identity_observation_id=o.id
    GROUP BY u.identifier_id,o.source_id
  ) SELECT d.id referenceId,m.instrument_id targetId,m.label,i.kind,m.status,c.source_id source,
    d.namespace,d.scope,d.value,m.reason,m.revision,c.observedCount,c.originKey
    FROM counts c JOIN instrument_identifiers d ON d.id=c.identifier_id
    JOIN current_instrument_mappings m ON m.identifier_id=d.id JOIN instruments i ON i.id=m.instrument_id
    ORDER BY c.source_id,d.id LIMIT 101 OFFSET ${offset}`;
  return `WITH ${ELIGIBLE}, ${current}
    SELECT o.source_id source,count(*) eligible,count(c.id) organized,
    sum(CASE WHEN m.status='identified' THEN 1 ELSE 0 END) identified,
    sum(CASE WHEN m.status='provider-local' THEN 1 ELSE 0 END) providerLocal,
    sum(CASE WHEN m.status='aggregate' THEN 1 ELSE 0 END) aggregate,
    sum(CASE WHEN m.status='unresolved' THEN 1 ELSE 0 END) unresolved
    FROM eligible o LEFT JOIN current c ON c.kind=o.kind AND c.observation_id=o.id AND c.parse_run_id=o.parse_run_id
    LEFT JOIN current_account_mappings m ON m.source_account_id=c.source_account_id
    WHERE ${filtered ? "o.source_id=?1" : "1"} GROUP BY o.source_id ORDER BY o.source_id LIMIT 101 OFFSET ${offset}`;
}
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
  const bindings = source === null ? [offset] : [source, offset];
  const sql = identityQuery(
    url.pathname.slice("/api/identity/".length) as "accounts" | "instruments" | "coverage",
    source !== null,
  );
  const result = await env.DB.prepare(sql)
    .bind(...bindings)
    .all<Record<string, unknown>>();
  if (url.pathname.endsWith("/instruments")) {
    const names = await preferredInstrumentNames(
      env.DB,
      result.results.map((row) => String(row.referenceId)),
    );
    for (const row of result.results)
      row.label = names.get(String(row.referenceId))?.label ?? row.label;
  }
  return json(
    page(url.pathname.endsWith("/coverage") ? result.results : result.results.map(origin), offset),
  );
}
