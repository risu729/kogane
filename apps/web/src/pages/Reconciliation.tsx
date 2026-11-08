import { useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { useFeatures } from "../api.ts";
import {
  useCardSettlement,
  useCardSettlementStatements,
  useRelatedCardSettlements,
  useStatementCandidates,
  type CardSettlementReview,
  type CardSettlementStatementGroup,
} from "../reconciliation-api.ts";
import {
  bankSourceLabel,
  CardSettlementDetails,
  DateValue,
  SETTLEMENT_STATUS,
  SettlementQuantity,
  settlementReason,
} from "../reconciliation-display.tsx";
import { postCommand, type ChangePlanView } from "../command-api.ts";
import { Link, navigate } from "../router.tsx";
import { Badge, EmptyState, Loading, Notice, QueryBoundary } from "../ui.tsx";
import { UnmatchedStatements } from "../unmatched-statements.tsx";

function ReviewActions({ review }: { review: CardSettlementReview }): ReactNode {
  const features = useFeatures();
  const [reason, setReason] = useState("");
  const plan = useMutation({
    mutationFn: async (action: "accept" | "reject" | "withdraw") => {
      const response = await postCommand<{ plan: ChangePlanView }>(
        "plan",
        {
          kind: `card-settlement.${action}`,
          payload: { proposalId: review.proposalId, reason: reason.trim() },
          baseContextId: `card-settlement:${review.proposalId}@${review.revision}`,
        },
        new AbortController().signal,
      );
      // A newer row needs another review; do not silently approve new facts.
      if (
        response.plan.expectedRevisions[`card-settlement:${review.proposalId}`] !== review.revision
      )
        throw new Error("候補が更新されています。一覧を更新して、内容を確認し直してください。");
      return response.plan;
    },
    onSuccess: (value) => navigate(`/confirm/${value.planId}`),
  });
  const canPlan =
    features.known && features.commands && reason.trim().length > 0 && !plan.isPending;
  const proposed = review.status === "proposed";
  if (review.status === "rejected" || review.status === "withdrawn")
    return (
      <p className="footnote">
        この候補の判断は保存されています。対応先を訂正する場合は、同じ請求・出金の他の候補を原本と照合して採用してください。
      </p>
    );
  return (
    <div className="settlement-decision">
      <div className="field">
        <label htmlFor={`reason-${review.proposalId}`}>判断の理由</label>
        <textarea
          id={`reason-${review.proposalId}`}
          className="settlement-reason"
          rows={2}
          maxLength={1000}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          disabled={!features.known || !features.commands || plan.isPending}
        />
      </div>
      <div className="button-row">
        {proposed ? (
          <button
            className="button"
            type="button"
            disabled={!canPlan || review.acceptanceBlockers.length > 0}
            onClick={() => plan.mutate("accept")}
          >
            採用内容を確認
          </button>
        ) : null}
        {proposed ? (
          <button
            className="button"
            type="button"
            disabled={!canPlan}
            onClick={() => plan.mutate("reject")}
          >
            却下内容を確認
          </button>
        ) : null}
        {review.status === "accepted" ? (
          <button
            className="button"
            type="button"
            disabled={!canPlan}
            onClick={() => plan.mutate("withdraw")}
          >
            採用を解除する内容を確認
          </button>
        ) : null}
      </div>
      {plan.isError ? (
        <Notice tone="bad" inline role="alert">
          {plan.error.message}
        </Notice>
      ) : null}
      {review.status === "accepted" ? (
        <p className="footnote">
          対応が誤っている場合は、採用を解除してから、同じ請求・出金の正しい候補を採用します。解除しても、この判断と原本は履歴に残ります。
        </p>
      ) : null}
      <p className="footnote">
        次の画面で内容を確認し、承認してから確定します。確認画面を開くだけでは採用・却下しません。
      </p>
    </div>
  );
}

function statementSource(review: CardSettlementReview): string {
  return review.facts.statement.sourceId === "vpass" ? "Vpass" : "MyJCB";
}

/**
 * One candidate. The head carries what identifies it; the review itself sits
 * under a disclosure that starts open only while a decision is still due, or
 * always on the candidate's own page (`detail`).
 */
function SettlementCard({
  review,
  detail = false,
}: {
  review: CardSettlementReview;
  detail?: boolean;
}): ReactNode {
  const features = useFeatures();
  const id = `review-${review.proposalId}`;
  const { facts } = review;
  return (
    // Candidates of one statement share their heading; the month and the
    // candidate's creation time tell their regions apart.
    <section className="panel" aria-labelledby={`${id} ${id}-period ${id}-created`}>
      <div className="panel-head settlement-head">
        <h2 id={id}>{statementSource(review)} の請求と銀行引落</h2>
        <Badge tone={review.status === "accepted" ? "ok" : "neutral"}>
          {SETTLEMENT_STATUS[review.status]}
        </Badge>
        <dl className="settlement-facts">
          <div id={`${id}-period`}>
            <dt>請求月 </dt>
            <dd>{facts.statement.period ?? "不明"}</dd>
          </div>
          <div>
            <dt>請求総額 </dt>
            <dd>
              <SettlementQuantity value={facts.statement.amount} />
            </dd>
          </div>
          <div>
            <dt>引落予定日 </dt>
            <dd>
              <DateValue value={facts.statement.paymentDate} />
            </dd>
          </div>
          <div>
            <dt>銀行 </dt>
            <dd>
              {bankSourceLabel(facts.bankDebit.sourceId)} · {facts.bankDebit.sourceAccount}
            </dd>
          </div>
          <div id={`${id}-created`}>
            <dt>候補の作成 </dt>
            <dd>{review.createdAt}</dd>
          </div>
        </dl>
      </div>
      <details className="settlement-disclosure" open={detail || review.status === "proposed"}>
        <summary>候補の詳細と判断</summary>
        <div className="panel-body">
          <CardSettlementDetails review={review} />
          {detail ? null : (
            <p>
              <Link to={`/reconciliation/${review.proposalId}`}>
                同じ請求・出金の他の候補を確認
              </Link>
            </p>
          )}
          {features.cardOwnershipReview && review.status === "proposed" ? (
            <p>
              <Link to={`/reconciliation/${review.proposalId}/ownership`}>
                口座の保有者と根拠を確認
              </Link>
            </p>
          ) : null}
          <ReviewActions review={review} />
        </div>
      </details>
    </section>
  );
}

/**
 * The candidates of a statement beyond the ones its group carries, read only
 * once asked for, newest first, without the ones already shown.
 */
function OlderCandidates({
  group,
  shown,
}: {
  group: CardSettlementStatementGroup;
  shown: ReadonlySet<string>;
}): ReactNode {
  const [requested, setRequested] = useState(false);
  const [offset, setOffset] = useState(0);
  const query = useStatementCandidates(group.statementKey, offset, requested);
  if (!requested)
    return (
      <button className="button" type="button" onClick={() => setRequested(true)}>
        この請求の候補をすべて表示（{group.candidateCount} 件）
      </button>
    );
  return (
    <QueryBoundary
      query={query}
      label="この請求の候補"
      isEmpty={(data) => data.items.length === 0}
      empty="この請求の候補はほかにありません。"
    >
      {(data) => (
        <>
          {data.items
            .filter((review) => !shown.has(review.proposalId))
            .map((review) => (
              <SettlementCard key={review.proposalId} review={review} />
            ))}
          <nav className="pagination" aria-label="この請求の候補のページ">
            <span role="status" aria-live="polite">
              {offset + 1}–{offset + data.items.length} 件目 / {group.candidateCount} 件
            </span>
            <button
              className="button"
              type="button"
              disabled={offset === 0}
              onClick={() => setOffset(0)}
            >
              先頭に戻る
            </button>
            <button
              className="button"
              type="button"
              disabled={data.nextOffset === null}
              onClick={() => (data.nextOffset === null ? undefined : setOffset(data.nextOffset))}
            >
              次の候補
            </button>
          </nav>
        </>
      )}
    </QueryBoundary>
  );
}

/**
 * One statement: the candidate to look at first (its accepted one, else the
 * newest one ready to accept, else the newest), and the other candidates of
 * the same statement collapsed under it. Nothing is hidden for good: every
 * candidate stays reachable and keeps its own decision history.
 */
function StatementGroup({ group }: { group: CardSettlementStatementGroup }): ReactNode {
  const [lead, ...others] = group.candidates;
  if (!lead) return null;
  const otherCount = group.candidateCount - 1;
  const shown = new Set(group.candidates.map((review) => review.proposalId));
  return (
    <div className="settlement-statement">
      <SettlementCard review={lead} />
      {otherCount > 0 ? (
        <details className="settlement-older">
          <summary>この請求のほかの候補（{otherCount} 件）</summary>
          <p className="footnote">
            同じ請求を再取得するたびに新しい候補ができます。ほかの候補も記録として残り、採用できるのは最新の請求・引落を指す候補だけです。
          </p>
          {others.map((review) => (
            <SettlementCard key={review.proposalId} review={review} />
          ))}
          {group.candidateCount > group.candidates.length ? (
            <OlderCandidates group={group} shown={shown} />
          ) : null}
        </details>
      ) : null}
    </div>
  );
}

export function ReconciliationPage(): ReactNode {
  const features = useFeatures();
  const [offset, setOffset] = useState(0);
  const query = useCardSettlementStatements(offset);
  if (!features.known) return <Loading label="照合機能" />;
  return (
    <>
      <div className="page-head">
        <h1>カード請求と引落の照合</h1>
        <p className="lede">
          カード会社の請求総額と銀行の出金を、原本を見ながら確認します。候補は自動採用されません。
        </p>
        <p className="footnote">
          対象は取得済みの請求・銀行明細です。候補がないことは、未払がないことや照合が完了したことを意味しません。請求ごとにまとめ、採用済みまたは採用できる候補を先頭に表示します。
        </p>
      </div>
      {!features.cardSettlementReconciliation ? (
        <EmptyState>この接続先はカード決済の照合候補を提供していません。</EmptyState>
      ) : (
        <QueryBoundary
          query={query}
          label="照合候補"
          isEmpty={(data) => data.statements.length === 0}
          empty="現在表示できる照合候補はありません。"
        >
          {(data) => (
            <>
              {data.statements.map((group) => (
                <StatementGroup key={group.statementKey} group={group} />
              ))}
              <nav className="pagination" aria-label="照合候補のページ">
                <span role="status" aria-live="polite">
                  請求 {offset + 1}–{offset + data.statements.length} 件目
                </span>
                <button
                  className="button"
                  type="button"
                  disabled={offset === 0}
                  onClick={() => setOffset(0)}
                >
                  先頭に戻る
                </button>
                <button
                  className="button"
                  type="button"
                  disabled={data.nextOffset === null}
                  onClick={() =>
                    data.nextOffset === null ? undefined : setOffset(data.nextOffset)
                  }
                >
                  次の請求
                </button>
              </nav>
            </>
          )}
        </QueryBoundary>
      )}
      {features.cardSettlementReconciliation ? <UnmatchedStatements /> : null}
    </>
  );
}

/**
 * One competing candidate, compact: what it pairs and its status, linked to
 * its own page, where it is reviewed. Nothing is decided here.
 */
function RelatedSettlement({ review }: { review: CardSettlementReview }): ReactNode {
  const { facts } = review;
  return (
    <li>
      <Badge tone={review.status === "accepted" ? "ok" : "neutral"}>
        {SETTLEMENT_STATUS[review.status]}
      </Badge>{" "}
      <Link to={`/reconciliation/${review.proposalId}`}>
        {statementSource(review)} {facts.statement.period ?? "請求月不明"} 請求分 ·{" "}
        {bankSourceLabel(facts.bankDebit.sourceId)}の出金
      </Link>
      <br />
      <span className="wrap-any">
        請求総額 <SettlementQuantity value={facts.statement.amount} /> · 引落予定日{" "}
        <DateValue value={facts.statement.paymentDate} /> / 出金額{" "}
        <SettlementQuantity value={facts.bankDebit.amount} /> · 出金日{" "}
        <DateValue value={facts.bankDebit.occurred} /> · {facts.bankDebit.sourceAccount}
      </span>
      {review.status === "proposed" && review.acceptanceBlockers.length > 0 ? (
        <>
          <br />
          <span className="dim">
            採用できない理由: {review.acceptanceBlockers.map(settlementReason).join("、")}
          </span>
        </>
      ) : null}
    </li>
  );
}

/**
 * The candidates `proposalId` competes with: those sharing its statement,
 * its bank debit or its statement month. While one is accepted the others
 * are `allocation_already_used`; correcting a wrong match is a withdrawal of
 * the accepted one, then the right one's acceptance, each its own decision.
 */
function RelatedSettlements({ proposalId }: { proposalId: string }): ReactNode {
  const [offset, setOffset] = useState(0);
  const query = useRelatedCardSettlements(proposalId, offset);
  return (
    <section className="panel" aria-labelledby="related-settlements">
      <div className="panel-head">
        <h2 id="related-settlements">同じ請求・出金の他の候補</h2>
      </div>
      <div className="panel-body">
        <p>
          同じ請求、同じ銀行出金、または同じカードの同じ請求月を対象とする候補です。採用済みの候補があるあいだ、他の候補は採用できません。
        </p>
        <p className="footnote">
          対応が誤っていた場合は、採用済みの候補で採用を解除してから、正しい候補を開いて採用します。解除と採用はそれぞれ新しい判断として追加され、以前の判断と原本は残ります。
        </p>
        <QueryBoundary
          query={query}
          label="他の候補"
          isEmpty={(data) => data.items.length === 0 && offset === 0}
          empty="同じ請求・出金を対象とする他の候補はありません。"
        >
          {(data) => (
            <>
              <ul className="plain-list" aria-label="他の候補">
                {data.items.map((item) => (
                  <RelatedSettlement key={item.proposalId} review={item} />
                ))}
              </ul>
              {offset > 0 || data.nextOffset !== null ? (
                <nav className="pagination" aria-label="他の候補のページ">
                  <span role="status" aria-live="polite">
                    {offset + 1}–{offset + data.items.length} 件目
                  </span>
                  <button
                    className="button"
                    type="button"
                    disabled={offset === 0}
                    onClick={() => setOffset(0)}
                  >
                    先頭に戻る
                  </button>
                  <button
                    className="button"
                    type="button"
                    disabled={data.nextOffset === null}
                    onClick={() =>
                      data.nextOffset === null ? undefined : setOffset(data.nextOffset)
                    }
                  >
                    次の候補
                  </button>
                </nav>
              ) : null}
            </>
          )}
        </QueryBoundary>
      </div>
    </section>
  );
}

/** One candidate on its own page, with the candidates it competes with. */
export function ReconciliationReviewPage({ proposalId }: { proposalId: string }): ReactNode {
  const features = useFeatures();
  const query = useCardSettlement(proposalId);
  if (!features.known) return <Loading label="照合候補" />;
  return (
    <>
      <div className="page-head">
        <div className="breadcrumb">
          <Link to="/reconciliation">照合候補の一覧に戻る</Link>
        </div>
        <h1>請求と引落の照合候補</h1>
        <p className="lede">
          この候補の原本と判断の履歴、同じ請求・出金を対象とする他の候補を確認します。候補は自動採用されません。
        </p>
      </div>
      {!features.cardSettlementReconciliation ? (
        <EmptyState>この接続先はカード決済の照合候補を提供していません。</EmptyState>
      ) : (
        <QueryBoundary
          query={query}
          label="照合候補"
          isEmpty={(review) => review === null}
          empty="この照合候補は見つかりません。"
        >
          {(review) =>
            review === null ? null : (
              <>
                <SettlementCard review={review} detail />
                <RelatedSettlements proposalId={review.proposalId} />
              </>
            )
          }
        </QueryBoundary>
      )}
    </>
  );
}
