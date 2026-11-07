// `監査ログ`: the operator's read-only view of the common audit record (ADR
// 0064; plan slice S8; docs/audit-log.md). One page of `GET /api/v2/audit`
// at a time — newest first, 50 records, filtered by the server's closed values
// only, paged by the server's cursor with no total. Every value on screen is a
// closed code, an identifier, a digest, a count or a stored UTC time; the
// record holds no amount, provider text or request body, so none is shown.
// Nothing here writes, and opening the page is not itself recorded.
import { useState, type FormEvent, type ReactNode } from "react";
import { ApiError } from "../api.ts";
import {
  AUDIT_DECISION_COUNT_LABELS,
  AUDIT_FILTER_CHOICES,
  AUDIT_LANE_PROPOSAL_KIND_LABELS,
  AUDIT_OPERATION_LABELS,
  AUDIT_PATH_LABELS,
  AUDIT_PRINCIPAL_KIND_LABELS,
  AUDIT_REQUEST_STATUS_LABELS,
  AUDIT_RESULT_LABELS,
  AUDIT_REVISION_FIELD_LABELS,
  AUDIT_ROUTE,
  AUDIT_SCOPE_LABELS,
  AUDIT_STEP_LABELS,
  auditFilterSearch,
  parseAuditFilters,
  useAuditPage,
  type AuditDiffView,
  type AuditFilters,
  type AuditRecordWire,
} from "../audit-api.ts";
import { displayLabel } from "../labels.ts";
import { Pagination } from "../pagination.tsx";
import { navigate, useLocation } from "../router.tsx";
import { Badge, EmptyState, Notice, Panel, QueryBoundary, type Tone } from "../ui.tsx";

const SELECTS: {
  key: keyof typeof AUDIT_FILTER_CHOICES;
  label: string;
  all: string;
  labels: Readonly<Record<string, string>>;
}[] = [
  { key: "operation", label: "操作", all: "すべての操作", labels: AUDIT_OPERATION_LABELS },
  { key: "result", label: "結果", all: "すべての結果", labels: AUDIT_RESULT_LABELS },
  { key: "path", label: "経路", all: "すべての経路", labels: AUDIT_PATH_LABELS },
  {
    key: "principalKind",
    label: "操作者の種類",
    all: "すべての種類",
    labels: AUDIT_PRINCIPAL_KIND_LABELS,
  },
];

const RESULT_TONES: Readonly<Record<string, Tone>> = {
  applied: "ok",
  accepted: "ok",
  refused: "warn",
  failed: "bad",
  overflow: "warn",
};

function go(filters: AuditFilters): void {
  const search = auditFilterSearch(filters);
  navigate(search ? `${AUDIT_ROUTE}?${search}` : AUDIT_ROUTE);
}

function Code({ value }: { value: string }): ReactNode {
  return <code className="wrap-any">{value}</code>;
}

function FilterForm({ filters }: { filters: AuditFilters }): ReactNode {
  const [draft, setDraft] = useState<AuditFilters>(filters);
  const invalidDates =
    draft.from !== undefined &&
    draft.from !== "" &&
    draft.to !== undefined &&
    draft.to !== "" &&
    draft.from > draft.to;
  function submit(event: FormEvent): void {
    event.preventDefault();
    if (!invalidDates) go(draft);
  }
  return (
    <section className="panel" aria-label="監査ログの絞り込み">
      <div className="panel-note">
        絞り込みは保存されたすべての記録に対して行い、その結果を新しい順に50件ずつ表示します。日付は協定世界時（UTC）の日付で、開始日と終了日を含みます。
      </div>
      <form className="filter-grid" onSubmit={submit}>
        {SELECTS.map((select) => (
          <label className="filter-field" key={select.key}>
            {select.label}
            <select
              aria-label={select.label}
              value={draft[select.key] ?? ""}
              onChange={(event) => setDraft({ ...draft, [select.key]: event.target.value })}
            >
              <option value="">{select.all}</option>
              {AUDIT_FILTER_CHOICES[select.key].map((value) => (
                <option key={value} value={value}>
                  {displayLabel(select.labels, value)}
                </option>
              ))}
            </select>
          </label>
        ))}
        <label className="filter-field">
          開始日（UTC）
          <input
            type="date"
            value={draft.from ?? ""}
            aria-invalid={invalidDates || undefined}
            onChange={(event) => setDraft({ ...draft, from: event.target.value })}
          />
        </label>
        <label className="filter-field">
          終了日（UTC）
          <input
            type="date"
            value={draft.to ?? ""}
            aria-invalid={invalidDates || undefined}
            onChange={(event) => setDraft({ ...draft, to: event.target.value })}
          />
        </label>
        <button className="button" type="submit" disabled={invalidDates}>
          条件を適用
        </button>
        {auditFilterSearch(filters) ? (
          <button className="button" type="button" onClick={() => go({})}>
            条件をクリア
          </button>
        ) : null}
        {invalidDates ? <p role="alert">開始日を終了日以前にしてください。</p> : null}
      </form>
    </section>
  );
}

function DiffSummary({ diff }: { diff: AuditDiffView }): ReactNode {
  switch (diff.kind) {
    case "read":
      return (
        <>
          {diff.rows}件を読み取り{diff.truncated ? "（続きあり）" : ""}
        </>
      );
    case "revision":
      return (
        <>
          改訂 {diff.from} → {diff.to}
          {diff.fields.length ? (
            <span className="audit-diff-fields">
              変更した項目:{" "}
              {diff.fields
                .map((field) => displayLabel(AUDIT_REVISION_FIELD_LABELS, field))
                .join("、")}
            </span>
          ) : null}
        </>
      );
    case "decision":
      return (
        <>
          判断の改訂 {diff.decisionRevisions}件
          {Object.keys(diff.counts).length ? (
            <ul className="plain-list audit-diff-fields">
              {Object.entries(diff.counts).map(([key, n]) => (
                <li key={key}>
                  {displayLabel(AUDIT_DECISION_COUNT_LABELS, key)}: {n}件
                </li>
              ))}
            </ul>
          ) : null}
        </>
      );
    case "request":
      return <>依頼の状態: {displayLabel(AUDIT_REQUEST_STATUS_LABELS, diff.status)}</>;
    case "release":
      return <>停止した実行を解除</>;
    case "overflow":
      return (
        <>
          1日の上限（{diff.cap}件）を超えた{displayLabel(AUDIT_RESULT_LABELS, diff.of)}
          {diff.count}件を集計
        </>
      );
    case "lane":
      return (
        <>
          判断の改訂 {diff.decisionRevisions}件 · 確定の記録 {diff.commits}件
          {diff.proposals.length ? (
            <ul className="plain-list audit-diff-fields">
              {diff.proposals.map((proposal) => (
                <li key={proposal.kind}>
                  {displayLabel(AUDIT_LANE_PROPOSAL_KIND_LABELS, proposal.kind)}: {proposal.count}件
                </li>
              ))}
            </ul>
          ) : null}
        </>
      );
    case "none":
      return <span className="muted">変更の要約なし</span>;
  }
}

/** The identifiers that tie a record to the existing logs, for an operator tracing one call. */
function Identifiers({ record }: { record: AuditRecordWire }): ReactNode {
  const rows: [string, string | null][] = [
    ["記録ID", record.auditId],
    ["リクエストID", record.correlationId],
    ["委任の参照", record.delegationRef],
    ["依頼キー", record.idempotencyKey],
    ["内容のダイジェスト", record.payloadDigest],
    ["確認用ダイジェスト", record.confirmationDigest],
    ["確認の期限（UTC）", record.confirmExpiresAt],
    ["確認した準備の記録", record.confirmsAuditId],
    ["取り消した記録", record.revertsAuditId],
    ["判断の通し番号", record.diff.kind === "decision" ? record.diff.commitSeq : null],
  ];
  return (
    <details className="inline-disclosure">
      <summary>識別子</summary>
      <dl>
        {rows
          .filter((row): row is [string, string] => row[1] !== null)
          .map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>
                <Code value={value} />
              </dd>
            </div>
          ))}
        {record.refs.length ? (
          <div>
            <dt>参照</dt>
            <dd>
              <ul className="plain-list">
                {record.refs.map((ref) => (
                  <li key={ref}>
                    <Code value={ref} />
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        ) : null}
      </dl>
    </details>
  );
}

function RecordRow({ record }: { record: AuditRecordWire }): ReactNode {
  return (
    <tr>
      <td className="cell-time">{record.recordedAt}</td>
      <td>
        {displayLabel(AUDIT_OPERATION_LABELS, record.operation)}
        <span className="audit-meta">
          <Code value={record.operation} />
        </span>
        <span className="audit-meta">
          {record.riskClass} · {displayLabel(AUDIT_STEP_LABELS, record.step)}
        </span>
      </td>
      <td>
        <Badge tone={RESULT_TONES[record.result] ?? "neutral"}>
          {displayLabel(AUDIT_RESULT_LABELS, record.result)}
        </Badge>
        {record.resultCode === null ? null : (
          <span className="audit-meta">
            <Code value={record.resultCode} />
          </span>
        )}
        {record.reasonCode === null ? null : (
          <span className="audit-meta">
            理由 <Code value={record.reasonCode} />
          </span>
        )}
      </td>
      <td>
        {displayLabel(AUDIT_PRINCIPAL_KIND_LABELS, record.principalKind)}
        <span className="audit-meta">
          <Code value={record.principal} />
        </span>
        <span className="audit-meta">{displayLabel(AUDIT_PATH_LABELS, record.path)}</span>
      </td>
      <td>
        {record.targetRef === null ? (
          <span className="muted">対象なし</span>
        ) : (
          <Code value={record.targetRef} />
        )}
        {record.scope === null ? null : (
          <span className="audit-meta">
            {displayLabel(AUDIT_SCOPE_LABELS, record.scope.namespace)}{" "}
            <Code value={record.scope.source} />
          </span>
        )}
      </td>
      <td>
        <DiffSummary diff={record.diff} />
      </td>
      <td>
        <Identifiers record={record} />
      </td>
    </tr>
  );
}

/** A refusal the page can explain; anything else goes to the shared error state. */
function Refusal({ error, onRestart }: { error: ApiError; onRestart: () => void }): ReactNode {
  if (error.status === 403)
    return (
      <div className="state state-error" role="alert">
        <span className="state-title">監査ログは管理者だけが表示できます</span>
        <p>
          この接続では管理者として確認されていないため、記録を表示しません。管理者のアカウントでログインしているか確認してください。
        </p>
      </div>
    );
  if (error.status === 404)
    return <EmptyState>この接続先は監査ログを提供していません。</EmptyState>;
  if (error.status === 409)
    return (
      <div className="state state-error" role="alert">
        <span className="state-title">続きのページを読めません</span>
        <p>
          ページの続きは、それを読み始めたときの絞り込み条件でしか読めません。最新の記録から読み直してください。
        </p>
        <button className="button" type="button" onClick={onRestart}>
          最新の記録から読み直す
        </button>
      </div>
    );
  return (
    <div className="state state-error" role="alert">
      <span className="state-title">この絞り込み条件では読み込めません</span>
      <p>条件をクリアしてから、もう一度絞り込んでください。</p>
      <button className="button" type="button" onClick={() => go({})}>
        条件をクリア
      </button>
    </div>
  );
}

function Records({ filters }: { filters: AuditFilters }): ReactNode {
  // The cursors that led to each page shown so far; the first page has none.
  const [trail, setTrail] = useState<(string | null)[]>([null]);
  const cursor = trail[trail.length - 1] ?? null;
  const query = useAuditPage(filters, cursor);
  const restart = (): void => setTrail([null]);
  if (
    query.isError &&
    query.error instanceof ApiError &&
    [400, 403, 404, 409].includes(query.error.status)
  )
    return <Refusal error={query.error} onRestart={restart} />;
  return (
    <QueryBoundary query={query} label="監査ログ" coverageNotice={false}>
      {(page) => (
        <Panel
          id="audit-records"
          title="記録"
          count={`${trail.length}ページ目 · このページ${page.records.length}件`}
          note="新しい順です。日時は保存されたUTCの表記のままです。件数はこのページの件数で、記録全体の総数ではありません。"
        >
          {page.records.length === 0 ? (
            <div className="panel-body">
              <EmptyState>
                {trail.length === 1
                  ? "この条件に当てはまる記録はありません。"
                  : "このページに記録はありません。"}
              </EmptyState>
            </div>
          ) : (
            <div className="table-scroll" role="region" aria-label="監査ログの記録" tabIndex={0}>
              <table className="audit-table">
                <caption className="visually-hidden">
                  監査ログ。日時、操作、結果、操作者と経路、対象、変更の要約、識別子。
                </caption>
                <thead>
                  <tr>
                    <th scope="col">日時（UTC）</th>
                    <th scope="col">操作</th>
                    <th scope="col">結果</th>
                    <th scope="col">操作者・経路</th>
                    <th scope="col">対象</th>
                    <th scope="col">変更の要約</th>
                    <th scope="col">識別子</th>
                  </tr>
                </thead>
                <tbody>
                  {page.records.map((record) => (
                    <RecordRow key={record.auditId} record={record} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pagination
            label="監査ログのページ"
            status={page.cursor === null ? "最後のページです" : "続きがあります"}
            previous={{
              label: "前のページ",
              disabled: query.isFetching || trail.length === 1,
              onClick: () => setTrail(trail.slice(0, -1)),
            }}
            next={{
              label: "次のページ",
              disabled: query.isFetching || page.cursor === null,
              onClick: () => {
                if (page.cursor !== null) setTrail([...trail, page.cursor]);
              },
            }}
            actions={
              <button
                className="button"
                type="button"
                disabled={query.isFetching}
                onClick={() => (trail.length === 1 ? void query.refetch() : restart())}
              >
                最新の記録から読み直す
              </button>
            }
          />
        </Panel>
      )}
    </QueryBoundary>
  );
}

export function AuditPage(): ReactNode {
  const search = useLocation().split("?")[1] ?? "";
  const filters = parseAuditFilters(search);
  const key = filters === null ? "invalid" : auditFilterSearch(filters);
  return (
    <section>
      <div className="page-head">
        <h1>監査ログ</h1>
        <p className="lede">
          管理画面、エージェントAPI、MCPからの操作を、だれがどの経路で行い、どうなったかの記録です。拒否や失敗も記録されます。定期実行が受け付けた収集と、処理レーンが書き込んだ判断・確定・提案も、自動処理として記録されます。
        </p>
        <p className="footnote">
          記録は追加のみで、変更・削除されません。記録には金額、取得元の文言、入力内容を含めず、閉じた区分のコードと識別子・件数だけを保存します。処理レーンの実行は、何も書き込まなかった回は記録しません。この画面を開いたことは記録されません。
        </p>
      </div>
      {filters === null ? (
        <Notice tone="bad" role="alert">
          このURLの絞り込み条件は指定できません。{" "}
          <button className="button" type="button" onClick={() => go({})}>
            条件をクリア
          </button>
        </Notice>
      ) : (
        <>
          {/* New filters are a new read: the draft and the cursor trail start again. */}
          <FilterForm key={`filters:${key}`} filters={filters} />
          <Records key={`records:${key}`} filters={filters} />
        </>
      )}
    </section>
  );
}
