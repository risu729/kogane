// ObservationReader over any SqlExecutor. The bound on list results and the
// mapping from rows to contract types happen here once, for every query.

import type {
  ArtifactDetail,
  FilterOptions,
  ObservationDetail,
  Overview,
  ParseRunDetail,
  PositionWithValuations,
} from "../../../poc/observation-pipeline/shared/api-contract";
import { OBSERVATION_TABLES, type ObservationKind } from "./concepts";
import {
  type ArtifactDetailSqlRow,
  type ArtifactSqlRow,
  artifactDetailArtifact,
  artifactRow,
  type BalanceHistorySqlRow,
  type BalanceSqlRow,
  balanceHistoryRow,
  balanceRow,
  observationSummary,
  type OverviewFetchRunSqlRow,
  type OverviewParseRunSqlRow,
  type OverviewSourceSqlRow,
  overviewFetchRun,
  overviewParseRun,
  overviewSource,
  type ParseRunSqlRow,
  parseRunDetail,
  type PositionSqlRow,
  positionRow,
  type ProvenanceSqlRow,
  provenance,
  type TransactionSqlRow,
  transactionRow,
  type ValuationSqlRow,
  valuationRow,
} from "./mappers";
import {
  type ObservationReader,
  type ParsingHealth,
  type RawDownload,
  type ReaderOptions,
  ResultLimitExceededError,
  type SqlExecutor,
} from "./reader";
import { CANDIDATE_LIMIT, RESULT_BOUND } from "./scope";
import {
  ARTIFACT_DETAIL_SQL,
  ARTIFACT_PARSE_RUNS_SQL,
  ARTIFACTS_SQL,
  balanceFilterScope,
  balanceHistorySql,
  COUNTED_RELATIONS,
  countSql,
  FILTER_SOURCES_SQL,
  filterAccountsSql,
  filterDimensionsSql,
  latestBalancesSql,
  observationDetailSql,
  OVERVIEW_FETCH_RUNS_SQL,
  OVERVIEW_PARSE_RUNS_SQL,
  OVERVIEW_SOURCES_SQL,
  PARSING_HEALTH_SQL,
  parseRunObservationsSql,
  POSITION_VALUATIONS_SQL,
  positionsSql,
  PROVENANCE_SQL,
  RAW_DOWNLOAD_SQL,
  transactionsSql,
  VISIBLE_EVIDENCE_PROBE_SQL,
} from "./sql";

const KINDS: readonly ObservationKind[] = ["transaction", "balance", "position", "valuation"];
const FILTER_TABLES = {
  transactions: OBSERVATION_TABLES.transaction,
  balances: OBSERVATION_TABLES.balance,
  positions: OBSERVATION_TABLES.position,
} as const;

export function createObservationReader(
  executor: SqlExecutor,
  options: ReaderOptions = {},
): ObservationReader {
  // Every list read is bounded: one row past the bound is fetched and the
  // result is refused, never returned as if complete. Page limits sit inside.
  const list = async <T>(sql: string, args: readonly unknown[] = []): Promise<T[]> => {
    const rows = await executor.all<T>(`SELECT * FROM (${sql}) LIMIT ${CANDIDATE_LIMIT}`, args);
    if (rows.length > RESULT_BOUND)
      throw options.limitExceeded ? options.limitExceeded() : new ResultLimitExceededError();
    return rows;
  };
  const one = <T>(sql: string, args: readonly unknown[] = []): Promise<T | null> =>
    executor.first<T>(sql, args);

  async function observationsForParseRun(
    parseRunId: number,
  ): Promise<ParseRunDetail["observations"]> {
    const out: ParseRunDetail["observations"] = [];
    for (const kind of KINDS) {
      const rows = await list<Record<string, unknown> & { id: number }>(
        parseRunObservationsSql(kind),
        [parseRunId],
      );
      for (const row of rows)
        out.push({ kind, id: row.id, summary: observationSummary(kind, row) });
    }
    return out;
  }

  return {
    async overview(): Promise<Overview> {
      const counts = await Promise.all(
        COUNTED_RELATIONS.map(async ([table, relation]) => ({
          table,
          rows: (await one<{ n: number }>(countSql(relation)))!.n,
        })),
      );
      const sources = (await list<OverviewSourceSqlRow>(OVERVIEW_SOURCES_SQL)).map(overviewSource);
      const fetchRuns = (await list<OverviewFetchRunSqlRow>(OVERVIEW_FETCH_RUNS_SQL)).map(
        overviewFetchRun,
      );
      const parseRuns = (await list<OverviewParseRunSqlRow>(OVERVIEW_PARSE_RUNS_SQL)).map(
        overviewParseRun,
      );
      return { counts, sources, fetchRuns, parseRuns };
    },

    async parsingHealth(): Promise<ParsingHealth> {
      await one(VISIBLE_EVIDENCE_PROBE_SQL);
      const jobs = await executor.all<{ status: keyof ParsingHealth; count: number }>(
        PARSING_HEALTH_SQL,
        [],
      );
      const health: ParsingHealth = { pending: 0, running: 0, failed: 0 };
      for (const job of jobs) health[job.status] = job.count;
      return health;
    },

    async listTransactions({ offset, ...scope }) {
      const page = transactionsSql(scope, offset);
      return (await list<TransactionSqlRow>(page.sql, page.args)).map(transactionRow);
    },

    async listLatestBalances({ offset, limit, ...scope }) {
      const page = latestBalancesSql(scope, offset, limit);
      return (await list<BalanceSqlRow>(page.sql, page.args)).map(balanceRow);
    },

    async listBalanceHistory({ offset, ...scope }) {
      const page = balanceHistorySql(scope, offset);
      return (await list<BalanceHistorySqlRow>(page.sql, page.args)).map(balanceHistoryRow);
    },

    async listPositions({ offset, ...scope }): Promise<PositionWithValuations[]> {
      const page = positionsSql(scope, offset);
      const positions = (await list<PositionSqlRow>(page.sql, page.args)).map(positionRow);
      if (positions.length === 0) return [];
      // Only the 500 positions the caller can return need valuations; the
      // 501st row exists to report truncation.
      const pairs = await list<ValuationSqlRow & { position_id: number }>(POSITION_VALUATIONS_SQL, [
        JSON.stringify(positions.slice(0, 500).map((row) => row.id)),
      ]);
      const byPosition = new Map<number, ReturnType<typeof valuationRow>[]>();
      for (const pair of pairs) {
        const bucket = byPosition.get(pair.position_id) ?? [];
        bucket.push(valuationRow(pair));
        byPosition.set(pair.position_id, bucket);
      }
      return positions.map((position) => ({
        position,
        valuations: byPosition.get(position.id) ?? [],
      }));
    },

    async listArtifacts({ before, source }) {
      return (await list<ArtifactSqlRow>(ARTIFACTS_SQL, [before, source ?? null])).map(artifactRow);
    },

    async filterOptions({ kind, measureView }): Promise<FilterOptions> {
      const balanceScope = kind === "balances" ? balanceFilterScope(measureView) : null;
      const sources = await list<{ source_id: string }>(FILTER_SOURCES_SQL);
      const accounts =
        kind === "artifacts"
          ? []
          : await list<{ source_id: string; source_account: string }>(
              filterAccountsSql(FILTER_TABLES[kind], balanceScope),
            );
      const dimensions =
        balanceScope === null
          ? []
          : await list<{ instrument: string; metric: string }>(filterDimensionsSql(balanceScope));
      return {
        // A measure view narrows sources to those with a matching account.
        sources: measureView
          ? [...new Set(accounts.map((row) => row.source_id))].sort()
          : sources.map((row) => row.source_id),
        accounts,
        instruments: [...new Set(dimensions.map((row) => row.instrument))].sort(),
        metrics: [...new Set(dimensions.map((row) => row.metric))].sort(),
      };
    },

    async getArtifact(id): Promise<ArtifactDetail | undefined> {
      const artifact = await one<ArtifactDetailSqlRow>(ARTIFACT_DETAIL_SQL, [id]);
      if (!artifact) return undefined;
      const runs = await list<ParseRunSqlRow>(ARTIFACT_PARSE_RUNS_SQL, [id]);
      return {
        artifact: artifactDetailArtifact(artifact),
        parseRuns: await Promise.all(
          runs.map(async (run) => parseRunDetail(run, await observationsForParseRun(run.id))),
        ),
      };
    },

    async getObservation({ kind, id }): Promise<ObservationDetail | undefined> {
      const row = await one<Record<string, unknown>>(observationDetailSql(kind), [id]);
      if (!row) return undefined;
      const extraRaw = typeof row["extra_json"] === "string" ? row["extra_json"] : "";
      let extra: unknown = extraRaw;
      let extraParsed = false;
      try {
        extra = JSON.parse(extraRaw);
        extraParsed = true;
      } catch {
        // Not valid JSON: hand back exactly what is stored rather than
        // inventing a shape the store does not have.
      }
      const parseRunId = typeof row["parse_run_id"] === "number" ? row["parse_run_id"] : 0;
      const provenanceRow = await one<ProvenanceSqlRow>(PROVENANCE_SQL, [parseRunId]);
      const { extra_json: _extraJson, ...rest } = row;
      return {
        kind,
        row: rest,
        extra,
        extraRaw,
        extraParsed,
        provenance: provenanceRow ? provenance(provenanceRow) : undefined,
      };
    },

    async getRawDownload({ sha256 }): Promise<RawDownload | undefined> {
      return (await one<RawDownload>(RAW_DOWNLOAD_SQL, [sha256])) ?? undefined;
    },
  };
}
