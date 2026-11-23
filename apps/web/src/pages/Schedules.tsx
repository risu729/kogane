import { displayLabel } from "../labels.ts";
import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type {
  MaintenanceRule,
  SchedulePattern,
  ScheduleSnapshot,
  ScheduleView,
  ScheduleOccurrence,
} from "../../../../packages/collection/src/schedule-model";
import type {
  MaintenanceSurveyProposalView,
  MaintenanceSurveyView,
  ProposalReason,
  SurveyFailureCode,
} from "../../../../packages/collection/src/maintenance-survey-model";
import { ApiError } from "../api";
import {
  acceptedCollectionMessage,
  collectionRequestKey,
  CollectionRequestError,
  postCollectionRequest,
} from "../collection-request-api";
import { operationRoute } from "../operations-api.ts";
import { BusyButton } from "../busy-button.tsx";
import { Link } from "../router";
import { Notice, QueryBoundary } from "../ui.tsx";
import "../styles/schedules.css";
const PATH = "/api/ops/v1/schedules";
const DAYS = ["日", "月", "火", "水", "木", "金", "土"];
const NAMES: Record<string, string> = {
  "prestia-globalpass": "GLOBAL PASS",
  vpass: "Vpass",
  myjcb: "MyJCB",
  "sbi-securities": "SBI証券",
  "sbi-shinsei": "SBI新生銀行",
  "sony-bank": "ソニー銀行",
  "sbi-vc-trade": "SBI VCトレード",
  "mobile-suica": "モバイルSuica",
  "moneyforward-me": "マネーフォワード ME",
  vpoint: "Vポイント",
  "mizuho-bank": "みずほ銀行",
  "st-george": "St.George",
  "sbi-vc-keepalive": "SBI VC セッション維持",
  "processor-tick": "保存・解析処理",
  "smbc-direct": "SMBCダイレクト",
  "vpoint-pay": "VポイントPay",
};
// One label per status the occurrence table's CHECK allows (CORE 0085); a
// label for any other status is a type error.
const STATUS = {
  started: "実行中・結果待ち",
  completed: "完了",
  failed: "失敗",
  uncertain: "結果を確認できません",
  not_dispatched: "収集の呼び出し前に停止",
} satisfies Record<ScheduleOccurrence["status"], string>;
const REF = {
  confirmed: "停止時間を確認済み",
  "no-applicable-rule": "収集に該当する定例停止なし",
  "not-found": "定例停止時間が見つかりません",
};
const fmt = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat("ja-JP", {
        timeZone: "Asia/Tokyo",
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value))
    : "未設定";
const name = (id: string) => displayLabel(NAMES, id);
async function request<T>(suffix = "", body?: unknown): Promise<T> {
  const response = await fetch(`${PATH}${suffix}`, {
    credentials: "same-origin",
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json", "x-kogane-settings": "1" },
          body: JSON.stringify(body),
        }),
  });
  // A fixed message chosen from the status, never the server's text: the
  // page's load error (QueryBoundary's ErrorState) shows it as it is.
  if (!response.ok) throw new ApiError(response.status, statusMessage(response.status));
  return response.json() as Promise<T>;
}
function statusMessage(status: number): string {
  if (status === 409) return "他の変更が先に保存されました。表示を更新して再度変更してください。";
  if (status === 401 || status === 403) return "管理者のログインが必要です。";
  if (status === 400 || status === 415) return "入力した時刻・出典・確認日時を確認してください。";
  return "設定を確認できません。表示を更新して保存状態を確認してください。";
}
function failure(error: unknown): string {
  return statusMessage(error instanceof ApiError ? error.status : 0);
}
/**
 * Whether the page shows an earlier answer: QueryBoundary keeps it, under its
 * 前回読み込んだ warning, while a refresh fails or waits offline. The actions
 * that decide from what the page shows, and that no server check ties to the
 * answer shown, are held until a read succeeds (docs/schedules.md).
 */
const showsEarlier = (query: UseQueryResult<unknown>): boolean =>
  query.data !== undefined && (query.isError || query.fetchStatus === "paused");
function Occurrence({ value }: { value: ScheduleOccurrence }): ReactNode {
  return (
    <div className="schedule-receipt">
      <span>
        {fmt(value.startedAt)} · {STATUS[value.status]}
      </span>
      {value.runLinks.map((link) =>
        link.evidenceId ? (
          <Link key={link.runId} to={`/runs/${link.evidenceId}`}>
            取得記録を見る
          </Link>
        ) : (
          <span key={link.runId} className="muted">
            取得記録の保存・取り込み待ち
          </span>
        ),
      )}
      {value.status === "not_dispatched" ? (
        <p>収集先は呼び出されていません。自動再実行は一度までです。</p>
      ) : null}
      {value.status === "uncertain" ? (
        <p>同じ予定の自動再実行は行いません。取得履歴を確認してください。</p>
      ) : null}
    </div>
  );
}
/**
 * A card's last save result: the revision the save was made from and the
 * revision it describes (the one it wrote; the same one when it wrote none).
 */
interface CardMessage {
  from: number;
  revision: number;
  text: string;
}
/**
 * Whether a card showing `revision` shows the message: at the revision the
 * save wrote, and at the one it was made from until that one is read back
 * (or while the read back fails), never at a later revision written elsewhere.
 */
const describes = (message: CardMessage | undefined, revision: number): message is CardMessage =>
  message !== undefined && (message.revision === revision || message.from === revision);
const DISPATCH_OFF = {
  lane_disabled: "依頼の処理が停止しているため、送った依頼は実行されません。",
  connection_disabled:
    "この接続は依頼による収集がまだ有効ではありません。送った依頼は実行されず24時間後に期限切れになるため、送信できません。",
};
/**
 * A refusal the server answers before it looks the key up (every 4xx but 408
 * and 429: sign-in, grant, origin, schema and declared-source refusals): this
 * send stored nothing, but it says nothing about an earlier send under the
 * key. Any other failure may follow a stored request.
 */
const refusedBeforeStore = (error: unknown): boolean =>
  error instanceof CollectionRequestError &&
  error.status >= 400 &&
  error.status < 500 &&
  error.status !== 408 &&
  error.status !== 429;
function requestFailure(error: unknown): string {
  if (error instanceof CollectionRequestError) {
    if (error.status === 401 || error.status === 403) return "管理者のログインが必要です。";
    if (error.status === 0)
      return "接続できませんでした。依頼が保存されたか分からないため、もう一度送信してください（同じ依頼として扱われます）。";
    if (error.code === "target_missing") return "この出典は依頼の対象として登録されていません。";
    // Every other 4xx is refused before anything is stored: a re-send under
    // the same key is refused the same way, so it is not offered as a retry.
    if (error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429)
      return `依頼は受け付けられず、保存されていません（${error.code ?? `HTTP ${error.status}`}）。`;
  }
  return "依頼を保存できたか確認できません。もう一度送信してください（同じ依頼として扱われます）。";
}
/**
 * One job's request state, held by the page: a card remounts on each new
 * revision, and a pending key or an operation id must survive that.
 */
interface RequestState {
  /**
   * One key per confirmation: a retry after a lost answer is the same request.
   * The window's date is fixed by the first send under that key, so a retry
   * after JST midnight re-sends the same payload instead of meeting
   * `idempotency_conflict`.
   */
  pending: { key: string; at: Date | null } | null;
  /**
   * The key and window of a send whose answer did not say whether the request
   * was stored. やめる keeps it: the request may already be stored, so the
   * next confirmation re-sends it under the same key and window, and the
   * server answers with the stored operation instead of storing a second
   * one. Cleared once a send under it is accepted.
   */
  unresolved: { key: string; at: Date } | null;
  busy: boolean;
  message: string;
  operationId: string | null;
}
const IDLE: RequestState = {
  pending: null,
  unresolved: null,
  busy: false,
  message: "",
  operationId: null,
};
/** What the section keeps saying after やめる while a send's outcome is unknown. */
const UNRESOLVED_CANCEL =
  "送信した依頼が保存されたかは確認できていません。保存されていれば、やめても取り消されず実行されます。このページを開いたまま、もう一度「収集を依頼」から送ると同じ依頼として扱われ、二重には保存されません。ページを離れるか再読み込みすると、次の依頼は新しい依頼になります。";
/**
 * 収集を依頼 (ADR 0048): the same stored request `kogane.ops.collection.request`
 * makes. The confirmation shows what the caller should read first — the last
 * run, a held lease, the next scheduled run and the maintenance status —
 * because a request cannot be taken back once a collector starts it.
 */
function CollectionRequest({
  value,
  lease,
  state,
  update,
  sending,
  earlier,
}: {
  value: ScheduleView;
  lease: ScheduleSnapshot["leases"][number] | undefined;
  state: RequestState;
  update: (patch: Partial<RequestState>) => void;
  /** The page's synchronous guard against a second send for the same job. */
  sending: Set<string>;
  /**
   * The page shows an earlier answer: the facts this confirmation asks the
   * operator to read first may be out of date, so nothing is sent.
   */
  earlier: boolean;
}): ReactNode {
  const { pending, unresolved, busy, message, operationId } = state;
  const target = value.collectionRequest;
  if (!target) return null;
  async function send() {
    if (earlier || sending.has(value.id) || pending === null || !target) return;
    sending.add(value.id);
    const at = pending.at ?? new Date();
    update({ pending: { key: pending.key, at }, busy: true, message: "" });
    try {
      const accepted = await postCollectionRequest(target.source, pending.key, at);
      update({
        pending: null,
        unresolved: null,
        operationId: accepted.operationId,
        message: acceptedCollectionMessage(accepted),
      });
    } catch (error) {
      update({
        message: requestFailure(error),
        // A refusal keeps what an earlier send under this key left unknown.
        unresolved: refusedBeforeStore(error) ? unresolved : { key: pending.key, at },
      });
    } finally {
      sending.delete(value.id);
      update({ busy: false });
    }
  }
  return (
    <div className="schedule-request">
      <h3>収集を依頼</h3>
      {target.dispatch !== "enabled" ? (
        <p>{DISPATCH_OFF[target.dispatch]}</p>
      ) : pending === null ? (
        <button
          type="button"
          className="button"
          onClick={() =>
            update({
              message: "",
              operationId: null,
              pending: unresolved ?? { key: collectionRequestKey(), at: null },
            })
          }
        >
          収集を依頼
        </button>
      ) : (
        <div role="group" aria-label={`${name(value.id)}の収集依頼の確認`}>
          <p>
            {name(value.id)}
            にログインし、毎日の収集と同じ範囲を取得します。期間は指定できません。収集が始まった依頼は取り消せません。送信する前に、次の状態を確認してください。
          </p>
          {unresolved !== null && unresolved.key === pending.key ? (
            <p>
              前回の送信は保存されたか確認できていません。同じ依頼として送ります。保存済みなら、その依頼の状態を表示します。
            </p>
          ) : null}
          <dl>
            <dt>前回の実行</dt>
            <dd>
              {value.latest
                ? `${fmt(value.latest.startedAt)} · ${STATUS[value.latest.status]}`
                : "記録なし"}
            </dd>
            <dt>実行中の収集</dt>
            <dd>
              {lease
                ? `あり（開始 ${fmt(lease.startedAt)}）。終わるまで依頼は待機します。`
                : "なし"}
            </dd>
            <dt>次の定期実行</dt>
            <dd>{fmt(value.nextRunAt)}</dd>
            <dt>メンテナンス時間</dt>
            <dd>{REF[value.maintenance.status]}。停止時間中は終了まで待機します。</dd>
          </dl>
          {earlier ? (
            <Notice tone="warn" inline>
              前回読み込んだ状態です。更新できるまで依頼は送信できません。
            </Notice>
          ) : null}
          <div className="schedule-actions">
            <BusyButton busy={busy} disabled={earlier} onClick={() => void send()}>
              {busy ? "送信中…" : "依頼を送信"}
            </BusyButton>
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() =>
                update({ pending: null, message: unresolved === null ? "" : UNRESOLVED_CANCEL })
              }
            >
              やめる
            </button>
          </div>
        </div>
      )}
      {message ? (
        <p role="status">
          {message}
          {operationId ? (
            <>
              {" "}
              <Link to={operationRoute(operationId)}>依頼の経過を見る</Link>
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
/**
 * Whether a settings write's answer leaves what is stored unknown: no answer
 * (a network error), a 2xx whose body cannot be read, a 5xx, 408 or 429 (a
 * lost relay is `503 scheduling_unavailable`, possibly after the Processor
 * wrote). Every other 4xx is the server's refusal before it wrote anything.
 */
const outcomeUnknown = (error: unknown): boolean =>
  !(error instanceof ApiError) ||
  error.status >= 500 ||
  error.status === 408 ||
  error.status === 429;
/**
 * A `409` (the version check found another revision, or the proposal was
 * decided): what is stored may be this very change, saved by an earlier
 * attempt whose answer was lost.
 */
const conflict = (error: unknown): boolean => error instanceof ApiError && error.status === 409;
/** JSON with object keys sorted, so two values compare by content, not key order. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
/**
 * The page's snapshot read again after a write whose answer did not say what
 * is stored, or null when that read fails too. The read starts after the
 * answer, so it shows the write if the server stored it.
 */
async function readBack(
  client: ReturnType<typeof useQueryClient>,
): Promise<ScheduleSnapshot | null> {
  try {
    await client.invalidateQueries({ queryKey: ["schedules"] }, { throwOnError: true });
  } catch {
    return null;
  }
  return client.getQueryData<ScheduleSnapshot>(["schedules"]) ?? null;
}
const READ_BACK_FAILED = "保存されたか確認できません。表示を更新して保存状態を確認してください。";
const NOT_STORED = "読み直した時点では保存されていません。もう一度保存できます。";
/**
 * What a save says once the stored revision is read back after an unknown
 * answer or a `409`. Saved means the stored revision moved past the one the
 * save was made from and holds exactly this change; a revision that did not
 * move means nothing is stored yet, and the version check refuses a retry if
 * an earlier attempt lands after all.
 */
function readBackText(
  error: unknown,
  from: number,
  stored: { revision: number } | undefined,
  same: boolean,
): string {
  if (!stored) return READ_BACK_FAILED;
  if (stored.revision > from && same)
    return conflict(error)
      ? "この変更はすでに保存されています。読み直した設定はこの変更と同じです。"
      : "応答を受け取れませんでしたが、読み直した設定はこの変更と同じで、保存されています。";
  if (stored.revision > from)
    return conflict(error)
      ? "他の変更が先に保存されました。読み直した設定を表示しています。必要なら再度変更してください。"
      : "この変更が保存されたかは分かりません。読み直した設定はこの変更と異なります。表示中の設定を確認し、必要なら再度変更してください。";
  return conflict(error) ? failure(error) : NOT_STORED;
}
const RESERVATION_PENDING = "実行予約の反映を待っています。";
/** A maintenance rule's stored fields, compared by content: what one save asks to store. */
const ruleChange = (r: Omit<MaintenanceRule, "id" | "revision">): string =>
  canonical({
    source: r.source,
    timezone: r.timezone,
    pattern: r.pattern,
    enabled: r.enabled,
    scope: r.scope,
    referenceUrl: r.referenceUrl,
    verifiedAt: r.verifiedAt,
  });
/**
 * A callback ref that focuses its element once, when it mounts: a module
 * function keeps one identity, so React does not call it again on re-render.
 */
const focusOnMount = (element: HTMLElement | null) => element?.focus();
/**
 * A proposal as the read back shows it: still `listed` (undecided), decided
 * with the rule revision accepting it would write (`accepted`), or `decided`
 * some other way; null when the read failed, or when the snapshot leaves out
 * undecided proposals past the shown bound and does not list this one.
 */
function decidedAfterReadBack(
  snapshot: ScheduleSnapshot | null,
  proposal: MaintenanceSurveyProposalView,
): "listed" | "accepted" | "decided" | null {
  const survey = snapshot?.survey;
  if (!snapshot || !survey) return null;
  if (survey.proposals.some((p) => p.id === proposal.id)) return "listed";
  if (survey.attention > survey.proposals.length) return null;
  const accepted = ruleChange({ ...proposal, verifiedAt: proposal.fetchedAt });
  // A `new` proposal's rule is created under `<source>-survey-<id>` (the
  // Processor's `proposedRuleId`).
  const ruleId = proposal.ruleId ?? `${proposal.source}-survey-${proposal.id}`;
  return snapshot.maintenance.some(
    (r) =>
      r.id === ruleId && r.revision === proposal.baseRevision + 1 && ruleChange(r) === accepted,
  )
    ? "accepted"
    : "decided";
}
function ScheduleCard({
  value,
  lease,
  collection,
  refresh,
  message,
  setMessage,
}: {
  value: ScheduleView;
  lease: ScheduleSnapshot["leases"][number] | undefined;
  collection: Omit<Parameters<typeof CollectionRequest>[0], "value" | "lease">;
  refresh: () => Promise<unknown>;
  /** Held by the page: the card remounts on each new revision, its result must not. */
  message: CardMessage | undefined;
  setMessage: (message: CardMessage) => void;
}): ReactNode {
  const [enabled, setEnabled] = useState(value.enabled),
    [timezone, setTimezone] = useState(value.timezone),
    [pattern, setPattern] = useState<SchedulePattern>(value.pattern);
  const [busy, setBusy] = useState(false);
  const client = useQueryClient();
  async function save(event: FormEvent) {
    event.preventDefault();
    // A save in flight ignores another submission, Enter in a field included.
    if (busy) return;
    setBusy(true);
    setMessage({ from: value.revision, revision: value.revision, text: "" });
    const intended = canonical({ enabled, timezone, pattern });
    try {
      const result = await request<{ reservation: string }>(`/${value.id}`, {
        revision: value.revision,
        enabled,
        timezone,
        pattern,
      });
      // The version check admits a save only at the revision shown, so the
      // save stored exactly the next revision: the message is about that one,
      // never about a later change read back from elsewhere.
      setMessage({
        from: value.revision,
        revision: value.revision + 1,
        text:
          result.reservation === "pending"
            ? "保存済み。実行予約の反映を待っています。"
            : "保存しました。",
      });
      await refresh();
    } catch (error) {
      if (!outcomeUnknown(error) && !conflict(error)) {
        setMessage({ from: value.revision, revision: value.revision, text: failure(error) });
        return;
      }
      // The answer does not say whether this change is stored: read the job
      // back, so the card shows what the server holds and says how that
      // compares with this change.
      const stored = (await readBack(client))?.schedules.find((s) => s.id === value.id);
      const same =
        stored !== undefined &&
        canonical({
          enabled: stored.enabled,
          timezone: stored.timezone,
          pattern: stored.pattern,
        }) === intended;
      setMessage({
        from: value.revision,
        revision: stored?.revision ?? value.revision,
        text: readBackText(error, value.revision, stored, same),
      });
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="schedule-card">
      <header>
        <h2>{name(value.id)}</h2>
        <span className={`schedule-state ${value.reservation}`}>
          {value.reservation === "armed"
            ? "予約済み"
            : value.reservation === "disabled"
              ? "停止中"
              : "予約の反映待ち"}
        </span>
      </header>
      {!value.supported ? (
        <p>
          {value.kind === "manual"
            ? "人による認証が必要なため、自動収集は未対応です。"
            : "メールからの取得を使用します。自動ログインは未対応です。"}
        </p>
      ) : (
        <form onSubmit={save}>
          <label className="schedule-toggle">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            定期実行を有効にする
          </label>
          {pattern.kind === "daily" ? (
            <>
              <label>
                実行時刻
                <input
                  aria-label={`${name(value.id)}の実行時刻`}
                  type="time"
                  required
                  value={pattern.time}
                  onChange={(e) => setPattern({ ...pattern, time: e.target.value })}
                />
              </label>
              <fieldset>
                <legend>実行する曜日</legend>
                <div className="schedule-days">
                  {DAYS.map((day, index) => (
                    <label key={day}>
                      <input
                        type="checkbox"
                        checked={pattern.weekdays.includes(index)}
                        onChange={(e) =>
                          setPattern({
                            ...pattern,
                            weekdays: e.target.checked
                              ? [...pattern.weekdays, index].sort()
                              : pattern.weekdays.filter((d) => d !== index),
                          })
                        }
                      />
                      {day}
                    </label>
                  ))}
                </div>
              </fieldset>
            </>
          ) : (
            <label>
              実行間隔（分）
              <input
                type="number"
                min={5}
                max={1440}
                required
                value={pattern.minutes}
                onChange={(e) => setPattern({ kind: "interval", minutes: Number(e.target.value) })}
              />
            </label>
          )}
          <label>
            設定時刻の地域
            <select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
              <option value="Asia/Tokyo">日本</option>
              <option value="Australia/Sydney">シドニー</option>
              <option value="UTC">UTC</option>
            </select>
          </label>
          {/* In flight it waits as `BusyButton` does (aria-disabled, focus
              kept); with no weekday chosen there is nothing to save. */}
          <button
            className="button"
            disabled={pattern.kind === "daily" && pattern.weekdays.length === 0}
            aria-disabled={busy ? true : undefined}
          >
            {busy ? "保存中…" : "設定を保存"}
          </button>
          <p role="status">{describes(message, value.revision) ? message.text : ""}</p>
        </form>
      )}
      <dl>
        <dt>本来の次回予定</dt>
        <dd>{fmt(value.nextNominalAt)}</dd>
        <dt>メンテナンスを考慮した予定</dt>
        <dd>{fmt(value.nextRunAt)}</dd>
        <dt>実際に予約されている時刻</dt>
        <dd>{fmt(value.actualAlarmAt)}</dd>
      </dl>
      {value.source ? (
        <p className="schedule-provenance">
          {REF[value.maintenance.status]}
          {value.maintenance.referenceUrl ? (
            <>
              <br />
              <a href={value.maintenance.referenceUrl} target="_blank" rel="noreferrer">
                公式案内
              </a>{" "}
              · 確認 {fmt(value.maintenance.verifiedAt || null)}
              {Date.now() - Date.parse(value.maintenance.verifiedAt) > 30 * 86400000
                ? " · 再確認が必要です"
                : ""}
            </>
          ) : null}
        </p>
      ) : null}
      {value.latest ? (
        <Occurrence value={value.latest} />
      ) : (
        <p className="muted">この設定による実行記録はまだありません。</p>
      )}
      <CollectionRequest value={value} lease={lease} {...collection} />
    </article>
  );
}
function description(rule: Pick<MaintenanceRule, "pattern">): string {
  const p = rule.pattern;
  if (p.kind === "once") return `${fmt(p.from)} ～ ${fmt(p.to)}`;
  if (p.kind === "weekly")
    return `毎週 ${p.weekdays.map((d) => DAYS[d]).join("・")} ${p.start} ～ ${p.end}${p.end < p.start ? "（翌日）" : ""}`;
  return `毎月 第${p.nth}${DAYS[p.weekday]}曜${p.offsetDays ? `の${p.offsetDays}日後` : ""} ${p.start} ～ ${p.end}${p.end < p.start ? "（翌日）" : ""}`;
}
const FRESHNESS = {
  disabled: "自動取得なし（確認待ち）",
  never: "まだ取得できていません",
  fresh: "最新",
  stale: "古い情報（再調査が成功していません）",
};
const FAILURE: Record<SurveyFailureCode, string> = {
  network_error: "接続できませんでした",
  timeout: "応答がありませんでした",
  http_error: "ページを取得できませんでした",
  redirected: "別のページへ移動していました",
  too_large: "ページが大きすぎます",
  unsupported_content_type: "読めない形式のページです",
  empty_body: "ページが空でした",
  store_failed: "取得内容を保存できませんでした",
  decode_failed: "文字を読めませんでした",
  no_window_recognized: "停止時間を読み取れませんでした",
  too_many_windows: "停止時間が多すぎて読み取りを止めました",
};
const KIND = {
  new: "新しい停止時間",
  changed: "停止時間の変更",
  absent: "ページに見当たらない停止時間（無効にする提案）",
};
const REASON: Record<ProposalReason, string> = {
  year_inferred: "年の記載がありません",
  weekday_mismatch: "日付と曜日が合いません",
  end_next_day_inferred: "終了が翌日かどうか明記されていません",
  timezone_mismatch: "別の時間帯で書かれています",
  exception_stated: "例外の記載があります",
  may_change: "変更・延長の可能性が書かれています",
  cancellation_stated: "中止・延期の記載があります",
  partial_service: "一部サービスのみの停止です",
  long_window: "3日を超える停止です",
  contradictory_windows: "同じページに異なる時間があります",
  ambiguous_rule_match: "どの設定の変更か特定できません",
  rule_disabled_by_operator: "無効にした設定と同じです",
  rule_absent_from_page: "ページに記載が見つかりません",
};
function SurveyProposal({
  value,
  report,
  refresh,
  earlier,
}: {
  value: MaintenanceSurveyProposalView;
  /** Where the decision's result is said: the section, which outlives a decided proposal. */
  report: (text: string) => void;
  refresh: () => Promise<unknown>;
  /** The page shows an earlier answer: the list of proposals may be out of date. */
  earlier: boolean;
}): ReactNode {
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    client = useQueryClient();
  async function decide(decision: "accept" | "reject") {
    if (earlier) return;
    if (
      decision === "accept" &&
      !window.confirm(`${name(value.source)}のメンテナンス時間をこの提案のとおりに変更しますか？`)
    )
      return;
    setBusy(true);
    setMessage("");
    // A decided proposal leaves the list, and its result with it: the section
    // says what was decided, prefixed with which proposal it was.
    const said = (text: string) => report(`${name(value.source)}の${KIND[value.kind]}：${text}`);
    try {
      const answer = await request<{ decided: string; reservation?: string }>(
        `/proposals/${value.id}`,
        { decision },
      );
      said(
        answer.decided === "accepted"
          ? `採用し、メンテナンス時間に反映しました。${answer.reservation === "pending" ? RESERVATION_PENDING : ""}`
          : "却下しました。メンテナンス時間は変わりません。",
      );
      await refresh();
    } catch (error) {
      if (!outcomeUnknown(error) && !conflict(error)) {
        setMessage(failure(error));
        return;
      }
      // The answer does not say whether the decision is stored (a lost
      // answer, or a 409 that an earlier attempt's own decision may explain):
      // read the proposals and rules back.
      const snapshot = await readBack(client);
      const decided = decidedAfterReadBack(snapshot, value);
      if (decided === null) {
        const unknown = "決定されたか確認できません。表示を更新して確認してください。";
        // A failed read keeps the list shown, this proposal in it; a read
        // that does not list it (past the shown bound, or without the
        // re-survey part) removes it, and a message of its own with it.
        if (snapshot) said(unknown);
        else setMessage(unknown);
      } else if (decided === "listed")
        setMessage(
          conflict(error)
            ? failure(error)
            : "読み直した時点では決定されていません。もう一度選べます。",
        );
      else
        said(
          decided === "accepted"
            ? "この提案は採用済みで、メンテナンス時間に反映されています。"
            : "この提案は決定済みで、確認待ちの一覧から外れました。採用・却下のどちらになったかは、メンテナンス時間の一覧で確認してください。",
        );
    } finally {
      setBusy(false);
    }
  }
  return (
    <li>
      <div>
        <strong>{name(value.source)}</strong> · {KIND[value.kind]} · {description(value)}
        <br />
        <small>
          {value.status === "review_pending"
            ? `確認が必要: ${value.reasons.map((r) => REASON[r]).join("、")}`
            : "公式ページの記載と現在の設定が異なります"}{" "}
          · 取得 {fmt(value.fetchedAt)} ·{" "}
          <a href={value.referenceUrl} target="_blank" rel="noreferrer">
            公式案内
          </a>
          {value.current ? "" : " · この提案の後に設定が変更されたため、採用できません"}
        </small>
        <p role="alert">{message}</p>
      </div>
      <div className="schedule-actions">
        <BusyButton
          busy={busy}
          disabled={earlier || !value.current}
          onClick={() => void decide("accept")}
        >
          採用
        </BusyButton>
        <BusyButton busy={busy} disabled={earlier} onClick={() => void decide("reject")}>
          却下
        </BusyButton>
      </div>
    </li>
  );
}
function SurveySection({
  survey,
  refresh,
  earlier,
}: {
  survey: MaintenanceSurveyView | undefined;
  refresh: () => Promise<unknown>;
  earlier: boolean;
}): ReactNode {
  // A decision's result takes focus, since the decided proposal's buttons
  // are gone: each result is a new paragraph (its own key), so a repeated
  // text takes focus again.
  const [report, setReport] = useState<{ key: number; text: string } | null>(null);
  return (
    <section className="schedule-section" aria-labelledby="maintenance-survey">
      <h2 id="maintenance-survey">公式サイトの再調査</h2>
      <p>
        確認済みの公式ページだけを定期的に取得し、停止時間が変わっていれば提案します。採用するまでメンテナンス時間は変わりません。取得の失敗や空のページは「停止時間なし」とはみなしません。
      </p>
      {report ? (
        <p role="status" tabIndex={-1} key={report.key} ref={focusOnMount}>
          {report.text}
        </p>
      ) : null}
      {!survey ? (
        <p className="muted">再調査の状態を読み込めません。</p>
      ) : (
        <>
          {survey.enabled ? null : <p className="muted">自動再調査は停止しています。</p>}
          <ul className="maintenance-list">
            {survey.targets.map((t) => (
              <li key={t.id}>
                <div>
                  <strong>{name(t.source)}</strong> · {FRESHNESS[t.freshness]}
                  <br />
                  <small>
                    最終成功 {fmt(t.lastSuccessAt)}
                    {t.lastFailureCode
                      ? ` · 最終失敗 ${fmt(t.lastFailureAt)}（${FAILURE[t.lastFailureCode]}）`
                      : ""}
                    {t.lastChangedAt ? ` · ページ更新を検知 ${fmt(t.lastChangedAt)}` : ""}
                    {t.nextDueAt ? ` · 次回 ${fmt(t.nextDueAt)}` : ""} ·{" "}
                    <a href={t.url} target="_blank" rel="noreferrer">
                      公式案内
                    </a>
                  </small>
                </div>
              </li>
            ))}
          </ul>
          {survey.proposals.length > 0 ? (
            <>
              <h3>確認待ちの提案</h3>
              {earlier ? (
                <Notice tone="warn" inline>
                  前回読み込んだ提案です。更新できるまで採用・却下はできません。
                </Notice>
              ) : null}
              <ul className="maintenance-list">
                {survey.proposals.map((p) => (
                  <SurveyProposal
                    key={p.id}
                    value={p}
                    refresh={refresh}
                    earlier={earlier}
                    report={(text) => setReport((last) => ({ key: (last?.key ?? 0) + 1, text }))}
                  />
                ))}
              </ul>
            </>
          ) : (
            <p className="muted">確認待ちの提案はありません。</p>
          )}
        </>
      )}
    </section>
  );
}
function MaintenanceEditor({
  rule,
  sources,
  refresh,
  close,
}: {
  rule: MaintenanceRule | null;
  sources: string[];
  refresh: () => Promise<unknown>;
  close: () => void;
}): ReactNode {
  const [id, setId] = useState(rule?.id ?? ""),
    [source, setSource] = useState(rule?.source ?? sources[0] ?? ""),
    [enabled, setEnabled] = useState(rule?.enabled ?? true),
    [scope, setScope] = useState(rule?.scope ?? "collection"),
    [timezone, setTimezone] = useState(rule?.timezone ?? "Asia/Tokyo");
  const [kind, setKind] = useState(rule?.pattern.kind ?? "once");
  const [start, setStart] = useState(
      rule?.pattern.kind !== "once" ? (rule?.pattern.start ?? "00:00") : "00:00",
    ),
    [end, setEnd] = useState(
      rule?.pattern.kind !== "once" ? (rule?.pattern.end ?? "05:00") : "05:00",
    );
  const [weekdays, setWeekdays] = useState(
    rule?.pattern.kind === "weekly" ? rule.pattern.weekdays : [0],
  );
  const [weekday, setWeekday] = useState(
      rule?.pattern.kind === "monthly" ? rule.pattern.weekday : 6,
    ),
    [nth, setNth] = useState(rule?.pattern.kind === "monthly" ? rule.pattern.nth : 3),
    [offsetDays, setOffset] = useState(
      rule?.pattern.kind === "monthly" ? rule.pattern.offsetDays : 0,
    );
  const local = (value: string) =>
    new Date(Date.parse(value) + 9 * 3600000).toISOString().slice(0, 16);
  const [from, setFrom] = useState(rule?.pattern.kind === "once" ? local(rule.pattern.from) : ""),
    [to, setTo] = useState(rule?.pattern.kind === "once" ? local(rule.pattern.to) : "");
  const [url, setUrl] = useState(rule?.referenceUrl ?? ""),
    [verified, setVerified] = useState(local(rule?.verifiedAt ?? new Date().toISOString())),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    // A stored save's result: the editor then shows only it, since the form
    // still carries the revision the save was made from.
    [saved, setSaved] = useState("");
  const client = useQueryClient();
  async function save(e: FormEvent) {
    e.preventDefault();
    // A save in flight ignores another submission, Enter in a field included.
    if (busy) return;
    setBusy(true);
    setMessage("");
    // Set once the request is about to be sent: a failure before it stored nothing.
    let intended: string | null = null;
    try {
      const pattern =
        kind === "once"
          ? {
              kind,
              from: new Date(`${from}:00+09:00`).toISOString(),
              to: new Date(`${to}:00+09:00`).toISOString(),
            }
          : kind === "weekly"
            ? { kind, weekdays, start, end }
            : { kind, weekday, nth, offsetDays, start, end };
      const body = {
        id,
        revision: rule?.revision ?? 0,
        source,
        enabled,
        scope,
        timezone,
        pattern,
        referenceUrl: url,
        verifiedAt: new Date(`${verified}:00+09:00`).toISOString(),
      };
      intended = ruleChange(body);
      const answer = await request<{ reservation?: string }>("/maintenance", body);
      setSaved(
        `停止時間を保存しました。${answer.reservation === "pending" ? RESERVATION_PENDING : ""}`,
      );
      await refresh();
    } catch (error) {
      if (intended === null || (!outcomeUnknown(error) && !conflict(error))) {
        setMessage(failure(error));
        return;
      }
      // The answer does not say whether this revision is stored: read the
      // rules back. A rule the read does not list has no stored revision.
      const from = rule?.revision ?? 0;
      const snapshot = await readBack(client);
      const stored = snapshot
        ? (snapshot.maintenance.find((r) => r.id === id) ?? { revision: 0 })
        : undefined;
      const same = stored !== undefined && "source" in stored && ruleChange(stored) === intended;
      const text = readBackText(error, from, stored, same);
      if (stored && stored.revision > from && same) setSaved(text);
      else
        setMessage(
          stored && stored.revision > from
            ? `${text}一覧の「変更」から開き直すと、保存済みの設定から変更できます。`
            : text,
        );
    } finally {
      setBusy(false);
    }
  }
  if (saved)
    return (
      <div className="maintenance-editor">
        <h3>{rule ? "停止時間を変更" : "停止時間を追加"}</h3>
        <p role="status" tabIndex={-1} ref={focusOnMount}>
          {saved}
        </p>
        <div className="schedule-actions">
          <button className="button" type="button" onClick={close}>
            閉じる
          </button>
        </div>
      </div>
    );
  return (
    <form onSubmit={save} className="maintenance-editor">
      <h3>{rule ? "停止時間を変更" : "停止時間を追加"}</h3>
      <p>日時指定と確認日時は日本時間です。公式案内を確認して入力してください。</p>
      <label>
        設定名（半角英数字・ハイフン）
        <input
          required
          pattern="[a-z0-9-]{1,100}"
          value={id}
          disabled={!!rule}
          onChange={(e) => setId(e.target.value)}
        />
      </label>
      <label>
        取得元
        <select
          aria-label="取得元"
          value={source}
          disabled={!!rule}
          onChange={(e) => setSource(e.target.value)}
        >
          {sources.map((s) => (
            <option key={s} value={s}>
              {name(s)}
            </option>
          ))}
        </select>
      </label>
      <label className="schedule-toggle">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        停止時間を有効にする
      </label>
      <label>
        対象
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value as MaintenanceRule["scope"])}
        >
          <option value="collection">収集を延期</option>
          <option value="session">収集・セッション維持を延期</option>
          <option value="feature-only">一部機能のみ（収集は延期しない）</option>
        </select>
      </label>
      <label>
        繰り返し
        <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          <option value="once">日時指定</option>
          <option value="weekly">毎週</option>
          <option value="monthly">毎月</option>
        </select>
      </label>
      {kind === "once" ? (
        <>
          <label>
            開始（日本時間）
            <input
              type="datetime-local"
              required
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label>
            終了（日本時間）
            <input
              type="datetime-local"
              required
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
        </>
      ) : (
        <>
          <label>
            繰り返し時刻の地域
            <select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
              <option value="Asia/Tokyo">日本</option>
              <option value="Australia/Sydney">シドニー</option>
              <option value="UTC">UTC</option>
            </select>
          </label>
          {kind === "weekly" ? (
            <fieldset>
              <legend>開始曜日</legend>
              <div className="schedule-days">
                {DAYS.map((d, i) => (
                  <label key={d}>
                    <input
                      type="checkbox"
                      checked={weekdays.includes(i)}
                      onChange={(e) =>
                        setWeekdays(
                          e.target.checked ? [...weekdays, i] : weekdays.filter((v) => v !== i),
                        )
                      }
                    />
                    {d}
                  </label>
                ))}
              </div>
            </fieldset>
          ) : (
            <>
              <label>
                第何週
                <input
                  type="number"
                  required
                  min={1}
                  max={5}
                  value={nth}
                  onChange={(e) => setNth(Number(e.target.value))}
                />
              </label>
              <label>
                曜日
                <select value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
                  {DAYS.map((d, i) => (
                    <option key={d} value={i}>
                      {d}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                その曜日から何日後
                <input
                  type="number"
                  required
                  min={0}
                  max={6}
                  value={offsetDays}
                  onChange={(e) => setOffset(Number(e.target.value))}
                />
              </label>
            </>
          )}
          <label>
            開始時刻
            <input type="time" required value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label>
            終了時刻（開始より前なら翌日）
            <input type="time" required value={end} onChange={(e) => setEnd(e.target.value)} />
          </label>
        </>
      )}
      <label>
        公式案内のURL
        <input type="url" required value={url} onChange={(e) => setUrl(e.target.value)} />
      </label>
      <label>
        公式案内を確認した日時（日本時間）
        <input
          type="datetime-local"
          required
          value={verified}
          onChange={(e) => setVerified(e.target.value)}
        />
      </label>
      <div className="schedule-actions">
        {/* In flight it waits as `BusyButton` does: aria-disabled, focus kept. */}
        <button className="button" aria-disabled={busy ? true : undefined}>
          {busy ? "保存中…" : "停止時間を保存"}
        </button>
        <button className="button" type="button" onClick={close}>
          閉じる
        </button>
      </div>
      <p role="alert">{message}</p>
    </form>
  );
}
export function SchedulesPage(): ReactNode {
  // The page shows every occurrence and rule; the route's default is the summary (ADR 0123).
  const query = useQuery({
      queryKey: ["schedules"],
      queryFn: () => request<ScheduleSnapshot>("?detail=full"),
    }),
    client = useQueryClient();
  const [editor, setEditor] = useState<MaintenanceRule | null | undefined>(),
    [filter, setFilter] = useState("collection"),
    [leaseMessage, setLeaseMessage] = useState(""),
    [cardMessages, setCardMessages] = useState<Record<string, CardMessage>>({}),
    [requestStates, setRequestStates] = useState<Record<string, RequestState>>({}),
    [releasingSources, setReleasingSources] = useState<string[]>([]);
  const leaseRequests = useRef(new Set<string>());
  const collectionSends = useRef(new Set<string>());
  const refresh = () => client.invalidateQueries({ queryKey: ["schedules"] });
  // Held while the answer shown is an earlier one: sending a collection
  // request and deciding a survey proposal. A schedule or maintenance save is
  // checked against the revision it was made from, and a lease release against
  // the exact lease reference shown, so the server refuses those (409) when
  // what they were based on changed; they stay available, and a release keeps
  // its documented retry after a failed read back.
  const earlier = showsEarlier(query);
  async function releaseLease(lease: ScheduleSnapshot["leases"][number]) {
    // The ref closes the gap before React marks the button busy, including
    // another activation while the confirmation dialog is being opened.
    if (leaseRequests.current.has(lease.source)) return;
    leaseRequests.current.add(lease.source);
    if (
      !window.confirm(
        `${name(lease.source)}の前の実行が停止していることを確認しましたか？ 実行中の解除は重複収集につながります。`,
      )
    ) {
      leaseRequests.current.delete(lease.source);
      return;
    }
    setReleasingSources([...leaseRequests.current]);
    setLeaseMessage("");
    try {
      let message = "対象の停止した実行は解除済みです。現在の実行状態を確認してください。";
      try {
        await request(`/leases/${lease.source}`, {
          leaseRef: lease.leaseRef,
          confirmedStopped: true,
        });
      } catch (error) {
        message = failure(error);
      }
      try {
        // A failed response may still follow a completed write. Read back on
        // both outcomes before allowing another release from this source.
        await client.invalidateQueries({ queryKey: ["schedules"] }, { throwOnError: true });
      } catch {
        message = "解除結果を確認できません。表示を更新して現在の実行状態を確認してください。";
      }
      setLeaseMessage(message);
    } finally {
      leaseRequests.current.delete(lease.source);
      setReleasingSources([...leaseRequests.current]);
    }
  }
  return (
    <section>
      <div className="page-head">
        <h1>収集スケジュール</h1>
        <p className="lede">
          実行時刻とメンテナンス時間を管理します。予定・予約・履歴は日本時間で表示します。
        </p>
        <Link to="/evidence">取得履歴を見る</Link>
      </div>
      <p className="query-notice">
        メンテナンスに重なった収集は、終了後に1回実行します。時刻の変更は次回から反映されます。
      </p>
      {/* An earlier answer stays visible after a failed refresh only under
          QueryBoundary's 前回読み込んだ warning, the count below included
          (INV05); a 401/403 hides it. */}
      <QueryBoundary query={query} label="収集スケジュール">
        {(data) => (
          <>
            {data.survey && data.survey.attention > 0 ? (
              <p className="query-notice" role="status">
                公式サイトの案内に変更の可能性があります。{data.survey.attention}
                件の提案を確認してください。
              </p>
            ) : null}
            <div className="schedule-grid">
              {data.schedules.map((s) => (
                <ScheduleCard
                  key={`${s.id}:${s.revision}`}
                  value={s}
                  lease={data.leases.find((lease) => lease.source === s.source)}
                  collection={{
                    state: requestStates[s.id] ?? IDLE,
                    update: (patch) =>
                      setRequestStates((states) => ({
                        ...states,
                        [s.id]: { ...(states[s.id] ?? IDLE), ...patch },
                      })),
                    sending: collectionSends.current,
                    earlier,
                  }}
                  refresh={refresh}
                  message={cardMessages[s.id]}
                  setMessage={(message) =>
                    setCardMessages((messages) => ({ ...messages, [s.id]: message }))
                  }
                />
              ))}
            </div>
            <section className="schedule-section">
              <header>
                <h2>メンテナンス時間</h2>
                <button className="button" onClick={() => setEditor(null)}>
                  停止時間を追加
                </button>
              </header>
              <p>
                公式サイトの再調査は提案だけを行い、ここに表示される設定を自動では変更しません。新しい案内を確認したら、出典・確認日時と合わせて変更してください。
              </p>
              {/* Keyed by revision: reopening a rule that changed since the form
                opened starts from what is stored, so the form never sends an
                earlier revision's fields under the newer revision number. */}
              {editor !== undefined ? (
                <MaintenanceEditor
                  key={editor === null ? "new" : `${editor.id}:${String(editor.revision)}`}
                  rule={editor}
                  sources={data.schedules
                    .flatMap((s) => (s.source ? [s.source] : []))
                    .filter((s, i, a) => a.indexOf(s) === i)}
                  refresh={refresh}
                  close={() => setEditor(undefined)}
                />
              ) : null}
              <ul className="maintenance-list">
                {data.maintenance.map((r) => (
                  <li key={r.id}>
                    <div>
                      <strong>{name(r.source)}</strong> · {description(r)}
                      <br />
                      <small>
                        {r.enabled
                          ? r.scope === "feature-only"
                            ? "一部機能のみ：収集は延期しません"
                            : "収集を延期"
                          : "無効"}{" "}
                        · 確認 {fmt(r.verifiedAt)} ·{" "}
                        <a href={r.referenceUrl} target="_blank" rel="noreferrer">
                          公式案内
                        </a>
                        {r.pattern.kind === "once" && Date.parse(r.pattern.to) < Date.now()
                          ? " · 終了済み"
                          : ""}
                      </small>
                    </div>
                    <button className="button" onClick={() => setEditor(r)}>
                      変更
                    </button>
                  </li>
                ))}
              </ul>
            </section>
            <SurveySection survey={data.survey} refresh={refresh} earlier={earlier} />
            <section className="schedule-section">
              <h2>実行結果</h2>
              <label>
                表示する実行
                <select value={filter} onChange={(e) => setFilter(e.target.value)}>
                  <option value="collection">収集</option>
                  <option value="all">すべて（保存処理・セッション維持を含む）</option>
                </select>
              </label>
              <p>直近の記録です。各取得元の最新結果は上のカードにも表示します。</p>
              {data.occurrences
                .filter(
                  (o) =>
                    filter === "all" ||
                    data.schedules.find((s) => s.id === o.scheduleId)?.kind === "collection",
                )
                .map((o) => (
                  <article className="schedule-history" key={o.id}>
                    <strong>{name(o.scheduleId)}</strong>
                    <Occurrence value={o} />
                  </article>
                ))}
            </section>
            {"leases" in data && Array.isArray(data.leases) && data.leases.length > 0 ? (
              <section className="schedule-section">
                <h2>実行中の取得元</h2>
                <p>
                  前の実行が終了したことを確認できるまで、新しい実行を開始しません。処理が停止した場合のみ、取得履歴と実行状態を確認して解除してください。
                </p>
                {(data.leases as { source: string; leaseRef: string; startedAt: string }[]).map(
                  (lease) => (
                    <div className="schedule-history" key={lease.source}>
                      <strong>{name(lease.source)}</strong> · 開始 {fmt(lease.startedAt)}
                      <BusyButton
                        busy={releasingSources.includes(lease.source)}
                        onClick={() => void releaseLease(lease)}
                      >
                        {releasingSources.includes(lease.source) ? "解除中…" : "停止した実行を解除"}
                      </BusyButton>
                    </div>
                  ),
                )}
              </section>
            ) : null}
            {leaseMessage ? <p role="status">{leaseMessage}</p> : null}
          </>
        )}
      </QueryBoundary>
    </section>
  );
}
