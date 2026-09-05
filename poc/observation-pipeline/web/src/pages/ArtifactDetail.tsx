import { useState, type ReactNode } from "react";
import { useArtifact, type ParseRunDetail } from "../api.ts";
import { Link } from "../router.tsx";
import {
  CellValue,
  KindBadge,
  LineageBadge,
  ObservationLink,
  Panel,
  QueryBoundary,
  RawLink,
  StatusBadge,
  WarningList,
} from "../ui.tsx";
import { pageWindow } from "../filters.ts";
import { Pager } from "./ViewControls.tsx";
import { displayLabel } from "../labels.ts";
const LABELS: Record<string, string> = {
  id: "原本番号",
  source_id: "取得元",
  dataset: "資料の種類",
  url: "取得URL（参照用）",
  method: "HTTPメソッド",
  http_status: "HTTP応答",
  mime: "資料形式",
  fetched_at: "取得日時",
  sha256: "SHA-256",
  size: "サイズ（バイト）",
  content_type: "保存形式",
  fetch_run_id: "収集実行番号",
  tool: "収集ツール",
  external_run_id: "外部実行番号",
  fetch_status: "収集結果",
  started_at: "開始日時",
  completed_at: "完了日時",
};
export function ArtifactDetailPage({ id }: { id: number }): ReactNode {
  const query = useArtifact(id);
  return (
    <>
      <div className="page-head">
        <div className="breadcrumb">
          <Link to="/artifacts">原本</Link> / #{id}
        </div>
        <h1>原本 #{id}</h1>
        <p className="lede">
          保存された資料と、この資料から読み取った記録を確認できます。
        </p>
      </div>
      <QueryBoundary query={query} label={`原本 #${id}`}>
        {(data) => (
          <>
            <Panel id="artifact-record" title="取得した資料">
              <div className="panel-body">
                <dl className="kv">
                  <dt>取得元</dt>
                  <dd>{data.artifact.source_id}</dd>
                  <dt>取得日時</dt>
                  <dd>{data.artifact.fetched_at}</dd>
                  <dt>収集結果</dt>
                  <dd>
                    <StatusBadge status={data.artifact.fetch_status} />
                  </dd>
                  <dt>原本データ</dt>
                  <dd>
                    <RawLink sha256={data.artifact.sha256}>
                      保存された原本を開く ↗
                    </RawLink>
                  </dd>
                </dl>
              </div>
            </Panel>
            <details className="detail-disclosure">
              <summary>原本・収集の技術情報</summary>
              <div className="panel-body">
                <dl className="kv">
                  {Object.entries(data.artifact).map(([key, value]) => (
                    <div key={key} className="kv-entry">
                      <dt>{displayLabel(LABELS, key)}</dt>
                      <dd>
                        <CellValue value={value} />
                      </dd>
                    </div>
                  ))}
                </dl>
                <p>
                  URLは取得時の記録として表示しています。原本データは保存時のバイト列で提供され、隔離された表示と形式判定の保護が適用されます。
                </p>
              </div>
            </details>
            <Panel
              id="parse-runs"
              title="この原本の解析履歴"
              count={`${data.parseRuns.length}回`}
              note="置き換えられた旧解析も残しています。各記録から保存された値と原本内の位置を確認できます。"
            >
              <div className="panel-body">
                {data.parseRuns.length ? (
                  data.parseRuns.map((run) => (
                    <ParseRunCard key={run.id} run={run} />
                  ))
                ) : (
                  <p>この原本はまだ解析されていません。</p>
                )}
              </div>
            </Panel>
          </>
        )}
      </QueryBoundary>
    </>
  );
}
function ParseRunCard({ run }: { run: ParseRunDetail }): ReactNode {
  const [page, setPage] = useState(0);
  const view = pageWindow(run.observations, page);
  const old = run.superseded_by_parse_run_id !== null;
  return (
    <section
      className={`chain-card${old ? " is-superseded" : ""}`}
      aria-label={`解析 #${run.id}${old ? "（旧解析）" : ""}`}
    >
      <div className="chain-card-head">
        <h3>解析 #{run.id}</h3>
        <StatusBadge status={run.status} />
        <LineageBadge supersededBy={run.superseded_by_parse_run_id} />
      </div>
      <div className="chain-body">
        <p>{run.parsed_at}</p>
        <details>
          <summary>解析方法・バージョン</summary>
          <code>
            {run.parser_name}@{run.parser_version}
          </code>
        </details>
        {run.error === null ? null : (
          <p className="state state-error">{run.error}</p>
        )}
        <WarningList warnings={run.warnings} />
        <h4>読み取った記録（{run.observations.length}件）</h4>
        {view.rows.length ? (
          <ul className="obs-list">
            {view.rows.map((observation) => (
              <li key={`${observation.kind}:${observation.id}`}>
                <KindBadge kind={observation.kind} />
                <ObservationLink kind={observation.kind} id={observation.id} />
                <span className="obs-summary">{observation.summary}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p>
            この解析から作成された記録はありません。収集範囲の完全性や残高ゼロを示すものではありません。
          </p>
        )}
        <Pager {...view} total={run.observations.length} onChange={setPage} />
        {old ? (
          <p className="footnote">
            同じ原本の解析 #{run.superseded_by_parse_run_id}
            に置き換えられた記録です。現行の値として扱わず、変更履歴の確認にお使いください。
          </p>
        ) : null}
      </div>
    </section>
  );
}
