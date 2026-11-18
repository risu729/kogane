// `依頼の一覧`: the operator's read-only list of every accepted operations
// request (ADR 0086 and its 2026-11-18 amendment; docs/ops-api.md). One page
// of `GET /api/ops/v1/operations` at a time — newest first, the route's page
// size, filtered by its closed `kind` and `status` only, paged by its cursor
// with no total. Each row links to its 依頼の経過 page. Every value is a closed
// code, an identifier, a count or a stored UTC time; the summary holds no
// request payload and names no principal, so neither is shown. Nothing here
// writes, and each page read is recorded once in the audit log by the server.
import { useState, type FormEvent, type ReactNode } from "react";
import { ApiError } from "../api.ts";
import { AUDIT_ROUTE } from "../audit-api.ts";
import { displayLabel } from "../labels.ts";
import {
  EXECUTION_REASON_LABELS,
  OPERATION_DISPATCH_LABELS,
  OPERATION_KIND_LABELS,
  OPERATION_LIST_FILTER_CHOICES,
  OPERATION_LIST_FILTER_KEYS,
  OPERATION_STATUS_LABELS,
  OPERATIONS_ROUTE,
  operationListSearch,
  operationRoute,
  parseOperationListFilters,
  useOperationList,
  type OperationListFilterKey,
  type OperationListFilters,
  type OperationSummaryWire,
} from "../operations-api.ts";
import { Pagination } from "../pagination.tsx";
import { Link, navigate, useLocation } from "../router.tsx";
import { Badge, EmptyState, Notice, Panel, QueryBoundary, type Tone } from "../ui.tsx";

const SELECTS: Readonly<
  Record<
    OperationListFilterKey,
    { label: string; all: string; labels: Readonly<Record<string, string>> }
  >
> = {
  kind: { label: "依頼の種類", all: "すべての種類", labels: OPERATION_KIND_LABELS },
  status: { label: "状態", all: "すべての状態", labels: OPERATION_STATUS_LABELS },
};

const STATUS_TONES: Readonly<Record<string, Tone>> = {
  completed: "ok",
  waiting_for_human: "warn",
  failed: "bad",
  blocked: "bad",
};

function go(filters: OperationListFilters): void {
  const search = operationListSearch(filters);
  navigate(search ? `${OPERATIONS_ROUTE}?${search}` : OPERATIONS_ROUTE);
}

function Code({ value }: { value: string }): ReactNode {
  return <code className="wrap-any">{value}</code>;
}

function FilterForm({ filters }: { filters: OperationListFilters }): ReactNode {
  // "" is a select's "all" option.
  const [draft, setDraft] = useState<Record<OperationListFilterKey, string>>({
    kind: filters.kind ?? "",
    status: filters.status ?? "",
  });
  function submit(event: FormEvent): void {
    event.preventDefault();
    // The selects offer only closed values, so the chosen ones parse as filters.
    const chosen = new URLSearchParams(Object.entries(draft).filter(([, value]) => value !== ""));
    go(parseOperationListFilters(chosen.toString()) ?? {});
  }
  return (
    <section className="panel" aria-label="依頼の一覧の絞り込み">
      <div className="panel-note">
        絞り込みは保存されたすべての依頼に対して行い、その結果を受付の新しい順に表示します。
      </div>
      <form className="filter-grid" onSubmit={submit}>
        {OPERATION_LIST_FILTER_KEYS.map((key) => (
          <label className="filter-field" key={key}>
            {SELECTS[key].label}
            <select
              aria-label={SELECTS[key].label}
              value={draft[key]}
              onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
            >
              <option value="">{SELECTS[key].all}</option>
              {OPERATION_LIST_FILTER_CHOICES[key].map((value) => (
                <option key={value} value={value}>
                  {displayLabel(SELECTS[key].labels, value)}
                </option>
              ))}
            </select>
          </label>
        ))}
        <button className="button" type="submit">
          条件を適用
        </button>
        {operationListSearch(filters) ? (
          <button className="button" type="button" onClick={() => go({})}>
            条件をクリア
          </button>
        ) : null}
      </form>
    </section>
  );
}

function SummaryRow({ summary }: { summary: OperationSummaryWire }): ReactNode {
  return (
    <tr>
      <td>
        <Code value={summary.acceptedAt} />
      </td>
      <td>
        {displayLabel(OPERATION_KIND_LABELS, summary.kind)} <Code value={summary.kind} />
      </td>
      <td>
        <Badge tone={STATUS_TONES[summary.status] ?? "neutral"}>
          {displayLabel(OPERATION_STATUS_LABELS, summary.status)}
        </Badge>{" "}
        <Code value={summary.status} />
      </td>
      <td>
        {summary.failureCode === null ? (
          <span className="muted">なし</span>
        ) : (
          <>
            {displayLabel(EXECUTION_REASON_LABELS, summary.failureCode)}{" "}
            <Code value={summary.failureCode} />
          </>
        )}
      </td>
      <td>
        {summary.source === null ? (
          <span className="muted">指定なし</span>
        ) : (
          <Code value={summary.source} />
        )}
      </td>
      <td>
        {displayLabel(OPERATION_DISPATCH_LABELS, summary.dispatch.state)}{" "}
        <Code value={summary.dispatch.state} />（{summary.dispatch.attempts}回）
      </td>
      <td>
        <Code value={summary.updatedAt} />
      </td>
      <th scope="row">
        <Link to={operationRoute(summary.operationId)}>
          <Code value={summary.operationId} />
        </Link>
      </th>
    </tr>
  );
}

/** A refusal the page can explain; anything else goes to the shared error state. */
function Refusal({ error, onRestart }: { error: ApiError; onRestart: () => void }): ReactNode {
  if (error.status === 401 || error.status === 403)
    return (
      <div className="state state-error" role="alert">
        <span className="state-title">依頼の一覧は管理者だけが表示できます</span>
        <p>
          この接続では管理者として確認されていないため、依頼を表示しません。管理者のアカウントでログインしているか確認してください。
        </p>
      </div>
    );
  // The cursor names a row of this list, and rows are never deleted, so a 404
  // with that code is a store that changed under the page: start again.
  if (error.status === 404 && error.code === "receipt_not_found")
    return (
      <div className="state state-error" role="alert">
        <span className="state-title">このページの続きを読み込めません</span>
        <p>最新の依頼から読み直してください。</p>
        <button className="button" type="button" onClick={onRestart}>
          最新の依頼から読み直す
        </button>
      </div>
    );
  if (error.status === 404)
    return (
      <EmptyState>
        この接続先は依頼の一覧を提供していません。運用APIを提供していない接続先では、依頼を表示しません。
      </EmptyState>
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

function Summaries({ filters }: { filters: OperationListFilters }): ReactNode {
  // The cursors that led to each page shown so far; the first page has none.
  const [trail, setTrail] = useState<(string | null)[]>([null]);
  const cursor = trail[trail.length - 1] ?? null;
  const query = useOperationList(filters, cursor);
  const restart = (): void => setTrail([null]);
  if (
    query.isError &&
    query.error instanceof ApiError &&
    [400, 401, 403, 404].includes(query.error.status)
  )
    return <Refusal error={query.error} onRestart={restart} />;
  return (
    <QueryBoundary query={query} label="依頼の一覧" coverageNotice={false}>
      {(page) => (
        <Panel
          id="operation-list"
          title="依頼"
          count={`${trail.length}ページ目 · このページ${page.operations.length}件`}
          note="受付の新しい順です。日時は保存されたUTCの表記のままです。件数はこのページの件数で、依頼全体の総数ではありません。"
        >
          {page.operations.length === 0 ? (
            <div className="panel-body">
              <EmptyState>
                {trail.length === 1
                  ? "この条件に当てはまる依頼はありません。"
                  : "このページに依頼はありません。"}
              </EmptyState>
            </div>
          ) : (
            <div className="table-scroll" role="region" aria-label="依頼の一覧の表" tabIndex={0}>
              <table>
                <caption className="visually-hidden">
                  依頼の一覧。受付日時、依頼の種類、状態、待機・停止の理由、取得元、処理への引き渡し、最終更新、依頼ID。
                </caption>
                <thead>
                  <tr>
                    <th scope="col">受付（UTC）</th>
                    <th scope="col">依頼の種類</th>
                    <th scope="col">状態</th>
                    <th scope="col">待機・停止の理由</th>
                    <th scope="col">取得元</th>
                    <th scope="col">処理への引き渡し</th>
                    <th scope="col">最終更新（UTC）</th>
                    <th scope="col">依頼ID（依頼の経過）</th>
                  </tr>
                </thead>
                <tbody>
                  {page.operations.map((summary) => (
                    <SummaryRow key={summary.operationId} summary={summary} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pagination
            label="依頼の一覧のページ"
            status={page.nextCursor === null ? "最後のページです" : "続きがあります"}
            previous={{
              label: "前のページ",
              disabled: query.isFetching || trail.length === 1,
              onClick: () => setTrail(trail.slice(0, -1)),
            }}
            next={{
              label: "次のページ",
              disabled: query.isFetching || page.nextCursor === null,
              onClick: () => {
                if (page.nextCursor !== null) setTrail([...trail, page.nextCursor]);
              },
            }}
            actions={
              <button
                className="button"
                type="button"
                disabled={query.isFetching}
                onClick={() => (trail.length === 1 ? void query.refetch() : restart())}
              >
                最新の依頼から読み直す
              </button>
            }
          />
        </Panel>
      )}
    </QueryBoundary>
  );
}

export function OperationsPage(): ReactNode {
  const search = useLocation().split("?")[1] ?? "";
  const filters = parseOperationListFilters(search);
  const key = filters === null ? "invalid" : operationListSearch(filters);
  return (
    <section>
      <div className="page-head">
        <h1>依頼の一覧</h1>
        <p className="lede">
          運用APIで受け付けた依頼を、受付の新しい順に表示します。管理画面から送った依頼も、MCPのクライアントが送った依頼も含みます。各行から依頼の経過を開けます。この画面から依頼の送信や再実行は行いません。
        </p>
        <p className="footnote">
          状態は保存された状態です。読み取りモデルへの反映は一覧では判定しないため、公開を確認した収集の依頼も、ここでは「進行中」のままのことがあります。反映までの経過は依頼の経過で確認してください。依頼した人は表示しません（
          <Link to={AUDIT_ROUTE}>監査ログ</Link>
          に記録されています）。一覧を読み込むたびに、その読み込みが監査ログに1件記録されます。表示は開いたときの記録で、自動では更新されません。
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
          <Summaries key={`operations:${key}`} filters={filters} />
        </>
      )}
    </section>
  );
}
