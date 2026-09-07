import type { ArtifactMeta, Observation, Parser, ParseResult } from "../types.ts";
import { decodeUtf8 } from "./util.ts";
import {
  exactKeys,
  exactDecimal,
  exactMoney,
  normalizedDate,
  strictBoolean,
  strictObject,
  strictSafeInteger,
  strictString,
} from "./sbi-strict.ts";

const SOURCE_ACCOUNT = "sbi-securities:yen-cash";
const ROOT_KEYS = [
  "depositRecordList",
  "detailsConditions",
  "exceededMaxCount",
  "isExceededMaxCount",
  "nextBusinessDate",
  "pageCount",
  "pageNumber",
  "pageSize",
  "totalCount",
  "totalDepositAmount",
  "totalDepositCount",
  "totalPaymentAmount",
  "totalPaymentCount",
  "totalTransDepositAmount",
  "totalTransDepositCount",
  "totalTransPaymentAmount",
  "totalTransPaymentCount",
] as const;
const RECORD_KEYS = [
  "detailKbn",
  "did",
  "dispAbstract",
  "payAmount",
  "payDepDate",
  "payDepKbn",
] as const;

export const sbiYenDetailHistory: Parser = {
  name: "sbi-yen-detail-history",
  version: "1.0.0",

  accepts(artifact: ArtifactMeta): boolean {
    return artifact.sourceId === "sbi-securities" && artifact.dataset === "yen-detail-history";
  },

  parse(bytes: Uint8Array): ParseResult {
    const body = strictObject(JSON.parse(decodeUtf8(bytes)), "yen-detail-history");
    exactKeys(body, ROOT_KEYS, "yen-detail-history");
    const records = body["depositRecordList"];
    if (!Array.isArray(records)) throw new Error("depositRecordList must be an array");
    if (records.length > 10_000) throw new Error("depositRecordList exceeds the parser bound");

    const detailsConditions = body["detailsConditions"];
    if (
      !Array.isArray(detailsConditions) ||
      detailsConditions.some((entry) => typeof entry !== "string")
    ) {
      throw new Error("detailsConditions must be a string array");
    }
    const exceeded = strictBoolean(body["exceededMaxCount"], "exceededMaxCount");
    const isExceeded = strictBoolean(body["isExceededMaxCount"], "isExceededMaxCount");
    if (exceeded !== isExceeded) throw new Error("yen history exceeded flags disagree");
    if (exceeded) throw new Error("yen history is truncated");
    strictString(body["nextBusinessDate"], "nextBusinessDate", {
      empty: true,
      max: 10,
      pattern: /^\d*$/u,
    });
    const pageCount = strictSafeInteger(body["pageCount"], "pageCount", { minimum: 0 });
    const pageNumber = strictSafeInteger(body["pageNumber"], "pageNumber", { minimum: 0 });
    const pageSize = strictSafeInteger(body["pageSize"], "pageSize", {
      minimum: 0,
      maximum: 10_000,
    });
    const totalCount = strictSafeInteger(body["totalCount"], "totalCount", { minimum: 0 });
    if (
      records.length !== totalCount ||
      records.length > pageSize ||
      (totalCount > 0 && pageCount < 1)
    ) {
      throw new Error("yen history pagination/count fields do not describe the stored rows");
    }
    if (pageNumber > pageCount) throw new Error("pageNumber exceeds pageCount");
    for (const field of ROOT_KEYS.filter((key) => key.endsWith("Amount"))) {
      exactMoney(body[field], "JPY", field);
    }
    for (const field of ROOT_KEYS.filter(
      (key) => key.startsWith("total") && key.endsWith("Count") && key !== "totalCount",
    )) {
      const count = exactDecimal(body[field], field);
      if (count.scale !== 0) throw new Error(`${field} must be an integer count`);
    }

    const seenIds = new Set<number>();
    const observations: Observation[] = records.map((value, index) => {
      const label = `depositRecordList[${index}]`;
      const record = strictObject(value, label);
      exactKeys(record, RECORD_KEYS, label);
      const did = strictSafeInteger(record["did"], `${label}.did`, { minimum: 1 });
      if (seenIds.has(did)) throw new Error(`${label}.did is duplicated`);
      seenIds.add(did);
      const direction = strictString(record["payDepKbn"], `${label}.payDepKbn`, {
        max: 2,
        pattern: /^(入金|出金)$/u,
      });
      const detail = strictString(record["detailKbn"], `${label}.detailKbn`, { max: 128 });
      const description = strictString(record["dispAbstract"], `${label}.dispAbstract`, {
        empty: true,
        max: 512,
      });
      const amount = exactMoney(record["payAmount"], "JPY", `${label}.payAmount`);
      const asOf = normalizedDate(record["payDepDate"], `${label}.payDepDate`);
      const transactionType =
        detail.includes("振替") || detail.includes("入出金")
          ? "transfer"
          : direction === "入金"
            ? "deposit"
            : "withdrawal";
      return {
        kind: "transaction",
        sourceAccount: SOURCE_ACCOUNT,
        externalId: `sbi-yen-detail:${did}`,
        status: "posted",
        amountMinor: amount.minor,
        amountText: amount.text,
        amountScale: amount.scale,
        currency: "JPY",
        description: description || detail,
        asOf,
        rawLocator: `json:$.depositRecordList[${index}]`,
        extra: {
          ...record,
          _kogane: { direction: direction === "入金" ? "credit" : "debit", transactionType },
        },
      };
    });
    return { observations, warnings: [] };
  },
};
