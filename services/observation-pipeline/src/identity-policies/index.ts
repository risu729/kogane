// Per-source identity policy selection (review D08). The store saves the plan
// a policy module selected; which rules apply, and on what evidence, is decided
// here. A new source with auxiliary evidence adds a module, not a branch in
// the scheduler. Selection is pure: evidence is loaded separately.
import { canonicalDigest } from "../../../../packages/domain/src/context.ts";
import { DEFAULT_POLICY_FAMILY, defaultSelection } from "./default.ts";
import { vpassPolicy, type VpassBinding } from "./vpass.ts";

/** Highest policy version the current build can select. */
export const IDENTITY_POLICY_VERSION = 2;
/** Policy version every source is eligible for without auxiliary evidence. */
export const BASE_IDENTITY_POLICY_VERSION = 1;

export interface IdentityParseMeta {
  id: number;
  artifact_id: number;
  source_id: string;
  producer_id: string;
  fetch_run_id: number;
}

/** One piece of evidence a run depends on; the digest of the set names the run's inputs. */
export type IdentityDependency = {
  kind: "trusted-vpass-card-binding";
  financialUnitId: number;
  bindingArtifactId: number;
  cardToken: string;
};

export type IdentityPolicyEligibility =
  | { status: "eligible" }
  /** The source's own family could not be applied; the default family was selected instead. */
  | { status: "fallback"; family: string; reason: string };

export interface IdentityPolicySelection {
  policyFamily: string;
  /** Release identifier stored on the run, e.g. `identity-default-v1`. */
  release: string;
  /** Integer stored in `identity_runs.policy_version`; ordering stays numeric. */
  policyVersion: number;
  dependencySet: IdentityDependency[];
  eligibility: IdentityPolicyEligibility;
}

/** Everything a policy module may consult. Modules read only their own field. */
export interface AvailableIdentityEvidence {
  vpassBindings: readonly VpassBinding[];
}
export const NO_EVIDENCE: AvailableIdentityEvidence = { vpassBindings: [] };

export interface IdentityPolicyModule {
  family: string;
  sourceId: string;
  /** The version this family selects when its evidence is present. */
  version: number;
  /** SQL predicate over an artifact alias: true when the family's evidence exists. */
  evidenceSql(artifactAlias: string): string;
  loadEvidence(
    db: D1Database,
    parse: IdentityParseMeta,
  ): Promise<Partial<AvailableIdentityEvidence>>;
  /** The family's selection, or the reason it does not apply to this parse. */
  select(
    parse: IdentityParseMeta,
    evidence: AvailableIdentityEvidence,
    requestedVersion: number,
  ): IdentityPolicySelection | { fallback: string };
}

const SOURCE_POLICIES: readonly IdentityPolicyModule[] = [vpassPolicy];

export function policyModuleFor(sourceId: string): IdentityPolicyModule | undefined {
  return SOURCE_POLICIES.find((module) => module.sourceId === sourceId);
}

function validAlias(artifactAlias: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(artifactAlias))
    throw new Error("identity_sql_alias_invalid");
}

/**
 * Required policy version for an artifact, as SQL. Shared by projection and
 * read-only audits so both use the same eligibility expression. The alias is
 * a SQL identifier, never user input.
 */
export function requiredIdentityPolicySql(artifactAlias: string): string {
  validAlias(artifactAlias);
  const branches = SOURCE_POLICIES.map(
    (module) => `WHEN ${module.evidenceSql(artifactAlias)}
    THEN ${module.version}`,
  ).join(" ");
  return `CASE ${branches} ELSE ${BASE_IDENTITY_POLICY_VERSION} END`;
}

/** Loads the evidence a version at or above the module's version may use. */
export async function loadIdentityEvidence(
  db: D1Database,
  parse: IdentityParseMeta,
  requestedVersion = IDENTITY_POLICY_VERSION,
): Promise<AvailableIdentityEvidence> {
  const module = policyModuleFor(parse.source_id);
  if (!module || requestedVersion < module.version) return NO_EVIDENCE;
  return { ...NO_EVIDENCE, ...(await module.loadEvidence(db, parse)) };
}

/**
 * Selects the policy family and release for one parse. A standard request
 * (`IDENTITY_POLICY_VERSION`) runs a source family at that family's own
 * version and the default family at the base version, so missing or
 * ambiguous sidecars complete as baseline projections rather than waiting at
 * the head of a queue. Any other requested version is an explicit override
 * and is stored as given; ordering between versions stays numeric.
 */
export function selectIdentityPolicy(
  parse: IdentityParseMeta,
  evidence: AvailableIdentityEvidence,
  requestedVersion = IDENTITY_POLICY_VERSION,
): IdentityPolicySelection {
  if (!Number.isSafeInteger(requestedVersion) || requestedVersion < 1)
    throw new Error("identity_version_invalid");
  const explicit = requestedVersion !== IDENTITY_POLICY_VERSION;
  const baseVersion = explicit ? requestedVersion : BASE_IDENTITY_POLICY_VERSION;
  const module = policyModuleFor(parse.source_id);
  if (!module || requestedVersion < module.version)
    return defaultSelection(baseVersion, { status: "eligible" });
  const selected = module.select(parse, evidence, explicit ? requestedVersion : module.version);
  if ("policyFamily" in selected) return selected;
  return defaultSelection(baseVersion, {
    status: "fallback",
    family: module.family,
    reason: selected.fallback,
  });
}

/** Canonical dependencies: sorted so equal sets always digest equally. */
export function canonicalDependencySet(set: readonly IdentityDependency[]): IdentityDependency[] {
  return [...set].sort((a, b) => {
    const left = JSON.stringify(a);
    const right = JSON.stringify(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/** SHA-256 over the canonical JSON of the dependency set (`canonical-json-v1`). */
export async function dependencyDigest(set: readonly IdentityDependency[]): Promise<string> {
  return canonicalDigest(canonicalDependencySet(set));
}

export { DEFAULT_POLICY_FAMILY };
export { trustedVpassBinding, VPASS_POLICY_FAMILY, type VpassBinding } from "./vpass.ts";
