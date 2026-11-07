// The client half of the operator's 依頼の経過 page (docs/ops-api.md,
// ADR 0048). The read is the server's `GET /api/ops/v1/operations/{id}`: one
// accepted operations request, its stages and — for a collection or a session
// refresh — the collector execution and the runs it reported, each followed to
// registration, parsing and publication or a closed reason. This module names
// every closed code in Japanese; a code without a name is shown as itself.
// Nothing here writes or requests an operation.
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { getJson } from "./api.ts";
import {
  OPERATION_ID,
  type OperationRecordWire,
} from "../../../packages/observation-shared/src/operation-contract.ts";

export type {
  OperationRecordExecutionWire,
  OperationRecordRunWire,
  OperationRecordWire,
} from "../../../packages/observation-shared/src/operation-contract.ts";
export { EVIDENCE_RUN_ID } from "../../../packages/observation-shared/src/operation-contract.ts";

/** The page of one operation: `/operations/op_<64 hex>`. */
export function operationRoute(operationId: string): string {
  return `/operations/${operationId}`;
}

/** Whether an identifier (an audit record's target, say) is an operation id. */
export function isOperationId(value: string): boolean {
  return OPERATION_ID.test(value);
}

/**
 * One operation's stored record. Read once when the page opens and again only
 * when the operator asks: the record is live from CORE, but nothing here
 * polls, so an open page is never a stream of audited reads.
 */
export function useOperation(operationId: string): UseQueryResult<OperationRecordWire, Error> {
  return useQuery({
    queryKey: ["operation", operationId],
    queryFn: ({ signal }) =>
      // Spelled out, not built from OPERATION_RECORD_PATH_PREFIX: the UI/MCP
      // parity guard reads this as `/api/ops/v1/operations/:id`, while the bare
      // prefix would name the list route, which no page reads (ADR 0086).
      getJson<OperationRecordWire>(`/api/ops/v1/operations/${operationId}`, signal),
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export const OPERATION_KIND_LABELS: Readonly<Record<string, string>> = {
  collection: "収集",
  import: "取り込み（保存済みの収集結果の登録）",
  replay: "再処理（解析のやり直し）",
  projection: "読み取りモデルの再構築",
  "session-refresh": "セッション更新",
};

export const OPERATION_STATUS_LABELS: Readonly<Record<string, string>> = {
  accepted: "受付済み（未実行）",
  waiting_for_human: "本人操作待ち",
  running: "進行中",
  completed: "完了",
  failed: "失敗",
  blocked: "停止",
};

export const OPERATION_DISPATCH_LABELS: Readonly<Record<string, string>> = {
  not_required: "引き渡し不要",
  dispatch_pending: "処理への引き渡し待ち",
  dispatched: "処理へ引き渡し済み",
  dispatch_failed: "引き渡しに失敗",
};

export const OPERATION_STAGE_LABELS: Readonly<Record<string, string>> = {
  persisted: "収集結果の保存",
  registered: "取得記録への登録",
  parsed: "解析",
  adopted: "採用・公開",
  projected: "読み取りモデルへの反映",
};

export const OPERATION_STAGE_STATE_LABELS: Readonly<Record<string, string>> = {
  pending: "未到達",
  completed: "完了",
  retryable: "再試行待ち",
  blocked: "停止",
};

export const EXECUTION_STATE_LABELS: Readonly<Record<string, string>> = {
  accepted: "受付済み・未実行",
  waiting_for_human: "本人操作待ち",
  waiting: "開始待ち",
  started: "収集を開始・結果待ち",
  collected: "収集済み・公開を確認中",
  refreshed: "セッション更新済み",
  published: "公開を確認",
  unpublished: "公開されず",
  failed: "失敗",
  uncertain: "結果を確認できません",
  expired: "開始されないまま期限切れ",
  unsupported: "対応する接続なし",
};

/** The closed reason codes of the execution, its runs and its stages (docs/ops-api.md). */
export const EXECUTION_REASON_LABELS: Readonly<Record<string, string>> = {
  collection_unsupported: "この取得元には収集の接続がありません",
  session_refresh_unsupported: "この取得元には無人のセッション更新がありません",
  collector_binding_missing: "この環境に収集処理への接続がありません",
  operation_expired: "受付から24時間以内に開始されませんでした",
  collector_dispatch_disabled: "この接続からの実行は有効になっていません",
  provider_maintenance: "取得元の定例停止中です",
  collection_lease_held: "別の実行（定期実行など）が進行中です",
  dispatch_deferred: "この回の処理では別の収集を開始済みです",
  collection_busy: "開始直前に別の実行が始まりました",
  collection_failed: "収集処理が失敗を報告しました",
  collector_result_invalid: "収集処理の応答が決まった形ではありません",
  dispatch_uncertain: "呼び出しの結果を確認できません",
  run_not_reported: "収集処理が実行記録を報告していません",
  publication_not_observed: "収集から48時間以内に公開を確認できませんでした",
  provider_failed: "取得元からの取得が失敗しました",
  no_parser_selected: "解析対象のファイルがありません",
  parse_failed: "解析に失敗しました",
  not_adopted: "解析結果が採用されていません",
  registration_blocked: "取得記録への登録が拒否されました",
};

export const RUN_STATE_LABELS: Readonly<Record<string, string>> = {
  not_registered: "未登録",
  registering: "登録中",
  blocked: "登録を拒否",
  parsing: "解析中",
  published: "公開済み",
  unpublished: "公開されず",
};

export const PROVIDER_OUTCOME_LABELS: Readonly<Record<string, string>> = {
  success: "成功",
  partial: "一部のみ",
  failed: "失敗",
};
