import { useMemo, type ReactNode } from "react";
import {
  createColumnHelper,
  createSortedRowModel,
  rowSortingFeature,
  sortFn_text,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { useTransactions, type TransactionRow } from "../api.ts";
import {
  Amount,
  Nullable,
  ObservationLink,
  Panel,
  QueryBoundary,
} from "../ui.tsx";
import {
  EMPTY_FILTERS,
  matchesDates,
  matchesSourceAccount,
  pageWindow,
} from "../filters.ts";
import { Pager, RecordControls } from "./ViewControls.tsx";
import { useViewState } from "../view-state.tsx";
const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { text: sortFn_text },
});
const helper = createColumnHelper<typeof features, TransactionRow>();
const columns = helper.columns([
  helper.accessor((row) => row.as_of ?? "", {
    id: "date",
    header: "取引の基準日",
    sortFn: "text",
    cell: (info) => <Nullable value={info.row.original.as_of} />,
  }),
  helper.accessor((row) => row.description ?? "", {
    id: "description",
    header: "内容",
    sortFn: "text",
    cell: (info) => (
      <>
        <Nullable value={info.row.original.description} />
        {info.row.original.counterparty ? (
          <div className="dim">{info.row.original.counterparty}</div>
        ) : null}
      </>
    ),
  }),
  helper.accessor((row) => row.source_id, {
    id: "source",
    header: "取得元",
    sortFn: "text",
    cell: (info) => info.row.original.source_id,
  }),
  helper.accessor((row) => row.source_account, {
    id: "account",
    header: "口座",
    sortFn: "text",
    cell: (info) => info.row.original.source_account,
  }),
  helper.display({
    id: "amount",
    header: "金額",
    cell: (info) => (
      <Amount
        minor={info.row.original.amount_minor}
        unit={info.row.original.currency}
        text={info.row.original.amount_text}
      />
    ),
  }),
  helper.accessor((row) => row.status ?? "", {
    id: "status",
    header: "取得元の状態",
    sortFn: "text",
    cell: (info) => <Nullable value={info.row.original.status} />,
  }),
  helper.display({
    id: "detail",
    header: "記録",
    cell: (info) => (
      <ObservationLink kind="transaction" id={info.row.original.id}>
        詳細
      </ObservationLink>
    ),
  }),
]);
export function TransactionsPage(): ReactNode {
  const query = useTransactions();
  return (
    <>
      <div className="page-head">
        <h1>取引</h1>
        <p className="lede">入出金の記録を、取得元・口座・日付から探せます。</p>
      </div>
      <QueryBoundary
        query={query}
        label="取引"
        isEmpty={(data) => data.transactions.length === 0}
        empty="表示できる取引がまだありません。取り込んだ記録はここに表示されます。"
      >
        {(data) => <TransactionsTable rows={data.transactions} />}
      </QueryBoundary>
    </>
  );
}
function TransactionsTable({ rows }: { rows: TransactionRow[] }): ReactNode {
  const [filters, setFilters] = useViewState("transactions.filters");
  const [search, setSearch] = useViewState("transactions.search");
  const [page, setPage] = useViewState("transactions.page");
  const [sorting, setSorting] = useViewState("transactions.sorting");
  const filtered = useMemo(
    () =>
      rows.filter(
        (row) =>
          matchesSourceAccount(row, filters) &&
          matchesDates(row.as_of, filters.from, filters.to) &&
          (!search.trim() ||
            [
              row.description,
              row.counterparty,
              row.external_id,
              row.source_id,
              row.source_account,
            ].some((value) =>
              value
                ?.toLocaleLowerCase()
                .includes(search.trim().toLocaleLowerCase()),
            )),
      ),
    [rows, filters, search],
  );
  const table = useTable({
    features,
    columns,
    data: filtered,
    state: { sorting },
    onSortingChange: (update) => {
      setSorting(update);
      setPage(0);
    },
    enableSortingRemoval: true,
  });
  const view = pageWindow(table.getRowModel().rows, page);
  return (
    <Panel
      id="transactions"
      title="取引の記録"
      count={`受信した${rows.length}件から絞り込み`}
    >
      <div className="panel-body">
        <RecordControls
          rows={rows}
          filters={filters}
          dates
          onChange={(value) => {
            setFilters(value);
            setPage(0);
          }}
        />
        <div className="toolbar">
          <label className="filter-field">
            内容を検索
            <input
              className="filter-input"
              type="search"
              value={search}
              placeholder="内容・相手先・識別番号"
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(0);
              }}
            />
          </label>
          <button
            className="button"
            type="button"
            onClick={() => {
              setFilters(EMPTY_FILTERS);
              setSearch("");
              setSorting([]);
              setPage(0);
            }}
          >
            条件をクリア
          </button>
        </div>
        {filters.from && filters.to && filters.from > filters.to ? (
          <p role="alert">開始日を終了日以前にしてください。</p>
        ) : null}
      </div>
      <div className="table-scroll">
        <table>
          <caption className="dim">
            解析済みの現行データです。同じ取引に由来する記録が複数含まれる場合があります。
          </caption>
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => {
                  const sorted = header.column.getIsSorted();
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      className={header.column.id === "amount" ? "num" : ""}
                      aria-sort={
                        sorted === "asc"
                          ? "ascending"
                          : sorted === "desc"
                            ? "descending"
                            : "none"
                      }
                    >
                      {header.column.getCanSort() ? (
                        <button
                          className="sort-button"
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                        >
                          <table.FlexRender header={header} />
                          <span aria-hidden="true">
                            {sorted === "asc"
                              ? " ↑"
                              : sorted === "desc"
                                ? " ↓"
                                : " ↕"}
                          </span>
                        </button>
                      ) : (
                        <table.FlexRender header={header} />
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {view.rows.length ? (
              view.rows.map((row) => (
                <tr key={row.id}>
                  {row.getAllCells().map((cell) => (
                    <td
                      key={cell.id}
                      className={
                        cell.column.id === "amount"
                          ? "num"
                          : cell.column.id === "description"
                            ? "wrap"
                            : ""
                      }
                    >
                      <table.FlexRender cell={cell} />
                    </td>
                  ))}
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={columns.length}>
                  条件に合う取引がありません。条件を変えてお試しください。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <Pager {...view} total={filtered.length} onChange={setPage} />
      <details className="detail-disclosure">
        <summary>表示範囲と日付について</summary>
        <p>
          APIから受信した全{rows.length}
          件をブラウザー内で絞り込み、50件ずつ表示しています。サーバーから次の50件を取得する仕組みではありません。この件数だけでは金融機関の全履歴が揃っているかは判断できません。
        </p>
        <p>
          日付は取得元の基準日（as_of）をそのまま表示します。期間指定時は記録された年月日で比較し、日付不明の記録は除外します。タイムゾーンの換算はしません。金額は保存値を保ち、異なる通貨での並べ替え・合算は行いません。
        </p>
        <p>
          取引番号・解析方法・原本への経路は各記録の「詳細」で確認できます。
        </p>
      </details>
    </Panel>
  );
}
