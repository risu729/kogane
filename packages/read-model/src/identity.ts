// Identity read modes (review D06). `latest` decorates observations with the
// current mapping revisions, so a correction changes what every reader sees at
// once. `as-recorded` decorates them with the mapping ids the sealed identity
// run pinned when it was made, so a correction never changes it. Both are
// served from the same stored rows; neither mode rewrites anything. A fixed
// `snapshot` mode is a later contract.
import {
  IDENTITY_READ_MODES,
  type IdentityReadMode,
  type InterpretationContext,
} from "../../../poc/observation-pipeline/shared/api-schema";
import {
  FINANCIAL_PRODUCT_CATALOGUE_VERSION,
  FINANCIAL_PRODUCT_RESOLVER_VERSION,
} from "../../../poc/observation-pipeline/shared/financial-products";

export { IDENTITY_READ_MODES, type IdentityReadMode, type InterpretationContext };

export const DEFAULT_IDENTITY_READ_MODE: IdentityReadMode = "latest";
/** Balance meaning comes from the fixed metric registry of `balance-semantics.ts`. */
export const MEASURE_POLICY_RELEASE = "metric-registry-v1";
/** Exact decimals are the `decimal-v1` normalization of migration 0024. */
export const DECIMAL_POLICY_RELEASE = "decimal-v1";
/** `latest` reads the current mapping revision of each reference, whatever policy wrote it. */
export const LATEST_IDENTITY_RELEASE = "current-mappings-v1";
/** `as-recorded` with no organized row: nothing was recorded to report. */
export const NO_RECORDED_IDENTITY_RELEASE = "as-recorded:none";
const MIXED_RECORDED_IDENTITY_RELEASE = "as-recorded:mixed";

export function isIdentityReadMode(value: string): value is IdentityReadMode {
  return (IDENTITY_READ_MODES as readonly string[]).includes(value);
}

/**
 * The identity release a response reports. Under `as-recorded` it names the
 * distinct policy releases of the runs the rows were recorded under, sorted
 * and joined with `+`, so a page mixing releases says so.
 */
export function identityReleaseFor(
  mode: IdentityReadMode,
  rowReleases: Iterable<string | null | undefined>,
): string {
  if (mode === "latest") return LATEST_IDENTITY_RELEASE;
  const distinct = [
    ...new Set(
      [...rowReleases].filter((release): release is string => typeof release === "string"),
    ),
  ].sort();
  if (distinct.length === 0) return NO_RECORDED_IDENTITY_RELEASE;
  const joined = distinct.join("+");
  return joined.length <= 128 ? joined : MIXED_RECORDED_IDENTITY_RELEASE;
}

export function interpretationContext(
  mode: IdentityReadMode,
  identityRelease: string,
): InterpretationContext {
  return {
    mode,
    snapshotId: null,
    identityRelease,
    productCatalogueRelease: FINANCIAL_PRODUCT_CATALOGUE_VERSION,
    productResolverRelease: FINANCIAL_PRODUCT_RESOLVER_VERSION,
    measurePolicyRelease: MEASURE_POLICY_RELEASE,
    decimalPolicyRelease: DECIMAL_POLICY_RELEASE,
  };
}

/**
 * The mapping relation each mode joins for an organized observation. `o` is
 * the identity observation, `d` the instrument identifier, `u` the instrument
 * use; the mapping aliases are `am` and `im` in both modes so the projected
 * columns are the same.
 */
export const MAPPING_RELATIONS: Record<IdentityReadMode, { account: string; instrument: string }> =
  {
    latest: {
      account: "JOIN current_account_mappings am ON am.source_account_id=o.source_account_id",
      instrument: "LEFT JOIN current_instrument_mappings im ON im.identifier_id=d.id",
    },
    "as-recorded": {
      account: "JOIN account_mappings am ON am.id=o.account_mapping_id",
      instrument: "LEFT JOIN instrument_mappings im ON im.id=u.instrument_mapping_id",
    },
  };
