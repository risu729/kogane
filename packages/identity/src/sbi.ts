import { currencyIdentity } from "./instruments.ts";
import {
  record,
  string,
  type IdentityInput,
  type IdentityPlan,
  type InstrumentIdentity,
} from "./types.ts";

const MARKETS: Record<string, string> = {
  TKY: "XTKS",
  NGY: "XNGO",
  FKO: "XFKA",
  SPR: "XSAP",
  東証: "XTKS",
  名証: "XNGO",
  福証: "XFKA",
  札証: "XSAP",
};
const MICS = new Set(Object.values(MARKETS));
const CUSTODY_LABELS: Record<string, string> = {
  "0": "特定預り",
  "1": "一般預り",
  "-": "一般預り",
  H: "成長投資枠",
  "4": "NISA預り",
  "5": "ジュニアNISA預り",
  "6": "ジュニアNISA預り",
  "7": "ジュニアNISA預り",
  J: "ジュニアNISA預り",
};

/** Provider references are evidence of identity, not an external security-master match. */
export function sbiIdentity(input: IdentityInput): IdentityPlan {
  if (input.sourceId !== "sbi-securities")
    throw new Error("SBI identity requires sbi-securities input");
  const extra = input.extra;
  const aggregate = input.sourceAccount === "sbi-securities:account-assets";
  const foreign = input.sourceAccount === "sbi-securities:foreign";
  const domestic =
    input.sourceAccount === "sbi-securities:domestic" ||
    input.sourceAccount.startsWith("sbi-securities:domestic:deposit-type=");
  const yen = input.sourceAccount === "sbi-securities:yen-cash";
  const issues: string[] = [];
  const key = [input.sourceAccount];
  // Preserve exact discriminator namespaces and values. Similar tax labels do
  // not establish equality between the domestic and foreign provider systems.
  if (foreign) {
    const discriminator =
      input.kind === "balance"
        ? string(record(extra.account).accountKind)
        : string(extra.specificAccountCode);
    const field = input.kind === "balance" ? "accountKind" : "specificAccountCode";
    if (discriminator !== null) key.push(field, discriminator);
    else issues.push(`missing-${field}`);
  } else if (domestic && input.kind === "transaction") {
    const label = string(extra.accountLabel);
    if (label !== null) key.push("accountLabel", label);
    else issues.push("missing-accountLabel");
  }
  if (domestic) {
    const deposit = string(extra.depositTypeCode);
    const suffix = input.sourceAccount.split(":deposit-type=")[1];
    if (deposit !== null && suffix !== undefined && suffix !== deposit) {
      key.push("conflicting-depositTypeCode", deposit);
      issues.push("conflicting-depositTypeCode");
    }
  }
  const instruments: InstrumentIdentity[] = [];
  const unit = input.kind === "balance" ? input.instrument : input.currency;
  if (unit !== null) instruments.push(currencyIdentity(unit, "unit"));
  else issues.push("missing-monetary-unit");
  if (foreign && input.kind === "transaction") {
    const trade = string(extra.tradeCurrencyCode);
    if (trade !== null) instruments.push(currencyIdentity(trade, "trade-unit"));
    else issues.push("missing-trade-currency");
    const settlement = string(extra.settlementCurrencyCode);
    if (settlement !== null && settlement !== input.currency)
      issues.push("conflicting-settlement-currency");
  }
  if (!aggregate && (domestic || foreign) && input.kind !== "balance") {
    const security = record(extra.securities);
    const code = domestic
      ? string(
          input.kind === "transaction"
            ? extra.issueCode
            : input.kind === "valuation"
              ? input.subject
              : input.securityCode,
        )
      : (string(security.securitiesCode) ?? string(input.securityCode) ?? string(input.subject));
    const ric = foreign ? string(security.ric) : null;
    const country = foreign ? (string(security.countryCode) ?? string(extra.countryCode)) : "JP";
    const rawMarket = domestic
      ? (string(input.market) ??
        string(record(extra._kogane).marketCode) ??
        string(extra.marketLabel))
      : (string(record(extra.market).marketCode) ?? string(input.market));
    const mic =
      rawMarket !== null && domestic
        ? MICS.has(rawMarket)
          ? rawMarket
          : (MARKETS[rawMarket] ?? null)
        : null;
    const details: Record<string, string> = {};
    if (code !== null) details.securityCode = code;
    if (country !== null) details.countryCode = country;
    if (rawMarket !== null) details.providerMarket = rawMarket;
    if (ric !== null) details.ric = ric;
    const value = ric ?? code;
    if (value !== null) {
      const displayName =
        string(input.securityName) ?? string(security.securitiesName) ?? string(extra.issueName);
      instruments.push({
        role: "security",
        kind: "security",
        namespace: ric !== null ? "ric" : mic !== null ? "mic-symbol" : "sbi-security-code",
        scope: ric !== null ? "" : (mic ?? country ?? "unknown-country"),
        value,
        label: displayName ?? value,
        status: "provider-local",
        reason:
          ric !== null
            ? "provider-reported-ric"
            : mic !== null
              ? "provider-reported-listing"
              : "provider-code-without-global-crosswalk",
        details,
      });
      if (ric === null && mic === null) issues.push("security-without-global-crosswalk");
    } else {
      issues.push("missing-security-identifier");
    }
  }
  const known = aggregate || foreign || domestic || yen;
  if (!known) issues.push("unknown-sbi-account-scope");
  let label = "SBI証券（口座区分未確定）";
  if (aggregate) label = "SBI証券 資産集計";
  else if (yen) label = "SBI証券 円貨預り金";
  else if (foreign) {
    const cash = input.kind === "balance";
    const discriminator = cash
      ? string(record(extra.account).accountKind)
      : string(extra.specificAccountCode);
    label = `SBI証券 ${cash ? "外貨預り金" : "外国株式"}（${cash ? "口座区分" : "預り区分"}: ${discriminator ?? "未確定"}）`;
  } else if (domestic) {
    const deposit = input.sourceAccount.split(":deposit-type=")[1];
    label =
      deposit !== undefined
        ? `SBI証券 国内株式 ${CUSTODY_LABELS[deposit] ?? "預り区分未確定"}（区分コード: ${deposit}）`
        : `SBI証券 国内株式（預り区分: ${string(extra.accountLabel) ?? "未確定"}）`;
  }
  return {
    account: {
      key,
      label,
      role: aggregate
        ? "aggregate"
        : foreign
          ? "foreign-brokerage"
          : domestic
            ? "domestic-brokerage"
            : yen
              ? "cash"
              : "unknown",
      status: aggregate
        ? "aggregate"
        : known &&
            !issues.some(
              (issue) =>
                issue.startsWith("missing-account") ||
                issue === "missing-specificAccountCode" ||
                issue === "conflicting-depositTypeCode",
            )
          ? "provider-local"
          : "unresolved",
      reason: aggregate
        ? "provider-portfolio-summary-not-separate-account"
        : "exact-provider-account-reference",
    },
    instruments,
    issues,
  };
}
