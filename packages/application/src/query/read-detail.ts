// The `summary` detail of the large reads (ADR 0123): one short line per row,
// derived from the read's own `full` answer, so the route and its MCP tool
// (ADR 0081) answer the summary from the same service result and nothing is
// read or computed twice. A summary drops provenance, never meaning: each
// line keeps the id that reads the row in full or as evidence, every unit,
// and every non-exact value's reason (INV05). No amount is added up here.
import { decimalToString } from "../../../domain/src/values.ts";
import type {
  BalanceHistoryPage,
  BalanceHistoryReason,
  BalanceHistorySummaryPage,
  BalanceReadDetail,
  BalanceRow,
  BalanceSummaryLine,
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
 * or null for both when that is unavailable; the same provider account
 * organized two ways on one page is two entries. A metric is one provider
 * metric within its source, with the registry's id for it.
 */
function lines<Item extends LineInput, Line>(
  items: readonly Item[],
  extra: (item: Item) => Line,
): {
  accounts: SummaryAccount[];
  metrics: SummaryMetric[];
  items: (BalanceSummaryLine & Line)[];
} {
  const accounts = refTable<Omit<SummaryAccount, "ref">>("a");
  const metrics = refTable<Omit<SummaryMetric, "ref">>("m");
  const out = items.map((item) => {
    const organized = item.row.organization?.account ?? null;
    const entry: Omit<SummaryAccount, "ref"> = {
      source: item.row.source_id,
      sourceAccount: item.row.source_account,
      account: organized?.targetId ?? null,
      label: organized?.label ?? null,
      status: organized?.status ?? null,
      lineage: item.row.organization?.lineage ?? null,
    };
    return {
      observationId: item.observationId,
      // Keyed by everything the entry says: two rows of one provider account
      // organized differently (a history row recorded under an older mapping,
      // or one whose organization is unavailable) get two refs, so a line
      // never resolves to an account, a label or a mapping state its row
      // does not carry.
      account: accounts.refOf(
        [
          entry.source,
          entry.sourceAccount,
          entry.account,
          entry.label,
          entry.status,
          entry.lineage,
        ],
        () => entry,
      ),
      metric: metrics.refOf([item.row.source_id, item.row.metric, item.metric.metricId], () => ({
        source: item.row.source_id,
        metric: item.metric.metricId,
        providerMetric: item.row.metric,
      })),
      amount: summaryAmount(item.quantity),
      asOf: item.row.as_of,
      ...extra(item),
    };
  });
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

/**
 * The reason of each parse run status that is not `ok`: the closed set
 * `parse_runs.status` allows (migration 0017's CHECK). A status outside it is
 * refused, never passed on as a code nobody defined.
 */
const PARSE_STATUS_REASONS: Readonly<Record<string, readonly BalanceHistoryReason[]>> = {
  ok: [],
  pending: ["parse:pending"],
  error: ["parse:error"],
};

/**
 * The summary of one balance history page. History keeps superseded and
 * failed parses' rows beside current ones, so each line says which it is
 * (`parse:superseded`, `parse:<status>`); a line with neither is a row of a
 * current successful parse.
 */
export function balanceHistorySummary(page: BalanceHistoryPage): BalanceHistorySummaryPage {
  const { items, schemaVersion, interpretationContext: _context, ...rest } = page;
  return {
    schemaVersion,
    detail: "summary",
    ...lines(items, (item) => {
      const status = Object.hasOwn(PARSE_STATUS_REASONS, item.row.parse_status)
        ? PARSE_STATUS_REASONS[item.row.parse_status]!
        : null;
      if (status === null) throw new Error("balance_history_parse_status_unknown");
      return {
        reasons: [
          ...(item.row.superseded_by_parse_run_id === null ? [] : ["parse:superseded" as const]),
          ...status,
        ],
      };
    }),
    ...rest,
  };
}
