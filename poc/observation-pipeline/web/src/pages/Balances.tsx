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
import { EMPTY_FILTERS, isRecordedZero, matchesSourceAccount, pageWindow } from "../filters.ts";
import { Pager, RecordControls } from "./ViewControls.tsx";
import { useViewState } from "../view-state.tsx";
import { OrganizedInstrumentContext, OrganizedSourceAccount } from "../organization.tsx";
import { BALANCE_GROUPS, BalanceEvidence, balanceMeaning } from "../balance-display.tsx";
export function BalancesPage(): ReactNode {
  const query = useBalances();
  return (
    <>
      <div className="page-head">
        <h1>残高</h1>
        <p className="lede">
          取得元が報告した金額を、預金などの残高・請求額・参考情報に分けて確認できます。純資産の合計ではありません。
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
  const [hideZero, setHideZero] = useViewState("balances.hideZero");
  const rows = [...latest, ...history];
  const instruments = [...new Set(rows.map((row) => row.instrument))].sort();
  const metrics = [...new Set(rows.map((row) => row.metric))].sort();
  const matches = (row: BalanceRow) =>
    matchesSourceAccount(row, filters) &&
    (!instrument || row.instrument === instrument) &&
    (!metric || row.metric === metric) &&
    (!hideZero || !isRecordedZero(row.amount_minor));
  const selectionKey = JSON.stringify([
    filters.source,
    filters.account,
    instrument,
    metric,
    hideZero,
  ]);
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
                setHideZero(false);
              }}
            >
              条件をクリア
            </button>
          </div>
        </section>
      ) : null}
      <section className="panel" aria-label="残高の表示条件">
        <div className="panel-body">
          <label>
            <input
              type="checkbox"
              checked={hideZero}
              onChange={(event) => setHideZero(event.target.checked)}
            />{" "}
            残高0を除外
          </label>
          <p className="footnote">
            受信した最新・履歴の記録から、金額が0と確認できる行を除外します。未記録・読み取り不能の金額は残します。
          </p>
        </div>
      </section>
      <LatestBalances
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
          過去の履歴には旧解析の記録も残っています。金額は合算・換算・符号反転せず、保存値をそのまま表示します。最新の記録は受信した範囲を全区分共通で50件ずつ表示します。件数は受信範囲のもので、金融機関の全履歴を表しません。
        </p>
        <p>
          同じ残高であることを確認できた最新の記録は、金額を一度だけ表示し、すべての根拠へのリンクを残します。金額や根拠が一致しない候補は別々に表示します。過去の履歴はまとめません。
        </p>
      </details>
    </>
  );
}
function LatestBalances({ rows, available }: { rows: BalanceRow[]; available: number }): ReactNode {
  const [page, setPage] = useState(0);
  const view = pageWindow(rows, page);
  return (
    <section aria-label="項目ごとの最新の記録">
      <h2 id="latest-balances">項目ごとの最新の記録</h2>
      <p className="footnote">
        受信した最新の記録 {available}件中、条件に一致する{rows.length}
        件。各区分の件数はこの表示ページ内です。
      </p>
      {BALANCE_GROUPS.map((group) => {
        const grouped = view.rows.filter((row) =>
          (group.kinds as readonly string[]).includes(balanceMeaning(row).kind),
        );
        return grouped.length ? (
          <BalanceTable key={group.id} rows={grouped} available={grouped.length} group={group} />
        ) : null;
      })}
      {!rows.length ? (
        <p>
          {available
            ? "条件に一致する残高がありません。条件をクリアすると保存された記録を確認できます。"
            : "表示対象の残高記録がまだありません。残高がゼロであることを意味しません。"}
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
}: {
  rows: BalanceRow[] | BalanceHistoryRow[];
  history?: boolean;
  available: number;
  group?: (typeof BALANCE_GROUPS)[number];
}): ReactNode {
  const [page, setPage] = useState(0);
  const view = pageWindow<BalanceRow | BalanceHistoryRow>(rows, group ? 0 : page);
  return (
    <Panel
      id={history ? "balance-history" : `balance-${group?.id}`}
      title={history ? "保存された残高の履歴" : group?.title}
      count={group ? `このページ内 ${rows.length}件` : `${available}件中 ${rows.length}件`}
      note={history ? "旧解析の記録も、根拠を確認できるように保持しています。" : group?.note}
    >
      <div
        className="table-scroll"
        role="region"
        aria-label={history ? "残高の履歴" : `${group?.title}の記録`}
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
                    {balanceMeaning(row).label} <Badge>{row.instrument}</Badge>
                    <div className="table-secondary">{row.metric}</div>
                    <OrganizedInstrumentContext
                      organization={row.organization}
                      role="unit"
                      original={row.instrument}
                    />
                  </td>
                  <td
                    className={`col-amount num${!history && balanceMeaning(row).kind !== "asset" ? " balance-reference-amount" : ""}`}
                  >
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
                    {!history ? <BalanceEvidence row={row} /> : null}
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
      {!group ? <Pager {...view} total={rows.length} onChange={setPage} /> : null}
    </Panel>
  );
}
