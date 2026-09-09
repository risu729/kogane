import type { ArtifactMeta, Observation, Parser, ParseResult } from "../types.ts";
import {
  acceptsSbiVcDataset,
  balanceFromDecimal,
  parseSbiVcEnvelope,
  providerExtra,
  providerTimestamp,
  requireExactDecimalString,
  requireNonEmptyString,
  warnUnknownFields,
} from "./sbi-vc-common.ts";
import { containerClaim, ParseDiagnostics } from "./coverage.ts";
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
  version: "0.2.0",

  accepts(artifact: ArtifactMeta): boolean {
    return acceptsSbiVcDataset(artifact, DATASET);
  },

  parse(bytes: Uint8Array, artifact: ArtifactMeta): ParseResult {
    const envelope = parseSbiVcEnvelope(bytes, DATASET);
    const diagnostics = new ParseDiagnostics();
    warnUnknownFields(envelope.body, BODY_FIELDS, "json:$.body", diagnostics);
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
      warnUnknownFields(value, ["attribute", "value"], `json:$.body.${field}`, diagnostics);
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
          throw new Error(`${locator}: expected an account margin amount object`);
        }
        warnUnknownFields(entry, AMOUNT_ITEM_FIELDS, locator, diagnostics);
        const currency = requireNonEmptyString(entry, "currency", locator);
        requireExactDecimalString(entry["amount"], `${locator}.amount`, currency);
        requireExactDecimalString(entry["baseCurrencyAmount"], `${locator}.baseCurrencyAmount`);
        requireExactDecimalString(
          entry["baseCurrencyCollateralAmount"],
          `${locator}.baseCurrencyCollateralAmount`,
        );
        requireExactDecimalString(entry["collateralValueRatio"], `${locator}.collateralValueRatio`);
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
            diagnostics,
          }),
        );
      });
    }
    for (const [listField, valueField, metric] of LIMIT_LISTS) {
      const list = envelope.body[listField] as unknown[];
      list.forEach((entry: unknown, index: number) => {
        const locator = `json:$.body.${listField}[${index}]`;
        if (!isObject(entry)) {
          throw new Error(`${locator}: expected an account margin limit object`);
        }
        warnUnknownFields(entry, ["currency", valueField], locator, diagnostics);
        const currency = requireNonEmptyString(entry, "currency", locator);
        requireExactDecimalString(entry[valueField], `${locator}.${valueField}`, currency);
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
            diagnostics,
          }),
        );
      });
    }
    return {
      observations,
      warnings: diagnostics.warnings,
      issues: diagnostics.issues,
      coverage: [
        containerClaim({
          artifact,
          issues: diagnostics.issues,
          observedCount: observations.length,
          evidenceRefs: CHILD_LIST_FIELDS.map((field) => `json:$.body.${field}`),
        }),
      ],
    };
  },
};
