import type { Observation, Parser } from "../types.ts";
import { containerClaim } from "./coverage.ts";
import { decodeUtf8, unitScopeAdmitted } from "./util.ts";
import {
  exactKeys,
  exactMoney,
  strictObject,
  strictSafeInteger,
  strictString,
} from "./sbi-strict.ts";

const CURRENCIES = new Set([
  "AUD",
  "BRL",
  "CAD",
  "CHF",
  "CNH",
  "EUR",
  "GBP",
  "HKD",
  "JPY",
  "NZD",
  "SEK",
  "USD",
  "ZAR",
]);

/** Only provider-stated annual figures; detail movements are never income. */
export const sonyBankRealisedGains: Parser = {
  name: "sony-bank-realised-gains",
  version: "1.0.0",
  accepts: (artifact) => artifact.sourceId === "sony-bank" && artifact.dataset === "realised-gains",
  parse(bytes, artifact) {
    if (
      (artifact.runStatus !== "success" || artifact.runFailureCount !== 0) &&
      !unitScopeAdmitted(artifact)
    )
      throw new Error("Sony realised gains require a successful run");
    if (artifact.mime !== "application/json")
      throw new Error("Sony realised gains media type drift");
    const body = strictObject(JSON.parse(decodeUtf8(bytes)), "realised gains");
    if (!Array.isArray(body.errors) || body.errors.length !== 0)
      throw new Error("Sony realised gains provider errors");
    const common = strictObject(body.responseBizCommon, "responseBizCommon");
    exactKeys(common, ["bizResult", "exceptionRsn"], "responseBizCommon");
    if (
      common.bizResult !== "0" ||
      !Array.isArray(common.exceptionRsn) ||
      common.exceptionRsn.length !== 0
    )
      throw new Error("Sony realised gains provider errors");
    // Nonempty valuation portfolios have not been observed. Keep that separate
    // from the independently observed realised summary schema.
    const unit = /^realised-year-(\d{4})$/u.exec(artifact.fetchUnitKey ?? "");
    const selectedYear = /^realised-gains-(\d{4})\.json$/u.exec(artifact.artifactKey ?? "")?.[1];
    if (!unit || unit[1] !== selectedYear) throw new Error("Sony realised year scope drift");
    const observations: Observation[] = [];
    const years: string[] = [];
    for (const [yearKey, prefix, label] of [
      ["rliztnPrftLsCy", "cy", "Cy"],
      ["rliztnPrftLsLy", "ly", "Ly"],
    ] as const) {
      const year = strictString(body[yearKey], yearKey, { pattern: /^\d{4}$/u });
      years.push(year);
      for (const key of [`${prefix}AgrRliztnPrftLs`, `${prefix}AgrItrAmt`])
        exactMoney(body[key], "JPY", key);
      const rows = body[`${prefix}CcySepRliztnPrftLsFcplSi`];
      const count = strictSafeInteger(body[`${prefix}CcySepRliztnPrftLsCnt`], "currency count");
      if (!Array.isArray(rows) || rows.length !== count || rows.length > 13)
        throw new Error("Sony realised currency count drift");
      const seen = new Set<string>();
      for (const [index, value] of rows.entries()) {
        const row = strictObject(value, "annual currency summary");
        exactKeys(
          row,
          ["currencyCd", `${prefix}RliztnPrftLs`, `${prefix}ItrAmt`],
          "annual currency summary",
        );
        const currency = strictString(row.currencyCd, "currencyCd");
        if (!CURRENCIES.has(currency) || seen.has(currency))
          throw new Error("Sony realised currency drift");
        seen.add(currency);
        for (const [field, metric] of [
          [`${prefix}RliztnPrftLs`, "annual_realised_fx_gain"],
          [`${prefix}ItrAmt`, "annual_after_tax_interest"],
        ] as const) {
          const money = exactMoney(row[field], "JPY", field);
          if (year !== selectedYear) continue;
          observations.push({
            kind: "valuation",
            sourceAccount: `sony-bank:deposit:${currency}`,
            subject: `sony-bank:realised:${year}:${currency}`,
            metric,
            amountMinor: money.minor,
            amountText: money.text,
            amountScale: money.scale,
            currency: "JPY",
            rawLocator: `json:$.${prefix}CcySepRliztnPrftLsFcplSi[${index}].${field}`,
            extra: {
              ...row,
              _kogane: {
                sourceView: "official-annual-summary",
                period: year,
                summaryLabel: label,
                sourceCurrency: currency,
                periodState: prefix === "cy" ? "year-to-date" : "previous-year",
                incomeRecognition: "evidence-only",
              },
            },
          });
        }
      }
    }
    if (!years.includes(selectedYear!) || Number(years[0]) !== Number(years[1]) + 1)
      throw new Error("Sony realised years drift");
    return {
      observations,
      warnings: [],
      issues: [],
      coverage: [
        containerClaim({
          artifact,
          issues: [],
          observedCount: observations.length,
          expectedCount: observations.length,
          evidenceRefs: ["json:$.cyCcySepRliztnPrftLsFcplSi", "json:$.lyCcySepRliztnPrftLsFcplSi"],
        }),
      ],
    };
  },
};
