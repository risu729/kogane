import { type ReactNode } from "react";
import { useViewState } from "../view-state.tsx";
import {
  useIdentityAccounts,
  useIdentityCoverage,
  useIdentityInstruments,
  useIdentityConnections,
} from "../identity-api.ts";
import { EmptyState, Kv, KvRow, ObservationLink, Panel, QueryBoundary } from "../ui.tsx";
import {
  IDENTITY_PAGE_LIMIT,
  type IdentityStatus,
} from "../../../../packages/observation-shared/src/identity-contract.ts";
import { AccountConnectionDetails, AccountConnectionInventory } from "../account-connection.tsx";
import { IdentityStatusBadge } from "../organization.tsx";
export function IdentitiesPage(): ReactNode {
  const [source, setSource] = useViewState("identity.source");
  const [draft, setDraft] = useViewState("identity.draft");
  const [tab, setTab] = useViewState("identity.tab");
  const [offset, setOffset] = useViewState("identity.offset");
  const [coverageOffset, setCoverageOffset] = useViewState("identity.coverageOffset");
  const coverage = useIdentityCoverage(source, coverageOffset);
  const connections = useIdentityConnections();
  const reset = (value: string): void => {
    setSource(value);
    setOffset(0);
    setCoverageOffset(0);
  };
  return (
    <>
      <div className="page-head">
        <h1>口座・銘柄の整理</h1>
        <p className="lede">取得元の記録と、現在の口座・通貨・銘柄の対応を確認できます。</p>
        <p className="footnote">
          「取得元内で識別」は外部の銘柄台帳との照合完了を意味しません。この整理は重複除去や資産額の合算を行いません。
          ここや口座フィルターの名称は口座の識別用で、金融商品の正式名称ではありません。
          商品は時期によって変わるため、各記録の詳細でその記録に基づく判定を確認できます。
        </p>
      </div>
      <QueryBoundary query={connections} label="取得経路の対応">
        {(data) => <AccountConnectionInventory connections={data.connections} />}
      </QueryBoundary>
      <Panel id="identity-filter" title="取得元で絞り込む">
        <form
          className="filter-grid"
          onSubmit={(e) => {
            e.preventDefault();
            reset(draft.trim());
          }}
        >
          <label className="filter-field identity-source-field">
            取得元
            <input
              name="identity-source"
              autoComplete="off"
              spellCheck={false}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="例: sbi-securities"
              maxLength={128}
            />
          </label>
          <div className="identity-filter-actions">
            <button type="submit" className="button">
              絞り込む
            </button>
            <button
              type="button"
              className="button"
              onClick={() => {
                setDraft("");
                reset("");
              }}
            >
              すべて表示
            </button>
          </div>
        </form>
      </Panel>
      <Panel
        id="identity-coverage"
        title="整理状況"
        note="対象は現在有効な保存記録です。状態別の件数は口座の対応状況であり、銘柄の照合率ではありません。"
      >
        <QueryBoundary query={coverage} label="整理状況" coverageNotice={false}>
          {(data) => (
            <>
              {data.rows.length === 0 ? (
                <div className="panel-body">
                  <EmptyState>条件に一致する対象記録がありません。</EmptyState>
                </div>
              ) : (
                <div
                  className="table-scroll"
                  role="region"
                  aria-label="口座の整理状況"
                  tabIndex={0}
                >
                  <table className="identity-coverage-table">
                    <caption>取得元ごとの対象記録の件数と、口座の対応状況の内訳</caption>
                    <thead>
                      <tr>
                        <th scope="col">取得元</th>
                        <th scope="col" className="num">
                          対象記録
                        </th>
                        <th scope="col" className="num">
                          整理済み
                        </th>
                        <th scope="col" className="num">
                          識別済み
                        </th>
                        <th scope="col" className="num">
                          取得元内
                        </th>
                        <th scope="col" className="num">
                          集計
                        </th>
                        <th scope="col" className="num">
                          要確認
                        </th>
                        <th scope="col" className="num">
                          未処理
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.rows.map((row) => (
                        <tr key={row.source}>
                          <td>{row.source}</td>
                          <td className="num">{row.eligible}</td>
                          <td className="num">{row.organized}</td>
                          <td className="num">{row.identified}</td>
                          <td className="num">{row.providerLocal}</td>
                          <td className="num">{row.aggregate}</td>
                          <td className="num">{row.unresolved}</td>
                          <td className="num">{row.eligible - row.organized}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <Pages
                offset={coverageOffset}
                next={data.coverage.nextOffset}
                change={setCoverageOffset}
              />
            </>
          )}
        </QueryBoundary>
      </Panel>
      <Panel
        id="identity-list"
        title={tab === "accounts" ? "整理済みの口座" : "整理済みの通貨・銘柄"}
      >
        <div className="toolbar" role="group" aria-label="一覧の種類">
          <button
            type="button"
            className="button"
            aria-pressed={tab === "accounts"}
            onClick={() => {
              setTab("accounts");
              setOffset(0);
            }}
          >
            口座
          </button>
          <button
            type="button"
            className="button"
            aria-pressed={tab === "instruments"}
            onClick={() => {
              setTab("instruments");
              setOffset(0);
            }}
          >
            通貨・銘柄
          </button>
        </div>
        {tab === "accounts" ? (
          <Accounts source={source} offset={offset} change={setOffset} />
        ) : (
          <Instruments source={source} offset={offset} change={setOffset} />
        )}
      </Panel>
    </>
  );
}
function Card({
  title,
  status,
  meta,
  children,
}: {
  title: string;
  status: IdentityStatus;
  meta: ReactNode;
  children: ReactNode;
}): ReactNode {
  return (
    <article className="identity-card">
      <h3 className="identity-card-title">
        {title} <IdentityStatusBadge status={status} />
      </h3>
      <p className="identity-card-meta">{meta}</p>
      {children}
    </article>
  );
}
function Accounts({
  source,
  offset,
  change,
}: {
  source: string;
  offset: number;
  change: (n: number) => void;
}) {
  const query = useIdentityAccounts(source, offset);
  return (
    <QueryBoundary query={query} label="口座" coverageNotice={false}>
      {(data) => (
        <>
          {!data.rows.length ? (
            <div className="panel-body">
              <EmptyState>
                整理済みの口座記録がありません。上の整理状況で未処理件数を確認できます。
              </EmptyState>
            </div>
          ) : (
            <div className="identity-grid">
              {data.rows.map((row) => (
                <Card
                  key={row.referenceId}
                  title={row.label}
                  status={row.status}
                  meta={`${row.source} · 対応する記録 ${String(row.observedCount)}件`}
                >
                  {row.connection ? <AccountConnectionDetails connection={row.connection} /> : null}
                  <details className="detail-disclosure">
                    <summary>対応の根拠・取得元の識別情報</summary>
                    <Kv>
                      <KvRow label="区分">{row.role}</KvRow>
                      <KvRow label="根拠">{row.reason}</KvRow>
                      <KvRow label="取得元の参照">
                        <code>{row.reference}</code>
                      </KvRow>
                      <KvRow label="参照ID">{row.referenceId}</KvRow>
                      <KvRow label="現在の対応先">{row.targetId}</KvRow>
                      <KvRow label="改訂">{row.revision}</KvRow>
                    </Kv>
                  </details>
                  <p className="identity-card-link">
                    <ObservationLink kind={row.origin.kind} id={row.origin.id}>
                      代表記録・原本を確認
                    </ObservationLink>
                  </p>
                </Card>
              ))}
            </div>
          )}
          <Pages offset={offset} next={data.coverage.nextOffset} change={change} />
        </>
      )}
    </QueryBoundary>
  );
}
function Instruments({
  source,
  offset,
  change,
}: {
  source: string;
  offset: number;
  change: (n: number) => void;
}) {
  const query = useIdentityInstruments(source, offset);
  return (
    <QueryBoundary query={query} label="通貨・銘柄" coverageNotice={false}>
      {(data) => (
        <>
          {!data.rows.length ? (
            <div className="panel-body">
              <EmptyState>この条件で整理された通貨・銘柄の記録がありません。</EmptyState>
            </div>
          ) : (
            <div className="identity-grid">
              {data.rows.map((row) => (
                <Card
                  key={`${row.source}:${row.referenceId}`}
                  title={row.label}
                  status={row.status}
                  meta={`${row.source} · 対応する記録 ${String(row.observedCount)}件`}
                >
                  <details className="detail-disclosure">
                    <summary>識別子・対応の根拠</summary>
                    <Kv>
                      <KvRow label="種別">{row.kind}</KvRow>
                      <KvRow label="識別子">
                        {row.namespace} / {row.scope} / {row.value}
                      </KvRow>
                      <KvRow label="根拠">{row.reason}</KvRow>
                      <KvRow label="参照ID">{row.referenceId}</KvRow>
                      <KvRow label="現在の対応先">{row.targetId}</KvRow>
                      <KvRow label="改訂">{row.revision}</KvRow>
                    </Kv>
                  </details>
                  <p className="identity-card-link">
                    <ObservationLink kind={row.origin.kind} id={row.origin.id}>
                      代表記録・原本を確認
                    </ObservationLink>
                  </p>
                </Card>
              ))}
            </div>
          )}
          <Pages offset={offset} next={data.coverage.nextOffset} change={change} />
        </>
      )}
    </QueryBoundary>
  );
}
/** The same markup as `Pager` in ViewControls, for lists paged by offset in memory. */
function Pages({
  offset,
  next,
  change,
}: {
  offset: number;
  next: number | null;
  change: (n: number) => void;
}) {
  return (
    <div className="pagination" aria-label="表示ページ">
      <span role="status" aria-live="polite">
        {offset + 1}件目から
      </span>
      <button
        type="button"
        className="button"
        disabled={offset === 0}
        onClick={() => change(Math.max(0, offset - IDENTITY_PAGE_LIMIT))}
      >
        前の{IDENTITY_PAGE_LIMIT}件
      </button>
      <button
        type="button"
        className="button"
        disabled={next === null}
        onClick={() => next !== null && change(next)}
      >
        次の{IDENTITY_PAGE_LIMIT}件
      </button>
    </div>
  );
}
