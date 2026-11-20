// Cash per account (ADR 0123, amendment 2026-11-20): the latest cash
// measurements of one published balance snapshot, one line per account, with
// exact subtotals per unit and per source. `GET /api/v2/balances/cash` and
// `kogane.balances.read` `collection: cash` both answer from `cashPerAccount`
// (ADR 0081).
//
// It reads nothing. The caller hands it the projection's latest rows of the
// filter scope (`measureRows`) with each row's organized account entity and
// label, and pages the lines it returns. What it decides:
//
//   * which rows are cash: the known-assets subtotal's metrics
//     (`CASH_METRIC_IDS`); every other row is counted under a closed reason
//     from its registry definition (`cashLeftOutReason`);
//   * one line per account: the organized account entity, or the projection
//     subject when the organization is unavailable, so an account reached
//     through several provider references is one line;
//   * what is counted (INV06): only adopted exact amounts, as the projection
//     adopted them for the known-assets subtotal and `holdings`, and only one
//     per unit on a line and on a provider reference. Two adopted amounts of
//     one unit on one account are both left uncounted with
//     `cash:account_reported_twice`, never added;
//   * the subtotals (INV03): `sumQuantities` of the counted amounts of one
//     unit, never across units; a unit with nothing counted has no value,
//     never a zero, and an amount that is not counted for a reason other
//     than `excluded` makes its subtotal `partial` with that reason (INV05).
import { metricById, UNKNOWN_METRIC } from "../../../domain/src/metrics.ts";
import {
  decimalToString,
  exactQuantity,
  type Quantity,
  sumQuantities,
} from "../../../domain/src/values.ts";
import {
  type BalanceAdoptionState,
  type CashAmount,
  type CashLeftOut,
  type CashLeftOutReason,
  type CashLine,
  type CashMetricId,
  type CashReference,
  type CashSourceSubtotal,
  type CashSubtotal,
  CASH_LEFT_OUT_METRICS,
  CASH_LEFT_OUT_REASONS,
  CASH_METRIC_IDS,
  CASH_REPORTED_TWICE,
  type SnapshotDataCoverage,
} from "../../../observation-shared/src/api-contract.ts";
import { type ProjectionMeasureRow, subtotalCountKey } from "../../../read-model/src/index";

/** A projection row with the account entity and readable label its organization gives. */
export interface OrganizedMeasureRow extends ProjectionMeasureRow {
  account: string | null;
  label: string | null;
}

/** One line with the key the caller pages by: the account entity or the projection subject. */
export interface KeyedCashLine {
  key: string;
  line: CashLine;
}

export interface CashPerAccount {
  /** Every line of the scope, in the read's order (source, label, key). */
  lines: KeyedCashLine[];
  subtotals: { byUnit: CashSubtotal[]; bySource: CashSourceSubtotal[] };
  leftOut: CashLeftOut[];
  dataCoverage: SnapshotDataCoverage;
}

const ADOPTION_STATES: readonly BalanceAdoptionState[] = [
  "adopted",
  "excluded",
  "unresolved",
  "conflict",
  "stale",
];

const isCashMetric = (metricId: string): metricId is CashMetricId =>
  (CASH_METRIC_IDS as readonly string[]).includes(metricId);

/**
 * Why a metric is not cash, from its registry definition, in the closed
 * order of `CASH_LEFT_OUT_REASONS`. A cash metric has no reason (null).
 */
export function cashLeftOutReason(metricId: string): CashLeftOutReason | null {
  if (isCashMetric(metricId)) return null;
  const definition = metricById(metricId);
  if (definition === null || definition.metricId === UNKNOWN_METRIC.metricId)
    return "metric_unknown";
  if (definition.unitDimension !== "currency") return "not_currency";
  if (definition.measurementKind !== "stock") return "not_a_stock";
  if (definition.signMeaning !== "asset-positive") return "not_asset_positive";
  if (definition.overlapGroup !== null) return "overlaps_another_measure";
  if (definition.aggregationRule === "select-one") return "restates_a_balance";
  return "not_summable";
}

function adoptionOf(state: string): BalanceAdoptionState {
  if (!(ADOPTION_STATES as readonly string[]).includes(state))
    throw new Error("cash_adoption_state_unknown");
  return state as BalanceAdoptionState;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareTuples(a: readonly (string | number)[], b: readonly (string | number)[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = a[index] ?? "";
    const right = b[index] ?? "";
    if (left === right) continue;
    if (typeof left === "number" && typeof right === "number") return left - right;
    return compareText(String(left), String(right));
  }
  return 0;
}

/** An amount with where it was reported and the exact coefficient a counted one is added with. */
interface Entry {
  source: string;
  amount: CashAmount;
  coefficient: string | null;
}

/** The counted amounts of one unit (or one source and unit), added exactly. */
function subtotal(unit: string, entries: readonly Entry[]): CashSubtotal {
  const counted: Quantity[] = [];
  const reasons = new Set<string>();
  let notCounted = 0;
  let partial = false;
  for (const { amount, coefficient } of entries) {
    if (amount.counted && coefficient !== null && amount.scale !== null) {
      counted.push(exactQuantity(unit, { coefficient, scale: amount.scale }));
      continue;
    }
    notCounted += 1;
    // `excluded`: another counted measurement covers it (the same balance
    // through another reference, a total and its breakdown), so leaving it
    // out completes the figure rather than cutting it.
    if (amount.adoption !== "excluded") partial = true;
    for (const reason of amount.reasons) reasons.add(reason);
  }
  let value: string | null = null;
  let scale: number | null = null;
  if (counted.length > 0) {
    const sum = sumQuantities(unit, counted);
    // Every operand is exact and of this unit, so a refusal is a bug, never a figure.
    if (!sum.ok || sum.quantity.value.status !== "exact") throw new Error("cash_subtotal_refused");
    value = decimalToString(sum.quantity.value.value);
    scale = sum.quantity.value.value.scale;
  }
  return {
    unit,
    value,
    scale,
    counted: counted.length,
    notCounted,
    status: partial ? "partial" : "complete",
    reasons: [...reasons].sort(),
  };
}

/** One cash row as an amount: its value or its status, and why it is not counted. */
function amountOf(row: OrganizedMeasureRow, twice: boolean): Entry {
  const adoption = adoptionOf(row.state);
  const exact =
    row.value_status === "exact" &&
    row.quantity_coefficient !== null &&
    row.quantity_scale !== null;
  const counted = adoption === "adopted" && exact && !twice;
  const reasons: string[] = [];
  if (row.reason_code !== null) reasons.push(`adoption:${row.reason_code}`);
  if (row.freshness_reason !== null) reasons.push(`freshness:${row.freshness_reason}`);
  if (twice) reasons.push(CASH_REPORTED_TWICE);
  // A not-counted amount always says why, even where the projection stored no code.
  if (!counted && reasons.length === 0) reasons.push(`adoption:${adoption}`);
  return {
    source: row.source_id,
    coefficient: counted ? row.quantity_coefficient : null,
    amount: {
      observationId: row.observation_id,
      metric: row.metric_id as CashMetricId,
      unit: row.unit_ref,
      value: exact
        ? decimalToString({ coefficient: row.quantity_coefficient!, scale: row.quantity_scale! })
        : null,
      scale: exact ? row.quantity_scale : null,
      status: row.value_status,
      adoption,
      counted,
      asOf: row.as_of,
      reasons: [...new Set(reasons)].sort(),
    },
  };
}

/** The left-out entry of one reason: its rows, and its metrics with the most rows first. */
function leftOutEntry(reason: CashLeftOutReason, metrics: Map<string, number>): CashLeftOut {
  const named = [...metrics.entries()]
    .sort(([leftId, left], [rightId, right]) => right - left || compareText(leftId, rightId))
    .map(([metric]) => metric);
  return {
    reason,
    rows: [...metrics.values()].reduce((sum, count) => sum + count, 0),
    metrics: named.slice(0, CASH_LEFT_OUT_METRICS),
    moreMetrics: Math.max(0, named.length - CASH_LEFT_OUT_METRICS),
  };
}

/**
 * The cash of one scope, from the projection's latest rows of that scope
 * with their organization. `behind` is whether the snapshot trails CORE (the
 * v2 balance routes' own test); it makes the coverage partial, as it does
 * theirs.
 */
export function cashPerAccount(
  rows: readonly OrganizedMeasureRow[],
  behind: boolean,
): CashPerAccount {
  const leftOut = new Map<CashLeftOutReason, Map<string, number>>();
  const cash: OrganizedMeasureRow[] = [];
  for (const row of rows) {
    const reason = cashLeftOutReason(row.metric_id);
    if (reason === null) {
      cash.push(row);
      continue;
    }
    const metrics = leftOut.get(reason) ?? new Map<string, number>();
    metrics.set(row.metric_id, (metrics.get(row.metric_id) ?? 0) + 1);
    leftOut.set(reason, metrics);
  }

  const lineKey = (row: OrganizedMeasureRow) =>
    row.account === null ? `subject:${row.subject_scope_key}` : `account:${row.account}`;

  // INV06: an adopted exact amount is counted only when it is the only one of
  // its unit on its provider reference (the subtotal's own key) and on its
  // account line. A second one leaves both uncounted rather than picking one.
  const adopted = cash.filter((row) => row.state === "adopted" && row.value_status === "exact");
  const twice = new Set<OrganizedMeasureRow>();
  for (const keyOf of [
    (row: OrganizedMeasureRow) => subtotalCountKey(row),
    (row: OrganizedMeasureRow) => JSON.stringify([lineKey(row), row.unit_ref]),
  ]) {
    const groups = new Map<string, OrganizedMeasureRow[]>();
    for (const row of adopted) {
      const key = keyOf(row);
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    for (const group of groups.values())
      if (group.length > 1) for (const row of group) twice.add(row);
  }

  // The coverage of the cash rows, read as the v2 latest page reads its own.
  const reasons = new Set<string>();
  let stale = behind;
  let unresolved = false;
  if (behind) reasons.add("snapshot:behind_published_evidence");
  for (const row of cash) {
    if (row.state === "stale" || row.freshness === "stale") stale = true;
    if (row.state === "unresolved" || row.state === "conflict" || twice.has(row)) unresolved = true;
    if (!(row.state === "adopted" && row.freshness === "current")) {
      if (row.reason_code !== null) reasons.add(`${row.state}:${row.reason_code}`);
      if (row.freshness !== "current") reasons.add(`freshness:${row.freshness}`);
    }
    if (twice.has(row)) reasons.add(CASH_REPORTED_TWICE);
  }

  const grouped = new Map<string, OrganizedMeasureRow[]>();
  for (const row of cash) grouped.set(lineKey(row), [...(grouped.get(lineKey(row)) ?? []), row]);
  const entries: Entry[] = [];
  const lines: (KeyedCashLine & { order: (string | number)[] })[] = [];
  for (const [key, members] of grouped) {
    const sorted = [...members].sort((a, b) =>
      compareTuples(
        [a.source_id, a.source_account, a.unit_ref, a.metric_id, a.row_seq],
        [b.source_id, b.source_account, b.unit_ref, b.metric_id, b.row_seq],
      ),
    );
    const references: CashReference[] = [];
    for (const row of sorted) {
      const entry = amountOf(row, twice.has(row));
      entries.push(entry);
      const last = references[references.length - 1];
      if (
        last !== undefined &&
        last.source === row.source_id &&
        last.sourceAccount === row.source_account
      )
        last.amounts.push(entry.amount);
      else
        references.push({
          source: row.source_id,
          sourceAccount: row.source_account,
          amounts: [entry.amount],
        });
    }
    // The rows of a line share an account entity; the label is its first
    // reference's (ADR 0120 gives one label per entity, except a manual
    // mapping's own label on its reference).
    const first = sorted[0]!;
    lines.push({
      key,
      line: { account: first.account, label: first.label, references },
      // A line sorts under its first source, then its label (unlabelled last).
      order: [first.source_id, first.label === null ? 1 : 0, first.label ?? "", key],
    });
  }
  lines.sort((a, b) => compareTuples(a.order, b.order));

  const units = [...new Set(entries.map(({ amount }) => amount.unit))].sort(compareText);
  const sourceUnits = [
    ...new Map(
      entries.map(({ source, amount }) => [
        JSON.stringify([source, amount.unit]),
        [source, amount.unit],
      ]),
    ).values(),
  ].sort((a, b) => compareTuples(a, b));

  return {
    lines: lines.map(({ key, line }) => ({ key, line })),
    subtotals: {
      byUnit: units.map((unit) =>
        subtotal(
          unit,
          entries.filter(({ amount }) => amount.unit === unit),
        ),
      ),
      bySource: sourceUnits.map(([source, unit]) => ({
        source: source!,
        ...subtotal(
          unit!,
          entries.filter((entry) => entry.source === source && entry.amount.unit === unit),
        ),
      })),
    },
    leftOut: CASH_LEFT_OUT_REASONS.flatMap((reason) => {
      const metrics = leftOut.get(reason);
      return metrics === undefined ? [] : [leftOutEntry(reason, metrics)];
    }),
    dataCoverage: {
      completeness: unresolved || stale ? "partial" : "complete",
      stale,
      reasons: [...reasons].sort(),
    },
  };
}

/**
 * What a cash cursor is bound to beside the snapshot: every line of the scope
 * in order, with its key, its label and the observations of each reference.
 * The snapshot fixes the rows, but the account a row is grouped under and the
 * label a line sorts by come from the current identity, so a decision between
 * two pages can merge, split or reorder lines anywhere in the scope, and with
 * them the subtotals. Any such change moves this value, and the cursor
 * expires instead of continuing a walk over another grouping.
 */
export function cashGrouping(lines: readonly KeyedCashLine[]): unknown {
  return lines.map(({ key, line }) => [
    key,
    line.label,
    line.references.map((reference) => [
      reference.source,
      reference.sourceAccount,
      reference.amounts.map((amount) => amount.observationId),
    ]),
  ]);
}

/** How many measurements a line holds, over all its references. */
function cashLineMeasurements(line: CashLine): number {
  return line.references.reduce((sum, reference) => sum + reference.amounts.length, 0);
}

/**
 * The lines of one page: whole lines from `start` while their measurements
 * fit in `limit`, as `limit` counts rows on the latest page. A line is never
 * split, so a line with more measurements than `limit` is a page of its own.
 */
export function cashPageLines(
  lines: readonly KeyedCashLine[],
  start: number,
  limit: number,
): KeyedCashLine[] {
  const page: KeyedCashLine[] = [];
  let measurements = 0;
  for (const entry of lines.slice(start)) {
    const count = cashLineMeasurements(entry.line);
    if (page.length > 0 && measurements + count > limit) break;
    page.push(entry);
    measurements += count;
  }
  return page;
}
