// The AI delegation in force, as the server reads `MCP_DELEGATIONS` (ADR 0063,
// amendment of 2026-11-06). Read-only: nothing here grants, edits or revokes a
// delegation, and the browser derives no state of its own: the window state,
// the capabilities and the reference are the server's.
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError, getJson } from "./api.ts";
import {
  DELEGATION_STATUS_PATH,
  type DelegationScopeView,
  type DelegationStatus,
  type DelegationStatusEntry,
} from "../../../packages/observation-shared/src/delegation-status-contract.ts";
import { Badge } from "./ui.tsx";

const ROLE: Record<DelegationStatusEntry["role"], string> = {
  maintainer: "保守",
  reviewer: "確認",
  "operator-delegate": "操作代行",
};
const STATE: Record<
  DelegationStatusEntry["state"],
  { tone: "ok" | "warn" | "neutral"; label: string }
> = {
  in_force: { tone: "ok", label: "有効" },
  not_yet_valid: { tone: "warn", label: "開始前" },
  expired: { tone: "neutral", label: "期限切れ" },
};
const CAPABILITY: Record<DelegationStatusEntry["capabilities"][number], string> = {
  "commands.plan": "変更計画の作成",
  "commands.decide.card-settlement": "カード引落しの判断",
  "commands.decide.relation": "関連付けの判断",
  "commands.decide.identity": "同一性の判断",
  "schedules.maintenance.update": "メンテナンス時間の変更",
  "schedules.survey.decide": "再調査の提案への判断",
  "schedules.job.update": "実行時刻の変更",
  "operations.import.request": "取り込みの依頼",
  "operations.replay.request": "再処理の依頼",
  "operations.projection.request": "読み取りモデル再構築の依頼",
  "operations.collection.request": "収集の依頼",
  "operations.session.refresh": "セッション更新の依頼",
  "operations.read": "運用状態の読み取り",
};

const time = (value: string) =>
  new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
const scope = (value: DelegationScopeView, unit: string) =>
  value === "*" ? "すべて" : value.length === 0 ? "なし" : `${value.length}${unit}指定`;

function useDelegationStatus() {
  return useQuery({
    queryKey: ["delegations"],
    queryFn: ({ signal }) => getJson<DelegationStatus>(DELEGATION_STATUS_PATH, signal),
    retry: false,
  });
}

function Entry({ value }: { value: DelegationStatusEntry }): ReactNode {
  const state = STATE[value.state];
  return (
    <li className="delegation-entry">
      <div className="delegation-entry-head">
        <code>{value.principal}</code>
        <Badge tone={state.tone}>{state.label}</Badge>
        <span>役割 {ROLE[value.role]}</span>
      </div>
      <p className="delegation-entry-window">
        {time(value.issuedAt)} から {time(value.notAfter)} まで · 1日あたりの書き込み上限{" "}
        {value.writesPerDay} 件
      </p>
      <details>
        <summary>権限と範囲</summary>
        <ul className="delegation-capabilities">
          {value.capabilities.map((capability) => (
            <li key={capability}>{CAPABILITY[capability]}</li>
          ))}
        </ul>
        <p>
          取得元 {scope(value.scopes.sources, "件")} · 口座 {scope(value.scopes.accounts, "件")} ·
          スケジュール {scope(value.scopes.scheduleSources, "件")}
        </p>
        <p>
          委任の参照 <code>{value.delegationRef}</code>
        </p>
      </details>
    </li>
  );
}

/** A compact notice; the pages that can be acted on by a delegate show it. */
export function DelegationStatusNotice(): ReactNode {
  const query = useDelegationStatus();
  // A failed refetch keeps the previous answer in the cache; the state it
  // names was the server's at its `evaluatedAt`, not now, so a failed read is
  // never shown as a current state.
  const data = query.isError ? undefined : query.data;
  return (
    <section className="delegation-status" aria-labelledby="delegation-status-heading">
      <h2 id="delegation-status-heading">AIへの委任</h2>
      {query.isPending && query.fetchStatus !== "paused" ? (
        <p role="status">委任の状態を読み込んでいます…</p>
      ) : data === undefined ? (
        <p role="status">
          委任の状態を確認できません。
          {query.error instanceof ApiError && query.error.status === 403
            ? "管理者としてログインしているか確認してください。"
            : "時間をおいて再読み込みしてください。"}
        </p>
      ) : data.configuration === "misconfigured" ? (
        <p className="notice notice-bad" role="alert">
          委任の設定に誤りがあるため、AIへの委任はすべて無効です。AIによる操作は受け付けません。
        </p>
      ) : data.configuration === "none" ? (
        <p>委任はありません。AIは読み取りと提案のみ行い、承認・確定・設定の変更は行えません。</p>
      ) : (
        <>
          <p>
            ここに表示する委任の権限と範囲・期間の内でのみ、AIが操作を行えます。この画面からは委任を変更できません。
          </p>
          <p className="delegation-evaluated-at">{time(data.evaluatedAt)} 時点の状態です。</p>
          <ul className="delegation-entries">
            {data.delegations.map((entry) => (
              <Entry key={entry.principal} value={entry} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
