// `依頼の経過`: the operator's read-only view of one accepted operations
// request (docs/ops-api.md, ADR 0048). It shows what `GET /api/ops/v1/
// operations/{id}` returns — the stored status, the stages the kind can reach,
// and for a collection or session refresh the collector execution and each run
// it reported, followed to its 取得記録, parsing and publication or a closed
// reason. Every value is a closed code, an identifier, a count or a stored UTC
// time. The page sends no request of its own and re-reads only when asked.
import type { ReactNode } from "react";
import { ApiError } from "../api.ts";
import { AUDIT_ROUTE } from "../audit-api.ts";
import { displayLabel } from "../labels.ts";
import {
  EVIDENCE_RUN_ID,
  EXECUTION_REASON_LABELS,
  EXECUTION_STATE_LABELS,
  OPERATION_DISPATCH_LABELS,
  OPERATION_KIND_LABELS,
  OPERATION_STAGE_LABELS,
  OPERATION_STAGE_STATE_LABELS,
  OPERATION_STATUS_LABELS,
  PROVIDER_OUTCOME_LABELS,
  RUN_STATE_LABELS,
  useOperation,
  type OperationRecordExecutionWire,
  type OperationRecordRunWire,
  type OperationRecordWire,
} from "../operations-api.ts";
import { Link } from "../router.tsx";
import { Badge, EmptyState, Kv, KvRow, Notice, Panel, QueryBoundary, type Tone } from "../ui.tsx";

const STATUS_TONES: Readonly<Record<string, Tone>> = {
  completed: "ok",
  running: "neutral",
  accepted: "neutral",
  waiting_for_human: "warn",
  failed: "bad",
  blocked: "bad",
};
const STAGE_TONES: Readonly<Record<string, Tone>> = {
  completed: "ok",
  retryable: "warn",
  blocked: "bad",
};
const EXECUTION_TONES: Readonly<Record<string, Tone>> = {
  published: "ok",
  refreshed: "ok",
  waiting: "warn",
  waiting_for_human: "warn",
  unpublished: "bad",
  failed: "bad",
  uncertain: "bad",
  expired: "bad",
  unsupported: "bad",
};
const RUN_TONES: Readonly<Record<string, Tone>> = {
  published: "ok",
  blocked: "bad",
  unpublished: "bad",
};

function Code({ value }: { value: string }): ReactNode {
  return <code className="wrap-any">{value}</code>;
}

/** A closed code by its Japanese name, with the code itself beside it. */
function Coded({
  labels,
  value,
  tone,
}: {
  labels: Readonly<Record<string, string>>;
  value: string;
  tone?: Tone | undefined;
}): ReactNode {
  return (
    <>
      <Badge tone={tone ?? "neutral"}>{displayLabel(labels, value)}</Badge> <Code value={value} />
    </>
  );
}

function Reason({ value }: { value: string | null }): ReactNode {
  if (value === null) return <span className="muted">なし</span>;
  return (
    <>
      {displayLabel(EXECUTION_REASON_LABELS, value)} <Code value={value} />
    </>
  );
}

function Time({ value }: { value: string | null }): ReactNode {
  return value === null ? <span className="muted">未到達</span> : <Code value={value} />;
}

/** A fetch run the evidence browser opens; anything else stays an identifier. */
function EvidenceRef({ value }: { value: string | null }): ReactNode {
  if (value === null) return <span className="muted">なし</span>;
  return EVIDENCE_RUN_ID.test(value) ? (
    <Link to={`/runs/${value}`}>取得記録 {value}</Link>
  ) : (
    <Code value={value} />
  );
}

function Summary({ record }: { record: OperationRecordWire }): ReactNode {
  return (
    <Panel id="operation-summary" title="依頼">
      <div className="panel-body">
        <Kv>
          <KvRow label="依頼の種類">
            {displayLabel(OPERATION_KIND_LABELS, record.kind)} <Code value={record.kind} />
          </KvRow>
          <KvRow label="状態">
            <Coded
              labels={OPERATION_STATUS_LABELS}
              value={record.status}
              tone={STATUS_TONES[record.status]}
            />
          </KvRow>
          <KvRow label="停止の理由">
            <Reason value={record.failureCode} />
          </KvRow>
          <KvRow label="取得元">
            {record.source === null ? (
              <span className="muted">指定なし</span>
            ) : (
              <Code value={record.source} />
            )}
          </KvRow>
          <KvRow label="処理への引き渡し">
            {displayLabel(OPERATION_DISPATCH_LABELS, record.dispatch.state)}{" "}
            <Code value={record.dispatch.state} />（{record.dispatch.attempts}回）
          </KvRow>
          <KvRow label="結び付いた対象">
            {record.targetRef === null ? (
              <span className="muted">まだありません</span>
            ) : (
              <Code value={record.targetRef} />
            )}
          </KvRow>
          <KvRow label="受付（UTC）">
            <Code value={record.acceptedAt} />
          </KvRow>
          <KvRow label="最終更新（UTC）">
            <Code value={record.updatedAt} />
          </KvRow>
          <KvRow label="依頼ID">
            <Code value={record.operationId} />
          </KvRow>
        </Kv>
      </div>
    </Panel>
  );
}

function Stages({ record }: { record: OperationRecordWire }): ReactNode {
  return (
    <Panel
      id="operation-stages"
      title="段階"
      count={`${record.stages.length}段階`}
      note="報告されていない段階は「未到達」です。完了は、その段階の記録が保存されたときだけ表示されます。"
    >
      {record.stages.length === 0 ? (
        <div className="panel-body">
          <EmptyState>
            この種類の依頼には段階がありません。進み具合は状態と下の実行の記録で確認します。
          </EmptyState>
        </div>
      ) : (
        <div className="table-scroll" role="region" aria-label="依頼の段階" tabIndex={0}>
          <table>
            <caption className="visually-hidden">
              依頼の段階。段階、状態、根拠、理由、試行回数、更新日時。
            </caption>
            <thead>
              <tr>
                <th scope="col">段階</th>
                <th scope="col">状態</th>
                <th scope="col">根拠</th>
                <th scope="col">理由</th>
                <th scope="col">試行</th>
                <th scope="col">更新（UTC）</th>
              </tr>
            </thead>
            <tbody>
              {record.stages.map((stage) => (
                <tr key={stage.stage}>
                  <th scope="row">
                    {displayLabel(OPERATION_STAGE_LABELS, stage.stage)} <Code value={stage.stage} />
                  </th>
                  <td>
                    <Badge tone={STAGE_TONES[stage.state] ?? "neutral"}>
                      {displayLabel(OPERATION_STAGE_STATE_LABELS, stage.state)}
                    </Badge>
                  </td>
                  <td>
                    <EvidenceRef value={stage.evidenceRef} />
                  </td>
                  <td>
                    <Reason value={stage.failureCode} />
                  </td>
                  <td className="num">{stage.attempts}</td>
                  <td>
                    <Time value={stage.updatedAt} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function Run({ run }: { run: OperationRecordRunWire }): ReactNode {
  const artifacts = run.artifacts;
  return (
    <tr>
      <th scope="row">
        <Code value={run.runId} />
      </th>
      <td>
        <Badge tone={RUN_TONES[run.state] ?? "neutral"}>
          {displayLabel(RUN_STATE_LABELS, run.state)}
        </Badge>
        {run.reasonCode === null ? null : (
          <span className="audit-meta">
            <Reason value={run.reasonCode} />
          </span>
        )}
        {run.blockedCode === null ? null : (
          <span className="audit-meta">
            登録の拒否 <Code value={run.blockedCode} />
          </span>
        )}
      </td>
      <td>
        {run.providerOutcome === null ? (
          <span className="muted">未確認</span>
        ) : (
          displayLabel(PROVIDER_OUTCOME_LABELS, run.providerOutcome)
        )}
      </td>
      <td>
        <EvidenceRef value={run.evidenceRunId} />
        {run.registeredAt === null ? null : (
          <span className="audit-meta">
            登録 <Code value={run.registeredAt} />
          </span>
        )}
      </td>
      <td>
        {artifacts === null ? (
          <span className="muted">登録前のため未集計</span>
        ) : (
          <ul className="plain-list">
            <li>ファイル {artifacts.total}件</li>
            <li>解析対象 {artifacts.parseSelected}件</li>
            <li>公開 {artifacts.published}件</li>
            <li>解析待ち・解析中 {artifacts.pending}件</li>
            <li>
              公開されず {artifacts.notPublished}件（うち解析失敗 {artifacts.parseFailed}件）
            </li>
          </ul>
        )}
      </td>
    </tr>
  );
}

function Execution({ execution }: { execution: OperationRecordExecutionWire }): ReactNode {
  return (
    <Panel
      id="operation-execution"
      title={execution.action === "collect" ? "収集の実行" : "セッション更新の実行"}
    >
      {execution.scope === "collector_default" ? (
        <Notice tone="warn" role="note">
          依頼で指定した期間は保存されるだけで、収集には使われません。収集は接続先の定期実行と同じ既定の範囲で行われます。
        </Notice>
      ) : null}
      <div className="panel-body">
        <Kv>
          <KvRow label="実行の状態">
            <Coded
              labels={EXECUTION_STATE_LABELS}
              value={execution.state}
              tone={EXECUTION_TONES[execution.state]}
            />
          </KvRow>
          <KvRow label="理由">
            <Reason value={execution.reasonCode} />
          </KvRow>
          <KvRow label="接続">
            {execution.connectionId === null ? (
              <span className="muted">まだ結び付いていません</span>
            ) : (
              <Code value={execution.connectionId} />
            )}
          </KvRow>
          <KvRow label="開始を待った回数">{execution.waits}回</KvRow>
          <KvRow label="開始の期限（UTC）">
            {execution.expiresAt === null ? (
              <span className="muted">期限なし（本人の操作を待つ依頼）</span>
            ) : (
              <Code value={execution.expiresAt} />
            )}
          </KvRow>
          <KvRow label="開始（UTC）">
            <Time value={execution.startedAt} />
          </KvRow>
          <KvRow label="収集の報告（UTC）">
            <Time value={execution.collectedAt} />
          </KvRow>
          <KvRow label="公開の確認（UTC）">
            <Time value={execution.publishedAt} />
          </KvRow>
          <KvRow label="終了（UTC）">
            <Time value={execution.finishedAt} />
          </KvRow>
        </Kv>
      </div>
    </Panel>
  );
}

function Runs({ execution }: { execution: OperationRecordExecutionWire }): ReactNode {
  return (
    <Panel
      id="operation-runs"
      title="報告された収集実行"
      count={`${execution.runs.length}件`}
      note="収集処理が報告した実行ごとに、取得記録への登録、解析、公開までの記録をたどります。件数は数で、金額や内容は表示しません。"
    >
      {execution.runs.length === 0 ? (
        <div className="panel-body">
          <EmptyState>
            {execution.collectedAt === null
              ? "収集処理はまだ実行記録を報告していません。"
              : "収集処理は実行記録を報告していません。"}
          </EmptyState>
        </div>
      ) : (
        <div className="table-scroll" role="region" aria-label="報告された収集実行" tabIndex={0}>
          <table>
            <caption className="visually-hidden">
              報告された収集実行。実行ID、状態と理由、取得元の結果、取得記録、ファイルの件数。
            </caption>
            <thead>
              <tr>
                <th scope="col">実行ID</th>
                <th scope="col">状態</th>
                <th scope="col">取得元の結果</th>
                <th scope="col">取得記録</th>
                <th scope="col">ファイル</th>
              </tr>
            </thead>
            <tbody>
              {execution.runs.map((run) => (
                <Run key={run.runId} run={run} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/** A refusal the page can explain; anything else goes to the shared error state. */
function Refusal({ error }: { error: ApiError }): ReactNode {
  if (error.status === 401 || error.status === 403)
    return (
      <div className="state state-error" role="alert">
        <span className="state-title">依頼の経過は管理者だけが表示できます</span>
        <p>
          この接続では管理者として確認されていないため、依頼を表示しません。管理者のアカウントでログインしているか確認してください。
        </p>
      </div>
    );
  return (
    <EmptyState>
      この依頼は見つかりません。別の操作者が受け付けた依頼や、運用APIを提供していない接続先でも、同じ表示になります。
    </EmptyState>
  );
}

export function OperationPage({ operationId }: { operationId: string }): ReactNode {
  const query = useOperation(operationId);
  const refusal =
    query.isError && query.error instanceof ApiError && [401, 403, 404].includes(query.error.status)
      ? query.error
      : null;
  return (
    <section>
      <div className="page-head">
        <div className="breadcrumb">
          <Link to={AUDIT_ROUTE}>監査ログ</Link> / 依頼の経過
        </div>
        <h1>依頼の経過</h1>
        <p className="lede">
          運用APIで受け付けた依頼が、収集、取得記録への登録、解析、公開のどこまで進んだかを、保存された記録から表示します。この画面から依頼の送信や再実行は行いません。
        </p>
        <p className="footnote">
          受付は実行の完了を意味しません。読み取りモデルへの反映は追跡していないため、公開を確認した収集の依頼も「進行中」のままです。日時は保存されたUTCの表記のままです。表示は開いたときの記録で、自動では更新されません。
        </p>
      </div>
      {refusal !== null ? (
        <Refusal error={refusal} />
      ) : (
        <QueryBoundary query={query} label="依頼の経過" coverageNotice={false}>
          {(record) => (
            <>
              <Summary record={record} />
              <Stages record={record} />
              {record.execution === null ? null : (
                <>
                  <Execution execution={record.execution} />
                  <Runs execution={record.execution} />
                </>
              )}
              <div className="panel-body">
                <button
                  className="button"
                  type="button"
                  disabled={query.isFetching}
                  onClick={() => void query.refetch()}
                >
                  最新の状態を読み直す
                </button>
              </div>
            </>
          )}
        </QueryBoundary>
      )}
    </section>
  );
}
