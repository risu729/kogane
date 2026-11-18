# ADR 0117: Scope an SBI Securities foreign row with no account discriminator to its fetch run under identity policy 3, keeping the foreign cash history's reference

- Status: proposed
- Date: 2026-11-18
- Carried by:
  `packages/identity/src/sbi.ts` (`SBI_UNDISCRIMINATED_ACCOUNT_POLICY_VERSION`,
  `SBI_SECURITIES_POLICY_VERSION`),
  `packages/storage-d1/src/core/identity-policies/sbi-securities.ts`,
  `packages/storage-d1/src/core/identity-policies/index.ts`
  (`IDENTITY_POLICY_VERSION`, `identityPolicyCeilingSql`,
  `AvailableIdentityEvidence.sbiForeignDiscriminatedArtifact`),
  `packages/storage-d1/src/core/identity-sweep-sql.ts`,
  `packages/storage-d1/src/core/identity-store.ts` (`identitySweep`),
  [SBI identity](../identity-sbi.md),
  [identity operations](../identity-operations.md#policy-3-sbi-securities-foreign-rows-with-no-account-discriminator)
- Follows: [ADR 0113](0113-sbi-scopeless-security-identity.md) (the same
  pattern for a security with no scope; its module now requires version 3),
  [ADR 0012](0012-mizuho-identity-policy-v2.md) (per-source policy modules
  and append-only re-identification),
  [ADR 0076](0076-sbi-shinsei-non-account-identity.md) (a rule selected by
  the run's version), [ADR 0089](0089-myjcb-jpoint-identity.md) (some
  datasets of a source re-identified)
- Related: [ADR 0004](0004-payment-type-shapes-from-evidence.md) (unobserved
  semantics stay unsupported), INV05 and INV06 ([ADR 0001](0001-domain-axes.md))

## Context

The SBI Securities rule (`sbiIdentity`) keys a foreign source account by the
parser's reference `sbi-securities:foreign` plus a discriminator: a trade,
position or valuation states `specificAccountCode`, a foreign cash balance
states `account.accountKind`. When the discriminator is missing (a value
`string()` reads as absent: not a string, empty or whitespace only), policies
1 and 2 add the issue `missing-specificAccountCode` or `missing-accountKind`,
map the account `unresolved` and leave the key as the bare
`["sbi-securities:foreign"]`.

The foreign cash history (`sbi-foreign-cash-history`, dataset
`foreign-cash-history`) emits `sbi-securities:foreign` transactions whose row
schema (`FOREIGN_ROW_KEYS`) has no discriminator at all, so every row of every
capture is on that bare key: it is the USD cash ledger's account. Every SBI
dataset has producer `collector-sbi-securities`, and the account entity is
derived from the source account id (`accountEntityId` in
`packages/storage-d1/src/core/identity-store.ts`), so whatever else lands on
the bare key joins the cash ledger's entity. Parser output accepted today
lands there:

- `sbi-foreign-trade-records` requires `specificAccountCode` to be a string
  but accepts `""`;
- `sbi-foreign-cash-positions` never reads or requires it (the position and
  its valuations carry the element as it came, as does the unreadable-element
  position);
- `sbi-foreign-cash-balances` never requires `accountKind`.

A test that ran the anonymous fixtures with the discriminators blanked put the
history, the trades, the positions and valuations and the balances on one
entity: custody holdings, trades and cash balances counted as one account with
the cash ledger (INV06), and in the custody and cash namespaces at once, which
the rule otherwise keeps apart. No observed shape does: every stored fixture
states `SPECIFIC`. Whether any production observation outside the cash history
is on the bare key was not read; a read-only aggregate count answers it (see
[identity operations](../identity-operations.md#policy-3-sbi-securities-foreign-rows-with-no-account-discriminator)).

Identity runs, mappings and identifiers are append-only, and a new run for one
parse needs a new numeric version (0018: `UNIQUE(parse_run_id,
policy_version)`). Positions parses already have policy-2 runs (ADR 0113), so
the next SBI version is 3, above the build's highest (`IDENTITY_POLICY_VERSION`
was 2).

## Options considered

1. **Change the rule in place, with no version.** Rejected: a later run under
   an existing release would record a different meaning than the sealed runs
   of that release, and nothing would re-identify them (as ADR 0113 option 1).
2. **Reuse version 2 for trades and balances.** Rejected: positions parses
   already have sealed policy-2 runs, so they could not be re-identified, and
   version 2 would mean different rules for different datasets.
3. **Give the cash history its own reference instead.** Rejected: it would
   move the USD cash ledger, the shape every capture has, to a new source
   account and entity, and the parser's Layer B reference is evidence that is
   not rewritten.
4. **Assume a missing code means `SPECIFIC`, or the account the capture's
   other rows state.** Rejected: nobody observed the provider omit it, and an
   unobserved semantic is not guessed (ADR 0004).
5. **Scope the unresolved account to the single observation.** Rejected, as
   ADR 0113 option 4: a capture's rows would become one account each, each
   needing its own review, without separating anything the capture scope does
   not.
6. **Tell the cash history apart by the artifact's dataset, passed into the
   resolver.** Not taken: the resolver reads the observation and the run's
   version only, and a resolver call without the dataset (the identity
   tests, a direct call) would have to guess. The row itself shows it: the
   cash history schema has no discriminator field, and the trade parser
   requires the field.
7. **Under policy 3, scope such a row to its fetch run, `unresolved` with the
   existing closed code as its reason, keep the cash history on the bare key,
   and re-identify the three datasets that can emit the shape.** Chosen.
8. **Require policy 3 only for captures that hold the shape**, or **carry an
   existing rule mapping forward when the new plan equals it.** Not taken, for
   ADR 0113's reasons (options 6 and 7): the required-policy SQL would have to
   restate the resolver's test over every row's `extra_json`, and the store
   appends one rule revision per subject for each newer version for every
   source.

## Decision

- **Rule (policy 3).** In `sbiIdentity`, a foreign row whose discriminator is
  missing gets the key
  `["sbi-securities:foreign", "missing-<field>", "fetch-run", "<fetch run id>"]`
  (`<field>` is `specificAccountCode` for a trade, position or valuation and
  `accountKind` for a cash balance), status `unresolved` and reason
  `missing-<field>`. The issue list, the label, the role and every instrument
  are policy 2's. A foreign **transaction that does not state
  `specificAccountCode` at all** is a cash history row and keeps the bare key
  under every version; a stated but unusable value (`""`, whitespace, a
  non-string) is missing. The added `missing-<field>` element cannot equal a
  field name, so the key never collides with a stated discriminator, whatever
  value the provider states.
- **The rule is selected by the run's version** (`IdentityInput.policyVersion`):
  below 3 the row keeps the bare key and reason
  `exact-provider-account-reference`, so policy-1 and policy-2 runs record
  what their releases meant. The ADR 0113 security rule applies from version
  2 (`SBI_SCOPELESS_SECURITY_POLICY_VERSION`), so it holds at 3. A call
  without a version gets the newest rules.
- **Policy module.** `identity-policies/sbi-securities.ts` requires version
  `SBI_SECURITIES_POLICY_VERSION` (3) when the parse's artifact has dataset
  `foreign-trade-records`, `foreign-cash-positions` or
  `foreign-cash-balances` (`sbiForeignDiscriminatedArtifact`). Any other SBI
  Securities parse, the foreign cash history included, falls back to the
  base policy (`not-a-discriminated-foreign-capture`). Family
  `identity-default`, release `identity-default-v3`, empty dependency set.
- **The build's highest version becomes 3** (`IDENTITY_POLICY_VERSION`). Two
  store paths that compared against it are changed so that no other source
  is affected:
  - the sweep's completed-parse shortcut compares a parse's sealed version
    with its source's ceiling (`identityPolicyCeilingSql`: the source
    module's version, else the base version) instead of the build's highest,
    so a parse sealed at 2 of Vpass, Mizuho, SBI Shinsei or MyJCB still skips
    the evidence lookups; candidates are unchanged, since no artifact of a
    source requires more than its ceiling;
  - the sweep's empty-parse path selects with the standard request, as the
    row path does, not with the required version: requested 2 is no longer
    the standard request, and a module that falls back would otherwise store
    a default-family run at version 2 instead of the base version.
    Manual decisions and `instrument-auto-v1` adoptions are stamped with the
    build's highest version (`policy_version` 3 instead of 2); the store's rule
    guards read only rule revisions, so this changes no mapping.
- **Re-identification is append-only** and limited to sealed parses of those
  three datasets below policy 3. Layer A/B, earlier runs, the bare source
  account and every earlier revision stay as recorded, and a manual decision
  is not replaced.
- **The audit** already counts `missing-specificAccountCode` and
  `missing-accountKind` as closed issue codes; `pending_parses` counts the
  three datasets below policy 3.
- **Enablement.** None: no migration, setting, reimport or reparse. The
  five-minute pipeline sweep picks the parses up after deploy.

## Consequences

- A foreign trade, position, valuation or cash balance with no discriminator
  no longer shares an account or an entity with the USD cash ledger, and the
  custody and cash namespaces no longer share one. Each such row is
  `unresolved` on its capture's account, with its own entity; the identity
  read's account list shows it, and a person or an agent maps it with
  `identity.assign`. It was `unresolved` on the bare key too, so collection
  quality's `unresolved_identities`, which counts observations on unresolved
  account mappings, does not change. Within
  one capture, every custody row without its code shares one account, and
  every cash balance without its kind shares another. Reads that follow an
  account across captures (the reported and dated state) see each capture's
  such account as an account of its own, as for an ordinal card reference,
  until a person maps them together.
- **Which parses get a new run:** every sealed SBI Securities parse of
  `foreign-trade-records` and `foreign-cash-balances` (sealed at policy 1) and
  of `foreign-cash-positions` (sealed at policy 2, or at 1 if the ADR 0113
  sweep had not reached it; it goes straight to 3) gains one policy-3 run, and
  the current views select it. No other parse does: not the foreign cash
  history, domestic positions and trades, yen cash, account assets, income or
  gains, nor any other source.
- **What stays the same:** the foreign cash history parses keep their
  policy-1 runs; the bare `sbi-securities:foreign` source account, its
  entity and its mapping revisions gain nothing, so the cash ledger does not
  churn, and a manual decision on it keeps applying to the history. Every
  observed shape (all fixtures, which state `SPECIFIC`) plans identically
  under policies 1, 2 and 3, so each re-identified observation keeps its
  source account, identifiers, account entity and instruments; balances,
  valuations and candidate statuses read the same values.
- **Which mappings get a new revision**, equal to the current rule revision
  except for its id, revision and version, at the first policy-3 run that
  uses the subject: the foreign custody accounts
  (`["sbi-securities:foreign","specificAccountCode",<code>]`), the foreign
  cash accounts (`["sbi-securities:foreign","accountKind",<kind>]`), every
  `ric//<RIC>` and `sbi-security-code/<country>/<code>` identifier a trade or
  positions capture names (positions subjects that ADR 0113 revised at
  policy 2 are revised again), and the shared currency identifiers
  `iso4217/global/USD` and `iso4217/global/JPY`, which every source uses and
  no other source's run has revised at 3. A subject whose current mapping is
  manual, or a rule adoption onto another instrument, gains no revision. A
  foreign cash history parse kept at policy 1 keeps citing the USD revision it
  recorded while the current USD mapping becomes the policy-3 one. An open
  plan that pinned an earlier revision of one of these subjects is refused at
  approval with `stale_context` and has to be planned again. No
  card-settlement evidence cites an SBI Securities account mapping, economic
  revision seals pin no identity revision today, and `instrument-auto-v1`
  adopts only domestic identifiers.
- **A row that was on the bare key** (none observed): its current observation
  moves to its capture's unresolved account; its earlier runs still name the
  bare key and readers asking for `as-recorded` see them. A manual decision on
  the bare account is not carried to the new accounts; it has to be made
  again on them.
- Rolling back leaves the policy-3 runs current: an older build cannot replace
  a newer sealed decision.
- Open limits: two different custody accounts that one capture reports
  without a code still share one account (and likewise two cash accounts
  without a kind); no observed capture does, and the capture states nothing
  that tells them apart. The cash history is recognized by its row shape: a
  future foreign transaction parser that omits the field would be read as
  the cash ledger, so such a parser needs its own reference or a rule change.
  The cash history's own account stays `unresolved`
  (`missing-specificAccountCode`) with a custody label, as before; classifying
  it is a separate decision.

## Verification

Synthetic inputs only:

- `packages/identity/test/identity-sbi-policy.test.ts`: the policy-1 and
  policy-2 golden plans of each shape are unchanged (all on the bare key);
  under policy 3 a trade stating `""`, a position and a valuation not stating
  the code, and a balance not stating the kind are `unresolved` on their
  capture's account with the closed reason, and only the account changes;
  custody and cash keys differ, captures differ, and a provider value equal to
  the issue code still keys the discriminator; the cash history plans
  identically under every version; through the real parsers, with the
  discriminators blanked, the four datasets share the bare key under
  policies 1 and 2 and none but the history keeps it under policy 3; every
  shape with a discriminator and every SBI parser fixture plans identically
  under all three versions.
- `services/processor/test/identity-policies.test.ts`: the three datasets
  select `identity-default-v3`; no evidence falls back to the base policy with
  `not-a-discriminated-foreign-capture`; every other source's selection is
  unchanged; the required-policy SQL text.
- `services/processor/test/identity-store.test.ts`: four sealed policy-1
  parses (history, trade, positions, balances) on one entity; the sweep
  re-identifies the three non-history parses once at policy 3 onto four
  distinct entities, the history keeps its run, source account, entity and
  mapping revisions, and every policy-1 run still names the bare key. The
  ADR 0113 tests now re-identify at policy 3 with the same outcome; an
  observed-shape trade parse is re-identified too and its policy-1 run keeps
  citing the revision it recorded. The existing Vpass candidate-cost test
  holds with the per-source ceiling.
- `services/processor/test/identity-audit.test.ts`: trades and balances
  sealed at 1 and positions sealed at 1 or 2 count as pending; positions at
  3, the cash history and a domestic capture do not.
- `packages/storage-d1/test/identity-sweep-query.test.ts`: the candidate SQL
  still equals the frozen legacy text on scaled random stores.
