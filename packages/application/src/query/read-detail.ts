// The `summary` detail of the large reads (ADR 0123): one short line per row,
// derived from the read's own `full` answer, so the route and its MCP tool
// (ADR 0081) answer the summary from the same service result and nothing is
// read or computed twice. A summary drops provenance, never meaning: each
// line keeps the id that reads the row in full or as evidence, every unit,
// and every non-exact value's reason (INV05). No amount is added up here.
import { decimalToString } from "../../../domain/src/values.ts";
import type {
  BalanceHistoryPage,
  BalanceHistorySummaryItem,
  BalanceHistorySummaryPage,
  BalanceReadDetail,
  BalanceRow,
  LatestBalancePage,
  LatestBalanceSummaryPage,
  ObservedQuantityWire,
  SummaryAccount,
  SummaryAmount,
  SummaryMetric,
} from "../../../observation-shared/src/api-contract.ts";
import { BALANCE_READ_DETAILS } from "../../../observation-shared/src/api-contract.ts";

export { BALANCE_READ_DETAILS };

/** The detail a request names; absent is `summary`, anything else is null (the caller refuses it). */
export function readDetail(text: string | null): BalanceReadDetail | null {
  if (text === null) return "summary";
  return (BALANCE_READ_DETAILS as readonly string[]).includes(text)
    ? (text as BalanceReadDetail)
    : null;
}

/** A quantity as one summary value: the exact decimal text, or no value and its reason. */
function summaryAmount(quantity: ObservedQuantityWire): SummaryAmount {
  const value = quantity.normalized;
  const exact = value.status === "exact" && value.coefficient !== null && value.scale !== null;
  return {
    value: exact ? decimalToString({ coefficient: value.coefficient!, scale: value.scale! }) : null,
    unit: quantity.unitReference,
    status: value.status,
    scale: exact ? value.scale : null,
  };
}

/** Entries kept once per page, each under a page-local ref (`a1`, `m1`, ...) in order of first appearance. */
function refTable<Entry>(prefix: string) {
  const entries: (Entry & { ref: string })[] = [];
  const refs = new Map<string, string>();
  return {
    entries,
    refOf(key: unknown, entry: () => Entry): string {
      const text = JSON.stringify(key);
      let ref = refs.get(text);
      if (ref === undefined) {
        ref = `${prefix}${entries.length + 1}`;
        refs.set(text, ref);
        entries.push({ ref, ...entry() });
      }
      return ref;
    },
  };
}

type LineInput = Pick<
  BalanceHistoryPage["items"][number],
  "observationId" | "quantity" | "metric"
> & {
  row: BalanceRow;
};

/**
 * A page's lines with its accounts and metrics named once each. An account is
 * one provider account (`sourceAccount`, the key the read's `account` filter
 * takes) within its source, with the entity and label its organization gives,
 * or null for both when that is unavailable. A metric is one provider metric
 * within its source, with the registry's id for it.
 */
function lines<Item extends LineInput, Line>(
  items: readonly Item[],
  extra: (item: Item) => Line,
): {
  accounts: SummaryAccount[];
  metrics: SummaryMetric[];
  items: (BalanceHistorySummaryItem & Line)[];
} {
  const accounts = refTable<Omit<SummaryAccount, "ref">>("a");
  const metrics = refTable<Omit<SummaryMetric, "ref">>("m");
  const out = items.map((item) => ({
    observationId: item.observationId,
    account: accounts.refOf([item.row.source_id, item.row.source_account], () => ({
      source: item.row.source_id,
      sourceAccount: item.row.source_account,
      account: item.row.organization?.account?.targetId ?? null,
      label: item.row.organization?.account?.label ?? null,
    })),
    metric: metrics.refOf([item.row.source_id, item.row.metric, item.metric.metricId], () => ({
      source: item.row.source_id,
      metric: item.metric.metricId,
      providerMetric: item.row.metric,
    })),
    amount: summaryAmount(item.quantity),
    asOf: item.row.as_of,
    ...extra(item),
  }));
  return { accounts: accounts.entries, metrics: metrics.entries, items: out };
}

/**
 * The summary of one latest balance page: its rows as lines, with its page,
 * coverage and subtotals as they are. The identity and policy releases
 * (`interpretationContext`) are provenance, in the `full` page only.
 */
export function latestBalanceSummary(page: LatestBalancePage): LatestBalanceSummaryPage {
  const { items, schemaVersion, interpretationContext: _context, ...rest } = page;
  return {
    schemaVersion,
    detail: "summary",
    ...lines(items, (item) => ({
      freshness: item.freshness.state,
      adoption: item.adoption.state,
      reasons: [
        ...(item.adoption.reasonCode === null ? [] : [`adoption:${item.adoption.reasonCode}`]),
        ...(item.freshness.reasonCode === null ? [] : [`freshness:${item.freshness.reasonCode}`]),
      ],
    })),
    ...rest,
  };
}

/** The summary of one balance history page. */
export function balanceHistorySummary(page: BalanceHistoryPage): BalanceHistorySummaryPage {
  const { items, schemaVersion, interpretationContext: _context, ...rest } = page;
  return { schemaVersion, detail: "summary", ...lines(items, () => ({})), ...rest };
}
