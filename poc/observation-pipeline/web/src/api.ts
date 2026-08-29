// The client's view of the read-only JSON API.
//
// Every interface here mirrors an interface exported by src/queries.ts, field
// for field and nullability for nullability. They are restated rather than
// imported because src/queries.ts pulls in bun:sqlite through src/store.ts,
// which has no business in a browser bundle. When a query shape changes, this
// file is the one place the client has to follow it.
//
export interface Warnings {
  /** Parsed warning strings; empty when the stored value could not be read. */
  list: string[];
  /** The stored text, so an unreadable value can be shown rather than hidden. */
  raw: string | null;
  parsed: boolean;
}

// Amounts are never widened here. `amount_minor` is carried as the integer
// minor-unit value the API sent and `amount_text` as the provider's verbatim
// string; both go to src/money.ts untouched.

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { ObservationKind } from "./router.tsx";

export type { ObservationKind };

// ── response shapes (mirroring src/queries.ts) ───────────────────────

export interface Overview {
  counts: { table: string; rows: number }[];
  sources: { id: string; provider: string; ingestion: string; artifact_count: number }[];
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

// ── transport ────────────────────────────────────────────────────────

/** The path to an artifact's bytes. Linked to, never fetched and rendered. */
export function rawUrl(sha256: string): string {
  return `/api/raw/${sha256}`;
}

/**
 * A 404 body from this API is `{error: string}`. That string is the useful
 * half of the failure, so it is surfaced instead of the status line.
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function getJson<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    signal,
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    let message = `${String(response.status)} ${response.statusText}`.trim();
    try {
      const body: unknown = await response.json();
      if (
        typeof body === "object" &&
        body !== null &&
        "error" in body &&
        typeof (body as { error: unknown }).error === "string"
      ) {
        message = (body as { error: string }).error;
      }
    } catch {
      // A non-JSON error body tells us nothing the status line does not.
    }
    throw new ApiError(response.status, message);
  }
  return (await response.json()) as T;
}

// ── hooks ────────────────────────────────────────────────────────────
//
// Every view is a fresh read. Nothing is written to localStorage, nothing is
// persisted across a reload, and no figure on a page outlives the response it
// came from.

export function useOverview(): UseQueryResult<Overview, Error> {
  return useQuery({
    queryKey: ["overview"],
    queryFn: ({ signal }) => getJson<Overview>("/api/overview", signal),
  });
}

export function useTransactions(): UseQueryResult<{ transactions: TransactionRow[] }, Error> {
  return useQuery({
    queryKey: ["transactions"],
    queryFn: ({ signal }) =>
      getJson<{ transactions: TransactionRow[] }>("/api/transactions", signal),
  });
}

export function useBalances(): UseQueryResult<
  { latest: BalanceRow[]; history: BalanceHistoryRow[] },
  Error
> {
  return useQuery({
    queryKey: ["balances"],
    queryFn: ({ signal }) =>
      getJson<{ latest: BalanceRow[]; history: BalanceHistoryRow[] }>(
        "/api/balances",
        signal,
      ),
  });
}

export function usePositions(): UseQueryResult<
  { positions: PositionWithValuations[] },
  Error
> {
  return useQuery({
    queryKey: ["positions"],
    queryFn: ({ signal }) =>
      getJson<{ positions: PositionWithValuations[] }>("/api/positions", signal),
  });
}

export function useArtifacts(): UseQueryResult<{ artifacts: ArtifactRow[] }, Error> {
  return useQuery({
    queryKey: ["artifacts"],
    queryFn: ({ signal }) => getJson<{ artifacts: ArtifactRow[] }>("/api/artifacts", signal),
  });
}

export function useArtifact(id: number): UseQueryResult<ArtifactDetail, Error> {
  return useQuery({
    queryKey: ["artifact", id],
    queryFn: ({ signal }) => getJson<ArtifactDetail>(`/api/artifacts/${String(id)}`, signal),
  });
}

export function useObservation(
  kind: ObservationKind,
  id: number,
): UseQueryResult<ObservationDetail, Error> {
  return useQuery({
    queryKey: ["observation", kind, id],
    queryFn: ({ signal }) =>
      getJson<ObservationDetail>(`/api/observations/${kind}/${String(id)}`, signal),
  });
}
