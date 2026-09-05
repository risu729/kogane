// Browser-safe HTTP contracts. No database, runtime, or UI imports.
// Amount strings retain exact minor units; formatting never changes these values.
export type ObservationKind =
  | "transaction"
  | "balance"
  | "position"
  | "valuation";

export interface ApiMetadata {
  apiVersion: 1;
  source: {
    kind: "local-store";
    /** Synthetic is an explicit assertion by an isolated fixture-only startup. */
    classification: "unknown" | "synthetic";
  };
  capabilities: {
    readOnly: true;
    rawEvidence: true;
    liveCollectors: false;
  };
}

export interface Warnings {
  /** Parsed warning strings; empty when the stored value could not be read. */
  list: string[];
  /** The stored text, so an unreadable value can be shown rather than hidden. */
  raw: string | null;
  parsed: boolean;
}

export interface Overview {
  counts: { table: string; rows: number }[];
  sources: {
    id: string;
    provider: string;
    ingestion: string;
    artifact_count: number;
  }[];
  fetchRuns: {
    id: number;
    source_id: string;
    tool: string;
    external_run_id: string | null;
    status: string;
    started_at: string;
    completed_at: string | null;
  }[];
  parseRuns: {
    id: number;
    fetch_artifact_id: number;
    parser_name: string;
    parser_version: string;
    parsed_at: string;
    status: string;
    warnings: Warnings;
    error: string | null;
    superseded_by_parse_run_id: number | null;
  }[];
}

export interface TransactionRow {
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

export interface BalanceRow {
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

export interface BalanceHistoryRow extends BalanceRow {
  superseded_by_parse_run_id: number | null;
  parse_status: string;
}

export interface PositionRow {
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

export interface ValuationRow {
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

export interface PositionWithValuations {
  position: PositionRow;
  valuations: ValuationRow[];
}

export interface ArtifactRow {
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

export interface ObservationRef {
  kind: ObservationKind;
  id: number;
  summary: string;
}

export interface ParseRunDetail {
  id: number;
  parser_name: string;
  parser_version: string;
  parsed_at: string;
  status: string;
  error: string | null;
  warnings: Warnings;
  superseded_by_parse_run_id: number | null;
  observations: ObservationRef[];
}

export interface ArtifactDetail {
  artifact: {
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
  };
  parseRuns: ParseRunDetail[];
}

export interface Provenance {
  parse_run_id: number;
  parser_name: string;
  parser_version: string;
  parsed_at: string;
  parse_status: string;
  error: string | null;
  warnings: Warnings;
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

export interface ObservationDetail {
  kind: ObservationKind;
  row: Record<string, unknown>;
  extra: unknown;
  extraRaw: string;
  extraParsed: boolean;
  provenance: Provenance | undefined;
}
