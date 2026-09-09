// The client half of the change lifecycle (A09). Everything shown on the
// confirmation screen is computed by the server: this module carries plan ids
// and receipts, never a recomputed difference and never a local decision about
// whether something may be approved.
//
// The buttons are enabled by the advertised `commands` capability only. That
// is a display decision: the server still authenticates, checks the grant, and
// refuses an agent's approval whatever the client sends.

export const COMMAND_PREFIX = "/api/command/v1";

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
}

/** Fixed messages per error code; a server message is never shown verbatim. */
const MESSAGES: Record<string, string> = {
  commands_disabled: "この接続先では確認操作が有効になっていません。",
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
  command_executor_unavailable: "確定を実行する経路に接続できません。",
};

function messageFor(status: number, code: string): string {
  return (
    MESSAGES[code] ??
    (status === 401
      ? "認証が必要です。ログイン状態を確認して、再読み込みしてください。"
      : status === 403
        ? "この操作を行う権限がありません。"
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
