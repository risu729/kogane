import type { InstrumentIdentity } from "./types.ts";

// Explicit currency catalog: arbitrary three-letter provider codes are not ISO evidence.
const FIAT = new Set([
  "JPY",
  "USD",
  "AUD",
  "CAD",
  "CHF",
  "CNY",
  "EUR",
  "GBP",
  "HKD",
  "NZD",
  "SEK",
  "ZAR",
  "BRL",
  "SGD",
  "NOK",
  "DKK",
  "KRW",
  "TWD",
  "THB",
  "MXN",
  "TRY",
  "INR",
  "IDR",
  "PHP",
  "MYR",
  "PLN",
  "CZK",
  "HUF",
  "AED",
  "SAR",
]);

export function currencyIdentity(
  code: string,
  role: InstrumentIdentity["role"] = "unit",
): InstrumentIdentity {
  if (FIAT.has(code))
    return {
      role,
      kind: "money",
      namespace: "iso4217",
      scope: "global",
      value: code,
      label: code,
      status: "identified",
      reason: "explicit-currency-catalog",
      details: {},
    };
  if (code === "CNH")
    return {
      role,
      kind: "money",
      namespace: "currency-variant",
      scope: "offshore-renminbi",
      value: code,
      label: "CNH (offshore renminbi)",
      status: "identified",
      reason: "offshore-variant-not-iso-cny",
      details: { variant: "offshore" },
    };
  if (code === "V_POINT")
    return {
      role,
      kind: "reward",
      namespace: "reward-program",
      scope: "v-point",
      value: code,
      label: "Vポイント",
      status: "identified",
      reason: "explicit-reward-program",
      details: {},
    };
  return {
    role,
    kind: "unknown",
    namespace: "unresolved-currency",
    scope: "provider",
    value: code,
    label: code,
    status: "unresolved",
    reason: "currency-not-in-explicit-catalog",
    details: {},
  };
}
