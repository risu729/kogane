import { useState, type ReactNode } from "react";
import { useOverview, type Overview } from "../api.ts";
import { Link } from "../router.tsx";
import {
  Badge,
  LineageBadge,
  Nullable,
  Panel,
  QueryBoundary,
  StatusBadge,
  WarningList,
} from "../ui.tsx";
import { pageWindow } from "../filters.ts";
import { Pager } from "./ViewControls.tsx";
import { displayLabel } from "../labels.ts";
const TABLE_LABELS: Record<string, string> = {
  source: "取得元",
  sources: "取得元",
  fetch_run: "収集の実行",
  fetch_runs: "収集の実行",
  fetch_artifact: "取得した原本",
  fetch_artifacts: "取得した原本",
  raw_object: "原本データ",
  raw_objects: "原本データ",
  parse_run: "解析の実行",
  parse_runs: "解析の実行",
  transaction_observations: "取引の保存記録",
  balance_observations: "残高の保存記録",
  position_observations: "保有資産の保存記録",
  valuation_observations: "評価額の保存記録",
};
export function OverviewPage(): ReactNode {
  const query = useOverview();
  return (
    <>
      <div className="page-head">
        <p className="page-eyebrow">あなたの記録を、ひとつの場所に</p>
        <h1>ホーム</h1>
        <p className="lede">取得元と最近の収集状況を確認し、気になる記録の原本までたどれます。</p>
      </div>
      <QueryBoundary query={query} label="ホーム">
        {(data) => <OverviewBody data={data} />}
      </QueryBoundary>
    </>
  );
}
function OverviewBody({ data }: { data: Overview }): ReactNode {
  const [page, setPage] = useState(0);
  const view = pageWindow(
    [...data.fetchRuns].sort((a, b) => b.id - a.id),
    page,
  );
  const artifactCount = data.sources.reduce((count, source) => count + source.artifact_count, 0);
  return (
    <>
      <div className="overview-grid">
        <div className="overview-stat">
          <span className="overview-stat-label">登録されている取得元</span>
          <strong className="overview-stat-value">{data.sources.length}</strong>
          <span>保存された記録の取得元</span>
        </div>
        <div className="overview-stat">
          <span className="overview-stat-label">取得した原本</span>
          <strong className="overview-stat-value">{artifactCount}</strong>
          <Link to="/artifacts">原本を見る →</Link>
        </div>
        <div className="overview-stat">
          <span className="overview-stat-label">収集の記録</span>
          <strong className="overview-stat-value">{data.fetchRuns.length}</strong>
          <span>保存済みの実行履歴</span>
        </div>
      </div>
      <Panel
        id="sources"
        title="取得元"
        count={`${data.sources.length}件`}
        note="保存された原本を、取得元ごとに確認できます。"
      >
        <div className="source-grid">
          {data.sources.length ? (
            data.sources.map((source) => (
              <article className="source-card" key={source.id}>
                <h3>{source.provider}</h3>
                <p className="dim">{source.id}</p>
                <strong>{source.artifact_count}件の原本</strong>
                <details className="detail-disclosure">
                  <summary>取込方法</summary>
                  <Badge>{source.ingestion}</Badge>
                </details>
              </article>
            ))
          ) : (
            <p className="panel-body">取得元がまだ登録されていません。</p>
          )}
        </div>
      </Panel>
      <Panel
        id="fetch-runs"
        title="最近の収集履歴"
        count={`${data.fetchRuns.length}件`}
        note="登録の新しい順に、実行ごとの結果と日時を表示しています。"
      >
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">取得元</th>
                <th scope="col">結果</th>
                <th scope="col">開始日時</th>
                <th scope="col">完了日時</th>
                <th scope="col">実行の詳細</th>
              </tr>
            </thead>
            <tbody>
              {view.rows.length ? (
                view.rows.map((run) => (
                  <tr key={run.id}>
                    <td>{run.source_id}</td>
                    <td>
                      <StatusBadge status={run.status} />
                    </td>
                    <td>{run.started_at}</td>
                    <td>
                      <Nullable value={run.completed_at} placeholder="完了日時未記録" />
                    </td>
                    <td>
                      <details>
                        <summary>実行 #{run.id}</summary>
                        <p>{run.tool}</p>
                        <Nullable value={run.external_run_id} />
                      </details>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={5}>収集の履歴がまだありません。</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <Pager {...view} total={data.fetchRuns.length} onChange={setPage} />
      </Panel>
      <details className="detail-disclosure">
        <summary>保存件数・解析の詳細</summary>
        <Panel
          id="counts"
          title="データベースの保存件数"
          note="旧解析を含む保存行の件数です。画面に表示される現行データの件数とは異なる場合があります。"
        >
          <div className="tiles">
            {data.counts.map((entry) => (
              <div className="tile" key={entry.table}>
                <div className="tile-value">{entry.rows}</div>
                <div className="tile-label">{displayLabel(TABLE_LABELS, entry.table)}</div>
                <code>{entry.table}</code>
              </div>
            ))}
          </div>
        </Panel>
        <ParseHistory data={data} />
      </details>
    </>
  );
}
function ParseHistory({ data }: { data: Overview }): ReactNode {
  const [page, setPage] = useState(0);
  const view = pageWindow(
    [...data.parseRuns].sort((a, b) => b.id - a.id),
    page,
  );
  return (
    <Panel id="parse-runs" title="解析の履歴" count={`${data.parseRuns.length}件`}>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {["原本", "解析方法", "解析日時", "結果", "履歴", "注意・エラー"].map((label) => (
                <th scope="col" key={label}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.rows.map((run) => (
              <tr
                key={run.id}
                className={run.superseded_by_parse_run_id === null ? "" : "is-superseded"}
              >
                <td>
                  <Link to={`/artifacts/${run.fetch_artifact_id}`}>
                    原本 #{run.fetch_artifact_id}
                  </Link>
                </td>
                <td>
                  {run.parser_name}@{run.parser_version}
                </td>
                <td>{run.parsed_at}</td>
                <td>
                  <StatusBadge status={run.status} />
                </td>
                <td>
                  <LineageBadge supersededBy={run.superseded_by_parse_run_id} />
                </td>
                <td>
                  <WarningList warnings={run.warnings} />
                  <Nullable value={run.error} placeholder="エラー未記録" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager {...view} total={data.parseRuns.length} onChange={setPage} />
    </Panel>
  );
}
