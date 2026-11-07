# ADR 0076: Classify SBI Shinsei's FX board and stage references as non-account statements under identity policy version 2

- Status: accepted (merged 2026-11-06 in #948)
- Date: 2026-11-06
- Carried by:
  `packages/identity/src/other.ts` (`SBI_SHINSEI_POLICY_VERSION`),
  `packages/identity/src/types.ts` (`IdentityInput.policyVersion`),
  `packages/storage-d1/src/core/identity-policies/sbi-shinsei.ts`,
  `packages/storage-d1/src/core/identity-store.ts` (`identifyParse` passes the
  run's version to the resolver),
  [identity sources](../identity-sources.md),
  [identity operations](../identity-operations.md#policy-2-sbi-shinsei-non-account-references),
  [identity audit](../identity-audit.md)
- Follows: [ADR 0012](0012-mizuho-identity-policy-v2.md) (per-source policy
  modules and append-only re-identification)
- Related: [ADR 0029](0029-data-classification-and-unkeyed-identity.md) (SBI
  Shinsei `accountNo` is a class (c) provider-local identifier held raw),
  [ADR 0030](0030-identity-crosswalk.md) (identity values are not rewritten
  outside its one-time migration), [ADR 0031](0031-sbi-shinsei-stage-category-fx-tier.md)
  (the stage observation), [ADR 0004](0004-payment-type-shapes-from-evidence.md)
  (unobserved semantics stay unsupported)

## Context

The SBI Shinsei parsers emit three kinds of source account reference:

- `sbi-shinsei:{accountNo}`: the provider's account id for balances, the yen
  equivalent valuation and activity rows (`sbi-shinsei-common.ts`,
  `sbi-shinsei-top-balances-and-activity.ts`);
- `sbi-shinsei:fx-board`: every rate cell of the exchange-rate board, subject
  `<CCY>` (`sbi-shinsei-exchange-rate.ts`, `SBI_SHINSEI_FX_BOARD_ACCOUNT`);
- `sbi-shinsei:customer`: the customer's stage category, subject
  `customerCategory`, currency `XXX`, no amount
  (`sbi-shinsei-balance-summary-and-stage.ts`, ADR 0031).

The identity rule for source `sbi-shinsei-bank` accepted `/^sbi-shinsei:.+$/`
and mapped every match as a provider-local `deposit`
(`provider-account-reference-with-native-unit`), with the subject or currency
appended as the `unit` discriminator. So every policy-1 run sealed for an
exchange-rate parse mapped one "deposit" per board currency
(`["sbi-shinsei:fx-board","unit","<CCY>"]`), and every stage parse mapped a
"deposit" `["sbi-shinsei:customer","unit","customerCategory"]`.
[Identity sources](../identity-sources.md) documented only `{accountNo}` as
accepted. Nothing reads these mappings for prices: the promotion lane selects
board and stage rows by `source_account` (`price-promotion-job.ts`), not by
identity. But the mappings are what the identity browser, the identity audit's
account-status counts and the ownership declaration's single-account check
(`ownership-declaration.ts`, which requires a `deposit` role and a
`provider-local` or `identified` status) see.

The parser's `accountNo` is validated only as a non-empty string; its digit
layout is not observed (`card-debit-account.ts` keeps it
`reference_layout_unverified`), so the account pattern cannot be narrowed to a
shape nobody has observed (ADR 0004).

Identity runs and mappings are append-only, a new run for one parse needs a
new numeric version (0018: `UNIQUE(parse_run_id, policy_version)`), and the
status column is a closed set (`identified`, `provider-local`, `aggregate`,
`unresolved`).

## Options considered

1. **Rewrite the policy-1 mappings.** Rejected: identity runs, observations
   and mapping revisions are evidence and append-only; a correction is a new
   revision.
2. **Change the rule in place, with no version.** Rejected: a later run under
   release `identity-default-v1` would record a different meaning than the
   sealed policy-1 runs of the same release, and nothing would re-identify the
   sealed parses (they already satisfy policy 1).
3. **Narrow the rule so the two references fall to `unrecognized-source-account`.**
   Rejected: they are recognised parser constants, not unknown shapes; the
   default plan drops the `unit` discriminator, so every observation would
   move to a new source account and the policy-1 `deposit` mapping of the old
   subject would stay its current mapping; and the audit would count a known
   statement as an unrecognised-account issue.
4. **A new `not-an-account` status or a new role.** Rejected for now: the
   status is a CHECK-constrained closed set on `accounts` and
   `account_mappings`, so it needs a table rebuild and every status reader to
   learn it, for two references; and a new role would be a guess at semantics
   the rules have no precedent for.
5. **A versioned SBI Shinsei rule under policy 2 that reuses the closed
   `aggregate` status and the precedent roles, keeping every key.** Chosen.

## Decision

- **Rule (policy 2).** In `otherIdentity`, for source `sbi-shinsei-bank`:
  - `sbi-shinsei:fx-board` (exact): role `valuation-aggregate`, status
    `aggregate`, reason `provider-fx-board-quotes-not-an-account`, label
    `SBI新生銀行 外貨為替レート`. Precedent: the rules give valuation-kind
    provider statements that are not a holding (PRESTIA groups, Sony gross
    categories) `valuation-aggregate` / `aggregate`.
  - `sbi-shinsei:customer` (exact): role `qualification-aggregate`, status
    `aggregate`, reason `provider-customer-stage-not-an-account`, label
    `SBI新生銀行 お客さまステージ`. Precedent: `prestia-bank:relationship`, a
    relationship-level qualification statement, is
    `qualification-aggregate` / `aggregate`.
  - Every other `sbi-shinsei:.+` reference is mapped exactly as under policy 1.
  - The key is unchanged under both versions for all three kinds
    (`[reference, "unit", native]`), so the correction lands as a new mapping
    revision of the same source account, and an account reference keeps the
    same source-account and account-entity digests.
    The role names the precedent class only; it does not claim the rates or the
    stage are additive, and the reason carries the specific meaning. No issue is
    added: the references are recognised.
- **The rule is selected by the run's version.** `IdentityInput.policyVersion`
  carries the identity run's version (`identifyParse` sets it). The SBI Shinsei
  rule applies the policy-2 classification at version 2 or above, and the
  policy-1 mapping below it, so an explicit policy-1 run still records what
  release `identity-default-v1` meant. A caller that passes no version gets the
  newest rules. Other sources' rules are unchanged and ignore the version.
- **Policy module.** `identity-policies/sbi-shinsei.ts`, beside `mizuho.ts`,
  requires version `SBI_SHINSEI_POLICY_VERSION` (2) for every SBI Shinsei
  parse, as ADR 0012 did for Mizuho: family `identity-default`, release
  `identity-default-v2`, empty dependency set, no fallback. The
  required-policy SQL gains the branch `WHEN a.source_id='sbi-shinsei-bank'
  THEN 2`; the sweep and the audit share it.
- **Re-identification is append-only.** The bounded sweep treats the sealed
  policy-1 SBI Shinsei parses as candidates again and appends a policy-2 run
  and, per source account, a policy-2 mapping revision; the current views
  select the newer sealed run. Policy-1 runs, their observation rows, their
  mapping revisions, and Layer A/B stay as recorded. A manual decision on an
  SBI Shinsei reference is not replaced (the automatic mapping yields to it as
  for every source).
- **Enablement.** Nothing is configured: as for Mizuho, the module takes
  effect when the processor build that contains it is deployed, and the
  five-minute pipeline sweep picks the parses up on its own. No migration, no
  setting, no reimport and no reparse.

## Consequences

- Account references (`{accountNo}`) keep their key, source account, entity
  and classification; they gain a policy-2 mapping revision equal to their
  policy-1 one except for its version. Balances and transactions are not
  counted twice: no observation moves to another source account.
- After re-identification the board's and the stage's current mappings read
  `aggregate`, so the ownership declaration's single-account check refuses
  them, and the audit's `account_status` counts them under `aggregate` instead
  of `provider-local`.
- Account entities are append-only, so a board or stage entity first written
  under policy 1 keeps its `deposit` role and `provider-local` entity status
  (shown as the role in the identity browser); the classification lives on the
  policy-2 mapping revision, which projections and the ownership check read.
  This is the same limit ADR 0012 records for Mizuho's `source-account` role.
  A store that first sees these references under policy 2 writes the entity
  with the policy-2 role and status.
- Until the sweep reaches a parse, its policy-1 run stays current and the
  audit's `pending_parses` counts it. Every SBI Shinsei parse is re-identified
  once, including those with only account references, so the backlog is the
  source's whole sealed history, processed within the sweep's existing
  per-tick bounds; each sealed run bumps the CORE revision as any identity
  run does.
- Reads that cite a current mapping revision (for example
  `account_mapping:<id>` in card-settlement ownership evidence) cite the
  policy-2 revision once it exists; ownership relations name the account
  entity, which is unchanged.
- Rolling the code back leaves the policy-2 runs current: an older build
  cannot replace a newer sealed decision, and it requires only policy 1.
- `bankAccountReference` in `packages/domain/src/card-debit-account.ts` still
  matches `sbi-shinsei:.+`; it already refuses every SBI Shinsei reference as
  `reference_layout_unverified`, so the board and the stage stay
  non-comparable there.

## Verification

Synthetic inputs only, shaped like the parsers' rows:

- `packages/identity/test/identity-sbi-shinsei.test.ts`: golden plans for
  policy 1 and policy 2 (account balance, yen valuation, activity row, board
  cell, stage); account plans equal under both versions; account and
  non-account keys whose source-account digests equal literals computed
  outside the code with `sha256sum`, under versions 1, 2, 10 and none; only the
  two exact references are reclassified.
- `services/processor/test/identity-policies.test.ts`: every SBI Shinsei parse
  selects `identity-default-v2` with an empty dependency set; explicit versions
  are stored as requested; the required-policy SQL text.
- `packages/storage-d1/test/identity-sweep-query.test.ts` and
  `services/processor/test/identity-sweep-cost.test.ts`: the frozen
  pre-rewrite candidate SQL (`fixtures/identity-sweep-legacy.sql`) carries the
  shipped required-policy expression, now with the SBI Shinsei branch; the
  synthetic store holds SBI Shinsei parses sealed at policy 1 and at policy 2,
  and the shipped candidate SQL returns the same rows as the frozen text on
  scaled stores (unscoped and scoped to `sbi-shinsei-bank`), with the plan
  checks (no table statistics) and the D1 rows-read bound unchanged.
- `services/processor/test/identity-store.test.ts`: a real policy-1 run, then
  the sweep appends one policy-2 run (and a second sweep does nothing); the
  policy-1 rows and revisions are unchanged; every observation keeps its source
  account; revision 2 carries the classification; the entity keeps its role.
- `services/processor/test/identity-audit.test.ts`: `pending_parses` counts a
  policy-1 SBI Shinsei parse until a policy-2 run is sealed, `account_status`
  moves the board from `provider-local` to `aggregate`, the integrity counters
  stay zero and no private value appears in the report.
