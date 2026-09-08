import { useState, type ReactNode } from "react";
import { useMetadata, useBalances, type BalanceHistoryRow, type BalanceRow } from "../api.ts";
import {
  Amount,
  Badge,
  LineageBadge,
  Nullable,
  ObservationLink,
  Panel,
  QueryBoundary,
  StatusBadge,
} from "../ui.tsx";
import { EMPTY_FILTERS, matchesSourceAccount, pageWindow } from "../filters.ts";
import { Pager, RecordControls } from "./ViewControls.tsx";
import { useViewState } from "../view-state.tsx";
import { OrganizedInstrumentContext, OrganizedSourceAccount } from "../organization.tsx";
export function BalancesPage(): ReactNode {
  const query = useBalances();
  return (
    <>
      <div className="page-head">
        <h1>残高</h1>
        <p className="lede">
          口座ごとに、取得元が報告した残高を確認できます。通貨や残高の種類を分けて表示しています。
        </p>
      </div>
      <QueryBoundary query={query} label="残高">
        {(data) => <BalancesBody latest={data.latest} history={data.history} />}
      </QueryBoundary>
    </>
  );
}
function BalancesBody({
  latest,
  history,
}: {
  latest: BalanceRow[];
  history: BalanceHistoryRow[];
}): ReactNode {
  const [filters, setFilters] = useViewState("balances.filters");
  const production = useMetadata().data?.source.kind === "central-store";
  const [instrument, setInstrument] = useViewState("balances.instrument");
  const [metric, setMetric] = useViewState("balances.metric");
  const rows = [...latest, ...history];
  const instruments = [...new Set(rows.map((row) => row.instrument))].sort();
  const metrics = [...new Set(rows.map((row) => row.metric))].sort();
  const matches = (row: BalanceRow) =>
    matchesSourceAccount(row, filters) &&
    (!instrument || row.instrument === instrument) &&
    (!metric || row.metric === metric);
  const selectionKey = JSON.stringify([filters.source, filters.account, instrument, metric]);
  return (
    <>
      {!production ? (
        <section className="panel">
          <div className="panel-body">
            <RecordControls rows={rows} filters={filters} onChange={setFilters} />
            <div className="filter-grid">
              {[
                {
                  label: "通貨・単位",
                  value: instrument,
                  options: instruments,
                  setValue: setInstrument,
                },
                { label: "残高の種類", value: metric, options: metrics, setValue: setMetric },
              ].map(({ label, value, options, setValue }) => (
                <label className="filter-field" key={label}>
                  {label}
                  <select
                    aria-label={label}
                    value={value}
                    onChange={(event) => setValue(event.target.value)}
                  >
                    <option value="">すべて</option>
                    {value && !options.includes(value) ? (
                      <option value={value}>{value}（今回の記録に含まれません）</option>
                    ) : null}
                    {options.map((option) => (
                      <option key={option}>{option}</option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <button
              className="button"
              type="button"
              onClick={() => {
                setFilters(EMPTY_FILTERS);
                setInstrument("");
                setMetric("");
              }}
            >
              条件をクリア
            </button>
          </div>
        </section>
      ) : null}
      <BalanceTable
        key={`latest:${selectionKey}`}
        rows={latest.filter(matches)}
        available={latest.length}
      />
      <details className="detail-disclosure">
        <summary>過去の残高・再解析の履歴</summary>
        <BalanceTable
          key={`history:${selectionKey}`}
          rows={history.filter(matches)}
          available={history.length}
          history
        />
      </details>
      <details className="detail-disclosure">
        <summary>「最新」の選び方と表示範囲</summary>
        <p>
          取得元・口座・残高の種類・通貨や単位が同じ記録から、基準日（as_of）、基準日がない場合は取得元での観測日時（observed_at）を使って選んでいます。同じ日時は記録番号で並べます。両日時は意味が異なるため、実際の測定時刻が最も新しいことを保証するものではありません。
        </p>
        <p>
          過去の履歴には旧解析の記録も残っています。金額は合算・換算せず、保存値をそのまま表示します。受信したページの各表を50件ずつ表示します。金融機関の全履歴が揃っていることを表す件数ではありません。
        </p>
      </details>
    </>
  );
}
function BalanceTable({
  rows,
  history = false,
  available,
}: {
  rows: BalanceRow[] | BalanceHistoryRow[];
  history?: boolean;
  available: number;
}): ReactNode {
  const [page, setPage] = useState(0);
  const view = pageWindow<BalanceRow | BalanceHistoryRow>(rows, page);
  return (
    <Panel
      id={history ? "balance-history" : "latest-balances"}
      title={history ? "保存された残高の履歴" : "項目ごとの最新の記録"}
      count={`${available}件中 ${rows.length}件`}
      note={
        history
          ? "旧解析の記録も、根拠を確認できるように保持しています。"
          : "種類や通貨が異なる残高は、それぞれ独立した記録です。"
      }
    >
      <div
        className="table-scroll"
        role="region"
        aria-label={history ? "残高の履歴" : "最新の残高"}
        tabIndex={0}
      >
        <table className="balance-table">
          <caption>
            基準日は残高が対象とする日付、観測日時は取得元で記録された日時です。それぞれ保存された表記で表示します。
          </caption>
          <thead>
            <tr>
              {[
                { label: "取得元・口座", column: "source" },
                { label: "残高の種類", column: "metric" },
                { label: "金額", column: "amount" },
                { label: "日時", column: "dates" },
                ...(history ? [{ label: "解析・履歴", column: "lineage" }] : []),
                { label: "記録", column: "detail" },
              ].map(({ label, column }) => (
                <th
                  scope="col"
                  key={column}
                  className={`col-${column}${column === "amount" ? " num" : ""}`}
                >
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.rows.length ? (
              view.rows.map((row) => (
                <tr
                  key={row.id}
                  className={
                    "superseded_by_parse_run_id" in row && row.superseded_by_parse_run_id !== null
                      ? "is-superseded"
                      : ""
                  }
                >
                  <td className="col-source">
                    <OrganizedSourceAccount
                      source={row.source_id}
                      account={row.source_account}
                      organization={row.organization}
                    />
                  </td>
                  <td className="col-metric">
                    {row.metric} <Badge>{row.instrument}</Badge>
                    <OrganizedInstrumentContext
                      organization={row.organization}
                      role="unit"
                      original={row.instrument}
                    />
                  </td>
                  <td className="col-amount num">
                    <Amount minor={row.amount_minor} unit={row.instrument} text={row.amount_text} />
                  </td>
                  <td className="col-dates">
                    <dl className="record-dates">
                      <dt>基準日</dt>
                      <dd>
                        <Nullable value={row.as_of} />
                      </dd>
                      <dt>取得元の観測日時</dt>
                      <dd>
                        <Nullable value={row.observed_at} />
                      </dd>
                    </dl>
                  </td>
                  {history && "parse_status" in row ? (
                    <td className="col-lineage">
                      <StatusBadge status={row.parse_status} />
                      <LineageBadge supersededBy={row.superseded_by_parse_run_id} />
                    </td>
                  ) : null}
                  <td className="col-detail">
                    <ObservationLink kind="balance" id={row.id}>
                      詳細
                    </ObservationLink>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={history ? 6 : 5}>
                  {available > 0
                    ? "条件に一致する残高がありません。条件をクリアすると保存された記録を確認できます。"
                    : "表示対象の残高記録がまだありません。残高がゼロであることを意味しません。"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <Pager {...view} total={rows.length} onChange={setPage} />
    </Panel>
  );
}
