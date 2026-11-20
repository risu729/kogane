// SBI Securities. Policy 2 (ADR 0113): policy 1 gave a security code with no
// RIC, no MIC and no country the placeholder scope `unknown-country`, so two
// different securities sharing such a code shared one identifier; the policy-2
// rule maps that shape `unresolved`, scoped to its fetch run. Only the foreign
// positions parser can emit it.
//
// Policy 3 (ADR 0117): policies 1 and 2 left a foreign trade, position,
// valuation or cash balance with no account discriminator on the bare
// `sbi-securities:foreign` reference, the one every foreign cash history row
// uses by schema, so such a row shared an account with the USD cash ledger.
// The policy-3 rule scopes it to its fetch run, keeps the cash history on the
// bare reference and plans every other shape exactly as policy 2 did. The
// foreign trade, positions and cash balances parsers can emit the shape; the
// cash history parser cannot.
//
// As for MyJCB (ADR 0089), a new run for one parse needs a new numeric version
// (0018's UNIQUE(parse_run_id,policy_version)), so this module requires
// version 3 for those three datasets only: the bounded sweep re-identifies
// their sealed policy-1 and policy-2 parses append-only, and the newer sealed
// run supersedes the older one in the current views. Every other SBI
// Securities parse, the foreign cash history included, stays at the base
// policy, so its identifiers and source accounts gain no revision.
//
// The rules need no auxiliary evidence beyond the artifact's own dataset, so
// the family stays `identity-default` with an empty dependency set; the
// release (`identity-default-v3`) records the rule change.
import { SBI_SECURITIES_POLICY_VERSION } from "../../../../identity/src/sbi.ts";
import { DEFAULT_POLICY_FAMILY, defaultSelection } from "./default.ts";
import type { IdentityPolicyModule } from "./index.ts";

export { SBI_SECURITIES_POLICY_VERSION };
/**
 * The datasets whose rows carry an account discriminator, read by
 * `sbi-foreign-cash-balances`, `sbi-foreign-cash-positions` and
 * `sbi-foreign-trade-records`. The foreign cash history
 * (`foreign-cash-history`) is not one of them.
 */
const SBI_FOREIGN_DISCRIMINATED_DATASETS: readonly string[] = [
  "foreign-cash-balances",
  "foreign-cash-positions",
  "foreign-trade-records",
];

export const sbiSecuritiesPolicy: IdentityPolicyModule = {
  family: DEFAULT_POLICY_FAMILY,
  sourceId: "sbi-securities",
  version: SBI_SECURITIES_POLICY_VERSION,
  evidenceSql: (alias) =>
    `${alias}.source_id='sbi-securities' AND ${alias}.dataset IN (${SBI_FOREIGN_DISCRIMINATED_DATASETS.map((dataset) => `'${dataset}'`).join(",")})`,
  async loadEvidence(db, parse) {
    if (parse.source_id !== "sbi-securities") return {};
    const artifact = await db
      .prepare("SELECT dataset FROM observation_fetch_artifacts WHERE id=?")
      .bind(parse.artifact_id)
      .first<{ dataset: string }>();
    return {
      sbiForeignDiscriminatedArtifact:
        artifact !== null && SBI_FOREIGN_DISCRIMINATED_DATASETS.includes(artifact.dataset),
    };
  },
  select(parse, evidence, requestedVersion) {
    if (parse.source_id !== "sbi-securities") return { fallback: "source-mismatch" };
    if (evidence.sbiForeignDiscriminatedArtifact !== true)
      return { fallback: "not-a-discriminated-foreign-capture" };
    return defaultSelection(requestedVersion, { status: "eligible" });
  },
};
