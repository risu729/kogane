# ADR 0113: Map an SBI Securities code with no RIC, MIC or country as unresolved under identity policy 2, for foreign positions captures only

- Status: proposed
- Date: 2026-11-18
- Carried by:
  `packages/identity/src/sbi.ts` (`SBI_SECURITIES_POLICY_VERSION`),
  `packages/storage-d1/src/core/identity-policies/sbi-securities.ts`,
  `packages/storage-d1/src/core/identity-policies/index.ts`
  (`AvailableIdentityEvidence.sbiForeignPositionsArtifact`),
  `packages/storage-d1/src/core/identity-audit.ts` (issue
  `missing-security-scope`),
  [SBI identity](../identity-sbi.md),
  [identity operations](../identity-operations.md#policy-2-sbi-securities-codes-with-no-scope)
- Follows: [ADR 0012](0012-mizuho-identity-policy-v2.md) (per-source policy
  modules and append-only re-identification),
  [ADR 0076](0076-sbi-shinsei-non-account-identity.md) (a rule selected by the
  run's version), [ADR 0089](0089-myjcb-jpoint-identity.md) (one dataset of a
  source re-identified)
- Related: [ADR 0004](0004-payment-type-shapes-from-evidence.md) (unobserved
  semantics stay unsupported), [ADR 0055](0055-instrument-candidates.md)
  (candidates read identifier facts)

## Context

The SBI Securities rule (`sbiIdentity`) gives a security reference one
identifier `(namespace, scope, value)`. With a provider RIC it is `ric//<RIC>`;
with a mapped domestic venue `mic-symbol/<MIC>/<code>`; otherwise
`sbi-security-code/<scope>/<code>`, where the scope was
`mic ?? country ?? "unknown-country"`. The store keys
`instrument_identifiers` by that triple across every parse and source, and by
rule maps each identifier onto an instrument of its own. So under policy 1 a
code with no RIC, no MIC and no country got the shared placeholder scope
`unknown-country`: two different securities stating the same code would share
one identifier and one instrument (a wrong merge, INV06). The placeholder
also stands in for a value nobody reported (INV05).

Which inputs reach that branch:

- Domestic rows never do: their country is always `JP`.
- `mic` is only ever set for domestic rows, so a foreign row reaches it when
  it has a code and states neither a RIC nor a country (at
  `securities.countryCode` or the element's `countryCode`).
- `sbi-foreign-trade-records` refuses a row without `countryCode`, and every
  version of it has (the first one, 1.0.0, already did), so trades never
  reach it.
- Foreign cash history rows (`sbi-foreign-cash-history`) carry no security
  and resolve to `missing-security-identifier`; foreign cash balances are
  balance observations, which carry no security.
- `sbi-foreign-cash-positions` (dataset `foreign-cash-positions`) does not
  require `countryCode` or `ric`. A position, and each of its up to four
  valuations, reaches the branch when its element states neither.

No observed shape does: the collector asks `GetSecuritiesBalanceList` for
`countryCode: "US"`, and the anonymous fixture that mirrors the observed
response states `countryCode` at both levels and a RIC for every element. The
only parser test rows without them are the parser's own edge cases (`FRAC`,
`NOCUR`). Whether any production identifier has the placeholder scope was not
read; a read-only aggregate count
(`SELECT count(*) FROM instrument_identifiers WHERE scope='unknown-country'`)
answers it.

Identity runs, mappings and identifiers are append-only, and a new run for one
parse needs a new numeric version (0018: `UNIQUE(parse_run_id,
policy_version)`).

## Options considered

1. **Change the rule in place, with no version.** Rejected: a later run under
   `identity-default-v1` would record a different meaning than the sealed
   policy-1 runs of the same release, and nothing would re-identify them.
2. **Assume the collector's query country (`US`).** Rejected: the response
   does not state it, and a provider semantic nobody observed is not guessed
   (ADR 0004).
3. **Drop the security from the plan, as for a missing code.** Rejected: the
   provider did report a code; dropping it hides the reference from review
   instead of asking for it.
4. **Scope the unresolved identifier to the single observation.** Rejected:
   a position and its valuations from one element would become five
   identifiers per capture, each needing its own review, without separating
   anything the capture scope does not.
5. **Under policy 2, map the shape `unresolved` on an identifier scoped to its
   fetch run, as the rules already treat a reference whose durable identity
   cannot be established (an ordinal card or reward-bucket reference is
   `unresolved` and keyed by `fetch-run`), and re-identify foreign positions
   captures only.** Chosen.
6. **Require policy 2 only for a positions capture that holds the shape.**
   No observed capture would then be re-identified, so no unchanged identity
   would gain a revision (see Consequences). Not taken: the required-policy
   SQL is evaluated per artifact by the sweep and the audit, so it would have
   to restate the resolver's test (a RIC, a country at either level, the
   resolver's whitespace rule) over the provider's `extra_json` of every
   position, and the other policy modules select on stored evidence or the
   dataset, never on provider text. It stays open if the revisions below are
   not acceptable.
7. **Carry an existing rule mapping forward when the new plan equals it.**
   Not taken: the store appends one rule revision per identifier and source
   account for each newer policy version (ADR 0012), and the SBI Shinsei and
   MyJCB bumps (ADR 0076, ADR 0089) relied on that; changing it would change
   every source's re-identification, not this rule.

## Decision

- **Rule (policy 2).** In `sbiIdentity`, a security with a code and no RIC, no
  MIC and no country gets namespace `sbi-security-code`, scope
  `fetch-run:<fetch run id>`, status `unresolved` and reason
  `missing-security-scope`, and the plan adds the issue
  `missing-security-scope` beside `security-without-global-crosswalk`. Label
  and details are as before (`details` names no country). The account and the
  money units are unchanged, and so is every other shape: with a RIC, a MIC or
  a country the plan is policy 1's.
- **The rule is selected by the run's version** (`IdentityInput.policyVersion`,
  as ADR 0076): below 2 the shape keeps policy 1's `unknown-country`
  identifier, so an explicit policy-1 run still records what release
  `identity-default-v1` meant. A call without a version gets the newest rules.
- **Policy module.** `identity-policies/sbi-securities.ts` requires version
  `SBI_SECURITIES_POLICY_VERSION` (2) only when the parse's artifact has
  dataset `foreign-cash-positions`: the required-policy SQL branch is
  `a.source_id='sbi-securities' AND a.dataset='foreign-cash-positions'`, and
  `loadEvidence` reads the artifact's dataset into
  `sbiForeignPositionsArtifact`. Any other SBI Securities parse falls back to
  the base policy (`not-a-foreign-positions-capture`), as a MyJCB statement
  parse does. Family `identity-default`, release `identity-default-v2`, empty
  dependency set.
- **Re-identification is append-only** and limited to the sealed policy-1
  foreign positions parses; Layer A/B, policy-1 runs, the placeholder
  identifier and every earlier revision stay as recorded, and a manual
  decision is not replaced.
- **The audit** counts `missing-security-scope` as a closed issue code.
- **Enablement.** None: no migration, setting, reimport or reparse. The
  five-minute pipeline sweep picks the parses up after deploy.

## Consequences

- Two different securities stating one code with no RIC, MIC or country in
  different captures no longer share an identifier or an instrument. Each is
  `unresolved`: the identity read's instrument list shows that status, the
  audit's `instrument_status` counts it and its `issues` count
  `missing-security-scope`, and a person or an agent maps it with
  `identity.assign`. Collection quality's `unresolved_identities` counts
  account mappings only, so it does not change. Within one capture, every row of that code shares
  one identifier: the position and its valuations, and the same code held in
  several custody accounts.
- What happens to identities stored under policy 1: each sealed policy-1
  foreign positions parse gains a policy-2 run, and the current views select
  it. If such a parse used an `unknown-country` identifier, its current
  observations move to the capture-scoped unresolved identifiers; the
  placeholder identifier, its mapping revisions and the policy-1 runs that
  name them stay as recorded, and readers asking for `as-recorded` still see
  them. The placeholder then has no current use, so the candidate read and
  per-source coverage stop listing it. A manual decision recorded on the
  placeholder stays on it and is not carried to the new identifiers; it has
  to be made again on them.
- Revisions of unchanged identities, which is every observed one: for a parse
  whose rows all state a RIC or a country the plan is unchanged, yet the
  first policy-2 run that uses a subject appends one policy-2 rule revision
  to it, equal to the policy-1 one except for its id, revision and
  version. The subjects are the foreign brokerage source accounts and every
  `ric//<RIC>` and `sbi-security-code/<country>/<code>` identifier a
  positions capture names, and the shared currency identifiers
  (`iso4217/global/USD`, `iso4217/global/JPY`) unless another source's
  policy-2 run already revised them. The account entity and the instrument
  stay the same, so balances, valuations and candidate statuses read the
  same values. A subject whose current mapping is manual, or a rule adoption
  onto another instrument, gains no revision. A foreign trade parse, which
  stays at policy 1, keeps citing the policy-1 revision it recorded for the
  same identifier, while the identifier's current mapping becomes the
  policy-2 one. An open plan that pinned the policy-1 revision (an
  instrument candidate's `identity.assign`, say) is refused at approval with
  `stale_context` and marked stale; it has to be planned again. No
  card-settlement evidence cites an SBI Securities mapping, and
  `instrument-auto-v1` adopts only domestic identifiers, which positions
  captures do not use.
- Every other SBI Securities parse (domestic, trades, cash, account assets)
  stays at policy 1 and gains no revision, including the domestic codes rule
  `instrument-auto-v1` adopts.
- The unresolved identifiers state no country, so they pair with nothing as a
  candidate; equal provider names across captures can appear as hints, which
  adopt nothing.
- Rolling back leaves the policy-2 runs current.
- Open limits: a capture-scoped identifier still joins two different
  securities that one capture reports with the same code and no RIC or
  country; no observed capture does, and the capture states nothing that
  could tell them apart. A future SBI parser that can emit this shape needs
  its dataset added to the module, or its parses keep policy 1's placeholder.
  Valuation and the report job key holdings and prices by
  `instrument:<source>:<market>:<code>` (`instrumentRef` in
  `services/processor/src/report-job.ts`, built from the position row's
  `market` and `security_code`), not by identity; that key is unchanged
  here, so two such securities with no market code still share it there.

## Verification

Synthetic inputs only:

- `packages/identity/test/identity-sbi-policy.test.ts`: the policy-1 golden
  plan of the shape is unchanged (two securities share the
  `unknown-country` identifier); under policy 2 they do not, each is
  `unresolved` / `missing-security-scope` on its own capture's scope; account
  and units are unchanged; a position and its valuation in one capture share
  one identifier; every shape with a RIC, MIC or country and every SBI parser
  fixture plans identically under both versions; through the real parsers
  only a positions element without country or RIC reaches the rule, and the
  trade parser refuses it.
- `services/processor/test/identity-policies.test.ts`: positions evidence
  selects `identity-default-v2`; no evidence falls back to the base policy
  with `not-a-foreign-positions-capture`; the required-policy SQL text.
- `services/processor/test/identity-store.test.ts`: two sealed policy-1
  positions parses sharing the placeholder are re-identified once at policy 2
  onto two capture-scoped unresolved identifiers; the placeholder and every
  earlier revision stay; a domestic parse is not re-identified and its listing
  gains no revision. An observed-shape positions parse (country and RIC)
  gives its source account and an unchanged RIC identifier one policy-2
  revision each, equal but for id, revision and version; a manually mapped
  identifier gains none; a foreign trade parse keeps citing the policy-1
  revision while the current mapping moves to the policy-2 one.
- `services/processor/test/identity-audit.test.ts`: only the positions
  capture counts as pending; `missing-security-scope` is an audited code.
