// The current snapshot set as data (ADR 0129, decisions 1 to 3; migration 0108).
//
// Which capture of a container is current used to be recomputed from the whole
// stored history by every read that needed it (`snapshotCtes`, the V Point run
// and MyJCB past-months selections). Here the same sets are computed by a walk
// that starts at each container's newest capture and stops at the first one
// the shipped rules call eligible, so a computation reads the captures newer
// than the current snapshot, not the history. The Processor stores the result
// once per snapshot-input revision (`snapshot_selection_members`), and its
// scheduled reads join those members instead of recomputing them.
//
// What makes it the same set:
//
// - Eligibility is the shipped predicates, evaluated for the walked captures
//   only: the policy's membership rule (`coverageV1Membership`, the confined
//   legacy adapter), the run or unit scope (`unitScopedEligibilitySql`), the
//   publication gate, the required parser version.
// - A container snapshot is a group: the sealed artifacts of one fetch run in
//   one (source, dataset, fetch unit). The shipped rule ranks eligible groups
//   by their newest artifact, then by their greatest artifact id. Walking
//   artifacts newest first, the first artifact whose group is eligible is that
//   group's newest, so its time is the greatest an eligible group has; the
//   groups tied at that time are then ranked by greatest id, as shipped.
// - The partition is the shipped one (`snapshotPartitionUnitSql`), including
//   the legacy unit aliases.
// - The memo holds every sealed artifact of a chosen group, so "this parse is
//   current" becomes "its artifact is a member for its parser", the same rows
//   `CURRENT_SNAPSHOT` matches by run, dataset and unit.
//
// `test/snapshot-memo.test.ts` checks the members against the shipped
// selection on the fixtures, the scaled stores and random stores, and the
// processor's growth test checks that the walk reads what changed, not the
// history.

import {
  ARTIFACT_SNAPSHOT_CONTAINERS,
  artifactContainerMatch,
  artifactContainerPoliciesCte,
  coverageV1Membership,
  legacyWarningCompatMembership,
  snapshotPartitionUnitSql,
  snapshotPoliciesCte,
  unitScopedEligibilitySql,
} from "../../parsers/src/snapshot-query";
import { sha256Hex } from "../../domain/src/context.ts";
import { publishedParses } from "./concepts";
import { MYJCB_PAST_MONTHS_CONNECTION } from "./current-captures";

/** The V Point page parsers whose run is selected whole (current-captures.ts). */
const VPOINT_PARSERS = "'v-point-balance-info', 'v-point-smfg-point', 'v-point-history-page'";
const MYJCB_PAST_MONTHS_PARSER = "myjcb-credit-past-month-balances";

/** A capture's time as the sealed view shows it, in the walk index's order. */
const CAPTURE_MS = (artifact: string): string =>
  `coalesce(${artifact}.fetched_at_ms, ${artifact}.recorded_at_ms)`;

/**
 * The walk index's own condition (migration 0108,
 * `idx_fetch_artifacts_source_dataset_capture`). It always holds, since
 * `recorded_at_ms` is NOT NULL; it is stated so that only the walks can use
 * that partial index and no other statement's plan moves to it.
 */
const WALK_INDEX = (artifact: string): string => `${CAPTURE_MS(artifact)} IS NOT NULL`;

/** The parse of `artifact` (sealed view) by the policy's parser that completes it. */
function completeParse(artifact: string, policy: string): string {
  return `EXISTS (
          SELECT 1 FROM parse_runs complete_parse
          WHERE complete_parse.fetch_artifact_id = ${artifact}.id
            AND complete_parse.parser_name = ${policy}.parser_name
            AND (${policy}.required_version IS NULL OR complete_parse.parser_version = ${policy}.required_version)
            AND ${publishedParses.predicate("complete_parse")}
            AND CASE ${policy}.policy_id
              WHEN 'coverage-v1' THEN ${coverageV1Membership("complete_parse", artifact, policy)}
              ELSE ${legacyWarningCompatMembership("complete_parse", policy)}
            END
        )`;
}

/**
 * The shipped `eligible_snapshots` WHERE for `artifact` of run `run`: the run
 * succeeded, or the dataset is unit-scoped and the artifact's unit succeeded.
 */
const passesScope = (run: string, artifact: string, policy: string): string =>
  `((${run}.status = 'success' AND ${run}.failure_count = 0)
        OR (${policy}.unit_scope = 'unit' AND EXISTS (SELECT 1 FROM observation_fetch_artifact_units artifact_unit
          WHERE artifact_unit.fetch_artifact_id = ${artifact}.id AND artifact_unit.unit_status = 'success')))`;

/**
 * Whether the group of `artifact` (its run, source, dataset and unit) is
 * eligible: no artifact of the group that passes the scope lacks a complete
 * parse. `artifact` passes the scope itself, so the group is not empty.
 */
function groupEligible(run: string, artifact: string, policy: string): string {
  return `NOT EXISTS (
        SELECT 1 FROM observation_fetch_artifacts member
        WHERE member.fetch_run_id = ${artifact}.fetch_run_id
          AND member.source_id = ${artifact}.source_id
          AND member.dataset = ${artifact}.dataset
          AND member.fetch_unit_key IS ${artifact}.fetch_unit_key
          AND ${passesScope(run, "member", policy)}
          AND NOT ${completeParse("member", policy)}
      )`;
}

const partitionOf = (artifact: string, policy: string): string =>
  snapshotPartitionUnitSql({
    sourceId: `${artifact}.source_id`,
    fetchUnitKey: `${artifact}.fetch_unit_key`,
    parserName: `${policy}.parser_name`,
    dataset: `${artifact}.dataset`,
  });

/** One container partition's eligible artifacts, visible through the sealed view. */
function eligibleInPartition(base: string, partition: string): string {
  return `JOIN observation_fetch_artifacts walked ON walked.id = ${base}.id
        JOIN observation_fetch_runs walked_run ON walked_run.id = walked.fetch_run_id
        WHERE ${base}.source_id = ${partition}.source_id AND ${base}.dataset = ${partition}.dataset
          AND ${WALK_INDEX(base)}
          AND ${partitionOf("walked", partition)} IS ${partition}.partition_unit
          AND ${passesScope("walked_run", "walked", partition)}
          AND ${groupEligible("walked_run", "walked", partition)}`;
}

/**
 * Container snapshots (`current_snapshots` of `snapshotCtes`), as member rows:
 * every sealed artifact of each partition's current group.
 */
const CONTAINER_CTES = `container_partitions AS (
  SELECT DISTINCT registered.source_id, policy.parser_name, policy.dataset, policy.required_version,
         policy.policy_id, policy.replaces_previous_on_complete_empty, policy.unit_scope,
         ${snapshotPartitionUnitSql({
           sourceId: "registered.source_id",
           fetchUnitKey: "nullif(registered.unit_key, '')",
           parserName: "policy.parser_name",
           dataset: "policy.dataset",
         })} AS partition_unit
  FROM snapshot_selection_containers registered
  JOIN snapshot_policies policy ON policy.parser_name = registered.parser_name
    AND policy.dataset = registered.dataset_key
  WHERE registered.connection_key = ''
), container_heads AS (
  SELECT container_partitions.*, (
    SELECT ${CAPTURE_MS("candidate")} FROM fetch_artifacts candidate
        ${eligibleInPartition("candidate", "container_partitions")}
    ORDER BY ${CAPTURE_MS("candidate")} DESC, candidate.id DESC LIMIT 1
  ) AS head_ms
  FROM container_partitions
), container_tied_groups AS (
  SELECT DISTINCT container_heads.source_id, container_heads.parser_name, container_heads.dataset,
         container_heads.required_version, container_heads.partition_unit,
         walked.fetch_run_id, walked.fetch_unit_key, (
           SELECT max(member.id) FROM observation_fetch_artifacts member
           JOIN observation_fetch_runs member_run ON member_run.id = member.fetch_run_id
           WHERE member.fetch_run_id = walked.fetch_run_id AND member.source_id = walked.source_id
             AND member.dataset = walked.dataset AND member.fetch_unit_key IS walked.fetch_unit_key
             AND ${passesScope("member_run", "member", "container_heads")}
         ) AS group_artifact_id
  FROM container_heads
  JOIN fetch_artifacts tied ON tied.source_id = container_heads.source_id
    AND tied.dataset = container_heads.dataset
    AND ${CAPTURE_MS("tied")} = container_heads.head_ms
  ${eligibleInPartition("tied", "container_heads")}
), container_groups AS (
  SELECT * FROM (
    SELECT container_tied_groups.*, ROW_NUMBER() OVER (
      PARTITION BY source_id, parser_name, dataset, partition_unit
      ORDER BY group_artifact_id DESC
    ) AS group_rank FROM container_tied_groups
  ) WHERE group_rank = 1
)`;

const CONTAINER_MEMBERS = `SELECT 'container' AS selection, container_groups.parser_name, member.id AS fetch_artifact_id,
       member.fetch_run_id, container_groups.required_version
FROM container_groups
JOIN observation_fetch_artifacts member ON member.fetch_run_id = container_groups.fetch_run_id
  AND member.source_id = container_groups.source_id AND member.dataset = container_groups.dataset
  AND member.fetch_unit_key IS container_groups.fetch_unit_key`;

/**
 * Artifact containers (`current_artifact_containers`): per code-owned
 * container, the newest eligible artifact. Terminal-v1 artifacts may carry no
 * dataset, so the unlabelled captures and the canonical dataset are walked
 * apart, each in index order, and the newer head wins.
 */
function artifactContainerHead(datasetMatch: string): string {
  return `(SELECT candidate.id
      FROM fetch_artifacts candidate
      JOIN observation_fetch_artifacts walked ON walked.id = candidate.id
      JOIN observation_fetch_runs walked_run ON walked_run.id = walked.fetch_run_id
      WHERE candidate.source_id = container_policy.source_id AND ${datasetMatch}
        AND ${WALK_INDEX("candidate")}
        AND ${artifactContainerMatch("walked", "container_policy")}
        AND walked_run.status = 'success' AND walked_run.failure_count = 0
        AND EXISTS (
          SELECT 1 FROM parse_runs complete_parse
          WHERE complete_parse.fetch_artifact_id = walked.id
            AND complete_parse.parser_name = container_policy.parser_name
            AND ${publishedParses.predicate("complete_parse")}
            AND ${coverageV1Membership("complete_parse", "walked", "container_policy")}
        )
      ORDER BY ${CAPTURE_MS("candidate")} DESC, candidate.id DESC LIMIT 1)`;
}

const captureOf = (id: string): string =>
  `(SELECT ${CAPTURE_MS("head")} FROM fetch_artifacts head WHERE head.id = ${id})`;

const ARTIFACT_CONTAINER_MEMBERS = `SELECT 'artifact-container' AS selection, parser_name,
       CASE WHEN unlabelled_head IS NULL THEN labelled_head
            WHEN labelled_head IS NULL THEN unlabelled_head
            WHEN ${captureOf("unlabelled_head")} > ${captureOf("labelled_head")} THEN unlabelled_head
            WHEN ${captureOf("unlabelled_head")} < ${captureOf("labelled_head")} THEN labelled_head
            WHEN unlabelled_head > labelled_head THEN unlabelled_head ELSE labelled_head END AS fetch_artifact_id,
       NULL AS required_version
FROM (SELECT container_policy.parser_name,
             ${artifactContainerHead("candidate.dataset IS NULL")} AS unlabelled_head,
             ${artifactContainerHead("candidate.dataset = container_policy.dataset")} AS labelled_head
      FROM artifact_container_policies container_policy)`;

/** MyJCB past months (`current_myjcb_snapshots`): per connection, the newest active capture. */
const MYJCB_PAST_MONTHS_MEMBERS = `SELECT 'myjcb-past-months' AS selection, '${MYJCB_PAST_MONTHS_PARSER}' AS parser_name,
       (SELECT candidate.id FROM fetch_artifacts candidate
        JOIN observation_fetch_artifacts walked ON walked.id = candidate.id
        JOIN observation_fetch_runs walked_run ON walked_run.id = walked.fetch_run_id
        WHERE candidate.source_id = connection.source_id AND candidate.dataset = 'credit-past-months'
          AND ${WALK_INDEX("candidate")}
          AND ${MYJCB_PAST_MONTHS_CONNECTION("walked")} = connection.connection_key
          AND EXISTS (SELECT 1 FROM parse_runs p WHERE p.fetch_artifact_id = walked.id
                        AND p.parser_name = '${MYJCB_PAST_MONTHS_PARSER}'
                        AND ${publishedParses.predicate("p")})
          AND ${unitScopedEligibilitySql("walked_run", "walked")}
        ORDER BY ${CAPTURE_MS("candidate")} DESC, candidate.id DESC LIMIT 1) AS fetch_artifact_id,
       NULL AS required_version
FROM (SELECT DISTINCT source_id, connection_key FROM snapshot_selection_containers
      WHERE parser_name = '${MYJCB_PAST_MONTHS_PARSER}' AND dataset_key = 'credit-past-months') connection`;

/** The V Point parses of run `run` that `eligible_vpoint_runs` counts (ACTIVE, one of the three parsers). */
const vpointRunParses = (run: string): string =>
  `parse_runs p
          JOIN observation_fetch_artifacts fa ON fa.id = p.fetch_artifact_id
          JOIN observation_fetch_runs f ON f.id = fa.fetch_run_id
          WHERE fa.fetch_run_id = ${run}.id AND p.parser_name IN (${VPOINT_PARSERS})
            AND ${publishedParses.predicate("p")} AND ${unitScopedEligibilitySql("f", "fa")}`;

/**
 * V Point runs (`current_vpoint_runs`): per source, the newest complete run by
 * completion. The terminal reports are walked newest first over every source
 * (`CROSS JOIN` keeps that order: driving from the source's runs instead would
 * test every run it ever had), so a walk reads the runs completed since the
 * current one.
 */
const VPOINT_RUN_MEMBERS = `SELECT 'vpoint-run' AS selection, '' AS parser_name, 0 AS fetch_artifact_id,
       (SELECT walked_run.id FROM fetch_run_reports report
        CROSS JOIN observation_fetch_runs walked_run ON walked_run.id = report.fetch_run_id
        WHERE report.report_kind = 'terminal'
          AND coalesce(report.completed_at_ms, report.fetch_run_id) IS NOT NULL
          AND walked_run.source_id = vpoint_source.source_id
          AND (SELECT COUNT(DISTINCT p.parser_name) FROM ${vpointRunParses("walked_run")}) = 3
          AND (SELECT COUNT(DISTINCT p.fetch_artifact_id) FROM ${vpointRunParses("walked_run")}) = (
            SELECT COUNT(*) FROM observation_fetch_artifacts expected_fa
            WHERE expected_fa.fetch_run_id = walked_run.id
              AND (expected_fa.dataset IN ('balance-info', 'smfg-point')
                OR expected_fa.dataset LIKE 'history-page-%'))
        ORDER BY report.completed_at_ms DESC, report.fetch_run_id DESC LIMIT 1) AS fetch_run_id,
       NULL AS required_version
FROM (SELECT DISTINCT source_id FROM snapshot_selection_containers
      WHERE parser_name IN (${VPOINT_PARSERS})) vpoint_source`;

/**
 * Every member of the current snapshot set, by one statement:
 * `(selection, parser_name, fetch_artifact_id, fetch_run_id, required_version)`.
 * A selection with no current capture contributes no row. Its SQL text is the
 * memo's selection digest, so it carries every code-owned constant it uses.
 */
export const SNAPSHOT_MEMBERS_SQL = `WITH ${snapshotPoliciesCte()}, ${artifactContainerPoliciesCte()}, ${CONTAINER_CTES}
SELECT selection, parser_name, fetch_artifact_id, fetch_run_id, required_version FROM (
${CONTAINER_MEMBERS}
UNION ALL
SELECT selection, parser_name, fetch_artifact_id,
       (SELECT fetch_run_id FROM fetch_artifacts WHERE id = artifact_member.fetch_artifact_id) AS fetch_run_id,
       required_version
FROM (${ARTIFACT_CONTAINER_MEMBERS}) artifact_member WHERE fetch_artifact_id IS NOT NULL
UNION ALL
SELECT selection, parser_name, fetch_artifact_id,
       (SELECT fetch_run_id FROM fetch_artifacts WHERE id = myjcb_member.fetch_artifact_id) AS fetch_run_id,
       required_version
FROM (${MYJCB_PAST_MONTHS_MEMBERS}) myjcb_member WHERE fetch_artifact_id IS NOT NULL
UNION ALL
SELECT selection, parser_name, fetch_artifact_id, fetch_run_id, required_version
FROM (${VPOINT_RUN_MEMBERS}) vpoint_member WHERE fetch_run_id IS NOT NULL
)`;

/** The code-owned containers the artifact-container selection walks (for tests and docs). */
export const WALKED_ARTIFACT_CONTAINERS = ARTIFACT_SNAPSHOT_CONTAINERS;

/**
 * The SHA-256 of `SNAPSHOT_MEMBERS_SQL`, the memo key's selection digest.
 * Pinned so that the statements reading the memo can name it in their text;
 * `test/snapshot-memo.test.ts` fails when the walk changes and this does not,
 * so a build never reads members another build's walk computed.
 */
export const SNAPSHOT_SELECTION_DIGEST =
  "e0b83051e75c8da1536f6947ac9201bc3b324bcf1451423c37730f0172c23abf";

/** Computes the digest `SNAPSHOT_SELECTION_DIGEST` pins (for the test). */
export function snapshotSelectionDigest(): Promise<string> {
  return sha256Hex(SNAPSHOT_MEMBERS_SQL);
}

export interface SnapshotMemberRow {
  selection: "container" | "artifact-container" | "myjcb-past-months" | "vpoint-run";
  parser_name: string;
  fetch_artifact_id: number;
  fetch_run_id: number;
  required_version: string | null;
}

// ── Reading the memo ─────────────────────────────────────────────────────
//
// A scheduled read uses the members of this build's key at the current
// snapshot-input revision and core epoch, named in the statement's own text,
// so one statement reads one key at the revision it reads everything else at.
// When that key does not exist (a write moved the revision since the memo was
// stored, or nothing stored it yet), the statement fails with SQLite's
// "malformed JSON" error the moment it needs a member, instead of reading an
// empty set as "nothing is current". A statement that never needs a member
// returns what it would return with any memo. The Processor then stores the
// memo again and repeats the read, or reads the shipped selection inline
// (services/processor/src/snapshot-memo-step.ts). The app never reads the
// memo: its reads compose the shipped selection, so an MCP read stays a read.

/** This build's key at the current revision and epoch, or NULL. */
const MEMO_KEY = `(SELECT memo_key.id FROM snapshot_selection_keys memo_key
  JOIN core_snapshot_input_revision memo_revision ON memo_revision.id = 1
    AND memo_revision.revision = memo_key.snapshot_revision
  JOIN core_source_revision memo_core ON memo_core.id = 1
    AND memo_core.core_epoch = memo_key.core_epoch
  WHERE memo_key.selection_digest = '${SNAPSHOT_SELECTION_DIGEST}')`;

/** `key_id`: this build's current key, or NULL. */
export const SNAPSHOT_MEMO_KEY_SQL = `SELECT ${MEMO_KEY} AS key_id`;

/** The error a memo-backed statement fails with when the memo is not current. */
export const SNAPSHOT_MEMO_STALE_ERROR = "malformed JSON";

/** Every member of this build's current key, once per statement; fails when there is none. */
export const MEMO_MEMBERS_CTE = `memo_members AS MATERIALIZED (
  SELECT selection, parser_name, fetch_artifact_id, fetch_run_id, required_version
  FROM snapshot_selection_members
  WHERE key_id = (SELECT CASE WHEN current_key.id IS NULL THEN json('snapshot memo not current')
                              ELSE current_key.id END
                  FROM (SELECT ${MEMO_KEY} AS id) current_key)
)`;

/**
 * Storing the memo, in one batch (one transaction): drop the keys of other
 * revisions or epochs with their members, add this build's key for the
 * current revision, and fill it from the walk. Every statement reads the
 * revision it is keyed by inside the same transaction, so the members are the
 * walk's result at that revision. Another build's key for the same revision
 * stays: during a rollout both builds keep their own. `insertKey` binds the
 * time as `?1`; the others take no arguments.
 */
export const STORE_SNAPSHOT_MEMO_SQL = {
  dropStaleMembers: `DELETE FROM snapshot_selection_members WHERE key_id IN (
     SELECT memo_key.id FROM snapshot_selection_keys memo_key
     WHERE NOT EXISTS (SELECT 1 FROM core_snapshot_input_revision memo_revision
                       JOIN core_source_revision memo_core ON memo_core.id = 1
                       WHERE memo_revision.id = 1
                         AND memo_revision.revision = memo_key.snapshot_revision
                         AND memo_core.core_epoch = memo_key.core_epoch))`,
  dropStaleKeys: `DELETE FROM snapshot_selection_keys WHERE NOT EXISTS (
     SELECT 1 FROM core_snapshot_input_revision memo_revision
     JOIN core_source_revision memo_core ON memo_core.id = 1
     WHERE memo_revision.id = 1
       AND memo_revision.revision = snapshot_selection_keys.snapshot_revision
       AND memo_core.core_epoch = snapshot_selection_keys.core_epoch)`,
  insertKey: `INSERT INTO snapshot_selection_keys (snapshot_revision, core_epoch, selection_digest, computed_at_ms)
   SELECT memo_revision.revision, memo_core.core_epoch, '${SNAPSHOT_SELECTION_DIGEST}', ?1
   FROM core_snapshot_input_revision memo_revision
   JOIN core_source_revision memo_core ON memo_core.id = 1
   WHERE memo_revision.id = 1
   ON CONFLICT (snapshot_revision, core_epoch, selection_digest) DO NOTHING`,
  insertMembers: `INSERT OR IGNORE INTO snapshot_selection_members
     (key_id, selection, parser_name, fetch_artifact_id, fetch_run_id, required_version)
   SELECT current_key.id, member.selection, member.parser_name, member.fetch_artifact_id,
          member.fetch_run_id, member.required_version
   FROM (SELECT ${MEMO_KEY} AS id) current_key
   CROSS JOIN (${SNAPSHOT_MEMBERS_SQL}) member
   WHERE current_key.id IS NOT NULL`,
} as const;

/**
 * The memo's stand-in for `completeSnapshotCandidates.ctes`: the policy and
 * artifact-container CTEs the membership predicate names, and the members.
 */
export const MEMO_SNAPSHOT_CTES = `${snapshotPoliciesCte()}, ${artifactContainerPoliciesCte()}, ${MEMO_MEMBERS_CTE}`;

/**
 * The memo's `CURRENT_SNAPSHOT`: the parse `p` of artifact `fa` is current
 * when its parser has no snapshot policy or its artifact is a member for its
 * parser (at the required version), and likewise for an artifact container.
 */
export const MEMO_CURRENT_SNAPSHOT = `((
  NOT EXISTS (SELECT 1 FROM snapshot_policies policy
              WHERE policy.parser_name = p.parser_name)
  OR EXISTS (
    SELECT 1 FROM memo_members snapshot
    WHERE snapshot.selection = 'container'
      AND snapshot.fetch_artifact_id = fa.id
      AND snapshot.parser_name = p.parser_name
      AND (snapshot.required_version IS NULL OR p.parser_version = snapshot.required_version)
  )
) AND (
  NOT EXISTS (SELECT 1 FROM artifact_container_policies container_policy
              WHERE container_policy.parser_name = p.parser_name
                AND ${artifactContainerMatch("fa", "container_policy")})
  OR EXISTS (SELECT 1 FROM memo_members snapshot
             WHERE snapshot.selection = 'artifact-container'
               AND snapshot.fetch_artifact_id = fa.id
               AND snapshot.parser_name = p.parser_name)
))`;

/**
 * `memo_candidate_parses(parse_run_id)`: the published parses whose rows a
 * memo-backed latest-state read can return, so the read starts from them and
 * reaches observations by parse instead of walking every observation. It is a
 * superset, never the filter: the read keeps the shipped predicates, so a
 * candidate that is not current is still dropped. A row passes only when its
 * parse is published (`activeStateProjection`) and either a member admits it
 * or no rule governs its parser:
 *
 * - the parses of member artifacts (container, artifact-container and MyJCB
 *   past-months members) and of every artifact of a member V Point run;
 * - every published parse of a parser that no snapshot policy names, that is
 *   not in `governed` (the parsers the read admits only through a member,
 *   such as the V Point balance parsers for the balance read), and whose
 *   artifact is not an artifact container of its parser. Those parsers'
 *   published rows are all current, so the read returns or ranks them
 *   anyway; ADR 0129's later slices bound that history.
 *
 * The parser names come from the container registry, which holds every
 * (source, parser) with a published parse.
 */
export function memoCandidateParsesCte(governed: readonly string[]): string {
  const governedList = governed.map((name) => `'${name.replaceAll("'", "''")}'`).join(", ");
  return `memo_candidate_parses(parse_run_id) AS MATERIALIZED (
  SELECT pub.parse_run_id FROM memo_members member
  JOIN published_parse_runs pub ON pub.fetch_artifact_id = member.fetch_artifact_id
    AND pub.parser_name = member.parser_name
  WHERE member.selection IN ('container', 'artifact-container', 'myjcb-past-months')
  UNION
  SELECT pub.parse_run_id FROM memo_members member
  CROSS JOIN fetch_artifacts run_artifact ON run_artifact.fetch_run_id = member.fetch_run_id
  CROSS JOIN published_parse_runs pub ON pub.fetch_artifact_id = run_artifact.id
  WHERE member.selection = 'vpoint-run'
  UNION
  SELECT pub.parse_run_id
  FROM (SELECT DISTINCT parser_name FROM snapshot_selection_containers) registered
  CROSS JOIN published_parse_runs pub ON pub.parser_name = registered.parser_name
  WHERE coalesce(pub.parser_name, pub.parse_run_id) IS NOT NULL
    AND registered.parser_name NOT IN (SELECT parser_name FROM snapshot_policies)${
    governed.length > 0
      ? `
    AND registered.parser_name NOT IN (${governedList})`
      : ""
  }
    AND NOT EXISTS (
      SELECT 1 FROM artifact_container_policies container_policy
      JOIN fetch_artifacts container_artifact ON container_artifact.id = pub.fetch_artifact_id
      LEFT JOIN fetch_units container_unit ON container_unit.id = container_artifact.fetch_unit_id
      WHERE container_policy.parser_name = pub.parser_name
        AND container_artifact.source_id = container_policy.source_id
        AND container_artifact.artifact_key = container_policy.artifact_key
        AND container_unit.unit_key = container_policy.fetch_unit_key
        AND (container_artifact.dataset IS NULL OR container_artifact.dataset = container_policy.dataset))
)`;
}

/**
 * The memo's stand-in for `activeStateProjection.observationChain`: the same
 * aliases (`p`, `fa`, `f`), reached from the candidate parses. `CROSS JOIN`
 * keeps that order, so a candidate with no rows in `table` costs one index
 * probe, not the visibility chain.
 */
export const memoObservationChain = (table: string, alias: string): string =>
  `memo_candidate_parses candidate
    CROSS JOIN ${table} ${alias} ON ${alias}.parse_run_id = candidate.parse_run_id
    CROSS JOIN parse_runs p ON p.id = ${alias}.parse_run_id
    CROSS JOIN observation_fetch_artifacts fa ON fa.id = p.fetch_artifact_id
    CROSS JOIN observation_fetch_runs f ON f.id = fa.fetch_run_id`;

/** The memo's `myjcbPastMonthsSnapshotCtes()`: `current_myjcb_snapshots(fetch_artifact_id)`. */
export const MEMO_MYJCB_PAST_MONTHS_CTES = `current_myjcb_snapshots AS (
         SELECT fetch_artifact_id FROM memo_members WHERE selection = 'myjcb-past-months'
       )`;

/** The memo's `ELIGIBLE_VPOINT_RUNS`: `current_vpoint_runs(fetch_run_id)`. */
export const MEMO_VPOINT_RUNS_CTES = `current_vpoint_runs AS (
         SELECT fetch_run_id FROM memo_members WHERE selection = 'vpoint-run'
       )`;
