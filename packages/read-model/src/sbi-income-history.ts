// One current complete retained container, including corrections/removals.
// Never union old row identities into a newer full since-2021-08 response.
import { activeStateProjection, completeSnapshotCandidates } from "./concepts";
import { PAGE_LIMIT, type PageSql } from "./scope";

const INCOME_METRICS = [
  "income_gross",
  "income_tax",
  "income_income_tax",
  "income_resident_tax",
  "income_net",
] as const;
const GAIN_METRICS = [
  "sale_proceeds",
  "realised_gain_before_tax",
  "sale_unit_price",
  "average_acquisition_unit_cost",
] as const;
export interface SbiIncomeHistoryQuery {
  kind: "income" | "gains";
  metric?: (typeof INCOME_METRICS)[number] | (typeof GAIN_METRICS)[number];
  currency?: "JPY" | "USD";
  account?: string;
  from?: string;
  to?: string;
  offset: number;
}
export interface SbiIncomeHistoryRow {
  id: number;
  parse_run_id: number;
  fetch_artifact_id: number;
  source_id: string;
  source_account: string;
  subject: string;
  metric: string;
  currency: "JPY" | "USD";
  as_of: string;
  /** Per-unit prices retain exact amount_text without inventing minor units. */
  amount_minor: string | null;
  amount_text: string;
  parser_name: string;
  parser_version: string;
  fetched_at: string;
  raw_locator: string;
  extra_json: string;
}
function date(value: string | undefined): boolean {
  if (value === undefined) return true;
  const time = Date.parse(`${value}T00:00:00Z`);
  return (
    /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
    Number.isFinite(time) &&
    new Date(time).toISOString().slice(0, 10) === value
  );
}
export function sbiIncomeHistorySql(query: SbiIncomeHistoryQuery): PageSql {
  const metrics: readonly string[] = query.kind === "income" ? INCOME_METRICS : GAIN_METRICS;
  if (
    !["income", "gains"].includes(query.kind) ||
    (query.metric !== undefined && !metrics.includes(query.metric)) ||
    (query.currency !== undefined && !["JPY", "USD"].includes(query.currency)) ||
    (query.account !== undefined &&
      (query.account.length > 512 || !query.account.startsWith(`sbi-securities:${query.kind}:`))) ||
    !Number.isSafeInteger(query.offset) ||
    query.offset < 0 ||
    !date(query.from) ||
    !date(query.to) ||
    (query.from !== undefined && query.to !== undefined && query.from > query.to)
  )
    throw new Error("sbi_income_history_query_invalid");
  return {
    sql: `WITH ${completeSnapshotCandidates.ctes}
      SELECT v.id, v.parse_run_id, fa.id AS fetch_artifact_id, fa.source_id,
        v.source_account, v.subject, v.metric, v.currency, v.as_of,
        CAST(v.amount_minor AS TEXT) AS amount_minor, v.amount_text,
        p.parser_name, p.parser_version, fa.fetched_at, v.raw_locator, v.extra_json
      FROM ${activeStateProjection.observationChain("valuation_observations", "v")}
      WHERE ${activeStateProjection.predicate} AND ${completeSnapshotCandidates.currentMember}
        AND fa.source_id = 'sbi-securities' AND fa.dataset = ?1 AND p.parser_name = ?2
        AND (?3 IS NULL OR v.metric = ?3) AND (?4 IS NULL OR v.currency = ?4)
        AND (?5 IS NULL OR v.source_account = ?5) AND (?6 IS NULL OR v.as_of >= ?6)
        AND (?7 IS NULL OR v.as_of <= ?7)
      ORDER BY v.as_of DESC, v.source_account, v.subject, v.metric, v.id DESC
      LIMIT ${PAGE_LIMIT} OFFSET ?8`,
    args: [
      query.kind === "income" ? "income-payments" : "realised-gains",
      query.kind === "income" ? "sbi-income-payments" : "sbi-realised-gains",
      query.metric ?? null,
      query.currency ?? null,
      query.account ?? null,
      query.from ?? null,
      query.to ?? null,
      query.offset,
    ],
  };
}
