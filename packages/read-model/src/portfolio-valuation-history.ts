// Latest witnessed revision of each weekly portfolio point (ADR 0098).
// A shorter response does not erase older weeks. Within a revised point,
// absent/null metrics do not resurrect from an older capture. Parser versions
// are builds of the same logical parser, never separate financial identities.
import { activeStateProjection } from "./concepts";
import { PAGE_LIMIT, type PageSql } from "./scope";
import {
  ASSET_HISTORY_CATEGORIES,
  type AssetHistoryCategory,
} from "../../parsers/src/parsers/sbi-asset-history-schema.ts";

export interface PortfolioValuationHistoryQuery {
  profile: "full" | "without-deposit";
  /** ALL is the aggregate; included categories are alternative breakdowns. */
  category?: AssetHistoryCategory;
  metric?: "valuation" | "acquisition_cost" | "profit_loss";
  from?: string;
  to?: string;
  offset: number;
}

export interface PortfolioValuationHistoryRow {
  id: number;
  parse_run_id: number;
  fetch_artifact_id: number;
  source_id: string;
  source_account: string;
  subject: string;
  metric: string;
  currency: string;
  as_of: string;
  amount_minor: string;
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

export function portfolioValuationHistorySql(query: PortfolioValuationHistoryQuery): PageSql {
  const category = query.category ?? "ALL";
  if (
    !(query.profile === "full" || query.profile === "without-deposit") ||
    !(ASSET_HISTORY_CATEGORIES as readonly string[]).includes(category) ||
    (query.metric !== undefined &&
      !["valuation", "acquisition_cost", "profit_loss"].includes(query.metric)) ||
    !Number.isSafeInteger(query.offset) ||
    query.offset < 0 ||
    !date(query.from) ||
    !date(query.to) ||
    (query.from !== undefined && query.to !== undefined && query.from > query.to)
  )
    throw new Error("portfolio_valuation_history_query_invalid");
  return {
    sql: `WITH point_revisions AS (
      SELECT v.id, v.parse_run_id, fa.id AS fetch_artifact_id, fa.source_id,
        v.source_account, v.subject, v.metric, v.currency, v.as_of,
        CAST(v.amount_minor AS TEXT) AS amount_minor, v.amount_text,
        p.parser_name, p.parser_version, fa.fetched_at, v.raw_locator, v.extra_json,
        DENSE_RANK() OVER (
          PARTITION BY fa.source_id, p.parser_name, v.source_account, v.subject, v.currency, v.as_of
          ORDER BY julianday(fa.fetched_at) DESC, fa.id DESC, p.id DESC
        ) AS point_rank
      FROM ${activeStateProjection.observationChain("valuation_observations", "v")}
      WHERE ${activeStateProjection.predicate}
        AND fa.source_id = 'sbi-securities' AND fa.dataset = 'account-assets-history'
        AND p.parser_name = 'sbi-account-assets-history'
    ), metric_revisions AS (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY source_id, parser_name, source_account, subject, metric, currency, as_of
        ORDER BY id DESC
      ) AS metric_rank FROM point_revisions WHERE point_rank = 1
    ) SELECT id, parse_run_id, fetch_artifact_id, source_id, source_account, subject,
        metric, currency, as_of, amount_minor, amount_text, parser_name, parser_version,
        fetched_at, raw_locator, extra_json
      FROM metric_revisions
      WHERE metric_rank = 1 AND subject = ?1
        AND (?2 IS NULL OR metric = ?2) AND (?3 IS NULL OR as_of >= ?3)
        AND (?4 IS NULL OR as_of <= ?4)
      ORDER BY as_of DESC, source_account, subject, currency, metric, id DESC
      LIMIT ${PAGE_LIMIT} OFFSET ?5`,
    args: [
      `portfolio:weekly:${query.profile}:${category}`,
      query.metric ?? null,
      query.from ?? null,
      query.to ?? null,
      query.offset,
    ],
  };
}
