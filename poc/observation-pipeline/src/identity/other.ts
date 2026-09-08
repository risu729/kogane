import { currencyIdentity } from "./instruments.ts";
import {
  record,
  string,
  type IdentityInput,
  type IdentityPlan,
  type InstrumentIdentity,
} from "./types.ts";

const LABELS: Record<string, string> = {
  vpass: "Vpassカード明細",
  "global-pass": "GLOBAL PASSデビット明細",
  myjcb: "MyJCB請求口座",
  "smbc-bank": "三井住友銀行 円普通預金",
  "sony-bank": "ソニー銀行",
  "sbi-shinsei-bank": "SBI新生銀行 預金口座",
  "sbi-vc-trade": "SBI VCトレード口座",
  "v-point": "Vポイント",
  "v-point-pay": "VポイントPay",
  "mobile-suica": "モバイルSuica SF",
  "moneyforward-me": "MoneyForward連携口座",
  paypay: "PayPay利用履歴",
};

export function otherIdentity(input: IdentityInput): IdentityPlan {
  const a = input.sourceAccount;
  const plan: IdentityPlan = {
    account: {
      key: [a],
      label: LABELS[input.sourceId] ?? "未識別の取得元口座",
      role: "source-account",
      status: "unresolved",
      reason: "unrecognized-source-account",
    },
    instruments: [],
    issues: [],
  };
  function account(
    role: string,
    reason: string,
    status: IdentityPlan["account"]["status"] = "provider-local",
  ) {
    Object.assign(plan.account, { role, reason, status });
  }
  function snapshot(role: string, reason: string) {
    account(role, reason, "unresolved");
    plan.account.key.push("fetch-run", String(input.fetchRunId));
    plan.issues.push(reason);
  }
  switch (input.sourceId) {
    case "vpass":
      if (/^vpass:card-\d{3}$/u.test(a))
        snapshot("card-statement", "card-ordinal-needs-durable-provider-binding");
      break;
    case "global-pass":
      if (a === "global-pass:card")
        account("debit-card-activity", "provider-card-surface-not-prestia-deposit");
      break;
    case "myjcb":
      if (/^myjcb:[a-z0-9][a-z0-9-]{0,63}:root$/u.test(a))
        account(
          "card-statement-aggregate",
          "connection-root-without-subcard-identity",
          "aggregate",
        );
      break;
    case "smbc-bank":
      if (a === "smbc-bank:ordinary-yen") account("deposit", "audited-ordinary-yen-scope");
      break;
    case "sony-bank":
      if (/^sony-bank:deposit:(AUD|BRL|CAD|CHF|CNH|EUR|GBP|HKD|JPY|NZD|SEK|USD|ZAR)$/u.test(a))
        account("deposit", "provider-deposit-currency-scope");
      else if (a === "sony-bank:wallet")
        account("debit-card-activity", "wallet-card-activity-not-extra-deposit");
      else if (/^sony-bank:gross(?::asset:00[1-9]|:asset:01[01]|:loan:01[2-5])?$/u.test(a))
        account(
          "valuation-aggregate",
          "provider-gross-category-or-total-not-product-holding",
          "aggregate",
        );
      break;
    case "sbi-shinsei-bank":
      if (/^sbi-shinsei:.+$/u.test(a)) {
        account("deposit", "provider-account-reference-with-native-unit");
        const native =
          string(input.subject) ??
          string(input.extra.currency) ??
          string(input.extra.currencyCode) ??
          input.instrument ??
          input.currency;
        if (native) plan.account.key.push("unit", native);
      }
      break;
    case "sbi-vc-trade":
      if (a === "sbi-vc-trade:main")
        account("exchange-account", "provider-exchange-scope-not-securities-account");
      break;
    case "v-point":
      if (/^v-point:common:bucket-\d+$/u.test(a)) {
        const type = input.extra.point_type;
        const expiry = input.extra.expiration;
        const metadata = record(input.extra._kogane);
        if (
          typeof type === "number" &&
          Number.isSafeInteger(type) &&
          type >= 0 &&
          typeof expiry === "string" &&
          expiry.length <= 100 &&
          (metadata.pointType === undefined || metadata.pointType === type) &&
          (metadata.expiration === undefined || metadata.expiration === expiry)
        ) {
          account("reward-bucket", "provider-point-type-expiration-bucket");
          plan.account.key = ["v-point:common", "point_type", String(type), "expiration", expiry];
          plan.account.label = "Vポイント 共通ポイント区分";
        } else snapshot("reward-bucket", "reward-bucket-semantic-evidence-missing-or-conflicting");
      } else if (/^v-point:store-limited:group-\d+:item-\d+$/u.test(a))
        snapshot("reward-bucket", "reward-bucket-index-not-durable-identity");
      else if (/^v-point:smfg:(smbc|smcc)$/u.test(a))
        account(
          "reward-display-aggregate",
          "displayed-reward-balance-may-overlap-common-points",
          "aggregate",
        );
      else if (a === "v-point:member") account("reward-account", "provider-member-history-scope");
      break;
    case "v-point-pay":
      if (a === "v-point-pay:notification-events")
        account("wallet-notification-events", "notification-evidence-not-settlement-confirmation");
      else if (a === "v-point-pay:prepaid-yen")
        account("prepaid-wallet", "event-balance-in-yen-not-v-points");
      break;
    case "mobile-suica":
      if (a === "mobile-suica:sf")
        account("stored-value", "provider-sf-scope-without-physical-card-binding");
      break;
    case "moneyforward-me":
      if (/^moneyforward-me:moneyforward-account-v1-[0-9a-f]{64}$/u.test(a))
        account(
          "aggregator-mirror",
          "verified-hmac-account-service-tuple-not-direct-account-alias",
        );
      break;
    case "paypay":
      if (a === "paypay")
        account("wallet-export", "export-scope-without-money-or-points-bucket-binding");
      break;
  }
  if (plan.account.reason === "unrecognized-source-account") plan.issues.push(plan.account.reason);
  const unit = input.instrument ?? input.currency;
  if (unit) addUnit(unit, "unit");
  const meta = record(input.extra._kogane);
  if (input.sourceId === "sony-bank" && a === "sony-bank:wallet") {
    const usage = string(record(meta.usageAmount).currency);
    if (usage) addUnit(usage, "usage-unit");
  }
  if (input.sourceId === "sbi-vc-trade") {
    const product = input.securityCode ?? string(input.extra.productId);
    if (product)
      plan.instruments.push({
        role: "security",
        kind: "product",
        namespace: "provider-product",
        scope: "sbi-vc-trade",
        value: product,
        label: product,
        status: "provider-local",
        reason: "provider-product-not-inferred-underlying-coin",
        details: {},
      });
    // Parser-supplied explicit pair fields only; never split product symbols.
    const pair = record(meta.currencyPair);
    const base = string(pair.base);
    const quote = string(pair.quote);
    if (base) addUnit(base, "trade-unit");
    if (quote && !unit) addUnit(quote, "unit");
    else if (quote && quote !== unit) plan.issues.push("execution-quote-unit-conflict");
  }
  return plan;

  function addUnit(code: string, role: InstrumentIdentity["role"]) {
    let identity = currencyIdentity(code, role);
    if (identity.status === "unresolved") {
      identity = { ...identity, scope: input.sourceId };
      if (input.sourceId === "sbi-vc-trade")
        identity = {
          ...identity,
          kind: "crypto",
          namespace: "provider-asset-code",
          status: "provider-local",
          reason: "explicit-exchange-asset-code-without-global-token-binding",
        };
    }
    if (
      !plan.instruments.some(
        (i) =>
          i.role === identity.role &&
          i.namespace === identity.namespace &&
          i.value === identity.value,
      )
    )
      plan.instruments.push(identity);
  }
}
