import { useState, type ReactNode } from "react";
import { useBalances, type BalanceHistoryRow, type BalanceRow } from "../api.ts";
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
  const rows = [...latest, ...history];
  return (
    <>
      <section className="panel">
        <div className="panel-body">
          <RecordControls rows={rows} filters={filters} onChange={setFilters} />
          <button className="button" type="button" onClick={() => setFilters(EMPTY_FILTERS)}>
            条件をクリア
          </button>
        </div>
      </section>
      <BalanceTable
        key={`latest:${filters.source}:${filters.account}`}
        rows={latest.filter((row) => matchesSourceAccount(row, filters))}
      />
      <details className="detail-disclosure">
        <summary>過去の残高・再解析の履歴</summary>
        <BalanceTable
          key={`history:${filters.source}:${filters.account}`}
          rows={history.filter((row) => matchesSourceAccount(row, filters))}
          history
        />
      </details>
      <details className="detail-disclosure">
        <summary>「最新」の選び方と表示範囲</summary>
        <p>
          取得元・口座・残高の種類・通貨や単位が同じ記録から、基準日（as_of）、基準日がない場合は取得元での観測日時（observed_at）を使って選んでいます。同じ日時は記録番号で並べます。両日時は意味が異なるため、実際の測定時刻が最も新しいことを保証するものではありません。
        </p>
        <p>
          過去の履歴には旧解析の記録も残っています。金額は合算・換算せず、保存値をそのまま表示します。APIの全件応答をブラウザー内で絞り込み、各表は50件ずつ表示します。金融機関の全履歴が揃っていることを表す件数ではありません。
        </p>
      </details>
    </>
  );
}
function BalanceTable({
  rows,
  history = false,
}: {
  rows: BalanceRow[] | BalanceHistoryRow[];
  history?: boolean;
}): ReactNode {
  const [page, setPage] = useState(0);
  const view = pageWindow<BalanceRow | BalanceHistoryRow>(rows, page);
  return (
    <Panel
      id={history ? "balance-history" : "latest-balances"}
      title={history ? "保存された残高の履歴" : "項目ごとの最新の記録"}
      count={`${rows.length}件`}
      note={
        history
          ? "旧解析の記録も、根拠を確認できるように保持しています。"
          : "種類や通貨が異なる残高は、それぞれ独立した記録です。"
      }
    >
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {[
                "取得元・口座",
                "残高の種類",
                "金額",
                "基準日",
                "取得元の観測日時",
                ...(history ? ["解析・履歴"] : []),
                "記録",
              ].map((label) => (
                <th scope="col" key={label} className={label === "金額" ? "num" : ""}>
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
                  <td>
                    {row.source_id}
                    <div className="dim">{row.source_account}</div>
                  </td>
                  <td>
                    {row.metric} <Badge>{row.instrument}</Badge>
                  </td>
                  <td className="num">
                    <Amount minor={row.amount_minor} unit={row.instrument} text={row.amount_text} />
                  </td>
                  <td>
                    <Nullable value={row.as_of} />
                  </td>
                  <td>
                    <Nullable value={row.observed_at} />
                  </td>
                  {history && "parse_status" in row ? (
                    <td>
                      <StatusBadge status={row.parse_status} />
                      <LineageBadge supersededBy={row.superseded_by_parse_run_id} />
                    </td>
                  ) : null}
                  <td>
                    <ObservationLink kind="balance" id={row.id}>
                      詳細
                    </ObservationLink>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={history ? 7 : 6}>
                  表示できる残高がありません。口座や取得元の条件をご確認ください。
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
