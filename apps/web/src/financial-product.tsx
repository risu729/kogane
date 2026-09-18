import type { ReactNode } from "react";
import {
  FINANCIAL_PRODUCT_SOURCES,
  isCurrentFinancialProductClaim,
  type FinancialProductClaim,
} from "../../../packages/observation-shared/src/financial-products.ts";
import { ArtifactLink, Badge, Kv, KvRow, ObservationLink, type Tone } from "./ui.tsx";

const STATUS = { identified: "商品を特定", unresolved: "商品未特定", conflict: "商品の根拠が競合" };
const TONE: Record<keyof typeof STATUS, Tone> = {
  identified: "ok",
  unresolved: "neutral",
  conflict: "warn",
};
const REFRESH_NOTICE = "商品情報が更新されています。再読み込みしてください。";

/**
 * The product claim for one stored row. `primary` puts it on the main line
 * of a cell; otherwise it is a secondary line under the account label.
 */
export function FinancialProductSummary({
  claim,
  primary = false,
}: {
  claim: FinancialProductClaim;
  primary?: boolean;
}): ReactNode {
  if (!isCurrentFinancialProductClaim(claim))
    return <div className="financial-product-summary table-secondary">{REFRESH_NOTICE}</div>;
  return (
    <div className={`financial-product-summary${primary ? " is-primary" : ""}`}>
      <div className="financial-product-name">
        {claim.status === "identified" ? claim.name : null}{" "}
        <Badge tone={TONE[claim.status]}>{STATUS[claim.status]}</Badge>
      </div>
      {claim.institution || claim.nativeCurrency ? (
        <div className="table-secondary">
          {claim.institution ? `金融機関: ${claim.institution.name}` : null}
          {claim.institution && claim.nativeCurrency ? " · " : null}
          {claim.nativeCurrency ? `元の通貨: ${claim.nativeCurrency}` : null}
        </div>
      ) : null}
    </div>
  );
}

export function FinancialProductDetails({ claim }: { claim: FinancialProductClaim }): ReactNode {
  if (!isCurrentFinancialProductClaim(claim))
    return <div className="financial-product-details table-secondary">{REFRESH_NOTICE}</div>;
  const sources = FINANCIAL_PRODUCT_SOURCES.filter((source) =>
    claim.evidence.sourceIds.includes(source.id),
  );
  return (
    <div className="financial-product-details">
      <FinancialProductSummary claim={claim} primary />
      <p className="footnote">
        この保存記録の情報を現在の商品台帳に照合した結果です。当時の商品名・金利・契約条件の確認ではありません。
        別の取得時点の残高から過去の取引商品を推定していません。口座の愛称や取得元の保存値は変更しません。
      </p>
      {claim.status !== "identified" ? (
        <p>口座や金融機関が分かっていても、個別の商品は特定できていません。</p>
      ) : null}
      <details className="detail-disclosure">
        <summary>商品の判定根拠</summary>
        <Kv>
          <KvRow label="商品 ID">{claim.productId ?? "未特定"}</KvRow>
          {claim.family ? (
            <KvRow label="商品体系">{claim.family.name}（個別商品とは別）</KvRow>
          ) : null}
          <KvRow label="元の商品コード">{claim.code ?? "記録なし"}</KvRow>
          <KvRow label="根拠の記録">
            <ObservationLink kind={claim.origin.kind} id={claim.origin.id}>
              判定に使った記録
            </ObservationLink>{" "}
            · <ArtifactLink id={claim.origin.artifactId} />
          </KvRow>
          <KvRow label="原本内の位置">{claim.origin.rawLocator}</KvRow>
          <KvRow label="記録の基準日">{claim.origin.asOf ?? "記録なし"}</KvRow>
          <KvRow label="取得元の観測日時">{claim.origin.observedAt ?? "記録なし"}</KvRow>
          <KvRow label="解析">
            #{claim.origin.parseRunId}
            {claim.origin.parserName ? ` · ${claim.origin.parserName}` : null}
          </KvRow>
          <KvRow label="参照した項目">{claim.evidence.fields.join(" / ") || "なし"}</KvRow>
          <KvRow label="判定理由">{claim.reason}</KvRow>
          <KvRow label="照合規則">{claim.evidence.rule}</KvRow>
          <KvRow label="公式の商品情報">
            {sources.length ? (
              <ul className="plain-list">
                {sources.map((source) => (
                  <li key={source.id}>
                    <a href={source.url} target="_blank" rel="noreferrer noopener">
                      {source.title}
                    </a>
                    （確認日: {source.verifiedAt}）
                  </li>
                ))}
              </ul>
            ) : (
              "対応する公式資料なし"
            )}
          </KvRow>
          <KvRow label="判定の版">
            台帳: {claim.catalogueVersion} · 規則: {claim.resolverVersion}
          </KvRow>
        </Kv>
      </details>
    </div>
  );
}
