import type { ArtifactMeta, Observation, Parser, ParseResult } from "../types.ts";
import {
  acceptsSbiVcDataset,
  collisionFreeTuple,
  parseSbiVcPage,
  providerExtra,
  providerTimestamp,
  requireNonEmptyString,
  SBI_VC_MAX_PAGES,
  SBI_VC_SOURCE_ACCOUNT,
  warnAttributeValueObject,
  warnNonStringFields,
  warnUnknownFields,
} from "./sbi-vc-common.ts";
import { ParseDiagnostics } from "./coverage.ts";
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
  version: "0.2.0",

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
    const diagnostics = new ParseDiagnostics();
    const observations: Observation[] = [];
    const observedAt = providerTimestamp(page.meta["timestamp"]);
    const externalIds = new Set<string>();

    page.list.forEach((entry: unknown, index: number) => {
      const locator = `json:$.body.list[${index}]`;
      if (!isObject(entry)) {
        throw new Error(`${locator}: expected an execution object`);
      }
      warnUnknownFields(entry, ITEM_FIELDS, locator, diagnostics);
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
        diagnostics,
      );
      for (const field of ["isAuction", "isCorrectedOrderExec"] as const) {
        if (typeof entry[field] !== "boolean") {
          diagnostics.warnings.push(`${locator}.${field}: expected a boolean; raw value preserved`);
        }
      }
      for (const field of ["executionNotifyId", "markup"] as const) {
        if (entry[field] !== null && typeof entry[field] !== "string") {
          diagnostics.warnings.push(
            `${locator}.${field}: expected a string or null; raw value preserved`,
          );
        }
      }
      warnAttributeValueObject(entry["isCloseOrder"], `${locator}.isCloseOrder`, diagnostics);
      warnAttributeValueObject(entry["isExOrder"], `${locator}.isExOrder`, diagnostics);
      const executionId = requireNonEmptyString(entry, "CExecutionId", locator);
      const executionSubNumber = requireNonEmptyString(entry, "CExecutionIdSubNo", locator);
      const productId = requireNonEmptyString(entry, "productId", locator);
      const currencyPair = requireNonEmptyString(entry, "currencyPair", locator);
      const pairMatch = currencyPair.match(/^([A-Z0-9]+)\/([A-Z0-9]+)$/u);
      if (!pairMatch) {
        throw new Error(`${locator}.currencyPair: expected the audited BASE/QUOTE form`);
      }
      const quantity = decimalText(entry["executionAmount"]);
      const price = decimalText(entry["executionPrice"]);
      if (!quantity) {
        throw new Error(`${locator}.executionAmount: expected an exact decimal`);
      }
      if (!price) {
        throw new Error(`${locator}.executionPrice: expected an exact decimal`);
      }
      const buySell = entry["buySellType"];
      const buySellValue = warnAttributeValueObject(buySell, `${locator}.buySellType`, diagnostics)
        ? buySell["value"]
        : undefined;
      let direction: "buy" | "sell";
      if (buySellValue === "3") direction = "buy";
      else if (buySellValue === "1") direction = "sell";
      else throw new Error(`${locator}.buySellType.value: unknown execution direction`);
      const asOf = providerTimestamp(entry["executionDatetime"]);
      if (asOf === undefined) {
        throw new Error(`${locator}.executionDatetime: timestamp format is not recognized`);
      }
      const externalId = collisionFreeTuple(executionId, executionSubNumber);
      if (externalIds.has(externalId)) {
        throw new Error(`${locator}: duplicate composite execution identity`);
      }
      externalIds.add(externalId);
      observations.push({
        kind: "transaction",
        sourceAccount: SBI_VC_SOURCE_ACCOUNT,
        externalId,
        description: productId,
        asOf,
        ...(observedAt !== undefined ? { observedAt } : {}),
        rawLocator: locator,
        extra: providerExtra(entry, page, ["list"], {
          sourceView,
          externalIdComponents: [executionId, executionSubNumber],
          direction,
          quantity: { ...quantity, currency: pairMatch[1] },
          price: { ...price, currency: pairMatch[2] },
          currencyPair: { base: pairMatch[1], quote: pairMatch[2] },
        }),
      });
    });
    return { observations, warnings: diagnostics.warnings };
  },
};
