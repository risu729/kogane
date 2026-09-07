import type { ArtifactMeta, Observation, Parser, ParseResult } from "../types.ts";
import {
  acceptsSbiVcDataset,
  balanceFromDecimal,
  parseSbiVcEnvelope,
  providerExtra,
  providerTimestamp,
  requireString,
  warnNonStringFields,
  warnUnknownFields,
} from "./sbi-vc-common.ts";
import { isObject } from "./util.ts";

const DATASET = "account-margin";
const SCALAR_FIELDS = [
  "cashBalance",
  "leaveOrderCommission",
  "leaveOrderSpreadSpotPL",
  "marginBuyingPower",
  "minMarginShortageAmount",
  "netAsset",
  "netAssetRatio",
  "orderingRequiredMargin",
  "positionRequiredMargin",
  "receivedMargin",
  "shortageAmount",
  "statusDate",
  "withdrawalLimit",
] as const;
const AMOUNT_LISTS = [
  ["receivedMarginList", "received_margin"],
  ["restrictedCommissionList", "restricted_commission"],
  ["withdrawalList", "withdrawal"],
] as const;
const LIMIT_LISTS = [
  ["lendingLimitList", "lendingLimit", "lending_limit"],
  ["restrictedWithdrawalAmountList", "restrictedWithdrawalAmount", "restricted_withdrawal_amount"],
  ["withdrawalLimitList", "withdrawalLimit", "withdrawal_limit"],
] as const;
const ATTRIBUTE_FIELDS = [
  "registeredCashOut",
  "uncollectedCommission",
  "unsettledNetPL",
  "unsettledPositionPL",
  "unsettledSwapPL",
] as const;
const BODY_FIELDS = [
  ...SCALAR_FIELDS,
  ...AMOUNT_LISTS.map(([field]) => field),
  ...LIMIT_LISTS.map(([field]) => field),
  ...ATTRIBUTE_FIELDS,
] as const;
const AMOUNT_ITEM_FIELDS = [
  "currency",
  "amount",
  "baseCurrencyAmount",
  "baseCurrencyCollateralAmount",
  "collateralValueRatio",
] as const;
const CHILD_LIST_FIELDS = [
  ...AMOUNT_LISTS.map(([field]) => field),
  ...LIMIT_LISTS.map(([field]) => field),
] as const;

export const sbiVcAccountMargin: Parser = {
  name: "sbi-vc-account-margin",
  version: "0.1.0",

  accepts(artifact: ArtifactMeta): boolean {
    return acceptsSbiVcDataset(artifact, DATASET);
  },

  parse(bytes: Uint8Array): ParseResult {
    const envelope = parseSbiVcEnvelope(bytes, DATASET);
    const warnings: string[] = [];
    warnUnknownFields(envelope.body, BODY_FIELDS, "json:$.body", warnings);
    for (const field of SCALAR_FIELDS) {
      if (typeof envelope.body[field] !== "string") {
        throw new Error(`${DATASET}: ${field} must be a string`);
      }
    }
    for (const [field] of [...AMOUNT_LISTS, ...LIMIT_LISTS]) {
      if (!Array.isArray(envelope.body[field])) {
        throw new Error(`${DATASET}: ${field} must be an array`);
      }
    }
    for (const field of ATTRIBUTE_FIELDS) {
      const value = envelope.body[field];
      if (!isObject(value)) throw new Error(`${DATASET}: ${field} must be an object`);
      warnUnknownFields(value, ["attribute", "value"], `json:$.body.${field}`, warnings);
      if (typeof value["attribute"] !== "string" || typeof value["value"] !== "string") {
        throw new Error(`${DATASET}: ${field} fields must be strings`);
      }
    }

    const observedAt = providerTimestamp(envelope.meta["timestamp"]);
    const asOf = providerTimestamp(envelope.body["statusDate"]);
    const observations: Observation[] = [];
    for (const [listField, metric] of AMOUNT_LISTS) {
      const list = envelope.body[listField] as unknown[];
      list.forEach((entry: unknown, index: number) => {
        const locator = `json:$.body.${listField}[${index}]`;
        if (!isObject(entry)) {
          warnings.push(`${locator}: expected an object; element could not be modelled`);
          return;
        }
        warnUnknownFields(entry, AMOUNT_ITEM_FIELDS, locator, warnings);
        warnNonStringFields(
          entry,
          ["amount", "baseCurrencyAmount", "baseCurrencyCollateralAmount", "collateralValueRatio"],
          locator,
          warnings,
        );
        const currency = requireString(entry, "currency", locator, warnings);
        if (currency === undefined || currency === "") {
          warnings.push(`${locator}: currency is required to denominate this balance`);
          return;
        }
        observations.push(
          balanceFromDecimal({
            value: entry["amount"],
            metric,
            instrument: currency,
            locator: `${locator}.amount`,
            extra: providerExtra(entry, envelope, CHILD_LIST_FIELDS, {
              sourceList: listField,
              sourceField: "amount",
            }),
            ...(asOf !== undefined ? { asOf } : {}),
            ...(observedAt !== undefined ? { observedAt } : {}),
            warnings,
          }),
        );
      });
    }
    for (const [listField, valueField, metric] of LIMIT_LISTS) {
      const list = envelope.body[listField] as unknown[];
      list.forEach((entry: unknown, index: number) => {
        const locator = `json:$.body.${listField}[${index}]`;
        if (!isObject(entry)) {
          warnings.push(`${locator}: expected an object; element could not be modelled`);
          return;
        }
        warnUnknownFields(entry, ["currency", valueField], locator, warnings);
        warnNonStringFields(entry, [valueField], locator, warnings);
        const currency = requireString(entry, "currency", locator, warnings);
        if (currency === undefined || currency === "") {
          warnings.push(`${locator}: currency is required to denominate this balance`);
          return;
        }
        observations.push(
          balanceFromDecimal({
            value: entry[valueField],
            metric,
            instrument: currency,
            locator: `${locator}.${valueField}`,
            extra: providerExtra(entry, envelope, CHILD_LIST_FIELDS, {
              sourceList: listField,
              sourceField: valueField,
            }),
            ...(asOf !== undefined ? { asOf } : {}),
            ...(observedAt !== undefined ? { observedAt } : {}),
            warnings,
          }),
        );
      });
    }
    return { observations, warnings };
  },
};
