// SBI Shinsei Bank (ADR 0076): policy 1 mapped every `sbi-shinsei:` reference
// as a provider-local deposit, including the parser's two references that
// name no account (`sbi-shinsei:fx-board`, the exchange-rate board, and
// `sbi-shinsei:customer`, the customer's stage category). The shared
// resolver's policy-2 rule classifies those two as provider statements and
// keeps every account reference exactly as policy 1 mapped it. A new run for
// one parse needs a new numeric version (0018's
// UNIQUE(parse_run_id,policy_version)), so, as for Mizuho (ADR 0012), this
// module requires version 2 for every SBI Shinsei parse: the bounded sweep
// re-identifies the sealed policy-1 parses append-only, and the newer sealed
// run supersedes the older one in the current views. The rule needs no
// auxiliary evidence, so the family stays `identity-default` with an empty
// dependency set; the release (`identity-default-v2`) records the rule.
import { SBI_SHINSEI_POLICY_VERSION } from "../../../../identity/src/other.ts";
import { DEFAULT_POLICY_FAMILY, defaultSelection } from "./default.ts";
import type { IdentityPolicyModule } from "./index.ts";

export { SBI_SHINSEI_POLICY_VERSION };

export const sbiShinseiPolicy: IdentityPolicyModule = {
  family: DEFAULT_POLICY_FAMILY,
  sourceId: "sbi-shinsei-bank",
  version: SBI_SHINSEI_POLICY_VERSION,
  evidenceSql: (alias) => `${alias}.source_id='sbi-shinsei-bank'`,
  loadEvidence: async () => ({}),
  select(parse, _evidence, requestedVersion) {
    if (parse.source_id !== "sbi-shinsei-bank") return { fallback: "source-mismatch" };
    return defaultSelection(requestedVersion, { status: "eligible" });
  },
};
