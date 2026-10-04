// Mizuho Bank: the shared resolver gained its `mizuho-bank` rule after the
// collector had already sealed policy-1 runs, which mapped every account as
// `unrecognized-source-account`. A new run for one parse needs a new numeric
// version (0018's UNIQUE(parse_run_id,policy_version)), so this module
// requires version 2 for every Mizuho parse: the bounded sweep re-identifies
// the sealed policy-1 parses append-only, and the newer sealed run supersedes
// the older one in the current views. The rule needs no auxiliary evidence,
// so the family stays `identity-default` with an empty dependency set; the
// release (`identity-default-v2`) records the rule change.
import { DEFAULT_POLICY_FAMILY, defaultSelection } from "./default.ts";
import type { IdentityPolicyModule } from "./index.ts";

export const MIZUHO_POLICY_VERSION = 2;

export const mizuhoPolicy: IdentityPolicyModule = {
  family: DEFAULT_POLICY_FAMILY,
  sourceId: "mizuho-bank",
  version: MIZUHO_POLICY_VERSION,
  evidenceSql: (alias) => `${alias}.source_id='mizuho-bank'`,
  loadEvidence: async () => ({}),
  select(parse, _evidence, requestedVersion) {
    if (parse.source_id !== "mizuho-bank") return { fallback: "source-mismatch" };
    return defaultSelection(requestedVersion, { status: "eligible" });
  },
};
