import { useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { ApiError, useFeatures } from "../api.ts";
import {
  purchaseLinkPinsMatch,
  purchaseLinkPlanRequest,
  useCardPurchase,
  useCardPurchases,
  type CardPurchaseCandidate,
  type CardPurchaseView,
  type PendingPostedAction,
} from "../card-purchases-api.ts";
import { postCommand, type ChangePlanView } from "../command-api.ts";
import { Pagination } from "../pagination.tsx";
import {
  CANDIDATE_ACTION_LABELS,
  CandidateCodes,
  candidateEffect,
  candidateOpen,
  CandidateOrigin,
  CandidateSides,
  CandidateStatusBadge,
  DisplayedAmount,
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
import { Link, navigate } from "../router.tsx";
import { EmptyState, Kv, KvRow, Loading, Notice, Nullable, Panel, QueryBoundary } from "../ui.tsx";
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

/**
 * Open pending-to-posted candidates touching this page's purchases, each once
 * (a candidate appears on both of its events), with a link to the purchase
 * where it is reviewed.
 */
function OpenCandidates({ items }: { items: CardPurchaseView[] }): ReactNode {
  const open = new Map<string, { candidate: CardPurchaseCandidate; eventId: string }>();
  for (const view of items)
    for (const candidate of view.candidates)
      if (candidateOpen(candidate) && !open.has(candidate.proposalId))
        open.set(candidate.proposalId, { candidate, eventId: view.eventId });
  if (open.size === 0) return null;
  return (
    <Panel
      id="purchase-candidates"
      title="確認待ちの未確定・確定の対応候補"
      count={`${open.size}件`}
      note="同じ利用が、未確定の明細と確定の明細として別々に記録されているかもしれない組です。金額や日付が近いだけでは統合しません。このページの利用に関わる候補だけを表示します。"
    >
      <div className="panel-body">
        <ul className="plain-list" aria-label="確認待ちの対応候補">
          {[...open.values()].map(({ candidate, eventId }) => (
            <li key={candidate.proposalId}>
              <strong>未確定</strong>{" "}
              <Nullable value={candidate.pending.usageDate} placeholder="利用日未記録" /> ·{" "}
              <DisplayedAmount side={candidate.pending} /> → <strong>確定</strong>{" "}
              <Nullable value={candidate.posted.usageDate} placeholder="利用日未記録" /> ·{" "}
              <DisplayedAmount side={candidate.posted} /> <CandidateOrigin candidate={candidate} />
              <br />
              <Link to={`/purchases/${eventId}`}>候補を確認して判断</Link>
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}

/**
 * The decisions the server offers for one candidate, each behind a written
 * reason. Planning only opens the confirmation screen; nothing is decided
 * until a human approves and commits there.
 */
function CandidateDecision({ candidate }: { candidate: CardPurchaseCandidate }): ReactNode {
  const features = useFeatures();
  const [reason, setReason] = useState("");
  const plan = useMutation({
    mutationFn: async (action: PendingPostedAction) => {
      const response = await postCommand<{ plan: ChangePlanView }>(
        "plan",
        purchaseLinkPlanRequest(candidate, action, reason.trim()),
        new AbortController().signal,
      );
      // A plan pinned to anything but what is on screen needs another look.
      if (!purchaseLinkPinsMatch(response.plan.expectedRevisions, candidate, action))
        throw new Error(
          "候補または利用の記録が更新されています。表示を更新して、内容を確認し直してください。",
        );
      return response.plan;
    },
    onSuccess: (value) => navigate(`/confirm/${value.planId}`),
  });
  if (candidate.actions.length === 0) return null;
  // Decisions are an operator's: the route itself is operator-only, and the
  // actions exist only where the change lifecycle is advertised.
  if (!features.commands)
    return (
      <p className="footnote">
        この接続先では確認操作が有効ではないため、ここから判断することはできません。
      </p>
    );
  const canPlan = reason.trim().length > 0 && !plan.isPending;
  const id = `candidate-reason-${candidate.proposalId}`;
  return (
    <div className="settlement-decision">
      <div className="field">
        <label htmlFor={id}>判断の理由</label>
        <textarea
          id={id}
          className="settlement-reason"
          rows={2}
          maxLength={1000}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          disabled={plan.isPending}
        />
      </div>
      <div className="button-row">
        {candidate.actions.map((action) => (
          <button
            key={action}
            className="button"
            type="button"
            disabled={!canPlan}
            onClick={() => plan.mutate(action)}
          >
            {CANDIDATE_ACTION_LABELS[action]}
          </button>
        ))}
      </div>
      {plan.isError ? (
        <Notice tone="bad" inline role="alert">
          {plan.error.message}
        </Notice>
      ) : null}
      <ul className="plain-list">
        {candidate.actions.map((action) => (
          <li key={action}>
            <strong>{CANDIDATE_ACTION_LABELS[action]}</strong>: {candidateEffect(candidate, action)}
          </li>
        ))}
      </ul>
      <p className="footnote">
        次の画面で内容を確認し、承認してから確定します。確認画面を開くだけでは判断は保存されません。
      </p>
    </div>
  );
}

/**
 * One candidate on a purchase's explanation, following the reconciliation
 * candidate: the head names both rows, the review sits under a disclosure
 * that starts open while a decision is due.
 */
function CandidatePanel({
  candidate,
  eventId,
}: {
  candidate: CardPurchaseCandidate;
  eventId: string;
}): ReactNode {
  const id = `candidate-${candidate.proposalId}`;
  return (
    <section className="panel" aria-labelledby={id}>
      <div className="panel-head settlement-head">
        <h2 id={id}>未確定と確定の明細の対応</h2>
        <CandidateStatusBadge candidate={candidate} />
        <dl className="settlement-facts">
          <div>
            <dt>未確定 </dt>
            <dd>
              <Nullable value={candidate.pending.usageDate} placeholder="利用日未記録" /> ·{" "}
              <DisplayedAmount side={candidate.pending} />
            </dd>
          </div>
          <div>
            <dt>確定 </dt>
            <dd>
              <Nullable value={candidate.posted.usageDate} placeholder="利用日未記録" /> ·{" "}
              <DisplayedAmount side={candidate.posted} />
            </dd>
          </div>
          <div>
            <dt>根拠 </dt>
            <dd>
              <CandidateOrigin candidate={candidate} />
            </dd>
          </div>
        </dl>
      </div>
      <details className="settlement-disclosure" open={candidateOpen(candidate)}>
        <summary>候補の詳細と判断</summary>
        <div className="panel-body settlement-details">
          <p>
            同じ利用が、カード会社の画面で未確定の明細として表示された後、確定の明細として表示されることがあります。同一の利用と判断すると、2件の記録を1件の利用として扱います。金額や日付が近いだけでは統合しません。
          </p>
          <CandidateSides candidate={candidate} currentEventId={eventId} />
          <CandidateCodes candidate={candidate} />
          <details className="detail-disclosure settlement-history">
            <summary>判断の記録と根拠の参照</summary>
            <Kv>
              <KvRow label="候補">
                <code className="wrap-any">{candidate.proposalId}</code>
              </KvRow>
              <KvRow label="候補の判断の版">{candidate.proposalRevision}</KvRow>
              <KvRow label="関係の記録数">{candidate.relationRevision}</KvRow>
              <KvRow label="根拠の参照">
                <ul className="plain-list">
                  {candidate.relation.evidenceRefs.map((ref) => (
                    <li key={ref}>
                      <code className="wrap-any">{ref}</code>
                    </li>
                  ))}
                </ul>
              </KvRow>
            </Kv>
            <p>判断は新しい記録として追加します。以前の判断、利用の版と原本は消しません。</p>
          </details>
          <CandidateDecision
            key={`${candidate.proposalRevision}:${candidate.relationRevision}`}
            candidate={candidate}
          />
        </div>
      </details>
    </section>
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
                  <OpenCandidates items={data.items} />
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
                {view.candidates.map((candidate) => (
                  <CandidatePanel
                    key={candidate.proposalId}
                    candidate={candidate}
                    eventId={view.eventId}
                  />
                ))}
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
