import type { AccountConnection } from "../../shared/account-connection-contract.ts";
import { ArtifactLink, Badge } from "./ui.tsx";

const STATUS = {
  confirmed: "連携先を確認済み",
  unresolved: "連携先の対応は要確認",
  "evidence-ineligible": "根拠は現在の対象外",
};
export function AccountConnectionDetails({ connection }: { connection: AccountConnection }) {
  return (
    <details className="detail-disclosure">
      <summary>取得経路の対応 · {STATUS[connection.status]}</summary>
      <p>
        {connection.label} · <Badge>{STATUS[connection.status]}</Badge>
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
      <div>
        根拠の原本:{" "}
        {connection.evidenceArtifactIds.map((id) => (
          <span key={id}>
            {" "}
            <ArtifactLink id={id} />{" "}
          </span>
        ))}
      </div>
    </details>
  );
}

export function AccountConnectionInventory({ connections }: { connections: AccountConnection[] }) {
  return (
    <section className="panel">
      <div className="panel-body">
        <h2>MoneyForwardと直接取得の対応</h2>
        <p>
          全連携の確認記録です。取引がない連携も表示しています。下の取得元フィルターとは別の一覧です。
        </p>
        <p>
          連携先の確認済み {connections.filter((item) => item.status === "confirmed").length}件 ·
          対応は要確認 {connections.filter((item) => item.status === "unresolved").length}件 ·
          根拠が対象外 {connections.filter((item) => item.status === "evidence-ineligible").length}
          件
        </p>
        {!connections.length ? <p>取得経路の確認記録はまだありません。</p> : null}
        {connections.map((connection, index) => (
          <article key={`${connection.label}:${index}`}>
            <h3>{connection.label}</h3>
            <AccountConnectionDetails connection={connection} />
          </article>
        ))}
        <h3>表示の優先方針</h3>
        <p>
          同じ個別口座・期間・項目・通貨・測定内容が確認できた場合は直接取得を優先します。
          MoneyForwardだけの期間や項目は、個別口座と取得範囲を確認できた場合に補完します。
          連携先の一致だけでは置き換えず、現在は両方の取得経路を残しています。
        </p>
        <p className="footnote">この対応は取引の重複除去や残高の合算を行いません。</p>
      </div>
    </section>
  );
}
