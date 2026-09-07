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

const DATASET = "cash-balances";
const BODY_FIELDS = ["baseCurrencyTotalAmount", "list"] as const;
const ITEM_FIELDS = [
  "amount",
  "baseCurrencyAmount",
  "currency",
  "fxAccountId",
  "noSettlingAmount",
  "settlingAmount",
] as const;
const METRICS = [
  ["amount", "cash_balance"],
  ["noSettlingAmount", "no_settling_amount"],
  ["settlingAmount", "settling_amount"],
] as const;

export const sbiVcCashBalances: Parser = {
  name: "sbi-vc-cash-balances",
  version: "0.1.0",

  accepts(artifact: ArtifactMeta): boolean {
    return acceptsSbiVcDataset(artifact, DATASET);
  },

  parse(bytes: Uint8Array): ParseResult {
    const envelope = parseSbiVcEnvelope(bytes, DATASET);
    const warnings: string[] = [];
    warnUnknownFields(envelope.body, BODY_FIELDS, "json:$.body", warnings);
    if (
      typeof envelope.body["baseCurrencyTotalAmount"] !== "string" ||
      !Array.isArray(envelope.body["list"])
    ) {
      throw new Error(`${DATASET}: body fields do not match the provider contract`);
    }
    const observedAt = providerTimestamp(envelope.meta["timestamp"]);
    const observations: Observation[] = [];
    envelope.body["list"].forEach((entry: unknown, index: number) => {
      const locator = `json:$.body.list[${index}]`;
      if (!isObject(entry)) {
        warnings.push(`${locator}: expected an object; element could not be modelled`);
        return;
      }
      warnUnknownFields(entry, ITEM_FIELDS, locator, warnings);
      warnNonStringFields(
        entry,
        ["amount", "baseCurrencyAmount", "fxAccountId", "noSettlingAmount", "settlingAmount"],
        locator,
        warnings,
      );
      const currency = requireString(entry, "currency", locator, warnings);
      if (currency === undefined || currency === "") {
        warnings.push(`${locator}: currency is required to denominate balances`);
        return;
      }
      for (const [field, metric] of METRICS) {
        const extra = providerExtra(entry, envelope, ["list"], {
          sourceField: field,
        });
        observations.push(
          balanceFromDecimal({
            value: entry[field],
            metric,
            instrument: currency,
            locator: `${locator}.${field}`,
            extra,
            ...(observedAt !== undefined ? { observedAt } : {}),
            warnings,
          }),
        );
      }
    });
    return { observations, warnings };
  },
};
