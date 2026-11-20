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
  BalanceHistoryRow,
  BalanceHistorySummaryPage,
  BalanceListLatestReason,
  BalanceListPage,
  BalanceListSummaryMetric,
  BalanceListSummaryPage,
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
import {
  BALANCE_LIST_SUMMARY_BYTES,
  BALANCE_LIST_SUMMARY_LINES,
  BALANCE_READ_DETAILS,
} from "../../../observation-shared/src/api-contract.ts";

export { BALANCE_READ_DETAILS };

/** The detail a request names; absent is `summary`, anything else is null (the caller refuses it). */
export function readDetail(text: string | null): BalanceReadDetail | null {
  if (text === null) return "summary";
  return (BALANCE_READ_DETAILS as readonly string[]).includes(text)
    ? (text as BalanceReadDetail)
    : null;
}

/** A quantity as one summary value: the exact decimal text, or no value and its reason. */
function summaryAmount(
  quantity: Pick<ObservedQuantityWire, "normalized" | "unitReference">,
): SummaryAmount {
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
    /** The entry's ref, keyed by everything it says. */
    refOf(entry: Entry): string {
      const text = JSON.stringify(entry);
      let ref = refs.get(text);
      if (ref === undefined) {
        ref = `${prefix}${entries.length + 1}`;
        refs.set(text, ref);
        entries.push({ ref, ...entry });
      }
      return ref;
    },
  };
}

/** What one summary line reads: its row, the id that reads it, and its value with its unit. */
interface LineInput {
  observationId: number;
  quantity: Pick<ObservedQuantityWire, "normalized" | "unitReference">;
  row: BalanceRow;
}

/** A v2 row's metric entry: the provider metric within its source, with the registry's id for it. */
const registryMetric = (
  item: LineInput & { metric: { metricId: string } },
): Omit<SummaryMetric, "ref"> => ({
  source: item.row.source_id,
  metric: item.metric.metricId,
  providerMetric: item.row.metric,
});

/**
 * A page's lines with its accounts and metrics named once each. An account is
 * one provider account (`sourceAccount`, the key the read's `account` filter
 * takes) within its source, with the entity and label its organization gives,
 * or null for both when that is unavailable; the same provider account
 * organized two ways on one page is two entries. A metric is what `metricOf`
 * says of the row (on the v2 pages, one provider metric within its source
 * with the registry's id for it), one entry per distinct entry.
 */
function lines<Item extends LineInput, Line, Metric extends object>(
  items: readonly Item[],
  metricOf: (item: Item) => Metric,
  extra: (item: Item) => Line,
): {
  accounts: SummaryAccount[];
  metrics: (Metric & { ref: string })[];
  items: (BalanceSummaryLine & Line)[];
} {
  const accounts = refTable<Omit<SummaryAccount, "ref">>("a");
  const metrics = refTable<Metric>("m");
  const out = items.map((item) => {
    const organized = item.row.organization?.account ?? null;
    return {
      observationId: item.observationId,
      // Keyed by everything the entry says: two rows of one provider account
      // organized differently (a history row recorded under an older mapping,
      // or one whose organization is unavailable) get two refs, so a line
      // never resolves to an account, a label or a mapping state its row
      // does not carry. A metric entry is keyed the same way.
      account: accounts.refOf({
        source: item.row.source_id,
        sourceAccount: item.row.source_account,
        account: organized?.targetId ?? null,
        label: organized?.label ?? null,
        status: organized?.status ?? null,
        lineage: item.row.organization?.lineage ?? null,
      }),
      metric: metrics.refOf(metricOf(item)),
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
    ...lines(items, registryMetric, (item) => ({
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
    ...lines(items, registryMetric, (item) => ({ reasons: historyReasons(item.row) })),
    ...rest,
  };
}

/** A history row's reasons: `parse:superseded` and `parse:<status>`, none for a current `ok` parse. */
function historyReasons(row: BalanceHistoryRow): BalanceHistoryReason[] {
  const status = Object.hasOwn(PARSE_STATUS_REASONS, row.parse_status)
    ? PARSE_STATUS_REASONS[row.parse_status]!
    : null;
  if (status === null) throw new Error("balance_history_parse_status_unknown");
  return [
    ...(row.superseded_by_parse_run_id === null ? [] : ["parse:superseded" as const]),
    ...status,
  ];
}

/** A v1 row as a summary line's input: its own id, and its stored decimal under its row's unit. */
function listLineInput<Row extends BalanceRow>(row: Row): LineInput & { row: Row } {
  // Every row the central store lists carries its stored decimal; a row
  // without one has no value the summary could state, so it is refused,
  // never written as missing or zero (INV05).
  if (row.normalized === undefined) throw new Error("balance_list_decimal_missing");
  return {
    observationId: row.id,
    quantity: { normalized: row.normalized, unitReference: row.instrument || null },
    row,
  };
}

/**
 * A v1 row's metric entry: the provider metric within its source and the
 * closed codes of the interpretation the full answer gives the row. A row
 * without one is refused: the central store interprets every row it lists.
 */
function interpretedMetric(item: LineInput): Omit<BalanceListSummaryMetric, "ref"> {
  const semantic = item.row.interpretation?.semantic;
  if (semantic === undefined) throw new Error("balance_list_interpretation_missing");
  return {
    source: item.row.source_id,
    providerMetric: item.row.metric,
    kind: semantic.kind,
    measurementKind: semantic.measurementKind ?? null,
    assetClass: semantic.assetClass ?? null,
    timeBasis: semantic.timeBasis ?? null,
  };
}

/** The bytes `value` serializes to as JSON, in UTF-8. */
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

/**
 * The summary of one `GET /api/balances` answer (the v1 grouped list), read
 * at `offset` (history) and `latestOffset` (latest). Its lines are the first
 * rows of each list, latest and history taken in turn, at most
 * `BALANCE_LIST_SUMMARY_LINES` of each, stopping before the line that would
 * take the page past `BALANCE_LIST_SUMMARY_BYTES` (the first line is always
 * kept, so a page always moves on). Accounts and metrics are named once per
 * page across both lists. Each list's next offset is where its next summary
 * page starts, null when neither this window nor the full answer has more.
 * A latest line keeps the ids its group folded in (`duplicates`) and its
 * conflict; a history line its parse reasons. The interpretation's label
 * and reason text and `interpretationContext` are in `full` only.
 */
export function balanceListSummary(
  page: BalanceListPage,
  at: { offset: number; latestOffset: number },
): BalanceListSummaryPage {
  type Entry =
    | { list: "latest"; input: LineInput & { row: BalanceRow } }
    | { list: "history"; input: LineInput & { row: BalanceHistoryRow } };
  const order: Entry[] = [];
  for (let index = 0; index < BALANCE_LIST_SUMMARY_LINES; index++) {
    const latest = page.latest[index];
    const history = page.history[index];
    if (latest) order.push({ list: "latest", input: listLineInput(latest) });
    if (history) order.push({ list: "history", input: listLineInput(history) });
  }
  const next = (shown: number, rows: number, more: number | null, offset: number) =>
    shown < rows || more !== null ? offset + shown : null;
  const build = (count: number): BalanceListSummaryPage => {
    const kept = order.slice(0, count);
    // Each list's own fields are added below, per list.
    const built = lines(
      kept.map((entry) => entry.input),
      interpretedMetric,
      () => ({}),
    );
    const latest: BalanceListSummaryPage["latest"] = [];
    const history: BalanceListSummaryPage["history"] = [];
    for (const [index, entry] of kept.entries()) {
      const line = built.items[index]!;
      if (entry.list === "latest") {
        const interpretation = entry.input.row.interpretation!;
        latest.push({
          ...line,
          duplicates: interpretation.evidence
            .map((member) => member.id)
            .filter((id) => id !== line.observationId),
          reasons: interpretation.conflict
            ? ["interpretation:conflict" satisfies BalanceListLatestReason]
            : [],
        });
      } else history.push({ ...line, reasons: historyReasons(entry.input.row) });
    }
    const nextOffset = next(
      history.length,
      page.history.length,
      page.coverage.nextOffset,
      at.offset,
    );
    const latestNextOffset = next(
      latest.length,
      page.latest.length,
      page.coverage.latestNextOffset,
      at.latestOffset,
    );
    return {
      detail: "summary",
      accounts: built.accounts,
      metrics: built.metrics,
      latest,
      history,
      coverage: {
        limit: BALANCE_LIST_SUMMARY_LINES,
        truncated: nextOffset !== null || latestNextOffset !== null,
        nextOffset,
        latestNextOffset,
      },
    };
  };
  let summary = build(Math.min(1, order.length));
  for (let count = 2; count <= order.length; count++) {
    const wider = build(count);
    if (jsonBytes(wider) > BALANCE_LIST_SUMMARY_BYTES) break;
    summary = wider;
  }
  return summary;
}
