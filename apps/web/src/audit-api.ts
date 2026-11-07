// The client half of the operator's 監査ログ page (ADR 0064, "Reading";
// docs/audit-log.md). The read is the server's `GET /api/v2/audit`: the
// whole store, newest first, 50 records a page, filtered by closed values
// only, with an opaque cursor bound to the filters it was issued under and no
// total. This module turns the page URL into those filters, refusing anything
// outside the closed lists rather than sending a guess, and names every
// closed code in Japanese. Nothing here writes, and reading the log is not
// itself recorded.
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { getJson } from "./api.ts";
import {
  AUDIT_FILTER_KEYS,
  AUDIT_PAGE_PATH,
  AUDIT_PATH_VALUES,
  AUDIT_PRINCIPAL_KIND_VALUES,
  AUDIT_RESULT_VALUES,
  validAuditDay,
  type AuditFilterKey,
  type AuditPageWire,
} from "../../../packages/observation-shared/src/audit-contract.ts";

export type {
  AuditDiffView,
  AuditFilterKey,
  AuditPageWire,
  AuditRecordWire,
} from "../../../packages/observation-shared/src/audit-contract.ts";

/** The page's own URL. Filters are query parameters, so a filtered view deep-links. */
export const AUDIT_ROUTE = "/audit";

export const AUDIT_PATH_LABELS: Readonly<Record<string, string>> = {
  ui: "管理画面",
  "agent-http": "エージェントAPI",
  mcp: "MCP",
  alarm: "定期実行",
  lane: "処理レーン",
};

export const AUDIT_PRINCIPAL_KIND_LABELS: Readonly<Record<string, string>> = {
  human: "管理者",
  agent: "エージェント",
  delegated: "委任されたエージェント",
  automatic: "自動処理",
};

export const AUDIT_RESULT_LABELS: Readonly<Record<string, string>> = {
  applied: "適用",
  accepted: "受付",
  prepared: "確認待ちとして準備",
  read: "読み取り",
  replayed: "同じ依頼の再送",
  refused: "拒否",
  failed: "失敗",
  overflow: "上限を超えた分の集計",
};

export const AUDIT_STEP_LABELS: Readonly<Record<string, string>> = {
  call: "1回で実行",
  prepare: "準備",
  confirm: "確認",
};

export const AUDIT_SCOPE_LABELS: Readonly<Record<string, string>> = {
  "core-source": "取得元",
  "schedule-source": "スケジュール",
};

/**
 * Every operation of `OPERATION_CATALOGUE`
 * (`packages/application/src/operation-path/catalogue.ts`), by name. The
 * operation filter offers exactly these; a stored name missing here is still
 * shown as its code. `apps/web/test/audit-contract.test.ts` asserts the keys
 * are the catalogue's.
 */
export const AUDIT_OPERATION_LABELS: Readonly<Record<string, string>> = {
  "command.plan": "変更の計画",
  "command.simulate": "変更の影響の確認",
  "command.approve": "変更の承認",
  "command.commit": "変更の確定",
  "command.operation.get": "変更操作の状態の確認",
  "ops.collection.request": "収集の依頼",
  "ops.import.request": "取り込みの依頼",
  "ops.replay.request": "再処理の依頼",
  "ops.projection.request": "集計の再構築の依頼",
  "ops.session.refresh": "セッション更新の依頼",
  "ops.operation.get": "依頼の状態の確認",
  "schedules.job.update": "収集スケジュールの変更",
  "schedules.maintenance.update": "定例停止時間の変更",
  "schedules.survey.decide": "定例停止の再調査の提案への判断",
  "schedules.lease.release": "停止した実行の解除",
  capabilities: "利用できる機能の確認",
  "context.open": "照会条件の作成",
  "financial.query": "記録の照会",
  explain: "根拠の説明",
  "instruments.candidates": "銘柄の同一性の候補の照会",
  "reconstructed-state.read": "残高の再構成の照会",
  "reported-state.read": "指定日の保有状況の照会",
  "purchases.explain": "カード利用の説明",
  "schedules.maintenance.read": "定例停止時間の照会",
  "schedules.survey.read": "定例停止の再調査の提案の照会",
  "instruments.history": "銘柄の対応付けの履歴の照会",
  "instruments.coverage": "銘柄の整理状況の照会",
  "accounts.candidates": "口座の対応候補の照会",
  "card-settlements.unmatched": "照合候補のないカード請求の照会",
  "economic-readiness.read": "経済行の準備状況の照会",
  "card-settlements.read": "カード照合の照会",
  "card-settlements.statements": "カード照合の請求ごとの照会",
  "card-settlements.ownership": "カード照合の保有者確認の照会",
  "identity.read": "口座・銘柄の整理の照会",
  "audit.search": "監査ログの検索",
  "audit.get": "監査記録の取得",
  "reconcile.propose": "照合の提案",
  "mcp.request": "MCPのリクエスト（操作の特定前）",
  "audit.overflow": "上限を超えた記録の日次集計",
  "alarm.occurrence.claim": "定期収集の実行の受付",
  "alarm.lease.expire": "停止した実行の自動解除",
  "lane.tick": "処理レーンの1回の実行",
};

/** The proposal kinds a lane record counts (`LANE_PROPOSAL_KINDS`). */
export const AUDIT_LANE_PROPOSAL_KIND_LABELS: Readonly<Record<string, string>> = {
  "reconciliation-provider-same": "照合の提案（取得元が示す同一の取引）",
  "reconciliation-pending-to-posted": "照合の提案（未確定の明細と確定の明細）",
  "reconciliation-supersedes": "照合の提案（置き換え）",
  "reconciliation-supports": "照合の提案（裏付け）",
  "reconciliation-contradicts": "照合の提案（食い違い）",
  "reconciliation-funded-by": "照合の提案（資金の出どころ）",
  "reconciliation-statement-covers": "照合の提案（明細書が含む取引）",
  "card-settlement-candidate": "カード請求と銀行引落の照合候補",
  "maintenance-survey-new": "定例停止の再調査の提案（新しい案内）",
  "maintenance-survey-changed": "定例停止の再調査の提案（案内の変更）",
  "maintenance-survey-absent": "定例停止の再調査の提案（案内の消失）",
};

export const AUDIT_REVISION_FIELD_LABELS: Readonly<Record<string, string>> = {
  enabled: "有効・無効",
  timezone: "タイムゾーン",
  pattern: "実行パターン",
  scope: "対象範囲",
  source: "出典",
  reference_url: "参照先",
  verified_at: "確認日時",
};

export const AUDIT_DECISION_COUNT_LABELS: Readonly<Record<string, string>> = {
  targets: "対象",
  attributedObservationsBefore: "帰属する記録（変更前）",
  attributedObservationsAfter: "帰属する記録（変更後）",
  relationsBefore: "関係（変更前）",
  relationsAfter: "関係（変更後）",
  affectedScopes: "影響する範囲",
  affectedParseRuns: "影響する解析",
  invalidations: "無効化する集計",
  outboxTargets: "通知先",
};

export const AUDIT_REQUEST_STATUS_LABELS: Readonly<Record<string, string>> = {
  accepted: "受付済み",
  waiting_for_human: "人の操作待ち",
  running: "実行中",
  completed: "完了",
  failed: "失敗",
  blocked: "停止",
};

/** The closed values each select offers, in the server's own order. */
export const AUDIT_FILTER_CHOICES: Readonly<
  Record<Exclude<AuditFilterKey, "from" | "to">, readonly string[]>
> = {
  operation: Object.keys(AUDIT_OPERATION_LABELS),
  path: AUDIT_PATH_VALUES,
  principalKind: AUDIT_PRINCIPAL_KIND_VALUES,
  result: AUDIT_RESULT_VALUES,
};

export type AuditFilters = Partial<Record<AuditFilterKey, string>>;

/**
 * The filters of a page URL's query string, or null when it holds anything
 * the page may not send: an unknown or repeated key, a value outside its
 * closed list, a day that is not a calendar day, or a range that ends before
 * it starts. A cursor is never part of the URL: it belongs to one session of
 * paging and to the filters it was issued under.
 */
export function parseAuditFilters(search: string): AuditFilters | null {
  const params = new URLSearchParams(search);
  const filters: AuditFilters = {};
  for (const key of new Set(params.keys())) {
    if (!(AUDIT_FILTER_KEYS as readonly string[]).includes(key)) return null;
    const values = params.getAll(key);
    if (values.length !== 1) return null;
    const value = values[0]!;
    const filterKey = key as AuditFilterKey;
    if (filterKey === "from" || filterKey === "to") {
      if (!validAuditDay(value)) return null;
    } else if (!AUDIT_FILTER_CHOICES[filterKey].includes(value)) return null;
    filters[filterKey] = value;
  }
  if (filters.from !== undefined && filters.to !== undefined && filters.from > filters.to)
    return null;
  return filters;
}

/** The query string for filters, in one fixed key order so equal filters are equal text. */
export function auditFilterSearch(filters: AuditFilters): string {
  const params = new URLSearchParams();
  for (const key of AUDIT_FILTER_KEYS) {
    const value = filters[key];
    if (value !== undefined && value !== "") params.set(key, value);
  }
  return params.toString();
}

export function useAuditPage(
  filters: AuditFilters,
  cursor: string | null,
): UseQueryResult<AuditPageWire, Error> {
  const search = auditFilterSearch(filters);
  const params = new URLSearchParams(search);
  if (cursor !== null) params.set("cursor", cursor);
  const suffix = params.size ? `?${params}` : "";
  return useQuery({
    queryKey: ["audit", search, cursor],
    queryFn: ({ signal }) => getJson<AuditPageWire>(`${AUDIT_PAGE_PATH}${suffix}`, signal),
    retry: false,
  });
}
