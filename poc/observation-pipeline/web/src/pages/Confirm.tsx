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
    void postCommand<{ receipt: ReceiptView }>(
      "operation",
      { operationId },
      new AbortController().signal,
    ).then((value) => setReceipt(value.receipt));
  }, [operationId]);

  if (report.isPending) return <Loading label="確認内容" />;
  if (report.isError)
    return (
      <ErrorState error={report.error} label="確認内容" onRetry={() => void report.refetch()} />
    );
  const data = report.data;
  const stale = data.stale;
  const canAct = features.known && features.commands && !stale;

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

      <Panel id="plan-targets" title="対象" count={data.simulation.targets.length}>
        {data.simulation.targets.length === 0 ? (
          <EmptyState>対象がありません。</EmptyState>
        ) : (
          <div className="table-scroll">
            <table>
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
        note="件数と対象の識別子のみです。金額はこの画面では扱いません。"
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
          <p className="panel-note">{RECEIPT_STATE[receipt.status]?.note ?? ""}</p>
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
