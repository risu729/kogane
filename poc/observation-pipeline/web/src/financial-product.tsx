import type { ReactNode } from "react";
import {
  FINANCIAL_PRODUCT_SOURCES,
  isCurrentFinancialProductClaim,
  type FinancialProductClaim,
} from "../../shared/financial-products.ts";
import { ArtifactLink, Badge, ObservationLink } from "./ui.tsx";

const STATUS = { identified: "商品を特定", unresolved: "商品未特定", conflict: "商品の根拠が競合" };
const REFRESH_NOTICE = "商品情報が更新されています。再読み込みしてください。";

export function FinancialProductSummary({ claim }: { claim: FinancialProductClaim }): ReactNode {
  if (!isCurrentFinancialProductClaim(claim))
    return <div className="financial-product-summary table-secondary">{REFRESH_NOTICE}</div>;
  return (
    <div className="financial-product-summary">
      <div>
        {claim.status === "identified" ? claim.name : null} <Badge>{STATUS[claim.status]}</Badge>
      </div>
      <div className="table-secondary">
        {claim.institution ? `金融機関: ${claim.institution.name}` : null}
        {claim.institution && claim.nativeCurrency ? " · " : null}
        {claim.nativeCurrency ? `元の通貨: ${claim.nativeCurrency}` : null}
      </div>
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
      <FinancialProductSummary claim={claim} />
      <p className="footnote">
        この保存記録の情報を現在の商品台帳に照合した結果です。当時の商品名・金利・契約条件の確認ではありません。
        別の取得時点の残高から過去の取引商品を推定していません。口座の愛称や取得元の保存値は変更しません。
      </p>
      {claim.status !== "identified" ? (
        <p>口座や金融機関が分かっていても、個別の商品は特定できていません。</p>
      ) : null}
      <details>
        <summary>商品の判定根拠</summary>
        <dl className="kv">
          <dt>商品 ID</dt>
          <dd className="wrap">{claim.productId ?? "未特定"}</dd>
          {claim.family ? (
            <>
              <dt>商品体系</dt>
              <dd>{claim.family.name}（個別商品とは別）</dd>
            </>
          ) : null}
          <dt>元の商品コード</dt>
          <dd>{claim.code ?? "記録なし"}</dd>
          <dt>根拠の記録</dt>
          <dd>
            <ObservationLink kind={claim.origin.kind} id={claim.origin.id}>
              判定に使った記録
            </ObservationLink>{" "}
            · <ArtifactLink id={claim.origin.artifactId} />
          </dd>
          <dt>原本内の位置</dt>
          <dd className="wrap">{claim.origin.rawLocator}</dd>
          <dt>記録の基準日</dt>
          <dd>{claim.origin.asOf ?? "記録なし"}</dd>
          <dt>取得元の観測日時</dt>
          <dd>{claim.origin.observedAt ?? "記録なし"}</dd>
          <dt>解析</dt>
          <dd className="wrap">
            #{claim.origin.parseRunId}
            {claim.origin.parserName ? ` · ${claim.origin.parserName}` : null}
          </dd>
          <dt>参照した項目</dt>
          <dd className="wrap">{claim.evidence.fields.join(" / ") || "なし"}</dd>
          <dt>判定理由</dt>
          <dd className="wrap">{claim.reason}</dd>
          <dt>照合規則</dt>
          <dd className="wrap">{claim.evidence.rule}</dd>
          <dt>公式の商品情報</dt>
          <dd>
            {sources.length ? (
              <ul>
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
          </dd>
          <dt>判定の版</dt>
          <dd className="wrap">
            台帳: {claim.catalogueVersion} · 規則: {claim.resolverVersion}
          </dd>
        </dl>
      </details>
    </div>
  );
}
