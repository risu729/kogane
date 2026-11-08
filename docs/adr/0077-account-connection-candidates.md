# ADR 0077: Propose aggregator-to-direct account containment from confirmed connection reviews; never propose the same account without leaf evidence

- Status: accepted (merged 2026-11-06 in #949)
- Date: 2026-11-06
- Issue: part of #545
- Carried by: `packages/domain/src/account-candidates.ts` (policy
  `account-candidates-v1`), `packages/read-model/src/account-candidates.ts`,
  `packages/application/src/query/account-candidates.ts`
  (`reviewAccountCandidates`), `services/app/src/account-candidates-api.ts`
  (the route), the `kogane.accounts.candidates` case of
  `services/app/src/read-tools.ts`, the `accounts.candidates` entry of
  `packages/application/src/operation-path/catalogue.ts`,
  `packages/observation-shared/src/account-candidates-contract.ts` (the wire
  check), `apps/web/src/pages/AccountCandidates.tsx` and
  `apps/web/src/account-candidates-api.ts`
- Related: [ADR 0027](0027-moneyforward-collector-account-identity.md) (the
  MoneyForward account identity), [ADR 0029](0029-data-classification-and-unkeyed-identity.md),
  [ADR 0030](0030-identity-crosswalk.md) (the one-time v1-to-v2 rewrite),
  [ADR 0055](0055-instrument-candidates.md) (the instrument analogue),
  [account connections](../account-connections.md),
  [change lifecycle](../change-lifecycle.md)

## Context

Issue #545 asks to tell, with evidence, whether an account seen directly at a
provider and an account seen through an aggregator (Money Forward) are the
same, and to keep different products, unresolved references and correction
history visible, without counting anything twice. What exists today:

- **Source-local identity.** A MoneyForward account identity
  (`moneyforward-me:moneyforward-account-v2-<64 hex>`, ADR 0027/0029) is one
  provider connection registered at MoneyForward: one account-detail page
  that can list several products. Its only parsed observations are monthly
  calendar transactions, keyed by that identity; the account-detail and
  accounts-index parsers are evidence-only and record no field. No parser
  records a branch code, an account number, a masked fragment or a leaf
  account reference for a MoneyForward row.
- **Connection reviews.** `account_connection_reviews` (CORE 0023) holds
  append-only reviews per (producer, connection key). A `confirmed` review is
  possible only for SBI Shinsei (its CHECK): the private verifier
  (`review-account-connections.ts`) compared the detail page's branch and
  displayed account number with the direct `nationalid` in memory, and pinned
  the exact direct source accounts listed by the direct overview of the same
  run. The view `current_account_connection_reviews` rechecks that the pinned
  artifacts are still eligible. The audit of 2026-09-08 found one confirmed
  connection covering 16 direct references, three unresolved connections, and
  zero proven leaf-account equivalences: MoneyForward shows the ordinary and
  the hyper-deposit rows under one displayed number.
- **Relations.** `entity_relations` (CORE 0029) admits `same_account` and
  `connection_contains`, and `relation.accept` / `relation.reject` plan,
  approve and commit any of them through the change lifecycle, with the
  relation's row count as the expected revision. Migration 0029 backfilled
  one accepted `connection_contains` relation from
  `connection:<producer>/<key>` to `source_account:<id>` per reference of
  each then-current confirmed review. Reviews appended later write no
  relation. The balance projection reads accepted `same_account` (one
  measurement) and containment kinds (a subset) as scope claims.
- **What is missing.** No read lists which aggregator connection may contain
  which direct accounts, on which evidence, in which decision state; nothing
  says why no same-account candidate exists; a person cannot decide a pair
  from a page, and an agent cannot read the set.

## Options considered

1. **Map the aggregator source account onto the direct account's entity by
   rule** (or propose `identity.assign` to do so). Rejected: the aggregator
   identity is a whole connection, so one entity would stand for several
   products (INV06, "different products stay apart"); a rule would change
   adopted state (INV07).
2. **Propose `same_account` when a confirmed review names exactly one direct
   account.** Rejected: the review proves a shared provider connection, not
   which product a MoneyForward row belongs to; MoneyForward can show two
   products under one displayed number, and the direct overview of one run
   need not list every product MoneyForward shows. No recorded field binds a
   leaf (ADR 0004: unobserved semantics stay unsupported).
3. **Match labels, institution names or amounts.** Rejected: names are
   display claims and amounts coincide; the same rule as ADR 0055 and
   `reconcile.ts`.
4. **Store candidates, or add a command kind with a migration.** Rejected:
   candidates are derivable from stored reviews and relations at read time,
   and `relation.accept` / `relation.reject` already write exactly the
   append-only relation and decision a containment judgement needs.
5. **A pure candidate function over current confirmed reviews proposing
   `connection_contains`, decided by the existing relation commands, with
   closed reasons why `same_account` is not proposed.** Chosen.

## Decision

Policy `account-candidates-v1`:

1. **Evidence.** One candidate per (current confirmed review, direct source
   account it pinned), evidence `connection-review-confirmed`, evidence refs
   `account-connection-review:<producer>/<key>@<revision>` and the review's
   `fetch_artifact:` ids. Nothing else is read as evidence: no label, name,
   institution, amount or date.
2. **Relation.** The candidate proposes `connection_contains` from
   `connection:<producer>/<key>` (the reference migration 0029 used) to
   `source_account:<direct id>`. It names, for a person to plan with a reason,
   `relation.accept` and `relation.reject` of exactly that triple with those
   evidence refs and no validity window.
3. **Status from stored relations only**: `accepted` or `rejected` when the
   newest relation of the pair (by `created_at`, then `id`, as the change
   lifecycle orders a relation's history) says so; otherwise (none,
   `proposed`, `released`) `proposed`. A pair is one (identity value, direct
   source account), and its relations are read under every reference it may
   have been recorded under, each listed in `recordedContainment` with a
   closed code: the candidate's own reference (`this-connection`), another
   producer's current review of the same identity value
   (`same-identity-value`; decision 4 already treats it as one connection),
   and a reference migration 0029 backfilled under a key the one-time
   identity-value rewrite (migration 0063) later replaced on the review row
   (`legacy-connection-key`). The last mapping is the one 0029 wrote, never a
   guess: the relation's id `rel_legacy_connection_<review row id>_<index>`
   and decision `dr_legacy_connection_<review row id>_<index>` name the
   review row (0063 kept row ids), its `to_ref` must be that row's pinned
   reference at that index, its `from_ref` must carry the row's producer,
   and the row's key now differs from the one the relation names. Accept is
   named unless a hold applies or the pair is accepted under any of them, so
   a pair decided before the rewrite or under another producer's reference is
   never offered for a second acceptance; reject (keep apart, or withdraw an
   acceptance) unless the pair is rejected. Both are planned under the
   candidate's own reference.
4. **Holds** withhold acceptance only: `evidence-ineligible` (the view's
   recheck failed) and `direct-account-in-several-connections` (the direct
   account is pinned by current eligible confirmed reviews of two or more
   identity values, as when two registrations share a displayed number). Two
   producers' reviews of one identity value are one connection, not a
   collision. Neither side is chosen; rejecting stays possible.
5. **Never `same_account`.** Every candidate states
   `sameAccount.proposed: false` with the closed reason
   `aggregator-account-connection-scoped`, plus `several-direct-accounts`
   when the review pins more than one direct account (one aggregator account
   matching several direct accounts: none is chosen). A `same_account`
   relation already stored between the connection's aggregator source
   accounts and the direct account, in either orientation, is reported as
   recorded, never derived or proposed.
6. **Other lists.** `connections`: every current review with its state
   (`confirmed`, `unresolved`, `evidence-ineligible`), its pinned direct and
   its aggregator source accounts (all `moneyforward-me` source accounts, of
   any producer, whose reference names the key). `unreviewed`: aggregator
   source accounts no current review names (`no-connection-review`) or whose
   reference is not one identity value (`reference-unrecognized`).
7. **Serving.** `reviewAccountCandidates` serves one page (50 items; views
   `open`, `held`, `decided`, `connections`, `unreviewed`; an optional
   `sourceAccountId`) with the manifest of policy, bounds and closed codes,
   the summary and every named source account with its current mapping, to
   whoever its grant allows: `records.read` over the whole store, the same
   rule as instrument candidates. `GET /api/identity/account-candidates`
   (reader grant, Access gate), `kogane.accounts.candidates` on
   `POST /api/agent/v1/accounts.candidates` and `/mcp` (listed only to a
   whole-store `records.read` grant), and the page
   `/identities/account-candidates` (`口座の対応候補`) call it. The page reads
   the candidate again before planning and plans nothing if its status, hold
   or commands changed; approval and commit happen on `/confirm/:planId`.
   Under today's grant lists an agent named in `AGENT_GRANTS` (empty in the
   committed configuration) can plan and cannot approve or commit, and an
   MCP client reaches no command route (ADR 0047).
8. **Bounds.** 64 current reviews (the browser connection reader's bound),
   1,000 aggregator source accounts, 10,000 newest relation rows and 10,000
   backfilled relations under a rewritten key; each read
   fetches one row past its bound and a larger store is refused whole
   (`budget_exceeded`, `budget:accountCandidates.<bound>`), never cut.

**Cost.** Five keyed reads, no observation table, no rewrite of shipped SQL:
the current review view, as the browser connection reader selects it (one
pass over the small append-only review table; every newer-revision and
evidence check is a keyed correlated subquery); `source_accounts` by its
`UNIQUE(source_id,...)` index; `entity_relations` as one keyed range per kind
of a `(kind, ref)` index; the 0029 mapping as one pass over the review
table, its pinned references and each backfilled relation by primary key
(`CROSS JOIN` fixes that order; without it, and without statistics, SQLite
would walk every `connection_contains` row first); and the page's named
source accounts by primary key
and `UNIQUE(source_account_id, revision)`. The plan checks run on the whole
CORE schema without table statistics. Remote D1 is not measured; the inputs
are bounded by the review table (64 x 100 pairs).

**Libraries.** None added. The pairing, the codes and the states are this
application's rules; the read uses the existing `SqlExecutor`, the route and
tool reuse the instrument candidate transports, and decisions reuse the
change lifecycle unchanged.

## Consequences

- Nothing is adopted by the read. Accepting a candidate appends one
  `connection_contains` relation and its decision. The balance projection
  already reads such a relation as a subset of a `connection:` scope that no
  measurement has, so an acceptance moves no adopted balance today; it does
  change the projection's declared input count, so the next READ build is a
  new snapshot id. No transaction, balance or display is merged, suppressed
  or summed, and `same_account` is never derived (SC06).
- Where the one-time identity-value rewrite (migration 0063) replaced a
  review's importer-era key, the relation migration 0029 backfilled still
  names the old key (relations are append-only). The read maps it back to the
  pair through the review row its id names (decision 3), so such a pair reads
  as `accepted`, with the old reference listed, and is not offered for a
  second acceptance. A later decision is planned under the current key and,
  being newer, decides the pair. This ADR states the mechanism; it does not
  assert a production count.
- Rejecting an accepted pair appends a later `rejected` row, and the
  candidate reads `rejected`. The balance projection reads every `accepted`
  relation row, not the newest of a pair, so the earlier acceptance stays
  among its declared inputs; it moves no balance today (a `connection:` scope
  has no measurement), and changing that projection is not decided here.
- Reviews are producer-scoped: a collector-era MoneyForward source account is
  listed with a reviewed connection only when its identity value equals the
  review's key; a value no review names is `unreviewed`.
- Only SBI Shinsei can have confirmed reviews (CORE 0023 CHECK), so only
  Shinsei pairs can be proposed. SMBC, Vpass and PRESTIA connections stay
  `unresolved` until a verifier records a witness for them.
- No server-side candidate provenance is checked: a `relation.accept` of
  `connection_contains` was plannable before this read and still is. The
  plan pinned only the revision of the candidate's own reference, so a
  decision recorded in between under one of the pair's other references
  (another producer's, or a pre-rewrite key) did not make it stale. Closed by
  the [amendment of 2026-11-08](#amendment-2026-11-08-a-pair-plan-pins-every-reference-of-the-pair):
  the plan now pins every reference of the pair.

## Explicitly not decided

- Leaf-account equivalence between an aggregator row and a direct account
  (`same_account`): no recorded field supports it. A parser that records a
  leaf witness, and the policy that would compare it, are later changes.
- Which presentation wins, or how an aggregator transaction is deduplicated
  against a direct one; validity periods of a containment (moved, migrated or
  closed accounts); a history view of a pair's relation revisions.
- Verifiers for connections other than SBI Shinsei.

## Verification

Synthetic data only, no production access.

- `packages/domain/test/account-candidates.test.ts`: one pinned account is a
  proposed pair with both commands and no same-account candidate; one
  aggregator account matching two direct accounts chooses neither
  (`several-direct-accounts`); a direct account pinned by two connections (a
  colliding displayed number) is held on both; two producers' reviews of one
  identity value are not a collision; an ineligible review holds its pairs and
  claims nothing; an unresolved review labelled like a direct account and an
  unreviewed aggregator account propose nothing; accepted, rejected, released
  and other-producer relations; a stored `same_account` in either orientation
  is reported and never proposed; a decision under another producer's
  reference of the same identity value, or under a 0029 reference whose key
  0063 rewrote, decides the pair and the newest across references wins;
  every bound refuses; input order does not matter.
- `packages/application/test/account-candidates.test.ts`, over CORE with
  reviews inserted through the review triggers: the views, the summary and the
  named source accounts; the read writes nothing; an excluded direct run makes
  a review ineligible and releases the other connection's claim; an agent's
  plan is refused at approval; a person's `relation.accept` and later
  `relation.reject` (withdraw) are two rows and move the pair to `accepted`
  then `rejected`, and no `same_account` row appears; a 0029-shaped
  acceptance under a rewritten key reads `accepted` (a relation whose `to_ref`
  is not the pinned reference at its id's index maps to nothing), and a
  withdrawal under the current key is newer; grant, request, paging
  and bound refusals; query plans on the whole CORE schema without statistics.
- `services/app/test/account-candidates-api.test.ts` on workerd: the route's
  views and refusals, Access gate and GET-only, the agent tool over HTTP and
  MCP returning the route's answer, its grading and listing, its audit record.
- `apps/web/test/account-candidates-contract.test.ts` and
  `apps/web/test/account-candidates.browser.test.ts`: the wire contract
  refuses unknown codes, a proposed `same_account`, a held acceptance or a
  foreign payload; the page plans exactly the named payload with the reason,
  offers only keeping apart on a held candidate, and plans nothing when the
  candidate changed.

## Amendment 2026-11-08: a pair plan pins every reference of the pair

- Status: proposed until the PR that carries it merges, then accepted
- Date: 2026-11-08
- Carried by: `packages/application/src/operations/pair-references.ts`
  (`CONNECTION_PAIR_REFS_SQL`, `withPairPins`, `pairStaleRefs`,
  `connectionPairGuard`), its calls in
  `packages/application/src/operations/targets.ts` (the relation and identity
  planners), `packages/application/src/command/approve.ts`,
  `packages/application/src/command/commit.ts` and
  `packages/application/src/operations/relation-writes.ts`;
  [change lifecycle](../change-lifecycle.md#pair-pins),
  [identity](../identity.md)
- Related: [ADR 0055](0055-instrument-candidates.md) (the instrument pair,
  amended the same day)

### Context

The last consequence above recorded an open gap: a plan of `relation.accept`
or `relation.reject` pinned only the revision (row count) of its own
`connection_contains` triple. Decision 3 reads the pair's status from the
newest relation under any of its references (`this-connection`,
`same-identity-value`, `legacy-connection-key`), so a decision recorded under
another producer's reference, or under a 0029 reference whose key 0063
rewrote, between plan and commit changed the pair's status and left the plan
fresh: the commit then appended a decision on a pair the operator had seen in
another state. The instrument pair of ADR 0055 had the same shape: an adoption
pinned both mappings but neither `listed_as` orientation, and the keep-apart
rejection pinned its own triple only, so a rejection in the other orientation
or an adoption between plan and commit did not make the other plan stale.

### Options considered

1. **A new subject kind in the lifecycle's revision guard** (say, a pair
   revision summing every reference's rows). Rejected: it changes the shared
   guard text in `packages/storage-d1` that the App and the Processor both
   run, and the existing subject kinds already answer each reference.
2. **Re-check the candidate read at approval and commit** (as instrument
   candidate provenance does). Rejected for this: the candidate read is a
   whole-store read, and it would still be a preceding `SELECT`, not a
   condition of the commit batch.
3. **Pin every reference of the pair with the existing subject kinds.**
   Chosen. No migration, no new subject kind, no change to the guard.

### Decision

- The planner pins, besides the command's own subject, the
  `relation:connection_contains|<ref>|source_account:<id>` triple under every
  reference of the pair: each producer's review reference of the identity
  value the plan's `from_ref` names, and each 0029 reference mapped to that
  identity value and direct account exactly as decision 3 maps it. A plan
  under a 0029 reference finds the pair through the same mapping. A triple no
  connection review names, and no 0029 backfill maps, names no pair and pins
  only itself.
- An instrument pair (ADR 0055's amendment of the same day) pins both
  identifiers' mappings and `listed_as` in both orientations.
- A `same_account` decision names no pair and pins only its own triple, and
  that is all it needs. Its references are `source_account:` ids, which no
  migration rewrites (0063 rewrote `reference_json`, never an id); its other
  triples are the reverse orientation and, for an aggregator account several
  producers list, the same decision under another producer's source account
  id. No reader combines any of them: the balance projection reads each as a
  triple of its own (`projectionRelationsSql`; the
  [ADR 0001 amendment of 2026-11-06](0001-domain-axes.md#amendment-2026-11-06-a-relation-triples-status-is-its-newest-decision)
  rule is per exact triple), and decision 5 reports each stored triple with
  its own status and derives no status of the pair. The plan shows the one
  triple. A decision under any other triple between plan and commit
  therefore changes neither what the plan showed nor what the commit writes. Pinning the reverse orientation was considered and rejected: it
  would refuse a plan for a change it neither showed nor depends on, while
  the reverse orientation stored before planning, which the plan does not
  show either, would still be accepted. What stays open is a meaning, not a
  stale plan: a rejection withdraws only its own orientation, so an
  acceptance stored in the other orientation stays in force in the
  projection.
- Approval and commit also re-read the pair's references. A reference the plan
  does not pin (another producer's first review of the identity value after
  planning, or a plan made before this amendment) makes the plan stale and
  marks it so; for an account pair the commit batch carries the same check as
  a condition of its receipt reservation (`connectionPairGuard`), so a review
  recorded between the commit's reads and its batch writes nothing.
- The refusal is the lifecycle's existing `stale_context`, with the moved or
  unpinned references among its refs. MCP clients reach it through
  `kogane.command.approve` and `kogane.command.commit`, which re-simulate
  before forwarding; `simulate` reports the plan stale because the pins it
  would record differ. Like every refusal that re-simulation finds, it is
  answered before forwarding, so the plan row is not marked stale.

### Consequences

- The consequence above ("does not") is closed: a decision recorded under any
  reference of the pair between plan and commit makes the plan stale.
- A plan of a pair with several references changes digest (its pins are part
  of it), so a plan made before this change is stale at simulation and is
  refused at approval and commit; it is planned again.
- The pins are not `simulation.targets[]` entries: the confirmation screen's
  table still lists the command's own triple, and the moved reference is named
  only in the refusal.
- The cost is one statement per plan, approval and commit of a
  `connection_contains` triple: one pass over the small review table per use
  and each backfilled relation by primary key, plus its pinned revisions
  through the existing guard. No observation table is read.

### Verification

Synthetic data only.

- `packages/application/test/pair-pins.test.ts`: the plan pins the own,
  another producer's and the 0029 reference; a decision under another
  producer's reference or the 0029 reference between plan and commit refuses
  the commit with `stale_context`, writes nothing and marks the plan stale,
  and `simulate` reports it stale; approval is refused the same way, also
  when the pair only gains a reference (no approval is written and the plan is
  marked stale); a reference that appears after planning refuses the commit
  both before the batch and inside it (a review inserted just before the batch
  writes no receipt and spends no approval use); with nothing in between the
  plan commits; the instrument adoption and keep-apart plans pin the same four
  references, a reverse-orientation rejection makes the adoption stale and an
  adoption makes the keep-apart stale; the pair read reaches the relations by
  primary key only on the whole CORE schema without statistics; a
  `same_account` plan pins its own triple only, commits after an acceptance
  recorded in the reverse orientation, and the candidate read reports the two
  orientations apart (`services/processor/test/balance-projection.test.ts`
  "a later decision on a relation triple supersedes an earlier one in the
  projection input" shows the projection reading the two orientations apart).
- `services/app/test/pair-pins-mcp.test.ts` on workerd: over real MCP, a plan
  approved and prepared for commit, then a rejection committed under the other
  producer's reference, is refused with `stale_context` at confirm and at a
  new prepare, and a plan made before that decision is refused at approval;
  nothing is written under the plan's own reference.
