# ADR 0034: Account evidence before automatic card settlement

- Status: accepted; self-declared ownership amendment proposed until its PR merges, then accepted
- Date: 2026-10-04
- Related: ADR 0032, ADR 0001 INV07, card-settlements.md

## Context

The owner requests automatic adoption of ordinary card settlements, with
Workers AI considered only where deterministic logic cannot resolve a case.
Account identification must precede automation.

SMBC Direct explicitly selects a branch, ordinary-deposit item code 2206 and
account number in its authenticated balance and account-detail requests.
The normalizer discarded that selection. A bounded read-only shape check of
one stored balance response and one stored transaction response found no
branch/account-number field in either response. Existing normalized artifacts
therefore cannot recover the selection. Request context is not a
provider-displayed account statement or ownership evidence.

## Options considered

1. Infer an account from equal amounts or from the only collected account.
   Rejected: that would invent identity.
2. Rename every legacy source account to include newly obtained digits.
   Rejected: it would relabel evidence that never recorded those digits.
3. Retain the selected account alongside each new normalized artifact and
   compare it only for the debit whose parse records that context. Chosen.

## Decision

- New SMBC normalized balance/transaction artifacts may carry an exact
  `account` object: `basis=authenticated-request-v1`, `accountType=ordinary`,
  a three-digit branch code and a seven-digit account number. These values
  come from the request that successfully returned that artifact. A four-digit
  branch beginning in zero is the request's padded three-digit code; other
  layouts supply no context. Credentials, cookies and tokens are never copied.
- Both SMBC parsers advance to 1.1.0. Old artifacts retain their exact old
  meaning and source account. New context is validated and retained as
  `extra._kogane.bankAccount`. Invalid supplied context fails closed.
- The debit-account policy advances to v3. An SMBC comparison is permitted
  only using that candidate debit's own published parser context; its
  transaction/parse reference is included in the proposal's evidence.
  No newer balance, another run or current credential fills a historical gap.
  The existing source-account identifier is unchanged. This is an additional
  property of the selected observation, not an identity migration.
- A prefix agreement remains a proposal. It establishes neither ownership
  nor the historical effective period of a card's displayed debit account.
  SBI Shinsei's unverified identifier layout remains uncomparable.
- No automatic acceptance, ownership inference, AI call, money action or
  source-evidence rewrite is introduced by the account-evidence path.

## Automation rollout

This PR provides a pure, separately tested assessment function with strict
policy checks and closed blocker codes. No production adapter calls it yet.
The CLI performs a bounded read-only aggregate prerequisite query only, not
candidate verdicts. Its uniqueness counts concern the sampled graph and its
context count measures presence, not validity; neither authorizes adoption.
Both paths have no approval/commit permission. Scope must explicitly bind a
resolved card account, a resolved bank account, an effective interval and
ownership evidence. Candidate completeness, two-sided uniqueness, current
facts, no contrary evidence, no prior rejection/withdrawal, and allocation
availability are required. A model's confidence cannot substitute for them.

A later acceptance lane must record a rule decision under a versioned,
owner-authorized policy and reuse the guarded atomic settlement writer.
It must preserve manual decisions and support withdrawal. Human approval
receipts are not fabricated. INV07 and the change-lifecycle documents must
be amended with that executable lane, not described as already changed.

Workers AI is deferred until deterministic gaps are measured. Its role would
be evidence extraction/classification for unresolved cases, not unrestricted
commit access.

## Consequences

Existing SMBC history remains uncomparable until a capture records its
selection; this change does not backfill missing evidence. SMBC acquisition
still needs its existing human Safety Pass approval. Synthetic validation is
not proof that a new authenticated production capture has succeeded.
The legacy single ordinary-account scope is not generalized to multiple bank
accounts by this change. Changing the configured account requires separate
identity/continuity review, not reuse of its history.

## Verification

Synthetic tests cover request-context normalization, invalid shapes, legacy
parser compatibility, retained account evidence, candidate-specific comparison
and a refusal to enrich old evidence from another capture. Automation checks
cover competition, incomplete inputs and manual decisions. No provider values
are used as fixtures.

## Read-cost amendment: repeated due dates

The settlement sweep shares bank results only within one invocation and one
CORE source/visibility revision and epoch. It reads that tuple before every
use, brackets a cache miss with another tuple read, and never stores a result
if the tuple changed during the query. Any changed or unavailable tuple clears
the cache. The existing bank SQL, ordering, 1,000-row limit and logical scanned
count remain unchanged. The cache retains at most 32 dates and 2,000 rows,
evicts least recently used entries, and never truncates query results.

All bank query inputs are covered by the existing revision contract: transaction
inserts create decimal rows whose triggers advance the source revision;
publication, identity, mappings and owner decisions advance it directly.
Evidence becomes visible at sealing, and later exclusion advances the visibility
revision. Sealed source records are immutable. No new revision counter,
migration, cross-tick cache or ownership inference is introduced.

A write after the revision read may occur before a proposal is recorded, just
as it could after the original bank query. Proposals retain their fact revisions,
and the existing guarded acceptance path remains authoritative. This cache
does not authorize acceptance.

Frozen query text, existing scaled/random-store differential and plan tests,
and new production-schema cache invalidation tests cover preservation.
At the committed CI-scale fixture an existing-candidate replay makes 10 bank
queries instead of 15 with identical results. Fresh-proposal sweeps on random
stores also compare the complete proposed facts and debit-account evidence. This synthetic query-count reduction is not a
production billing forecast.

## Self-declared ownership amendment (2026-10-10)

### Context and options

This is a single-user application. The owner explicitly permits treating their
bank accounts as their own when an authenticated page does not show the name.
Login alone still proves neither beneficial ownership nor card liability.
Requiring provider-name evidence in every case unnecessarily prevents the
owner from recording that personal assertion. Silently labelling the assertion
as provider-verified would be false. A separate, explicit provenance is chosen.

### Decision

The existing card-ownership review offers an optional **sole-personal
self-declaration**, separate from a reviewed-evidence judgement. The operator
selects their stable party identifier, confirms the current source/account
mapping, selects the assertion date and explicitly confirms the role. Bank
`beneficial_owner` and card `liable_party` remain different assertions: a bank
ownership statement does not establish card liability. Joint, third-party,
family-card liability and corporate relationships are not eligible for this
fallback. No owner is derived from the login, display-name match or amount.

The closed evidence reference
`ownership-declaration:sole-personal-v1:<role>:YYYY-MM-DD` is included alongside
the existing candidate, fact, parse and account-mapping evidence. It is covered
by the existing immutable command payload/digest and accepted decision. The
simulation and claim history label it `self-declared`, with provider-name
verification false. The declaration date records the assertion, not the start
of account ownership or proof of a historical ownership period. Existing
evidence-review decisions are not retroactively labelled provider-verified.

Self-declaration first requires a non-aggregate, non-unresolved account and
mapping with the exact `card-statement` or `deposit` role. Connection roots,
including MyJCB's `card-statement-aggregate`, do not identify individual cards:
one root can also be recorded under both legacy and current producers. Counts
of these identities are not physical card counts, and no declaration may turn
them into individual-card evidence. Existing explicit evidence review remains
available; resolving or merging identities is a separate decision.

Self-declaration is also refused if _any_ ownership-role history exists for the
resolved account (including another role, rejection or dated claim), or a
recorded `contradicts` relation touches that account, source-account reference
or the four review evidence references. This conservative fallback does not
traverse `same_account` or parent/child links, interpret raw provider text, or
claim to detect unrecorded corporate/joint ownership. Those cases require
explicit evidence review. The same predicates run again inside the existing
atomic receipt guard, in addition to all publication, mapping and revision
guards. A competing judgement cannot slip between planning and commit.

### Consequences and verification

No schema migration, production adoption, automatic acceptance, new grant,
agent approval right or provider-name collection is introduced. Rejection and
correction use the existing explicit review path and append a revision; they
never delete the original declaration. Recording both roles still leaves all
settlement candidates proposed. A fresh sweep and separate human settlement
approval remain necessary; stale candidates are never revived.

Synthetic domain/read-model tests cover closed markers, role/date validation,
aggregate/unresolved/wrong-role account refusal,
historical claims and direct contrary evidence. Lifecycle tests cover human
approval, agent refusal, immutable readback, replay, append-only correction and
an opposite-role judgement arriving at batch time. Browser tests cover the
role-specific assertion, provenance warning and blocked fallback. These are
local/synthetic checks, not evidence of production adoption or provider KYC.
