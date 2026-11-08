// MyJCB: the shared resolver gained its J-POINT rule after the collector had
// already sealed policy-1 runs of the `myjcb-jpoint-balance` parser, which
// mapped `myjcb:{connection}:j-point:total` as `unrecognized-source-account`.
// As for Mizuho (ADR 0012), a new run for one parse needs a new numeric version
// (0018's UNIQUE(parse_run_id,policy_version)), so this module requires
// version 2, but only for J-POINT captures (dataset `jpoint-balance`, the only
// dataset that parser reads): the bounded sweep re-identifies those sealed
// policy-1 parses append-only, and the newer sealed run supersedes the older
// one in the current views.
//
// Every other MyJCB parse stays at the base policy, like a Vpass parse without
// a trusted binding. Re-identifying a statement parse would give the statement
// root a new mapping revision with a new id, and card-settlement readiness
// compares the cited ownership evidence (`account_mapping:<id>`) by id, so
// every MyJCB settlement candidate, accepted ones included, would read
// `ownership_changed` (ADR 0089). The root's classification does not change,
// so it has nothing to gain from a new revision.
//
// The rule needs no auxiliary evidence beyond the artifact's own dataset, so
// the family stays `identity-default` with an empty dependency set; the
// release (`identity-default-v2`) records the rule change.
import { DEFAULT_POLICY_FAMILY, defaultSelection } from "./default.ts";
import type { IdentityPolicyModule } from "./index.ts";

export const MYJCB_POLICY_VERSION = 2;
/** The dataset the J-POINT parser reads (`myjcb-jpoint-balance`). */
export const MYJCB_JPOINT_DATASET = "jpoint-balance";

export const myJcbPolicy: IdentityPolicyModule = {
  family: DEFAULT_POLICY_FAMILY,
  sourceId: "myjcb",
  version: MYJCB_POLICY_VERSION,
  evidenceSql: (alias) =>
    `${alias}.source_id='myjcb' AND ${alias}.dataset='${MYJCB_JPOINT_DATASET}'`,
  async loadEvidence(db, parse) {
    if (parse.source_id !== "myjcb") return {};
    const artifact = await db
      .prepare("SELECT dataset FROM observation_fetch_artifacts WHERE id=?")
      .bind(parse.artifact_id)
      .first<{ dataset: string }>();
    return { myJcbJPointArtifact: artifact?.dataset === MYJCB_JPOINT_DATASET };
  },
  select(parse, evidence, requestedVersion) {
    if (parse.source_id !== "myjcb") return { fallback: "source-mismatch" };
    if (evidence.myJcbJPointArtifact !== true) return { fallback: "not-a-jpoint-capture" };
    return defaultSelection(requestedVersion, { status: "eligible" });
  },
};
