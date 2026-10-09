// Collection quality (ADR 0045, docs/read-model.md "Collection quality"): what
// each stage of collection last did, per schedule, per CORE source and per
// source × fetch unit × dataset × period, in identifiers, times, counts and
// closed codes. Read-only and computed per request; nothing here is stored.
//
// The stages and where each is read:
//
//   attempt       collection_schedules, the newest collection_schedule_occurrences
//                 row per job (its UNIQUE(schedule_id, nominal_at) index) and the
//                 held collection_execution_leases row (CORE 0065).
//   acquisition   collection_runs for the exact run ids a receipt names, and the
//                 never-registered terminals per collector source (CORE 0039).
//   raw stored    a visible artifact whose raw object is reachable (`evidenceExists`).
//   parsed        observation_parse_jobs, recorded parse runs and the publication
//                 projection of each (artifact, parser) of a cell's newest capture.
//   current       membership in the current set under the rule the existing reads
//                 use: the dataset snapshot policies (`completeSnapshotCandidates`),
//                 the GLOBAL PASS, Vpass and MyJCB snapshot CTEs of sql.ts, and
//                 otherwise `activeStateProjection`. The rules are composed, never
//                 restated, so this read cannot disagree with the lists it explains.
//   freshness     the capture time of a cell's current capture, as stored. No
//                 "now minus" is computed and no age is judged here.
//
// Cost (D1 has no table statistics): the schedule, source and terminal reads
// are keyed by their primary keys and indexes, per configured job and per
// source. The cell read reaches one source's artifacts through
// `idx_fetch_artifacts_source_dataset_time` and every parse, job, publication,
// claim and unit row by key from them; the only whole-store passes are the
// ones the composed snapshot CTEs already make for the Transactions, Balances
// and Positions reads, and SQLite runs a per-source CTE only when a cell of its
// dataset reaches it. `test/collection-quality.test.ts` checks the plans on a
// scaled store with the complete CORE schema.
//
// Parameters: the cell read takes `?1` the CORE source id and `?2` the offset.
import {
  activeStateProjection,
  completeSnapshotCandidates,
  evidenceExists,
  recordedParses,
  successfulFetchRuns,
  unitParseable,
  visibleEvidence,
} from "./concepts";
import { PAGE_LIMIT } from "./scope";
import {
  GLOBAL_PASS_ACTIVITY_SNAPSHOT_CTES,
  GLOBAL_PASS_MONTH,
  MYJCB_LEDGER_MEMBER,
  MYJCB_LEDGER_SNAPSHOT_CTES,
  myjcbStatementSlot,
  VPASS_SNAPSHOT_MEMBER,
  VPASS_STATEMENT_MONTH,
  VPASS_STATEMENT_SNAPSHOT_CTES,
} from "./sql";

/** More configured jobs or sources than this in one read is refused, never cut. */
export const COLLECTION_QUALITY_ROW_BOUND = 200;

/**
 * Parsers whose current set a read narrows further than the rules composed
 * here: the Transactions read keeps only the newest SMBC Direct range per key,
 * the newest MoneyForward month per account and the newest complete V Point
 * run, and the Balances read the newest MyJCB past-months capture per
 * connection. Their cells state `published-eligible` currentness and carry
 * `query_rule_not_composed`; `test/collection-quality.test.ts` pins each name
 * to the read that narrows it, so a rule added there fails until it is named
 * here or composed.
 */
export const UNCOMPOSED_QUERY_RULE_PARSERS = [
  "smbc-direct-transactions",
  "moneyforward-monthly-transactions",
  "v-point-history-page",
  "v-point-balance-info",
  "v-point-smfg-point",
  "myjcb-credit-past-month-balances",
] as const;

// ── attempt ───────────────────────────────────────────────────────────────

export interface ScheduleQualityRow {
  id: string;
  source: string | null;
  kind: string;
  enabled: number;
  supported: number;
  occurrence_status: string | null;
  occurrence_failure_code: string | null;
  occurrence_nominal_at: string | null;
  occurrence_finished_at: string | null;
  /** JSON array of the collector run ids the receipt names; never returned to a client. */
  occurrence_run_ids: string | null;
  lease_started_at: string | null;
}

/**
 * Every configured job, its newest receipt by nominal time and its held
 * lease. The jobs are the rows of `collection_schedules`, read here rather
 * than counted anywhere, so a job added or removed by a migration or the
 * settings API is what the read shows.
 */
export const SCHEDULE_QUALITY_SQL = `SELECT s.id, s.source, s.kind, s.enabled, s.supported,
       o.status AS occurrence_status, o.failure_code AS occurrence_failure_code,
       o.nominal_at AS occurrence_nominal_at, o.finished_at AS occurrence_finished_at,
       o.run_ids_json AS occurrence_run_ids,
       lease.started_at AS lease_started_at
  FROM collection_schedules s
  LEFT JOIN collection_schedule_occurrences o
    ON o.id = (SELECT newest.id FROM collection_schedule_occurrences newest
                WHERE newest.schedule_id = s.id
                ORDER BY newest.nominal_at DESC LIMIT 1)
  LEFT JOIN collection_execution_leases lease
    ON lease.source = s.source AND lease.lease_ref IS NOT NULL
 ORDER BY s.id
 LIMIT ${COLLECTION_QUALITY_ROW_BOUND + 1}`;

// ── acquisition ───────────────────────────────────────────────────────────

export interface TerminalQualityRow {
  id: number;
  source: string;
  run_id: string;
  provider_outcome: string | null;
  coverage_status: string | null;
  blocked_code: string | null;
  registered_at: string | null;
  /** The registered fetch run, only when it is visible evidence. */
  visible_fetch_run_id: number | null;
  registered_stage_state: string | null;
  registered_stage_failure_code: string | null;
}

/**
 * The `collection_runs` rows of exactly the (collector source, run id) pairs
 * in `?1`, a JSON array of two-element arrays: the runs a receipt names, never
 * the latest unrelated run. A run registered again under a newer contract has
 * several rows; the caller reads the registered one first.
 */
export const TERMINAL_QUALITY_SQL = `WITH wanted(source, run_id) AS (
  SELECT json_extract(pair.value, '$[0]'), json_extract(pair.value, '$[1]')
    FROM json_each(?1) pair
)
SELECT r.id, r.source, r.run_id, r.provider_outcome, r.coverage_status, r.blocked_code,
       r.registered_at,
       CASE WHEN EXISTS (SELECT 1 FROM ${visibleEvidence.fetchRuns} f WHERE f.id = r.fetch_run_id)
            THEN r.fetch_run_id END AS visible_fetch_run_id,
       (SELECT stage.state FROM collection_run_stages stage
         WHERE stage.collection_run_id = r.id AND stage.stage = 'registered'
         ORDER BY stage.id DESC LIMIT 1) AS registered_stage_state,
       (SELECT stage.failure_code FROM collection_run_stages stage
         WHERE stage.collection_run_id = r.id AND stage.stage = 'registered'
         ORDER BY stage.id DESC LIMIT 1) AS registered_stage_failure_code
  FROM wanted
  CROSS JOIN collection_runs r ON r.source = wanted.source AND r.run_id = wanted.run_id
 ORDER BY r.id`;

export interface UnregisteredQualityRow {
  source: string;
  blocked_code: string | null;
  runs: number;
  newest_seen_at: string;
}

/**
 * Terminals of the collector sources in `?1` (a JSON array) that never
 * registered, counted once per run by the run's newest row: still pending
 * (no code) or refused with a code. A run that registered under any contract
 * version is not counted.
 */
export const UNREGISTERED_QUALITY_SQL = `SELECT r.source, r.blocked_code, COUNT(*) AS runs,
       MAX(r.first_seen_at) AS newest_seen_at
  FROM json_each(?1) wanted
  CROSS JOIN collection_runs r ON r.source = wanted.value
 WHERE r.registered_at IS NULL
   AND r.id = (SELECT MAX(newest.id) FROM collection_runs newest
                WHERE newest.source = r.source AND newest.run_id = r.run_id)
   AND NOT EXISTS (SELECT 1 FROM collection_runs done
                    WHERE done.source = r.source AND done.run_id = r.run_id
                      AND done.registered_at IS NOT NULL)
 GROUP BY r.source, r.blocked_code
 ORDER BY r.source, r.blocked_code`;

// ── sources ───────────────────────────────────────────────────────────────

export interface SourceQualityRow {
  source_id: string;
  fetch_run_id: number | null;
  succeeded: number | null;
  completed_at: string | null;
}

/**
 * Each source's newest visible fetch run, then its fields by primary key. The
 * run view carries correlated columns, so it is only ever read by id here: an
 * outer join to it would make SQLite build the whole view first.
 */
const sourceQualitySql = (where: string, limit: string): string => `WITH latest AS (
  SELECT s.id AS source_id,
         (SELECT newest.id FROM ${visibleEvidence.fetchRuns} newest
           WHERE newest.source_id = s.id ORDER BY newest.id DESC LIMIT 1) AS fetch_run_id
    FROM ${visibleEvidence.sources} s${where}
)
SELECT latest.source_id, latest.fetch_run_id,
       (SELECT CASE WHEN ${successfulFetchRuns.predicate("f")} THEN 1 ELSE 0 END
          FROM ${visibleEvidence.fetchRuns} f WHERE f.id = latest.fetch_run_id) AS succeeded,
       (SELECT f.completed_at FROM ${visibleEvidence.fetchRuns} f
         WHERE f.id = latest.fetch_run_id) AS completed_at
  FROM latest
 ORDER BY latest.source_id${limit}`;

/** Every visible source with its newest visible fetch run. */
export const SOURCE_QUALITY_SQL = sourceQualitySql(
  "",
  `\n LIMIT ${COLLECTION_QUALITY_ROW_BOUND + 1}`,
);

/** One visible source (`?1`) with its newest visible fetch run; no row when it is not visible. */
export const ONE_SOURCE_QUALITY_SQL = sourceQualitySql("\n   WHERE s.id = ?1", "");

// ── cells ─────────────────────────────────────────────────────────────────

export interface CellQualityRow {
  dataset: string | null;
  /** The parser the cell is about; null for captures no parse job or recorded parse names. */
  parser_name: string | null;
  fetch_unit_key: string | null;
  period_kind: string;
  period: string | null;
  period_state: string | null;
  current_rule: string;
  newest_run_id: number;
  newest_captured_at: string;
  newest_run_succeeded: number;
  /** The newest visible run of the producer that made the newest capture (of its unit, for a unit's cell). */
  latest_producer_run_id: number;
  artifacts: number;
  raw_stored: number;
  not_queued: number;
  not_eligible: number;
  published: number;
  pending: number;
  failed: number;
  unpublished: number;
  /** JSON array; `null` entries stand for "none" and are dropped by the caller. */
  failure_codes_json: string;
  unit_failed: number;
  unit_failure_code: string | null;
  incomplete_coverage: number | null;
  coverage_causes_json: string | null;
  current_run_id: number | null;
  current_captured_at: string | null;
}

/**
 * The rule that decides whether `fa`'s capture is current for `parser`: the
 * per-source CTE whose dataset and parser it selects by, a container policy
 * (a `dataset_snapshot_policies` row for the parser and dataset, or the
 * artifact container Mizuho's account list is, matched as
 * `artifactContainerMatch` matches it), or else a published parse of an
 * eligible run. A capture no parser names is placed by its dataset alone.
 */
const CURRENT_RULE = (fa: string, parser: string): string => `CASE
           WHEN ${fa}.dataset = 'globalpass-activity'
             AND coalesce(${parser}, 'global-pass-activity') = 'global-pass-activity'
             THEN 'global-pass-month'
           WHEN ${fa}.dataset = 'statement-page'
             AND coalesce(${parser}, 'vpass-statement-page') = 'vpass-statement-page'
             THEN 'vpass-card-month'
           WHEN ${fa}.dataset = 'credit-ledger'
             AND coalesce(${parser}, 'myjcb-credit-ledger') = 'myjcb-credit-ledger'
             THEN 'myjcb-statement-slot'
           WHEN EXISTS (SELECT 1 FROM snapshot_policies policy
                         WHERE policy.dataset = ${fa}.dataset
                           AND coalesce(${parser}, policy.parser_name) = policy.parser_name)
             OR EXISTS (SELECT 1 FROM artifact_container_policies container_policy
                         WHERE container_policy.source_id = ${fa}.source_id
                           AND container_policy.artifact_key = ${fa}.artifact_key
                           AND container_policy.fetch_unit_key = ${fa}.fetch_unit_key
                           AND (${fa}.dataset IS NULL OR ${fa}.dataset = container_policy.dataset)
                           AND coalesce(${parser}, container_policy.parser_name) = container_policy.parser_name)
             THEN 'container-snapshot'
           ELSE 'published-eligible'
         END`;

/** How the dataset names its period, and the period, by the expressions its snapshot CTE partitions on. */
const PERIOD_KIND = (fa: string): string => `CASE ${fa}.dataset
           WHEN 'globalpass-activity' THEN 'activity-month'
           WHEN 'statement-page' THEN 'statement-month'
           WHEN 'credit-ledger' THEN 'statement-slot'
           ELSE 'latest'
         END`;
const PERIOD = (fa: string): string => `CASE ${fa}.dataset
           WHEN 'globalpass-activity' THEN ${GLOBAL_PASS_MONTH(fa)}
           WHEN 'statement-page' THEN ${VPASS_STATEMENT_MONTH(fa)}
           WHEN 'credit-ledger' THEN ${myjcbStatementSlot(fa)}
         END`;

const CELL_KEY = [
  "dataset",
  "parser_name",
  "fetch_unit_key",
  "period_kind",
  "period",
  "period_state",
  "current_rule",
] as const;

/** The cell key columns, qualified by `alias` when one is given. */
const cellColumns = (alias?: string): string =>
  CELL_KEY.map((column) => (alias ? `${alias}.${column}` : column)).join(", ");

/** The cell key, as a join condition between two relations carrying it. */
const SAME_CELL = (a: string, b: string): string =>
  CELL_KEY.map((column) => `${a}.${column} IS ${b}.${column}`).join(" AND ");

/** The same slot (dataset, unit, period) whatever the parser. */
const SAME_SLOT = (a: string, b: string): string =>
  ["dataset", "fetch_unit_key", "period_kind", "period", "period_state"]
    .map((column) => `${a}.${column} IS ${b}.${column}`)
    .join(" AND ");

/**
 * One page of cells of source `?1`, from offset `?2`. A cell is (dataset,
 * parser, fetch unit, period, MyJCB statement state, currentness rule) over
 * the source's visible artifacts that a parser dataset, a parse job or a
 * recorded parse names. Its newest capture is its newest fetch run by capture
 * time; its current capture is the newest fetch run with a member of the
 * current set. A capture no parser names is its own cell, shown only while it
 * is newer than every parsed capture of its slot.
 */
export const CELL_QUALITY_SQL = `WITH ${completeSnapshotCandidates.ctes},
${GLOBAL_PASS_ACTIVITY_SNAPSHOT_CTES},
${VPASS_STATEMENT_SNAPSHOT_CTES},
${MYJCB_LEDGER_SNAPSHOT_CTES},
cq_artifacts AS MATERIALIZED (
  SELECT fa.id, fa.fetch_run_id, fa.source_id, fa.dataset, fa.artifact_key, fa.fetch_unit_key,
         fa.fetched_at, fa.sha256,
         ${PERIOD_KIND("fa")} AS period_kind,
         ${PERIOD("fa")} AS period,
         CASE WHEN fa.dataset = 'credit-ledger' THEN fa.statement_state END AS period_state
    FROM ${visibleEvidence.fetchArtifacts} fa
   WHERE fa.source_id = ?1
     AND (fa.dataset IS NOT NULL
          OR EXISTS (SELECT 1 FROM observation_parse_jobs job WHERE job.fetch_artifact_id = fa.id)
          OR EXISTS (SELECT 1 FROM parse_runs attempt
                      WHERE attempt.fetch_artifact_id = fa.id AND ${recordedParses.predicate("attempt")}))
), cq_parsers AS MATERIALIZED (
  SELECT fa.id AS artifact_id, job.parser_name
    FROM cq_artifacts fa CROSS JOIN observation_parse_jobs job ON job.fetch_artifact_id = fa.id
  UNION
  SELECT fa.id, attempt.parser_name
    FROM cq_artifacts fa CROSS JOIN parse_runs attempt ON attempt.fetch_artifact_id = fa.id
   WHERE ${recordedParses.predicate("attempt")}
), cq_targets AS MATERIALIZED (
  SELECT targeted.*, ${CURRENT_RULE("targeted", "targeted.parser_name")} AS current_rule
    FROM (
      SELECT fa.*, k.parser_name FROM cq_artifacts fa JOIN cq_parsers k ON k.artifact_id = fa.id
      UNION ALL
      SELECT fa.*, NULL FROM cq_artifacts fa
       WHERE NOT EXISTS (SELECT 1 FROM cq_parsers k WHERE k.artifact_id = fa.id)
    ) targeted
), cq_ordered AS MATERIALIZED (
  SELECT fa.*,
         MAX(fa.fetched_at) OVER capture AS run_captured_at,
         MAX(fa.id) OVER capture AS run_newest_id
    FROM cq_targets fa
  WINDOW capture AS (PARTITION BY ${cellColumns()}, fetch_run_id)
), cq_newest AS MATERIALIZED (
  SELECT * FROM (
    SELECT ordered.*, DENSE_RANK() OVER (
             PARTITION BY ${cellColumns()}
             ORDER BY run_captured_at DESC, run_newest_id DESC
           ) AS capture_rank
      FROM cq_ordered ordered
  ) WHERE capture_rank = 1
), cq_members AS MATERIALIZED (
  SELECT fa.*
    FROM cq_ordered fa
   WHERE CASE fa.current_rule
     WHEN 'global-pass-month'
       THEN fa.id IN (SELECT fetch_artifact_id FROM current_global_pass_snapshots)
     WHEN 'vpass-card-month'
       THEN EXISTS (SELECT 1 FROM current_vpass_snapshots snapshot WHERE ${VPASS_SNAPSHOT_MEMBER})
     WHEN 'myjcb-statement-slot'
       THEN ${MYJCB_LEDGER_MEMBER}
     ELSE EXISTS (
       SELECT 1 FROM parse_runs p
         JOIN ${visibleEvidence.fetchRuns} f ON f.id = fa.fetch_run_id
        WHERE p.fetch_artifact_id = fa.id AND p.parser_name = fa.parser_name
          AND ${activeStateProjection.predicate}
          AND ${completeSnapshotCandidates.currentMember})
   END
     AND fa.parser_name IS NOT NULL
), cq_current AS (
  SELECT * FROM (
    SELECT ${cellColumns()}, fetch_run_id, run_captured_at AS captured_at,
           ROW_NUMBER() OVER (
             PARTITION BY ${cellColumns()}
             ORDER BY run_captured_at DESC, run_newest_id DESC
           ) AS current_rank
      FROM (SELECT DISTINCT ${cellColumns()}, fetch_run_id, run_captured_at, run_newest_id
              FROM cq_members)
  ) WHERE current_rank = 1
), cq_states AS MATERIALIZED (
  SELECT n.id AS artifact_id, n.parser_name,
         CASE
           WHEN EXISTS (SELECT 1 FROM published_parse_runs pub
                         WHERE pub.fetch_artifact_id = n.id AND pub.parser_name = n.parser_name)
             THEN 'published'
           WHEN EXISTS (SELECT 1 FROM observation_parse_jobs job
                         WHERE job.fetch_artifact_id = n.id AND job.parser_name = n.parser_name
                           AND job.status IN ('pending', 'running'))
             THEN 'pending'
           WHEN EXISTS (SELECT 1 FROM observation_parse_jobs job
                         WHERE job.fetch_artifact_id = n.id AND job.parser_name = n.parser_name
                           AND job.status = 'failed'
                           AND coalesce(job.last_error_code, '') <> 'parser_version_retired')
               OR EXISTS (SELECT 1 FROM parse_runs failed
                           WHERE failed.fetch_artifact_id = n.id
                             AND failed.parser_name = n.parser_name AND failed.status = 'error')
             THEN 'failed'
           ELSE 'unpublished'
         END AS state,
         coalesce(
           (SELECT job.last_error_code FROM observation_parse_jobs job
             WHERE job.fetch_artifact_id = n.id AND job.parser_name = n.parser_name
               AND job.status = 'failed'
               AND coalesce(job.last_error_code, '') <> 'parser_version_retired'
             ORDER BY job.created_at_ms DESC, job.parser_version DESC LIMIT 1),
           (SELECT failed.error FROM parse_runs failed
             WHERE failed.fetch_artifact_id = n.id
               AND failed.parser_name = n.parser_name AND failed.status = 'error'
             ORDER BY failed.id DESC LIMIT 1)
         ) AS failure_code
    FROM cq_newest n
   WHERE n.parser_name IS NOT NULL
), cq_latest_units AS MATERIALIZED (
  -- The newest visible run of each producer of the source, and of each unit
  -- it declared: a collector that runs once per card or connection is
  -- compared with its own newest run of that unit, and a unit that failed
  -- with no artifact still counts as captured by that run.
  SELECT latest.tool, unit.unit_key, MAX(latest.id) AS fetch_run_id
    FROM ${visibleEvidence.fetchRuns} latest
    LEFT JOIN fetch_units unit ON unit.fetch_run_id = latest.id
   WHERE latest.source_id = ?1
   GROUP BY latest.tool, unit.unit_key
), cq_latest_runs AS MATERIALIZED (
  SELECT tool, MAX(fetch_run_id) AS fetch_run_id FROM cq_latest_units GROUP BY tool
), cq_cells AS MATERIALIZED (
  SELECT ${cellColumns("n")}, n.fetch_run_id AS newest_run_id,
         MAX(n.run_captured_at) AS newest_captured_at,
         MAX(CASE WHEN ${successfulFetchRuns.predicate("f")} THEN 1 ELSE 0 END) AS newest_run_succeeded,
         MAX(CASE WHEN n.fetch_unit_key IS NULL THEN producer.fetch_run_id
                  ELSE producer_unit.fetch_run_id END) AS latest_producer_run_id,
         COUNT(*) AS artifacts,
         SUM(CASE WHEN ${evidenceExists.predicate("n")} THEN 1 ELSE 0 END) AS raw_stored,
         SUM(CASE WHEN n.parser_name IS NULL
                   AND ${unitParseable.policyPredicate("f", "n")} THEN 1 ELSE 0 END) AS not_queued,
         SUM(CASE WHEN n.parser_name IS NULL
                   AND NOT ${unitParseable.policyPredicate("f", "n")} THEN 1 ELSE 0 END) AS not_eligible,
         SUM(CASE WHEN k.state = 'published' THEN 1 ELSE 0 END) AS published,
         SUM(CASE WHEN k.state = 'pending' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN k.state = 'failed' THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN k.state = 'unpublished' THEN 1 ELSE 0 END) AS unpublished,
         json_group_array(DISTINCT CASE WHEN k.state = 'failed' THEN k.failure_code END) AS failure_codes_json,
         MAX(CASE WHEN (SELECT unit.unit_status FROM observation_fetch_artifact_units unit
                         WHERE unit.fetch_artifact_id = n.id) = 'failed' THEN 1 ELSE 0 END) AS unit_failed,
         MAX((SELECT unit.unit_failure_code FROM observation_fetch_artifact_units unit
               WHERE unit.fetch_artifact_id = n.id)) AS unit_failure_code
    FROM cq_newest n
    JOIN ${visibleEvidence.fetchRuns} f ON f.id = n.fetch_run_id
    LEFT JOIN cq_latest_runs producer ON producer.tool = f.tool
    LEFT JOIN cq_latest_units producer_unit
      ON producer_unit.tool = f.tool AND producer_unit.unit_key = n.fetch_unit_key
    LEFT JOIN cq_states k ON k.artifact_id = n.id AND k.parser_name = n.parser_name
   GROUP BY ${cellColumns("n")}, n.fetch_run_id
), cq_claims AS (
  SELECT ${cellColumns("n")}, COUNT(*) AS incomplete_coverage,
         json_group_array(DISTINCT claim.failure_cause) AS coverage_causes_json
    FROM cq_newest n
    CROSS JOIN published_parse_runs pub
      ON pub.fetch_artifact_id = n.id AND pub.parser_name = n.parser_name
    CROSS JOIN parse_coverage_claims claim ON claim.parse_run_id = pub.parse_run_id
   WHERE claim.completeness <> 'complete' OR claim.membership_complete <> 1
      OR claim.failure_cause IS NOT NULL
   GROUP BY ${cellColumns("n")}
)
SELECT c.dataset, c.parser_name, c.fetch_unit_key, c.period_kind, c.period, c.period_state,
       c.current_rule, c.newest_run_id, c.newest_captured_at, c.newest_run_succeeded,
       c.latest_producer_run_id, c.artifacts, c.raw_stored, c.not_queued, c.not_eligible,
       c.published, c.pending, c.failed, c.unpublished, c.failure_codes_json,
       c.unit_failed, c.unit_failure_code,
       claims.incomplete_coverage, claims.coverage_causes_json,
       cur.fetch_run_id AS current_run_id, cur.captured_at AS current_captured_at
  FROM cq_cells c
  LEFT JOIN cq_claims claims ON ${SAME_CELL("claims", "c")}
  LEFT JOIN cq_current cur ON ${SAME_CELL("cur", "c")}
 WHERE c.parser_name IS NOT NULL
    OR NOT EXISTS (SELECT 1 FROM cq_cells parsed
                    WHERE parsed.parser_name IS NOT NULL AND ${SAME_SLOT("parsed", "c")}
                      AND parsed.newest_captured_at > c.newest_captured_at)
 ORDER BY c.dataset, c.fetch_unit_key, c.period_kind, c.period DESC, c.period_state,
          c.parser_name, c.current_rule
 LIMIT ${PAGE_LIMIT} OFFSET ?2`;
