import { useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import type {
  CardOwnershipReview,
  CardOwnershipSide,
} from "../../../../packages/domain/src/card-ownership-review.ts";
import { ownershipReviewPartyRef } from "../../../../packages/domain/src/ownership-review.ts";
import { useCardOwnership } from "../card-ownership-api.ts";
import { CardOwnershipDetails, OWNERSHIP_ROLES, ownerLabel } from "../card-ownership-display.tsx";
import { useFeatures } from "../api.ts";
import { postCommand, type ChangePlanView } from "../command-api.ts";
import { Link, navigate } from "../router.tsx";
import { EmptyState, Loading, Panel, QueryBoundary } from "../ui.tsx";

function OwnershipForm({
  review,
  side,
}: {
  review: CardOwnershipReview;
  side: CardOwnershipSide;
}): ReactNode {
  const features = useFeatures();
  const [label, setLabel] = useState("");
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState(false);
  const partyRef = "party:" + label.trim();
  const existing = side.claims.some((c) => c.partyRef === partyRef && c.status === "accepted");
  const plan = useMutation({
    mutationFn: async (action: "accept" | "reject") => {
      const value = await postCommand<{ plan: ChangePlanView }>(
        "plan",
        {
          kind: `relation.${action}`,
          payload: {
            relationKind: side.role,
            fromRef: `account:${side.accountId}`,
            toRef: partyRef,
            validFrom: null,
            validTo: null,
            evidenceRefs: side.evidenceRefs,
            reason: reason.trim(),
          },
          baseContextId: `card-ownership:${review.proposalId}:${side.role}`,
        },
        new AbortController().signal,
      );
      const expected = value.plan.expectedRevisions;
      if (
        expected[`card-settlement:${review.proposalId}`] !== review.revision ||
        expected[`account_mapping:${side.sourceAccountId}`] !== side.mappingRevision ||
        expected[`ownership:${side.role}|${side.accountId}`] !== side.ownershipRevision
      )
        throw new Error(
          "口座または保有者の記録が更新されています。表示を更新して確認し直してください。",
        );
      return value.plan;
    },
    onSuccess: (value) => navigate(`/confirm/${value.planId}`),
  });
  const enabled =
    features.known &&
    features.commands &&
    features.cardOwnershipReview &&
    side.blockers.length === 0 &&
    side.accountId !== null &&
    evidence &&
    reason.trim().length > 0 &&
    ownershipReviewPartyRef(partyRef) &&
    !plan.isPending;
  const suggestions = [
    ...new Set(
      review.sides.flatMap((s) => s.claims.map((c) => c.partyRef)).filter(ownershipReviewPartyRef),
    ),
  ];
  const invalidLabel = label.length > 0 && !ownershipReviewPartyRef(partyRef);
  return (
    <div className="ownership-form">
      <div className="field">
        <label htmlFor={`owner-${side.role}`}>保有者の識別名</label>
        <input
          id={`owner-${side.role}`}
          value={label}
          maxLength={128}
          list={`owners-${side.role}`}
          autoComplete="off"
          onChange={(event) => {
            setLabel(event.target.value);
            setEvidence(false);
          }}
          aria-invalid={invalidLabel ? true : undefined}
          aria-describedby={`owner-help-${side.role}`}
        />
        <datalist id={`owners-${side.role}`}>
          {suggestions.map((ref) => (
            <option key={ref} value={ownerLabel(ref)} />
          ))}
        </datalist>
        <p id={`owner-help-${side.role}`} className="footnote">
          誰の記録かを区別する名前です。同じ人には両方の口座で同じ識別名を使ってください。名前だけでは保有者の証明になりません。本人確認番号やパスワードは入力しないでください。
        </p>
      </div>
      {invalidLabel ? (
        <p className="notice notice-bad" role="alert">
          識別名は128文字以内とし、縦線・スラッシュ・制御文字を含めないでください。
        </p>
      ) : null}
      <label className="check-field ownership-evidence">
        <input
          type="checkbox"
          checked={evidence}
          onChange={(event) => setEvidence(event.target.checked)}
        />
        <span>この原本と口座の対応を、入力した保有者の関係を判断する根拠として確認した</span>
      </label>
      <div className="field">
        <label htmlFor={`ownership-reason-${side.role}`}>判断の理由・原本で確認した箇所</label>
        <textarea
          id={`ownership-reason-${side.role}`}
          className="settlement-reason"
          rows={3}
          maxLength={1000}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </div>
      <div className="button-row">
        <button
          type="button"
          className="button"
          disabled={!enabled}
          onClick={() => plan.mutate("accept")}
        >
          この保有者の関係を確認
        </button>
        <button
          type="button"
          className="button"
          disabled={!enabled || !existing}
          onClick={() => plan.mutate("reject")}
        >
          この保有者の関係を却下する内容を確認
        </button>
      </div>
      {plan.isError ? (
        <p className="notice notice-bad" role="alert">
          {plan.error.message}
        </p>
      ) : null}
      <p className="footnote">
        ここでは期間を限定しない関係を記録します。名義変更や期間の指定が必要な場合は、この画面では確定しないでください。次の画面で承認・確定するまで判断は保存されません。
      </p>
    </div>
  );
}
export function CardOwnershipPage({ proposalId }: { proposalId: string }): ReactNode {
  const features = useFeatures();
  const query = useCardOwnership(proposalId);
  if (!features.known) return <Loading label="保有者の確認" />;
  return (
    <>
      <div className="page-head">
        <div className="breadcrumb">
          <Link to="/reconciliation">照合候補に戻る</Link>
        </div>
        <h1>口座の保有者を確認</h1>
        <p className="lede">
          請求の支払義務と銀行口座の資金の保有者を、別々に原本で確認します。ログインした人や金額の一致からは決めません。
        </p>
        <p className="footnote">
          この判断だけではカード決済を採用しません。関係が反映された後、新しく作成された照合候補で請求と引落を再確認してください。
        </p>
      </div>
      {!features.cardOwnershipReview ? (
        <EmptyState>この接続先は保有者の確認を提供していません。</EmptyState>
      ) : (
        <QueryBoundary query={query} label="口座と保有者の根拠">
          {(data) =>
            data.sides.map((side) => (
              <Panel
                key={side.role}
                id={`ownership-${side.role}`}
                title={OWNERSHIP_ROLES[side.role]}
              >
                <div className="panel-body">
                  <CardOwnershipDetails side={side} />
                  <OwnershipForm
                    key={`${side.mappingRevision}:${side.ownershipRevision}:${data.revision}`}
                    review={data}
                    side={side}
                  />
                </div>
              </Panel>
            ))
          }
        </QueryBoundary>
      )}
    </>
  );
}
