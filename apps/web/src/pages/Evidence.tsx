import { useState, type ReactNode } from "react";
import type {
  EvidenceArtifact,
  EvidenceArtifactId,
  EvidencePayloadFidelity,
  EvidenceRole,
  EvidenceRun,
  EvidenceRunId,
  EvidenceSource,
} from "../../../shared/evidence-contract.ts";
import {
  evidenceRawUrl,
  useEvidenceArtifact,
  useEvidenceArtifacts,
  useEvidenceRuns,
} from "../evidence-api.ts";
import {
  EvidenceBoundary,
  EvidencePager,
  Outcome,
  RecordedTime,
  useCursorPage,
} from "../evidence-ui.tsx";
import { Link } from "../router.tsx";
import { Badge, EmptyState, KvRow, Nullable, Panel, Sha } from "../ui.tsx";
import { EvidencePreview } from "../EvidencePreview.tsx";

const ROLES: Record<EvidenceRole, string> = {
  provider_response: "取得元の応答",
  provider_export: "取得元のエクスポート",
  provider_document: "取得元の文書",
  provider_message: "取得元の通知",
  collector_manifest: "収集内容の一覧",
  collector_error: "収集エラーの記録",
  collector_summary: "収集結果の要約",
  collector_derived: "収集時の加工データ",
  sanitized_provider_capture: "機密情報を除いた取得記録",
  user_capture: "手動の取得記録",
};
const FIDELITY: Record<EvidencePayloadFidelity, string> = {
  exact: "取得時のバイト列を保存",
  transport_decoded: "通信形式を展開",
  transformed: "加工済み",
  generated: "生成された記録",
  unknown: "保存形式の関係は不明",
};

function RunSummary({ run, sources }: { run: EvidenceRun; sources: EvidenceSource[] }): ReactNode {
  return (
    <Panel title="この収集記録" id="run-summary">
      <div className="panel-body">
        <dl className="kv">
          <KvRow label="保存状態">
            <Badge>保存済み</Badge>
          </KvRow>
          <KvRow label="収集結果">
            <Outcome value={run.outcome} />
          </KvRow>
          <KvRow label="取得元">
            {sources.find((source) => source.id === run.sourceId)?.label ?? run.sourceId}
          </KvRow>
          <KvRow label="収集開始の記録">
            <RecordedTime value={run.startedAt} basis={run.startedAtBasis} />
          </KvRow>
          <KvRow label="収集完了の記録">
            <RecordedTime value={run.completedAt} basis={run.completedAtBasis} />
          </KvRow>
          <KvRow label="中央保管庫の受付日時">{run.recordedAt}</KvRow>
          <KvRow label="中央保管庫の保存完了日時">{run.sealedAt}</KvRow>
          <KvRow label="保存ファイル数">{run.artifactCount}件</KvRow>
        </dl>
      </div>
      <div className="panel-note">
        「保存済み」は保管の完了を表します。収集の成功や、金融機関の全履歴が揃っていることは意味しません。日時は記録された表記のまま表示しています。
      </div>
    </Panel>
  );
}

export function EvidenceHistory({ sources }: { sources: EvidenceSource[] }): ReactNode {
  const [selected, setSelected] = useState("");
  const sourceId =
    selected || sources.find((source) => source.id === "sony-bank")?.id || sources[0]?.id || "";
  if (!sourceId) return <EmptyState>閲覧できる取得元はまだありません。</EmptyState>;
  return (
    <>
      <section className="panel">
        <div className="panel-body">
          <label className="filter-field">
            取得元
            <select
              aria-label="取得元"
              value={sourceId}
              onChange={(event) => setSelected(event.target.value)}
            >
              {!sources.some((source) => source.id === sourceId) ? (
                <option value={sourceId}>{sourceId}（現在は一覧にありません）</option>
              ) : null}
              {sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>
      <HistoryPage key={sourceId} sourceId={sourceId} />
    </>
  );
}

function HistoryPage({ sourceId }: { sourceId: string }): ReactNode {
  const paging = useCursorPage();
  const query = useEvidenceRuns(sourceId, paging.cursor);
  return (
    <EvidenceBoundary query={query} label="取得履歴">
      {(data) => (
        <Panel
          title="保存済みの取得履歴"
          id="run-history"
          note="中央保管庫への保存が完了した記録のみ表示します。受付順の一覧で、金融機関のデータが最新かどうかを示すものではありません。"
        >
          {data.items.length === 0 ? (
            <EmptyState>
              このページに保存済みの記録はありません。未保存の収集や未取得の履歴の有無は、この一覧からは判断できません。
            </EmptyState>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">中央受付日時</th>
                    <th scope="col">収集開始の記録</th>
                    <th scope="col">収集結果</th>
                    <th scope="col">保存状態</th>
                    <th scope="col">ファイル数</th>
                    <th scope="col">詳細</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((run) => (
                    <tr key={run.id}>
                      <td>{run.recordedAt}</td>
                      <td>
                        <RecordedTime value={run.startedAt} basis={run.startedAtBasis} />
                      </td>
                      <td>
                        <Outcome value={run.outcome} />
                      </td>
                      <td>
                        <Badge>保存済み</Badge>
                      </td>
                      <td>{run.artifactCount}件</td>
                      <td>
                        <Link to={`/runs/${run.id}`} title={`収集記録 ${run.id}`}>
                          保存ファイルを見る
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <EvidencePager
            paging={paging}
            nextCursor={data.nextCursor}
            count={data.items.length}
            fetching={query.isFetching}
          />
        </Panel>
      )}
    </EvidenceBoundary>
  );
}

export function EvidenceRunPage({
  runId,
  sources,
}: {
  runId: EvidenceRunId;
  sources: EvidenceSource[];
}): ReactNode {
  const paging = useCursorPage();
  const query = useEvidenceArtifacts(runId, paging.cursor);
  return (
    <EvidenceBoundary query={query} label="保存ファイル">
      {(data) => (
        <>
          <RunSummary run={data.run} sources={sources} />
          <Panel
            title="保存ファイル"
            id="saved-files"
            note="取得元の応答と、収集側が生成した記録を区別して表示します。"
          >
            {data.items.length === 0 ? (
              <EmptyState>このページに保存ファイルはありません。</EmptyState>
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">記録の内容</th>
                      <th scope="col">種類</th>
                      <th scope="col">保存形式</th>
                      <th scope="col">サイズ</th>
                      <th scope="col">詳細</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((artifact) => (
                      <tr key={artifact.id}>
                        <td>
                          <Nullable value={artifact.dataset} placeholder="内容名未記録" />
                        </td>
                        <td>{ROLES[artifact.role]}</td>
                        <td>{FIDELITY[artifact.payloadFidelity]}</td>
                        <td>{artifact.byteSize} bytes</td>
                        <td>
                          <Link
                            to={`/runs/${runId}/artifacts/${artifact.id}`}
                            title={`保存ファイル ${artifact.id}`}
                          >
                            ファイルの詳細
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <EvidencePager
              paging={paging}
              nextCursor={data.nextCursor}
              count={data.items.length}
              fetching={query.isFetching}
            />
          </Panel>
        </>
      )}
    </EvidenceBoundary>
  );
}

function ArtifactFacts({ artifact }: { artifact: EvidenceArtifact }): ReactNode {
  return (
    <dl className="kv">
      <KvRow label="記録の内容">
        <Nullable value={artifact.dataset} />
      </KvRow>
      <KvRow label="種類">{ROLES[artifact.role]}</KvRow>
      <KvRow label="元データとの関係">{FIDELITY[artifact.payloadFidelity]}</KvRow>
      <KvRow label="サイズ">{artifact.byteSize} bytes</KvRow>
      <KvRow label="中央保管庫の受付日時">{artifact.recordedAt}</KvRow>
    </dl>
  );
}

export function EvidenceArtifactPage({
  runId,
  artifactId,
  sources,
}: {
  runId: EvidenceRunId;
  artifactId: EvidenceArtifactId;
  sources: EvidenceSource[];
}): ReactNode {
  const query = useEvidenceArtifact(runId, artifactId);
  return (
    <EvidenceBoundary query={query} label="ファイルの詳細">
      {(data) => (
        <>
          <Panel title="保存されたファイル" id="artifact-detail">
            <div className="panel-body">
              <ArtifactFacts artifact={data.artifact} />
              <p>
                <a className="button" href={evidenceRawUrl(runId, artifactId)} download>
                  保存ファイルをダウンロード
                </a>
              </p>
              <p className="dim">
                保存されたバイト列を取得します。収集側が生成・加工したファイルは、取得元の未加工データとは異なります。
              </p>
              <EvidencePreview
                key={`${runId}:${artifactId}:${data.artifact.sha256}`}
                url={evidenceRawUrl(runId, artifactId)}
                artifactKey={data.artifact.artifactKey}
                mediaType={data.artifact.declaredMediaType}
                byteSize={data.artifact.byteSize}
                sha256={data.artifact.sha256}
              />
            </div>
          </Panel>
          <RunSummary run={data.run} sources={sources} />
          <details className="detail-disclosure">
            <summary>照合用の識別情報</summary>
            <dl className="kv">
              <KvRow label="収集記録ID">{data.run.id}</KvRow>
              <KvRow label="ファイルID">{data.artifact.id}</KvRow>
              <KvRow label="収集プログラム">{data.run.producerId}</KvRow>
              <KvRow label="収集内のファイル識別子">{data.artifact.artifactKey}</KvRow>
              <KvRow label="ファイル SHA-256">
                <Sha value={data.artifact.sha256} full />
              </KvRow>
              <KvRow label="記述情報 SHA-256">
                <Sha value={data.artifact.descriptorSha256} full />
              </KvRow>
              <KvRow label="形式">
                <Nullable value={data.artifact.formatId} /> /{" "}
                <Nullable value={data.artifact.formatVersion} />
              </KvRow>
              <KvRow label="申告されたメディア形式">
                <Nullable value={data.artifact.declaredMediaType} />
              </KvRow>
              <KvRow label="コンテナ種別">{data.artifact.containerKind}</KvRow>
              <KvRow label="元データへの参照方法">{data.artifact.lineageDisposition}</KvRow>
            </dl>
          </details>
        </>
      )}
    </EvidenceBoundary>
  );
}
