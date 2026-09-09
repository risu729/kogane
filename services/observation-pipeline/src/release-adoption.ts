// Candidate results, release comparison, adoption and rollback
// (design review D03 / AT65, A04; docs/release-adoption.md).
//
// Three rules hold everywhere in this file.
//
//   1. A candidate result is written like any other parse result and is
//      published like none: `candidateBatch` never touches
//      `published_parse_runs`, so every normal reader keeps showing the
//      adopted run (docs/publication-gate.md step 4).
//   2. Adoption is a pointer move plus an event. Nothing here updates or
//      deletes `parse_runs`, observations, `observation_artifact_metadata` or
//      `superseded_by_parse_run_id`; a rollback is a new event, never an
//      un-write.
//   3. Comparison responses carry counts, ids and raw locators only. No
//      amount, description, account label or raw body ever leaves this module.
import { ACTOR_PATTERN } from "./publication-gate.ts";
import { activeRelease, lookupRelease, RELEASE_ID_PATTERN } from "./releases.ts";

/** The candidate lane and every adoption route are off unless the Worker is
 * configured with `RELEASE_CANDIDATES_ENABLED = "true"`. With the flag absent
 * the pipeline behaves exactly as it did before A04: no candidate run is ever
 * written, and the routes below are not routed at all. */
export function candidatesEnabled(env: unknown): boolean {
  return (
    typeof env === "object" &&
    env !== null &&
    (env as Record<string, unknown>).RELEASE_CANDIDATES_ENABLED === "true"
  );
}

export const SOURCE_PATTERN = /^[a-z0-9-]{1,100}$/u;
export const DATASET_PATTERN = /^[A-Za-z0-9._-]{1,200}$/u;
export const PARSER_NAME_PATTERN = /^[a-z0-9-]{1,100}$/u;
export const COMPARISON_SAMPLE_LIMIT = 50;

export class ReleaseCommandError extends Error {}
const fail = (code: string): never => {
  throw new ReleaseCommandError(code);
};

export interface CandidateInput {
  parseId: number;
  /** The lease this attempt holds; nothing is recorded once it has expired. */
  token: string;
  releaseId: string;
  fingerprint: string;
  createdAt: string;
  now: number;
}

/**
 * The write transaction of a successful candidate parse: mark the run `ok`,
 * mark it a candidate of its release, close the job. No supersession, no
 * publication event, no pointer. The first statement is fenced on the live
 * lease and every later statement depends on its effect, so an expired lease
 * leaves the run `pending` and records no candidate at all.
 */
export function candidateBatch(db: D1Database, input: CandidateInput): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `UPDATE parse_runs SET status='ok' WHERE id=?1 AND status='pending'
          AND EXISTS(SELECT 1 FROM observation_parse_jobs WHERE lease_token=?2 AND status='running' AND lease_until_ms>?3)`,
      )
      .bind(input.parseId, input.token, input.now),
    db
      .prepare(
        `INSERT INTO parse_run_candidates(parse_run_id,release_id,fingerprint,state,created_at)
          SELECT p.id,?2,?3,'candidate',?4 FROM parse_runs p
          WHERE p.id=?1 AND p.status='ok' AND p.superseded_by_parse_run_id IS NULL`,
      )
      .bind(input.parseId, input.releaseId, input.fingerprint, input.createdAt),
    db
      .prepare(
        `UPDATE observation_parse_jobs SET status='done',last_error_code=NULL
          WHERE lease_token=?1 AND EXISTS(SELECT 1 FROM parse_runs WHERE id=?2 AND status='ok')`,
      )
      .bind(input.token, input.parseId),
  ];
}

// ── comparison ───────────────────────────────────────────────────────────

/**
 * The comparison key of the parser output contract: artifact, kind, raw
 * locator and the metric/role the kind defines. The review is explicit that a
 * locator alone must not be assumed unique, so a key that resolves to more
 * than one observation on either side is reported as ambiguous instead of
 * being matched.
 */
const OBSERVATION_ROWS = `SELECT parse_run_id,'transaction' AS kind,id AS observation_id,raw_locator,coalesce(external_id,'') AS role FROM transaction_observations WHERE parse_run_id IN (SELECT run FROM runs)
 UNION ALL SELECT parse_run_id,'balance',id,raw_locator,metric||'/'||instrument FROM balance_observations WHERE parse_run_id IN (SELECT run FROM runs)
 UNION ALL SELECT parse_run_id,'position',id,raw_locator,security_code FROM position_observations WHERE parse_run_id IN (SELECT run FROM runs)
 UNION ALL SELECT parse_run_id,'valuation',id,raw_locator,subject||'/'||metric FROM valuation_observations WHERE parse_run_id IN (SELECT run FROM runs)`;

/** Scope and side CTEs shared by every comparison query. `?1` source,
 * `?2` dataset, `?3` parser name, `?4` candidate release id. */
const COMPARISON_CTES = `WITH scope AS (
  SELECT a.id AS artifact_id,pub.parse_run_id AS base_run,cand.parse_run_id AS candidate_run
  FROM fetch_artifacts a
  LEFT JOIN published_parse_runs pub ON pub.fetch_artifact_id=a.id AND pub.parser_name=?3
  LEFT JOIN release_candidate_runs cand ON cand.fetch_artifact_id=a.id AND cand.release_id=?4
  WHERE a.source_id=?1 AND a.dataset=?2 AND (pub.parse_run_id IS NOT NULL OR cand.parse_run_id IS NOT NULL)
), runs AS (
  SELECT base_run AS run FROM scope WHERE base_run IS NOT NULL
  UNION SELECT candidate_run FROM scope WHERE candidate_run IS NOT NULL
), obs AS (${OBSERVATION_ROWS}
), sided AS (
  SELECT s.artifact_id,CASE WHEN o.parse_run_id=s.base_run THEN 'base' ELSE 'candidate' END AS side,
    o.kind,o.observation_id,o.raw_locator,o.role
  FROM scope s JOIN obs o ON o.parse_run_id=s.base_run OR o.parse_run_id=s.candidate_run
), keyed AS (
  SELECT artifact_id,kind,raw_locator,role,
    count(CASE WHEN side='base' THEN 1 END) AS base_n,
    count(CASE WHEN side='candidate' THEN 1 END) AS candidate_n,
    max(CASE WHEN side='base' THEN observation_id END) AS base_obs,
    max(CASE WHEN side='candidate' THEN observation_id END) AS candidate_obs
  FROM sided GROUP BY artifact_id,kind,raw_locator,role
), valued AS (
  SELECT k.*,
    (SELECT d.status||'|'||coalesce(d.coefficient,'')||'|'||coalesce(d.scale,'')
      FROM observation_decimal_values d
      WHERE d.kind=k.kind AND d.observation_id=k.base_obs AND d.policy_version='decimal-v1') AS base_value,
    (SELECT d.status||'|'||coalesce(d.coefficient,'')||'|'||coalesce(d.scale,'')
      FROM observation_decimal_values d
      WHERE d.kind=k.kind AND d.observation_id=k.candidate_obs AND d.policy_version='decimal-v1') AS candidate_value
  FROM keyed k WHERE k.base_n=1 AND k.candidate_n=1
)`;

export interface ComparisonSummary {
  scope: { sourceId: string; dataset: string; parserName: string };
  baseReleaseId: string | null;
  candidateReleaseId: string;
  artifacts: { base: number; candidate: number; compared: number; candidateOnly: number };
  /** Observation counts per kind on each side. */
  countsByKind: { kind: string; base: number; candidate: number }[];
  locators: { matched: number; baseOnly: number; candidateOnly: number; ambiguous: number };
  /** Exact normalized-value differences over `observation_decimal_values`. */
  values: { compared: number; differing: number; missingOnOneSide: number };
  coverage: { baseClaims: number; candidateClaims: number; differing: number };
  emptyContainers: { baseEmptyCandidateNot: number; candidateEmptyBaseNot: number };
  /** Bounded sample of differing keys: ids and raw locators only. */
  sample: {
    artifactId: number;
    kind: string;
    rawLocator: string;
    role: string;
    difference: "base_only" | "candidate_only" | "ambiguous" | "value";
  }[];
}

export interface CompareRequest {
  source: string;
  dataset: string;
  parser: string;
  releaseId: string;
}

function validateScope(request: CompareRequest): void {
  if (!SOURCE_PATTERN.test(request.source)) fail("release_source_invalid");
  if (!DATASET_PATTERN.test(request.dataset)) fail("release_dataset_invalid");
  if (!PARSER_NAME_PATTERN.test(request.parser)) fail("release_parser_invalid");
  if (!RELEASE_ID_PATTERN.test(request.releaseId)) fail("release_id_invalid");
}

/**
 * Computes the comparison of a candidate release against whatever the dataset
 * currently publishes and appends it to `release_comparisons`. Append-only, so
 * an interrupted comparison leaves either nothing or one complete summary, and
 * re-running it after more candidate runs arrive records a second summary
 * instead of editing the first.
 */
export async function compareReleases(
  db: D1Database,
  request: CompareRequest,
): Promise<ComparisonSummary & { comparisonId: number }> {
  validateScope(request);
  const release = await lookupRelease(db, request.releaseId);
  if (!release) fail("release_not_registered");
  if (release!.parser_name !== request.parser) fail("release_parser_mismatch");
  const bind = [request.source, request.dataset, request.parser, request.releaseId] as const;
  const query = <T>(sql: string) =>
    db
      .prepare(`${COMPARISON_CTES} ${sql}`)
      .bind(...bind)
      .all<T>();

  const artifacts = await db
    .prepare(
      `${COMPARISON_CTES} SELECT
        count(CASE WHEN base_run IS NOT NULL THEN 1 END) AS base,
        count(CASE WHEN candidate_run IS NOT NULL THEN 1 END) AS candidate,
        count(CASE WHEN base_run IS NOT NULL AND candidate_run IS NOT NULL THEN 1 END) AS compared,
        count(CASE WHEN base_run IS NULL THEN 1 END) AS candidate_only FROM scope`,
    )
    .bind(...bind)
    .first<{ base: number; candidate: number; compared: number; candidate_only: number }>();
  const byKind = await query<{ kind: string; base: number; candidate: number }>(
    `SELECT kind,count(CASE WHEN side='base' THEN 1 END) AS base,
      count(CASE WHEN side='candidate' THEN 1 END) AS candidate FROM sided GROUP BY kind ORDER BY kind`,
  );
  const locators = await db
    .prepare(
      `${COMPARISON_CTES} SELECT
        count(CASE WHEN base_n=1 AND candidate_n=1 THEN 1 END) AS matched,
        count(CASE WHEN base_n>0 AND candidate_n=0 THEN 1 END) AS base_only,
        count(CASE WHEN base_n=0 AND candidate_n>0 THEN 1 END) AS candidate_only,
        count(CASE WHEN base_n>1 OR candidate_n>1 THEN 1 END) AS ambiguous FROM keyed`,
    )
    .bind(...bind)
    .first<{ matched: number; base_only: number; candidate_only: number; ambiguous: number }>();
  const values = await db
    .prepare(
      `${COMPARISON_CTES} SELECT count(*) AS compared,
        count(CASE WHEN base_value IS NOT candidate_value THEN 1 END) AS differing,
        count(CASE WHEN (base_value IS NULL)<>(candidate_value IS NULL) THEN 1 END) AS missing_one_side
        FROM valued`,
    )
    .bind(...bind)
    .first<{ compared: number; differing: number; missing_one_side: number }>();
  const coverage = await db
    .prepare(
      `${COMPARISON_CTES}, claims AS (
        SELECT s.artifact_id,CASE WHEN c.parse_run_id=s.base_run THEN 'base' ELSE 'candidate' END AS side,
          c.scope_key,c.mode||'|'||c.completeness||'|'||c.membership_complete||'|'||c.observed_count
            ||'|'||coalesce(c.expected_count,-1)||'|'||c.absence_meaning AS shape
        FROM scope s JOIN parse_coverage_claims c ON c.parse_run_id=s.base_run OR c.parse_run_id=s.candidate_run
      ), paired AS (
        SELECT artifact_id,scope_key,
          max(CASE WHEN side='base' THEN shape END) AS base_shape,
          max(CASE WHEN side='candidate' THEN shape END) AS candidate_shape,
          count(CASE WHEN side='base' THEN 1 END) AS base_n,
          count(CASE WHEN side='candidate' THEN 1 END) AS candidate_n
        FROM claims GROUP BY artifact_id,scope_key
      ) SELECT sum(base_n) AS base_claims,sum(candidate_n) AS candidate_claims,
        count(CASE WHEN base_shape IS NOT candidate_shape THEN 1 END) AS differing FROM paired`,
    )
    .bind(...bind)
    .first<{ base_claims: number | null; candidate_claims: number | null; differing: number }>();
  const empty = await db
    .prepare(
      `${COMPARISON_CTES}, per_artifact AS (
        SELECT s.artifact_id,
          (SELECT count(*) FROM obs o WHERE o.parse_run_id=s.base_run) AS base_rows,
          (SELECT count(*) FROM obs o WHERE o.parse_run_id=s.candidate_run) AS candidate_rows
        FROM scope s WHERE s.base_run IS NOT NULL AND s.candidate_run IS NOT NULL
      ) SELECT count(CASE WHEN base_rows=0 AND candidate_rows>0 THEN 1 END) AS base_empty,
        count(CASE WHEN candidate_rows=0 AND base_rows>0 THEN 1 END) AS candidate_empty FROM per_artifact`,
    )
    .bind(...bind)
    .first<{ base_empty: number; candidate_empty: number }>();
  const sample = await db
    .prepare(
      `${COMPARISON_CTES} SELECT artifact_id,kind,raw_locator,role,
        CASE WHEN base_n>1 OR candidate_n>1 THEN 'ambiguous'
          WHEN candidate_n=0 THEN 'base_only' WHEN base_n=0 THEN 'candidate_only' END AS difference
        FROM keyed WHERE base_n>1 OR candidate_n>1 OR base_n=0 OR candidate_n=0
      UNION ALL
      SELECT artifact_id,kind,raw_locator,role,'value' FROM valued WHERE base_value IS NOT candidate_value
      ORDER BY artifact_id,kind,raw_locator,role LIMIT ${COMPARISON_SAMPLE_LIMIT}`,
    )
    .bind(...bind)
    .all<{
      artifact_id: number;
      kind: string;
      raw_locator: string;
      role: string;
      difference: ComparisonSummary["sample"][number]["difference"];
    }>();
  const baseReleaseId = (await activeRelease(db, {
    sourceId: request.source,
    dataset: request.dataset,
    parserName: request.parser,
  }))?.release_id;
  const summary: ComparisonSummary = {
    scope: { sourceId: request.source, dataset: request.dataset, parserName: request.parser },
    baseReleaseId: baseReleaseId ?? null,
    candidateReleaseId: request.releaseId,
    artifacts: {
      base: artifacts?.base ?? 0,
      candidate: artifacts?.candidate ?? 0,
      compared: artifacts?.compared ?? 0,
      candidateOnly: artifacts?.candidate_only ?? 0,
    },
    countsByKind: byKind.results,
    locators: {
      matched: locators?.matched ?? 0,
      baseOnly: locators?.base_only ?? 0,
      candidateOnly: locators?.candidate_only ?? 0,
      ambiguous: locators?.ambiguous ?? 0,
    },
    values: {
      compared: values?.compared ?? 0,
      differing: values?.differing ?? 0,
      missingOnOneSide: values?.missing_one_side ?? 0,
    },
    coverage: {
      baseClaims: coverage?.base_claims ?? 0,
      candidateClaims: coverage?.candidate_claims ?? 0,
      differing: coverage?.differing ?? 0,
    },
    emptyContainers: {
      baseEmptyCandidateNot: empty?.base_empty ?? 0,
      candidateEmptyBaseNot: empty?.candidate_empty ?? 0,
    },
    sample: sample.results.map((row) => ({
      artifactId: row.artifact_id,
      kind: row.kind,
      rawLocator: row.raw_locator,
      role: row.role,
      difference: row.difference,
    })),
  };
  const now = new Date().toISOString();
  const inserted = await db
    .prepare(
      `INSERT INTO release_comparisons(source_id,dataset,parser_name,base_release_id,candidate_release_id,summary_json,computed_at)
        VALUES(?,?,?,?,?,?,?) RETURNING id`,
    )
    .bind(
      request.source,
      request.dataset,
      request.parser,
      summary.baseReleaseId,
      request.releaseId,
      JSON.stringify(summary),
      now,
    )
    .first<{ id: number }>();
  if (!inserted) fail("release_comparison_insert_failed");
  // A compared candidate is still invisible; the state only records that an
  // operator has something to judge.
  await db
    .prepare(
      `UPDATE parse_run_candidates SET state='compared' WHERE state='candidate' AND parse_run_id IN (
        SELECT parse_run_id FROM release_candidate_runs
        WHERE release_id=?1 AND source_id=?2 AND dataset=?3 AND parser_name=?4)`,
    )
    .bind(request.releaseId, request.source, request.dataset, request.parser)
    .run();
  return { ...summary, comparisonId: inserted!.id };
}

// ── adoption ─────────────────────────────────────────────────────────────

export interface AdoptionRequest {
  source: string;
  dataset: string;
  parser: string;
  releaseId: string;
  /** The release the operator believes is active; null means "none yet". */
  expectedActiveReleaseId: string | null;
  actor: string;
  reason: string;
}

export interface AdoptionResult {
  kind: "activate" | "rollback";
  releaseId: string;
  previousReleaseId: string | null;
  /** False when the release was already active and nothing was written. */
  changed: boolean;
  pointersMoved: number;
  /** Keys the pointer could not leave: a rollback of a first publication. */
  retained: number;
}

function validateAdoption(request: AdoptionRequest): void {
  validateScope(request);
  if (!ACTOR_PATTERN.test(request.actor) || request.actor === "pipeline")
    fail("release_actor_invalid");
  if (request.reason.length < 1 || request.reason.length > 200) fail("release_reason_invalid");
  if (
    request.expectedActiveReleaseId !== null &&
    !RELEASE_ID_PATTERN.test(request.expectedActiveReleaseId)
  )
    fail("release_expected_invalid");
}

/** Fence used by every statement after the pointer move: the batch only has
 * an effect if `active_releases` really names the new release. */
const ACTIVE_FENCE = `EXISTS(SELECT 1 FROM active_releases ar WHERE ar.source_id=?1 AND ar.dataset=?2
  AND ar.parser_name=?3 AND ar.release_id=?4)`;

async function currentRelease(db: D1Database, request: AdoptionRequest) {
  return activeRelease(db, {
    sourceId: request.source,
    dataset: request.dataset,
    parserName: request.parser,
  });
}

/**
 * Moves the dataset onto a candidate release: one D1 batch that flips
 * `active_releases`, publishes every artifact that has a candidate result of
 * that release, records one `activation` publication event per artifact with
 * the run it replaces, marks the candidates adopted and appends the
 * activation event. Conflicts on `expectedActiveReleaseId`; repeating the
 * call once the release is active changes nothing.
 */
export async function activateRelease(
  db: D1Database,
  request: AdoptionRequest,
): Promise<AdoptionResult> {
  validateAdoption(request);
  const release = await lookupRelease(db, request.releaseId);
  if (!release) fail("release_not_registered");
  if (release!.parser_name !== request.parser) fail("release_parser_mismatch");
  const current = await currentRelease(db, request);
  const previousReleaseId = current?.release_id ?? null;
  if (previousReleaseId === request.releaseId)
    return {
      kind: "activate",
      releaseId: request.releaseId,
      previousReleaseId,
      changed: false,
      pointersMoved: 0,
      retained: 0,
    };
  if (previousReleaseId !== request.expectedActiveReleaseId) fail("release_activation_conflict");
  const now = new Date().toISOString();
  const scope = [request.source, request.dataset, request.parser, request.releaseId] as const;
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO active_releases(source_id,dataset,parser_name,release_id,metadata_extractor_release,activated_at)
          VALUES(?1,?2,?3,?4,?5,?6)
          ON CONFLICT(source_id,dataset,parser_name) DO UPDATE SET release_id=excluded.release_id,
            metadata_extractor_release=excluded.metadata_extractor_release,activated_at=excluded.activated_at
          WHERE active_releases.release_id IS ?7`,
      )
      .bind(...scope, release!.metadata_extractor_release, now, request.expectedActiveReleaseId),
    db
      .prepare(
        `INSERT INTO publication_events(fetch_artifact_id,parser_name,previous_parse_run_id,new_parse_run_id,kind,actor,reason,occurred_at)
          SELECT c.fetch_artifact_id,c.parser_name,
            (SELECT x.parse_run_id FROM published_parse_runs x WHERE x.fetch_artifact_id=c.fetch_artifact_id AND x.parser_name=c.parser_name),
            c.parse_run_id,'activation',?5,?6,?7
          FROM release_candidate_runs c
          WHERE c.release_id=?4 AND c.source_id=?1 AND c.dataset=?2 AND c.parser_name=?3
            AND c.state<>'rejected' AND ${ACTIVE_FENCE}
            AND coalesce((SELECT x.parse_run_id FROM published_parse_runs x
              WHERE x.fetch_artifact_id=c.fetch_artifact_id AND x.parser_name=c.parser_name),0)<>c.parse_run_id`,
      )
      .bind(...scope, request.actor, request.reason, now),
    db
      .prepare(
        `INSERT INTO published_parse_runs(fetch_artifact_id,parser_name,parse_run_id,parser_version,published_at,publication_kind,release_id)
          SELECT c.fetch_artifact_id,c.parser_name,c.parse_run_id,c.parser_version,?5,'activation',?4
          FROM release_candidate_runs c
          WHERE c.release_id=?4 AND c.source_id=?1 AND c.dataset=?2 AND c.parser_name=?3
            AND c.state<>'rejected' AND ${ACTIVE_FENCE}
          ON CONFLICT(fetch_artifact_id,parser_name) DO UPDATE SET parse_run_id=excluded.parse_run_id,
            parser_version=excluded.parser_version,published_at=excluded.published_at,
            publication_kind='activation',release_id=excluded.release_id`,
      )
      .bind(...scope, now),
    db
      .prepare(
        `UPDATE parse_run_candidates SET state='adopted' WHERE state<>'rejected' AND parse_run_id IN (
          SELECT parse_run_id FROM release_candidate_runs
          WHERE release_id=?4 AND source_id=?1 AND dataset=?2 AND parser_name=?3) AND ${ACTIVE_FENCE}`,
      )
      .bind(...scope),
    db
      .prepare(
        `INSERT INTO release_activation_events(source_id,dataset,parser_name,previous_release_id,new_release_id,kind,actor,reason,expected_previous,pointers_moved,occurred_at)
          SELECT ?1,?2,?3,?8,?4,'activate',?5,?6,?9,
            (SELECT count(*) FROM published_parse_runs x JOIN fetch_artifacts a ON a.id=x.fetch_artifact_id
              WHERE a.source_id=?1 AND a.dataset=?2 AND x.parser_name=?3 AND x.release_id=?4),?7
          WHERE ${ACTIVE_FENCE}`,
      )
      .bind(
        ...scope,
        request.actor,
        request.reason,
        now,
        previousReleaseId,
        request.expectedActiveReleaseId,
      ),
  ]);
  if (!results[0]?.meta.changes) fail("release_activation_conflict");
  return {
    kind: "activate",
    releaseId: request.releaseId,
    previousReleaseId,
    changed: true,
    pointersMoved: results[2]?.meta.changes ?? 0,
    retained: 0,
  };
}

/**
 * Restores the result set the dataset published before its last activation:
 * for every key the activation moved, the pointer goes back to the run that
 * activation named as `previous_parse_run_id`, with a `rollback` publication
 * event. Nothing is un-written: the candidate run, its observations and every
 * supersession pointer stay exactly as they are. A key whose activation was a
 * first publication has no previous run to restore and is reported as
 * `retained` rather than being removed from the projection, which cannot
 * happen by design.
 */
export async function rollbackRelease(
  db: D1Database,
  request: AdoptionRequest,
): Promise<AdoptionResult> {
  validateAdoption(request);
  const release = await lookupRelease(db, request.releaseId);
  if (!release) fail("release_not_registered");
  if (release!.parser_name !== request.parser) fail("release_parser_mismatch");
  const current = await currentRelease(db, request);
  const previousReleaseId = current?.release_id ?? null;
  if (previousReleaseId === request.releaseId)
    return {
      kind: "rollback",
      releaseId: request.releaseId,
      previousReleaseId,
      changed: false,
      pointersMoved: 0,
      retained: 0,
    };
  if (previousReleaseId !== request.expectedActiveReleaseId) fail("release_activation_conflict");
  const restorable = `SELECT x.fetch_artifact_id,x.parser_name,x.parse_run_id AS current_run,
      (SELECT e.previous_parse_run_id FROM publication_events e
        WHERE e.fetch_artifact_id=x.fetch_artifact_id AND e.parser_name=x.parser_name
          AND e.new_parse_run_id=x.parse_run_id AND e.kind='activation'
        ORDER BY e.id DESC LIMIT 1) AS previous_run
    FROM published_parse_runs x JOIN fetch_artifacts a ON a.id=x.fetch_artifact_id
    WHERE a.source_id=?1 AND a.dataset=?2 AND x.parser_name=?3`;
  const retained = await db
    .prepare(`SELECT count(*) AS n FROM (${restorable}) WHERE previous_run IS NULL`)
    .bind(request.source, request.dataset, request.parser)
    .first<number>("n");
  const now = new Date().toISOString();
  const scope = [request.source, request.dataset, request.parser, request.releaseId] as const;
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO active_releases(source_id,dataset,parser_name,release_id,metadata_extractor_release,activated_at)
          VALUES(?1,?2,?3,?4,?5,?6)
          ON CONFLICT(source_id,dataset,parser_name) DO UPDATE SET release_id=excluded.release_id,
            metadata_extractor_release=excluded.metadata_extractor_release,activated_at=excluded.activated_at
          WHERE active_releases.release_id IS ?7`,
      )
      .bind(...scope, release!.metadata_extractor_release, now, request.expectedActiveReleaseId),
    db
      .prepare(
        `INSERT INTO publication_events(fetch_artifact_id,parser_name,previous_parse_run_id,new_parse_run_id,kind,actor,reason,occurred_at)
          SELECT r.fetch_artifact_id,r.parser_name,r.current_run,r.previous_run,'rollback',?5,?6,?7
          FROM (${restorable}) r WHERE r.previous_run IS NOT NULL AND ${ACTIVE_FENCE}`,
      )
      .bind(...scope, request.actor, request.reason, now),
    db
      .prepare(
        `INSERT INTO published_parse_runs(fetch_artifact_id,parser_name,parse_run_id,parser_version,published_at,publication_kind,release_id)
          SELECT r.fetch_artifact_id,r.parser_name,r.previous_run,p.parser_version,?5,'rollback',
            (SELECT ref.parser_release_id FROM parse_input_references ref WHERE ref.parse_run_id=r.previous_run)
          FROM (${restorable}) r JOIN parse_runs p ON p.id=r.previous_run
          WHERE r.previous_run IS NOT NULL AND ${ACTIVE_FENCE}
          ON CONFLICT(fetch_artifact_id,parser_name) DO UPDATE SET parse_run_id=excluded.parse_run_id,
            parser_version=excluded.parser_version,published_at=excluded.published_at,
            publication_kind='rollback',release_id=excluded.release_id`,
      )
      .bind(...scope, now),
    db
      .prepare(
        `INSERT INTO release_activation_events(source_id,dataset,parser_name,previous_release_id,new_release_id,kind,actor,reason,expected_previous,pointers_moved,occurred_at)
          SELECT ?1,?2,?3,?8,?4,'rollback',?5,?6,?9,
            (SELECT count(*) FROM published_parse_runs x JOIN fetch_artifacts a ON a.id=x.fetch_artifact_id
              WHERE a.source_id=?1 AND a.dataset=?2 AND x.parser_name=?3 AND x.publication_kind='rollback'),?7
          WHERE ${ACTIVE_FENCE}`,
      )
      .bind(
        ...scope,
        request.actor,
        request.reason,
        now,
        previousReleaseId,
        request.expectedActiveReleaseId,
      ),
  ]);
  if (!results[0]?.meta.changes) fail("release_activation_conflict");
  return {
    kind: "rollback",
    releaseId: request.releaseId,
    previousReleaseId,
    changed: true,
    pointersMoved: results[2]?.meta.changes ?? 0,
    retained: retained ?? 0,
  };
}

export interface ReleaseStatus {
  releases: {
    release_id: string;
    parser_name: string;
    semantic_version: string;
    metadata_extractor_release: string;
  }[];
  active: {
    source_id: string;
    dataset: string;
    parser_name: string;
    release_id: string;
    metadata_extractor_release: string;
    activated_at: string;
  }[];
  candidates: { release_id: string; state: string; runs: number }[];
  comparisons: {
    id: number;
    source_id: string;
    dataset: string;
    parser_name: string;
    candidate_release_id: string;
    computed_at: string;
  }[];
  activations: {
    id: number;
    source_id: string;
    dataset: string;
    parser_name: string;
    kind: string;
    previous_release_id: string | null;
    new_release_id: string;
    actor: string;
    pointers_moved: number;
    occurred_at: string;
  }[];
}

/** Identifiers and counts only; the audit view of the adoption machinery. */
export async function releaseStatus(db: D1Database): Promise<ReleaseStatus> {
  const [releases, active, candidates, comparisons, activations] = await db.batch([
    db.prepare(
      "SELECT release_id,parser_name,semantic_version,metadata_extractor_release FROM parser_releases ORDER BY parser_name,semantic_version,release_id",
    ),
    db.prepare(
      "SELECT source_id,dataset,parser_name,release_id,metadata_extractor_release,activated_at FROM active_releases ORDER BY source_id,dataset,parser_name",
    ),
    db.prepare(
      "SELECT release_id,state,count(*) AS runs FROM parse_run_candidates GROUP BY release_id,state ORDER BY release_id,state",
    ),
    db.prepare(
      "SELECT id,source_id,dataset,parser_name,candidate_release_id,computed_at FROM release_comparisons ORDER BY id DESC LIMIT 20",
    ),
    db.prepare(
      "SELECT id,source_id,dataset,parser_name,kind,previous_release_id,new_release_id,actor,pointers_moved,occurred_at FROM release_activation_events ORDER BY id DESC LIMIT 20",
    ),
  ]);
  return {
    releases: (releases?.results ?? []) as ReleaseStatus["releases"],
    active: (active?.results ?? []) as ReleaseStatus["active"],
    candidates: (candidates?.results ?? []) as ReleaseStatus["candidates"],
    comparisons: (comparisons?.results ?? []) as ReleaseStatus["comparisons"],
    activations: (activations?.results ?? []) as ReleaseStatus["activations"],
  };
}
