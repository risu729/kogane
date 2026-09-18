import type { ReactNode } from "react";
import type { CardOwnershipSide } from "../../../packages/domain/src/card-ownership-review.ts";
import { Link } from "./router.tsx";
import { Kv, KvRow, Notice } from "./ui.tsx";
export const OWNERSHIP_ROLES = {
  liable_party: "カード請求の支払義務を負う人",
  beneficial_owner: "銀行口座の資金を保有する人",
} as const;
const BLOCKERS: Record<string, string> = {
  candidate_not_proposed: "この照合候補は判断済みです。新しい候補から確認してください。",
  source_changed: "請求または銀行明細が更新されています。新しい照合候補を確認してください。",
  account_mapping_unresolved:
    "原本から口座への対応がまだ一つに定まっていません。口座の整理を確認してください。",
  account_not_resolved:
    "候補作成時の口座が未解決です。口座の整理後、新しい候補を確認してください。",
  account_context_changed: "候補作成後に口座の対応が変わっています。新しい候補で確認してください。",
};
export function ownerLabel(ref: string): string {
  return ref.startsWith("party:") ? ref.slice(6) : ref;
}
export function CardOwnershipDetails({ side }: { side: CardOwnershipSide }): ReactNode {
  const match = /^(balance|transaction):([0-9]+)$/u.exec(side.fact.id);
  return (
    <>
      <Kv>
        <KvRow label="確認する関係">{OWNERSHIP_ROLES[side.role]}</KvRow>
        <KvRow label="取得元の口座">
          {side.sourceId} · {side.sourceAccount}
        </KvRow>
        <KvRow label="原本">
          {match ? (
            <Link to={`/observations/${match[1]}/${match[2]}`}>対象の記録と原本を開く</Link>
          ) : (
            "原本の経路を確認できません"
          )}
        </KvRow>
        <KvRow label="口座の対応">
          {side.accountId === null ? "未解決" : "現在の対応を取得済み"}
        </KvRow>
      </Kv>
      {side.blockers.length > 0 ? (
        <Notice tone="warn" inline role="note">
          <ul className="warning-list">
            {side.blockers.map((code) => (
              <li key={code}>{BLOCKERS[code] ?? code}</li>
            ))}
          </ul>
          <Link to="/identities">口座の整理を確認</Link>
        </Notice>
      ) : null}
      <details className="detail-disclosure settlement-history">
        <summary>現在の対応と記録済みの判断</summary>
        <p>
          口座: {side.accountId ?? "未解決"} · 対応の版: {side.mappingRevision} ·
          保有者判断の記録数: {side.ownershipRevision}
        </p>
        <p>解析版: {side.fact.revision}</p>
        {side.claims.length === 0 ? (
          <p>この関係に記録済みの保有者はいません。</p>
        ) : (
          <ul className="plain-list">
            {side.claims.map((claim) => (
              <li key={claim.id}>
                {ownerLabel(claim.partyRef)} ·{" "}
                {claim.status === "accepted"
                  ? "採用済み"
                  : claim.status === "rejected"
                    ? "却下済み"
                    : claim.status === "released"
                      ? "解除済み"
                      : "提案"}
                {claim.validFrom !== null || claim.validTo !== null
                  ? "（期間の指定あり。この照合では自動適用しません）"
                  : ""}
                <br />
                判断の記録: {claim.decisionRevisionId}
              </li>
            ))}
          </ul>
        )}
        {side.claimsTruncated ? (
          <p>直近50件の相手を表示しています。以前の判断も保存されています。</p>
        ) : null}
      </details>
    </>
  );
}
