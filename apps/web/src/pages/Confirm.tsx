// The correction confirmation screen (addendum 11 §5, A09).
//
// Five things this screen must not do: recompute the difference in the
// browser, show a caller's own claim about impact, offer an action the server
// has not advertised, reuse an approval after the targets moved, or report a
// change as finished when it is only accepted. The counts, the staleness and
// the receipt state all come from the server.
import { useCallback, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFeatures } from "../api.ts";
import { useCardOwnership } from "../card-ownership-api.ts";
import { CardOwnershipDetails, OWNERSHIP_ROLES, ownerLabel } from "../card-ownership-display.tsx";
import { useCardSettlement } from "../reconciliation-api.ts";
import { CardSettlementDetails } from "../reconciliation-display.tsx";
import { Link } from "../router.tsx";
import { Badge, EmptyState, ErrorState, Kv, KvRow, Loading, Panel } from "../ui.tsx";
import {
  CommandError,
  postCommand,
  type ApprovalView,
  type ReceiptView,
  type SimulationReportView,
} from "../command-api.ts";

const KIND_LABELS: Record<string, string> = {
  "identity.assign": "対応付けの手動確定",
  "identity.release-override": "手動確定の解除（自動方針に戻す）",
  "relation.accept": "関係の採用",
  "relation.reject": "関係の却下",
  "card-settlement.accept": "カード請求と銀行引落の対応付けを採用",
  "card-settlement.reject": "カード決済の照合候補を却下",
  "card-settlement.withdraw": "カード決済の採用を解除",
};

const RECEIPT_STATE: Record<string, { tone: "ok" | "warn" | "bad"; label: string; note: string }> =
  {
    accepted: {
      tone: "warn",
      label: "受理",
      note: "判断は保存されました。読み取りモデルへの反映はまだ完了していません。",
    },
    published: {
      tone: "ok",
      label: "反映済み",
      note: "判断が保存され、対象の読み取りモデルへの反映も完了しました。",
    },
    failed: {
      tone: "bad",
      label: "失敗",
      note: "この操作は完了していません。記録を確認してください。",
    },
  };

function targetLabel(value: string | null): ReactNode {
  return value === null ? <span className="muted">未定（方針が決定）</span> : <code>{value}</code>;
}

export function ConfirmPage({ planId }: { planId: string }): ReactNode {
  const features = useFeatures();
  const client = useQueryClient();
  const [approval, setApproval] = useState<ApprovalView | null>(null);
  const [receipt, setReceipt] = useState<ReceiptView | null>(null);
  const [receiptError, setReceiptError] = useState<string | null>(null);
  // One operation id per approval: a resend of the same confirmation is the
  // same operation, so a lost response never commits twice (addendum 10 §6).
  const [operationId, setOperationId] = useState<string | null>(null);

  const report = useQuery({
    queryKey: ["command", "simulate", planId],
    queryFn: ({ signal }) =>
      postCommand<{ report: SimulationReportView }>("simulate", { planId }, signal).then(
        (value) => value.report,
      ),
    retry: false,
  });

  const requiresSettlement = report.data?.simulation.kind.startsWith("card-settlement.") === true;
  const settlementTarget = report.data?.simulation.targets.find((target) =>
    target.subjectRef.startsWith("card-settlement:"),
  );
  const settlementProposalId =
    requiresSettlement && settlementTarget
      ? settlementTarget.subjectRef.slice("card-settlement:".length)
      : null;
  const settlement = useCardSettlement(settlementProposalId);
  const ownershipTarget = report.data?.simulation.targets.find((target) =>
    /^relation:(liable_party|beneficial_owner)\|account:/u.test(target.subjectRef),
  );
  const ownershipMatch = ownershipTarget
    ? /^relation:(liable_party|beneficial_owner)\|account:([^|]+)\|(party:[^|]+)$/u.exec(
        ownershipTarget.subjectRef,
      )
    : null;
  const requiresOwnership =
    report.data?.simulation.invalidations.includes("review:card-ownership") === true;
  const ownershipProposalId =
    requiresOwnership && settlementTarget
      ? settlementTarget.subjectRef.slice("card-settlement:".length)
      : null;
  const ownership = useCardOwnership(ownershipProposalId);
  const ownershipSide = ownership.data?.sides.find(
    (side) => side.role === ownershipMatch?.[1] && side.accountId === ownershipMatch?.[2],
  );
  const ownershipReady =
    !requiresOwnership ||
    (features.cardOwnershipReview &&
      ownership.data !== undefined &&
      ownershipSide !== undefined &&
      ownershipSide.blockers.length === 0 &&
      ownershipMatch !== null &&
      ownership.data.revision ===
        report.data?.expectedRevisions[`card-settlement:${ownershipProposalId}`] &&
      ownershipSide.mappingRevision ===
        report.data?.expectedRevisions[`account_mapping:${ownershipSide.sourceAccountId}`] &&
      ownershipSide.ownershipRevision ===
        report.data?.expectedRevisions[
          `ownership:${ownershipSide.role}|${ownershipSide.accountId}`
        ]);

  const settlementRevisionMatches =
    !requiresSettlement ||
    (settlement.data != null &&
      settlementTarget !== undefined &&
      settlement.data.revision === report.data?.expectedRevisions[settlementTarget.subjectRef]);
  const settlementActionAllowed =
    !requiresSettlement ||
    (settlement.data != null &&
      (report.data?.simulation.kind === "card-settlement.accept"
        ? settlement.data.status === "proposed" && settlement.data.acceptanceBlockers.length === 0
        : report.data?.simulation.kind === "card-settlement.reject"
          ? settlement.data.status === "proposed"
          : report.data?.simulation.kind === "card-settlement.withdraw" &&
            settlement.data.status === "accepted"));
  const settlementReady =
    (!requiresSettlement || features.cardSettlementReconciliation) &&
    settlementRevisionMatches &&
    settlementActionAllowed;

  const approveMutation = useMutation({
    mutationFn: async (digest: string) => {
      const value = await postCommand<{ approval: ApprovalView }>(
        "approve",
        { planId, planDigest: digest },
        new AbortController().signal,
      );
      return value.approval;
    },
    onSuccess: (value) => {
      setApproval(value);
      setOperationId(`op-${value.approvalId.slice(3, 35)}`);
    },
  });

  const commitMutation = useMutation({
    mutationFn: async (input: { approvalId: string; operationId: string }) => {
      const value = await postCommand<{ receipt: ReceiptView }>(
        "commit",
        { planId, approvalId: input.approvalId, operationId: input.operationId },
        new AbortController().signal,
      );
      return value.receipt;
    },
    onSuccess: (value) => {
      setReceipt(value);
      void client.invalidateQueries({ queryKey: ["command", "simulate", planId] });
    },
  });

  const refreshReceipt = useCallback(() => {
    if (operationId === null) return;
    setReceiptError(null);
    void postCommand<{ receipt: ReceiptView }>(
      "operation",
      { operationId },
      new AbortController().signal,
    )
      .then((value) => setReceipt(value.receipt))
      .catch(() =>
        setReceiptError(
          "反映状況を確認できませんでした。受理済みの判断を再送せず、状況確認をやり直してください。",
        ),
      );
  }, [operationId]);

  if (report.isPending) return <Loading label="確認内容" />;
  if (report.isError)
    return (
      <ErrorState error={report.error} label="確認内容" onRetry={() => void report.refetch()} />
    );
  const data = report.data;
  const stale = data.stale;
  const canAct = features.known && features.commands && !stale && settlementReady && ownershipReady;

  return (
    <>
      <h1>変更の確認</h1>
      <Panel
        id="plan-summary"
        title={KIND_LABELS[data.simulation.kind] ?? data.simulation.kind}
        note={
          features.known && !features.commands
            ? "この接続先は確認操作を提供していません。内容の表示のみ行えます。"
            : undefined
        }
      >
        <Kv>
          <KvRow label="計画ID">
            <code>{data.planId}</code>
          </KvRow>
          <KvRow label="状態">
            {stale ? (
              <Badge tone="bad">対象が変更されています</Badge>
            ) : (
              <Badge tone="ok">確認した内容のまま</Badge>
            )}
          </KvRow>
          {stale ? (
            <KvRow label="再試算後の計画ID">
              <code>{data.resimulatedPlanId}</code>
            </KvRow>
          ) : null}
        </Kv>
        {stale ? (
          <p className="panel-note" role="alert">
            この計画が読み取った版から対象が変わりました。古い承認は適用されません。再試算した計画で
            確認し直してください。
          </p>
        ) : null}
      </Panel>

      {requiresOwnership ? (
        <Panel id="ownership-review" title="口座の保有者の判断">
          {ownership.isPending ? (
            <Loading label="保有者の根拠" />
          ) : ownership.isError ? (
            <ErrorState
              error={ownership.error}
              label="保有者の根拠"
              onRetry={() => void ownership.refetch()}
            />
          ) : ownershipSide && ownershipMatch ? (
            <>
              <p>
                <strong>{OWNERSHIP_ROLES[ownershipSide.role]}</strong>:{" "}
                {ownerLabel(ownershipMatch[3]!)} の関係を
                {data.simulation.kind === "relation.reject" ? "却下" : "採用"}します。
              </p>
              <CardOwnershipDetails side={ownershipSide} />
              <p>
                選択した原本・解析版・口座の対応を根拠として、期間を限定しない関係を記録します。識別名だけで保有者を証明するものではありません。
              </p>
            </>
          ) : (
            <p role="alert">計画した口座と根拠の詳細を取得できません。</p>
          )}
          {!ownershipReady && ownership.isSuccess ? (
            <p role="alert">
              口座または保有者の記録が計画作成後に変わっています。新しい計画で確認し直してください。
            </p>
          ) : null}
          <p className="panel-note">
            保有者の判断を保存してもカード決済は採用されません。次の定期処理で新しい照合候補が作成された後、請求と銀行引落を別に確認してください。
          </p>
          {ownershipProposalId ? (
            <Link to={`/reconciliation/${ownershipProposalId}/ownership`}>
              口座の保有者の確認に戻る
            </Link>
          ) : null}
        </Panel>
      ) : null}
      {requiresSettlement ? (
        <Panel id="settlement-review" title="請求・銀行原本と金額の確認">
          {!features.cardSettlementReconciliation ? (
            <p role="alert">照合の詳細を取得できない接続先のため、承認・確定できません。</p>
          ) : settlement.isPending ? (
            <Loading label="照合の根拠" />
          ) : settlement.isError ? (
            <ErrorState
              error={settlement.error}
              label="照合の根拠"
              onRetry={() => void settlement.refetch()}
            />
          ) : settlement.data ? (
            <CardSettlementDetails review={settlement.data} />
          ) : (
            <p role="alert">対象の照合候補が見つかりません。</p>
          )}
          {!settlementRevisionMatches && settlement.isSuccess ? (
            <p role="alert">
              候補の判断が計画作成後に更新されています。新しい計画で確認し直してください。
            </p>
          ) : null}
          {!settlementActionAllowed && settlement.isSuccess ? (
            <p role="alert">
              この候補では計画した操作を実行できません。条件と根拠を一覧で確認し直してください。
            </p>
          ) : null}
          {data.simulation.kind === "card-settlement.withdraw" ? (
            <p className="panel-note">
              解除するのは請求と引落の対応付けです。銀行の出金原本は残り、現金が返却されたことにはなりません。
            </p>
          ) : null}
          <p>
            <Link to="/reconciliation">照合候補に戻る</Link>
          </p>
        </Panel>
      ) : null}

      <Panel id="plan-targets" title="対象" count={data.simulation.targets.length}>
        {data.simulation.targets.length === 0 ? (
          <EmptyState>対象がありません。</EmptyState>
        ) : (
          <div className="table-scroll">
            <table
              className={requiresSettlement || requiresOwnership ? "settlement-targets" : undefined}
            >
              <thead>
                <tr>
                  <th scope="col">対象</th>
                  <th scope="col">計画時の版</th>
                  <th scope="col">現在の版</th>
                  <th scope="col">現在の対応先</th>
                  <th scope="col">変更後の対応先</th>
                </tr>
              </thead>
              <tbody>
                {data.simulation.targets.map((row) => (
                  <tr key={row.subjectRef}>
                    <th scope="row">
                      <code>{row.subjectRef}</code>
                    </th>
                    <td>{data.expectedRevisions[row.subjectRef] ?? row.currentRevision}</td>
                    <td>{data.currentRevisions[row.subjectRef] ?? "—"}</td>
                    <td>{targetLabel(row.currentTargetRef)}</td>
                    <td>{targetLabel(row.proposedTargetRef)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel
        id="plan-diff"
        title="サーバーが計算した差分"
        note={
          requiresSettlement
            ? "変更計画には件数と対象の識別子を記録します。照合の金額は上の原本・決済情報で確認します。"
            : "件数と対象の識別子のみです。金額はこの画面では扱いません。"
        }
      >
        <Kv>
          <KvRow label="対応付けが変わる明細">
            {data.simulation.before.attributedObservations} 件 →{" "}
            {data.simulation.after.attributedObservations} 件
          </KvRow>
          <KvRow label="関係の件数">
            {data.simulation.before.relations} 件 → {data.simulation.after.relations} 件
          </KvRow>
          <KvRow label="再処理対象の解析実行">{data.simulation.affectedParseRuns} 件</KvRow>
          <KvRow label="影響する取得元">
            {data.simulation.affectedScopes.length === 0
              ? "—"
              : data.simulation.affectedScopes.join("、")}
          </KvRow>
          <KvRow label="無効化される読み取りモデル">
            {data.simulation.invalidations.join("、")}
          </KvRow>
          <KvRow label="反映先">{data.simulation.outboxTargets.join("、")}</KvRow>
        </Kv>
      </Panel>

      <Panel id="plan-actions" title="承認と確定">
        {!features.known ? (
          <p className="panel-note">接続先の機能を確認しています…</p>
        ) : !features.commands ? (
          <p className="panel-note">
            この接続先では確認操作が有効ではないため、承認・確定は行えません。
          </p>
        ) : null}
        <div className="button-row">
          <button
            className="button"
            type="button"
            disabled={!canAct || approveMutation.isPending || approval !== null}
            onClick={() => approveMutation.mutate(data.planDigest)}
          >
            {approveMutation.isPending ? "承認中…" : approval === null ? "承認する" : "承認済み"}
          </button>
          <button
            className="button"
            type="button"
            disabled={
              !canAct ||
              approval === null ||
              operationId === null ||
              commitMutation.isPending ||
              receipt !== null
            }
            onClick={() =>
              approval !== null && operationId !== null
                ? commitMutation.mutate({ approvalId: approval.approvalId, operationId })
                : undefined
            }
          >
            {commitMutation.isPending ? "確定中…" : "確定する"}
          </button>
        </div>
        {approveMutation.isError ? (
          <p className="panel-note" role="alert">
            {approveMutation.error instanceof CommandError
              ? approveMutation.error.message
              : "承認できませんでした。"}
          </p>
        ) : null}
        {commitMutation.isError ? (
          <p className="panel-note" role="alert">
            {commitMutation.error instanceof CommandError
              ? commitMutation.error.message
              : "確定できませんでした。"}
          </p>
        ) : null}
      </Panel>

      {receipt === null ? null : (
        <Panel id="plan-receipt" title="操作の記録">
          <Kv>
            <KvRow label="操作ID">
              <code>{receipt.operationId}</code>
            </KvRow>
            <KvRow label="状態">
              <Badge tone={RECEIPT_STATE[receipt.status]?.tone ?? "neutral"}>
                {RECEIPT_STATE[receipt.status]?.label ?? receipt.status}
              </Badge>
            </KvRow>
            <KvRow label="受理">{receipt.acceptedAt}</KvRow>
            <KvRow label="反映完了">
              {receipt.publishedAt ?? <span className="muted">未完了</span>}
            </KvRow>
            <KvRow label="判断の記録">
              <code>{receipt.decisionRevisionId}</code>
            </KvRow>
          </Kv>
          <p className="panel-note" role="status">
            {RECEIPT_STATE[receipt.status]?.note ?? ""}
          </p>
          {receiptError ? <p role="alert">{receiptError}</p> : null}
          {receipt.status === "accepted" ? (
            <div className="button-row">
              <button className="button" type="button" onClick={refreshReceipt}>
                反映状況を再確認
              </button>
            </div>
          ) : null}
        </Panel>
      )}
    </>
  );
}
