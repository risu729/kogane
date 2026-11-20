# ADR 0118: Classify the SMBC AUD foreign ordinary deposit under identity policy 2, for AUD balance captures only; SBI income and gains stay unresolved

- Status: proposed
- Date: 2026-11-18
- Carried by:
  `packages/identity/src/other.ts` (SMBC rule, `SMBC_BANK_POLICY_VERSION`),
  `packages/storage-d1/src/core/identity-policies/smbc-bank.ts`,
  `packages/storage-d1/src/core/identity-policies/index.ts`
  (`AvailableIdentityEvidence.smbcForeignOrdinaryAudBalanceArtifact`),
  [identity sources](../identity-sources.md),
  [identity operations](../identity-operations.md#policy-2-smbc-aud-foreign-ordinary-deposit)
- Follows: [ADR 0089](0089-myjcb-jpoint-identity.md) (one dataset of a source
  re-identified at policy 2),
  [ADR 0076](0076-sbi-shinsei-non-account-identity.md) and
  [ADR 0113](0113-sbi-scopeless-security-identity.md) (a rule selected by the
  run's version), [ADR 0012](0012-mizuho-identity-policy-v2.md) (per-source
  policy modules and append-only re-identification)
- Related: [ADR 0004](0004-payment-type-shapes-from-evidence.md) (unobserved
  semantics stay unsupported), [ADR 0106](0106-sbi-reported-income-and-gains.md)
  (SBI reported income and gains), [ADR 0093](0093-direct-bank-deposit-disjointness.md)
  (direct deposit disjointness)

## Context

Since 2026-11-11 three parser outputs emit account references that no identity
rule classifies, so they map `unresolved` and add unresolved accounts to the
Phase 3 view. A fourth, SBI foreign cash history's bare
`sbi-securities:foreign`, is left to separate work on SBI foreign identity and
is not decided here.

**SMBC AUD.** `smbc-foreign-ordinary-balance` (dataset
`foreign-ordinary-aud-balance`) emits one balance observation per capture on
the constant `smbc-bank:ordinary-foreign-aud`, unit `AUD`, with
`_kogane.balanceScope: "ordinary_foreign_aud_account"`. The SMBC rule accepts
only `smbc-bank:ordinary-yen`, so every policy-1 run mapped the AUD reference
`unresolved` / `unrecognized-source-account` under the source's fallback label
`三井住友銀行 円普通預金` (yen ordinary deposit), which is wrong for an AUD
balance. The explicit-empty history parser (`smbc-foreign-ordinary-history`)
publishes no observation.

What establishes the account ([source notes](../sources/smbc-bank.md)):

- The collector reads the foreign ordinary detail only through the top page's
  `TPALTOPaccountGaikaFutsuDetail` link and refuses a top page without exactly
  one such link (`foreign_account_selection_unreviewed`). So one capture names
  one foreign ordinary account of the login.
- Within that detail it reads only the `dl.detail-list03` whose `dt.title` is
  `通貨：A$`, and refuses a page without exactly one
  (`foreign_currency_unreviewed`). The balance is that section's `現在残高`.
- The observed history page heads the selected account with the branch label,
  `外貨` and its own account number, which the collector compares with the
  detail it selected. The detail POST's `moudaiAcNo` (the top form's value)
  differs from that foreign `accountNo`.

So the reference names the AUD balance of the login's one foreign ordinary
account. Whether that account and the yen ordinary deposit belong to one
customer relationship is not stated by anything the parser records, and
nothing needs it: the reference is its own source account either way.

**SBI income and gains.** `sbi-income-payments` and `sbi-realised-gains` emit
valuations on `sbi-securities:{income,gains}:<accountType>`, where the parser
admits only `SPECIFIC_NORMAL` and `NISA_GROWTH`
([ADR 0106](0106-sbi-reported-income-and-gains.md)). The rule maps them
`unresolved` / `unknown-sbi-account-scope`, label `SBI証券（口座区分未確定）`.
They would map onto an existing SBI scope only if `accountType` named one,
and the evidence does not show that:

- One income reference spans both observed categories, `DOMESTIC_STOCK_SPOT`
  and `FOREIGN_STOCK_US`. The existing scopes are per custody system: domestic
  `deposit-type=<code>` (for example `0` 特定預り, `H` 成長投資枠), foreign
  `specificAccountCode`, foreign cash `accountKind`. The rules already state
  that matching text across those fields does not prove the same subaccount
  ([SBI identity](../identity-sbi.md)).
- No observation recorded what the page labels `SPECIFIC_NORMAL` or
  `NISA_GROWTH` as, and no codebook maps them to custody codes. Whether
  `SPECIFIC_NORMAL` is the specific account alone or the specific and general
  accounts together is not known.

Identity runs and mappings are append-only, and a new run for one parse needs
a new numeric version (0018: `UNIQUE(parse_run_id, policy_version)`).

## Options considered

1. **Change the SMBC rule in place, with no version.** Rejected: a later run
   under `identity-default-v1` would record a different meaning than the
   sealed policy-1 runs of the same release, and nothing would re-identify
   them.
2. **Re-identify every SMBC parse at policy 2 (the ADR 0012 pattern).**
   Rejected: the yen ordinary deposit would gain a policy-2 mapping revision
   with a new id although its classification does not change. Card-settlement
   ownership evidence cites `account_mapping:<id>` of the debit account, and
   readiness compares cited ids, so every candidate debited from that account,
   the accepted ones included, would read `ownership_changed` (the ADR 0089
   limit).
3. **Classify the AUD reference as a `deposit`, `provider-local`, under policy
   2 for AUD balance captures only, keyed as before.** Chosen for SMBC.
4. **Fix only the AUD fallback label and leave it unresolved.** Rejected: the
   label is a plan output, so it needs the same version and re-identification
   as option 3, and it would keep an understood reference among the
   unresolved ones.
5. **Map SBI `accountType` onto existing custody scopes (`SPECIFIC_NORMAL` to
   `deposit-type=0` or foreign `SPECIFIC`, `NISA_GROWTH` to `deposit-type=H`).**
   Rejected: that is a tax-account equivalence nobody observed, across two
   custody systems, and one reference holds both (ADR 0004).
6. **Classify the SBI references as their own provider-local or aggregate
   scope.** Rejected: provider-local would claim the reference is one account
   scope although `SPECIFIC_NORMAL` may cover two, and aggregate would say the
   payments and sales belong to no account although each happened in one. The
   account is unknown, which is what `unresolved` says.
7. **Leave the SBI references unresolved.** Chosen for SBI: no rule, policy or
   label changes. Their fallback label `SBI証券（口座区分未確定）` (account
   category undetermined) is accurate.

## Decision

- **Rule (policy 2).** In `otherIdentity`, for source `smbc-bank`, the exact
  reference `smbc-bank:ordinary-foreign-aud` maps to role `deposit`, status
  `provider-local`, reason `collector-single-foreign-ordinary-aud-scope`,
  label `三井住友銀行 外貨普通預金（AUD）`. The key is unchanged (`[reference]`), so a
  policy-2 run revises the same source account. The unit identity is
  unchanged (`iso4217/global/AUD`). Near shapes (`ordinary-aud`, another
  currency, another case, a suffix) stay unresolved. The yen rule is
  unchanged.
- **The rule is selected by the run's version** (`IdentityInput.policyVersion`,
  as ADR 0076 and ADR 0113): below 2 the AUD reference keeps policy 1's plan,
  so an explicit policy-1 run still records what release
  `identity-default-v1` meant. A call without a version gets the newest
  rules. This is the one difference from ADR 0089, whose rule added a shape
  without reading the version.
- **Policy module.** `identity-policies/smbc-bank.ts` requires version
  `SMBC_BANK_POLICY_VERSION` (2) only when the parse's artifact has dataset
  `foreign-ordinary-aud-balance`: the required-policy SQL branch is
  `a.source_id='smbc-bank' AND a.dataset='foreign-ordinary-aud-balance'`, and
  `loadEvidence` reads the artifact's dataset into
  `smbcForeignOrdinaryAudBalanceArtifact`. Any other SMBC parse falls back to
  the base policy (`not-a-foreign-ordinary-aud-balance-capture`), as a MyJCB
  statement parse does. Family `identity-default`, release
  `identity-default-v2`, empty dependency set.
- **Re-identification is append-only** and limited to the sealed policy-1 AUD
  balance parses; Layer A/B, policy-1 runs and every earlier revision stay as
  recorded, and a manual decision is not replaced.
- **SBI Securities is unchanged**: no rule, no module change, no
  re-identification. Its policy module still requires version 2 for foreign
  positions captures only (ADR 0113).
- **Enablement.** None: no migration, setting, reimport or reparse. The
  five-minute pipeline sweep picks the parses up after deploy.

## Consequences

- **Which parses get a policy-2 run.** Every `ok` parse of an SMBC artifact
  with dataset `foreign-ordinary-aud-balance` whose fetch run succeeded with
  no failures (the sweep's eligibility), superseded parses included, and that
  has only a policy-1 sealed run: one policy-2 run each, once. Yen parses
  (`balance-normalized`, `transactions-normalized`) and AUD history parses
  (`foreign-ordinary-aud-history`) get none.
- **Which mappings get a new revision.**
  - The AUD source account (one per producer that captured it): one policy-2
    rule revision, `deposit` / `provider-local` /
    `collector-single-foreign-ordinary-aud-scope`, label
    `三井住友銀行 外貨普通預金（AUD）`, on the same account entity. Not if its
    current mapping is manual.
  - The currency identifier `iso4217/global/AUD`: one policy-2 rule revision
    equal to its policy-1 one except for its id, revision and version, unless
    its current mapping is already a rule mapping at policy 2 or above (an
    SBI Shinsei policy-2 run of an AUD account revises it too), a manual
    mapping or a rule adoption onto another instrument. Other policy-1 parses
    that use it keep citing the revision they recorded; an open plan that
    pinned the policy-1 revision is refused at approval with `stale_context`.
  - Nothing else: the yen ordinary deposit, `iso4217/global/JPY` and every
    other SMBC subject gain no revision, so the yen mapping id that
    card-settlement ownership evidence cites is unchanged.
- Its account entity keeps the role, label and status it was first written
  with (`source-account`, `三井住友銀行 円普通預金`, `unresolved`; the ADR
  0012 limit). Entities are append-only (`accounts_no_update`), no rule
  revision writes a new one for an existing source account, and a manual
  decision only maps onto an existing entity, so nothing changes them. Which
  reads show the classification depends on whether they read the current
  mapping revision or the entity:
  - **Mapping (new label and `provider-local`):** the identity read
    (`kogane.identity.read` and the 識別 page: label, status, reason, and the
    per-source status counts), observation organization, account history,
    account candidates (`kogane.accounts.candidates`), the organized filter
    options, dated state and holdings change (`identityStatus`), the audit's
    `account_status`, and collection quality's `unresolved_identities`, so
    the AUD balance cell no longer carries `identity_unresolved` and the
    reference leaves the Phase 3 unresolved count.
  - **Entity (policy-1 values):** the identity read's role (区分 on the 識別
    page) stays `source-account`; collection quality's per-account coverage
    (`queryAccountCoverage`, `accounts_json`) still labels the account
    `三井住友銀行 円普通預金`, next to the mapping status `provider-local`;
    and the ownership declaration's single-account check reads the entity's
    role and status as well as the mapping's, so it still refuses the AUD
    account (`single_account_scope_unconfirmed`), as it did before.
- An open plan that pinned the AUD reference's policy-1 mapping revision is
  refused with `stale_context`.
- The balance projection is unchanged: within-source disjointness only tests
  `!== "aggregate"`, and the cross-institution rule (ADR 0093) admits only
  `deposit.balance` readings, whose registry entry names `smbc-direct-balance`
  and not the AUD parser. No AUD transaction is published, so no settlement
  evidence cites the AUD mapping.
- The SBI income and gains references stay `unresolved` /
  `unknown-sbi-account-scope`; a codebook observation naming the page labels
  of `accountType` and how they relate to custody codes is what would allow a
  decision.
- Rolling back leaves the policy-2 runs current.
- Open limit: a second foreign ordinary account, or a second currency, is
  refused by the collector today; if the collector ever admits one, the
  constant reference no longer names one account and this rule has to be
  revisited with the parser.

## Verification

Synthetic inputs only:

- `packages/identity/test/identity-smbc-policy.test.ts`: through the real AUD
  balance parser, the policy-1 plan is unchanged (unresolved, yen fallback
  label, AUD unit, the same key for every run); under policy 2 the reference
  is `deposit` / `provider-local` with its own label and the same key; a call
  without a version equals policy 2; the yen deposit plans identically under
  both versions; near shapes and other sources stay unresolved.
- `services/processor/test/identity-policies.test.ts`: AUD balance evidence
  selects `identity-default-v2`; no evidence falls back to the base policy
  with `not-a-foreign-ordinary-aud-balance-capture`; other sources ignore the
  flag; the required-policy SQL text.
- `services/processor/test/identity-store.test.ts`: a sealed policy-1 AUD
  balance parse is re-identified once at policy 2, while a yen parse and an
  AUD history parse are not; every earlier revision stays; the yen account
  gains no revision; the AUD reference gains one on the same entity, and no
  second source account; the AUD currency identifier gains one equal but for
  id, revision and version.
- `services/processor/test/identity-audit.test.ts`: only the AUD balance
  capture counts as pending.
