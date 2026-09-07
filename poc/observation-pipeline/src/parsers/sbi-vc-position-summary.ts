import type { ArtifactMeta, Observation, Parser, ParseResult } from "../types.ts";
import {
  acceptsSbiVcDataset,
  jsonPathProperty,
  parseSbiVcEnvelope,
  providerExtra,
  providerTimestamp,
  requireString,
  SBI_VC_SOURCE_ACCOUNT,
  warnNonStringFields,
  warnUnknownFields,
} from "./sbi-vc-common.ts";
import { decimalText, isObject } from "./util.ts";

const DATASET = "position-summary";
const ITEM_FIELDS = ["productId", "totalAmount", "evaluationPl"] as const;

export const sbiVcPositionSummary: Parser = {
  name: "sbi-vc-position-summary",
  version: "0.1.0",

  accepts(artifact: ArtifactMeta): boolean {
    return acceptsSbiVcDataset(artifact, DATASET);
  },

  parse(bytes: Uint8Array): ParseResult {
    const envelope = parseSbiVcEnvelope(bytes, DATASET);
    const warnings: string[] = [];
    const observations: Observation[] = [];
    const observedAt = providerTimestamp(envelope.meta["timestamp"]);

    for (const [groupName, group] of Object.entries(envelope.body)) {
      const groupLocator = `json:$.body${jsonPathProperty(groupName)}`;
      if (!isObject(group)) {
        warnings.push(`${groupLocator}: expected a position group object; group skipped`);
        continue;
      }
      for (const [positionKey, entry] of Object.entries(group)) {
        const locator = `${groupLocator}${jsonPathProperty(positionKey)}`;
        if (!isObject(entry)) {
          warnings.push(`${locator}: expected a position object; element skipped`);
          continue;
        }
        warnUnknownFields(entry, ITEM_FIELDS, locator, warnings);
        warnNonStringFields(entry, ["totalAmount", "evaluationPl"], locator, warnings);
        const productId = requireString(entry, "productId", locator, warnings) ?? "";
        const quantity = decimalText(entry["totalAmount"]);
        if (!quantity) {
          warnings.push(`${locator}.totalAmount: expected an exact decimal; raw value preserved`);
        }
        observations.push({
          kind: "position",
          sourceAccount: SBI_VC_SOURCE_ACCOUNT,
          securityCode: productId,
          quantityText: quantity?.text ?? "",
          quantityScale: quantity?.scale ?? 0,
          ...(observedAt !== undefined ? { observedAt } : {}),
          rawLocator: locator,
          extra: providerExtra(entry, envelope, Object.keys(envelope.body), {
            positionGroup: groupName,
            positionKey,
          }),
        });
      }
    }
    return { observations, warnings };
  },
};
