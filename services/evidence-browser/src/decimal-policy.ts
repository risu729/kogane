import { HttpError } from "./http";
import { DECIMAL_POLICY_RELEASE } from "../../../packages/read-model/src/index";

/**
 * Read-side selection of the decimal normalization policy (root review 07
 * section 6).
 *
 * `decimalPolicyRelease` in the interpretation context is a name a reader may
 * choose, but only when a projection actually exists for that name. Migration
 * 0024 fixes `policy_version='decimal-v1'` with a CHECK, so today exactly one
 * projection exists and every other name is refused as unsupported semantics
 * rather than silently served from `decimal-v1` rows.
 *
 * Adding a second policy is a schema change plus this registry entry, not an
 * edit of 0024: a new migration adds the projection (a new table or a
 * compatible view keyed by `policy_version`) and backfills it, and only then
 * does the name become selectable here. The recipe is in
 * docs/normalized-decimals.md.
 */
export const DECIMAL_POLICY_PROJECTIONS: Readonly<Record<string, { policyVersion: string }>> = {
  [DECIMAL_POLICY_RELEASE]: { policyVersion: DECIMAL_POLICY_RELEASE },
};

export const DEFAULT_DECIMAL_POLICY = DECIMAL_POLICY_RELEASE;

/** Release identifier shape shared with the API schema; not a guarantee a projection exists. */
const RELEASE = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/u;

export function decimalProjectionExists(release: string): boolean {
  return Object.hasOwn(DECIMAL_POLICY_PROJECTIONS, release);
}

/**
 * The policy a request selected. A malformed name is an invalid query; a
 * well-formed name with no projection is `unsupported_semantics`, the same
 * distinction the identity read mode makes for `snapshot`.
 */
export function decimalPolicySelection(url: URL): string {
  const value = url.searchParams.get("decimalPolicy");
  if (value === null) return DEFAULT_DECIMAL_POLICY;
  if (!RELEASE.test(value)) throw new HttpError(400, "invalid_query");
  if (!decimalProjectionExists(value)) throw new HttpError(400, "unsupported_semantics");
  return value;
}
