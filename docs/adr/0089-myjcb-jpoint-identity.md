# ADR 0089: Classify the MyJCB J-POINT total under identity policy 2, for J-POINT captures only

- Status: proposed
- Date: 2026-11-08
- Carried by:
  `packages/identity/src/other.ts` (MyJCB rule),
  `packages/storage-d1/src/core/identity-policies/myjcb.ts`,
  `packages/storage-d1/src/core/identity-policies/index.ts`
  (`AvailableIdentityEvidence.myJcbJPointArtifact`),
  [identity sources](../identity-sources.md),
  [identity operations](../identity-operations.md#policy-2-myjcb-j-point-total)
- Follows: [ADR 0012](0012-mizuho-identity-policy-v2.md) (per-source policy
  modules and append-only re-identification),
  [ADR 0076](0076-sbi-shinsei-non-account-identity.md)
- Related: [ADR 0004](0004-payment-type-shapes-from-evidence.md) (unobserved
  semantics stay unsupported), [ADR 0082](0082-owner-default-ownership.md)
  (owner-default ownership), [rewards](../rewards.md),
  [card settlements](../card-settlements.md); Phase 3 unit 3f
  ([plan](../plans/2026-11-phase3-coverage-identity.md#3f-account-identity-audit-then-code-where-evidence-allows),
  [#545](https://github.com/risu729/kogane/issues/545),
  [#444](https://github.com/risu729/kogane/issues/444))

## Context

The J-POINT parser (`myjcb-jpoint-balance`, dataset `jpoint-balance`) emits one
balance observation per capture: source account
`myjcb:{connection}:j-point:total`, metric `displayed_jpoint_total`, unit
`J_POINT`. The identity resolver had no rule for that shape, so every run
mapped it `unresolved` / `unrecognized-source-account` under the source's
label `MyJCB請求口座`, the statement account's. It is the only `unresolved`
account reference in production (plan §1.2, read over MCP).

[Rewards](../rewards.md) already treats the observed total as one unclassified
holding in `points:j-point`. Nothing else observes J-POINT, so the total
overlaps no other observed holding.

Identity runs and mappings are append-only, and a new run for one parse needs
a new numeric version (0018: `UNIQUE(parse_run_id, policy_version)`). ADR 0012
and ADR 0076 re-identified every parse of their source. For MyJCB that would
also re-revise the statement root `myjcb:{connection}:root` (unchanged
classification, new mapping revision, new mapping id `<base>-r2`).
Card-settlement ownership evidence cites `account_mapping:<id>` of the root,
and readiness compares the cited refs by id
(`card-settlement-readiness.ts`, `ownership_current`): every MyJCB settlement
candidate, the accepted one included, would read `ownership_changed`, plans
made before the deploy would go stale, and the settlement sweep would
re-propose every candidate under new ids. The owner-default relations name the
account entity and would stay valid.

## Options considered

1. **Leave the reference unresolved.** Rejected: the shape is the parser's
   own constant, and Phase 3 asks resolved and unresolved accounts to be told
   apart; an unresolved reference that is really understood hides the real
   ones.
2. **`aggregate` (as `v-point:smfg:*`).** Rejected: that status marks a display
   that may overlap other observed holdings. J-POINT has none, and `aggregate`
   would also withdraw the within-source disjointness between two
   connections' totals in the balance projection.
3. **`reward-account` / `provider-local`, re-identifying every MyJCB parse at
   policy 2 (the ADR 0012 pattern).** Rejected: the root gains nothing from a
   new revision, and the settlement side effect above is real.
4. **`reward-account` / `provider-local`, policy 2 for J-POINT captures only.**
   Chosen.

## Decision

- **Rule.** In `otherIdentity`, for source `myjcb`, the exact shape
  `myjcb:{connection}:j-point:total` (connection
  `[a-z0-9][a-z0-9-]{0,63}`, the parser's and `reward-claims-job.ts`'s
  pattern) maps to role `reward-account`, status `provider-local`, reason
  `provider-connection-jpoint-total`, label `MyJCB J-POINT`. Precedent:
  `v-point:member` is `reward-account` / `provider-local`. The rule claims the
  scope only (one connection's displayed total); it adds no programme
  semantics (ADR 0004). The key is unchanged (`[reference]`). The rule does not
  read the run's version: it adds a shape and changes none.
- **Policy module.** `identity-policies/myjcb.ts` requires version 2 only when
  the parse's artifact has dataset `jpoint-balance`: the required-policy SQL
  branch is `a.source_id='myjcb' AND a.dataset='jpoint-balance'`, and
  `loadEvidence` reads the artifact's dataset into
  `myJcbJPointArtifact`. Any other MyJCB parse falls back to the base policy
  (`not-a-jpoint-capture`), as a Vpass parse without a trusted binding does.
  Family `identity-default`, release `identity-default-v2`, empty dependency
  set.
- **Re-identification is append-only** and limited to the sealed policy-1
  J-POINT parses; Layer A/B, policy-1 runs and revisions stay as recorded, and
  a manual decision is not replaced.
- **Enablement.** None: the five-minute pipeline sweep picks the parses up
  after deploy.

## Consequences

- The J-POINT total reads `provider-local` with its own label in the identity
  read, the audit's `account_status` and collection quality's
  `unresolved_identities`. Its account entity keeps the `source-account` role
  it was first written with (the ADR 0012 limit).
- Statement parses, the root's mapping revision and id, settlement candidates,
  accepted settlements and owner-default relations are untouched.
- The balance projection is unchanged: within-source disjointness only tests
  `!== "aggregate"`, and reward units are not summable.
- Rolling back leaves the policy-2 runs current.
- Open limit: readiness compares cited mapping ids, so a future policy bump
  that re-revises a card or bank account cited by settlement evidence will
  flip its candidates to `ownership_changed`. That needs its own decision when
  it comes up.

## Verification

Synthetic inputs only:

- `packages/identity/test/identity-other.test.ts`: the exact shape maps to
  `reward-account` / `provider-local` with its label; another connection is
  another account; the root keeps its role and label; near shapes stay
  unresolved.
- `services/processor/test/identity-policies.test.ts`: J-POINT evidence selects
  `identity-default-v2`; no evidence falls back to the base policy with
  `not-a-jpoint-capture`; the required-policy SQL text.
- `services/processor/test/identity-store.test.ts`: a sealed policy-1 J-POINT
  parse is re-identified once at policy 2 and a statement parse is not; the
  root gains no revision, the total gains one, no second source account.
- `services/processor/test/identity-audit.test.ts`: only the J-POINT capture
  counts as pending.
