import { useState, type FormEvent, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  MaintenanceRule,
  SchedulePattern,
  ScheduleSnapshot,
  ScheduleView,
  ScheduleOccurrence,
} from "../../../../packages/collection/src/schedule-model";
import { ApiError } from "../api";
import { Link } from "../router";
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
const STATUS = {
  started: "実行中・結果待ち",
  completed: "完了",
  failed: "失敗",
  uncertain: "結果を確認できません",
  partial: "一部のみ取得",
};
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
const name = (id: string) => NAMES[id] ?? id;
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
  if (!response.ok) throw new ApiError(response.status, "schedule_request_failed");
  return response.json() as Promise<T>;
}
function failure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409)
      return "他の変更が先に保存されました。表示を更新して再度変更してください。";
    if (error.status === 401 || error.status === 403) return "管理者のログインが必要です。";
    if (error.status === 400 || error.status === 415)
      return "入力した時刻・出典・確認日時を確認してください。";
  }
  return "設定を確認できません。表示を更新して保存状態を確認してください。";
}
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
      {value.status === "uncertain" ? (
        <p>同じ予定の自動再実行は行いません。取得履歴を確認してください。</p>
      ) : null}
    </div>
  );
}
function ScheduleCard({
  value,
  refresh,
}: {
  value: ScheduleView;
  refresh: () => Promise<unknown>;
}): ReactNode {
  const [enabled, setEnabled] = useState(value.enabled),
    [timezone, setTimezone] = useState(value.timezone),
    [pattern, setPattern] = useState<SchedulePattern>(value.pattern);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const result = await request<{ reservation: string }>(`/${value.id}`, {
        revision: value.revision,
        enabled,
        timezone,
        pattern,
      });
      setMessage(
        result.reservation === "pending"
          ? "保存済み。実行予約の反映を待っています。"
          : "保存しました。",
      );
      await refresh();
    } catch (error) {
      setMessage(failure(error));
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
          <button
            className="button"
            disabled={busy || (pattern.kind === "daily" && pattern.weekdays.length === 0)}
          >
            {busy ? "保存中…" : "設定を保存"}
          </button>
          <p role="status">{message}</p>
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
    </article>
  );
}
function description(rule: MaintenanceRule): string {
  const p = rule.pattern;
  if (p.kind === "once") return `${fmt(p.from)} ～ ${fmt(p.to)}`;
  if (p.kind === "weekly")
    return `毎週 ${p.weekdays.map((d) => DAYS[d]).join("・")} ${p.start} ～ ${p.end}${p.end < p.start ? "（翌日）" : ""}`;
  return `毎月 第${p.nth}${DAYS[p.weekday]}曜${p.offsetDays ? `の${p.offsetDays}日後` : ""} ${p.start} ～ ${p.end}${p.end < p.start ? "（翌日）" : ""}`;
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
    [busy, setBusy] = useState(false);
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage("");
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
      await request("/maintenance", {
        id,
        revision: rule?.revision ?? 0,
        source,
        enabled,
        scope,
        timezone,
        pattern,
        referenceUrl: url,
        verifiedAt: new Date(`${verified}:00+09:00`).toISOString(),
      });
      await refresh();
      close();
    } catch (error) {
      setMessage(failure(error));
    } finally {
      setBusy(false);
    }
  }
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
        <button className="button" disabled={busy}>
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
  const query = useQuery({ queryKey: ["schedules"], queryFn: () => request<ScheduleSnapshot>() }),
    client = useQueryClient();
  const [editor, setEditor] = useState<MaintenanceRule | null | undefined>(),
    [filter, setFilter] = useState("collection"),
    [leaseMessage, setLeaseMessage] = useState("");
  const refresh = () => client.invalidateQueries({ queryKey: ["schedules"] });
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
      {query.isPending ? (
        <p role="status">設定を読み込んでいます…</p>
      ) : query.isError ? (
        <p role="alert">{failure(query.error)}</p>
      ) : null}
      {query.data ? (
        <>
          <div className="schedule-grid">
            {query.data.schedules.map((s) => (
              <ScheduleCard key={`${s.id}:${s.revision}`} value={s} refresh={refresh} />
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
              公式サイトの案内は自動では更新されません。新しい案内を確認したら、出典・確認日時と合わせて変更してください。
            </p>
            {editor !== undefined ? (
              <MaintenanceEditor
                key={editor?.id ?? "new"}
                rule={editor}
                sources={query.data.schedules
                  .flatMap((s) => (s.source ? [s.source] : []))
                  .filter((s, i, a) => a.indexOf(s) === i)}
                refresh={refresh}
                close={() => setEditor(undefined)}
              />
            ) : null}
            <ul className="maintenance-list">
              {query.data.maintenance.map((r) => (
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
            {query.data.occurrences
              .filter(
                (o) =>
                  filter === "all" ||
                  query.data.schedules.find((s) => s.id === o.scheduleId)?.kind === "collection",
              )
              .map((o) => (
                <article className="schedule-history" key={o.id}>
                  <strong>{name(o.scheduleId)}</strong>
                  <Occurrence value={o} />
                </article>
              ))}
          </section>
          {"leases" in query.data &&
          Array.isArray(query.data.leases) &&
          query.data.leases.length > 0 ? (
            <section className="schedule-section">
              <h2>実行中の取得元</h2>
              <p>
                前の実行が終了したことを確認できるまで、新しい実行を開始しません。処理が停止した場合のみ、取得履歴と実行状態を確認して解除してください。
              </p>
              {(query.data.leases as { source: string; leaseRef: string; startedAt: string }[]).map(
                (lease) => (
                  <div className="schedule-history" key={lease.source}>
                    <strong>{name(lease.source)}</strong> · 開始 {fmt(lease.startedAt)}
                    <button
                      className="button"
                      onClick={async () => {
                        if (
                          !window.confirm(
                            `${name(lease.source)}の前の実行が停止していることを確認しましたか？ 実行中の解除は重複収集につながります。`,
                          )
                        )
                          return;
                        try {
                          await request(`/leases/${lease.source}`, {
                            leaseRef: lease.leaseRef,
                            confirmedStopped: true,
                          });
                          await refresh();
                          setLeaseMessage("解除しました。次の予定から実行できます。");
                        } catch (error) {
                          setLeaseMessage(failure(error));
                        }
                      }}
                    >
                      停止した実行を解除
                    </button>
                  </div>
                ),
              )}
              <p role="status">{leaseMessage}</p>
            </section>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
