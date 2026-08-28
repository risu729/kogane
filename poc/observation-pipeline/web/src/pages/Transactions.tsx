// Transactions — every current transaction observation.
//
// "Current" is the parse run predicate the API applies for us:
// `superseded_by_parse_run_id IS NULL AND status = 'ok'`. Nothing superseded
// reaches this page; superseded rows stay reachable, and marked, through the
// artifact they came from.
//
// Sorting and filtering happen in the browser over the rows the API already
// returned. Neither is a query, so neither can change which observations count
// as current.

import { useMemo, useState, type ReactNode } from "react";
import {
  columnFilteringFeature,
  createColumnHelper,
  createFilteredRowModel,
  createSortedRowModel,
  filterFn_includesString,
  globalFilteringFeature,
  rowSortingFeature,
  sortFn_basic,
  sortFn_text,
  tableFeatures,
  useTable,
  type SortingState,
} from "@tanstack/react-table";
import { useTransactions, type TransactionRow } from "../api.ts";
import { Amount, Nullable, ObservationLink, Panel, QueryBoundary } from "../ui.tsx";

const features = tableFeatures({
  columnFilteringFeature,
  globalFilteringFeature,
  rowSortingFeature,
  filteredRowModel: createFilteredRowModel(),
  sortedRowModel: createSortedRowModel(),
  filterFns: { includesString: filterFn_includesString },
  sortFns: { basic: sortFn_basic, text: sortFn_text },
});

const helper = createColumnHelper<typeof features, TransactionRow>();

// Accessors coerce a null to "" for sorting and filtering only; every cell
// renders the stored value, so an absent field still reads as absent.
// `helper.columns` keeps each column's own value type instead of widening the
// array to one shared TValue.
const columns = helper.columns([
  helper.display({
    id: "obs",
    header: "obs",
    cell: (info) => <ObservationLink kind="transaction" id={info.row.original.id} />,
  }),
  helper.accessor((row) => row.source_id, {
    id: "source",
    header: "source",
    sortFn: "text",
    cell: (info) => info.row.original.source_id,
  }),
  helper.accessor((row) => row.source_account, {
    id: "account",
    header: "account",
    sortFn: "text",
    cell: (info) => info.row.original.source_account,
  }),
  helper.accessor((row) => row.as_of ?? "", {
    id: "as_of",
    header: "as_of",
    sortFn: "text",
    cell: (info) => <Nullable value={info.row.original.as_of} />,
  }),
  helper.accessor((row) => row.amount_minor, {
    id: "amount",
    header: "amount",
    sortFn: "basic",
    enableGlobalFilter: false,
    cell: (info) => {
      const row = info.row.original;
      return <Amount minor={row.amount_minor} unit={row.currency} text={row.amount_text} />;
    },
  }),
  helper.accessor((row) => row.currency ?? "", {
    id: "currency",
    header: "ccy",
    sortFn: "text",
    cell: (info) => <Nullable value={info.row.original.currency} />,
  }),
  helper.accessor((row) => row.description ?? "", {
    id: "description",
    header: "description",
    sortFn: "text",
    cell: (info) => <Nullable value={info.row.original.description} />,
  }),
  helper.accessor((row) => row.counterparty ?? "", {
    id: "counterparty",
    header: "counterparty",
    sortFn: "text",
    cell: (info) => <Nullable value={info.row.original.counterparty} />,
  }),
  helper.accessor((row) => row.external_id ?? "", {
    id: "external_id",
    header: "external_id",
    sortFn: "text",
    cell: (info) => <Nullable value={info.row.original.external_id} />,
  }),
  helper.accessor((row) => row.parser, {
    id: "parser",
    header: "parser",
    sortFn: "text",
    cell: (info) => info.row.original.parser,
  }),
]);

const NUMERIC_COLUMNS = new Set(["amount"]);
const WIDE_COLUMNS = new Set(["description", "counterparty"]);
// Identifiers and timestamps are read character by character, so a wrap in the
// middle of one is a misreading waiting to happen.
const NOWRAP_COLUMNS = new Set([
  "obs",
  "source",
  "account",
  "as_of",
  "currency",
  "external_id",
  "parser",
]);

const SORT_ARROW: Record<string, string> = { asc: "▲", desc: "▼" };

export function TransactionsPage(): ReactNode {
  const query = useTransactions();
  return (
    <>
      <div className="page-head">
        <h1>Transactions</h1>
        <p className="lede">
          Current transaction observations: those whose parse run succeeded and
          which nothing has superseded.
        </p>
      </div>
      <QueryBoundary
        query={query}
        label="transactions"
        isEmpty={(data) => data.transactions.length === 0}
        empty="No current transaction observations. Run bun run demo to populate the store."
      >
        {(data) => <TransactionsTable rows={data.transactions} />}
      </QueryBoundary>
    </>
  );
}

function TransactionsTable({ rows }: { rows: TransactionRow[] }): ReactNode {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const data = useMemo(() => rows, [rows]);

  const table = useTable({
    features,
    columns,
    data,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    globalFilterFn: "includesString",
    enableSortingRemoval: true,
  });

  const visible = table.getRowModel().rows;

  return (
    <Panel
      id="transactions"
      title="Current transaction observations"
      count={`${String(visible.length)} of ${String(rows.length)} rows`}
    >
      <div className="toolbar">
        <label htmlFor="tx-filter" className="mono">
          filter
        </label>
        <input
          id="tx-filter"
          className="filter-input"
          type="search"
          value={globalFilter}
          placeholder="substring across all text columns"
          onChange={(event) => {
            setGlobalFilter(event.target.value);
          }}
        />
        <button
          type="button"
          className="button"
          onClick={() => {
            setGlobalFilter("");
            setSorting([]);
          }}
        >
          reset
        </button>
        <span className="count">click a column heading to sort</span>
      </div>

      <div className="table-scroll">
        <table>
          <caption className="dim">
            Current transaction observations, one row per observation. Sorting the
            amount column orders by integer minor units, which are not comparable
            between currencies; the currency column is shown beside it for that
            reason.
          </caption>
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const sorted = header.column.getIsSorted();
                  const canSort = header.column.getCanSort();
                  const className = NUMERIC_COLUMNS.has(header.column.id) ? "num" : "";
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      className={className}
                      aria-sort={
                        sorted === "asc"
                          ? "ascending"
                          : sorted === "desc"
                            ? "descending"
                            : "none"
                      }
                    >
                      {header.isPlaceholder ? null : canSort ? (
                        <button
                          type="button"
                          className="sort-button"
                          onClick={header.column.getToggleSortingHandler()}
                        >
                          <table.FlexRender header={header} />
                          <span className="sort-arrow" aria-hidden="true">
                            {sorted === false ? "↕" : (SORT_ARROW[sorted] ?? "↕")}
                          </span>
                        </button>
                      ) : (
                        <span className="th-label">
                          <table.FlexRender header={header} />
                        </span>
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="dim">
                  No row matches “{globalFilter}”.
                </td>
              </tr>
            ) : (
              visible.map((row) => (
                <tr key={row.id}>
                  {row.getAllCells().map((cell) => {
                    const id = cell.column.id;
                    const className = NUMERIC_COLUMNS.has(id)
                      ? "num"
                      : WIDE_COLUMNS.has(id)
                        ? "wrap"
                        : NOWRAP_COLUMNS.has(id)
                          ? "nowrap"
                          : "";
                    return (
                      <td key={cell.id} className={className}>
                        <table.FlexRender cell={cell} />
                      </td>
                    );
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="footnote" style={{ padding: "0.5rem 0.75rem" }}>
        <code>external_id</code> is what the provider said, not a logical identity. A
        pending row and its posted row are related by a recorded link, never by an
        update — and no such link exists yet, so two rows here may describe one
        event.
      </p>
    </Panel>
  );
}
