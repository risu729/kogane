import type { ReactNode } from "react";
import { ApiError, useFeatures } from "../api.ts";
import { useCardPurchase, useCardPurchases, type CardPurchaseView } from "../card-purchases-api.ts";
import { Pagination } from "../pagination.tsx";
import {
  EXCLUSION_LABELS,
  KIND_LABELS,
  PurchaseAmount,
  PurchaseChain,
  PurchaseFigures,
  PurchaseStateBadge,
  SETTLEMENT_NOTE,
  settlementCell,
  statementCell,
  StatementTotals,
} from "../purchase-display.tsx";
import { Link } from "../router.tsx";
import { EmptyState, Loading, Notice, Nullable, Panel, QueryBoundary } from "../ui.tsx";
import { useViewState } from "../view-state.tsx";

const PAGE_SIZE = 50;
const PERIOD = /^[0-9]{4}-(?:0[1-9]|1[0-2])$/u;
const HISTORY_ACTIONS: Record<string, string> = {
  recognize: "認識",
  revise: "訂正",
  reanchor: "根拠の付け替え",
  retire: "表示されなくなった",
  merge: "統合",
  split: "分割",
};

function UnavailableNotice(): ReactNode {
  return <EmptyState>この接続先はカード利用の説明を提供していません。</EmptyState>;
}

function PurchaseRow({ view }: { view: CardPurchaseView }): ReactNode {
  const counterparty = view.sourceRows[0]?.counterparty ?? null;
  return (
    <tr>
      <td className="cell-time">{view.usageDate}</td>
      <td>
        <Nullable value={counterparty} placeholder="利用先未記録" />
      </td>
      <td>
        {KIND_LABELS[view.kind]} <PurchaseStateBadge view={view} />
      </td>
      <td className="num">
        <PurchaseAmount view={view} />
      </td>
      <td>{statementCell(view)}</td>
      <td>{settlementCell(view)}</td>
      <td>
        <Link to={`/purchases/${view.eventId}`}>説明を見る</Link>
      </td>
    </tr>
  );
}

export function PurchasesPage(): ReactNode {
  const features = useFeatures();
  const [period, setPeriod] = useViewState("purchases.period");
  const [draft, setDraft] = useViewState("purchases.draft");
  const [offset, setOffset] = useViewState("purchases.offset");
  const query = useCardPurchases(offset, period === "" ? null : period);
  const invalidDraft = draft !== "" && !PERIOD.test(draft);
  // The server refuses a filter it cannot total completely (413); the page
  // says how to narrow it instead of a generic error with a retry that would
  // be refused again.
  const tooLarge = query.error instanceof ApiError && query.error.status === 413;
  if (!features.known) return <Loading label="カード利用" />;
  return (
    <>
      <div className="page-head">
        <h1>カード利用</h1>
        <p className="lede">
          カード会社が確定・未確定として表示した利用を、請求と銀行の引落までたどります。
        </p>
        <p className="footnote">
          対象は取得済みの Vpass・MyJCB
          の1回払いの利用です。この一覧はカード利用の完全な履歴ではありません。
        </p>
      </div>
      {!features.cardPurchaseRecognition ? (
        <UnavailableNotice />
      ) : (
        <>
          <Panel id="purchase-filter" title="請求月で絞り込む">
            <form
              className="filter-grid"
              onSubmit={(event) => {
                event.preventDefault();
                if (invalidDraft) return;
                setPeriod(draft);
                setOffset(0);
              }}
            >
              <label className="filter-field purchase-period-field">
                請求月
                <input
                  type="month"
                  name="purchase-period"
                  value={draft}
                  placeholder="2026-09"
                  aria-invalid={invalidDraft || undefined}
                  onChange={(event) => setDraft(event.target.value)}
                />
              </label>
              <button className="button" type="submit" disabled={invalidDraft}>
                絞り込む
              </button>
              <button
                className="button"
                type="button"
                onClick={() => {
                  setDraft("");
                  setPeriod("");
                  setOffset(0);
                }}
              >
                すべて表示
              </button>
              {invalidDraft ? (
                <p role="alert">請求月は 2026-09 のように年と月で指定してください。</p>
              ) : null}
            </form>
          </Panel>
          {tooLarge ? (
            <Notice tone="warn" role="note">
              この条件の利用は多すぎて、すべてを合計できません。一部だけの合計は表示しないため、請求月で絞り込んでください。
            </Notice>
          ) : (
            <QueryBoundary query={query} label="カード利用">
              {(data) => (
                <>
                  <Panel
                    id="purchase-figures"
                    title={
                      period === "" ? "状態ごとの利用額" : `${period} 請求分の状態ごとの利用額`
                    }
                    count={`${data.summary.events}件`}
                    note={<>確定・未確定・返金は別々に表示し、合算しません。{SETTLEMENT_NOTE}。</>}
                  >
                    {data.summary.units.length === 0 && data.summary.unresolved === 0 ? (
                      <div className="panel-body">
                        <p>この条件で合計する利用はありません。</p>
                      </div>
                    ) : (
                      <PurchaseFigures summary={data.summary} />
                    )}
                    <details className="detail-disclosure">
                      <summary>カード会社の請求総額（参考）</summary>
                      <p className="footnote">
                        請求総額はカード会社が報告した金額です。上の利用額と比較したり差し引いたりしません。
                      </p>
                      <StatementTotals totals={data.summary.statementTotals} />
                    </details>
                  </Panel>
                  <Notice tone="warn" role="note">
                    <p>
                      <strong>一覧に含まれない利用があります。</strong>
                    </p>
                    <p>
                      取得元が現在表示している明細のうち {data.coverage.unrecognizedCurrentRows}{" "}
                      件は、カード利用として認識されていないため、どの請求月の一覧にも含まれていません。分割・リボ・ボーナス払い、金額を読み取れない利用、まだ処理していない明細などです。
                    </p>
                    <details className="inline-disclosure">
                      <summary>対象外の条件</summary>
                      <ul className="warning-list">
                        {data.coverage.unsupportedShapes.map((code) => (
                          <li key={code}>{EXCLUSION_LABELS[code] ?? code}</li>
                        ))}
                      </ul>
                    </details>
                  </Notice>
                  <Panel id="purchase-list" title="利用の一覧">
                    {data.items.length === 0 ? (
                      <div className="panel-body">
                        <EmptyState>
                          <p>表示できるカード利用はありません。</p>
                          <p>
                            一覧が空でも、カードの利用がなかったことにはなりません。取得していない明細や、この一覧の対象外の利用があります。
                          </p>
                        </EmptyState>
                      </div>
                    ) : (
                      <div
                        className="table-scroll"
                        role="region"
                        aria-label="カード利用の一覧"
                        tabIndex={0}
                      >
                        <table className="purchase-table">
                          <caption>
                            新しい利用日から順に表示します。金額は状態ごとに扱い、合算していません。
                          </caption>
                          <thead>
                            <tr>
                              <th scope="col">利用日</th>
                              <th scope="col">利用先</th>
                              <th scope="col">種類・状態</th>
                              <th scope="col" className="num">
                                金額
                              </th>
                              <th scope="col">請求</th>
                              <th scope="col">引落</th>
                              <th scope="col">
                                <span className="visually-hidden">説明</span>
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {data.items.map((view) => (
                              <PurchaseRow key={view.eventId} view={view} />
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    {data.items.length === 0 && offset === 0 ? null : (
                      <Pagination
                        label="カード利用のページ"
                        status={`${data.summary.events}件中 ${
                          data.items.length === 0
                            ? "表示なし"
                            : `${offset + 1}–${offset + data.items.length}件`
                        }`}
                        previous={{
                          label: `前の${PAGE_SIZE}件`,
                          disabled: offset === 0,
                          onClick: () => setOffset(Math.max(0, offset - PAGE_SIZE)),
                        }}
                        next={{
                          label: `次の${PAGE_SIZE}件`,
                          disabled: data.nextOffset === null,
                          onClick: () => {
                            if (data.nextOffset !== null) setOffset(data.nextOffset);
                          },
                        }}
                      />
                    )}
                  </Panel>
                </>
              )}
            </QueryBoundary>
          )}
        </>
      )}
    </>
  );
}

export function PurchasePage({ eventId }: { eventId: string }): ReactNode {
  const features = useFeatures();
  const query = useCardPurchase(eventId);
  if (!features.known) return <Loading label="カード利用の説明" />;
  return (
    <>
      <div className="page-head">
        <div className="breadcrumb">
          <Link to="/purchases">カード利用の一覧に戻る</Link>
        </div>
        <h1>カード利用の説明</h1>
        <p className="lede">この利用を、カード会社の請求と銀行の引落までたどります。</p>
      </div>
      {!features.cardPurchaseRecognition ? (
        <UnavailableNotice />
      ) : (
        <QueryBoundary
          query={query}
          label="カード利用の説明"
          isEmpty={(data) => data.items.length === 0}
          empty="この利用は見つかりません。"
        >
          {(data) => {
            const view = data.items[0]!;
            return (
              <>
                <Panel id="purchase-chain" title="利用 → 請求 → 引落">
                  <div className="panel-body">
                    <PurchaseChain view={view} />
                  </div>
                </Panel>
                <details className="detail-disclosure purchase-history">
                  <summary>記録の履歴と根拠の参照</summary>
                  <ol className="plain-list">
                    {view.history.map((entry) => (
                      <li key={entry.revision}>
                        版 {entry.revision}: {HISTORY_ACTIONS[entry.action] ?? entry.action} ·{" "}
                        <PurchaseStateBadge view={entry} /> · {entry.createdAt}
                        <br />
                        <code className="wrap-any">{entry.decisionRevisionId}</code>
                      </li>
                    ))}
                  </ol>
                  {view.historyTruncated ? (
                    <p>直近20件の記録を表示しています。古い記録も保存されています。</p>
                  ) : null}
                  <p>訂正は新しい版を追加します。以前の版と原本は消しません。</p>
                  <h3>根拠の参照</h3>
                  <ul className="plain-list">
                    {view.explanationRefs.map((ref) => (
                      <li key={ref}>
                        <code className="wrap-any">{ref}</code>
                      </li>
                    ))}
                  </ul>
                </details>
              </>
            );
          }}
        </QueryBoundary>
      )}
    </>
  );
}
