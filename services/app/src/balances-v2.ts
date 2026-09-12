// `/api/v2/balances/latest` and `/api/v2/balances/history` (review D10/D11).
//
// Two routes with separate budgets over one fixed snapshot. A page is a keyed
// range scan of the projection built by the observation pipeline; this module
// never re-ranks, re-groups or re-classifies candidates, so paging cannot
// change group membership and a publication landing between two pages cannot
// insert or remove a row from the list being read.
//
// The cursor is opaque but never trusted. It carries only the snapshot id, a
// digest of the resolved filter set, the last sort key and an opaque row
// position: no account label, no provider metric, no amount. Every
// continuation request goes through the same Access gate and the same scope
// resolution as the first, and a cursor whose filter digest differs is
// refused rather than reinterpreted.

import { canonicalDigest } from "../../../packages/domain/src/context.ts";
import { metricById, resolveMetric, UNKNOWN_METRIC } from "../../../packages/domain/src/metrics.ts";
import {
  KEYSET_PAGINATION_VERSION,
  SNAPSHOT_PAGE_SCHEMA_VERSION,
} from "../../../packages/domain/src/paging.ts";
import { addDecimals, integerDecimal } from "../../../packages/domain/src/values.ts";
import type {
  BalanceEvidenceMember,
  BalanceHistoryItem,
  BalanceHistoryPage,
  BalanceHistoryRow,
  BalanceRow,
  KnownAssetsSubtotals,
  LatestBalanceItem,
  LatestBalancePage,
  MeasureDescriptor,
  ObservedQuantityWire,
  SnapshotDataCoverage,
} from "../../../packages/observation-shared/src/api-contract.ts";
import {
  BALANCE_INTERPRETATION_POLICY_VERSION,
  classifyBalance,
} from "../../../packages/observation-shared/src/balance-semantics.ts";
import { minorUnitExponent } from "../../../packages/parsers/src/money.ts";
import type { IdentityReadMode } from "../../../packages/read-model/src/index";
import {
  d1Executor,
  DEFAULT_PROJECTION_PAGE_LIMIT,
  KNOWN_ASSETS_POLICY,
  knownAssetMetricIds,
  PROJECTION_PAGE_LIMITS,
  temporalReferenceFor,
  type BalanceProjectionReader,
  type BalanceSnapshotRow,
  type ProjectionPageRow,
} from "../../../packages/read-model/src/index";
import {
  checkReadCursor,
  createReadProjectionReader,
  decodeReadCursor,
  encodeReadCursor,
  READ_CONTRACT_VERSION,
  type PointerRow,
  type ReadProjectionReader,
} from "../../../packages/storage-d1/src/read/index.ts";
import { HttpError, json } from "./http";
import { decimalRows } from "./normalized-decimals";
import { organizationContext, organizeRows } from "./observation-organization";

export const V2_LATEST_PATH = "/api/v2/balances/latest";
export const V2_HISTORY_PATH = "/api/v2/balances/history";

/** Reader-side flag. Off keeps `/api/balances` on today's code path exactly. */
export function projectionFlagOn(env: Env): boolean {
  const flag: string = env.BALANCE_PROJECTION_ENABLED;
  return flag === "1";
}

/** The READ binding, when this deployment has one. */
function readBinding(env: Env): D1Database | null {
  return (env as unknown as { READ?: D1Database }).READ ?? null;
}

/**
 * The reader for this deployment. In READ mode the snapshot, its rows, its
 * coverage and its subtotals come from the READ database while the revision,
 * the input summary and balance history stay on CORE, because the two cannot
 * be joined (04 §1).
 */
export function balanceProjectionReader(env: Env): BalanceProjectionReader {
  const read = readBinding(env);
  if (!read) throw new HttpError(503, "read_model_unavailable");
  return createReadProjectionReader(d1Executor(env.DB), d1Executor(read));
}

/** The reader plus the physical read model a cursor has to name. */
export interface ReadTarget {
  reader: BalanceProjectionReader;
  /** The READ instance id. */
  instanceId: string | null;
  /** The READ pointer, or null before publication. */
  pointer: PointerRow | null;
  /**
   * The bound database has the shape of another baseline (06 §2). Nothing in
   * it is readable under this contract, published or not.
   */
  contractMismatch: boolean;
}

export async function readTarget(env: Env): Promise<ReadTarget> {
  const reader = balanceProjectionReader(env);
  const read = reader as ReadProjectionReader;
  const [instance, pointer] = await Promise.all([read.readInstance(), read.readPointer()]);
  // A READ database nobody has built into yet has no identity and no
  // published snapshot; the request is `unavailable`, never an empty list.
  return {
    reader,
    instanceId: instance?.read_instance_id ?? "read-unclaimed",
    pointer,
    contractMismatch: instance !== null && instance.contract_version !== READ_CONTRACT_VERSION,
  };
}

/**
 * Whether the published snapshot may still be served (05 §7).
 *
 * A snapshot behind the current revision is a valid fixed context and the page
 * says so. These two are not:
 *
 *   * a different `core_epoch` — CORE was restored, so its revision numbers
 *     mean something else and rows built under the old epoch are another
 *     context entirely (G3-02);
 *   * a different `visibility_revision` — a use restriction changed. Filtering
 *     rows out of the old snapshot would leave every subtotal at its old
 *     value, so the whole snapshot is refused until the rebuild publishes one
 *     that accounts for the restriction (G3-04).
 */
async function snapshotRefusal(
  target: ReadTarget,
  snapshot: BalanceSnapshotRow,
): Promise<string | null> {
  const revision = await target.reader.coreRevision();
  // The published snapshot is vouched for by the pointer: a build whose
  // content did not change still re-captured it at the current revision and
  // moved the watermark, so the pointer is what says "this was verified under
  // this epoch and these restrictions". An older snapshot a cursor still names
  // has only its own capture to go by.
  const vouched =
    target.pointer !== null && target.pointer.snapshot_id === snapshot.snapshot_id
      ? { epoch: target.pointer.core_epoch, visibility: target.pointer.visibility_revision }
      : { epoch: snapshot.core_epoch, visibility: snapshot.visibility_revision };
  if (vouched.epoch !== null && vouched.epoch !== revision.core_epoch)
    return "read_model_context_changed";
  if (vouched.visibility !== null && vouched.visibility !== revision.visibility_revision)
    return "read_model_restriction_changed";
  return null;
}

/** The scope the routes accept; the same allow-listed keys the v1 list uses. */
export interface V2Scope {
  source?: string;
  account?: string;
  instrument?: string;
  metric?: string;
  measureView?: "balances" | "summaries";
}

function scopeOf(url: URL): V2Scope {
  const view = url.searchParams.get("view");
  return {
    ...(url.searchParams.get("source") ? { source: url.searchParams.get("source")! } : {}),
    ...(url.searchParams.get("account") ? { account: url.searchParams.get("account")! } : {}),
    ...(url.searchParams.get("instrument")
      ? { instrument: url.searchParams.get("instrument")! }
      : {}),
    ...(url.searchParams.get("metric") ? { metric: url.searchParams.get("metric")! } : {}),
    ...(view === "balances" || view === "summaries" ? { measureView: view } : {}),
  };
}

function pageLimit(url: URL): number {
  const text = url.searchParams.get("limit");
  if (text === null) return DEFAULT_PROJECTION_PAGE_LIMIT;
  const limit = Number(text);
  if (!(PROJECTION_PAGE_LIMITS as readonly number[]).includes(limit))
    throw new HttpError(400, "invalid_limit");
  return limit;
}

/**
 * What the cursor is bound to: the route, the resolved scope, the page size
 * and the identity read mode. Changing any of them makes a stored cursor
 * belong to a different query, and the continuation is refused.
 */
async function filterDigest(
  route: string,
  scope: V2Scope,
  limit: number,
  mode: IdentityReadMode,
): Promise<string> {
  return await canonicalDigest({ route, scope, limit, mode });
}

function quantityOf(row: {
  value_status: ProjectionPageRow["value_status"];
  quantity_coefficient: string | null;
  quantity_scale: number | null;
  unit_ref: string;
  amount_minor: string | null;
  amount_text: string | null;
}): ObservedQuantityWire {
  return {
    normalized:
      row.value_status === "exact" &&
      row.quantity_coefficient !== null &&
      row.quantity_scale !== null
        ? {
            policyVersion: "decimal-v1",
            status: "exact",
            coefficient: row.quantity_coefficient,
            scale: row.quantity_scale,
            basis: "agreement",
          }
        : {
            policyVersion: "decimal-v1",
            status: row.value_status,
            coefficient: null,
            scale: null,
            basis: "none",
          },
    unitReference: row.unit_ref || null,
    sourceRepresentation: {
      amountText: row.amount_text,
      legacyMinorUnits: row.amount_minor,
      // Unknown stays null: the exponent is a property of the legacy parser
      // contract for known currencies, never guessed from the value.
      legacyMinorUnitExponent: minorUnitExponent(row.unit_ref) ?? null,
    },
  };
}

/** The registry's meaning of one provider row, resolved from its coordinates. */
function metricIdOf(
  sourceId: string,
  parser: string,
  metric: string,
  sourceAccount: string,
): string {
  return resolveMetric({
    family: "balance",
    sourceId,
    parserName: parser.split("@")[0] ?? null,
    metric,
    sourceAccount,
    amountBasis: null,
  }).metricId;
}

function temporalOf(
  asOf: string | null,
  observedAt: string | null,
): BalanceHistoryItem["temporal"] {
  return temporalReferenceFor(asOf, observedAt) as unknown as BalanceHistoryItem["temporal"];
}

function measureOf(metricId: string, definitionRelease: string): MeasureDescriptor {
  const definition = metricById(metricId) ?? UNKNOWN_METRIC;
  return {
    metricId,
    definitionRelease,
    measurementKind: definition.measurementKind,
    aggregationRule: definition.aggregationRule,
  };
}

function evidenceOf(row: ProjectionPageRow): BalanceEvidenceMember[] {
  const members = storedEvidence(row);
  // A measurement always has at least its representative; an unreadable
  // stored list falls back to it rather than to an empty evidence array.
  return members.length > 0
    ? members
    : [
        {
          ref: row.representative_observation_ref,
          observationId: row.observation_id,
          metric: row.metric,
        },
      ];
}

function storedEvidence(row: ProjectionPageRow): BalanceEvidenceMember[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.member_evidence_refs_json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (item): item is BalanceEvidenceMember =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as BalanceEvidenceMember).ref === "string" &&
      typeof (item as BalanceEvidenceMember).observationId === "number" &&
      typeof (item as BalanceEvidenceMember).metric === "string",
  );
}

/** The v1-shaped evidence row a projection row represents. */
function balanceRowOf(row: ProjectionPageRow): BalanceRow {
  return {
    id: row.observation_id,
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

/**
 * The v1 interpretation record, rebuilt from the projection rather than
 * recomputed from a page fragment. `conflict` is the witness-level
 * disagreement of the strict same-provider-witness rule, exactly as today; an
 * adoption-level conflict is reported through `adoption.state` instead.
 */
function interpretationOf(row: ProjectionPageRow, evidence: BalanceEvidenceMember[]) {
  return {
    policyVersion: BALANCE_INTERPRETATION_POLICY_VERSION,
    semantic: classifyBalance({
      sourceId: row.source_id,
      parserName: row.parser.split("@")[0] ?? null,
      metric: row.metric,
      sourceAccount: row.source_account,
    }),
    evidence: evidence.map((member) => ({ id: member.observationId, metric: member.metric })),
    duplicateCount: evidence.length - 1,
    conflict: row.reason_code === "witness_value_conflict",
  } as const;
}

function highWaterOf(snapshot: BalanceSnapshotRow): number {
  const manifest: unknown = JSON.parse(snapshot.input_manifest_json);
  const value =
    typeof manifest === "object" && manifest !== null
      ? (manifest as Record<string, unknown>).publishedHighWaterParseRunId
      : null;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * Whether the snapshot still describes the store's current inputs.
 *
 * Since migration 0038 the comparison is the CORE revision, not a digest of
 * counts: the revision is bumped inside the same transaction as every write
 * the projection depends on, so a publication, a run leaving the visible set
 * and an accepted decision all move it — including the decision, which changes
 * which scopes overlap without publishing anything and which no parse-run
 * high-water can show. The active pointer carries the revision the published
 * snapshot was last verified against, so "current" is one integer comparison.
 *
 * A snapshot that is behind is still a valid fixed context to page; the page
 * says so instead of presenting itself as the current state. A snapshot that
 * is not the published one, or a database with no pointer yet, is behind by
 * definition rather than by assumption.
 */
async function snapshotBehind(
  reader: BalanceProjectionReader,
  snapshot: BalanceSnapshotRow,
): Promise<boolean> {
  const [pointer, revision] = await Promise.all([reader.activePointer(), reader.coreRevision()]);
  return (
    pointer === null ||
    pointer.snapshot_id !== snapshot.snapshot_id ||
    pointer.source_revision !== revision.source_revision ||
    pointer.core_epoch !== revision.core_epoch
  );
}

async function dataCoverage(
  reader: BalanceProjectionReader,
  snapshotId: string,
  scope: V2Scope,
  behind: boolean,
): Promise<SnapshotDataCoverage> {
  const rows = await reader.coverage(snapshotId, scope);
  const reasons = new Set<string>();
  let stale = behind;
  let unresolved = false;
  if (behind) reasons.add("snapshot:behind_published_evidence");
  for (const row of rows) {
    if (row.state === "adopted" && row.freshness === "current") continue;
    if (row.state === "stale" || row.freshness === "stale") stale = true;
    if (row.state === "unresolved" || row.state === "conflict") unresolved = true;
    if (row.reason_code) reasons.add(`${row.state}:${row.reason_code}`);
    if (row.freshness !== "current") reasons.add(`freshness:${row.freshness}`);
  }
  return {
    completeness: unresolved || stale ? "partial" : "complete",
    stale,
    reasons: [...reasons].sort(),
  };
}

/**
 * Assets the adopted set accounts for, per unit, over the whole filter scope
 * rather than the page. Exact integer arithmetic only; a unit is summed only
 * across distinct subject scopes, so a subject reported twice makes the
 * subtotal unavailable instead of double counting it (INV06). There is
 * deliberately no net worth: unfetched liabilities mean this is not even a
 * lower bound (addendum 05 section 5).
 */
async function knownAssetSubtotals(
  reader: BalanceProjectionReader,
  snapshotId: string,
  scope: V2Scope,
): Promise<KnownAssetsSubtotals> {
  const rows = await reader.summableQuantities(snapshotId, scope, knownAssetMetricIds());
  if (rows === null)
    return {
      policyRelease: KNOWN_ASSETS_POLICY,
      knownAssetsSubtotal: null,
      liabilitiesCoverage: "unknown",
      reasonCode: "scope_exceeds_subtotal_bound",
    };
  const subjects = new Set<string>();
  for (const row of rows) {
    if (subjects.has(row.subject_scope_key))
      return {
        policyRelease: KNOWN_ASSETS_POLICY,
        knownAssetsSubtotal: null,
        liabilitiesCoverage: "unknown",
        reasonCode: "subject_reported_twice",
      };
    subjects.add(row.subject_scope_key);
  }
  const totals = new Map<string, { coefficient: string; scale: number; adoptedCount: number }>();
  for (const row of rows) {
    const current = totals.get(row.unit_ref) ?? {
      ...integerDecimal(0),
      adoptedCount: 0,
    };
    const sum = addDecimals(
      { coefficient: current.coefficient, scale: current.scale },
      { coefficient: row.quantity_coefficient, scale: row.quantity_scale },
    );
    totals.set(row.unit_ref, { ...sum, adoptedCount: current.adoptedCount + 1 });
  }
  return {
    policyRelease: KNOWN_ASSETS_POLICY,
    knownAssetsSubtotal: [...totals.entries()]
      .map(([unitRef, total]) => ({ unitRef, ...total }))
      .sort((a, b) => (a.unitRef < b.unitRef ? -1 : 1)),
    liabilitiesCoverage: "unknown",
    reasonCode: null,
  };
}

interface Continuation {
  snapshot: BalanceSnapshotRow;
  afterRowSeq: number;
  afterSortKey: string;
}

/**
 * Resolve which snapshot serves this request. Without a cursor it is the
 * newest sealed snapshot; with one it is the snapshot the cursor names, so
 * membership stays fixed while the reader pages. A cursor for another query
 * is `cursor_mismatch` (400) and a snapshot that no longer exists is
 * `context_expired` (410): the reader is never moved silently to a newer
 * list.
 */
async function continuation(
  target: ReadTarget,
  url: URL,
  digest: string,
): Promise<Continuation | null> {
  if (target.contractMismatch) throw new HttpError(503, "read_model_unavailable");
  const text = url.searchParams.get("cursor");
  if (text === null) {
    const snapshot = await target.reader.currentSnapshot();
    return snapshot ? { snapshot, afterRowSeq: -1, afterSortKey: "" } : null;
  }
  const cursor = decodeReadCursor(text);
  if (!cursor) throw new HttpError(400, "invalid_cursor");
  const snapshot = await target.reader.snapshot(cursor.snapshotId);
  const rejection = checkReadCursor(cursor, {
    filterDigest: digest,
    // A cursor from another physical read model — a rebuilt READ database, or
    // the CORE projection this deployment no longer serves — expires. Snapshot
    // ids are digests of content and repeat across rebuilds, so the instance
    // is what says which database answered (U11, G3-03).
    readInstanceId: target.instanceId,
    snapshotReadable: snapshot !== null,
  });
  if (rejection === "cursor_mismatch") throw new HttpError(400, "cursor_mismatch");
  if (rejection !== null || snapshot === null) throw new HttpError(410, "context_expired");
  return { snapshot, afterRowSeq: cursor.position, afterSortKey: cursor.sortKey };
}

/**
 * The v1 `/api/balances` latest list, served from the projection instead of
 * grouping the candidate set on every request. Same rows, same order, same
 * offset window and the same `interpretation` record, so a client cannot tell
 * the two paths apart; the parity test compares them on one fixture.
 *
 * Returns null when no sealed snapshot exists, which is what keeps the flag
 * safe: the caller falls back to today's code rather than serving an empty
 * list.
 */
export async function legacyLatestFromProjection(
  env: Env,
  scope: V2Scope,
  latestOffset: number,
  mode: IdentityReadMode,
): Promise<BalanceRow[] | null> {
  const target = await readTarget(env);
  const reader = target.reader;
  if (target.contractMismatch) return null;
  const snapshot = await reader.currentSnapshot();
  // The v1 route promises the current state and its 5,000-candidate refusal.
  // A snapshot that is behind the published evidence cannot keep that
  // promise, so the adapter declines and the caller stays on today's query,
  // which still answers 413 for an oversized candidate set. A refused snapshot
  // (a restored CORE, a changed restriction) declines for the same reason:
  // v1 falls back rather than answering 503.
  if (!snapshot || (await snapshotBehind(reader, snapshot))) return null;
  if ((await snapshotRefusal(target, snapshot)) !== null) return null;
  const rows = await reader.legacyLatestPage(snapshot.snapshot_id, scope, latestOffset, 501);
  const organized = await organizeRows(env.DB, "balance", rows.map(balanceRowOf), mode);
  const withDecimals = await decimalRows(env.DB, "balance", organized);
  return rows.map((row, index) => ({
    ...withDecimals[index]!,
    interpretation: interpretationOf(row, evidenceOf(row)),
  }));
}

/**
 * Latest balances of one fixed snapshot. Items carry the adopted state and
 * its reason code, the quantity a calculation may use, what the measure
 * means, and how many pieces of evidence back it — which is not the number of
 * balances shown (addendum 11 section 4).
 */
export async function latestBalancePage(
  env: Env,
  url: URL,
  mode: IdentityReadMode,
): Promise<Response> {
  const target = await readTarget(env);
  const reader = target.reader;
  const scope = scopeOf(url);
  const limit = pageLimit(url);
  const digest = await filterDigest(V2_LATEST_PATH, scope, limit, mode);
  const resolved = await continuation(target, url, digest);
  // No published snapshot at all: the read model is unavailable, which is a
  // different answer from "you hold no balances" (05 §7, G3-01).
  if (!resolved) throw new HttpError(503, "read_model_unavailable");
  const refusal = await snapshotRefusal(target, resolved.snapshot);
  if (refusal !== null) throw new HttpError(503, refusal);
  const rows = await reader.latestPage(
    resolved.snapshot.snapshot_id,
    scope,
    limit,
    resolved.afterRowSeq,
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const organized = await organizeRows(env.DB, "balance", page.map(balanceRowOf), mode);
  const withDecimals = await decimalRows(env.DB, "balance", organized);
  const items: LatestBalanceItem[] = page.map((row, index) => {
    const evidence = evidenceOf(row);
    const temporal: unknown = JSON.parse(row.temporal_json);
    return {
      observationId: row.observation_id,
      row: { ...withDecimals[index]!, interpretation: interpretationOf(row, evidence) },
      quantity: quantityOf(row),
      metric: measureOf(row.metric_id, row.definition_release),
      adoption: {
        state: row.state as LatestBalanceItem["adoption"]["state"],
        reasonCode: row.reason_code,
        memberEvidence: evidence,
        evidenceCount: evidence.length,
      },
      temporal: temporal as LatestBalanceItem["temporal"],
      freshness: {
        state: row.freshness as LatestBalanceItem["freshness"]["state"],
        reasonCode: row.freshness_reason,
      },
    };
  });
  const last = page[page.length - 1];
  const body: LatestBalancePage = {
    schemaVersion: SNAPSHOT_PAGE_SCHEMA_VERSION,
    items,
    page: {
      limit,
      hasMore,
      nextCursor:
        hasMore && last
          ? encodeReadCursor({
              snapshotId: resolved.snapshot.snapshot_id,
              readInstanceId: target.instanceId,
              filterDigest: digest,
              sortKey: last.sort_as_of,
              position: last.row_seq,
            })
          : null,
      snapshotId: resolved.snapshot.snapshot_id,
      paginationVersion: KEYSET_PAGINATION_VERSION,
    },
    dataCoverage: await dataCoverage(
      reader,
      resolved.snapshot.snapshot_id,
      scope,
      await snapshotBehind(reader, resolved.snapshot),
    ),
    subtotals: await knownAssetSubtotals(reader, resolved.snapshot.snapshot_id, scope),
    interpretationContext: organizationContext(
      mode,
      organized.map((row) => row.organization),
    ),
  };
  return json(body);
}

/**
 * Balance history of the same fixed context: the append-only record of
 * visible parse results up to the snapshot's published high-water parse run,
 * with its own page budget and its own cursor.
 */
export async function balanceHistoryPage(
  env: Env,
  url: URL,
  mode: IdentityReadMode,
): Promise<Response> {
  const target = await readTarget(env);
  const reader = target.reader;
  const scope = scopeOf(url);
  const limit = pageLimit(url);
  const digest = await filterDigest(V2_HISTORY_PATH, scope, limit, mode);
  const resolved = await continuation(target, url, digest);
  if (!resolved) throw new HttpError(503, "read_model_unavailable");
  const refusal = await snapshotRefusal(target, resolved.snapshot);
  if (refusal !== null) throw new HttpError(503, refusal);
  const rows = await reader.historyPage(
    highWaterOf(resolved.snapshot),
    scope,
    limit,
    resolved.afterRowSeq < 0
      ? null
      : { sortValue: resolved.afterSortKey, id: resolved.afterRowSeq },
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const organized = await organizeRows(env.DB, "balance", page, mode);
  const withDecimals = await decimalRows(env.DB, "balance", organized);
  const items: BalanceHistoryItem[] = page.map((row, index) => {
    const evidence: BalanceEvidenceMember[] = [
      { ref: `balance:${String(row.id)}`, observationId: row.id, metric: row.metric },
    ];
    // `sort_key` is the query's ordering column, not part of the contract.
    const { sort_key: _sortKey, ...evidenceRow } = withDecimals[index]!;
    const historyRow: BalanceHistoryRow = {
      ...(evidenceRow as BalanceHistoryRow),
      interpretation: {
        policyVersion: BALANCE_INTERPRETATION_POLICY_VERSION,
        semantic: classifyBalance({
          sourceId: row.source_id,
          parserName: row.parser.split("@")[0] ?? null,
          metric: row.metric,
          sourceAccount: row.source_account,
        }),
        evidence: evidence.map((member) => ({ id: member.observationId, metric: member.metric })),
        duplicateCount: 0,
        conflict: false,
      },
    };
    return {
      observationId: row.id,
      row: historyRow,
      quantity: quantityOf({
        value_status: historyRow.normalized?.status ?? "missing",
        quantity_coefficient: historyRow.normalized?.coefficient ?? null,
        quantity_scale: historyRow.normalized?.scale ?? null,
        unit_ref: row.instrument,
        amount_minor: row.amount_minor,
        amount_text: row.amount_text,
      }),
      metric: measureOf(
        // History rows are individual observations; their meaning comes from
        // the same registry, resolved from the provider coordinates.
        metricIdOf(row.source_id, row.parser, row.metric, row.source_account),
        resolved.snapshot.projection_release,
      ),
      temporal: temporalOf(row.as_of, row.observed_at),
    };
  });
  const last = page[page.length - 1];
  const body: BalanceHistoryPage = {
    schemaVersion: SNAPSHOT_PAGE_SCHEMA_VERSION,
    items,
    page: {
      limit,
      hasMore,
      nextCursor:
        hasMore && last
          ? encodeReadCursor({
              snapshotId: resolved.snapshot.snapshot_id,
              readInstanceId: target.instanceId,
              filterDigest: digest,
              sortKey: last.sort_key,
              position: last.id,
            })
          : null,
      snapshotId: resolved.snapshot.snapshot_id,
      paginationVersion: KEYSET_PAGINATION_VERSION,
    },
    dataCoverage: {
      // History is the record of what was parsed, not a membership claim: it
      // never says a portfolio is complete.
      completeness: "unknown",
      stale: false,
      reasons: ["history:not_a_membership_claim"],
    },
    interpretationContext: organizationContext(
      mode,
      organized.map((row) => row.organization),
    ),
  };
  return json(body);
}
