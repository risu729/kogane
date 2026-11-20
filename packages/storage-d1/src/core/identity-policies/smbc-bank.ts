// SMBC (ADR 0118): the shared resolver gained its rule for the AUD foreign
// ordinary deposit reference `smbc-bank:ordinary-foreign-aud` after policy-1
// runs had mapped it `unresolved` / `unrecognized-source-account` under the
// source's yen-deposit label. As for MyJCB (ADR 0089), a new run for one parse
// needs a new numeric version (0018's UNIQUE(parse_run_id,policy_version)), so
// this module requires version 2, but only for AUD balance captures (dataset
// `foreign-ordinary-aud-balance`, the only dataset whose parser,
// `smbc-foreign-ordinary-balance`, emits the reference): the bounded sweep
// re-identifies those sealed policy-1 parses append-only, and the newer sealed
// run supersedes the older one in the current views.
//
// Every other SMBC parse stays at the base policy. Re-identifying a yen parse
// would give the yen ordinary deposit a new mapping revision with a new id,
// and card-settlement readiness compares the cited ownership evidence
// (`account_mapping:<id>`) by id, so every settlement candidate debited from
// that account, accepted ones included, would read `ownership_changed`. The
// yen account's classification does not change, so it has nothing to gain.
// The explicit-empty AUD history parser publishes no observation, so a new run
// of it would record nothing.
//
// The rule needs no auxiliary evidence beyond the artifact's own dataset, so
// the family stays `identity-default` with an empty dependency set; the
// release (`identity-default-v2`) records the rule change.
import { SMBC_BANK_POLICY_VERSION } from "../../../../identity/src/other.ts";
import { DEFAULT_POLICY_FAMILY, defaultSelection } from "./default.ts";
import type { IdentityPolicyModule } from "./index.ts";

export { SMBC_BANK_POLICY_VERSION };
/** The dataset the AUD balance parser reads (`smbc-foreign-ordinary-balance`). */
const SMBC_FOREIGN_ORDINARY_AUD_BALANCE_DATASET = "foreign-ordinary-aud-balance";

export const smbcBankPolicy: IdentityPolicyModule = {
  family: DEFAULT_POLICY_FAMILY,
  sourceId: "smbc-bank",
  version: SMBC_BANK_POLICY_VERSION,
  evidenceSql: (alias) =>
    `${alias}.source_id='smbc-bank' AND ${alias}.dataset='${SMBC_FOREIGN_ORDINARY_AUD_BALANCE_DATASET}'`,
  async loadEvidence(db, parse) {
    if (parse.source_id !== "smbc-bank") return {};
    const artifact = await db
      .prepare("SELECT dataset FROM observation_fetch_artifacts WHERE id=?")
      .bind(parse.artifact_id)
      .first<{ dataset: string }>();
    return {
      smbcForeignOrdinaryAudBalanceArtifact:
        artifact?.dataset === SMBC_FOREIGN_ORDINARY_AUD_BALANCE_DATASET,
    };
  },
  select(parse, evidence, requestedVersion) {
    if (parse.source_id !== "smbc-bank") return { fallback: "source-mismatch" };
    if (evidence.smbcForeignOrdinaryAudBalanceArtifact !== true)
      return { fallback: "not-a-foreign-ordinary-aud-balance-capture" };
    return defaultSelection(requestedVersion, { status: "eligible" });
  },
};
