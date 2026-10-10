// Provider-displayed portions of a holding, never additive holding buckets.
import { hasExactKeys, isRecord, isText, isRefList } from "./guards.ts";
import { validQuantity, type Quantity } from "./values.ts";
import { validTemporalValue, type TemporalValue } from "./time.ts";
export interface RewardProviderExpiryDisplay {
  displayRef: string;
  scope: "holding-subset";
  quantity: Quantity;
  expires: TemporalValue;
  rawLocator: string;
}
export interface RewardProviderExpiryDisplayMetadata {
  coverage: "observed" | "not-displayed" | "unknown";
  reasonCode: null | "provider_expiry_not_displayed" | "provider_expiry_unavailable";
  displays: RewardProviderExpiryDisplay[];
}
export interface RewardProviderExpirySection extends RewardProviderExpiryDisplayMetadata {
  programId: string;
  holdingRef: string;
  parentBucketRef: string;
  unitRef: string;
  observedAt: TemporalValue;
  sourceFactRefs: string[];
}
export function validRewardProviderExpiryDisplay(
  value: unknown,
): value is RewardProviderExpiryDisplay {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["displayRef", "scope", "quantity", "expires", "rawLocator"]) &&
    isText(value.displayRef, 128) &&
    value.scope === "holding-subset" &&
    validQuantity(value.quantity) &&
    validTemporalValue(value.expires) &&
    (value.expires.kind === "unknown" ||
      (value.expires.kind === "local-date" && value.expires.basis === "provider")) &&
    isText(value.rawLocator, 1024)
  );
}
const METADATA_KEYS = ["coverage", "reasonCode", "displays"];
function validMetadataFields(value: Record<string, unknown>): boolean {
  if (
    !Array.isArray(value.displays) ||
    value.displays.length > 100 ||
    !value.displays.every(validRewardProviderExpiryDisplay)
  )
    return false;
  if (new Set(value.displays.map((display) => display.displayRef)).size !== value.displays.length)
    return false;
  if (value.coverage === "observed") return value.reasonCode === null;
  return (
    value.displays.length === 0 &&
    ((value.coverage === "not-displayed" && value.reasonCode === "provider_expiry_not_displayed") ||
      (value.coverage === "unknown" && value.reasonCode === "provider_expiry_unavailable"))
  );
}
export function validRewardProviderExpiryDisplayMetadata(
  value: unknown,
): value is RewardProviderExpiryDisplayMetadata {
  return isRecord(value) && hasExactKeys(value, METADATA_KEYS) && validMetadataFields(value);
}
export function validRewardProviderExpirySection(
  value: unknown,
): value is RewardProviderExpirySection {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      ...METADATA_KEYS,
      "programId",
      "holdingRef",
      "parentBucketRef",
      "unitRef",
      "observedAt",
      "sourceFactRefs",
    ]) &&
    validMetadataFields(value) &&
    isText(value.programId) &&
    isText(value.holdingRef) &&
    isText(value.parentBucketRef) &&
    isText(value.unitRef) &&
    validTemporalValue(value.observedAt) &&
    isRefList(value.sourceFactRefs) &&
    value.sourceFactRefs.length > 0 &&
    (value.displays as RewardProviderExpiryDisplay[]).every(
      (display) => display.quantity.unitRef === value.unitRef,
    )
  );
}
