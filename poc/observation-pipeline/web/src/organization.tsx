import { Fragment, type ReactNode } from "react";
import type { IdentityStatus } from "../../shared/identity-contract.ts";
import type {
  ObservationOrganization,
  OrganizedAccount,
  OrganizedInstrument,
} from "../../shared/organization-contract.ts";
import { Badge, Nullable, ObservationLink, Panel, SourceAccount } from "./ui.tsx";
import { AccountConnectionDetails } from "./account-connection.tsx";
import { FinancialProductDetails, FinancialProductSummary } from "./financial-product.tsx";

type Organization = ObservationOrganization | undefined;
const STATUS: Record<IdentityStatus, string> = {
  identified: "識別済み",
  "provider-local": "取得元内で識別",
  aggregate: "集計表示",
  unresolved: "要確認",
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
  const productPrimary = product?.status === "identified" && organized?.method !== "manual";
  return (
    <div className="organized-account">
      {productPrimary ? <FinancialProductSummary claim={product} /> : null}
      {organized ? (
        <div className={productPrimary ? "table-secondary" : undefined}>
          {organized.label} <Badge>{STATUS[organized.status]}</Badge>
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
      <div>
        {item.label} <Badge>{STATUS[item.status]}</Badge>
      </div>
      <div className="table-secondary">
        {item.method === "manual" ? "手動で整理" : "規則で整理"} · 改訂 {item.revision}
      </div>
      <details>
        <summary>対応の根拠</summary>
        <dl className="kv">
          <dt>理由</dt>
          <dd>{item.reason}</dd>
          <dt>参照先</dt>
          <dd className="wrap">{item.referenceId}</dd>
          <dt>整理先</dt>
          <dd className="wrap">{item.targetId}</dd>
        </dl>
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
            <dl className="kv">
              <dt>口座</dt>
              <dd>
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
              </dd>
              {organization.instruments.map((item) => (
                <Fragment key={item.role}>
                  <dt>{ROLE[item.role]}</dt>
                  <dd>
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
                  </dd>
                </Fragment>
              ))}
            </dl>
            {organization.product ? (
              <>
                <h3>金融商品</h3>
                <FinancialProductDetails claim={organization.product} />
              </>
            ) : null}
          </>
        )}
      </div>
    </Panel>
  );
}
