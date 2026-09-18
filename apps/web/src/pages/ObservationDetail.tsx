import type { ReactNode } from "react";
import { useObservation, type ObservationDetail, type Provenance } from "../api.ts";
import { Link, type ObservationKind } from "../router.tsx";
import { formatAmount } from "../money.ts";
import {
  Amount,
  CellValue,
  KindBadge,
  Kv,
  KvRow,
  LineageBadge,
  Notice,
  Nullable,
  Panel,
  QueryBoundary,
  RawLink,
  Sha,
  StatusBadge,
  TransactionStatus,
  WarningList,
} from "../ui.tsx";
import { KIND_LABELS } from "./ViewControls.tsx";
import { displayLabel } from "../labels.ts";
import { OrganizationPanel } from "../organization.tsx";
import { classifyActivity } from "../../../../packages/observation-shared/src/activity-semantics.ts";
import { ActivityFacts } from "../activity-display.tsx";
import {
  classifyBalance,
  BALANCE_INTERPRETATION_POLICY_VERSION,
} from "../../../../packages/observation-shared/src/balance-semantics.ts";
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
  parser: "解析方法",
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
  const activity =
    detail.kind === "transaction" && provenance
      ? classifyActivity({
          sourceId: provenance.source_id,
          parserName: provenance.parser_name,
          status: stringAt(row, "status"),
          extra: detail.extra,
        })
      : null;
  const meaning =
    detail.kind === "balance" && provenance
      ? classifyBalance({
          sourceId: provenance.source_id,
          parserName: provenance.parser_name,
          metric: stringAt(row, "metric") ?? "",
          sourceAccount: stringAt(row, "source_account") ?? "",
        })
      : null;
  return (
    <>
      {provenance?.superseded_by_parse_run_id != null ? (
        <Notice tone="warn" role="alert">
          <strong>これは旧解析の記録です</strong>
          <p>
            解析 #{provenance.superseded_by_parse_run_id}
            に置き換えられています。現在の値として扱わないでください。
          </p>
        </Notice>
      ) : null}
      {hasAmount ? (
        <Panel id="amount" title="記録された金額">
          <div className="panel-body">
            <div className="quantity">
              <Amount
                minor={minor}
                unit={unit}
                text={text}
                neutral={activity !== null || (meaning !== null && meaning.kind !== "asset")}
              />
            </div>
            <p className="footnote">取得元の単位と保存された精度を保って表示しています。</p>
          </div>
        </Panel>
      ) : null}
      {meaning ? (
        <Panel id="measurement-meaning" title="記録の意味">
          <div className="panel-body">
            <strong>{meaning.label}</strong>
            <p>{meaning.reason}</p>
            <p className="footnote">
              解釈の版: {BALANCE_INTERPRETATION_POLICY_VERSION}
              。保存形式の「残高」は原本から読み取った項目の格納先を表し、必ずしも保有残高を意味しません。
            </p>
          </div>
        </Panel>
      ) : null}
      {activity ? (
        <Panel id="activity-meaning" title="記録の意味">
          <div className="panel-body">
            <p>
              {activity.amountLabel} / {activity.dateLabel} / {activity.statusLabel}
            </p>
            <ActivityFacts meaning={activity} />
          </div>
        </Panel>
      ) : null}
      <OrganizationPanel organization={detail.organization} />
      {detail.normalized ? (
        <Panel id="normalized-value" title="DBの正規化値">
          <div className="panel-body">
            <p>
              状態:{" "}
              {
                {
                  exact: "正規化済み",
                  missing: "値が未記録",
                  unparsed: "解析不能",
                  conflict: "原表記と整数値が不一致",
                }[detail.normalized.status]
              }
            </p>
            {detail.normalized.status === "exact" ? (
              <p>
                整数係数: {detail.normalized.coefficient} ／ 小数桁数: {detail.normalized.scale}
              </p>
            ) : null}
            <p className="footnote">
              規則: {detail.normalized.policyVersion}
              。上の金額と以下の記録欄は元の表記を保持しています。ゼロ判定にはDBの正規化値を使います。
            </p>
          </div>
        </Panel>
      ) : null}
      <Panel id="stored-row" title="記録の内容">
        <div className="table-scroll" role="region" aria-label="記録の内容" tabIndex={0}>
          <table className="stored-row-table">
            <caption>保存された列と値をそのまま並べています。</caption>
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
                    {detail.kind === "transaction" &&
                    column === "status" &&
                    (typeof value === "string" || value == null) ? (
                      <TransactionStatus status={value} />
                    ) : (
                      <CellValue value={value} />
                    )}
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
            <details className="detail-disclosure">
              <summary>内部の項目名</summary>
              <Kv>
                {Object.keys(row).map((key) => (
                  <KvRow key={key} label={displayLabel(FIELD_LABELS, key)}>
                    <code>{key}</code>
                  </KvRow>
                ))}
              </Kv>
            </details>
          </div>
        </Panel>
      </details>
      <h2 className="section-gap" id="provenance">
        記録の根拠をたどる
      </h2>
      <p className="footnote">記録 → 解析 → 原本 → 収集の順に、保存された情報を確認できます。</p>
      {provenance == null ? (
        <Notice tone="bad" role="alert">
          <strong>原本へのつながりを確認できません</strong>
          <p>対応する解析記録がないため、この値の取得経路を確認できません。</p>
        </Notice>
      ) : (
        <ProvenanceChain detail={detail} provenance={provenance} />
      )}
    </>
  );
}
function Step({
  number,
  stage,
  title,
  children,
}: {
  number: number;
  stage: string;
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
          <div className="chain-heading">
            <span className="chain-stage">{stage}</span>
            <h3 className="chain-title">{title}</h3>
          </div>
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
      <Step number={1} stage="記録" title="口座と原本内の位置">
        <Kv>
          <KvRow label="口座">
            <Nullable value={stringAt(detail.row, "source_account")} />
          </KvRow>
          <KvRow label="原本内の位置">
            <Nullable value={stringAt(detail.row, "raw_locator")} placeholder="位置未記録" />
          </KvRow>
        </Kv>
        <p className="footnote">
          この位置を原本と照らし合わせることで、読み取った値を確認できます。
        </p>
      </Step>
      <Step number={2} stage="解析" title={`解析 #${p.parse_run_id}`}>
        <StatusBadge status={p.parse_status} />
        <LineageBadge supersededBy={p.superseded_by_parse_run_id} />
        <Kv>
          <KvRow label="解析方法">
            {p.parser_name}@{p.parser_version}
          </KvRow>
          <KvRow label="解析日時">{p.parsed_at}</KvRow>
          <KvRow label="エラー">
            <Nullable value={p.error} placeholder="エラー未記録" />
          </KvRow>
        </Kv>
        <WarningList warnings={p.warnings} />
        {p.warnings.parsed && p.warnings.list.length === 0 ? (
          <p className="dim">解析の注意事項は記録されていません。</p>
        ) : null}
      </Step>
      <Step number={3} stage="原本" title={`原本 #${p.artifact_id}`}>
        <Kv>
          <KvRow label="取得元">{p.source_id}</KvRow>
          <KvRow label="資料の種類">
            <Nullable value={p.dataset} />
          </KvRow>
          <KvRow label="取得日時">{p.fetched_at}</KvRow>
          <KvRow label="解析履歴">
            <Link to={`/artifacts/${p.artifact_id}`}>この原本のすべての解析を見る</Link>
          </KvRow>
        </Kv>
        <details className="detail-disclosure">
          <summary>取得URL・形式</summary>
          <Kv>
            <KvRow label="取得URL">
              <span className="wrap-any">
                <Nullable value={p.url} />
              </span>
            </KvRow>
            <KvRow label="資料形式">{p.mime}</KvRow>
          </Kv>
        </details>
      </Step>
      <Step number={4} stage="保存データ" title="保存された原本データ">
        <RawLink sha256={p.sha256}>この記録の原本を開く ↗</RawLink>
        <details className="detail-disclosure">
          <summary>原本の識別情報</summary>
          <Kv>
            <KvRow label="SHA-256">
              <Sha value={p.sha256} full />
            </KvRow>
            <KvRow label="サイズ">{p.size} バイト</KvRow>
            <KvRow label="保存形式">{p.content_type}</KvRow>
          </Kv>
        </details>
      </Step>
      <Step number={5} stage="収集" title={`収集 #${p.fetch_run_id}`}>
        <StatusBadge status={p.fetch_status} />
        <Kv>
          <KvRow label="開始日時">{p.started_at}</KvRow>
          <KvRow label="完了日時">
            <Nullable value={p.completed_at} placeholder="完了日時未記録" />
          </KvRow>
        </Kv>
        <details className="detail-disclosure">
          <summary>収集ツール・実行番号</summary>
          <Kv>
            <KvRow label="収集ツール">
              <span className="wrap-any">{p.tool}</span>
            </KvRow>
            <KvRow label="外部実行番号">
              <span className="wrap-any">
                <Nullable value={p.external_run_id} placeholder="外部実行番号未記録" />
              </span>
            </KvRow>
          </Kv>
        </details>
      </Step>
    </ol>
  );
}
