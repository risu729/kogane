import type { ReactNode } from "react";
import type { IdentityStatus } from "../../../packages/observation-shared/src/identity-contract.ts";
import type {
  ObservationOrganization,
  OrganizedAccount,
  OrganizedInstrument,
} from "../../../packages/observation-shared/src/organization-contract.ts";
import {
  Badge,
  Kv,
  KvRow,
  Nullable,
  ObservationLink,
  Panel,
  SourceAccount,
  type Tone,
} from "./ui.tsx";
import { AccountConnectionDetails } from "./account-connection.tsx";
import { FinancialProductDetails, FinancialProductSummary } from "./financial-product.tsx";
import { isCurrentFinancialProductClaim } from "../../../packages/observation-shared/src/financial-products.ts";

type Organization = ObservationOrganization | undefined;
const STATUS: Record<IdentityStatus, string> = {
  identified: "識別済み",
  "provider-local": "取得元内で識別",
  aggregate: "集計表示",
  unresolved: "要確認",
};
// Only a full identification is a positive claim; a provider-local or
// aggregate mapping is a fact about scope, not a warning.
const STATUS_TONE: Record<IdentityStatus, Tone> = {
  identified: "ok",
  "provider-local": "neutral",
  aggregate: "neutral",
  unresolved: "warn",
};
const ROLE: Record<OrganizedInstrument["role"], string> = {
  security: "銘柄",
  unit: "通貨・単位",
  "trade-unit": "取引の単位",
  "usage-unit": "利用の単位",
};
const NAME_REASON = {
  manual: "手動で指定した名称",
  "provider-current": "現在の対応付けの名称",
  "observed-japanese-script": "保存記録にある日本語表記",
};
export function IdentityStatusBadge({ status }: { status: IdentityStatus }): ReactNode {
  return <Badge tone={STATUS_TONE[status]}>{STATUS[status]}</Badge>;
}
export function organizedInstrument(
  organization: Organization,
  role: OrganizedInstrument["role"],
): OrganizedInstrument | undefined {
  return organization?.state === "organized"
    ? organization.instruments.find((item) => item.role === role)
    : undefined;
}
export function OrganizationLineage({ organization }: { organization: Organization }): ReactNode {
  return organization?.lineage === "historical" ? (
    <div className="table-secondary">履歴の整理情報（現在の値ではありません）</div>
  ) : null;
}
export function OrganizedSourceAccount({
  source,
  account,
  organization,
}: {
  source: string;
  account: string;
  organization: Organization;
}): ReactNode {
  const organized = organization?.state === "organized" ? organization.account : null;
  const product = organization?.state === "organized" ? organization.product : undefined;
  const productPrimary =
    product?.status === "identified" &&
    isCurrentFinancialProductClaim(product) &&
    organized?.method !== "manual";
  return (
    <div className="organized-account">
      {productPrimary ? <FinancialProductSummary claim={product} primary /> : null}
      {organized ? (
        <div className={`organized-label${productPrimary ? " table-secondary" : ""}`}>
          {organized.label} <IdentityStatusBadge status={organized.status} />
        </div>
      ) : null}
      {product && !productPrimary ? <FinancialProductSummary claim={product} /> : null}
      <SourceAccount source={source} account={account} />
      {organized?.connection ? (
        <AccountConnectionDetails connection={organized.connection} />
      ) : null}
      {organization?.state === "unavailable" ? (
        <div className="table-secondary">整理情報なし</div>
      ) : null}
      <OrganizationLineage organization={organization} />
    </div>
  );
}
export function OrganizedInstrumentContext({
  organization,
  role,
  original,
}: {
  organization: Organization;
  role: OrganizedInstrument["role"];
  original?: string | null;
}): ReactNode {
  const item = organizedInstrument(organization, role);
  return item && item.label !== original ? (
    <div className="table-secondary">
      {ROLE[role]}: {item.label}
    </div>
  ) : null;
}
function Interpretation({ item }: { item: OrganizedAccount }): ReactNode {
  return (
    <>
      <div className="organized-label">
        {item.label} <IdentityStatusBadge status={item.status} />
      </div>
      <div className="table-secondary">
        {item.method === "manual" ? "手動で整理" : "規則で整理"} · 改訂 {item.revision}
      </div>
      <details className="detail-disclosure">
        <summary>対応の根拠</summary>
        <Kv>
          <KvRow label="理由">{item.reason}</KvRow>
          <KvRow label="参照先">{item.referenceId}</KvRow>
          <KvRow label="整理先">{item.targetId}</KvRow>
        </Kv>
      </details>
    </>
  );
}
export function OrganizationPanel({ organization }: { organization: Organization }): ReactNode {
  return (
    <Panel id="organization" title="口座・銘柄の整理">
      <div className="panel-body">
        {!organization || organization.state !== "organized" ? (
          <p>この記録の整理情報は利用できません。以下に取得元の保存値を表示しています。</p>
        ) : (
          <>
            <OrganizationLineage organization={organization} />
            <p className="footnote">
              保存された値に対応する整理情報です。「取得元内で識別」は外部台帳との照合完了を意味しません。
            </p>
            <Kv>
              <KvRow label="口座">
                {organization.account ? (
                  <>
                    <Interpretation item={organization.account} />
                    {organization.account.connection ? (
                      <AccountConnectionDetails connection={organization.account.connection} />
                    ) : null}
                  </>
                ) : (
                  <Nullable value={null} placeholder="口座の整理情報なし" />
                )}
              </KvRow>
              {organization.instruments.map((item) => (
                <KvRow key={item.role} label={ROLE[item.role]}>
                  <Interpretation item={item} />
                  <div className="table-secondary">
                    {item.namespace} / {item.scope} / {item.value}
                  </div>
                  {item.nameEvidence ? (
                    <div className="table-secondary">
                      名称の根拠: {NAME_REASON[item.nameEvidence.reason]}
                      {item.nameEvidence.origin ? (
                        <>
                          {" "}
                          ·{" "}
                          <ObservationLink
                            kind={item.nameEvidence.origin.kind}
                            id={item.nameEvidence.origin.id}
                          >
                            根拠の記録
                          </ObservationLink>
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </KvRow>
              ))}
            </Kv>
            {organization.product ? (
              <>
                <h3 className="section-gap">金融商品</h3>
                <FinancialProductDetails claim={organization.product} />
              </>
            ) : null}
          </>
        )}
      </div>
    </Panel>
  );
}
