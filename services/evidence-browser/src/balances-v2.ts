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
import {
  checkKeysetCursor,
  decodeKeysetCursor,
  encodeKeysetCursor,
  KEYSET_PAGINATION_VERSION,
  SNAPSHOT_PAGE_SCHEMA_VERSION,
} from "../../../packages/domain/src/paging.ts";
import { addDecimals, integerDecimal } from "../../../packages/domain/src/values.ts";
import { metricById, resolveMetric, UNKNOWN_METRIC } from "../../../packages/domain/src/metrics.ts";
import {
  createBalanceProjectionReader,
  d1Executor,
  DECIMAL_POLICY_RELEASE,
  DEFAULT_PROJECTION_PAGE_LIMIT,
  KNOWN_ASSETS_POLICY,
  LATEST_IDENTITY_RELEASE,
  knownAssetMetricIds,
  PROJECTION_PAGE_LIMITS,
  projectionInputManifest,
  temporalReferenceFor,
  type BalanceProjectionReader,
  type BalanceSnapshotRow,
  type ProjectionPageRow,
} from "../../../packages/read-model/src/index";
import {
  BALANCE_INTERPRETATION_POLICY_VERSION,
  classifyBalance,
} from "../../../packages/observation-shared/src/balance-semantics.ts";
import { minorUnitExponent } from "../../../packages/parsers/src/money.ts";
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
import type { IdentityReadMode } from "../../../packages/read-model/src/index";
import { decimalRows } from "./normalized-decimals";
import { HttpError, json } from "./http";
import { organizationContext, organizeRows } from "./observation-organization";

export const V2_LATEST_PATH = "/api/v2/balances/latest";
export const V2_HISTORY_PATH = "/api/v2/balances/history";

/** Reader-side flag. Off keeps `/api/balances` on today's code path exactly. */
export function projectionFlagOn(env: Env): boolean {
  const flag: string = env.BALANCE_PROJECTION_ENABLED;
  return flag === "1";
}

export function balanceProjectionReader(env: Env): BalanceProjectionReader {
  return createBalanceProjectionReader(d1Executor(env.DB));
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
 * The comparison is the snapshot id itself, which is the digest of every
 * declared input: a new publication, a run leaving the visible set, and an
 * accepted decision all change it. That last one matters here — a decision
 * changes which scopes overlap without publishing anything, and a snapshot
 * built before it is wrong in a way no parse-run high-water can show.
 *
 * A snapshot that is behind is still a valid fixed context to page; the page
 * says so instead of presenting itself as the current state.
 */
async function snapshotBehind(
  reader: BalanceProjectionReader,
  snapshot: BalanceSnapshotRow,
): Promise<boolean> {
  const row = await reader.projectionInputs();
  const current = await canonicalDigest(
    projectionInputManifest({
      publishedHighWaterParseRunId: row.published_high_water,
      visibleFetchRunCount: row.visible_runs,
      visibleFetchRunHighWater: row.visible_high_water,
      adoptedRelationCount: row.adopted_relations,
      decisionRevisionCount: row.decision_revisions,
      identityRelease: LATEST_IDENTITY_RELEASE,
      decimalPolicyRelease: DECIMAL_POLICY_RELEASE,
    }),
  );
  return current !== snapshot.snapshot_id;
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
  reader: BalanceProjectionReader,
  url: URL,
  digest: string,
): Promise<Continuation | null> {
  const text = url.searchParams.get("cursor");
  if (text === null) {
    const snapshot = await reader.currentSnapshot();
    return snapshot ? { snapshot, afterRowSeq: -1, afterSortKey: "" } : null;
  }
  const cursor = decodeKeysetCursor(text);
  if (!cursor) throw new HttpError(400, "invalid_cursor");
  const snapshot = await reader.snapshot(cursor.s);
  const rejection = checkKeysetCursor(cursor, {
    filterDigest: digest,
    snapshotReadable: snapshot !== null,
  });
  if (rejection === "cursor_mismatch") throw new HttpError(400, "cursor_mismatch");
  if (rejection !== null || snapshot === null) throw new HttpError(410, "context_expired");
  return { snapshot, afterRowSeq: cursor.t, afterSortKey: cursor.k };
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
  const reader = balanceProjectionReader(env);
  const snapshot = await reader.currentSnapshot();
  // The v1 route promises the current state and its 5,000-candidate refusal.
  // A snapshot that is behind the published evidence cannot keep that
  // promise, so the adapter declines and the caller stays on today's query,
  // which still answers 413 for an oversized candidate set.
  if (!snapshot || (await snapshotBehind(reader, snapshot))) return null;
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
  const reader = balanceProjectionReader(env);
  const scope = scopeOf(url);
  const limit = pageLimit(url);
  const digest = await filterDigest(V2_LATEST_PATH, scope, limit, mode);
  const resolved = await continuation(reader, url, digest);
  if (!resolved) throw new HttpError(404, "not_found");
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
          ? encodeKeysetCursor({
              s: resolved.snapshot.snapshot_id,
              f: digest,
              k: last.sort_as_of,
              t: last.row_seq,
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
  const reader = balanceProjectionReader(env);
  const scope = scopeOf(url);
  const limit = pageLimit(url);
  const digest = await filterDigest(V2_HISTORY_PATH, scope, limit, mode);
  const resolved = await continuation(reader, url, digest);
  if (!resolved) throw new HttpError(404, "not_found");
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
          ? encodeKeysetCursor({
              s: resolved.snapshot.snapshot_id,
              f: digest,
              k: last.sort_key,
              t: last.id,
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
