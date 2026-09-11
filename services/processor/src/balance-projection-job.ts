// Builds the latest-balance projection of migration 0030 (review D10/D11,
// addendum A07; unified plan 05, migration 0038). Bounded work per
// invocation, resumable through the snapshot's build cursor, and off unless
// BALANCE_PROJECTION_ENABLED is "1".
//
// The job only writes derived rows. It never touches a Layer A or Layer B
// row, never republishes a parse, and never deletes an observation: a wrong
// projection is repaired by retiring the snapshot and building a new one.
//
// Determinism. A build fixes its input once, at a CORE revision that did not
// move while it was reading (05 §3), stores the canonical bytes of that input
// in the DATA bucket, and resumes from those bytes rather than from CORE's
// current state. The snapshot id is
// `sha256(inputContentDigest ‖ projectionBuildDigest ‖ contractVersion)`
// (05 §4): the content digest says what was read, the build digest says what
// this code would make of it. `sourceRevision` detects and orders change; it
// is never used as the identity, because a write that changes nothing the
// projection reads still moves it.
//
// Completion. A snapshot is sealed and the active pointer switched in one
// batch, under the writer's fence, after the written rows have been verified
// against the build. Only then may the CORE side of a decision be reported
// complete (05 §5); a lost response converges on the next tick by re-reading
// the active pointer instead of rebuilding.

import { canonicalJson, sha256Hex } from "../../../packages/domain/src/context.ts";
import { snapshotEligibility, type CoverageClaim } from "../../../packages/domain/src/coverage.ts";
import {
  authorityRank,
  BALANCE_PROJECTION_RELEASE,
  buildBalanceProjection,
  CORE_READ_INSTANCE_ID,
  createBalanceProjectionReader,
  createD1ObservationReader,
  d1Executor,
  DECIMAL_POLICY_RELEASE,
  ResultLimitExceededError,
  LATEST_IDENTITY_RELEASE,
  organizationSql,
  projectionBuildDigest,
  projectionInputManifest,
  scopeRelationsFromEntityRelations,
  snapshotIdentity,
  type CoreRevisionRow,
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
import {
  blockedOutcome,
  completedOutcome,
  pendingOutcome,
  retryableOutcome,
  type OutboxProcessor,
} from "./decision-outbox.ts";
// The structural D1 binding the shared CORE package uses (U05); a real
// `D1Database` satisfies it, and typing the projection against it is what
// lets `balanceProjectionOutboxProcessor` be an `OutboxProcessor`.
import {
  runBatch,
  type D1Like,
  type D1StatementLike,
} from "../../../packages/storage-d1/src/d1.ts";
import {
  captureDigest,
  fixedInput,
  insertInputRecord,
  loadProjectionInput,
  readInputRecord,
  restoreProjectionInput,
  storeProjectionInput,
  type CapturedProjectionInput,
  type FixedProjectionInput,
  type ProjectionInputStore,
} from "./projection-input.ts";
import {
  readProjectionEnabled,
  readPublishedSnapshotAt,
  runReadProjection,
} from "./read-projection.ts";

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
/** Declared relations read per build, and derived relations stored per build. */
const RELATION_ROW_BOUND = 5000;
const RELATION_WRITE_BOUND = 5000;
/** Optimistic input captures before the job yields and waits for a quiet tick. */
const CAPTURE_ATTEMPTS = 3;
/** How long one invocation holds the build. Shorter than the cron period, so a
 * writer that crashed is taken over on the next tick rather than blocking. */
const WRITER_LEASE_MS = 60_000;
/** Complete snapshots kept besides the newest one, so an open cursor survives a rebuild. */
const RETAINED_SNAPSHOTS = 2;

/**
 * A declared budget was exceeded. Every one of these is fail-closed: the build
 * refuses and seals nothing rather than sealing a truncated set that looks
 * complete (05 §3). The code travels to the outbox as a `blocked` reason.
 */
export class ProjectionBudgetError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "ProjectionBudgetError";
    this.code = code;
  }
}

export interface BalanceProjectionResult {
  enabled: boolean;
  snapshotId: string | null;
  /**
   * `refused` is a fail-closed budget refusal, `retryable` a transient failure
   * (a lost writer fence, an unreadable stored input) and `pending` a context
   * that would not hold still long enough to be captured. None of them is a
   * completed build.
   */
  status: "skipped" | "unchanged" | "building" | "complete" | "refused" | "retryable" | "pending";
  written: number;
  rowCount: number;
  retired: number;
  reasonCode: string | null;
  /** The CORE revision the fixed input was captured at. */
  sourceRevision: number | null;
  /** Content digest of the fixed input; the first half of the snapshot id. */
  inputDigest: string | null;
  /** Whether the active pointer publishes this snapshot. */
  active: boolean;
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
  sourceRevision: null,
  inputDigest: null,
  active: false,
});

/** A build that did not finish, with the safe code that says why. */
const halted = (
  status: BalanceProjectionResult["status"],
  reasonCode: string,
  snapshotId: string | null = null,
  written = 0,
): BalanceProjectionResult => ({
  enabled: true,
  snapshotId,
  status,
  written,
  rowCount: 0,
  retired: 0,
  reasonCode,
  sourceRevision: null,
  inputDigest: null,
  active: false,
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
async function readCandidates(db: D1Like): Promise<CandidateRow[]> {
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
    if (error instanceof ResultLimitExceededError)
      throw new ProjectionBudgetError("candidate_limit_exceeded");
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
  if (union.size > CANDIDATE_BOUND) throw new ProjectionBudgetError("candidate_limit_exceeded");
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
  ORDER BY c.parse_run_id DESC LIMIT ${COVERAGE_CLAIM_LIMIT + 1}`;

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
  // One row over the bound: a supporting set that does not fit is refused
  // like the candidate set, never silently cut to size (05 §3).
  if (result.results.length > COVERAGE_CLAIM_LIMIT)
    throw new ProjectionBudgetError("coverage_claim_budget_exceeded");
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
  ORDER BY id LIMIT ${RELATION_ROW_BOUND + 1}`;

/** The declared relations of one build; over the bound is a refusal, not a cut. */
async function readRelationRows(db: D1Like): Promise<EntityRelationRow[]> {
  const rows = await db.prepare(RELATION_SQL).all<EntityRelationRow>();
  if (rows.results.length > RELATION_ROW_BOUND)
    throw new ProjectionBudgetError("relation_budget_exceeded");
  return rows.results;
}

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
export async function collectCandidates(db: D1Like): Promise<ProjectionCandidate[]> {
  const rows = await readCandidates(db);
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
 * The operational summary of the store. Since migration 0038 this is not the
 * snapshot identity and not the change detector: `max(parse_run_id)` cannot
 * tell that an artifact's adopted parse moved from 100 to 150 while an
 * unrelated run 900 exists (01 §5). It is kept because it is cheap to log and
 * because `publishedHighWaterParseRunId` still pins a snapshot's history
 * window.
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

/** The CORE change detector; one read, one definition for builder and reader. */
export async function currentCoreRevision(db: D1Like): Promise<CoreRevisionRow> {
  return await createBalanceProjectionReader(d1Executor(db)).coreRevision();
}

export type CaptureOutcome =
  | { ok: true; captured: CapturedProjectionInput }
  | { ok: false; status: "refused" | "pending"; code: string };

/**
 * Fix the input of one build (05 §3).
 *
 *     read revision r0
 *       -> read candidates, relations and the declared releases
 *     read revision r1
 *     r0 == r1  -> this is the input
 *     r0 != r1  -> discard it and retry, bounded
 *
 * A mixture of two contexts is never accepted: what was read before a
 * publication and what was read after it do not go into one snapshot. After
 * `CAPTURE_ATTEMPTS` unstable reads the job yields `pending` and waits for a
 * quieter tick rather than spinning.
 */
export async function captureFixedInput(
  db: D1Like,
  options: BalanceProjectionOptions = {},
): Promise<CaptureOutcome> {
  const now = options.now ?? (() => new Date().toISOString());
  for (let attempt = 1; attempt <= CAPTURE_ATTEMPTS; attempt += 1) {
    const before = await currentCoreRevision(db);
    const capturedAt = now();
    const manifest = projectionInputManifest(await currentProjectionInputs(db));
    let candidates: ProjectionCandidate[];
    let relations: EntityRelationRow[];
    try {
      candidates = await collectCandidates(db);
      relations = await readRelationRows(db);
    } catch (error) {
      if (error instanceof ProjectionBudgetError)
        return { ok: false, status: "refused", code: error.code };
      throw error;
    }
    // Test seam: a writer that lands between the two revision reads.
    await options.duringCapture?.(attempt);
    const after = await currentCoreRevision(db);
    if (
      after.source_revision !== before.source_revision ||
      after.visibility_revision !== before.visibility_revision ||
      after.core_epoch !== before.core_epoch
    )
      continue;
    return {
      ok: true,
      captured: await captureDigest(
        fixedInput({
          sourceRevision: before.source_revision,
          visibilityRevision: before.visibility_revision,
          coreEpoch: before.core_epoch,
          capturedAt,
          content: { manifest, candidates, relations },
        }),
      ),
    };
  }
  return { ok: false, status: "pending", code: "input_capture_unstable" };
}

/**
 * The snapshot id a fresh capture would produce. Only the flag-off and
 * diagnostic paths need it: a build takes the id from the input it fixed.
 */
export async function currentSnapshotId(db: D1Like): Promise<string> {
  const capture = await captureFixedInput(db);
  if (!capture.ok) throw new ProjectionBudgetError(capture.code);
  return await snapshotIdentity(capture.captured.digest, await projectionBuildDigest());
}

/**
 * One projection row. `row_digest` is what makes a re-sent chunk decidable:
 * the same content is an ignored duplicate, different content for a row that
 * already exists raises `projection chunk conflict` in the trigger of
 * migration 0038 instead of being hidden by OR IGNORE (05 §4).
 */
function insertRow(db: D1Like, snapshotId: string, row: ProjectionRow, digest: string) {
  return db
    .prepare(
      `INSERT OR IGNORE INTO current_balance_projection(
        snapshot_id,scope_key,subject_scope_key,row_seq,representative_observation_ref,
        member_evidence_refs_json,member_metrics_json,evidence_count,metric_id,definition_release,
        quantity_coefficient,quantity_scale,value_status,unit_ref,state,reason_code,
        as_of_role,as_of_kind,as_of_value,temporal_json,freshness,freshness_reason,sort_as_of,
        source_id,source_account,metric,instrument,parser,observation_id,parse_run_id,
        fetch_artifact_id,amount_minor,amount_text,as_of,observed_at,measure_view,latest_in_group,
        row_digest)
      VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,
        ?23,?24,?25,?26,?27,?28,?29,?30,?31,?32,?33,?34,?35,?36,?37,?38)`,
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
      digest,
    );
}

/** Content digest of every row of a build, keyed by its position. */
async function rowDigests(rows: readonly ProjectionRow[]): Promise<Map<number, string>> {
  const digests = new Map<number, string>();
  for (const row of rows) digests.set(row.rowSeq, await sha256Hex(canonicalJson(row)));
  return digests;
}

/**
 * What was written is what the build produced: the same number of rows, a
 * dense sequence in the contract order, and the same content digest for every
 * position (05 §5). A build that cannot prove this does not seal.
 */
async function writtenRowsMatch(
  db: D1Like,
  snapshotId: string,
  rows: readonly ProjectionRow[],
  digests: ReadonlyMap<number, string>,
): Promise<boolean> {
  const stored = await db
    .prepare(
      `SELECT row_seq,row_digest FROM current_balance_projection
       WHERE snapshot_id=?1 ORDER BY row_seq`,
    )
    .bind(snapshotId)
    .all<{ row_seq: number; row_digest: string | null }>();
  if (stored.results.length !== rows.length) return false;
  return stored.results.every(
    (row, index) => row.row_seq === index && row.row_digest === digests.get(index),
  );
}

async function writeRelations(
  db: D1Like,
  relations: readonly DerivedScopeRelation[],
  now: string,
): Promise<void> {
  // Policy relations are reproducible from the policy release recorded in the
  // manifest, so only evidence-backed claims are stored.
  const stored = relations.filter((relation) => relation.source !== "policy");
  if (stored.length > RELATION_WRITE_BOUND)
    throw new ProjectionBudgetError("scope_relation_budget_exceeded");
  for (let start = 0; start < stored.length; start += WRITE_CHUNK) {
    await runBatch(
      db,
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
async function retireOldSnapshots(db: D1Like, keep: string, now: string): Promise<number> {
  const stale = await db
    .prepare(
      `SELECT snapshot_id FROM balance_read_snapshots
       WHERE snapshot_id <> ?1 AND status IN ('complete','building')
         AND snapshot_id <> coalesce((SELECT p.snapshot_id FROM balance_snapshot_pointer p
           WHERE p.id=1),'')
       ORDER BY created_at DESC, snapshot_id DESC LIMIT 50 OFFSET ${RETAINED_SNAPSHOTS - 1}`,
    )
    .bind(keep)
    .all<{ snapshot_id: string }>();
  for (const row of stale.results) {
    // A retired build keeps a sealing time: the 0030 check pairs 'building'
    // with a null `sealed_at`, so an abandoned build needs one to leave.
    await db
      .prepare(
        `UPDATE balance_read_snapshots SET status='retired',sealed_at=coalesce(sealed_at,?2)
         WHERE snapshot_id=?1`,
      )
      .bind(row.snapshot_id, now)
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
  /** The writer's fence token; a fresh one per invocation unless a test pins it. */
  writerToken?: string;
  /**
   * Test seam only: a concurrent writer landing between the two revision reads
   * of the capture protocol. Production never passes it.
   */
  duringCapture?: (attempt: number) => Promise<void>;
  /**
   * Test seam only: the build digest of a different deployment, so a test can
   * show the same input building a new snapshot after a code change. The
   * production build digest is `projectionBuildDigest()`.
   */
  buildDigest?: string;
}

/**
 * The DATA bucket of the shared collection layout (03 §1) when the deployment
 * binds one. The pipeline's `EVIDENCE` binding names the same physical bucket
 * today, so a configuration without the new binding stores the same bytes in
 * the same place instead of losing the input.
 */
function projectionInputBucket(env: Env): ProjectionInputStore {
  const bound = (env as unknown as { DATA?: ProjectionInputStore }).DATA;
  return bound ?? (env.EVIDENCE as unknown as ProjectionInputStore);
}

interface FixedBuild {
  snapshotId: string;
  inputDigest: string;
  input: FixedProjectionInput;
}

type ResumeOutcome =
  | { kind: "none" }
  | { kind: "build"; build: FixedBuild }
  | { kind: "failure"; code: string };

/**
 * Continue the oldest unfinished build from the input it fixed. This is the
 * whole point of the input record: an invocation that re-read CORE here would
 * write rows from a context the earlier invocations never saw (05 §3, G2-05).
 */
async function resumeFixedBuild(
  db: D1Like,
  store: ProjectionInputStore,
  now: string,
): Promise<ResumeOutcome> {
  const building = await db
    .prepare(
      `SELECT snapshot_id,input_digest FROM balance_read_snapshots WHERE status='building'
       ORDER BY created_at, snapshot_id LIMIT 1`,
    )
    .first<{ snapshot_id: string; input_digest: string | null }>();
  if (!building) return { kind: "none" };
  const record =
    building.input_digest === null ? null : await readInputRecord(db, building.input_digest);
  if (!record) {
    // A build started before migration 0038 has no fixed input and cannot be
    // resumed without re-reading CORE. It is retired; the next tick captures a
    // fresh input and builds a new snapshot from it.
    await db
      .prepare(
        `UPDATE balance_read_snapshots SET status='retired',sealed_at=coalesce(sealed_at,?2)
         WHERE snapshot_id=?1 AND status='building'`,
      )
      .bind(building.snapshot_id, now)
      .run();
    await db
      .prepare("DELETE FROM current_balance_projection WHERE snapshot_id=?1")
      .bind(building.snapshot_id)
      .run();
    return { kind: "failure", code: "projection_input_missing" };
  }
  const input = await loadProjectionInput(store, record);
  if (!input) return { kind: "failure", code: "projection_input_unreadable" };
  return {
    kind: "build",
    build: { snapshotId: building.snapshot_id, inputDigest: record.input_digest, input },
  };
}

/**
 * Switch the active pointer to a snapshot, if it is at least as current as the
 * one published now. A build that finishes late is complete but not published:
 * the read model never moves back to an older context (05 §5). Exported so the
 * test that proves it runs the statement the job runs.
 *
 * The statement only names a complete snapshot. In the seal batch it follows
 * the guarded seal, so a writer whose lease was taken between the last chunk
 * and the seal matches no row here either — the batch then reports the lost
 * fence instead of the pointer trigger aborting it. The trigger stays as the
 * defence against a writer that bypasses this statement.
 */
export function activePointerStatement(
  db: D1Like,
  snapshotId: string,
  sourceRevision: number,
  coreEpoch: string,
  now: string,
): D1StatementLike {
  return db
    .prepare(
      `INSERT INTO balance_snapshot_pointer(id,snapshot_id,source_revision,read_instance_id,
        core_epoch,switched_at)
       SELECT 1,?1,?2,?3,?4,?5 WHERE EXISTS(SELECT 1 FROM balance_read_snapshots s
         WHERE s.snapshot_id=?1 AND s.status='complete')
       ON CONFLICT(id) DO UPDATE SET snapshot_id=excluded.snapshot_id,
         source_revision=excluded.source_revision,read_instance_id=excluded.read_instance_id,
         core_epoch=excluded.core_epoch,switched_at=excluded.switched_at
       WHERE excluded.source_revision>=balance_snapshot_pointer.source_revision`,
    )
    .bind(snapshotId, sourceRevision, CORE_READ_INSTANCE_ID, coreEpoch, now);
}

/**
 * The snapshot the read model publishes, when it covers `required`, whichever
 * database publishes it. With the READ flag on the answer comes from the READ
 * pointer under this CORE epoch; a restored CORE is another context, so its
 * revision numbers alone never complete a decision (05 §2, G3-02).
 */
async function publishedSnapshotFor(
  env: Env,
  db: D1Like,
  required: number | null,
): Promise<string | null> {
  if (!readProjectionEnabled(env)) return await activeSnapshotAt(db, required);
  const revision = await currentCoreRevision(db);
  return await readPublishedSnapshotAt(env, required, revision.core_epoch);
}

/** The snapshot the CORE read model publishes, when it covers `required`. */
async function activeSnapshotAt(db: D1Like, required: number | null): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT p.snapshot_id AS snapshot_id FROM balance_snapshot_pointer p
       JOIN balance_read_snapshots s ON s.snapshot_id=p.snapshot_id AND s.status='complete'
       WHERE p.id=1 AND (?1 IS NULL OR p.source_revision>=?1)`,
    )
    .bind(required)
    .first<{ snapshot_id: string }>();
  return row?.snapshot_id ?? null;
}

/**
 * One bounded step of the projection build.
 *
 * `unchanged` means the fixed input digests to a snapshot that is already
 * sealed, `building` that the write budget ran out, `complete` that the
 * snapshot was sealed and the active pointer considered in this invocation.
 * `refused`, `retryable` and `pending` are the three ways a step declines to
 * produce a snapshot at all; none of them is ever reported as completion.
 */
export async function runBalanceProjection(
  env: Env,
  options: BalanceProjectionOptions = {},
): Promise<BalanceProjectionResult> {
  try {
    return await projectionStep(env, options);
  } catch (error) {
    // A declared budget was exceeded: seal nothing, say which budget, and let
    // an operator decide. Never a truncated set presented as complete.
    if (error instanceof ProjectionBudgetError) return halted("refused", error.code);
    throw error;
  }
}

async function projectionStep(
  env: Env,
  options: BalanceProjectionOptions,
): Promise<BalanceProjectionResult> {
  if (!projectionFlagOn(env)) return skipped("flag_off");
  const db = env.DB;
  const store = projectionInputBucket(env);
  const budget = options.writeBudget ?? PROJECTION_WRITE_BUDGET;
  const now = (options.now ?? (() => new Date().toISOString()))();
  const lease = options.writerToken ?? crypto.randomUUID();

  // The READ database is the target when the deployment says so (U11). The
  // capture protocol, the input digest, the budgets and the four outcomes are
  // the ones below; only the rows land in another physical database, so
  // turning the flag off puts this deployment back on the CORE tables.
  if (readProjectionEnabled(env))
    return await runReadProjection(
      env,
      {
        capture: captureFixedInput,
        buildDigest: async () => options.buildDigest ?? (await projectionBuildDigest()),
      },
      options,
      store,
      budget,
    );

  // 1. An unfinished build continues from its own input, never from CORE.
  const resumed = await resumeFixedBuild(db, store, now);
  if (resumed.kind === "failure") return halted("retryable", resumed.code);
  let build: FixedBuild;
  if (resumed.kind === "build") build = resumed.build;
  else {
    const capture = await captureFixedInput(db, options);
    if (!capture.ok) return halted(capture.status, capture.code);
    const snapshotId = await snapshotIdentity(
      capture.captured.digest,
      options.buildDigest ?? (await projectionBuildDigest()),
    );
    const existing = await db
      .prepare("SELECT status,row_count FROM balance_read_snapshots WHERE snapshot_id=?1")
      .bind(snapshotId)
      .first<{ status: string; row_count: number }>();
    if (existing?.status === "complete") {
      // The content is unchanged, so this is the same snapshot; what moved is
      // how current it is. The pointer carries that watermark, so a decision
      // that did not change a single row still reaches "the published snapshot
      // covers your revision" instead of waiting for a rebuild that has
      // nothing to build (05 §5).
      const refreshed = await activePointerStatement(
        db,
        snapshotId,
        capture.captured.input.sourceRevision,
        capture.captured.input.coreEpoch,
        now,
      ).run();
      return {
        enabled: true,
        snapshotId,
        status: "unchanged",
        written: 0,
        rowCount: existing.row_count,
        retired: 0,
        reasonCode: null,
        sourceRevision: capture.captured.input.sourceRevision,
        inputDigest: capture.captured.digest,
        active: refreshed.meta.changes === 1 || (await activeSnapshotAt(db, null)) === snapshotId,
      };
    }
    if (existing?.status === "retired") return skipped("snapshot_retired");
    if (existing?.status === "building")
      return halted("retryable", "projection_build_in_progress", snapshotId);
    // The input exists before the build that references it: a crash the other
    // way round would leave a build whose input cannot be read. The same input
    // may already be on record from a build under an earlier build digest;
    // that record is shared, and its object is written back if it is gone.
    const record = await readInputRecord(db, capture.captured.digest);
    if (!record) await storeProjectionInput(store, capture.captured);
    else if (!(await loadProjectionInput(store, record)))
      await restoreProjectionInput(store, record, capture.captured.input.content, now);
    await runBatch(db, [
      db
        .prepare(
          `INSERT INTO balance_read_snapshots(snapshot_id,created_at,input_manifest_json,status,
            row_count,projection_release,build_cursor,sealed_at,input_digest,source_revision,
            visibility_revision,core_epoch,read_instance_id)
           VALUES(?1,?2,?3,'building',0,?4,NULL,NULL,?5,?6,?7,?8,?9)`,
        )
        .bind(
          snapshotId,
          now,
          JSON.stringify(capture.captured.input.content.manifest),
          BALANCE_PROJECTION_RELEASE,
          capture.captured.digest,
          capture.captured.input.sourceRevision,
          capture.captured.input.visibilityRevision,
          capture.captured.input.coreEpoch,
          CORE_READ_INSTANCE_ID,
        ),
      ...(record ? [] : [insertInputRecord(db, capture.captured, snapshotId, now)]),
    ]);
    build = {
      snapshotId,
      inputDigest: capture.captured.digest,
      input: capture.captured.input,
    };
  }

  // 2. Take the lease and raise the fence. Another writer holding a live lease
  //    keeps it; when it expires the next invocation takes the build over, and
  //    the displaced writer can no longer seal or publish (05 §4).
  const nowMs = Date.now();
  const claim = await db
    .prepare(
      `UPDATE balance_read_snapshots SET writer_lease=?2,writer_lease_until_ms=?3,
        writer_fence=writer_fence+1
       WHERE snapshot_id=?1 AND status='building'
         AND (writer_lease IS NULL OR writer_lease=?2 OR writer_lease_until_ms<=?4)`,
    )
    .bind(build.snapshotId, lease, nowMs + WRITER_LEASE_MS, nowMs)
    .run();
  if (claim.meta.changes !== 1)
    return halted("retryable", "writer_lease_unavailable", build.snapshotId);
  try {
    return await buildStep(db, build, { budget, lease, now });
  } finally {
    // The step is over: hand the build back so the next invocation can take
    // it without waiting out the lease. A sealed snapshot is not building any
    // more, so this is a no-op there.
    await db
      .prepare(
        `UPDATE balance_read_snapshots SET writer_lease=NULL,writer_lease_until_ms=0
         WHERE snapshot_id=?1 AND status='building' AND writer_lease=?2`,
      )
      .bind(build.snapshotId, lease)
      .run();
  }
}

interface StepContext {
  budget: number;
  lease: string;
  now: string;
}

/** The write, verify and publish half of one step, under a held lease. */
async function buildStep(
  db: D1Like,
  build: FixedBuild,
  { budget, lease, now }: StepContext,
): Promise<BalanceProjectionResult> {
  const projection = buildBalanceProjection(
    build.input.content.candidates,
    scopeRelationsFromEntityRelations(build.input.content.relations),
  );
  const digests = await rowDigests(projection.rows);
  const cursor = await db
    .prepare("SELECT build_cursor FROM balance_read_snapshots WHERE snapshot_id=?1")
    .bind(build.snapshotId)
    .first<{ build_cursor: string | null }>();
  const resumeAt =
    cursor?.build_cursor === null || cursor?.build_cursor === undefined
      ? -1
      : Number(cursor.build_cursor);
  const pending = projection.rows.filter((row) => row.rowSeq > resumeAt);
  const slice = pending.slice(0, budget);
  let written = 0;
  for (let start = 0; start < slice.length; start += WRITE_CHUNK) {
    const chunk = slice.slice(start, start + WRITE_CHUNK);
    // Chunk and checkpoint commit together: a statement error rolls both back,
    // so a checkpoint can never claim rows that are not there (05 §4, G2-08).
    const results = await runBatch(db, [
      ...chunk.map((row) => insertRow(db, build.snapshotId, row, digests.get(row.rowSeq) ?? "")),
      db
        .prepare(
          `UPDATE balance_read_snapshots SET build_cursor=?2
           WHERE snapshot_id=?1 AND status='building' AND writer_lease=?3`,
        )
        .bind(build.snapshotId, String(chunk[chunk.length - 1]!.rowSeq), lease),
    ]);
    if (results[results.length - 1]!.meta.changes !== 1)
      return halted("retryable", "writer_lease_lost", build.snapshotId, written);
    written += chunk.length;
  }
  if (slice.length < pending.length)
    return {
      enabled: true,
      snapshotId: build.snapshotId,
      status: "building",
      written,
      rowCount: projection.rows.length,
      retired: 0,
      reasonCode: null,
      sourceRevision: build.input.sourceRevision,
      inputDigest: build.inputDigest,
      active: false,
    };
  await writeRelations(db, projection.relations, now);

  // 3. Verify what was written, then seal and switch the pointer in one batch.
  //    A writer that lost the fence stops here: the guarded seal matches no
  //    row, and the pointer trigger refuses a snapshot that is not complete.
  if (!(await writtenRowsMatch(db, build.snapshotId, projection.rows, digests)))
    return halted("retryable", "projection_rows_unverified", build.snapshotId, written);
  const held = await db
    .prepare(
      `SELECT 1 AS held FROM balance_read_snapshots
       WHERE snapshot_id=?1 AND status='building' AND writer_lease=?2`,
    )
    .bind(build.snapshotId, lease)
    .first<{ held: number }>();
  if (!held) return halted("retryable", "writer_lease_lost", build.snapshotId, written);
  const sealed = await runBatch(db, [
    db
      .prepare(
        `UPDATE balance_read_snapshots SET status='complete',sealed_at=?2,row_count=?3
         WHERE snapshot_id=?1 AND status='building' AND writer_lease=?4`,
      )
      .bind(build.snapshotId, now, projection.rows.length, lease),
    activePointerStatement(
      db,
      build.snapshotId,
      build.input.sourceRevision,
      build.input.coreEpoch,
      now,
    ),
  ]);
  if (sealed[0]!.meta.changes !== 1)
    return halted("retryable", "writer_lease_lost", build.snapshotId, written);
  const retired = await retireOldSnapshots(db, build.snapshotId, now);
  return {
    enabled: true,
    snapshotId: build.snapshotId,
    status: "complete",
    written,
    rowCount: projection.rows.length,
    retired,
    reasonCode: null,
    sourceRevision: build.input.sourceRevision,
    inputDigest: build.inputDigest,
    active: sealed[1]!.meta.changes === 1,
  };
}

/**
 * The `balance-projection` decision outbox processor (A09 hands the target to
 * A07 through `dispatchDecisionOutbox`'s `processors` argument).
 *
 * An accepted decision changes which scopes overlap, and therefore which
 * candidates are adopted, without publishing a single new parse. The decision
 * moved the CORE revision, so this processor's job is to answer one question:
 * does the snapshot the read model publishes already cover that revision?
 *
 *   yes                     -> completed, with the snapshot as the evidence
 *   still building, flag off -> pending, with the progress code
 *   budget exceeded          -> blocked
 *   fence lost, input gone   -> retryable
 *
 * It never reports completion because a rebuild was started, and never
 * rebuilds twice: a lost response converges on the next tick because the
 * active pointer already carries the revision (05 §5–§6, G2-11..G2-13).
 */
export function balanceProjectionOutboxProcessor(
  env: Env,
  options: BalanceProjectionOptions = {},
  // The dispatcher's own processor shape (packages/storage-d1 since U05): the
  // structural D1 binding, which a real `D1Database` satisfies, and the row
  // the dispatcher claimed, which carries the revision this effect must cover.
): OutboxProcessor {
  return async (db, row) => {
    if (!projectionFlagOn(env)) return pendingOutcome("projection_flag_off");
    const required = row.required_source_revision;
    const already = await publishedSnapshotFor(env, db, required);
    if (already) return completedOutcome("balance_projection_active", already);
    const result = await runBalanceProjection(env, options);
    switch (result.status) {
      case "complete":
      case "unchanged": {
        const active = await publishedSnapshotFor(env, db, required);
        return active
          ? completedOutcome("balance_projection_active", active)
          : pendingOutcome("projection_behind_decision");
      }
      case "building":
        return pendingOutcome("projection_building");
      case "pending":
        return pendingOutcome(result.reasonCode ?? "projection_input_unstable");
      case "refused":
        return blockedOutcome(result.reasonCode ?? "projection_budget_exceeded");
      case "retryable":
        return retryableOutcome(result.reasonCode ?? "projection_writer_fenced");
      default:
        // `skipped`: the flag went off between the two reads above.
        return pendingOutcome("projection_flag_off");
    }
  };
}
