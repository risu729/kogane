import { useState, type ReactNode } from "react";
import { useArtifacts, type ArtifactRow } from "../api.ts";
import { Link } from "../router.tsx";
import { Nullable, Panel, QueryBoundary, RawLink } from "../ui.tsx";
import { pageWindow } from "../filters.ts";
import { Pager } from "./ViewControls.tsx";
export function ArtifactsPage(): ReactNode {
  const query = useArtifacts();
  return (
    <>
      <div className="page-head">
        <h1>原本</h1>
        <p className="lede">
          取得時の資料を保存しています。各原本から、解析された記録とその履歴を確認できます。
        </p>
      </div>
      <QueryBoundary
        query={query}
        label="原本"
        isEmpty={(data) => data.artifacts.length === 0}
        empty="保存された原本がまだありません。"
      >
        {(data) => <ArtifactTable rows={data.artifacts} />}
      </QueryBoundary>
    </>
  );
}
function ArtifactTable({ rows }: { rows: ArtifactRow[] }): ReactNode {
  const [page, setPage] = useState(0);
  const view = pageWindow(rows, page);
  return (
    <Panel
      id="artifacts"
      title="保存された原本"
      count={`${rows.length}件`}
      note="解析件数には旧解析の記録も含みます。現行の取引件数とは異なる場合があります。"
    >
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {[
                "原本",
                "取得元",
                "資料の種類",
                "取得日時",
                "解析された記録",
                "原本データ",
              ].map((label) => (
                <th scope="col" key={label}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.rows.map((artifact) => (
              <tr key={artifact.id}>
                <th scope="row">
                  <Link to={`/artifacts/${artifact.id}`}>
                    原本 #{artifact.id}
                  </Link>
                </th>
                <td>{artifact.source_id}</td>
                <td>
                  <Nullable value={artifact.dataset} />
                  <div className="dim">{artifact.mime}</div>
                </td>
                <td>{artifact.fetched_at}</td>
                <td>
                  取引 {artifact.transaction_count} / 残高{" "}
                  {artifact.balance_count}
                  <br />
                  保有 {artifact.position_count} / 評価{" "}
                  {artifact.valuation_count}
                  <div className="dim">解析 {artifact.parse_run_count}回</div>
                </td>
                <td>
                  <RawLink sha256={artifact.sha256}>原本を開く ↗</RawLink>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager {...view} total={rows.length} onChange={setPage} />
      <details className="detail-disclosure">
        <summary>保存と表示の仕組み</summary>
        <p>
          取得URL・SHA-256・解析方法は各原本の詳細で確認できます。原本データは画面に埋め込まず、専用の保護された経路で開きます。現在はAPIから受信した全件を50件ずつ表示しています。
        </p>
      </details>
    </Panel>
  );
}
