import { useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import type {
  CardOwnershipReview,
  CardOwnershipSide,
} from "../../../../packages/domain/src/card-ownership-review.ts";
import { ownershipReviewPartyRef } from "../../../../packages/domain/src/ownership-review.ts";
import { ownershipDeclarationRef } from "../../../../packages/domain/src/ownership-declaration.ts";
import { useCardOwnership } from "../card-ownership-api.ts";
import { CardOwnershipDetails, OWNERSHIP_ROLES, ownerLabel } from "../card-ownership-display.tsx";
import { useFeatures } from "../api.ts";
import { postCommand, type ChangePlanView } from "../command-api.ts";
import { Link, navigate } from "../router.tsx";
import { EmptyState, Loading, Notice, Panel, QueryBoundary } from "../ui.tsx";

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
  const [basis, setBasis] = useState<"reviewed" | "self-declared">("reviewed");
  const [declaredOn, setDeclaredOn] = useState(() => new Date().toISOString().slice(0, 10));
  const declarationRef = ownershipDeclarationRef(side.role, declaredOn);
  const selfDeclared = basis === "self-declared";
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
            evidenceRefs: [
              ...side.evidenceRefs,
              ...(selfDeclared && declarationRef && action === "accept" ? [declarationRef] : []),
            ],
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
    (!selfDeclared || (declarationRef !== null && side.selfDeclarationBlockers.length === 0)) &&
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
        <Notice tone="bad" inline role="alert">
          識別名は128文字以内とし、縦線・スラッシュ・制御文字を含めないでください。
        </Notice>
      ) : null}
      <div className="field">
        <label htmlFor={`ownership-basis-${side.role}`}>根拠の種類</label>
        <select
          id={`ownership-basis-${side.role}`}
          value={basis}
          onChange={(event) => {
            setBasis(event.target.value === "self-declared" ? "self-declared" : "reviewed");
            setEvidence(false);
          }}
        >
          <option value="reviewed">原本などの根拠を確認した判断</option>
          <option value="self-declared">本人申告（名義は未確認）</option>
        </select>
      </div>
      {selfDeclared ? (
        <>
          <Notice tone="warn" inline role="note">
            本人の申告として記録します。銀行・カード会社の名義確認や本人確認が済んだ証明ではありません。共同・第三者・法人の関係、矛盾する根拠がある場合は選ばないでください。
          </Notice>
          <div className="field">
            <label htmlFor={`ownership-declared-on-${side.role}`}>本人申告の日付</label>
            <input
              id={`ownership-declared-on-${side.role}`}
              type="date"
              value={declaredOn}
              onChange={(event) => {
                setDeclaredOn(event.target.value);
                setEvidence(false);
              }}
            />
            <p className="footnote">
              申告した日です。口座を保有し始めた日や過去の名義の証明ではありません。
            </p>
          </div>
          {side.selfDeclarationBlockers.length > 0 ? (
            <Notice tone="warn" inline role="note">
              {side.selfDeclarationBlockers.includes("single_account_scope_unconfirmed")
                ? "この記録は集約・未解決、または個別のカード請求口座／預金口座と確認できない範囲です。表示件数をカード枚数とみなさず、個別口座との対応を先に確認してください。本人申告は記録できません。"
                : "既存の判断・矛盾または口座の更新を確認する必要があります。本人申告で上書きせず、記録済みの根拠を確認してください。"}
            </Notice>
          ) : null}
        </>
      ) : null}
      <label className="check-field ownership-evidence">
        <input
          type="checkbox"
          checked={evidence}
          onChange={(event) => setEvidence(event.target.checked)}
        />
        <span>
          {selfDeclared
            ? side.role === "beneficial_owner"
              ? "この原本と口座の対応を確認し、入力した識別名は私本人で、この銀行口座の資金を私が単独で保有し、共同・第三者・法人の口座ではないと申告する"
              : "この原本と口座の対応を確認し、入力した識別名は私本人で、このカード請求の支払義務を私が負い、家族・第三者・法人が支払義務者ではないと申告する"
            : "この原本と口座の対応を、入力した保有者の関係を判断する根拠として確認した"}
        </span>
      </label>
      <div className="field">
        <label htmlFor={`ownership-reason-${side.role}`}>
          {selfDeclared ? "本人申告の補足・判断の理由" : "判断の理由・原本で確認した箇所"}
        </label>
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
          disabled={!enabled || !existing || selfDeclared}
          onClick={() => plan.mutate("reject")}
        >
          この保有者の関係を却下する内容を確認
        </button>
      </div>
      {plan.isError ? (
        <Notice tone="bad" inline role="alert">
          {plan.error.message}
        </Notice>
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
          請求の支払義務と銀行口座の資金の保有者を別々に確認します。原本で確認した判断と、名義未確認の本人申告を区別して記録します。ログインした人や金額の一致からは決めません。
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
