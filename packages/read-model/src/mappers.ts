// Explicit mappers from SQL rows to the API contract. A row type states what
// each query selects; the mapper states what the API promises. Drift between
// the two fails to compile instead of surfacing as a missing field in JSON.

import type {
  ArtifactDetail,
  ArtifactRow,
  BalanceHistoryRow,
  BalanceRow,
  ObservationKind,
  Overview,
  ParseRunDetail,
  PositionRow,
  Provenance,
  TransactionRow,
  UnitUpdateSummary,
  ValuationRow,
  Warnings,
} from "../../../packages/observation-shared/src/api-contract";

const SEPARATOR = " · ";

/**
 * Read a stored warnings array. A malformed value must not quietly become
 * "no warnings": warnings are the parser's record of what it could not read,
 * so losing them loses exactly the signal this store exists to keep.
 */
export function parseWarnings(warningsJson: string | null): Warnings {
  if (warningsJson === null || warningsJson === "") {
    return { list: [], raw: warningsJson, parsed: true };
  }
  try {
    const value: unknown = JSON.parse(warningsJson);
    if (!Array.isArray(value)) {
      return { list: [], raw: warningsJson, parsed: false };
    }
    return {
      list: value.map((entry) => String(entry)),
      raw: warningsJson,
      parsed: true,
    };
  } catch {
    return { list: [], raw: warningsJson, parsed: false };
  }
}

export function summarize(parts: (string | null)[]): string {
  return parts.filter((part) => part !== null && part !== "").join(SEPARATOR);
}

export interface TransactionSqlRow {
  id: number;
  source_id: string;
  source_account: string;
  as_of: string | null;
  amount_minor: string | null;
  amount_text: string | null;
  currency: string | null;
  description: string | null;
  counterparty: string | null;
  external_id: string | null;
  status: string | null;
  parser: string;
}
export function transactionRow(row: TransactionSqlRow): TransactionRow {
  return {
    id: row.id,
    source_id: row.source_id,
    source_account: row.source_account,
    as_of: row.as_of,
    amount_minor: row.amount_minor,
    amount_text: row.amount_text,
    currency: row.currency,
    description: row.description,
    counterparty: row.counterparty,
    external_id: row.external_id,
    status: row.status,
    parser: row.parser,
  };
}

export interface BalanceSqlRow {
  id: number;
  source_id: string;
  source_account: string;
  metric: string;
  instrument: string;
  amount_minor: string | null;
  amount_text: string | null;
  as_of: string | null;
  observed_at: string | null;
  parser: string;
}
export function balanceRow(row: BalanceSqlRow): BalanceRow {
  return {
    id: row.id,
    source_id: row.source_id,
    source_account: row.source_account,
    metric: row.metric,
    instrument: row.instrument,
    amount_minor: row.amount_minor,
    amount_text: row.amount_text,
    as_of: row.as_of,
    observed_at: row.observed_at,
    parser: row.parser,
  };
}

export interface BalanceHistorySqlRow extends BalanceSqlRow {
  superseded_by_parse_run_id: number | null;
  parse_status: string;
}
export function balanceHistoryRow(row: BalanceHistorySqlRow): BalanceHistoryRow {
  return {
    ...balanceRow(row),
    superseded_by_parse_run_id: row.superseded_by_parse_run_id,
    parse_status: row.parse_status,
  };
}

export interface PositionSqlRow {
  id: number;
  source_id: string;
  source_account: string;
  security_code: string;
  security_name: string | null;
  market: string | null;
  quantity_text: string;
  quantity_scale: number;
  currency: string | null;
  as_of: string | null;
  parser: string;
}
export function positionRow(row: PositionSqlRow): PositionRow {
  return {
    id: row.id,
    source_id: row.source_id,
    source_account: row.source_account,
    security_code: row.security_code,
    security_name: row.security_name,
    market: row.market,
    quantity_text: row.quantity_text,
    quantity_scale: row.quantity_scale,
    currency: row.currency,
    as_of: row.as_of,
    parser: row.parser,
  };
}

export interface ValuationSqlRow {
  id: number;
  source_id: string;
  source_account: string;
  subject: string;
  metric: string;
  amount_minor: string | null;
  amount_text: string | null;
  currency: string;
  as_of: string | null;
  parser: string;
}
export function valuationRow(row: ValuationSqlRow): ValuationRow {
  return {
    id: row.id,
    source_id: row.source_id,
    source_account: row.source_account,
    subject: row.subject,
    metric: row.metric,
    amount_minor: row.amount_minor,
    amount_text: row.amount_text,
    currency: row.currency,
    as_of: row.as_of,
    parser: row.parser,
  };
}

export interface ArtifactSqlRow {
  id: number;
  source_id: string;
  dataset: string | null;
  url: string | null;
  mime: string;
  fetched_at: string;
  sha256: string;
  parse_run_count: number;
  transaction_count: number;
  balance_count: number;
  position_count: number;
  valuation_count: number;
}
export function artifactRow(row: ArtifactSqlRow): ArtifactRow {
  return {
    id: row.id,
    source_id: row.source_id,
    dataset: row.dataset,
    url: row.url,
    mime: row.mime,
    fetched_at: row.fetched_at,
    sha256: row.sha256,
    parse_run_count: row.parse_run_count,
    transaction_count: row.transaction_count,
    balance_count: row.balance_count,
    position_count: row.position_count,
    valuation_count: row.valuation_count,
  };
}

export interface OverviewSourceSqlRow {
  id: string;
  provider: string;
  ingestion: string;
  artifact_count: number;
}
export function overviewSource(row: OverviewSourceSqlRow): Overview["sources"][number] {
  return {
    id: row.id,
    provider: row.provider,
    ingestion: row.ingestion,
    artifact_count: row.artifact_count,
  };
}

export interface OverviewFetchRunSqlRow {
  id: number;
  source_id: string;
  tool: string;
  external_run_id: string | null;
  status: string;
  started_at: string;
  completed_at: string | null;
}
export function overviewFetchRun(row: OverviewFetchRunSqlRow): Overview["fetchRuns"][number] {
  return {
    id: row.id,
    source_id: row.source_id,
    tool: row.tool,
    external_run_id: row.external_run_id,
    status: row.status,
    started_at: row.started_at,
    completed_at: row.completed_at,
  };
}

export interface OverviewParseRunSqlRow {
  id: number;
  fetch_artifact_id: number;
  parser_name: string;
  parser_version: string;
  parsed_at: string;
  status: string;
  error: string | null;
  warnings_json: string | null;
  superseded_by_parse_run_id: number | null;
}
export function overviewParseRun(row: OverviewParseRunSqlRow): Overview["parseRuns"][number] {
  return {
    id: row.id,
    fetch_artifact_id: row.fetch_artifact_id,
    parser_name: row.parser_name,
    parser_version: row.parser_version,
    parsed_at: row.parsed_at,
    status: row.status,
    warnings: parseWarnings(row.warnings_json),
    error: row.error,
    superseded_by_parse_run_id: row.superseded_by_parse_run_id,
  };
}

/** D13 partial-update signal; see `UNIT_UPDATES_SQL`. */
export interface UnitUpdateSqlRow {
  /** Never null: the policy join `pol.dataset = fa.dataset` excludes datasetless artifacts. */
  source_id: string;
  dataset: string;
  fetch_run_id: number;
  fetched_at: string;
  updated_units: number;
  stale_units: number;
}
export function unitUpdateSummary(row: UnitUpdateSqlRow): UnitUpdateSummary {
  return {
    source_id: row.source_id,
    dataset: row.dataset,
    fetch_run_id: row.fetch_run_id,
    fetched_at: row.fetched_at,
    updated_units: row.updated_units,
    stale_units: row.stale_units,
  };
}

export interface ArtifactDetailSqlRow {
  id: number;
  source_id: string;
  dataset: string | null;
  url: string | null;
  method: string | null;
  http_status: number | null;
  mime: string;
  fetched_at: string;
  sha256: string;
  size: number;
  content_type: string;
  fetch_run_id: number;
  tool: string;
  external_run_id: string | null;
  fetch_status: string;
  started_at: string;
  completed_at: string | null;
}
export function artifactDetailArtifact(row: ArtifactDetailSqlRow): ArtifactDetail["artifact"] {
  return {
    id: row.id,
    source_id: row.source_id,
    dataset: row.dataset,
    url: row.url,
    method: row.method,
    http_status: row.http_status,
    mime: row.mime,
    fetched_at: row.fetched_at,
    sha256: row.sha256,
    size: row.size,
    content_type: row.content_type,
    fetch_run_id: row.fetch_run_id,
    tool: row.tool,
    external_run_id: row.external_run_id,
    fetch_status: row.fetch_status,
    started_at: row.started_at,
    completed_at: row.completed_at,
  };
}

export interface ParseRunSqlRow {
  id: number;
  parser_name: string;
  parser_version: string;
  parsed_at: string;
  status: string;
  error: string | null;
  warnings_json: string | null;
  superseded_by_parse_run_id: number | null;
}
export function parseRunDetail(
  row: ParseRunSqlRow,
  observations: ParseRunDetail["observations"],
): ParseRunDetail {
  return {
    id: row.id,
    parser_name: row.parser_name,
    parser_version: row.parser_version,
    parsed_at: row.parsed_at,
    status: row.status,
    error: row.error,
    warnings: parseWarnings(row.warnings_json),
    superseded_by_parse_run_id: row.superseded_by_parse_run_id,
    observations,
  };
}

export interface ProvenanceSqlRow {
  parse_run_id: number;
  parser_name: string;
  parser_version: string;
  parsed_at: string;
  parse_status: string;
  error: string | null;
  warnings_json: string | null;
  superseded_by_parse_run_id: number | null;
  artifact_id: number;
  source_id: string;
  dataset: string | null;
  url: string | null;
  mime: string;
  fetched_at: string;
  sha256: string;
  size: number;
  content_type: string;
  fetch_run_id: number;
  tool: string;
  external_run_id: string | null;
  fetch_status: string;
  started_at: string;
  completed_at: string | null;
}
/**
 * The served shape has always carried the raw `warnings_json` column next to
 * the parsed `warnings`, although the contract type does not list it. It is
 * kept for response-shape parity; `warnings.raw` is the contract's way to
 * read the same text, and dropping the column is a contract change.
 */
export function provenance(row: ProvenanceSqlRow): Provenance & { warnings_json: string | null } {
  return { ...row, warnings: parseWarnings(row.warnings_json) };
}

/** Summary line of one observation reference, per shape. */
export function observationSummary(kind: ObservationKind, row: Record<string, unknown>): string {
  const text = (key: string): string | null => {
    const value = row[key];
    return typeof value === "string" ? value : null;
  };
  switch (kind) {
    case "transaction":
      return summarize([text("source_account"), text("as_of"), text("description")]);
    case "balance":
      return summarize([text("source_account"), text("metric"), text("instrument"), text("as_of")]);
    case "position":
      return summarize([text("source_account"), text("security_code"), text("security_name")]);
    case "valuation":
      return summarize([text("source_account"), text("subject"), text("metric"), text("currency")]);
  }
}
