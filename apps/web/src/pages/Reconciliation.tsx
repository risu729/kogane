import { useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { useFeatures } from "../api.ts";
import { useCardSettlements, type CardSettlementReview } from "../reconciliation-api.ts";
import {
  CardSettlementDetails,
  DateValue,
  SETTLEMENT_STATUS,
  SettlementQuantity,
} from "../reconciliation-display.tsx";
import { postCommand, type ChangePlanView } from "../command-api.ts";
import { Link, navigate } from "../router.tsx";
import { Badge, EmptyState, Loading, QueryBoundary } from "../ui.tsx";

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
        <p className="notice notice-bad" role="alert">
          {plan.error.message}
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
              {facts.bankDebit.sourceId} · {facts.bankDebit.sourceAccount}
            </dd>
          </div>
        </dl>
      </div>
      <details
        className="detail-disclosure settlement-disclosure"
        open={review.status === "proposed"}
      >
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

export function ReconciliationPage(): ReactNode {
  const features = useFeatures();
  const [offset, setOffset] = useState(0);
  const query = useCardSettlements(offset);
  if (!features.known) return <Loading label="照合機能" />;
  return (
    <>
      <div className="page-head">
        <h1>カード請求と引落の照合</h1>
        <p className="lede">
          カード会社の請求総額と銀行の出金を、原本を見ながら確認します。候補は自動採用されません。
        </p>
        <p className="footnote">
          対象は取得済みの請求・銀行明細です。候補がないことは、未払がないことや照合が完了したことを意味しません。
        </p>
      </div>
      {!features.cardSettlementReconciliation ? (
        <EmptyState>この接続先はカード決済の照合候補を提供していません。</EmptyState>
      ) : (
        <QueryBoundary
          query={query}
          label="照合候補"
          isEmpty={(data) => data.items.length === 0}
          empty="現在表示できる照合候補はありません。"
        >
          {(data) => (
            <>
              {data.items.map((review) => (
                <SettlementCard key={review.proposalId} review={review} />
              ))}
              <nav className="pagination" aria-label="照合候補のページ">
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
            </>
          )}
        </QueryBoundary>
      )}
    </>
  );
}
