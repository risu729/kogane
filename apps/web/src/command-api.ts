// The client half of the change lifecycle (A09). Everything shown on the
// confirmation screen is computed by the server: this module carries plan ids
// and receipts, never a recomputed difference and never a local decision about
// whether something may be approved.
//
// The buttons are enabled by the advertised `commands` capability only. That
// is a display decision: the server still authenticates, checks the grant, and
// refuses an agent's approval whatever the client sends.
import type { OwnershipSelfDeclaration } from "../../../packages/domain/src/ownership-declaration.ts";

export const COMMAND_PREFIX = "/api/command/v1";

/**
 * How the confirmation screen names each change kind. The card purchase
 * review kinds (ADR 0017) are listed so a plan of theirs is never shown by its
 * raw code; the server refuses to plan them until their planners exist, and
 * no screen offers them yet.
 */
export const COMMAND_KIND_LABELS: Readonly<Record<string, string>> = {
  "identity.assign": "対応付けの手動確定",
  "identity.release-override": "手動確定の解除（自動方針に戻す）",
  "relation.accept": "関係の採用",
  "relation.reject": "関係の却下",
  "card-settlement.accept": "カード請求と銀行引落の対応付けを採用",
  "card-settlement.reject": "カード決済の照合候補を却下",
  "card-settlement.withdraw": "カード決済の採用を解除",
  "card-purchase.exclude": "カード利用を購入から除外",
  "card-purchase.restore": "購入からの除外を取り消す",
  "card-refund.allocate": "返金を購入に充当",
  "card-refund.withdraw": "返金の充当を取り消す",
  "card-installment.link": "分割払いの後続回を支払計画に紐付け",
  "card-installment.unlink": "分割払いの後続回の紐付けを解除",
};

export interface PlanTargetView {
  subjectRef: string;
  currentRevision: number;
  currentTargetRef: string | null;
  proposedTargetRef: string | null;
}
export interface SimulationView {
  kind: string;
  targets: PlanTargetView[];
  before: { attributedObservations: number; relations: number };
  after: { attributedObservations: number; relations: number };
  invalidations: string[];
  affectedScopes: string[];
  affectedParseRuns: number;
  outboxTargets: string[];
  ownershipDeclaration?: OwnershipSelfDeclaration;
}
export interface ChangePlanView {
  planId: string;
  planDigest: string;
  kind: string;
  baseContextId: string;
  expectedRevisions: Record<string, number>;
  simulation: SimulationView;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  status: string;
}
export interface SimulationReportView {
  planId: string;
  planDigest: string;
  simulation: SimulationView;
  expectedRevisions: Record<string, number>;
  currentRevisions: Record<string, number>;
  stale: boolean;
  resimulatedPlanId: string;
}
export interface ApprovalView {
  approvalId: string;
  planId: string;
  planDigest: string;
  approverActor: string;
  expiresAt: string;
  usesRemaining: number;
}
export interface ReceiptView {
  operationId: string;
  operationKind: string;
  planId: string;
  status: "accepted" | "published" | "failed";
  acceptedAt: string;
  publishedAt: string | null;
  decisionRevisionId: string;
  outboxTargets: string[];
  result: Record<string, unknown>;
}

export class CommandError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "CommandError";
    this.status = status;
    this.code = code;
  }

  /**
   * Whether the same request would be refused again, so offering a retry would
   * only repeat the refusal: a client error other than an expired sign-in, a
   * timeout or a rate limit, and the store-wide `budget_exceeded` bound.
   */
  get final(): boolean {
    return refusalIsFinal(this.status, this.code);
  }
}

function refusalIsFinal(status: number, code: string): boolean {
  return (
    code === "budget_exceeded" ||
    (status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429)
  );
}

/**
 * Fixed messages per error code; a server message is never shown verbatim.
 * Every closed code of the change lifecycle (`COMMAND_ERROR_CODES`) has its
 * own entry, so a refusal that retrying cannot change never reads as "try
 * again later" (test/command-api.test.ts).
 */
const MESSAGES: Record<string, string> = {
  incomplete_evidence:
    "選択した原本や口座の根拠が不足しています。原本と現在の対応を確認してください。",
  needs_scope_resolution:
    "口座や保有者の対応が未解決です。照合候補と口座の整理を確認してください。",
  unsupported_semantics:
    "この変更は、まだ対応していない内容を含むため受け付けられません。再試行しても結果は変わりません。",
  needs_rule_verification:
    "適用するルールの確認が済んでいないため受け付けられません。ルールを確認してから計画し直してください。",
  // Every command-path source is a store-wide instrument-resolution bound
  // (identity observations, fact rows, listed_as rows, candidate count;
  // instrument-candidate-context.ts), which no narrower plan avoids.
  budget_exceeded:
    "処理できる件数の上限を超えているため、この変更は受け付けられません。再試行しても結果は変わりません。",
  evidence_restricted: "この根拠を使う権限がないため、この操作は受け付けられません。",
  invalid_payload: "入力した識別名、理由、根拠を確認してください。",
  invalid_command:
    "送信した内容の形式を受け付けられませんでした。表示を更新して、内容を確認し直してください。",
  commands_disabled: "この接続先では確認操作が有効になっていません。",
  subject_not_granted: "このアカウントには確認操作の権限が付与されていません。",
  grants_misconfigured:
    "接続先の権限設定を読み取れないため、確認操作を受け付けていません。管理者に設定の確認を依頼してください。",
  approval_required: "承認は人による認証経路が必要です。この権限では実行できません。",
  stale_context: "対象が変更されました。再試算した新しい計画で確認し直してください。",
  idempotency_conflict: "同じ操作IDで別の内容は送れません。新しい操作IDで実行してください。",
  plan_not_found: "計画が見つかりません。一覧から選び直してください。",
  plan_expired: "計画の有効期限が切れています。再試算してください。",
  plan_not_open: "この計画はすでに確定または無効です。",
  approval_expired: "承認の有効期限が切れています。もう一度承認してください。",
  approval_exhausted: "この承認は使い切られています。もう一度承認してください。",
  approval_scope_mismatch: "承認の範囲がこの対象を含んでいません。",
  approval_not_found: "承認が見つかりません。もう一度承認してください。",
  receipt_not_found: "この操作の記録は見つかりません。",
  target_missing: "対象の記録が見つかりません。表示を更新して、対象を選び直してください。",
  target_ambiguous: "対象を一つに特定できません。表示を更新して、対象を選び直してください。",
  commit_failed: "変更は保存されませんでした。表示を更新して、対象と計画を確認し直してください。",
  command_executor_unavailable: "確定を実行する経路に接続できません。",
};

function messageFor(status: number, code: string): string {
  return (
    MESSAGES[code] ??
    (status === 401
      ? "認証が必要です。ログイン状態を確認して、再読み込みしてください。"
      : status === 403
        ? "この操作を行う権限がありません。"
        : refusalIsFinal(status, code)
          ? "操作を受け付けられませんでした。再試行しても結果は変わりません。表示を更新して、内容を確認し直してください。"
          : "操作を完了できませんでした。時間をおいて再試行してください。")
  );
}

export async function postCommand<T>(
  operation: "plan" | "simulate" | "approve" | "commit" | "operation",
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${COMMAND_PREFIX}/${operation}`, {
      method: "POST",
      signal,
      headers: { accept: "application/json", "content-type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      redirect: "manual",
      body: JSON.stringify(body),
    });
  } catch {
    if (signal.aborted) throw new DOMException("Request aborted", "AbortError");
    throw new CommandError(0, "unreachable", messageFor(0, "unreachable"));
  }
  let value: unknown = null;
  try {
    value = await response.json();
  } catch {
    value = null;
  }
  if (!response.ok) {
    const code =
      value !== null &&
      typeof value === "object" &&
      typeof (value as { error?: unknown }).error === "string"
        ? (value as { error: string }).error
        : "unknown";
    throw new CommandError(response.status, code, messageFor(response.status, code));
  }
  if (value === null || typeof value !== "object")
    throw new CommandError(
      response.status,
      "invalid_response",
      messageFor(response.status, "unknown"),
    );
  return value as T;
}
