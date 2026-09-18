import type { ReactNode } from "react";
import type { AccountConnection } from "../../../packages/observation-shared/src/account-connection-contract.ts";
import { ArtifactLink, Badge, EmptyState, Panel, type Tone } from "./ui.tsx";

const STATUS: Record<AccountConnection["status"], string> = {
  confirmed: "連携先を確認済み",
  unresolved: "連携先の対応は要確認",
  "evidence-ineligible": "根拠は現在の対象外",
};
const TONE: Record<AccountConnection["status"], Tone> = {
  confirmed: "ok",
  unresolved: "warn",
  "evidence-ineligible": "neutral",
};
export function AccountConnectionDetails({
  connection,
}: {
  connection: AccountConnection;
}): ReactNode {
  return (
    <details className="detail-disclosure">
      <summary>取得経路の対応 · {STATUS[connection.status]}</summary>
      <p>
        {connection.label} <Badge tone={TONE[connection.status]}>{STATUS[connection.status]}</Badge>
      </p>
      <p>{connection.reason}</p>
      <p className="footnote">
        {connection.status === "confirmed"
          ? "同じ金融機関の連携であることを確認しています。個別口座・カードとの対応は未確定です。"
          : "個別口座・カードとの対応は未確定です。"}
      </p>
      {connection.status === "evidence-ineligible" ? (
        <p>過去の確認記録です。現在の名称変更や対応確定には使用していません。</p>
      ) : null}
      <p>
        根拠の原本:{" "}
        {connection.evidenceArtifactIds.map((id, index) => (
          <span key={id}>
            {index === 0 ? "" : " · "}
            <ArtifactLink id={id} />
          </span>
        ))}
      </p>
    </details>
  );
}

function Count({ label, value }: { label: string; value: number }): ReactNode {
  return (
    <span className="connection-count">
      {label} <span className="count">{value}件</span>
    </span>
  );
}

export function AccountConnectionInventory({
  connections,
}: {
  connections: AccountConnection[];
}): ReactNode {
  const tally = (status: AccountConnection["status"]) =>
    connections.filter((item) => item.status === status).length;
  return (
    <Panel
      id="account-connections"
      title="MoneyForwardと直接取得の対応"
      count={`${connections.length}件`}
      note="全連携の確認記録です。取引がない連携も表示しています。下の取得元フィルターとは別の一覧です。"
    >
      <div className="panel-body">
        <p className="connection-counts">
          <Count label="連携先の確認済み" value={tally("confirmed")} />
          <Count label="対応は要確認" value={tally("unresolved")} />
          <Count label="根拠が対象外" value={tally("evidence-ineligible")} />
        </p>
        {!connections.length ? <EmptyState>取得経路の確認記録はまだありません。</EmptyState> : null}
      </div>
      {connections.length ? (
        <div className="identity-grid">
          {connections.map((connection, index) => (
            <article className="identity-card" key={`${connection.label}:${index}`}>
              <h3 className="identity-card-title">{connection.label}</h3>
              <AccountConnectionDetails connection={connection} />
            </article>
          ))}
        </div>
      ) : null}
      <div className="panel-body">
        <h3>表示の優先方針</h3>
        <p>
          同じ個別口座・期間・項目・通貨・測定内容が確認できた場合は直接取得を優先します。
          MoneyForwardだけの期間や項目は、個別口座と取得範囲を確認できた場合に補完します。
          連携先の一致だけでは置き換えず、現在は両方の取得経路を残しています。
        </p>
        <p className="footnote">この対応は取引の重複除去や残高の合算を行いません。</p>
      </div>
    </Panel>
  );
}
