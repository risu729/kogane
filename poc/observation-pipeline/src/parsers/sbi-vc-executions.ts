import type { ArtifactMeta, Observation, Parser, ParseResult } from "../types.ts";
import {
  acceptsSbiVcDataset,
  collisionFreeTuple,
  parseSbiVcPage,
  providerExtra,
  providerTimestamp,
  requireString,
  SBI_VC_MAX_PAGES,
  SBI_VC_SOURCE_ACCOUNT,
  warnAttributeValueObject,
  warnNonStringFields,
  warnUnknownFields,
} from "./sbi-vc-common.ts";
import { decimalText, isObject } from "./util.ts";

const RECENT_DATASET = "executions-recent-page-0001";
const HISTORICAL_DATASET = /^executions-historical-page-(\d{4})$/u;
const ITEM_FIELDS = [
  "baseCurrencyBalancePl",
  "CExecutionId",
  "CExecutionIdSubNo",
  "baseCurrencyPl",
  "baseCurrencySwapPl",
  "buySellType",
  "commissionAmount",
  "commissionCurrency",
  "currencyPair",
  "executionAmount",
  "executionDatetime",
  "executionDatetimeTimestamp",
  "executionNotifyId",
  "executionPrice",
  "executionYmdDate",
  "fxAccountId",
  "inputExecutionPerson",
  "internalMemo",
  "isAuction",
  "isCloseOrder",
  "isCorrectedOrderExec",
  "isExOrder",
  "markup",
  "orderDatetime",
  "orderPrice",
  "orderType",
  "orderYmdDate",
  "plConversionPrice",
  "productId",
  "publicMemo",
  "settlePl",
  "swapPl",
  "tradeChannelType",
  "tradePrice",
  "valueYmdDate",
] as const;

export const sbiVcExecutions: Parser = {
  name: "sbi-vc-executions",
  version: "0.1.0",

  accepts(artifact: ArtifactMeta): boolean {
    return (
      acceptsSbiVcDataset(artifact, RECENT_DATASET) ||
      acceptsSbiVcDataset(artifact, HISTORICAL_DATASET)
    );
  },

  parse(bytes: Uint8Array, artifact: ArtifactMeta): ParseResult {
    const dataset = artifact.dataset;
    if (dataset === null) throw new Error("sbi-vc execution artifact omitted its dataset");
    const historicalMatch = HISTORICAL_DATASET.exec(dataset);
    const sourceView = dataset === RECENT_DATASET ? "recent" : "historical";
    const expectedPageNumber = sourceView === "recent" ? 0 : Number(historicalMatch?.[1] ?? 0) - 1;
    if (
      !Number.isSafeInteger(expectedPageNumber) ||
      expectedPageNumber < 0 ||
      expectedPageNumber >= SBI_VC_MAX_PAGES
    ) {
      throw new Error(`${dataset}: historical page suffix is invalid`);
    }
    const page = parseSbiVcPage(bytes, dataset, expectedPageNumber);
    if (sourceView === "recent" && page.totalSize > page.pageSize) {
      throw new Error(`${dataset}: recent view exceeds its single collected page`);
    }
    const warnings: string[] = [];
    const observations: Observation[] = [];
    const observedAt = providerTimestamp(page.meta["timestamp"]);

    page.list.forEach((entry: unknown, index: number) => {
      const locator = `json:$.body.list[${index}]`;
      if (!isObject(entry)) {
        warnings.push(`${locator}: expected an execution object; raw element preserved`);
        observations.push({
          kind: "transaction",
          sourceAccount: SBI_VC_SOURCE_ACCOUNT,
          ...(observedAt !== undefined ? { observedAt } : {}),
          rawLocator: locator,
          extra: {
            _kogane: {
              unparsedElement: entry,
              sourceView,
              providerContext: {
                meta: { ...page.meta },
                pageNumber: page.pageNumber,
                pageSize: page.pageSize,
                totalNumOfPages: page.totalNumOfPages,
                totalSize: page.totalSize,
              },
            },
          },
        });
        return;
      }
      warnUnknownFields(entry, ITEM_FIELDS, locator, warnings);
      warnNonStringFields(
        entry,
        ITEM_FIELDS.filter(
          (field) =>
            ![
              "buySellType",
              "isAuction",
              "isCloseOrder",
              "isCorrectedOrderExec",
              "isExOrder",
              "executionNotifyId",
              "markup",
            ].includes(field),
        ),
        locator,
        warnings,
      );
      for (const field of ["isAuction", "isCorrectedOrderExec"] as const) {
        if (typeof entry[field] !== "boolean") {
          warnings.push(`${locator}.${field}: expected a boolean; raw value preserved`);
        }
      }
      for (const field of ["executionNotifyId", "markup"] as const) {
        if (entry[field] !== null && typeof entry[field] !== "string") {
          warnings.push(`${locator}.${field}: expected a string or null; raw value preserved`);
        }
      }
      warnAttributeValueObject(entry["isCloseOrder"], `${locator}.isCloseOrder`, warnings);
      warnAttributeValueObject(entry["isExOrder"], `${locator}.isExOrder`, warnings);
      const executionId = requireString(entry, "CExecutionId", locator, warnings);
      const executionSubNumber = requireString(entry, "CExecutionIdSubNo", locator, warnings);
      const productId = requireString(entry, "productId", locator, warnings);
      const currencyPair = requireString(entry, "currencyPair", locator, warnings);
      const pairMatch = currencyPair?.match(/^([A-Z0-9]+)\/([A-Z0-9]+)$/u);
      if (!pairMatch) {
        warnings.push(`${locator}.currencyPair: expected the audited BASE/QUOTE form`);
      }
      const quantity = decimalText(entry["executionAmount"]);
      const price = decimalText(entry["executionPrice"]);
      if (!quantity) {
        warnings.push(`${locator}.executionAmount: expected an exact decimal; raw value preserved`);
      }
      if (!price) {
        warnings.push(`${locator}.executionPrice: expected an exact decimal; raw value preserved`);
      }
      const buySell = entry["buySellType"];
      const buySellValue = warnAttributeValueObject(buySell, `${locator}.buySellType`, warnings)
        ? buySell["value"]
        : undefined;
      let direction: "buy" | "sell" | undefined;
      if (buySellValue === "3") direction = "buy";
      else if (buySellValue === "1") direction = "sell";
      else warnings.push(`${locator}.buySellType.value: unknown direction; raw value preserved`);
      const asOf = providerTimestamp(entry["executionDatetime"]);
      if (asOf === undefined) {
        warnings.push(`${locator}.executionDatetime: timestamp format is not recognized`);
      }
      const externalId =
        executionId !== undefined && executionSubNumber !== undefined
          ? collisionFreeTuple(executionId, executionSubNumber)
          : undefined;
      if (externalId === undefined) {
        warnings.push(`${locator}: composite execution identity is incomplete`);
      }
      observations.push({
        kind: "transaction",
        sourceAccount: SBI_VC_SOURCE_ACCOUNT,
        ...(externalId !== undefined ? { externalId } : {}),
        ...(productId !== undefined ? { description: productId } : {}),
        ...(asOf !== undefined ? { asOf } : {}),
        ...(observedAt !== undefined ? { observedAt } : {}),
        rawLocator: locator,
        extra: providerExtra(entry, page, ["list"], {
          sourceView,
          ...(executionId !== undefined && executionSubNumber !== undefined
            ? { externalIdComponents: [executionId, executionSubNumber] }
            : {}),
          ...(direction !== undefined ? { direction } : {}),
          ...(quantity !== undefined
            ? {
                quantity: {
                  ...quantity,
                  ...(pairMatch?.[1] ? { currency: pairMatch[1] } : {}),
                },
              }
            : {}),
          ...(price !== undefined
            ? {
                price: {
                  ...price,
                  ...(pairMatch?.[2] ? { currency: pairMatch[2] } : {}),
                },
              }
            : {}),
          ...(pairMatch ? { currencyPair: { base: pairMatch[1], quote: pairMatch[2] } } : {}),
        }),
      });
    });
    return { observations, warnings };
  },
};
