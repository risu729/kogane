// SBI Securities (ADR 0113): policy 1 gave a security code with no RIC, no
// MIC and no country the placeholder scope `unknown-country`, so two
// different securities sharing such a code shared one identifier. The shared
// resolver's policy-2 rule maps that shape `unresolved`, scoped to its fetch
// run, and plans every other shape exactly as policy 1 did. Only the
// foreign positions parser (`sbi-foreign-cash-positions`, dataset
// `foreign-cash-positions`) can emit it: domestic rows are always country JP,
// and the foreign trade parser refuses a row without a country. As for MyJCB
// (ADR 0089), a new run for one parse needs a new numeric version (0018's
// UNIQUE(parse_run_id,policy_version)), so this module requires version 2
// for those captures only: the bounded sweep re-identifies their sealed
// policy-1 parses append-only, and the newer sealed run supersedes the older
// one in the current views. Every other SBI Securities parse stays at the base
// policy, so its identifiers and source accounts gain no revision.
//
// The rule needs no auxiliary evidence beyond the artifact's own dataset, so
// the family stays `identity-default` with an empty dependency set; the
// release (`identity-default-v2`) records the rule change.
import { SBI_SECURITIES_POLICY_VERSION } from "../../../../identity/src/sbi.ts";
import { DEFAULT_POLICY_FAMILY, defaultSelection } from "./default.ts";
import type { IdentityPolicyModule } from "./index.ts";

export { SBI_SECURITIES_POLICY_VERSION };
/** The dataset the foreign positions parser reads (`sbi-foreign-cash-positions`). */
export const SBI_FOREIGN_POSITIONS_DATASET = "foreign-cash-positions";

export const sbiSecuritiesPolicy: IdentityPolicyModule = {
  family: DEFAULT_POLICY_FAMILY,
  sourceId: "sbi-securities",
  version: SBI_SECURITIES_POLICY_VERSION,
  evidenceSql: (alias) =>
    `${alias}.source_id='sbi-securities' AND ${alias}.dataset='${SBI_FOREIGN_POSITIONS_DATASET}'`,
  async loadEvidence(db, parse) {
    if (parse.source_id !== "sbi-securities") return {};
    const artifact = await db
      .prepare("SELECT dataset FROM observation_fetch_artifacts WHERE id=?")
      .bind(parse.artifact_id)
      .first<{ dataset: string }>();
    return { sbiForeignPositionsArtifact: artifact?.dataset === SBI_FOREIGN_POSITIONS_DATASET };
  },
  select(parse, evidence, requestedVersion) {
    if (parse.source_id !== "sbi-securities") return { fallback: "source-mismatch" };
    if (evidence.sbiForeignPositionsArtifact !== true)
      return { fallback: "not-a-foreign-positions-capture" };
    return defaultSelection(requestedVersion, { status: "eligible" });
  },
};
