import { useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { useFeatures } from "../api.ts";
import { useCardSettlements, type CardSettlementReview } from "../reconciliation-api.ts";
import { CardSettlementDetails } from "../reconciliation-display.tsx";
import { postCommand, type ChangePlanView } from "../command-api.ts";
import { navigate } from "../router.tsx";
import { EmptyState, ErrorState, Loading, Panel } from "../ui.tsx";

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
      <p className="panel-note">
        この候補の判断は保存されています。対応先を訂正する場合は、別の候補を原本と照合して採用してください。
      </p>
    );
  return (
    <>
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
      <p className="panel-note">
        次の画面で内容を確認し、承認してから確定します。確認画面を開くだけでは採用・却下しません。
      </p>
      {plan.isError ? <p role="alert">{plan.error.message}</p> : null}
    </>
  );
}

export function ReconciliationPage(): ReactNode {
  const features = useFeatures();
  const [offset, setOffset] = useState(0);
  const query = useCardSettlements(offset);
  if (!features.known) return <Loading label="照合機能" />;
  if (!features.cardSettlementReconciliation)
    return (
      <>
        <h1>カード請求と引落の照合</h1>
        <EmptyState>この接続先はカード決済の照合候補を提供していません。</EmptyState>
      </>
    );
  if (query.isPending) return <Loading label="照合候補" />;
  if (query.isError)
    return <ErrorState error={query.error} label="照合候補" onRetry={() => void query.refetch()} />;
  return (
    <>
      <h1>カード請求と引落の照合</h1>
      <p>
        カード会社の請求総額と銀行の出金を、原本を見ながら確認します。候補は自動採用されません。
      </p>
      <p className="panel-note">
        対象は取得済みの請求・銀行明細です。候補がないことは、未払がないことや照合が完了したことを意味しません。
      </p>
      {query.data.items.length === 0 ? (
        <EmptyState>現在表示できる照合候補はありません。</EmptyState>
      ) : (
        query.data.items.map((review) => (
          <Panel
            key={review.proposalId}
            id={`review-${review.proposalId}`}
            title={`${review.facts.statement.sourceId === "vpass" ? "Vpass" : "MyJCB"} の請求と銀行引落`}
          >
            <CardSettlementDetails review={review} />
            <ReviewActions review={review} />
          </Panel>
        ))
      )}
      <div className="button-row" aria-label="照合候補のページ">
        {offset > 0 ? (
          <button className="button" type="button" onClick={() => setOffset(0)}>
            先頭に戻る
          </button>
        ) : null}
        {query.data.nextOffset !== null ? (
          <button
            className="button"
            type="button"
            onClick={() => setOffset(query.data.nextOffset!)}
          >
            次の候補
          </button>
        ) : null}
      </div>
    </>
  );
}
