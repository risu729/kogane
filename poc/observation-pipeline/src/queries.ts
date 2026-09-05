// Read-only data access for the evidence browser.
//
// Every query the API can run lives here, so the invariants are stated once
// rather than in each route. Two rules govern all of them:
//
//   * "Current" means produced by a parse run that succeeded and that nothing
//     has superseded. That is the predicate
//     `p.superseded_by_parse_run_id IS NULL AND p.status = 'ok'`, applied to
//     every current-state view. Superseded observations are never deleted, so
//     they stay reachable through the artifact they came from.
//   * Nothing here writes. The browser observes the store; a handler that
//     could write would make it part of the pipeline.
//
// Amounts are returned as stored: integer minor units plus the verbatim text.
// Formatting belongs to money.ts, which never uses floating point.

import type { Store } from "./store.ts";

import type {
  ObservationKind,
  Warnings,
  Overview,
  TransactionRow,
  BalanceRow,
  BalanceHistoryRow,
  PositionRow,
  ValuationRow,
  PositionWithValuations,
  ArtifactRow,
  ArtifactDetail,
  Provenance,
  ObservationDetail,
} from "../shared/api-contract.ts";
export type {
  ObservationKind,
  Warnings,
  Overview,
  TransactionRow,
  BalanceRow,
  BalanceHistoryRow,
  PositionRow,
  ValuationRow,
  PositionWithValuations,
  ArtifactRow,
  ParseRunDetail,
  ArtifactDetail,
  Provenance,
  ObservationDetail,
} from "../shared/api-contract.ts";

export const OBSERVATION_TABLES: Record<ObservationKind, string> = {
  transaction: "transaction_observations",
  balance: "balance_observations",
  position: "position_observations",
  valuation: "valuation_observations",
};

export function isObservationKind(value: string): value is ObservationKind {
  return Object.prototype.hasOwnProperty.call(OBSERVATION_TABLES, value);
}

const COUNTED_TABLES = [
  "sources",
  "fetch_runs",
  "raw_objects",
  "fetch_artifacts",
  "parse_runs",
  "transaction_observations",
  "balance_observations",
  "position_observations",
  "valuation_observations",
] as const;

/** Only a parse run that succeeded and that nothing has superseded is current. */
const CURRENT = "p.superseded_by_parse_run_id IS NULL AND p.status = 'ok'";

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

function summarize(parts: (string | null)[]): string {
  return parts.filter((part) => part !== null && part !== "").join(SEPARATOR);
}

export function overview(store: Store): Overview {
  const counts = COUNTED_TABLES.map((table) => ({
    table,
    rows: (
      store.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
        n: number;
      }
    ).n,
  }));
  const sources = store.db
    .query(
      `SELECT s.id, s.provider, s.ingestion,
              COUNT(a.id) AS artifact_count
       FROM sources s
       LEFT JOIN fetch_artifacts a ON a.source_id = s.id
       GROUP BY s.id, s.provider, s.ingestion
       ORDER BY s.id`,
    )
    .all() as Overview["sources"];
  const fetchRuns = store.db
    .query(
      `SELECT id, source_id, tool, external_run_id, status, started_at, completed_at
       FROM fetch_runs ORDER BY id`,
    )
    .all() as Overview["fetchRuns"];
  const parseRunRows = store.db
    .query(
      `SELECT id, fetch_artifact_id, parser_name, parser_version, parsed_at, status,
              error, warnings_json, superseded_by_parse_run_id
       FROM parse_runs ORDER BY id`,
    )
    .all() as (Omit<Overview["parseRuns"][number], "warnings"> & {
    warnings_json: string | null;
  })[];
  const parseRuns = parseRunRows.map(({ warnings_json, ...rest }) => ({
    ...rest,
    warnings: parseWarnings(warnings_json),
  }));
  return { counts, sources, fetchRuns, parseRuns };
}

export function currentTransactions(store: Store): TransactionRow[] {
  return store.db
    .query(
      `SELECT t.id, fa.source_id, t.source_account, t.as_of,
              CAST(t.amount_minor AS TEXT) AS amount_minor, t.amount_text,
              t.currency, t.description, t.counterparty, t.external_id, t.status,
              p.parser_name || '@' || p.parser_version AS parser
       FROM transaction_observations t
       JOIN parse_runs p ON p.id = t.parse_run_id
       JOIN fetch_artifacts fa ON fa.id = p.fetch_artifact_id
       WHERE ${CURRENT}
       ORDER BY COALESCE(t.as_of, '') DESC, t.id DESC`,
    )
    .all() as TransactionRow[];
}

/**
 * Latest balance per (source, account, metric, instrument).
 *
 * The source is carried through the join and into the partition key, because
 * `source_account` is only the provider's own label: two institutions both
 * calling an account "main" would otherwise hide each other.
 *
 * Computed on request and stored nowhere. It is a derived view; the
 * append-only history below it remains the record.
 */
export function latestBalances(store: Store): BalanceRow[] {
  return store.db
    .query(
      `SELECT id, source_id, source_account, metric, instrument, amount_minor,
              amount_text, as_of, observed_at, parser
       FROM (
         SELECT b.id, fa.source_id, b.source_account, b.metric, b.instrument,
                CAST(b.amount_minor AS TEXT) AS amount_minor, b.amount_text,
                b.as_of, b.observed_at,
                p.parser_name || '@' || p.parser_version AS parser,
                ROW_NUMBER() OVER (
                  PARTITION BY fa.source_id, b.source_account, b.metric, b.instrument
                  ORDER BY COALESCE(b.as_of, b.observed_at, '') DESC, b.id DESC
                ) AS rank_in_group
         FROM balance_observations b
         JOIN parse_runs p ON p.id = b.parse_run_id
         JOIN fetch_artifacts fa ON fa.id = p.fetch_artifact_id
         WHERE ${CURRENT}
       )
       WHERE rank_in_group = 1
       ORDER BY source_id, source_account, metric, instrument`,
    )
    .all() as BalanceRow[];
}

/** The full append-only history, superseded rows included and marked. */
export function balanceHistory(store: Store): BalanceHistoryRow[] {
  return store.db
    .query(
      `SELECT b.id, fa.source_id, b.source_account, b.metric, b.instrument,
              CAST(b.amount_minor AS TEXT) AS amount_minor,
              b.amount_text, b.as_of, b.observed_at,
              p.parser_name || '@' || p.parser_version AS parser,
              p.superseded_by_parse_run_id, p.status AS parse_status
       FROM balance_observations b
       JOIN parse_runs p ON p.id = b.parse_run_id
       JOIN fetch_artifacts fa ON fa.id = p.fetch_artifact_id
       ORDER BY COALESCE(b.as_of, b.observed_at, '') DESC, b.id DESC`,
    )
    .all() as BalanceHistoryRow[];
}

export function currentPositions(store: Store): PositionRow[] {
  return store.db
    .query(
      `SELECT po.id, fa.source_id, po.source_account, po.security_code, po.security_name,
              po.market, po.quantity_text, po.quantity_scale, po.currency, po.as_of,
              p.parser_name || '@' || p.parser_version AS parser
       FROM position_observations po
       JOIN parse_runs p ON p.id = po.parse_run_id
       JOIN fetch_artifacts fa ON fa.id = p.fetch_artifact_id
       WHERE ${CURRENT}
       ORDER BY fa.source_id, po.source_account, po.security_code, po.id`,
    )
    .all() as PositionRow[];
}

export function currentValuations(store: Store): ValuationRow[] {
  return store.db
    .query(
      `SELECT v.id, fa.source_id, v.source_account, v.subject, v.metric,
              CAST(v.amount_minor AS TEXT) AS amount_minor,
              v.amount_text, v.currency, v.as_of,
              p.parser_name || '@' || p.parser_version AS parser
       FROM valuation_observations v
       JOIN parse_runs p ON p.id = v.parse_run_id
       JOIN fetch_artifacts fa ON fa.id = p.fetch_artifact_id
       WHERE ${CURRENT}
       ORDER BY fa.source_id, v.source_account, v.subject, v.metric, v.id`,
    )
    .all() as ValuationRow[];
}

/**
 * Positions with the provider-reported valuations that describe them.
 *
 * Matched on (source, account, subject) rather than on the security code
 * alone, which is only unique within a provider. Each valuation keeps its own
 * currency; they are never summed or converted, because a JPY figure and a USD
 * figure are two separate claims by the source.
 */
export function positionsWithValuations(store: Store): PositionWithValuations[] {
  const bySubject = new Map<string, ValuationRow[]>();
  const key = (source: string, account: string, subject: string): string =>
    JSON.stringify([source, account, subject]);
  for (const valuation of currentValuations(store)) {
    const bucket = bySubject.get(
      key(valuation.source_id, valuation.source_account, valuation.subject),
    );
    if (bucket) bucket.push(valuation);
    else
      bySubject.set(key(valuation.source_id, valuation.source_account, valuation.subject), [
        valuation,
      ]);
  }
  return currentPositions(store).map((position) => ({
    position,
    valuations:
      bySubject.get(key(position.source_id, position.source_account, position.security_code)) ?? [],
  }));
}

export function artifacts(store: Store): ArtifactRow[] {
  return store.db
    .query(
      `SELECT a.id, a.source_id, a.dataset, a.url, a.mime, a.fetched_at, a.sha256,
              (SELECT COUNT(*) FROM parse_runs p WHERE p.fetch_artifact_id = a.id)
                AS parse_run_count,
              (SELECT COUNT(*) FROM transaction_observations t
                 JOIN parse_runs p ON p.id = t.parse_run_id
                WHERE p.fetch_artifact_id = a.id) AS transaction_count,
              (SELECT COUNT(*) FROM balance_observations b
                 JOIN parse_runs p ON p.id = b.parse_run_id
                WHERE p.fetch_artifact_id = a.id) AS balance_count,
              (SELECT COUNT(*) FROM position_observations o
                 JOIN parse_runs p ON p.id = o.parse_run_id
                WHERE p.fetch_artifact_id = a.id) AS position_count,
              (SELECT COUNT(*) FROM valuation_observations v
                 JOIN parse_runs p ON p.id = v.parse_run_id
                WHERE p.fetch_artifact_id = a.id) AS valuation_count
       FROM fetch_artifacts a
       ORDER BY a.id`,
    )
    .all() as ArtifactRow[];
}

/**
 * One artifact with EVERY parse run over it, superseded ones included. This is
 * the page that makes re-parsing auditable: it is the only place a retired
 * observation stays visible, which is what lets someone see what a parser
 * change actually did.
 */
export function artifactDetail(store: Store, id: number): ArtifactDetail | undefined {
  const artifact = store.db
    .query(
      `SELECT a.id, a.source_id, a.dataset, a.url, a.method, a.http_status, a.mime,
              a.fetched_at, a.sha256, r.size, r.content_type,
              f.id AS fetch_run_id, f.tool, f.external_run_id,
              f.status AS fetch_status, f.started_at, f.completed_at
       FROM fetch_artifacts a
       JOIN raw_objects r ON r.sha256 = a.sha256
       JOIN fetch_runs f ON f.id = a.fetch_run_id
       WHERE a.id = ?1`,
    )
    .get(id) as ArtifactDetail["artifact"] | null;
  if (!artifact) return undefined;

  const runs = store.db
    .query(
      `SELECT id, parser_name, parser_version, parsed_at, status, error,
              warnings_json, superseded_by_parse_run_id
       FROM parse_runs WHERE fetch_artifact_id = ?1 ORDER BY id`,
    )
    .all(id) as {
    id: number;
    parser_name: string;
    parser_version: string;
    parsed_at: string;
    status: string;
    error: string | null;
    warnings_json: string | null;
    superseded_by_parse_run_id: number | null;
  }[];

  return {
    artifact,
    parseRuns: runs.map(({ warnings_json, ...run }) => ({
      ...run,
      warnings: parseWarnings(warnings_json),
      observations: observationsForParseRun(store, run.id),
    })),
  };
}

/** Every observation a parse run produced, across all four shapes. */
export function observationsForParseRun(
  store: Store,
  parseRunId: number,
): { kind: ObservationKind; id: number; summary: string }[] {
  const out: { kind: ObservationKind; id: number; summary: string }[] = [];

  const transactions = store.db
    .query(
      `SELECT id, source_account, as_of, description
       FROM transaction_observations WHERE parse_run_id = ?1 ORDER BY id`,
    )
    .all(parseRunId) as {
    id: number;
    source_account: string;
    as_of: string | null;
    description: string | null;
  }[];
  for (const row of transactions) {
    out.push({
      kind: "transaction",
      id: row.id,
      summary: summarize([row.source_account, row.as_of, row.description]),
    });
  }

  const balances = store.db
    .query(
      `SELECT id, source_account, metric, instrument, as_of
       FROM balance_observations WHERE parse_run_id = ?1 ORDER BY id`,
    )
    .all(parseRunId) as {
    id: number;
    source_account: string;
    metric: string;
    instrument: string;
    as_of: string | null;
  }[];
  for (const row of balances) {
    out.push({
      kind: "balance",
      id: row.id,
      summary: summarize([row.source_account, row.metric, row.instrument, row.as_of]),
    });
  }

  const positions = store.db
    .query(
      `SELECT id, source_account, security_code, security_name
       FROM position_observations WHERE parse_run_id = ?1 ORDER BY id`,
    )
    .all(parseRunId) as {
    id: number;
    source_account: string;
    security_code: string;
    security_name: string | null;
  }[];
  for (const row of positions) {
    out.push({
      kind: "position",
      id: row.id,
      summary: summarize([row.source_account, row.security_code, row.security_name]),
    });
  }

  const valuations = store.db
    .query(
      `SELECT id, source_account, subject, metric, currency
       FROM valuation_observations WHERE parse_run_id = ?1 ORDER BY id`,
    )
    .all(parseRunId) as {
    id: number;
    source_account: string;
    subject: string;
    metric: string;
    currency: string;
  }[];
  for (const row of valuations) {
    out.push({
      kind: "valuation",
      id: row.id,
      summary: summarize([row.source_account, row.subject, row.metric, row.currency]),
    });
  }

  return out;
}

/**
 * One observation with the full provenance chain behind it: parse run,
 * artifact, raw object, fetch run. Without that chain this would be a table
 * viewer; with it, a number on screen can be traced to the bytes a source
 * actually sent.
 */
export function observationDetail(
  store: Store,
  kind: ObservationKind,
  id: number,
): ObservationDetail | undefined {
  // The table name comes from a fixed map keyed by a validated union member,
  // never from the request path.
  const table = OBSERVATION_TABLES[kind];
  // Positions store a quantity, not an amount. Other kinds need the trailing
  // CAST to preserve every digit while still returning all stored columns.
  const columns = kind === "position" ? "*" : "*, CAST(amount_minor AS TEXT) AS amount_minor";
  const row = store.db.query(`SELECT ${columns} FROM ${table} WHERE id = ?1`).get(id) as Record<
    string,
    unknown
  > | null;
  if (!row) return undefined;

  const extraRaw = typeof row["extra_json"] === "string" ? row["extra_json"] : "";
  let extra: unknown = extraRaw;
  let extraParsed = false;
  try {
    extra = JSON.parse(extraRaw);
    extraParsed = true;
  } catch {
    // Not valid JSON: hand back exactly what is stored rather than inventing a
    // shape the store does not have.
  }

  const parseRunId = typeof row["parse_run_id"] === "number" ? row["parse_run_id"] : 0;
  const provenanceRow = store.db
    .query(
      `SELECT p.id AS parse_run_id, p.parser_name, p.parser_version, p.parsed_at,
              p.status AS parse_status, p.error, p.warnings_json,
              p.superseded_by_parse_run_id,
              a.id AS artifact_id, a.source_id, a.dataset, a.url, a.mime, a.fetched_at,
              r.sha256, r.size, r.content_type,
              f.id AS fetch_run_id, f.tool, f.external_run_id,
              f.status AS fetch_status, f.started_at, f.completed_at
       FROM parse_runs p
       JOIN fetch_artifacts a ON a.id = p.fetch_artifact_id
       JOIN raw_objects r ON r.sha256 = a.sha256
       JOIN fetch_runs f ON f.id = a.fetch_run_id
       WHERE p.id = ?1`,
    )
    .get(parseRunId) as (Omit<Provenance, "warnings"> & { warnings_json: string | null }) | null;

  const provenance = provenanceRow
    ? { ...provenanceRow, warnings: parseWarnings(provenanceRow.warnings_json) }
    : undefined;

  const { extra_json: _extraJson, ...rest } = row;
  return { kind, row: rest, extra, extraRaw, extraParsed, provenance };
}

export interface RawObjectRow {
  sha256: string;
  content_type: string;
  size: number;
}

export function rawObjectMeta(store: Store, sha256: string): RawObjectRow | undefined {
  const row = store.db
    .query("SELECT sha256, content_type, size FROM raw_objects WHERE sha256 = ?1")
    .get(sha256) as RawObjectRow | null;
  return row ?? undefined;
}
