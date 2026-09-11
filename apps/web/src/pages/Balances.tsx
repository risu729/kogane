import { useState, type ReactNode } from "react";
import { useFeatures, useBalances, type BalanceHistoryRow, type BalanceRow } from "../api.ts";
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
import { isNormalizedZero } from "../../../shared/normalized-decimal.ts";
import { Pager, RecordControls } from "./ViewControls.tsx";
import { useViewState } from "../view-state.tsx";
import { OrganizedInstrumentContext, OrganizedSourceAccount } from "../organization.tsx";
import {
  BALANCE_GROUPS,
  BalanceEvidence,
  balanceMeaning,
  isPeriodMeasure,
} from "../balance-display.tsx";
import { Link } from "../router.tsx";
import { BalancesLatestPage } from "./BalancesLatest.tsx";
export function BalancesPage({
  view = "balances",
}: {
  view?: "balances" | "summaries";
}): ReactNode {
  // The read model is used when the server advertises it, and the previous
  // list stays in place otherwise; the page never branches on the name of the
  // connection.
  const { balanceReadModel } = useFeatures();
  const query = useBalances(view);
  const summaries = view === "summaries";
  return (
    <>
      <div className="page-head">
        <h1>{summaries ? "期間実績・請求" : "残高"}</h1>
        <p className="lede">
          {summaries
            ? "期間中の獲得実績と請求額です。保有残高・個々の利用明細・支払い済み額とは区別します。"
            : "ある時点の保有残高と参考額です。獲得実績・請求額は含めず、純資産として合算しません。"}
        </p>
        <Link to={summaries ? "/balances" : "/summaries"}>
          {summaries ? "保有残高を見る" : "期間実績・請求を見る"}
        </Link>
      </div>
      {balanceReadModel ? <BalancesLatestPage view={view} /> : null}
      <QueryBoundary query={query} label={summaries ? "実績・請求" : "残高"}>
        {(data) => (
          <BalancesBody
            summaries={summaries}
            latest={data.latest.filter((row) => isPeriodMeasure(row) === summaries)}
            history={data.history.filter((row) => isPeriodMeasure(row) === summaries)}
          />
        )}
      </QueryBoundary>
    </>
  );
}
function BalancesBody({
  latest,
  history,
  summaries,
}: {
  latest: BalanceRow[];
  history: BalanceHistoryRow[];
  summaries: boolean;
}): ReactNode {
  const [filters, setFilters] = useViewState("balances.filters");
  // Client-side record controls only when the server cannot filter for us.
  const { serverFilters } = useFeatures();
  const [instrument, setInstrument] = useViewState("balances.instrument");
  const [metric, setMetric] = useViewState("balances.metric");
  const [hideZero, setHideZero] = useViewState("balances.hideZero");
  const rows = [...latest, ...history];
  const instruments = [...new Set(rows.map((row) => row.instrument))].sort();
  const metrics = [...new Set(rows.map((row) => row.metric))].sort();
  const matches = (row: BalanceRow) =>
    matchesSourceAccount(row, filters) &&
    (!instrument || row.instrument === instrument) &&
    (!metric || row.metric === metric) &&
    (!hideZero || !isNormalizedZero(row.normalized));
  const selectionKey = JSON.stringify([
    filters.source,
    filters.account,
    instrument,
    metric,
    hideZero,
  ]);
  return (
    <>
      {!serverFilters ? (
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
                {
                  label: summaries ? "実績・請求の種類" : "残高の種類",
                  value: metric,
                  options: metrics,
                  setValue: setMetric,
                },
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
                setHideZero(false);
              }}
            >
              条件をクリア
            </button>
          </div>
        </section>
      ) : null}
      <section className="panel" aria-label={summaries ? "実績・請求の表示条件" : "残高の表示条件"}>
        <div className="panel-body">
          <label>
            <input
              type="checkbox"
              checked={hideZero}
              onChange={(event) => setHideZero(event.target.checked)}
            />{" "}
            {summaries ? "0の実績・請求を除外" : "残高0を除外"}
          </label>
          <p className="footnote">
            DBで正規化された金額が0の行を除外します。未記録・解析不能・値の不一致・正規化情報がない行は残します。
          </p>
        </div>
      </section>
      <LatestBalances
        key={`latest:${selectionKey}`}
        rows={latest.filter(matches)}
        available={latest.length}
        summaries={summaries}
      />
      <details className="detail-disclosure">
        <summary>
          {summaries ? "実績・請求の過去の取得・再解析" : "過去の残高・再解析の履歴"}
        </summary>
        <BalanceTable
          key={`history:${selectionKey}`}
          rows={history.filter(matches)}
          available={history.length}
          history
          summaries={summaries}
        />
      </details>
      <details className="detail-disclosure">
        <summary>「最新」の選び方と表示範囲</summary>
        {summaries ? (
          <p>
            MyJCBは最新の取得に含まれる各請求月を表示します。Vポイントは最新の完全な取得の先月分です。請求月と取得日時は別の意味で、先月分の対象年月は未特定です。
          </p>
        ) : null}
        <p>
          取得元・口座・残高の種類・通貨や単位が同じ記録から、基準日（as_of）、基準日がない場合は取得元での観測日時（observed_at）を使って選んでいます。同じ日時は記録番号で並べます。両日時は意味が異なるため、実際の測定時刻が最も新しいことを保証するものではありません。
        </p>
        <p>
          過去の履歴には旧解析の記録も残っています。金額は合算・換算・符号反転せず、保存値をそのまま表示します。最新の記録は受信した範囲を全区分共通で50件ずつ表示します。件数は受信範囲のもので、金融機関の全履歴を表しません。
        </p>
        <p>
          同じ残高であることを確認できた最新の記録は、金額を一度だけ表示し、すべての根拠へのリンクを残します。金額や根拠が一致しない候補は別々に表示します。過去の履歴はまとめません。
        </p>
      </details>
    </>
  );
}
function LatestBalances({
  rows,
  available,
  summaries,
}: {
  rows: BalanceRow[];
  available: number;
  summaries: boolean;
}): ReactNode {
  const [page, setPage] = useState(0);
  const view = pageWindow(rows, page);
  return (
    <section aria-label={summaries ? "最新取得の期間実績・請求" : "項目ごとの最新の記録"}>
      <h2 id="latest-balances">
        {summaries ? "最新取得の期間実績・請求" : "項目ごとの最新の記録"}
      </h2>
      <p className="footnote">
        受信した最新の記録 {available}件中、条件に一致する{rows.length}
        件。各区分の件数はこの表示ページ内です。
      </p>
      {BALANCE_GROUPS.map((group) => {
        const grouped = view.rows.filter((row) =>
          (group.kinds as readonly string[]).includes(balanceMeaning(row).kind),
        );
        return grouped.length ? (
          <BalanceTable
            key={group.id}
            rows={grouped}
            available={grouped.length}
            group={group}
            summaries={summaries}
          />
        ) : null;
      })}
      {!rows.length ? (
        <p>
          {available
            ? "条件に一致する記録がありません。条件をクリアすると保存された記録を確認できます。"
            : "表示対象の記録がまだありません。金額がゼロであることを意味しません。"}
        </p>
      ) : null}
      <Pager {...view} total={rows.length} onChange={setPage} />
    </section>
  );
}
function BalanceTable({
  rows,
  history = false,
  available,
  group,
  summaries = false,
}: {
  rows: BalanceRow[] | BalanceHistoryRow[];
  history?: boolean;
  available: number;
  group?: (typeof BALANCE_GROUPS)[number];
  summaries?: boolean;
}): ReactNode {
  const [page, setPage] = useState(0);
  const view = pageWindow<BalanceRow | BalanceHistoryRow>(rows, group ? 0 : page);
  return (
    <Panel
      id={history ? "balance-history" : `balance-${group?.id}`}
      title={history ? (summaries ? "実績・請求の取得履歴" : "保存された残高の履歴") : group?.title}
      count={group ? `このページ内 ${rows.length}件` : `${available}件中 ${rows.length}件`}
      note={history ? "旧解析の記録も、根拠を確認できるように保持しています。" : group?.note}
    >
      <div
        className="table-scroll"
        role="region"
        aria-label={
          history ? (summaries ? "実績・請求の履歴" : "残高の履歴") : `${group?.title}の記録`
        }
        tabIndex={0}
      >
        <table className="balance-table">
          <caption>
            金額・日時は保存された表記です。観測日時が取得時刻を表す場合もあり、現在残高や決済完了の保証ではありません。
          </caption>
          <thead>
            <tr>
              {[
                { label: "取得元・口座", column: "source" },
                { label: summaries ? "実績・請求の種類" : "残高の種類", column: "metric" },
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
                    {balanceMeaning(row).label} <Badge>{row.instrument}</Badge>
                    <div className="table-secondary">{row.metric}</div>
                    <details>
                      <summary>金額の意味</summary>
                      {balanceMeaning(row).reason}
                    </details>
                    <OrganizedInstrumentContext
                      organization={row.organization}
                      role="unit"
                      original={row.instrument}
                    />
                  </td>
                  <td
                    className={`col-amount num${balanceMeaning(row).kind !== "asset" ? " balance-reference-amount" : ""}`}
                  >
                    <Amount minor={row.amount_minor} unit={row.instrument} text={row.amount_text} />
                  </td>
                  <td className="col-dates">
                    <dl className="record-dates">
                      <dt>
                        {balanceMeaning(row).kind === "statement"
                          ? "請求月"
                          : balanceMeaning(row).kind === "period_total"
                            ? "対象期間"
                            : "基準日"}
                      </dt>
                      <dd>
                        {balanceMeaning(row).kind === "period_total" ? (
                          "先月分（対象年月は未特定）"
                        ) : (
                          <Nullable value={row.as_of} />
                        )}
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
                    {!history ? <BalanceEvidence row={row} /> : null}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={history ? 6 : 5}>
                  {available > 0
                    ? "条件に一致する記録がありません。条件をクリアすると保存された記録を確認できます。"
                    : "表示対象の記録がまだありません。金額がゼロであることを意味しません。"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {!group ? <Pager {...view} total={rows.length} onChange={setPage} /> : null}
    </Panel>
  );
}
