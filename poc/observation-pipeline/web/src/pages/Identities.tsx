import { type ReactNode } from "react";
import { useViewState } from "../view-state.tsx";
import {
  useIdentityAccounts,
  useIdentityCoverage,
  useIdentityInstruments,
  useIdentityConnections,
} from "../identity-api.ts";
import { Badge, EmptyState, ObservationLink, QueryBoundary } from "../ui.tsx";
import type { IdentityStatus } from "../../../shared/identity-contract.ts";
import { AccountConnectionDetails, AccountConnectionInventory } from "../account-connection.tsx";
const STATUS: Record<IdentityStatus, string> = {
  identified: "識別済み",
  "provider-local": "取得元内で識別",
  aggregate: "集計表示",
  unresolved: "要確認",
};
export function IdentitiesPage(): ReactNode {
  const [source, setSource] = useViewState("identity.source");
  const [draft, setDraft] = useViewState("identity.draft");
  const [tab, setTab] = useViewState("identity.tab");
  const [offset, setOffset] = useViewState("identity.offset");
  const [coverageOffset, setCoverageOffset] = useViewState("identity.coverageOffset");
  const coverage = useIdentityCoverage(source, coverageOffset);
  const connections = useIdentityConnections();
  return (
    <div className="identity-page">
      <div className="page-head">
        <h1>口座・銘柄の整理</h1>
        <p className="lede">取得元の記録と、現在の口座・通貨・銘柄の対応を確認できます。</p>
      </div>
      <p className="footnote">
        「取得元内で識別」は外部の銘柄台帳との照合完了を意味しません。この整理は重複除去や資産額の合算を行いません。
      </p>
      <QueryBoundary query={connections} label="取得経路の対応">
        {(data) => <AccountConnectionInventory connections={data.connections} />}
      </QueryBoundary>
      <section className="panel">
        <div className="panel-body">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setSource(draft.trim());
              setOffset(0);
              setCoverageOffset(0);
            }}
          >
            <label>
              取得元{" "}
              <input
                name="identity-source"
                autoComplete="off"
                spellCheck={false}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="例: sbi-securities"
                maxLength={128}
              />
            </label>{" "}
            <button type="submit" className="button">
              絞り込む
            </button>{" "}
            <button
              type="button"
              className="button"
              onClick={() => {
                setDraft("");
                setSource("");
                setOffset(0);
                setCoverageOffset(0);
              }}
            >
              すべて表示
            </button>
          </form>
        </div>
      </section>
      <QueryBoundary query={coverage} label="整理状況">
        {(data) => (
          <section className="panel">
            <div className="panel-body">
              <h2>整理状況</h2>
              <p className="footnote">
                対象は現在有効な保存記録です。状態別の件数は口座の対応状況であり、銘柄の照合率ではありません。
              </p>
              {data.rows.length === 0 ? (
                <EmptyState>条件に一致する対象記録がありません。</EmptyState>
              ) : (
                <div
                  className="table-scroll"
                  role="region"
                  aria-label="口座の整理状況"
                  tabIndex={0}
                >
                  <table>
                    <thead>
                      <tr>
                        <th>取得元</th>
                        <th>対象記録</th>
                        <th>整理済み</th>
                        <th>識別済み</th>
                        <th>取得元内</th>
                        <th>集計</th>
                        <th>要確認</th>
                        <th>未処理</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.rows.map((row) => (
                        <tr key={row.source}>
                          <td>{row.source}</td>
                          <td>{row.eligible}</td>
                          <td>{row.organized}</td>
                          <td>{row.identified}</td>
                          <td>{row.providerLocal}</td>
                          <td>{row.aggregate}</td>
                          <td>{row.unresolved}</td>
                          <td>{row.eligible - row.organized}</td>
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
            </div>
          </section>
        )}
      </QueryBoundary>
      <div className="page-actions">
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
        </button>{" "}
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
    </div>
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
    <QueryBoundary query={query} label="口座">
      {(data) => (
        <>
          {!data.rows.length ? (
            <EmptyState>
              整理済みの口座記録がありません。上の整理状況で未処理件数を確認できます。
            </EmptyState>
          ) : null}
          {data.rows.map((row) => (
            <article className="panel" key={row.referenceId}>
              <div className="panel-body">
                <h2>
                  {row.label} <Badge>{STATUS[row.status]}</Badge>
                </h2>
                <p>
                  {row.source} · 対応する記録 {row.observedCount}件
                </p>
                {row.connection ? <AccountConnectionDetails connection={row.connection} /> : null}
                <details className="detail-disclosure">
                  <summary>対応の根拠・取得元の識別情報</summary>
                  <dl className="kv">
                    <dt>区分</dt>
                    <dd>{row.role}</dd>
                    <dt>根拠</dt>
                    <dd>{row.reason}</dd>
                    <dt>取得元の参照</dt>
                    <dd>
                      <code>{row.reference}</code>
                    </dd>
                    <dt>参照ID</dt>
                    <dd>{row.referenceId}</dd>
                    <dt>現在の対応先</dt>
                    <dd>{row.targetId}</dd>
                    <dt>改訂</dt>
                    <dd>{row.revision}</dd>
                  </dl>
                </details>
                <ObservationLink kind={row.origin.kind} id={row.origin.id}>
                  代表記録・原本を確認
                </ObservationLink>
              </div>
            </article>
          ))}
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
    <QueryBoundary query={query} label="通貨・銘柄">
      {(data) => (
        <>
          {!data.rows.length ? (
            <EmptyState>この条件で整理された通貨・銘柄の記録がありません。</EmptyState>
          ) : null}
          {data.rows.map((row) => (
            <article className="panel" key={`${row.source}:${row.referenceId}`}>
              <div className="panel-body">
                <h2>
                  {row.label} <Badge>{STATUS[row.status]}</Badge>
                </h2>
                <p>
                  {row.source} · 対応する記録 {row.observedCount}件
                </p>
                <details className="detail-disclosure">
                  <summary>識別子・対応の根拠</summary>
                  <dl className="kv">
                    <dt>種別</dt>
                    <dd>{row.kind}</dd>
                    <dt>識別子</dt>
                    <dd>
                      {row.namespace} / {row.scope} / {row.value}
                    </dd>
                    <dt>根拠</dt>
                    <dd>{row.reason}</dd>
                    <dt>参照ID</dt>
                    <dd>{row.referenceId}</dd>
                    <dt>現在の対応先</dt>
                    <dd>{row.targetId}</dd>
                    <dt>改訂</dt>
                    <dd>{row.revision}</dd>
                  </dl>
                </details>
                <ObservationLink kind={row.origin.kind} id={row.origin.id}>
                  代表記録・原本を確認
                </ObservationLink>
              </div>
            </article>
          ))}
          <Pages offset={offset} next={data.coverage.nextOffset} change={change} />
        </>
      )}
    </QueryBoundary>
  );
}
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
    <div className="page-actions">
      <button
        type="button"
        className="button"
        disabled={offset === 0}
        onClick={() => change(Math.max(0, offset - 100))}
      >
        前の100件
      </button>{" "}
      <span>{offset + 1}件目から</span>{" "}
      <button
        type="button"
        className="button"
        disabled={next === null}
        onClick={() => next !== null && change(next)}
      >
        次の100件
      </button>
    </div>
  );
}
