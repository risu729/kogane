import type { ArtifactMeta, Observation, Parser, ParseResult } from "../types.ts";
import { decodeUtf8 } from "./util.ts";
import {
  exactKeys,
  exactMoney,
  exactDecimal,
  normalizedDate,
  stableFingerprint,
  strictBoolean,
  strictObject,
  strictString,
} from "./sbi-strict.ts";

const SOURCE_ACCOUNT = "sbi-securities:foreign";
const ROOT_KEYS = ["pages"] as const;
const PAGE_KEYS = ["checkJrNisaOpen", "listTradeRecords"] as const;
const LIST_KEYS = ["page", "tradeRecords"] as const;
const RECORD_KEYS = [
  "amount",
  "listedSecuritiesStatus",
  "marginCloseLimitType",
  "orderPriceKindCode",
  "price",
  "quantity",
  "securities",
  "settlementCurrencyCode",
  "specificAccountCode",
  "tradeCurrencyCode",
  "tradeDate",
  "tradeRecordTypeCode",
  "valueDate",
] as const;
const SECURITY_KEYS = [
  "countryCode",
  "ric",
  "securitiesCode",
  "securitiesName",
  "securitiesShortName",
] as const;
const CONTROL_CODE = /^[A-Z0-9_-]*$/u;

export const sbiForeignTradeRecords: Parser = {
  name: "sbi-foreign-trade-records",
  version: "1.0.0",

  accepts(artifact: ArtifactMeta): boolean {
    return artifact.sourceId === "sbi-securities" && artifact.dataset === "foreign-trade-records";
  },

  parse(bytes: Uint8Array): ParseResult {
    const body = strictObject(JSON.parse(decodeUtf8(bytes)), "foreign-trade-records");
    exactKeys(body, ROOT_KEYS, "foreign-trade-records");
    const pages = body["pages"];
    if (!Array.isArray(pages) || pages.length === 0 || pages.length > 1_000) {
      throw new Error("pages must be a non-empty bounded array");
    }
    const occurrences = new Map<string, number>();
    const observations: Observation[] = [];
    pages.forEach((pageValue, pageIndex) => {
      const pageLabel = `pages[${pageIndex}]`;
      const page = strictObject(pageValue, pageLabel);
      exactKeys(page, PAGE_KEYS, pageLabel);
      const nisa = strictObject(page["checkJrNisaOpen"], `${pageLabel}.checkJrNisaOpen`);
      exactKeys(nisa, ["opened"], `${pageLabel}.checkJrNisaOpen`);
      strictBoolean(nisa["opened"], `${pageLabel}.checkJrNisaOpen.opened`);
      const list = strictObject(page["listTradeRecords"], `${pageLabel}.listTradeRecords`);
      exactKeys(list, LIST_KEYS, `${pageLabel}.listTradeRecords`);
      const pageInfo = strictObject(list["page"], `${pageLabel}.listTradeRecords.page`);
      exactKeys(pageInfo, ["hasNextPage"], `${pageLabel}.listTradeRecords.page`);
      const hasNextPage = strictBoolean(
        pageInfo["hasNextPage"],
        `${pageLabel}.listTradeRecords.page.hasNextPage`,
      );
      if (hasNextPage !== pageIndex < pages.length - 1) {
        throw new Error(`${pageLabel} pagination is incomplete or has an extra page`);
      }
      const records = list["tradeRecords"];
      if (!Array.isArray(records) || records.length > 10_000) {
        throw new Error(`${pageLabel}.listTradeRecords.tradeRecords must be a bounded array`);
      }
      records.forEach((recordValue, recordIndex) => {
        const label = `${pageLabel}.listTradeRecords.tradeRecords[${recordIndex}]`;
        const record = strictObject(recordValue, label);
        exactKeys(record, RECORD_KEYS, label);
        const security = strictObject(record["securities"], `${label}.securities`);
        exactKeys(security, SECURITY_KEYS, `${label}.securities`);
        const code = strictString(
          security["securitiesCode"],
          `${label}.securities.securitiesCode`,
          {
            max: 32,
            pattern: /^[A-Z0-9.:-]+$/u,
          },
        );
        const country = strictString(security["countryCode"], `${label}.securities.countryCode`, {
          max: 3,
          pattern: /^[A-Z]{2,3}$/u,
        });
        if (country !== "US") throw new Error(`${label} has an unsupported countryCode`);
        const name = strictString(
          security["securitiesName"],
          `${label}.securities.securitiesName`,
          {
            empty: true,
            max: 256,
          },
        );
        strictString(security["securitiesShortName"], `${label}.securities.securitiesShortName`, {
          empty: true,
          max: 256,
        });
        strictString(security["ric"], `${label}.securities.ric`, { empty: true, max: 64 });
        for (const field of [
          "listedSecuritiesStatus",
          "marginCloseLimitType",
          "orderPriceKindCode",
          "specificAccountCode",
          "tradeRecordTypeCode",
        ] as const) {
          strictString(record[field], `${label}.${field}`, {
            empty: true,
            max: 64,
            pattern: CONTROL_CODE,
          });
        }
        const tradeCurrency = strictString(
          record["tradeCurrencyCode"],
          `${label}.tradeCurrencyCode`,
          {
            max: 3,
            pattern: /^[A-Z]{3}$/u,
          },
        );
        const settlementCurrency = strictString(
          record["settlementCurrencyCode"],
          `${label}.settlementCurrencyCode`,
          { max: 3, pattern: /^[A-Z]{3}$/u },
        );
        if (
          !new Set(["JPY", "USD"]).has(tradeCurrency) ||
          !new Set(["JPY", "USD"]).has(settlementCurrency)
        ) {
          throw new Error(`${label} has an unsupported currency`);
        }
        const amount = exactMoney(record["amount"], settlementCurrency, `${label}.amount`);
        const quantity = exactDecimal(record["quantity"], `${label}.quantity`);
        exactMoney(record["price"], tradeCurrency, `${label}.price`);
        const tradeDate = normalizedDate(record["tradeDate"], `${label}.tradeDate`);
        const valueDate = normalizedDate(record["valueDate"], `${label}.valueDate`);
        const fingerprint = stableFingerprint(record);
        const occurrence = occurrences.get(fingerprint) ?? 0;
        occurrences.set(fingerprint, occurrence + 1);
        observations.push({
          kind: "transaction",
          sourceAccount: SOURCE_ACCOUNT,
          externalId: `sbi-foreign-trade:${fingerprint}:${occurrence}`,
          status: "posted",
          amountMinor: amount.minor,
          amountText: amount.text,
          amountScale: amount.scale,
          currency: settlementCurrency,
          description: name || code,
          asOf: tradeDate,
          rawLocator: `json:$.pages[${pageIndex}].listTradeRecords.tradeRecords[${recordIndex}]`,
          extra: {
            ...record,
            _kogane: {
              transactionType: record["tradeRecordTypeCode"],
              tradeCurrency,
              tradeDate,
              valueDate,
              quantityText: quantity.text,
              quantityScale: quantity.scale,
              identityOrigin: "canonical-provider-row+occurrence",
            },
          },
        });
      });
    });
    return { observations, warnings: [] };
  },
};
