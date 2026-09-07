import type { ArtifactMeta, Observation, Parser, ParseResult } from "../types.ts";
import {
  acceptsSbiVcDataset,
  jsonPathProperty,
  parseSbiVcEnvelope,
  providerExtra,
  providerTimestamp,
  requireNonEmptyString,
  SBI_VC_SOURCE_ACCOUNT,
  warnNonStringFields,
  warnUnknownFields,
} from "./sbi-vc-common.ts";
import { decimalText, isObject } from "./util.ts";

const DATASET = "position-summary";
const ITEM_FIELDS = ["productId", "totalAmount", "evaluationPl"] as const;

export const sbiVcPositionSummary: Parser = {
  name: "sbi-vc-position-summary",
  version: "0.2.0",

  accepts(artifact: ArtifactMeta): boolean {
    return acceptsSbiVcDataset(artifact, DATASET);
  },

  parse(bytes: Uint8Array): ParseResult {
    const envelope = parseSbiVcEnvelope(bytes, DATASET);
    const warnings: string[] = [];
    const observations: Observation[] = [];
    const observedAt = providerTimestamp(envelope.meta["timestamp"]);
    const productIds = new Set<string>();

    for (const [groupName, group] of Object.entries(envelope.body)) {
      const groupLocator = `json:$.body${jsonPathProperty(groupName)}`;
      if (!isObject(group)) {
        throw new Error(`${groupLocator}: expected a position group object`);
      }
      for (const [positionKey, entry] of Object.entries(group)) {
        const locator = `${groupLocator}${jsonPathProperty(positionKey)}`;
        if (!isObject(entry)) {
          throw new Error(`${locator}: expected a position object`);
        }
        warnUnknownFields(entry, ITEM_FIELDS, locator, warnings);
        warnNonStringFields(entry, ["totalAmount", "evaluationPl"], locator, warnings);
        const productId = requireNonEmptyString(entry, "productId", locator);
        if (productIds.has(productId)) {
          throw new Error(`${locator}: duplicate position identity`);
        }
        productIds.add(productId);
        const quantity = decimalText(entry["totalAmount"]);
        if (!quantity) {
          throw new Error(`${locator}.totalAmount: expected an exact decimal`);
        }
        if (!decimalText(entry["evaluationPl"])) {
          throw new Error(`${locator}.evaluationPl: expected an exact decimal`);
        }
        observations.push({
          kind: "position",
          sourceAccount: SBI_VC_SOURCE_ACCOUNT,
          securityCode: productId,
          quantityText: quantity.text,
          quantityScale: quantity.scale,
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
