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
  version: "0.2.0",

  accepts(artifact: ArtifactMeta): boolean {
    return acceptsSbiVcDataset(artifact, DATASET);
  },

  parse(bytes: Uint8Array, artifact: ArtifactMeta): ParseResult {
    const envelope = parseSbiVcEnvelope(bytes, DATASET);
    const diagnostics = new ParseDiagnostics();
    warnUnknownFields(envelope.body, BODY_FIELDS, "json:$.body", diagnostics);
    if (!Array.isArray(envelope.body["list"])) {
      throw new Error(`${DATASET}: body fields do not match the provider contract`);
    }
    requireExactDecimalString(
      envelope.body["baseCurrencyTotalAmount"],
      "json:$.body.baseCurrencyTotalAmount",
    );
    const observedAt = providerTimestamp(envelope.meta["timestamp"]);
    const observations: Observation[] = [];
    envelope.body["list"].forEach((entry: unknown, index: number) => {
      const locator = `json:$.body.list[${index}]`;
      if (!isObject(entry)) {
        throw new Error(`${locator}: expected a cash balance object`);
      }
      warnUnknownFields(entry, ITEM_FIELDS, locator, diagnostics);
      const currency = requireNonEmptyString(entry, "currency", locator);
      if (typeof entry["fxAccountId"] !== "string") {
        throw new Error(`${locator}.fxAccountId: expected a string`);
      }
      requireExactDecimalString(entry["baseCurrencyAmount"], `${locator}.baseCurrencyAmount`);
      for (const [field, metric] of METRICS) {
        requireExactDecimalString(entry[field], `${locator}.${field}`, currency);
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
            diagnostics,
          }),
        );
      }
    });
    return {
      observations,
      warnings: diagnostics.warnings,
      issues: diagnostics.issues,
      coverage: [
        containerClaim({
          artifact,
          issues: diagnostics.issues,
          observedCount: observations.length,
          evidenceRefs: ["json:$.body.list"],
        }),
      ],
    };
  },
};
