import type { ReactNode } from "react";
import { useObservation, type ObservationDetail, type Provenance } from "../api.ts";
import { Link, type ObservationKind } from "../router.tsx";
import { formatAmount } from "../money.ts";
import {
  Amount,
  CellValue,
  KindBadge,
  LineageBadge,
  Nullable,
  Panel,
  QueryBoundary,
  RawLink,
  Sha,
  StatusBadge,
  WarningList,
} from "../ui.tsx";
import { KIND_LABELS } from "./ViewControls.tsx";
import { displayLabel } from "../labels.ts";
const stringAt = (row: Record<string, unknown>, key: string): string | null =>
  typeof row[key] === "string" ? (row[key] as string) : null;
const FIELD_LABELS: Record<string, string> = {
  id: "記録番号",
  source_id: "取得元",
  source_account: "口座",
  as_of: "基準日",
  observed_at: "取得元の観測日時",
  description: "内容",
  counterparty: "相手先",
  currency: "通貨",
  instrument: "通貨・単位",
  amount_minor: "最小単位の金額",
  amount_text: "取得元の金額表記",
  metric: "指標",
  status: "取得元の状態",
  external_id: "取得元の識別番号",
  security_code: "銘柄コード",
  security_name: "銘柄名",
  quantity_text: "数量の表記",
  quantity_scale: "数量の小数桁",
  market: "市場",
  subject: "評価対象",
  raw_locator: "原本内の位置",
  parse_run_id: "解析番号",
};
export function ObservationDetailPage({
  kind,
  id,
}: {
  kind: ObservationKind;
  id: number;
}): ReactNode {
  const query = useObservation(kind, id);
  return (
    <>
      <div className="page-head">
        <div className="breadcrumb">
          記録 / {KIND_LABELS[kind]} / #{id}
        </div>
        <div className="title-row">
          <h1>
            {KIND_LABELS[kind]}の詳細 #{id}
          </h1>
          <KindBadge kind={kind} />
        </div>
        <p className="lede">記録された値と、その根拠になった原本を確認できます。</p>
      </div>
      <QueryBoundary query={query} label={`${KIND_LABELS[kind]}の詳細 #${id}`}>
        {(data) => <ObservationBody detail={data} />}
      </QueryBoundary>
    </>
  );
}
function ObservationBody({ detail }: { detail: ObservationDetail }): ReactNode {
  const { row, provenance } = detail;
  const minor = stringAt(row, "amount_minor"),
    text = stringAt(row, "amount_text"),
    unit = stringAt(row, "currency") ?? stringAt(row, "instrument");
  const hasAmount = formatAmount(minor, unit, text) !== "";
  return (
    <>
      {provenance?.superseded_by_parse_run_id != null ? (
        <div className="state state-error" role="alert">
          <span className="state-title">これは旧解析の記録です</span>
          <p>
            解析 #{provenance.superseded_by_parse_run_id}
            に置き換えられています。現在の値として扱わないでください。
          </p>
        </div>
      ) : null}
      {hasAmount ? (
        <Panel id="amount" title="記録された金額">
          <div className="panel-body">
            <div className="quantity">
              <Amount minor={minor} unit={unit} text={text} />
            </div>
            <p className="footnote">取得元の単位と保存された精度を保って表示しています。</p>
          </div>
        </Panel>
      ) : null}
      <Panel id="stored-row" title="記録の内容">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">項目</th>
                <th scope="col">保存された値</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(row).map(([column, value]) => (
                <tr key={column}>
                  <th scope="row">{displayLabel(FIELD_LABELS, column)}</th>
                  <td className="wrap">
                    <CellValue value={value} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <details className="detail-disclosure">
        <summary>追加項目と保存形式</summary>
        <Panel
          id="extra"
          title="取得元の追加項目"
          note={
            detail.extraParsed
              ? "保存されたJSONを読みやすく整形しています。保存内容は変更していません。"
              : "JSONとして解釈できなかったため、保存された文字列をそのまま表示します。"
          }
        >
          <div className="panel-body">
            {detail.extraRaw === "" ? (
              <p>追加項目は記録されていません。</p>
            ) : (
              <pre>
                <code>
                  {detail.extraParsed ? JSON.stringify(detail.extra, null, 2) : detail.extraRaw}
                </code>
              </pre>
            )}
            <details>
              <summary>内部の項目名</summary>
              <dl className="kv">
                {Object.keys(row).map((key) => (
                  <div className="kv-entry" key={key}>
                    <dt>{displayLabel(FIELD_LABELS, key)}</dt>
                    <dd>
                      <code>{key}</code>
                    </dd>
                  </div>
                ))}
              </dl>
            </details>
          </div>
        </Panel>
      </details>
      <h2 className="section-gap" id="provenance">
        記録の根拠をたどる
      </h2>
      <p className="footnote">記録 → 解析 → 原本 → 収集の順に、保存された情報を確認できます。</p>
      {provenance == null ? (
        <div className="state state-error" role="alert">
          <span className="state-title">原本へのつながりを確認できません</span>
          <p>対応する解析記録がないため、この値の取得経路を確認できません。</p>
        </div>
      ) : (
        <ProvenanceChain detail={detail} provenance={provenance} />
      )}
    </>
  );
}
function Step({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: ReactNode;
}): ReactNode {
  return (
    <li className="chain-step">
      <span className="chain-marker" aria-hidden="true">
        {number}
      </span>
      <section className="chain-card">
        <div className="chain-card-head">
          <h3>{title}</h3>
        </div>
        <div className="chain-body">{children}</div>
      </section>
    </li>
  );
}
function ProvenanceChain({
  detail,
  provenance: p,
}: {
  detail: ObservationDetail;
  provenance: Provenance;
}): ReactNode {
  return (
    <ol className="chain">
      <Step number={1} title="記録と原本内の位置">
        <dl className="kv">
          <dt>口座</dt>
          <dd>
            <Nullable value={stringAt(detail.row, "source_account")} />
          </dd>
          <dt>原本内の位置</dt>
          <dd>
            <Nullable value={stringAt(detail.row, "raw_locator")} placeholder="位置未記録" />
          </dd>
        </dl>
        <p className="footnote">
          この位置を原本と照らし合わせることで、読み取った値を確認できます。
        </p>
      </Step>
      <Step number={2} title={`解析 #${p.parse_run_id}`}>
        <StatusBadge status={p.parse_status} />
        <LineageBadge supersededBy={p.superseded_by_parse_run_id} />
        <dl className="kv">
          <dt>解析方法</dt>
          <dd>
            {p.parser_name}@{p.parser_version}
          </dd>
          <dt>解析日時</dt>
          <dd>{p.parsed_at}</dd>
          <dt>エラー</dt>
          <dd>
            <Nullable value={p.error} placeholder="エラー未記録" />
          </dd>
        </dl>
        <WarningList warnings={p.warnings} />
        {p.warnings.parsed && p.warnings.list.length === 0 ? (
          <p className="dim">解析の注意事項は記録されていません。</p>
        ) : null}
      </Step>
      <Step number={3} title={`原本 #${p.artifact_id}`}>
        <dl className="kv">
          <dt>取得元</dt>
          <dd>{p.source_id}</dd>
          <dt>資料の種類</dt>
          <dd>
            <Nullable value={p.dataset} />
          </dd>
          <dt>取得日時</dt>
          <dd>{p.fetched_at}</dd>
          <dt>解析履歴</dt>
          <dd>
            <Link to={`/artifacts/${p.artifact_id}`}>この原本のすべての解析を見る</Link>
          </dd>
        </dl>
        <details>
          <summary>取得URL・形式</summary>
          <p>
            <Nullable value={p.url} />
          </p>
          <p>{p.mime}</p>
        </details>
      </Step>
      <Step number={4} title="保存された原本データ">
        <RawLink sha256={p.sha256}>この記録の原本を開く ↗</RawLink>
        <details className="detail-disclosure">
          <summary>原本の識別情報</summary>
          <dl className="kv">
            <dt>SHA-256</dt>
            <dd>
              <Sha value={p.sha256} full />
            </dd>
            <dt>サイズ</dt>
            <dd>{p.size} バイト</dd>
            <dt>保存形式</dt>
            <dd>{p.content_type}</dd>
          </dl>
        </details>
      </Step>
      <Step number={5} title={`収集 #${p.fetch_run_id}`}>
        <StatusBadge status={p.fetch_status} />
        <dl className="kv">
          <dt>開始日時</dt>
          <dd>{p.started_at}</dd>
          <dt>完了日時</dt>
          <dd>
            <Nullable value={p.completed_at} placeholder="完了日時未記録" />
          </dd>
        </dl>
        <details>
          <summary>収集ツール・実行番号</summary>
          <p>{p.tool}</p>
          <Nullable value={p.external_run_id} />
        </details>
      </Step>
    </ol>
  );
}
