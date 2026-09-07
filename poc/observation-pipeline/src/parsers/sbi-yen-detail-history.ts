// Parser for the validated page bundle emitted by sbi-securities-worker.
// Each provider page and row is retained verbatim. The duplicate pagination
// checks here intentionally repeat the collector/importer boundary checks so
// legacy or manually ingested truncated artifacts cannot become observations.

import type { ArtifactMeta, Observation, Parser, ParseResult } from "../types.ts";
import { decodeUtf8, isObject } from "./util.ts";
import {
  exactDecimal,
  exactMoney,
  normalizedDate,
  strictBoolean,
  strictSafeInteger,
  strictString,
} from "./sbi-strict.ts";

const SOURCE_ACCOUNT = "sbi-securities:yen-cash";
const SCHEMA_VERSION = "sbi-yen-detail-history-bundle-v1";
const MAX_PAGES = 200;
const MAX_ROWS = 20_000;
const MAX_PAGE_SIZE = 1_000;
const BUNDLE_KEYS = [
  "schemaVersion",
  "pageCount",
  "pageSize",
  "totalCount",
  "complete",
  "pageLimitExceeded",
  "rowLimitExceeded",
  "pages",
] as const;
const PAGE_KEYS = [
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
  version: "1.0.2",

  accepts(artifact: ArtifactMeta): boolean {
    return artifact.sourceId === "sbi-securities" && artifact.dataset === "yen-detail-history";
  },

  parse(bytes: Uint8Array, artifact: ArtifactMeta): ParseResult {
    const body: unknown = JSON.parse(decodeUtf8(bytes));
    const legacy =
      isObject(body) &&
      !Object.hasOwn(body, "schemaVersion") &&
      Object.hasOwn(body, "depositRecordList");
    let input = body;
    let legacySingleLimitFlag = false;
    if (legacy) {
      // Earlier direct responses contain only the primary isExceededMaxCount
      // flag. Recognize that exact schema, with an explicit false still required.
      // Canonical bundles remain strict about both agreeing flags.
      legacySingleLimitFlag = !Object.hasOwn(body, "exceededMaxCount");
      const original = exactObject(
        body,
        legacySingleLimitFlag ? PAGE_KEYS.filter((key) => key !== "exceededMaxCount") : PAGE_KEYS,
        "legacy page",
      );
      const page = legacySingleLimitFlag
        ? { ...original, exceededMaxCount: original["isExceededMaxCount"] }
        : original;
      const records = page["depositRecordList"];
      const empty = page["totalCount"] === 0;
      if (
        !(
          (page["pageCount"] === 1 && page["pageNumber"] === 1) ||
          (empty && page["pageCount"] === 0 && page["pageNumber"] === 0)
        ) ||
        !Array.isArray(records) ||
        records.length !== page["totalCount"] ||
        page["exceededMaxCount"] !== false ||
        page["isExceededMaxCount"] !== false
      ) {
        throw new Error("legacy yen history is not a complete single page");
      }
      // Reuse all canonical page/record validation only after direct metadata
      // proves single-page coverage. Bytes and raw locators remain the original.
      input = {
        schemaVersion: SCHEMA_VERSION,
        pageCount: 1,
        pageSize: page["pageSize"],
        totalCount: page["totalCount"],
        complete: true,
        pageLimitExceeded: false,
        rowLimitExceeded: false,
        pages: [page],
      };
    }
    const bundle = exactObject(input, BUNDLE_KEYS, "bundle");
    if (bundle["schemaVersion"] !== SCHEMA_VERSION) {
      throw new Error(`artifact ${artifact.sha256} has an unsupported yen history schema`);
    }
    const pageCount = count(bundle["pageCount"], 1, MAX_PAGES, "pageCount");
    const pageSize = count(bundle["pageSize"], 1, MAX_PAGE_SIZE, "pageSize");
    const totalCount = count(bundle["totalCount"], 0, MAX_ROWS, "totalCount");
    if (
      bundle["complete"] !== true ||
      bundle["pageLimitExceeded"] !== false ||
      bundle["rowLimitExceeded"] !== false
    ) {
      throw new Error("yen history bundle is incomplete or exceeded a collection limit");
    }
    const pages = bundle["pages"];
    if (!Array.isArray(pages) || pages.length !== pageCount) {
      throw new Error("yen history page inventory does not match pageCount");
    }

    const observations: Observation[] = [];
    const warnings: string[] = [];
    const seenIds = new Set<number>();
    let rowCount = 0;
    for (const [pageIndex, rawPage] of pages.entries()) {
      const page = exactObject(rawPage, PAGE_KEYS, `pages[${pageIndex}]`);
      const providerPageCount = count(page["pageCount"], 0, MAX_PAGES, "provider pageCount");
      const providerPageNumber = count(page["pageNumber"], 0, MAX_PAGES, "provider pageNumber");
      if (page["pageSize"] !== pageSize || page["totalCount"] !== totalCount) {
        throw new Error(`pages[${pageIndex}] pagination metadata changed`);
      }
      const exceeded = strictBoolean(
        page["exceededMaxCount"],
        `pages[${pageIndex}].exceededMaxCount`,
      );
      const isExceeded = strictBoolean(
        page["isExceededMaxCount"],
        `pages[${pageIndex}].isExceededMaxCount`,
      );
      if (exceeded !== isExceeded) {
        throw new Error(`pages[${pageIndex}] provider exceeded flags disagree`);
      }
      if (exceeded) {
        throw new Error(`pages[${pageIndex}] reports a provider limit exceeded`);
      }
      const detailsConditions = page["detailsConditions"];
      if (
        !Array.isArray(detailsConditions) ||
        detailsConditions.some((entry) => typeof entry !== "string")
      ) {
        throw new Error(`pages[${pageIndex}].detailsConditions must be a string array`);
      }
      strictString(page["nextBusinessDate"], `pages[${pageIndex}].nextBusinessDate`, {
        empty: true,
        max: 10,
        pattern: /^\d*$/u,
      });
      for (const field of PAGE_KEYS.filter((key) => key.endsWith("Amount"))) {
        exactMoney(page[field], "JPY", `pages[${pageIndex}].${field}`);
      }
      for (const field of PAGE_KEYS.filter(
        (key) => key.startsWith("total") && key.endsWith("Count") && key !== "totalCount",
      )) {
        const total = exactDecimal(page[field], `pages[${pageIndex}].${field}`);
        if (total.scale !== 0) throw new Error(`${field} must be an integer count`);
      }
      if (totalCount === 0) {
        if (
          pageIndex !== 0 ||
          !(
            (providerPageCount === 0 && providerPageNumber === 0) ||
            (providerPageCount === 1 && providerPageNumber === 1)
          )
        ) {
          throw new Error("empty yen history has inconsistent page metadata");
        }
      } else if (providerPageCount !== pageCount || providerPageNumber !== pageIndex + 1) {
        throw new Error(`pages[${pageIndex}] is not part of a contiguous complete page chain`);
      }
      const records = page["depositRecordList"];
      if (!Array.isArray(records) || records.length > pageSize) {
        throw new Error(`pages[${pageIndex}].depositRecordList is invalid`);
      }
      rowCount += records.length;
      if (rowCount > MAX_ROWS) throw new Error("yen history row limit exceeded");

      for (const [recordIndex, rawRecord] of records.entries()) {
        const record = exactObject(
          rawRecord,
          RECORD_KEYS,
          `pages[${pageIndex}].depositRecordList[${recordIndex}]`,
        );
        const label = `pages[${pageIndex}].depositRecordList[${recordIndex}]`;
        const did = strictSafeInteger(record["did"], `${label}.did`, { minimum: 1 });
        if (seenIds.has(did)) throw new Error(`yen history contains duplicate did ${did}`);
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
        observations.push({
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
          rawLocator: legacy
            ? `json:$.depositRecordList[${recordIndex}]`
            : `json:$.pages[${pageIndex}].depositRecordList[${recordIndex}]`,
          extra: {
            ...record,
            _kogane: {
              direction: direction === "入金" ? "credit" : "debit",
              transactionType,
              ...(legacy
                ? {
                    sourceEnvelope: "legacy-single-page",
                    ...(legacySingleLimitFlag ? { providerLimitFlag: "isExceededMaxCount" } : {}),
                  }
                : { bundlePageIndex: pageIndex }),
              providerPageNumber,
            },
          },
        });
      }
    }
    if (rowCount !== totalCount) throw new Error("yen history row count does not match totalCount");
    return { observations, warnings };
  },
};

function exactObject(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!isObject(value)) throw new Error(`yen history ${label} is not an object`);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    throw new Error(`yen history ${label} fields changed`);
  }
  return value;
}

function count(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`yen history ${label} is invalid`);
  }
  return value as number;
}
