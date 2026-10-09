import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { getJson } from "../api.ts";
import { Link, useLocation } from "../router.tsx";
import { EmptyState, Kv, KvRow, Panel, QueryBoundary } from "../ui.tsx";
import {
  COLLECTION_QUALITY_PATH,
  type CollectionQualityCell,
  type CollectionQualityCells,
  type CollectionQualitySchedule,
  type CollectionQualitySummary,
  type CellReason,
  type SourceReason,
} from "../../../../packages/observation-shared/src/collection-quality-contract.ts";

export const QUALITY_REASON_LABELS: Record<CellReason | SourceReason, string> = {
  no_collector: "収集方法が登録されていません",
  no_schedule: "実行予定がありません",
  schedule_disabled: "定期実行を停止しています",
  schedule_unsupported: "定期実行は未対応です",
  schedule_never_ran: "実行記録がありません",
  occurrence_running: "実行中・結果待ちです",
  occurrence_failed: "最終試行が失敗しました",
  occurrence_uncertain: "最終試行の結果を確認できません",
  user_action_required: "本人による認証・操作が必要です",
  lease_held: "実行中または実行の終了を確認できません",
  terminal_unrecorded: "取得結果がまだ届いていません",
  terminal_registration_pending: "取得結果の登録待ちです",
  terminal_registration_blocked: "取得結果の登録が拒否されました",
  acquisition_partial: "取得元の結果は一部のみです",
  acquisition_failed: "取得元で失敗しました",
  coverage_partial: "取得範囲は一部のみです",
  coverage_unknown: "取得範囲の完全性が不明です",
  unregistered_terminals: "未登録の取得結果があります",
  no_registered_run: "保存済みの取得記録がありません",
  latest_run_not_successful: "最新の取得は成功していません",
  dataset_withheld: "公開を保留しているデータがあります",
  unit_without_artifacts: "この口座・カードの原本ファイルがありません",
  unit_outcome_unknown: "この口座・カードの取得結果が不明です",
  identity_unresolved: "対応が未確定の口座があります",
  identity_not_recorded: "口座の対応付けがまだ記録されていません",
  published_without_observations:
    "公開された解析に観測行がありません（取引ゼロの証明ではありません）",
  retention_not_assessed: "取得元の保持上限による欠落は未判定です",
  run_not_successful: "この取得記録は成功していません",
  unit_failed: "この口座・カードの取得が不完全です",
  raw_not_reachable: "原本の保存記録に到達できません",
  parse_not_queued: "解析待ちに登録されていません",
  not_parse_eligible: "解析対象にできません",
  parse_pending: "解析待ち・解析中です",
  parse_failed: "解析が失敗しました",
  parser_rejected: "解析が拒否されました",
  parse_unpublished: "解析済みですが公開されていません",
  coverage_incomplete: "ページや対象範囲の完全性が確認できません",
  coverage_not_recorded: "解析の網羅性が記録されていません",
  newer_capture_not_current: "新しい取得を公開に採用できず、過去の取得を表示しています",
  no_current_capture: "現在の表示に採用された取得がありません",
  period_unplaced: "対象期間を確定できません",
  query_rule_not_composed: "現在の表示との対応が未確認です",
  not_in_latest_run: "より新しい実行に、このデータがありません",
};
const instant = (value: string | null): string => (value === null ? "記録なし・未確認" : value);
function Reasons({ codes }: { codes: readonly (CellReason | SourceReason)[] }): ReactNode {
  return (
    <ul className="warning-list">
      {codes.map((code) => (
        <li key={code}>
          {QUALITY_REASON_LABELS[code]} <code>{code}</code>
        </li>
      ))}
    </ul>
  );
}
function Schedule({ value }: { value: CollectionQualitySchedule }): ReactNode {
  return (
    <article className="panel-body">
      <h3>{value.id}</h3>
      <p>
        {value.supported
          ? value.enabled
            ? "定期実行が有効"
            : "定期実行を停止中"
          : "自動実行は未対応"}{" "}
        · {value.kind}
      </p>
      <Kv>
        <KvRow label="次回の予定時刻">{instant(value.nextNominalAt)}</KvRow>
        <KvRow label="メンテナンス考慮後の予定">{instant(value.nextRunAt)}</KvRow>
        <KvRow label="実際の Alarm 予約">
          {value.alarm.status === "unavailable"
            ? "予約状態を確認できません"
            : value.alarm.actualAt === null
              ? "予約なし（確認済み）"
              : value.alarm.actualAt}
        </KvRow>
        {value.alarm.status === "observed" &&
        ((value.enabled &&
          (value.alarm.actualAt === null || value.alarm.actualAt !== value.nextRunAt)) ||
          (!value.enabled && value.alarm.actualAt !== null)) ? (
          <KvRow label="予約の不一致">
            設定と実際の予約が一致していません。予約の反映待ち・停止状態を確認してください。
          </KvRow>
        ) : null}
        <KvRow label="最後の予定時刻">{instant(value.latest?.nominalAt ?? null)}</KvRow>
        <KvRow label="最後の試行開始">{instant(value.latest?.startedAt ?? null)}</KvRow>
        <KvRow label="試行の終了">{instant(value.latest?.finishedAt ?? null)}</KvRow>
        <KvRow label="試行の状態">
          {value.latest?.status ?? "実行記録なし"}{" "}
          {value.latest?.failureCode ? <code>{value.latest.failureCode}</code> : null}
        </KvRow>
        <KvRow label="実行の占有開始">{instant(value.leaseStartedAt)}</KvRow>
      </Kv>
      {value.latest?.terminals.map((terminal, index) => (
        <p key={index}>
          {terminal.collector}: 取得 {terminal.outcome ?? "不明"} / 範囲{" "}
          {terminal.coverage ?? "不明"} / 保存 {terminal.registration}
          {terminal.blockedCode ? (
            <>
              {" "}
              · <code>{terminal.blockedCode}</code>
            </>
          ) : null}
          {terminal.fetchRunId !== null ? (
            <>
              {" "}
              · <Link to={`/runs/r_${terminal.fetchRunId}`}>取得記録</Link>
            </>
          ) : null}
        </p>
      ))}
    </article>
  );
}
export function QualityCell({ value }: { value: CollectionQualityCell }): ReactNode {
  const n = value.newest;
  return (
    <Panel
      title={`${value.dataset ?? "データ種別不明"} / ${value.unitKey ?? "口座・カードの区分なし"}`}
    >
      <div className="panel-body">
        <p>
          期間:{" "}
          {value.period.kind === "latest" ? "期間の区分なし" : (value.period.value ?? "期間未確定")}{" "}
          {value.period.state ?? ""} · 解析: {value.parser ?? "解析の指定なし"}
        </p>
        <Kv>
          <KvRow label={n.artifacts === 0 ? "原本がない試行の時刻" : "最新の取得時刻"}>
            {n.capturedAt} · <Link to={`/runs/r_${n.fetchRunId}`}>取得記録</Link>
          </KvRow>
          <KvRow label="取得">
            {n.runSucceeded ? "実行成功" : "成功未確認"} /{" "}
            {n.unitFailed
              ? "口座・カードの取得不完全"
              : n.artifacts === 0
                ? "原本なし・完全性未確認"
                : "記録された原本を対象"}{" "}
            {n.unitFailureCode ? <code>{n.unitFailureCode}</code> : null}
          </KvRow>
          <KvRow label="原本の保存">
            {n.artifacts === 0
              ? "原本なし。空の履歴や完全取得を意味しません。"
              : `${n.rawStored} / ${n.artifacts} ファイルの保存記録あり（実ファイルの存在はダウンロード時に確認）`}
          </KvRow>
          <KvRow label="解析">
            公開 {n.parses.published} / 待機 {n.parses.pending} / 失敗 {n.parses.failed} / 未公開{" "}
            {n.parses.unpublished} / 未登録 {n.parses.notQueued} / 対象外 {n.parses.notEligible}
          </KvRow>
          <KvRow label="採用・公開">
            {value.state === "current"
              ? "最新の取得が現在の表示対象"
              : value.state === "older-current"
                ? "過去の取得が現在の表示対象"
                : "現在の表示対象なし"}{" "}
            · 保存された観測 {n.observations} 件
          </KvRow>
          <KvRow label="現在の表示の取得時刻">
            {instant(value.current?.capturedAt ?? null)}{" "}
            {value.current ? (
              <Link to={`/runs/r_${value.current.fetchRunId}`}>採用された取得記録</Link>
            ) : null}
          </KvRow>
          <KvRow label="口座の対応">
            未確定の観測 {n.unresolvedIdentities}{" "}
            件。取得単位のキーと整理済みの口座は同一とは限りません。
          </KvRow>
          <KvRow label="網羅性">
            不完全な解析の宣言 {n.incompleteCoverage}{" "}
            件。公開・採用だけでは全履歴の取得を証明できません。
          </KvRow>
        </Kv>
        <Reasons codes={value.reasons} />
        {[...n.failureCodes, ...n.coverageCauses].length > 0 ? (
          <p>
            解析・網羅性の理由:{" "}
            {[...new Set([...n.failureCodes, ...n.coverageCauses])].map((code) => (
              <code key={code}>{code} </code>
            ))}
          </p>
        ) : null}
      </div>
    </Panel>
  );
}
function SourceCells({ sourceId, offset }: { sourceId: string; offset: number }): ReactNode {
  const query = useQuery({
    queryKey: ["collection-quality", sourceId, offset],
    queryFn: ({ signal }) =>
      getJson<CollectionQualityCells>(
        `${COLLECTION_QUALITY_PATH}/${encodeURIComponent(sourceId)}?offset=${offset}`,
        signal,
      ),
  });
  return (
    <QueryBoundary query={query} label="取得・解析・公開の状態">
      {(data) => (
        <>
          <h2>口座・カード × データ種別 × 期間</h2>
          <p>
            このページは {offset + 1}{" "}
            件目からの保存記録です。対象外・未宣言の口座や期間は列挙できません。新しさは保存時刻を表示し、一律の「古い」判定は行いません。
          </p>
          {query.dataUpdatedAt ? (
            <p>表示を読んだ時刻: {new Date(query.dataUpdatedAt).toISOString()}</p>
          ) : null}
          {data.cells.length === 0 ? (
            <EmptyState>
              この範囲の取得・解析記録がありません。完全取得や取引ゼロとは判定できません。
            </EmptyState>
          ) : (
            data.cells.map((value) => (
              <QualityCell
                key={JSON.stringify([
                  value.dataset,
                  value.parser,
                  value.unitKey,
                  value.period,
                  value.currentRule,
                ])}
                value={value}
              />
            ))
          )}
          <nav aria-label="収集品質のページ">
            {offset > 0 ? (
              <Link
                to={`/collection-quality?source=${encodeURIComponent(sourceId)}&offset=${Math.max(0, offset - data.coverage.limit)}`}
              >
                前のページ
              </Link>
            ) : null}
            {data.coverage.nextOffset !== null ? (
              <Link
                to={`/collection-quality?source=${encodeURIComponent(sourceId)}&offset=${data.coverage.nextOffset}`}
              >
                次のページ（続きあり）
              </Link>
            ) : null}
          </nav>
          <p>
            {data.coverage.truncated
              ? "続きがあります。このページだけでは対象全体を検証できません。"
              : "このページが保存記録の末尾です。取得元の全範囲の網羅性は別の確認が必要です。"}
          </p>
        </>
      )}
    </QueryBoundary>
  );
}
export function CollectionQualityPage(): ReactNode {
  const params = new URLSearchParams(useLocation().split("?", 2)[1] ?? "");
  const sourceId = params.get("source");
  const offsetText = params.get("offset") ?? "0";
  const validOffset = /^(?:0|[1-9][0-9]{0,6})$/u.test(offsetText);
  const query = useQuery({
    queryKey: ["collection-quality", "summary"],
    queryFn: ({ signal }) => getJson<CollectionQualitySummary>(COLLECTION_QUALITY_PATH, signal),
  });
  return (
    <div className="wrap-any">
      <div className="page-head">
        <h1>収集品質</h1>
        <p className="lede">試行、取得、原本保存、解析、公開、新しさを取得元ごとに確認します。</p>
        <Link to="/schedules">収集スケジュール</Link> · <Link to="/evidence">取得履歴と原本</Link>
      </div>
      <p>
        空表示は完全取得や取引ゼロの証明ではありません。本人操作待ちや個別復旧は{" "}
        <a href="https://github.com/risu729/kogane/issues/440">収集の復旧記録</a>で追跡します。
      </p>
      <QueryBoundary query={query} label="収集方法と実行予定">
        {(data) => {
          const selected = data.sources.find((source) => source.sourceId === sourceId);
          return (
            <>
              <nav aria-label="取得元を選択">
                <ul>
                  {data.sources.map((source) => (
                    <li key={source.sourceId}>
                      <Link
                        to={`/collection-quality?source=${encodeURIComponent(source.sourceId)}`}
                        current={sourceId === source.sourceId}
                      >
                        {source.sourceId}
                      </Link>{" "}
                      ·{" "}
                      {source.reasons.length
                        ? `${source.reasons.length} 個の未完了・未確認理由`
                        : "実行の記録あり（網羅性は個別確認）"}
                    </li>
                  ))}
                </ul>
              </nav>
              {sourceId === null ? (
                <EmptyState>取得元を選ぶと、対象を限定して状態を読み込みます。</EmptyState>
              ) : selected === undefined ? (
                <EmptyState>
                  この取得元は一覧にありません。全範囲の取得成功とは判定できません。
                </EmptyState>
              ) : (
                <>
                  <h2>{selected.sourceId}</h2>
                  <p>登録された収集方法: {selected.collectors.join(" / ") || "なし"}</p>
                  <Reasons codes={selected.reasons} />
                  <Panel title="最後の試行と取得結果">
                    {selected.schedules.length ? (
                      selected.schedules.map((schedule) => (
                        <Schedule key={schedule.id} value={schedule} />
                      ))
                    ) : (
                      <p className="panel-body">実行予定の記録なし</p>
                    )}
                  </Panel>
                  {selected.unregistered.map((item) => (
                    <p key={`${item.collector}/${item.blockedCode}`}>
                      {item.collector}: 未登録 {item.runs} 件 · 最後の確認 {item.newestSeenAt} ·{" "}
                      {item.blockedCode ?? "登録待ち"}
                    </p>
                  ))}
                  {validOffset ? (
                    <SourceCells key={sourceId} sourceId={sourceId} offset={Number(offsetText)} />
                  ) : (
                    <EmptyState>
                      ページ指定が正しくありません。取得元を選び直してください。
                    </EmptyState>
                  )}
                </>
              )}
              {data.otherSchedules.length ? (
                <Panel title="取得元に属さない実行予定">
                  {data.otherSchedules.map((schedule) => (
                    <Schedule key={schedule.id} value={schedule} />
                  ))}
                </Panel>
              ) : null}
            </>
          );
        }}
      </QueryBoundary>
    </div>
  );
}
