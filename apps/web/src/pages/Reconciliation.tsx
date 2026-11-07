import { useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { useFeatures } from "../api.ts";
import {
  useCardSettlementStatements,
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
        この候補の判断は保存されています。対応先を訂正する場合は、別の候補を原本と照合して採用してください。
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
 * under a disclosure that starts open only while a decision is still due.
 */
function SettlementCard({ review }: { review: CardSettlementReview }): ReactNode {
  const features = useFeatures();
  const id = `review-${review.proposalId}`;
  const { facts } = review;
  return (
    <section className="panel" aria-labelledby={id}>
      <div className="panel-head settlement-head">
        <h2 id={id}>{statementSource(review)} の請求と銀行引落</h2>
        <Badge tone={review.status === "accepted" ? "ok" : "neutral"}>
          {SETTLEMENT_STATUS[review.status]}
        </Badge>
        <dl className="settlement-facts">
          <div>
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
        </dl>
      </div>
      <details className="settlement-disclosure" open={review.status === "proposed"}>
        <summary>候補の詳細と判断</summary>
        <div className="panel-body">
          <CardSettlementDetails review={review} />
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
