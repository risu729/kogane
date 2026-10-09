// 残高の再構成: for one account and a range, the balance its provider
// reported at the start, the balance reconstructed by applying the adopted
// events to it, and the balance reported at the end, side by side with their
// difference and the fold's own explanation (docs/reconstructed-state.md).
// The page computes nothing: every figure, status and reason is the server's
// (`GET /api/v2/reconstructed-state`), shown as exact decimals with closed
// codes. A difference is shown as a difference, never as an adjustment and
// never as zero; a missing value is shown with its reason. Nothing here
// adopts, approves or writes anything.
import { useState, type ReactNode } from "react";
import { ApiError, useFeatures } from "../api.ts";
import { displayLabel } from "../labels.ts";
import { SettlementQuantity } from "../reconciliation-display.tsx";
import {
  useReconstructedState,
  type LegDispositionRecord,
  type ReconstructedCell,
  type ReconstructedStateQuery,
  type ReconstructedStateResult,
  type ReconstructionStart,
} from "../reconstructed-state-api.ts";
import { tokyoToday, useReportedState } from "../reported-state-api.ts";
import {
  Badge,
  EmptyState,
  Kv,
  KvRow,
  Loading,
  Notice,
  Nullable,
  Panel,
  QueryBoundary,
  Sha,
  type Tone,
} from "../ui.tsx";
import { useViewState } from "../view-state.tsx";

const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u;
const ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,127}$/u;
const EPOCH = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,63}$/u;
const SEQ = /^[1-9][0-9]{0,15}$/u;
const INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/u;
/** The route's bound (`RECONSTRUCTION_RANGE_MAX_DAYS`); the server checks it again. */
const MAX_DAYS = 366;

const STATUS: Record<ReconstructedStateResult["status"], { label: string; tone: Tone }> = {
  complete: { label: "完全", tone: "ok" },
  incomplete: { label: "一部のみ", tone: "warn" },
  needs_review: { label: "確認が必要", tone: "warn" },
  indeterminate: { label: "判定できない", tone: "warn" },
  unavailable: { label: "再構成の対象外", tone: "bad" },
};

/** Every reason code of the answer, in words; the code is shown beside it. */
export const RECONSTRUCTION_REASON_LABELS: Record<string, string> = {
  economic_guard_missing: "この保管庫には経済イベントの採用記録（CORE 0070）がありません",
  no_reported_container: "この口座の残高を報告する取得元がありません",
  log_empty: "採用のコミット記録がまだありません",
  cut_before_log_start: "指定した時点はコミット記録の開始より前です",
  knowledge_unlogged: "コミット記録に載っていない採用があります（記録開始前の採用など）",
  snapshot_boundary_unknown: "取得日当日の動きが、取得の前か後か分かりません",
  identity_changed: "採用の後で口座・銘柄の対応が変わりました",
  claim_conflict: "同じ取引を複数のイベントが参照しています",
  alias_conflict: "同じ取引の別の表現を複数のイベントが参照しています",
  revision_chain_inconsistent: "改訂の連なりとコミット記録が一致しません",
  writer_unsupported: "再構成が対応していない形の採用があります",
  revision_left_out: "再構成に渡せない改訂を除外しました",
  no_start_snapshot: "開始日の報告残高がありません",
  start_metric_not_stock: "開始日の値が時点の残高ではありません",
  start_sign_unknown: "開始日の値の符号の意味が分かりません",
  start_ambiguous_metrics: "開始日の残高が複数あり、1つに決められません",
  start_ambiguous_positions: "開始日の保有が複数あり、1つに決められません",
  start_value_not_exact: "開始日の値が正確な数値ではありません",
  instrument_not_identified: "銘柄が特定されていません",
  leg_value_not_exact: "金額が正確でない動きがあります",
  leg_sign_unknown: "増減の向きが分からない動きがあります",
  event_time_unknown: "計上日が記録されていない動きがあります",
  own_transfer_held: "自分の口座の間の振替を保留しています",
  leg_subject_unrecognized: "どの口座の動きか分からないものがあります",
  leg_effect_unknown: "残高への効果が宣言されていない動きがあります",
  family_not_evented: "この口座の取引のすべての種類がイベントになってはいません",
  history_coverage_unknown: "この期間の取引履歴がすべて取得されたか分かりません",
  history_gap: "取引履歴に欠けている期間があります",
  nothing_to_reconstruct: "再構成できる残高がありません",
  positions_not_folded: "保有数量は再構成していません（取得元の表示文字列しかないため）",
};
const EXPLANATION: Record<string, { label: string; tone: Tone }> = {
  reconciled: { label: "一致", tone: "ok" },
  consistent_with_boundary_exclusion: { label: "取得日当日の動きを除けば一致", tone: "ok" },
  consistent_with_boundary_inclusion: { label: "取得日当日の動きを含めれば一致", tone: "ok" },
  difference_unexplained: { label: "説明できない差", tone: "bad" },
  not_comparable: { label: "比較できない", tone: "warn" },
  unavailable: { label: "比較の対象外", tone: "warn" },
};
const EXPLANATION_REASONS: Record<string, string> = {
  reported_end_missing: "終了日の報告値がありません",
  reported_end_not_exact: "終了日の報告値が正確な数値ではありません",
  reconstruction_incomplete: "再構成が完全ではありません",
  snapshot_basis_unknown: "報告値がどの基準の残高か分かりません",
  same_capture_as_start: "終了日の報告値は開始日と同じ取得です",
  no_reported_container: "この口座の残高を報告する取得元がありません",
};
const DISPOSITIONS: Record<string, string> = {
  applied: "適用",
  pending_shown_apart: "未確定（別に表示）",
  outside_range: "期間外",
  superseded_at_knowledge_time: "その時点で改訂済み",
  recorded_after_knowledge_time: "その時点より後に記録",
  state_no_effect: "残高に影響しない状態",
  other_basis: "現金以外の基準",
  other_account: "別の口座",
  boundary_same_day: "取得日当日（前後不明）",
  breakdown_attribution: "内訳",
  correspondence_link: "対応する動き",
  unknown_effect: "効果が分からない",
  knowledge_unlogged: "コミット記録外",
  identity_changed: "対応が変化",
  alias_conflict: "別表現の重複",
  claim_conflict: "参照の重複",
  writer_unsupported: "未対応の形",
};
const LATE_UNAVAILABLE: Record<string, string> = {
  no_end_capture: "終了日の取得がないため、遅れて記録された分を分けられません",
  end_captures_differ: "終了日の残高が別々の取得に由来するため、遅れて記録された分を分けられません",
  baseline_after_cut: "終了日の取得が指定した時点より後のため、遅れて記録された分を分けられません",
};
const COVERAGE: Record<string, string> = {
  logged: "すべてコミット記録に載っています",
  partial: "一部がコミット記録に載っていません",
  indeterminate: "コミット記録から判定できません",
};
/** The route's closed refusal codes, each with a fixed message. */
export const RECONSTRUCTION_REFUSAL_MESSAGES: Record<string, string> = {
  invalid_query: "条件の形式が正しくありません。",
  scope_unsupported: "口座は1つだけ指定できます。銘柄ごとの再構成には対応していません。",
  invalid_account: "口座 ID の形式が正しくありません。",
  invalid_date: "日付を 2026-03-31 のように指定してください。",
  invalid_range: "開始日は終了日より前にしてください。",
  range_too_long: "期間は366日以内にしてください。",
  range_in_future: "終了日は今日（日本時間）以前にしてください。",
  basis_unsupported: "現金の基準だけに対応しています。",
  invalid_cut: "知識の時点（コミット番号または時刻）の形式が正しくありません。",
  cut_in_future: "知識の時点は現在より前にしてください。",
  cut_after_log_end: "指定したコミット番号はまだ記録されていません。",
  cut_epoch_not_current:
    "指定したコミット記録の世代は現在のものではありません。最新の時点で表示し直してください。",
  set_version_changed: "固定した採用知識の版が変わりました。最新の時点で表示し直してください。",
  unknown_account: "この口座 ID は登録されていません。",
  scope_restricted: "この権限の範囲では表示できません。",
  capability_missing: "この権限では表示できません。",
  result_limit_exceeded:
    "この口座の記録は多すぎて、一度に再構成できません。一部だけの再構成はしません。",
};

const reason = (code: string): string => displayLabel(RECONSTRUCTION_REASON_LABELS, code);

function ReasonList({ codes, label }: { codes: readonly string[]; label: string }): ReactNode {
  return (
    <ul className="warning-list" aria-label={label}>
      {codes.map((code) => (
        <li key={code}>
          {reason(code)} <code className="dim">{code}</code>
        </li>
      ))}
    </ul>
  );
}

/**
 * A reported figure as the fold compares it: oriented asset-positive. A
 * liability-positive figure was negated for that, so the provider's own
 * figure is shown beside it with the note that its sign was inverted.
 */
function Reported({ value }: { value: ReconstructionStart | null }): ReactNode {
  if (value === null) return <Nullable value={null} placeholder="報告値なし" />;
  return (
    <>
      <SettlementQuantity value={value.oriented} />
      {value.signMeaning === "liability-positive" ? (
        <span className="dim reconstructed-captured">
          取得元の表示 <SettlementQuantity value={value.reported} />
          （負債として報告された値の符号を反転）
        </span>
      ) : null}
      <span className="dim reconstructed-captured">
        取得 <time dateTime={value.capturedAt}>{value.capturedAt}</time>
      </span>
    </>
  );
}

function Difference({ cell }: { cell: ReconstructedCell }): ReactNode {
  const { explanation } = cell;
  const status = EXPLANATION[explanation.status] ?? {
    label: explanation.status,
    tone: "warn" as Tone,
  };
  return (
    <>
      {explanation.remainder.value.status === "exact" ? (
        <SettlementQuantity value={explanation.remainder} />
      ) : (
        <Nullable
          value={null}
          placeholder={`算出できない（${explanation.remainder.value.reasonCode}）`}
        />
      )}
      <div>
        <Badge tone={status.tone}>{status.label}</Badge>
        {explanation.reasonCode === null ? null : (
          <span className="dim">
            {" "}
            {displayLabel(EXPLANATION_REASONS, explanation.reasonCode)}{" "}
            <code>{explanation.reasonCode}</code>
          </span>
        )}
      </div>
    </>
  );
}

function Components({ cell }: { cell: ReconstructedCell }): ReactNode {
  const { explanation } = cell;
  return (
    <ul className="plain-list">
      <li>
        適用 {cell.applied.count} 件
        {cell.applied.count === 0 ? null : (
          <>
            {" "}
            <SettlementQuantity value={cell.applied.total} />
          </>
        )}
      </li>
      {cell.pending.count === 0 ? null : (
        <li>
          未確定（別に表示） {cell.pending.count} 件{" "}
          <SettlementQuantity value={explanation.pendingShownApart.total} />
        </li>
      )}
      {cell.boundary.count === 0 ? null : (
        <li>
          取得日当日（前後不明） {cell.boundary.count} 件{" "}
          <SettlementQuantity value={explanation.sameDayBoundary.total} />
        </li>
      )}
      {explanation.lateRecorded === null ? null : (
        <li>
          終了日の取得より後に記録 {explanation.lateRecorded.refs.length} 件{" "}
          <SettlementQuantity value={explanation.lateRecorded.total} />
        </li>
      )}
      {cell.unknown.count === 0 ? null : <li>扱いの決まらない動き {cell.unknown.count} 件</li>}
    </ul>
  );
}

function CellTable({ cells }: { cells: ReconstructedCell[] }): ReactNode {
  return (
    <div className="table-scroll" role="region" aria-label="残高ごとの比較" tabIndex={0}>
      <table className="reconstructed-state-table">
        <caption>
          差は「終了日の報告値 −
          再構成値」で、どちらも資産を正とした向きです。差を調整として記録したり、0
          として扱ったりはしません。
        </caption>
        <thead>
          <tr>
            <th scope="col">単位</th>
            <th scope="col" className="num">
              開始日の報告値
            </th>
            <th scope="col" className="num">
              再構成値
            </th>
            <th scope="col" className="num">
              終了日の報告値
            </th>
            <th scope="col" className="num">
              差（報告 − 再構成）
            </th>
            <th scope="col">内訳</th>
          </tr>
        </thead>
        <tbody>
          {cells.map((cell) => (
            <tr key={`${cell.measure}/${cell.unitRef ?? cell.unidentifiedRef ?? ""}`}>
              <th scope="row">
                {cell.unitRef ?? <Nullable value={null} placeholder="銘柄未特定" />}
                <div className="dim">{cell.measure === "position" ? "数量" : "残高"}</div>
              </th>
              <td className="num">
                <Reported value={cell.start} />
              </td>
              <td className="num">
                {cell.reconstructed.value.status === "exact" ? (
                  <SettlementQuantity value={cell.reconstructed} />
                ) : (
                  <Nullable
                    value={null}
                    placeholder={`算出できない（${cell.reconstructed.value.reasonCode}）`}
                  />
                )}
              </td>
              <td className="num">
                <Reported value={cell.explanation.reported} />
              </td>
              <td className="num">
                <Difference cell={cell} />
              </td>
              <td>
                <Components cell={cell} />
                {cell.gaps.length === 0 ? null : (
                  <ReasonList codes={cell.gaps} label="この残高の不足" />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DispositionTable({ rows }: { rows: LegDispositionRecord[] }): ReactNode {
  return (
    <div className="table-scroll" role="region" aria-label="イベントの扱いの一覧" tabIndex={0}>
      <table className="reconstructed-state-table">
        <thead>
          <tr>
            <th scope="col">イベント</th>
            <th scope="col">単位</th>
            <th scope="col">扱い</th>
            <th scope="col">理由</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.ref}>
              <td>
                <code>{row.ref}</code>
              </td>
              <td>
                <Nullable value={row.unitRef} />
              </td>
              <td>
                {displayLabel(DISPOSITIONS, row.disposition)}{" "}
                <code className="dim">{row.disposition}</code>
              </td>
              <td>
                {row.gap === null ? (
                  <Nullable value={null} placeholder="—" />
                ) : (
                  <>
                    {reason(row.gap)} <code className="dim">{row.gap}</code>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function KnowledgePanel({
  answer,
  onPin,
}: {
  answer: ReconstructedStateResult;
  onPin: (coreEpoch: string, commitSeq: number) => void;
}): ReactNode {
  const { cut, knowledge, manifest } = answer;
  if (cut === null || knowledge === null || manifest === null) return null;
  const requested =
    "commitSeq" in cut.requested
      ? `コミット ${cut.requested.commitSeq}`
      : `時刻 ${cut.requested.instant}`;
  return (
    <Panel
      id="reconstructed-knowledge"
      title="使用した採用知識"
      note="この答えは、下のコミット記録の時点までに採用された内容だけから計算しています。"
    >
      <div className="panel-body">
        <Kv>
          <KvRow label="指定した時点">
            {requested} <span className="dim">（世代 {cut.requested.coreEpoch}）</span>
          </KvRow>
          <KvRow label="使用したコミット">
            {cut.resolved.commitSeq === 0 ? "最初のコミットより前" : `${cut.resolved.commitSeq} 番`}
            <span className="dim"> · 世代 {cut.resolved.coreEpoch}</span>
            {cut.knownAt === null ? null : (
              <span className="dim">
                {" "}
                · 記録時刻 <time dateTime={cut.knownAt}>{cut.knownAt}</time>
              </span>
            )}
          </KvRow>
          <KvRow label="時点の確定">
            {answer.cutStanding === "provisional" ? (
              <>
                <Badge tone="warn">暫定</Badge>{" "}
                この時刻は最新の記録以降です。後から記録が追加されると、同じ時刻が別のコミットを指すことがあります。
              </>
            ) : (
              <Badge tone="ok">確定</Badge>
            )}
          </KvRow>
          <KvRow label="採用知識の版">
            <Sha value={knowledge.setVersion} />
          </KvRow>
          <KvRow label="口座対応の世代">{manifest.identity.epoch}</KvRow>
          <KvRow label="コミット記録">
            {displayLabel(COVERAGE, knowledge.coverage.status)}{" "}
            <code className="dim">{knowledge.coverage.status}</code>
            {knowledge.coverage.logStart === null ? null : (
              <span className="dim">
                {" "}
                · 記録開始{" "}
                <time dateTime={knowledge.coverage.logStart.knownAt}>
                  {knowledge.coverage.logStart.knownAt}
                </time>
              </span>
            )}
          </KvRow>
          <KvRow label="対象の改訂">{knowledge.revisions} 件</KvRow>
          <KvRow label="照会 ID">
            {answer.contextId === null ? (
              <Nullable value={null} />
            ) : (
              <Sha value={answer.contextId} />
            )}
          </KvRow>
        </Kv>
        {cut.resolved.commitSeq === 0 ? null : (
          <button
            className="button"
            type="button"
            onClick={() => onPin(cut.resolved.coreEpoch, cut.resolved.commitSeq)}
          >
            このコミットに固定して表示する
          </button>
        )}
        <Diagnostics answer={answer} />
      </div>
    </Panel>
  );
}

function Diagnostics({ answer }: { answer: ReconstructedStateResult }): ReactNode {
  const knowledge = answer.knowledge!;
  const lines: ReactNode[] = [];
  for (const entry of knowledge.unlogged)
    lines.push(
      <li key={`u/${entry.eventId}@${entry.revision}`}>
        コミット記録外: <code>{`${entry.eventId}@${entry.revision}`}</code>{" "}
        <code className="dim">{entry.reasonCode}</code>
      </li>,
    );
  for (const entry of knowledge.inconsistent)
    lines.push(
      <li key={`i/${entry.eventId}/${entry.reasonCode}`}>
        改訂の不一致: <code>{entry.eventId}</code> <code className="dim">{entry.reasonCode}</code>
      </li>,
    );
  for (const entry of knowledge.identityChanged)
    lines.push(
      <li key={`c/${entry.eventId}@${entry.revision}`}>
        対応の変化: <code>{`${entry.eventId}@${entry.revision}`}</code>{" "}
        <code className="dim">{entry.reasons.join(", ")}</code>
      </li>,
    );
  for (const entry of knowledge.conflicts)
    lines.push(
      <li key={`k/${entry.dimension}/${entry.ref}`}>
        参照の重複（{entry.dimension === "key" ? "同じ取引" : "別表現"}）:{" "}
        {entry.holders.map((holder) => (
          <code key={holder}>{holder} </code>
        ))}
      </li>,
    );
  for (const entry of knowledge.unsupported)
    lines.push(
      <li key={`s/${entry.eventId}@${entry.revision}/${entry.reasonCode}`}>
        未対応の形: <code>{`${entry.eventId}@${entry.revision}`}</code>{" "}
        <code className="dim">{entry.reasonCode}</code>
      </li>,
    );
  for (const note of knowledge.adapterNotes)
    lines.push(
      <li key={`n/${note.ref}/${note.code}`}>
        再構成に渡せなかったもの: <code>{note.ref}</code> <code className="dim">{note.code}</code>
      </li>,
    );
  if (lines.length === 0) return null;
  return (
    <details className="inline-disclosure" open>
      <summary>採用知識の注意（{lines.length} 件）</summary>
      <ul className="warning-list" aria-label="採用知識の注意">
        {lines}
      </ul>
    </details>
  );
}

function Answer({
  answer,
  onPin,
}: {
  answer: ReconstructedStateResult;
  onPin: (coreEpoch: string, commitSeq: number) => void;
}): ReactNode {
  const status = STATUS[answer.status];
  const cells = answer.reconstruction?.cells ?? [];
  return (
    <>
      <Panel
        id="reconstructed-summary"
        title={`${answer.range.from} → ${answer.range.to} の再構成`}
        count={<Badge tone={status.tone}>{status.label}</Badge>}
      >
        <div className="panel-body">
          <Kv>
            <KvRow label="口座">
              <code>{answer.account}</code>
            </KvRow>
            <KvRow label="基準">現金（入出金の計上日）</KvRow>
            <KvRow label="判定">
              {status.label} <code className="dim">{answer.status}</code>
            </KvRow>
          </Kv>
          {answer.reasons.length === 0 ? null : (
            <ReasonList codes={answer.reasons} label="判定の理由" />
          )}
        </div>
      </Panel>
      {answer.reconstruction === null ? (
        <Notice tone="bad" role="note">
          <p>
            <strong>再構成できません。</strong>
            {reason("economic_guard_missing")}。報告値は「基準日の保有状況」で確認できます。
          </p>
        </Notice>
      ) : (
        <>
          <KnowledgePanel answer={answer} onPin={onPin} />
          <Panel
            id="reconstructed-cells"
            title="報告値と再構成値"
            count={`${cells.length}件`}
            note="通貨・単位ごとに並べています。口座や通貨をまたいで合算・換算はしません。"
          >
            {cells.length === 0 ? (
              <div className="panel-body">
                <p>
                  {reason("nothing_to_reconstruct")}。0
                  という意味ではありません。理由は上の判定を見てください。
                </p>
              </div>
            ) : (
              <CellTable cells={cells} />
            )}
          </Panel>
          {answer.reported !== null && answer.reported.positionsNotFolded > 0 ? (
            <Notice tone="warn" role="note">
              報告された保有銘柄 {answer.reported.positionsNotFolded} 件は、
              {reason("positions_not_folded")}。
            </Notice>
          ) : null}
          <Panel id="reconstructed-late" title="遅れて記録された採用">
            <div className="panel-body">
              {answer.late !== null ? (
                <p>
                  終了日の取得の時点（
                  {answer.late.baselineCut.commitSeq === 0
                    ? "最初のコミットより前"
                    : `コミット ${answer.late.baselineCut.commitSeq}`}
                  ）より後に採用されたもの: {answer.late.entered.length} 件、取り消されたもの:{" "}
                  {answer.late.left.length} 件
                </p>
              ) : (
                <p>
                  {displayLabel(LATE_UNAVAILABLE, answer.lateUnavailable ?? "")}{" "}
                  <code className="dim">{answer.lateUnavailable}</code>
                </p>
              )}
            </div>
          </Panel>
          {answer.reconstruction.dispositions.length === 0 ? null : (
            <Panel
              id="reconstructed-dispositions"
              title="イベントの扱い"
              count={`${answer.reconstruction.dispositions.length}件`}
            >
              <DispositionTable rows={answer.reconstruction.dispositions} />
            </Panel>
          )}
        </>
      )}
    </>
  );
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** A form problem, in words, or null when the request may be sent. */
function formProblem(draft: ReconstructedStateQuery, today: string): string | null {
  if (!ACCOUNT.test(draft.account)) return "口座 ID を選ぶか入力してください。";
  if (!DATE.test(draft.from) || !DATE.test(draft.to))
    return "日付を 2026-03-31 のように指定してください。";
  if (draft.from >= draft.to) return "開始日は終了日より前にしてください。";
  if (draft.to > today) return "終了日は今日（日本時間）以前にしてください。";
  if (daysBetween(draft.from, draft.to) > MAX_DAYS) return "期間は366日以内にしてください。";
  if (draft.cut.kind !== "latest" && !EPOCH.test(draft.cut.coreEpoch))
    return "コミット記録の世代を入力してください。";
  if (draft.cut.kind === "sequence" && !SEQ.test(draft.cut.commitSeq))
    return "コミット番号は1以上の整数で入力してください。";
  if (draft.cut.kind === "instant" && !INSTANT.test(draft.cut.instant))
    return "時刻を 2026-04-01T00:00:00Z のように UTC で入力してください。";
  return null;
}

function monthBefore(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - 30 * 86_400_000).toISOString().slice(0, 10);
}

export function ReconstructedStatePage(): ReactNode {
  const features = useFeatures();
  const today = tokyoToday();
  const [chosen, setChosen] = useViewState("reconstructedState.query");
  const [draft, setDraft] = useState<ReconstructedStateQuery>(
    () => chosen ?? { account: "", from: monthBefore(today), to: today, cut: { kind: "latest" } },
  );
  const [epochDraft, setEpochDraft] = useState(
    draft.cut.kind === "latest" ? "" : draft.cut.coreEpoch,
  );
  const [seqDraft, setSeqDraft] = useState(
    draft.cut.kind === "sequence" ? draft.cut.commitSeq : "",
  );
  const [instantDraft, setInstantDraft] = useState(
    draft.cut.kind === "instant" ? draft.cut.instant : "",
  );
  const [mode, setMode] = useState<ReconstructedStateQuery["cut"]["kind"]>(draft.cut.kind);
  const query = useReconstructedState(chosen);
  // The accounts the provider reported on the end date, to choose from; the
  // field also takes any account id.
  const reported = useReportedState(DATE.test(draft.to) ? draft.to : today);
  const accounts = [
    ...new Set(
      (reported.data?.accounts ?? []).flatMap((account) =>
        account.accountId === null ? [] : [account.accountId],
      ),
    ),
  ].sort();
  const request: ReconstructedStateQuery = {
    ...draft,
    cut:
      mode === "latest"
        ? { kind: "latest" }
        : mode === "sequence"
          ? { kind: "sequence", coreEpoch: epochDraft, commitSeq: seqDraft }
          : { kind: "instant", coreEpoch: epochDraft, instant: instantDraft },
  };
  const problem = formProblem(request, today);
  const refusal =
    query.error instanceof ApiError &&
    query.error.code !== null &&
    Object.hasOwn(RECONSTRUCTION_REFUSAL_MESSAGES, query.error.code)
      ? query.error.code
      : null;
  const pin = (coreEpoch: string, commitSeq: number): void => {
    const pinned: ReconstructedStateQuery = {
      ...chosen!,
      cut: { kind: "sequence", coreEpoch, commitSeq: String(commitSeq) },
    };
    setMode("sequence");
    setEpochDraft(coreEpoch);
    setSeqDraft(String(commitSeq));
    setDraft(pinned);
    setChosen(pinned);
  };
  if (!features.known) return <Loading label="残高の再構成" />;
  return (
    <>
      <div className="page-head">
        <h1>残高の再構成</h1>
        <p className="lede">
          開始日に取得元が報告した残高へ、採用済みのイベントを適用して終了日の残高を再構成し、終了日に報告された残高と並べます。
        </p>
        <p className="footnote">
          表示するだけの画面です。差を調整として記録したり、採用の状態を変えたりはしません。値のないものは
          0 とせず、理由とともに示します。
        </p>
      </div>
      {!features.reconstructedStateOnDate ? (
        <EmptyState>この接続先は残高の再構成を提供していません。</EmptyState>
      ) : (
        <>
          <Panel id="reconstructed-query" title="口座と期間を選ぶ">
            <form
              className="filter-grid"
              onSubmit={(event) => {
                event.preventDefault();
                if (problem !== null) return;
                setDraft(request);
                setChosen(request);
              }}
            >
              <label className="filter-field">
                口座 ID
                <input
                  type="text"
                  name="reconstructed-account"
                  list="reconstructed-accounts"
                  value={draft.account}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setDraft({ ...draft, account: event.target.value.trim() })}
                />
                <datalist id="reconstructed-accounts">
                  {accounts.map((account) => (
                    <option key={account} value={account} />
                  ))}
                </datalist>
              </label>
              <label className="filter-field">
                開始日
                <input
                  type="date"
                  name="reconstructed-from"
                  value={draft.from}
                  max={today}
                  onChange={(event) => setDraft({ ...draft, from: event.target.value })}
                />
              </label>
              <label className="filter-field">
                終了日
                <input
                  type="date"
                  name="reconstructed-to"
                  value={draft.to}
                  max={today}
                  onChange={(event) => setDraft({ ...draft, to: event.target.value })}
                />
              </label>
              <label className="filter-field">
                知識の時点
                <select
                  name="reconstructed-cut"
                  value={mode}
                  onChange={(event) =>
                    setMode(event.target.value as ReconstructedStateQuery["cut"]["kind"])
                  }
                >
                  <option value="latest">最新のコミット</option>
                  <option value="sequence">コミット番号で指定</option>
                  <option value="instant">時刻で指定</option>
                </select>
              </label>
              {mode === "latest" ? null : (
                <label className="filter-field">
                  コミット記録の世代
                  <input
                    type="text"
                    name="reconstructed-epoch"
                    value={epochDraft}
                    spellCheck={false}
                    onChange={(event) => setEpochDraft(event.target.value.trim())}
                  />
                </label>
              )}
              {mode === "sequence" ? (
                <label className="filter-field">
                  コミット番号
                  <input
                    type="text"
                    inputMode="numeric"
                    name="reconstructed-seq"
                    value={seqDraft}
                    onChange={(event) => setSeqDraft(event.target.value.trim())}
                  />
                </label>
              ) : null}
              {mode === "instant" ? (
                <label className="filter-field">
                  時刻（UTC）
                  <input
                    type="text"
                    name="reconstructed-instant"
                    placeholder="2026-04-01T00:00:00Z"
                    value={instantDraft}
                    spellCheck={false}
                    onChange={(event) => setInstantDraft(event.target.value.trim())}
                  />
                </label>
              ) : null}
              <button className="button" type="submit" disabled={problem !== null}>
                表示する
              </button>
              {problem !== null && draft.account !== "" ? <p role="alert">{problem}</p> : null}
            </form>
          </Panel>
          {chosen === null ? (
            <EmptyState>
              <p>口座と期間を選ぶと、報告値と再構成値を並べて表示します。</p>
            </EmptyState>
          ) : refusal !== null ? (
            <Notice tone="warn" role="alert">
              <p>
                <strong>この条件には答えられません。</strong>
                {RECONSTRUCTION_REFUSAL_MESSAGES[refusal]} <code className="dim">{refusal}</code>
              </p>
            </Notice>
          ) : (
            <QueryBoundary query={query} label="残高の再構成">
              {(answer) => <Answer answer={answer} onPin={pin} />}
            </QueryBoundary>
          )}
        </>
      )}
    </>
  );
}
