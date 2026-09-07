import type { ReactNode } from "react";
import { usePositions, type PositionWithValuations } from "../api.ts";
import { Amount, Badge, EmptyState, Nullable, ObservationLink, QueryBoundary } from "../ui.tsx";
import { EMPTY_FILTERS, matchesSourceAccount, pageWindow } from "../filters.ts";
import { Pager, RecordControls } from "./ViewControls.tsx";
import { useViewState } from "../view-state.tsx";
export function PositionsPage(): ReactNode {
  const query = usePositions();
  return (
    <>
      <div className="page-head">
        <h1>保有資産</h1>
        <p className="lede">取得元が報告した保有数量と評価額を、通貨ごとに確認できます。</p>
      </div>
      <details className="detail-disclosure">
        <summary>評価額の対応関係について</summary>
        <p>
          口座・取得元・銘柄のラベルが一致する評価額を表示しています。日付の一致や、同じ時点の評価であることは保証されません。それぞれの基準日をご確認ください。金額は取得元の報告値を保ち、合算や為替換算はしていません。
        </p>
      </details>
      <QueryBoundary query={query} label="保有資産">
        {(data) => <PositionList entries={data.positions} />}
      </QueryBoundary>
    </>
  );
}
function PositionList({ entries }: { entries: PositionWithValuations[] }): ReactNode {
  const [page, setPage] = useViewState("positions.page");
  const [filters, setFilters] = useViewState("positions.filters");
  const filtered = entries.filter((entry) => matchesSourceAccount(entry.position, filters));
  const view = pageWindow(filtered, page);
  return (
    <>
      <section className="panel">
        <div className="panel-body">
          <RecordControls
            rows={entries.map((entry) => entry.position)}
            filters={filters}
            onChange={(next) => {
              setFilters(next);
              setPage(0);
            }}
          />
          <button
            className="button"
            type="button"
            onClick={() => {
              setFilters(EMPTY_FILTERS);
              setPage(0);
            }}
          >
            条件をクリア
          </button>
          <p className="footnote">
            保存された保有資産 {entries.length}件中 {filtered.length}
            件が条件に一致しています。取得元の全保有資産が揃っていることを示す件数ではありません。
          </p>
        </div>
      </section>
      {filtered.length === 0 ? (
        <EmptyState>
          {entries.length > 0
            ? "条件に一致する保有資産がありません。条件をクリアすると保存された記録を確認できます。"
            : "表示できる保有資産の記録がまだありません。保有数量や評価額がゼロであることを意味しません。"}
        </EmptyState>
      ) : null}
      {view.rows.map((entry) => (
        <PositionCard key={entry.position.id} entry={entry} />
      ))}
      <Pager {...view} total={filtered.length} onChange={setPage} />
    </>
  );
}
function PositionCard({ entry }: { entry: PositionWithValuations }): ReactNode {
  const { position, valuations } = entry;
  const currencies = [...new Set(valuations.map((value) => value.currency))];
  return (
    <article className="position-card">
      <div className="position-facts">
        <div className="position-title">
          <span className="security-code">{position.security_code}</span>
          <Badge>{position.source_id}</Badge>
        </div>
        <h2 className="security-name">
          <Nullable value={position.security_name} placeholder="銘柄名未記録" />
        </h2>
        <div className="quantity">{position.quantity_text}</div>
        <div className="figure-metric">保有数量（取得元の表記）</div>
        <dl className="kv">
          <dt>口座</dt>
          <dd>{position.source_account}</dd>
          <dt>市場</dt>
          <dd>
            <Nullable value={position.market} />
          </dd>
          <dt>通貨</dt>
          <dd>
            <Nullable value={position.currency} />
          </dd>
          <dt>基準日</dt>
          <dd>
            <Nullable value={position.as_of} />
          </dd>
          <dt>記録</dt>
          <dd>
            <ObservationLink kind="position" id={position.id}>
              詳細・原本を確認
            </ObservationLink>
          </dd>
        </dl>
        <details className="detail-disclosure">
          <summary>数量・解析の情報</summary>
          <p>
            小数桁数: {position.quantity_scale} / 解析: {position.parser}
          </p>
        </details>
      </div>
      <div className="position-valuations">
        <h3>取得元の評価額</h3>
        {valuations.length ? (
          currencies.map((currency) => (
            <section className="currency-group" key={currency}>
              <div className="currency-group-head">
                <span>{currency}</span>
                <span>通貨別の報告値</span>
              </div>
              <div className="figures">
                {valuations
                  .filter((value) => value.currency === currency)
                  .map((value) => (
                    <div className="figure" key={value.id}>
                      <div className="figure-metric">{value.metric}</div>
                      <div className="figure-amount">
                        <Amount
                          minor={value.amount_minor}
                          unit={value.currency}
                          text={value.amount_text}
                        />
                      </div>
                      <div className="figure-foot">
                        <span>
                          基準日: <Nullable value={value.as_of} />
                        </span>
                        <ObservationLink kind="valuation" id={value.id}>
                          詳細
                        </ObservationLink>
                      </div>
                    </div>
                  ))}
              </div>
            </section>
          ))
        ) : (
          <p className="footnote">
            この銘柄のラベルに一致する評価額がありません。評価額がゼロであることや、取得元に情報がないことを意味しません。
          </p>
        )}
      </div>
    </article>
  );
}
