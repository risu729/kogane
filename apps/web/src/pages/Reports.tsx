// 評価レポート: the fixed report artifacts the Processor's report job stored
// (docs/calculation-and-reports.md §4). Read only. A stored report is shown
// exactly as it was fixed: the page never recomputes a value, never adds the
// rows itself, and offers no recompute or share button, because those are
// commands no route serves.
import type { ReactNode } from "react";
import { ApiError, useFeatures } from "../api.ts";
import { Pagination } from "../pagination.tsx";
import {
  REPORTS_PAGE_SIZE,
  reportExportUrl,
  useReport,
  useReportExplanation,
  useReports,
  type ReportBody,
  type ReportDetail,
  type ReportEventRow,
  type ReportExplanation,
  type ReportListItem,
  type ReportSummary,
} from "../reports-api.ts";
import {
  ClaimRef,
  EVENT_LABELS,
  metricLabel,
  PartitionBadge,
  PURPOSE_LABELS,
  ReplayabilityBadge,
  ReportAmount,
  RUN_STATUS_LABELS,
  UNVALUED_LABELS,
} from "../report-display.tsx";
import { Link } from "../router.tsx";
import {
  Badge,
  EmptyState,
  Kv,
  KvRow,
  Loading,
  Notice,
  Nullable,
  ObservationLink,
  Panel,
  QueryBoundary,
  Sha,
} from "../ui.tsx";
import { useViewState } from "../view-state.tsx";

/** The server's closed refusals for a stored body it will not serve as this report. */
const STORED_BODY_REFUSALS: Record<string, string> = {
  report_digest_mismatch:
    "保存された内容が、作成時に記録したダイジェストと一致しません。このレポートとして表示せず、作り直すこともしません。",
  report_body_invalid:
    "保存された内容が、レポートの形式として読み取れません。このレポートとして表示せず、作り直すこともしません。",
  report_body_too_large: "保存された内容が表示できる大きさを超えています。",
};

function UnavailableNotice(): ReactNode {
  return <EmptyState>この接続先は評価レポートを提供していません。</EmptyState>;
}

function ReportListRow({ item }: { item: ReportListItem }): ReactNode {
  return (
    <tr>
      <td className="cell-time">{item.createdAt}</td>
      <td>{PURPOSE_LABELS[item.purpose]}</td>
      <td>
        <code className="wrap-any">{item.reportId}</code>
      </td>
      <td>
        <Sha value={item.contentDigest} />
      </td>
      <td>{item.createdBy}</td>
      <td>
        <Link to={`/reports/${encodeURIComponent(item.reportId)}`}>内容を見る</Link>
      </td>
    </tr>
  );
}

export function ReportsPage(): ReactNode {
  const features = useFeatures();
  const [offset, setOffset] = useViewState("reports.offset");
  const query = useReports(offset);
  if (!features.known) return <Loading label="評価レポート" />;
  return (
    <>
      <div className="page-head">
        <h1>評価レポート</h1>
        <p className="lede">
          保有資産の記録から作成し、作成時の内容のまま保存したレポートです。表示するときに計算し直すことはありません。
        </p>
        <p className="footnote">
          評価するのは、同じ取得結果に価格がある保有資産だけです。評価できなかった保有資産は理由とともに残し、0
          円として扱いません。レポートは資産全体の合計ではありません。
        </p>
      </div>
      {!features.reportArtifacts ? (
        <UnavailableNotice />
      ) : (
        <QueryBoundary query={query} label="評価レポート">
          {(data) => (
            <Panel id="report-list" title="保存されたレポート">
              {data.items.length === 0 ? (
                <div className="panel-body">
                  <EmptyState>
                    <p>
                      {offset === 0
                        ? "保存された評価レポートはありません。"
                        : "このページに表示するレポートはありません。"}
                    </p>
                  </EmptyState>
                </div>
              ) : (
                <div
                  className="table-scroll"
                  role="region"
                  aria-label="評価レポートの一覧"
                  tabIndex={0}
                >
                  <table className="report-table">
                    <caption>
                      作成日時の新しい順です。入力が変わったときだけ新しいレポートが保存されます。
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">作成日時</th>
                        <th scope="col">種類</th>
                        <th scope="col">レポート</th>
                        <th scope="col">内容のダイジェスト</th>
                        <th scope="col">作成者</th>
                        <th scope="col">
                          <span className="visually-hidden">内容</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.items.map((item) => (
                        <ReportListRow key={item.reportId} item={item} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {data.items.length === 0 && offset === 0 ? null : (
                <Pagination
                  label="評価レポートのページ"
                  status={
                    data.items.length === 0
                      ? "このページに表示なし"
                      : `${offset + 1}–${offset + data.items.length}件目`
                  }
                  previous={{
                    label: `前の${REPORTS_PAGE_SIZE}件`,
                    disabled: offset === 0,
                    onClick: () => setOffset(Math.max(0, offset - REPORTS_PAGE_SIZE)),
                  }}
                  next={{
                    label: `次の${REPORTS_PAGE_SIZE}件`,
                    disabled: data.nextCursor === null,
                    onClick: () => {
                      if (data.nextCursor !== null) setOffset(Number(data.nextCursor));
                    },
                  }}
                />
              )}
            </Panel>
          )}
        </QueryBoundary>
      )}
    </>
  );
}

/** The figure a body states, with what it covers. A partial subtotal is named as one. */
function ReportFigures({ body }: { body: ReportBody }): ReactNode {
  const valued = body.rows.filter((row) => row.valued).length;
  const unvalued = body.rows.length - valued;
  const subtotalLabel =
    body.partition === "complete" ? "評価額の合計" : "評価できた保有資産だけの小計";
  return (
    <div className="tiles report-figures">
      <div className="tile tile-wide">
        <div className="tile-value">
          {body.subtotal === null ? (
            <Nullable value={null} placeholder="小計なし" />
          ) : (
            <ReportAmount value={body.subtotal} unit={body.unitRef} />
          )}
        </div>
        <div className="tile-label">
          {body.subtotal === null ? "評価できた保有資産がないため小計はありません" : subtotalLabel}
        </div>
      </div>
      <div className="tile">
        <div className="tile-value">{valued}件</div>
        <div className="tile-label">評価できた保有資産</div>
      </div>
      <div className="tile">
        <div className="tile-value">{unvalued}件</div>
        <div className="tile-label">評価できなかった保有資産</div>
      </div>
    </div>
  );
}

function ReportRows({ body }: { body: ReportBody }): ReactNode {
  if (body.rows.length === 0)
    return (
      <div className="panel-body">
        <EmptyState>このレポートに保有資産の行はありません。</EmptyState>
      </div>
    );
  return (
    <div className="table-scroll" role="region" aria-label="保有資産ごとの評価" tabIndex={0}>
      <table className="report-table">
        <caption>
          保存された順です。評価できなかった行は理由を表示し、合計に含めていません。
        </caption>
        <thead>
          <tr>
            <th scope="col">銘柄</th>
            <th scope="col">口座</th>
            <th scope="col">指標</th>
            <th scope="col" className="num">
              評価額
            </th>
          </tr>
        </thead>
        <tbody>
          {body.rows.map((row, index) => (
            <tr key={`${row.subjectRef}|${row.scopeRef}|${row.metric}|${String(index)}`}>
              <td>
                <code className="wrap-any">{row.subjectRef}</code>
              </td>
              <td>
                <code className="wrap-any">{row.scopeRef}</code>
              </td>
              <td>{metricLabel(row.metric)}</td>
              <td className="num">
                {row.valued ? (
                  <ReportAmount value={row.value} unit={row.unitRef} />
                ) : (
                  <span>
                    <Badge tone="warn">未評価</Badge> {UNVALUED_LABELS[row.unvaluedReason]}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReportEvents({ events }: { events: ReportEventRow[] }): ReactNode {
  if (events.length === 0) return <p>記録された出来事はありません。</p>;
  return (
    <ol className="plain-list" aria-label="レポートの記録">
      {events.map((event, index) => (
        <li key={`${event.occurred_at}|${event.kind}|${String(index)}`}>
          <time className="cell-time">{event.occurred_at}</time> · {EVENT_LABELS[event.kind]} ·{" "}
          {event.actor}
          {event.related_report_id === null ? null : (
            <>
              {" "}
              · 関連するレポート:{" "}
              <Link to={`/reports/${encodeURIComponent(event.related_report_id)}`}>
                <code className="wrap-any">{event.related_report_id}</code>
              </Link>
            </>
          )}
        </li>
      ))}
    </ol>
  );
}

function ReportFacts({
  report,
  detail,
}: {
  report: ReportSummary;
  detail: ReportDetail;
}): ReactNode {
  const run = report.calculationRun;
  return (
    <Kv>
      <KvRow label="レポート">
        <code className="wrap-any">{report.reportId}</code>
      </KvRow>
      <KvRow label="種類">{PURPOSE_LABELS[report.purpose]}</KvRow>
      <KvRow label="作成日時">{report.createdAt}</KvRow>
      <KvRow label="作成者">{report.createdBy}</KvRow>
      <KvRow label="再計算の可否">
        <ReplayabilityBadge replayability={report.replayability} />
      </KvRow>
      <KvRow label="内容のダイジェスト">
        <span className="wrap-any">
          <Sha value={report.contentDigest} full />
        </span>
      </KvRow>
      <KvRow label="計算の文脈">
        <code className="wrap-any">{report.contextId}</code>
      </KvRow>
      <KvRow label="計算の実行">
        {run === null ? (
          <Nullable value={null} placeholder="記録なし（入力を特定できないため再計算できません）" />
        ) : (
          <>
            <code className="wrap-any">{run.runId}</code> ·{" "}
            {RUN_STATUS_LABELS[run.status] ?? run.status} · 開始 {run.startedAt}
            {run.completedAt === null ? null : <> · 完了 {run.completedAt}</>}
          </>
        )}
      </KvRow>
      <KvRow label="表示の解釈">
        数値の正規化 <code>{detail.interpretationContext.decimalPolicyRelease}</code>
        （保存時の内容をそのまま表示）
      </KvRow>
    </Kv>
  );
}

/**
 * The export download, offered only when the report's capabilities allow it:
 * the server refuses `/export` for a restricted or unavailable report, and the
 * page does not link to a refusal.
 */
function ReportExport({ report }: { report: ReportSummary }): ReactNode {
  if (!report.capabilities.export)
    return (
      <p className="dim">
        {report.replayability === "restricted"
          ? "根拠にした記録の利用が制限されたため、書き出しはできません。"
          : "保存内容を読み出せないため、書き出しはできません。"}
      </p>
    );
  return (
    <>
      <p>
        <a
          className="button"
          href={reportExportUrl(report.reportId)}
          download={`${report.reportId}.json`}
        >
          保存内容を書き出す（JSON）
        </a>
      </p>
      <p className="dim">保存されたときの内容をそのまま書き出します。計算し直しません。</p>
    </>
  );
}

function ExplanationContent({ data }: { data: ReportExplanation }): ReactNode {
  const node = data.explanation;
  const manifest = node.inputManifest;
  return (
    <div className="panel-body">
      <Kv>
        <KvRow label="対象範囲">
          <code className="wrap-any">{manifest.perimeterRef}</code>
        </KvRow>
        <KvRow label="基準の単位">{manifest.unitRef}</KvRow>
        <KvRow label="含めた記録の最終記録時刻">
          {manifest.knowledgeCutoffEffective === "none" ? (
            <Nullable value={null} placeholder="含めた記録なし" />
          ) : (
            manifest.knowledgeCutoffEffective
          )}
        </KvRow>
        <KvRow label="数値の正規化">
          <code>{manifest.decimalPolicyRelease}</code>
        </KvRow>
        <KvRow label="評価方法の方針">
          <code className="wrap-any">{manifest.instrumentValuationPolicyId}</code>
        </KvRow>
        <KvRow label="方針の一覧">
          <ul className="plain-list">
            {node.policyRefs.map((ref) => (
              <li key={ref}>
                <code className="wrap-any">{ref}</code>
              </li>
            ))}
          </ul>
        </KvRow>
      </Kv>
      <details className="detail-disclosure">
        <summary>入力にした保有資産の記録（{manifest.positionObservationIds.length}件）</summary>
        <ObservationIds kind="position" ids={manifest.positionObservationIds} />
      </details>
      <details className="detail-disclosure">
        <summary>入力にした評価額の記録（{manifest.valuationObservationIds.length}件）</summary>
        <ObservationIds kind="valuation" ids={manifest.valuationObservationIds} />
      </details>
      <details className="detail-disclosure">
        <summary>使った価格（{node.prices.length}件）</summary>
        {node.prices.length === 0 ? (
          <p>価格は使っていません。</p>
        ) : (
          <ul className="plain-list" aria-label="使った価格">
            {node.prices.map((price) => (
              <li key={price.id}>
                <code className="wrap-any">{price.baseInstrumentRef}</code> · {price.quoteUnitRef}{" "}
                建て · {price.priceKind}
                <br />
                根拠: <ClaimRef value={price.sourceClaimRef} />
              </li>
            ))}
          </ul>
        )}
      </details>
      <p className="footnote">説明には参照だけを保存しています。金額は上の保存内容が正です。</p>
    </div>
  );
}

function ObservationIds({
  kind,
  ids,
}: {
  kind: "position" | "valuation";
  ids: number[];
}): ReactNode {
  if (ids.length === 0) return <p>記録はありません。</p>;
  return (
    <ul className="report-ref-list">
      {ids.map((id) => (
        <li key={id}>
          <ObservationLink kind={kind} id={id} />
        </li>
      ))}
    </ul>
  );
}

function ReportExplanationPanel({ report }: { report: ReportSummary }): ReactNode {
  const query = useReportExplanation(report.reportId, report.capabilities.explain);
  return (
    <Panel
      id="report-explanation"
      title="根拠の説明"
      note="このレポートを作成したときの入力の一覧です。"
    >
      {!report.capabilities.explain ? (
        <div className="panel-body">
          <Notice tone="bad" inline role="note">
            {report.replayability === "restricted"
              ? "根拠にした記録の利用が制限されたため、説明は表示しません。保存された内容はそのまま残っています。"
              : "保存内容を読み出せないため、説明は表示しません。"}
          </Notice>
        </div>
      ) : query.error instanceof ApiError && query.error.status === 404 ? (
        // The node is a cache: its absence is said, never rebuilt.
        <div className="panel-body">
          <EmptyState>このレポートの説明は保存されていません。</EmptyState>
        </div>
      ) : (
        <QueryBoundary query={query} label="根拠の説明">
          {(data) => <ExplanationContent data={data} />}
        </QueryBoundary>
      )}
    </Panel>
  );
}

function ReportContent({ detail }: { detail: ReportDetail }): ReactNode {
  const { report } = detail;
  return (
    <>
      {detail.body === null ? (
        <Notice tone="bad" role="alert">
          保存されたレポートの内容を読み出せません。別の内容で作り直すことはしません。
        </Notice>
      ) : (
        <Panel
          id="report-body"
          title={`${PURPOSE_LABELS[detail.body.purpose]}（${detail.body.unitRef}）`}
          count={<PartitionBadge partition={detail.body.partition} />}
          note={
            detail.body.partition === "complete"
              ? "すべての保有資産を評価できたレポートです。対象は取得済みの保有資産だけで、資産全体の合計ではありません。"
              : "評価できなかった保有資産があります。小計はそれを含まないため、資産全体の合計でも、その下限でもありません。"
          }
        >
          <ReportFigures body={detail.body} />
          {detail.body.coverage.truncated ? (
            <div className="panel-body">
              <Notice tone="warn" inline role="note">
                保有資産が上限で打ち切られています。上限を超えた保有資産はこのレポートに含まれていません。
              </Notice>
            </div>
          ) : null}
          <ReportRows body={detail.body} />
        </Panel>
      )}
      <Panel id="report-facts" title="レポートの記録">
        <div className="panel-body">
          <ReportFacts report={report} detail={detail} />
          <ReportExport report={report} />
          {"events" in detail ? (
            <>
              <h3>出来事</h3>
              <ReportEvents events={detail.events} />
            </>
          ) : null}
          <p className="footnote">
            保存されたレポートは変更しません。規則や価格が変わったときは新しいレポートとして保存します。再計算や訂正版の共有はこの画面からは行いません。
          </p>
        </div>
      </Panel>
      <ReportExplanationPanel report={report} />
    </>
  );
}

export function ReportPage({ reportId }: { reportId: string }): ReactNode {
  const features = useFeatures();
  const query = useReport(reportId);
  if (!features.known) return <Loading label="評価レポートの内容" />;
  return (
    <>
      <div className="page-head">
        <div className="breadcrumb">
          <Link to="/reports">評価レポートの一覧に戻る</Link>
        </div>
        <h1>評価レポートの内容</h1>
        <p className="lede">保存されたときの内容をそのまま表示します。計算し直していません。</p>
      </div>
      {!features.reportArtifacts ? (
        <UnavailableNotice />
      ) : query.error instanceof ApiError &&
        query.error.code !== null &&
        Object.hasOwn(STORED_BODY_REFUSALS, query.error.code) ? (
        // The server refused to serve bytes that are not the bytes the report
        // was fixed with; retrying would be refused again.
        <Notice tone="bad" role="alert">
          {STORED_BODY_REFUSALS[query.error.code]}
        </Notice>
      ) : (
        <QueryBoundary query={query} label="評価レポートの内容">
          {(detail) => <ReportContent detail={detail} />}
        </QueryBoundary>
      )}
    </>
  );
}
