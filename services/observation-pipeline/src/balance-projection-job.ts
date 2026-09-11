// Builds the latest-balance projection of migration 0030 (review D10/D11,
// addendum A07). Bounded work per invocation, resumable through the
// snapshot's build cursor, and off unless BALANCE_PROJECTION_ENABLED is "1".
//
// The job only writes derived rows. It never touches a Layer A or Layer B
// row, never republishes a parse, and never deletes an observation: a wrong
// projection is repaired by retiring the snapshot and building a new one.
//
// Determinism: the snapshot id is the digest of the declared inputs
// (published high-water parse run, identity release, metric registry
// release, decimal policy, projection release, authority policy, scope
// relation release). The same inputs therefore always produce the same
// snapshot id and the same rows, which is what makes a partially written
// build safe to resume rather than restart.

import { canonicalDigest } from "../../../packages/domain/src/context.ts";
import { snapshotEligibility, type CoverageClaim } from "../../../packages/domain/src/coverage.ts";
import {
  authorityRank,
  BALANCE_PROJECTION_RELEASE,
  buildBalanceProjection,
  createBalanceProjectionReader,
  createD1ObservationReader,
  d1Executor,
  DECIMAL_POLICY_RELEASE,
  ResultLimitExceededError,
  LATEST_IDENTITY_RELEASE,
  organizationSql,
  projectionInputManifest,
  scopeRelationsFromEntityRelations,
  type DerivedScopeRelation,
  type EntityRelationRow,
  type ProjectionCandidate,
  type ProjectionInputs,
  type ProjectionRow,
  type SubjectStatus,
} from "../../../packages/read-model/src/index";
import {
  projectBalanceRows,
  type BalanceProjectionInput,
} from "../../../packages/observation-shared/src/balance-semantics.ts";
import { resolveFinancialProduct } from "../../../packages/observation-shared/src/financial-products.ts";
import {
  validNormalizedDecimal,
  type NormalizedDecimal,
} from "../../../packages/observation-shared/src/normalized-decimal.ts";
import type { BalanceRow } from "../../../packages/observation-shared/src/api-contract.ts";
import type { OutboxOutcome, OutboxRow } from "./decision-outbox.ts";
// The structural D1 binding the shared CORE package uses (U05); a real
// `D1Database` satisfies it, and typing the projection against it is what
// lets `balanceProjectionOutboxProcessor` be an `OutboxProcessor`.
import { runBatch, type D1Like } from "../../../packages/storage-d1/src/d1.ts";

/** The 5,000 candidate bound of the read model; a larger set is refused, never cut. */
const CANDIDATE_LIMIT = 5001;
const CANDIDATE_BOUND = 5000;
/** Rows written per invocation, so one cron tick is bounded whatever the size. */
export const PROJECTION_WRITE_BUDGET = 1000;
const WRITE_CHUNK = 100;
const ORGANIZATION_CHUNK = 500;
const DECIMAL_CHUNK = 80;
/** Coverage claims read per build; enough for every published container dataset. */
const COVERAGE_CLAIM_LIMIT = 5000;
/** Complete snapshots kept besides the newest one, so an open cursor survives a rebuild. */
const RETAINED_SNAPSHOTS = 2;

export interface BalanceProjectionResult {
  enabled: boolean;
  snapshotId: string | null;
  status: "skipped" | "unchanged" | "building" | "complete" | "refused";
  written: number;
  rowCount: number;
  retired: number;
  reasonCode: string | null;
}

/** Reads the operator flag as a plain string; the binding type pins the default. */
function projectionFlagOn(env: Env): boolean {
  const flag: string = env.BALANCE_PROJECTION_ENABLED;
  return flag === "1";
}

const skipped = (reasonCode: string | null): BalanceProjectionResult => ({
  enabled: false,
  snapshotId: null,
  status: "skipped",
  written: 0,
  rowCount: 0,
  retired: 0,
  reasonCode,
});

interface OrganizationFields {
  account_reference: string | null;
  account_target: string | null;
  account_status: SubjectStatus | null;
  raw_locator: string | null;
  parser_name: string | null;
  artifact_id: number | null;
  parse_run_id: number | null;
  dataset: string | null;
  product_extra: string | null;
  product_currency: string | null;
  product_as_of: string | null;
  product_observed_at: string | null;
  source: string | null;
  source_account: string | null;
}

type CandidateRow = BalanceRow & { measureView: "balances" | "summaries"; latestInGroup: boolean };

/**
 * The candidate set: the same latest-balance query the reader serves, taken
 * once for the unfiltered list and once for each measure view, so the
 * projection holds their union and every view selects the same rows it does
 * today. The reader refuses more than 5,000 candidates; the job records that
 * refusal and seals nothing rather than projecting a partial set.
 */
async function readCandidates(db: D1Like): Promise<CandidateRow[] | null> {
  const reader = createD1ObservationReader(db);
  let latest: BalanceRow[];
  let balances: BalanceRow[];
  let summaries: BalanceRow[];
  try {
    [latest, balances, summaries] = await Promise.all([
      reader.listLatestBalances({ offset: 0, limit: CANDIDATE_LIMIT }),
      reader.listLatestBalances({ offset: 0, limit: CANDIDATE_LIMIT, measureView: "balances" }),
      reader.listLatestBalances({ offset: 0, limit: CANDIDATE_LIMIT, measureView: "summaries" }),
    ]);
  } catch (error) {
    // The reader refuses more than 5,000 candidates. That bound is the read
    // contract, so the job reports the refusal and seals nothing rather than
    // projecting a silently partial set.
    if (error instanceof ResultLimitExceededError) return null;
    throw error;
  }
  const latestIds = new Set(latest.map((row) => row.id));
  const summaryIds = new Set(summaries.map((row) => row.id));
  const union = new Map<number, CandidateRow>();
  for (const row of [...balances, ...summaries])
    union.set(row.id, {
      ...row,
      measureView: summaryIds.has(row.id) ? "summaries" : "balances",
      latestInGroup: latestIds.has(row.id),
    });
  if (union.size > CANDIDATE_BOUND) return null;
  return [...union.values()].sort((a, b) => a.id - b.id);
}

async function readOrganization(
  db: D1Like,
  ids: readonly number[],
): Promise<Map<number, OrganizationFields>> {
  const sql = organizationSql("latest");
  const found = new Map<number, OrganizationFields>();
  for (let start = 0; start < ids.length; start += ORGANIZATION_CHUNK) {
    const refs = ids
      .slice(start, start + ORGANIZATION_CHUNK)
      .map((id) => ({ kind: "balance" as const, id }));
    const result = await db
      .prepare(sql)
      .bind(JSON.stringify(refs))
      .all<OrganizationFields & { observation_id: number }>();
    // The organization query returns one row per instrument use; the account
    // and product columns repeat, so the first row of an observation is enough.
    for (const row of result.results)
      if (!found.has(row.observation_id)) found.set(row.observation_id, row);
  }
  return found;
}

interface OriginRow {
  observation_id: number;
  parse_run_id: number;
  fetch_artifact_id: number;
  dataset: string | null;
}

/** Parse, artifact and dataset of each candidate, straight from Layer B. */
async function readOrigins(db: D1Like, ids: readonly number[]): Promise<Map<number, OriginRow>> {
  const found = new Map<number, OriginRow>();
  for (let start = 0; start < ids.length; start += ORGANIZATION_CHUNK) {
    const page = ids.slice(start, start + ORGANIZATION_CHUNK);
    const result = await db
      .prepare(
        `SELECT b.id AS observation_id, b.parse_run_id, p.fetch_artifact_id, fa.dataset
         FROM balance_observations b
         JOIN parse_runs p ON p.id = b.parse_run_id
         JOIN observation_fetch_artifacts fa ON fa.id = p.fetch_artifact_id
         WHERE b.id IN (SELECT value FROM json_each(?1))`,
      )
      .bind(JSON.stringify(page))
      .all<OriginRow>();
    for (const row of result.results) found.set(row.observation_id, row);
  }
  return found;
}

async function readDecimals(
  db: D1Like,
  ids: readonly number[],
): Promise<Map<number, NormalizedDecimal>> {
  const found = new Map<number, NormalizedDecimal>();
  for (let start = 0; start < ids.length; start += DECIMAL_CHUNK) {
    const page = ids.slice(start, start + DECIMAL_CHUNK);
    const result = await db
      .prepare(
        `SELECT observation_id,policy_version AS policyVersion,status,coefficient,scale,basis
         FROM observation_decimal_values
         WHERE kind='balance' AND policy_version='${DECIMAL_POLICY_RELEASE}'
           AND observation_id IN (${page.map(() => "?").join(",")})`,
      )
      .bind(...page)
      .all<NormalizedDecimal & { observation_id: number }>();
    for (const row of result.results) {
      const { observation_id, ...value } = row;
      if (validNormalizedDecimal(value)) found.set(observation_id, value);
    }
  }
  return found;
}

interface CoverageFacts {
  /** Per (source, dataset, unit): the newest published claim and whether it re-observed. */
  groups: Map<string, { parseRunId: number; replacesPrevious: boolean; reasonCode: string }>;
  /** Per parse run: the weakest completeness its own claims declare. */
  byParseRun: Map<number, { completeness: "complete" | "partial" | "unknown"; reasonCode: string }>;
}

const COVERAGE_SQL = `SELECT c.parse_run_id, c.claim_id, c.scope_key, c.mode, c.completeness,
    c.membership_complete, c.observed_count, c.expected_count, c.evidence_refs_json,
    c.policy_version, c.failure_cause, c.absence_meaning,
    fa.source_id, coalesce(fa.dataset,'') AS dataset, coalesce(fa.fetch_unit_key,'') AS unit
  FROM parse_coverage_claims c
  JOIN published_parse_runs pub ON pub.parse_run_id = c.parse_run_id
  JOIN parse_runs p ON p.id = c.parse_run_id
  JOIN observation_fetch_artifacts fa ON fa.id = p.fetch_artifact_id
  ORDER BY c.parse_run_id DESC LIMIT ${COVERAGE_CLAIM_LIMIT}`;

interface CoverageRow {
  parse_run_id: number;
  claim_id: string;
  scope_key: string;
  mode: CoverageClaim["mode"];
  completeness: CoverageClaim["completeness"];
  membership_complete: number;
  observed_count: number;
  expected_count: number | null;
  evidence_refs_json: string;
  policy_version: string;
  failure_cause: CoverageClaim["failureCause"];
  absence_meaning: CoverageClaim["absenceMeaning"];
  source_id: string;
  dataset: string;
  unit: string;
}

async function readCoverage(db: D1Like): Promise<CoverageFacts> {
  const result = await db.prepare(COVERAGE_SQL).all<CoverageRow>();
  const groups: CoverageFacts["groups"] = new Map();
  const byParseRun: CoverageFacts["byParseRun"] = new Map();
  for (const row of result.results) {
    const claim: CoverageClaim = {
      claimId: row.claim_id,
      scopeKey: row.scope_key,
      mode: row.mode,
      completeness: row.completeness,
      membershipComplete: row.membership_complete === 1,
      observedCount: row.observed_count,
      expectedCount: row.expected_count,
      evidenceRefs: [],
      policyVersion: row.policy_version,
      failureCause: row.failure_cause,
      absenceMeaning: row.absence_meaning,
    };
    const eligibility = snapshotEligibility(claim);
    const key = `${row.source_id} ${row.dataset} ${row.unit}`;
    const current = groups.get(key);
    if (!current || row.parse_run_id > current.parseRunId)
      groups.set(key, {
        parseRunId: row.parse_run_id,
        replacesPrevious: eligibility.replacesPrevious,
        reasonCode: eligibility.reasonCode,
      });
    const existing = byParseRun.get(row.parse_run_id);
    const weakest =
      row.completeness === "unknown" || existing?.completeness === "unknown"
        ? "unknown"
        : row.completeness === "partial" || existing?.completeness === "partial"
          ? "partial"
          : "complete";
    byParseRun.set(row.parse_run_id, { completeness: weakest, reasonCode: eligibility.reasonCode });
  }
  return { groups, byParseRun };
}

const RELATION_SQL = `SELECT id, kind, from_ref, to_ref, status, decision_revision_id
  FROM entity_relations
  WHERE kind IN ('same_account','connection_contains','account_has_pocket','statement_covers')
  ORDER BY id LIMIT 20000`;

/**
 * Scope key of one candidate row: the provider coordinates that make it a
 * distinct measurement. It is a projection key, never a cursor value.
 */
function scopeKeyFor(row: CandidateRow, dataset: string | null): string {
  return [
    "bal",
    row.source_id,
    dataset ?? "",
    row.parser.split("@")[0] ?? "",
    row.source_account,
    row.metric,
    row.instrument,
  ].join("");
}

/**
 * The scope adoption reasons about. An identity-resolved account reference is
 * the scope other routes can be related to, so a decision recorded against
 * `source_account:<id>` in migration 0029 lines up with it. Without a
 * reference the scope is provider-local and stays outside every disjointness
 * policy (SC06).
 */
function subjectScopeFor(row: CandidateRow, organization: OrganizationFields | undefined): string {
  const reference = organization?.account_reference;
  return reference
    ? `source_account:${reference}`
    : `source-local:${row.source_id}:${row.source_account}`;
}

function projectionInput(
  row: CandidateRow,
  organization: OrganizationFields | undefined,
): BalanceProjectionInput & { row: CandidateRow } {
  const parserName = row.parser.split("@")[0] ?? "";
  const rawLocator = organization?.raw_locator ?? null;
  const product =
    organization &&
    organization.parse_run_id !== null &&
    organization.artifact_id !== null &&
    rawLocator
      ? resolveFinancialProduct({
          parserName: organization.parser_name ?? parserName,
          asOf: organization.product_as_of ?? null,
          observedAt: organization.product_observed_at ?? null,
          kind: "balance",
          id: row.id,
          parseRunId: organization.parse_run_id,
          artifactId: organization.artifact_id,
          rawLocator,
          sourceId: organization.source ?? row.source_id,
          dataset: organization.dataset ?? "",
          sourceAccount: organization.source_account ?? row.source_account,
          currency: organization.product_currency ?? row.instrument,
          subject: null,
          extra: JSON.parse(organization.product_extra ?? "{}") as unknown,
        })
      : null;
  return {
    row,
    id: row.id,
    sourceId: row.source_id,
    parserName,
    metric: row.metric,
    sourceAccount: row.source_account,
    accountReference: organization?.account_reference ?? null,
    accountTarget: organization?.account_target ?? null,
    currency: row.instrument,
    amountMinor: row.amount_minor,
    amountText: row.amount_text,
    artifactId: organization?.artifact_id ?? null,
    parseRunId: organization?.parse_run_id ?? null,
    rawLocator,
    asOf: row.as_of,
    observedAt: row.observed_at,
    product,
  };
}

/**
 * Candidate assembly. Witness bundling reuses `projectBalanceRows` exactly as
 * the current API does, so the strict same-provider-witness rule (identical
 * provider minor units and identical raw text, one identified product, one
 * parse) is unchanged: this PR does not relax it, and disagreeing evidence
 * stays a conflict rather than being collapsed.
 */
export async function collectCandidates(db: D1Like): Promise<ProjectionCandidate[] | null> {
  const rows = await readCandidates(db);
  if (rows === null) return null;
  const ids = rows.map((row) => row.id);
  const [organization, origins, decimals, coverage] = await Promise.all([
    readOrganization(db, ids),
    readOrigins(db, ids),
    readDecimals(db, ids),
    readCoverage(db),
  ]);
  const groups = projectBalanceRows(
    rows.map((row) => projectionInput(row, organization.get(row.id))),
  );
  const candidates: ProjectionCandidate[] = [];
  for (const group of groups) {
    const row = group.representative.row;
    const fields = organization.get(row.id);
    // Provenance comes from Layer B, not from the identity read: a row the
    // identity pipeline has not organized still has a parse, an artifact and
    // a dataset, and its freshness must not depend on that.
    const origin = origins.get(row.id);
    const dataset = origin?.dataset ?? null;
    const parseRunId = origin?.parse_run_id ?? 0;
    const claim = coverage.byParseRun.get(parseRunId);
    const groupKey = `${row.source_id} ${dataset ?? ""} `;
    const newest = [...coverage.groups.entries()].find(([key]) => key.startsWith(groupKey))?.[1];
    const stale =
      newest !== undefined && !newest.replacesPrevious && newest.parseRunId > parseRunId;
    candidates.push({
      scopeKey: scopeKeyFor(row, dataset),
      subjectScopeKey: subjectScopeFor(row, fields),
      subjectStatus: fields?.account_status ?? "unresolved",
      observationId: row.id,
      parseRunId,
      fetchArtifactId: origin?.fetch_artifact_id ?? 0,
      sourceId: row.source_id,
      sourceAccount: row.source_account,
      parser: row.parser,
      parserName: row.parser.split("@")[0] ?? "",
      metric: row.metric,
      instrument: row.instrument,
      amountMinor: row.amount_minor,
      amountText: row.amount_text,
      asOf: row.as_of,
      observedAt: row.observed_at,
      normalized: decimals.get(row.id) ?? {
        policyVersion: "decimal-v1",
        status: "missing",
        coefficient: null,
        scale: null,
        basis: "none",
      },
      memberEvidence: group.evidence.map((evidence) => ({
        ref: `balance:${String(evidence.id)}`,
        observationId: evidence.id,
        metric: evidence.metric,
      })),
      witnessConflict: group.conflict,
      // A candidate that survived the dataset's snapshot policy already has
      // complete membership under the existing read contract; a stored
      // coverage claim can only weaken that, never invent it.
      coverage: {
        completeness: claim?.completeness ?? "complete",
        reasonCode: claim?.reasonCode ?? null,
      },
      freshness: stale
        ? { state: "stale", reasonCode: newest.reasonCode }
        : { state: "current", reasonCode: null },
      authorityRank: authorityRank(row.source_id),
      measureView: row.measureView,
      latestInGroup: row.latestInGroup,
    });
  }
  // Two witnesses of one measurement collapse into one candidate, so the
  // scope key can repeat only if two provider rows are genuinely the same
  // coordinates; the later one is kept out rather than overwriting silently.
  const unique = new Map<string, ProjectionCandidate>();
  for (const candidate of candidates)
    if (!unique.has(candidate.scopeKey)) unique.set(candidate.scopeKey, candidate);
  return [...unique.values()];
}

/**
 * The declared inputs, read through the same query the evidence browser uses
 * to decide whether the sealed snapshot is still current. One definition, so
 * builder and reader cannot disagree about what "behind" means.
 */
export async function currentProjectionInputs(db: D1Like): Promise<ProjectionInputs> {
  const row = await createBalanceProjectionReader(d1Executor(db)).projectionInputs();
  return {
    publishedHighWaterParseRunId: row.published_high_water,
    visibleFetchRunCount: row.visible_runs,
    visibleFetchRunHighWater: row.visible_high_water,
    adoptedRelationCount: row.adopted_relations,
    decisionRevisionCount: row.decision_revisions,
    identityRelease: LATEST_IDENTITY_RELEASE,
    decimalPolicyRelease: DECIMAL_POLICY_RELEASE,
  };
}

/** The snapshot id the current inputs produce; the same digest the reader compares. */
export async function currentSnapshotId(db: D1Like): Promise<string> {
  return await canonicalDigest(projectionInputManifest(await currentProjectionInputs(db)));
}

function insertRow(db: D1Like, snapshotId: string, row: ProjectionRow) {
  return db
    .prepare(
      `INSERT OR IGNORE INTO current_balance_projection(
        snapshot_id,scope_key,subject_scope_key,row_seq,representative_observation_ref,
        member_evidence_refs_json,member_metrics_json,evidence_count,metric_id,definition_release,
        quantity_coefficient,quantity_scale,value_status,unit_ref,state,reason_code,
        as_of_role,as_of_kind,as_of_value,temporal_json,freshness,freshness_reason,sort_as_of,
        source_id,source_account,metric,instrument,parser,observation_id,parse_run_id,
        fetch_artifact_id,amount_minor,amount_text,as_of,observed_at,measure_view,latest_in_group)
      VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,
        ?23,?24,?25,?26,?27,?28,?29,?30,?31,?32,?33,?34,?35,?36,?37)`,
    )
    .bind(
      snapshotId,
      row.scopeKey,
      row.subjectScopeKey,
      row.rowSeq,
      row.representativeObservationRef,
      JSON.stringify(row.memberEvidence),
      JSON.stringify(row.memberMetrics),
      row.evidenceCount,
      row.metricId,
      row.definitionRelease,
      row.quantityCoefficient,
      row.quantityScale,
      row.valueStatus,
      row.unitRef,
      row.state,
      row.reasonCode,
      row.asOfRole,
      row.asOfKind,
      row.asOfValue,
      JSON.stringify(row.temporal),
      row.freshness,
      row.freshnessReason,
      row.sortAsOf,
      row.sourceId,
      row.sourceAccount,
      row.metric,
      row.instrument,
      row.parser,
      row.observationId,
      row.parseRunId,
      row.fetchArtifactId,
      row.amountMinor,
      row.amountText,
      row.asOf,
      row.observedAt,
      row.measureView,
      row.latestInGroup ? 1 : 0,
    );
}

async function writeRelations(
  db: D1Like,
  relations: readonly DerivedScopeRelation[],
  now: string,
): Promise<void> {
  // Policy relations are reproducible from the policy release recorded in the
  // manifest, so only evidence-backed claims are stored.
  const stored = relations.filter((relation) => relation.source !== "policy").slice(0, 5000);
  for (let start = 0; start < stored.length; start += WRITE_CHUNK) {
    await db.batch(
      stored.slice(start, start + WRITE_CHUNK).map((relation) =>
        db
          .prepare(
            `INSERT INTO scope_relations(from_scope_key,to_scope_key,relation,source,
              decision_revision_id,release,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)
             ON CONFLICT(from_scope_key,to_scope_key,release) DO UPDATE SET
              relation=excluded.relation,source=excluded.source,
              decision_revision_id=excluded.decision_revision_id`,
          )
          .bind(
            relation.fromScopeKey,
            relation.toScopeKey,
            relation.relation,
            relation.source,
            relation.decisionRevisionId,
            relation.release,
            now,
          ),
      ),
    );
  }
}

/** Retire and delete builds older than the retained window; a reader on an
 * older cursor gets `context_expired` rather than a silently different list. */
async function retireOldSnapshots(db: D1Like, keep: string): Promise<number> {
  const stale = await db
    .prepare(
      `SELECT snapshot_id FROM balance_read_snapshots
       WHERE snapshot_id <> ?1 AND status IN ('complete','building')
       ORDER BY created_at DESC, snapshot_id DESC LIMIT 50 OFFSET ${RETAINED_SNAPSHOTS - 1}`,
    )
    .bind(keep)
    .all<{ snapshot_id: string }>();
  for (const row of stale.results) {
    await db
      .prepare("UPDATE balance_read_snapshots SET status='retired' WHERE snapshot_id=?1")
      .bind(row.snapshot_id)
      .run();
    await db
      .prepare("DELETE FROM current_balance_projection WHERE snapshot_id=?1")
      .bind(row.snapshot_id)
      .run();
  }
  return stale.results.length;
}

export interface BalanceProjectionOptions {
  /** Rows written in this invocation; the rest continue on the next tick. */
  writeBudget?: number;
  now?: () => string;
}

/**
 * One bounded step of the projection build. Returns `unchanged` when the
 * newest sealed snapshot already describes the current inputs, `building`
 * when the write budget ran out before the snapshot could be sealed, and
 * `complete` when the snapshot was sealed in this invocation.
 */
export async function runBalanceProjection(
  env: Env,
  options: BalanceProjectionOptions = {},
): Promise<BalanceProjectionResult> {
  if (!projectionFlagOn(env)) return skipped("flag_off");
  const db = env.DB;
  const budget = options.writeBudget ?? PROJECTION_WRITE_BUDGET;
  const now = (options.now ?? (() => new Date().toISOString()))();
  const manifest = projectionInputManifest(await currentProjectionInputs(db));
  const snapshotId = await canonicalDigest(manifest);
  const existing = await db
    .prepare("SELECT status,row_count FROM balance_read_snapshots WHERE snapshot_id=?1")
    .bind(snapshotId)
    .first<{ status: string; row_count: number }>();
  if (existing?.status === "complete")
    return {
      enabled: true,
      snapshotId,
      status: "unchanged",
      written: 0,
      rowCount: existing.row_count,
      retired: 0,
      reasonCode: null,
    };
  if (existing?.status === "retired") return skipped("snapshot_retired");

  const candidates = await collectCandidates(db);
  if (candidates === null)
    return {
      enabled: true,
      snapshotId: null,
      status: "refused",
      written: 0,
      rowCount: 0,
      retired: 0,
      reasonCode: "candidate_limit_exceeded",
    };
  const relationRows = await db.prepare(RELATION_SQL).all<EntityRelationRow>();
  const declared = scopeRelationsFromEntityRelations(relationRows.results);
  const build = buildBalanceProjection(candidates, declared);

  if (!existing)
    await db
      .prepare(
        `INSERT INTO balance_read_snapshots(snapshot_id,created_at,input_manifest_json,status,
          row_count,projection_release,build_cursor,sealed_at)
         VALUES(?1,?2,?3,'building',?4,?5,NULL,NULL)`,
      )
      .bind(
        snapshotId,
        now,
        JSON.stringify(manifest),
        build.rows.length,
        BALANCE_PROJECTION_RELEASE,
      )
      .run();

  const cursor = await db
    .prepare("SELECT build_cursor FROM balance_read_snapshots WHERE snapshot_id=?1")
    .bind(snapshotId)
    .first<{ build_cursor: string | null }>();
  const resumeAt =
    cursor?.build_cursor === null || cursor?.build_cursor === undefined
      ? -1
      : Number(cursor.build_cursor);
  const pending = build.rows.filter((row) => row.rowSeq > resumeAt);
  const slice = pending.slice(0, budget);
  for (let start = 0; start < slice.length; start += WRITE_CHUNK) {
    const chunk = slice.slice(start, start + WRITE_CHUNK);
    await runBatch(
      db,
      chunk.map((row) => insertRow(db, snapshotId, row)),
    );
    await db
      .prepare("UPDATE balance_read_snapshots SET build_cursor=?2 WHERE snapshot_id=?1")
      .bind(snapshotId, String(chunk[chunk.length - 1]!.rowSeq))
      .run();
  }
  if (slice.length < pending.length)
    return {
      enabled: true,
      snapshotId,
      status: "building",
      written: slice.length,
      rowCount: build.rows.length,
      retired: 0,
      reasonCode: null,
    };
  await writeRelations(db, build.relations, now);
  // Sealing is the last statement of the build: a reader that only selects
  // 'complete' snapshots therefore never observes a partial one.
  await db
    .prepare(
      `UPDATE balance_read_snapshots SET status='complete',sealed_at=?2,row_count=?3
       WHERE snapshot_id=?1 AND status='building'`,
    )
    .bind(snapshotId, now, build.rows.length)
    .run();
  const retired = await retireOldSnapshots(db, snapshotId);
  return {
    enabled: true,
    snapshotId,
    status: "complete",
    written: slice.length,
    rowCount: build.rows.length,
    retired,
    reasonCode: null,
  };
}

/**
 * The `balance-projection` decision outbox processor (A09 hands the target to
 * A07 through `dispatchDecisionOutbox`'s `processors` argument).
 *
 * An accepted decision changes which scopes overlap, and therefore which
 * candidates are adopted, without publishing a single new parse. Because the
 * adopted relations are a declared input of the snapshot id, the sealed
 * snapshot is already reported as behind by every reader the moment the
 * decision lands; this processor is what makes the rebuild start on the same
 * tick instead of waiting for the next cron.
 *
 * Idempotent by construction: it recomputes the current snapshot id and does
 * nothing at all when a sealed snapshot already carries it, so a duplicated
 * or out-of-order delivery cannot rebuild twice or undo a finished build. It
 * is bounded like every other invocation, so a decision can never turn one
 * outbox row into an unbounded rebuild.
 */
export function balanceProjectionOutboxProcessor(
  env: Env,
  options: BalanceProjectionOptions = {},
  // The dispatcher's own processor shape (packages/storage-d1 since U05): the
  // structural D1 binding, which a real `D1Database` satisfies, and the outbox
  // row, which this processor does not need — it rebuilds from the current
  // inputs, not from what the row says.
): (db: D1Like, row?: OutboxRow) => Promise<OutboxOutcome> {
  return async (db) => {
    if (!projectionFlagOn(env)) return "skipped_no_projection";
    const wanted = await currentSnapshotId(db);
    const sealed = await db
      .prepare("SELECT status FROM balance_read_snapshots WHERE snapshot_id=?1")
      .bind(wanted)
      .first<{ status: string }>();
    if (sealed?.status === "complete") return "balance_projection_current";
    const result = await runBalanceProjection(env, options);
    return result.status === "complete"
      ? "balance_projection_rebuilt"
      : "balance_projection_rebuilding";
  };
}
