# ADR 0077: Propose aggregator-to-direct account containment from confirmed connection reviews; never propose the same account without leaf evidence

- Status: accepted (merged 2026-11-06 in #949); the
  [first 2026-11-08 amendment](#amendment-2026-11-08-a-later-proposal-never-replaces-a-pairs-decision)
  is accepted (#1163); the
  [second](#amendment-2026-11-08-the-correction-history-of-a-source-account)
  is proposed
- Date: 2026-11-06; amended 2026-11-08
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
  candidate reads `rejected`. When this ADR merged the balance projection
  read every `accepted` relation row, so the earlier acceptance stayed among
  its declared inputs. Since
  [ADR 0001's amendment of 2026-11-06](0001-domain-axes.md#amendment-2026-11-06-a-relation-triples-status-is-its-newest-decision)
  it reads each triple's current row, so a rejection under the reference the
  acceptance was recorded under withdraws it; an acceptance recorded under
  another of the pair's references (another producer's, or a pre-rewrite key)
  is another triple and stays among its declared relations. Either way it
  moves no balance today (a `connection:` scope has no measurement).
- Reviews are producer-scoped: a collector-era MoneyForward source account is
  listed with a reviewed connection only when its identity value equals the
  review's key; a value no review names is `unreviewed`.
- Only SBI Shinsei can have confirmed reviews (CORE 0023 CHECK), so only
  Shinsei pairs can be proposed. SMBC, Vpass and PRESTIA connections stay
  `unresolved` until a verifier records a witness for them.
- No server-side candidate provenance is checked: a `relation.accept` of
  `connection_contains` was plannable before this read and still is. The
  plan pins the revision of the candidate's own reference, so a decision
  taken in between under that reference makes it stale at approval and
  commit; a decision recorded in between under one of the pair's other
  references (another producer's, or a pre-rewrite key) does not.

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

## Amendment 2026-11-08: a later proposal never replaces a pair's decision

- Status: proposed until the PR that carries it merges, then accepted
- Date: 2026-11-08
- Carried by: `ACCOUNT_RELATIONS_SQL` in
  `packages/read-model/src/account-candidates.ts`, [identity](../identity.md#aggregator-to-direct-account-candidates)

### Context

Decision 3 reads, per relation triple (kind, `from_ref`, `to_ref`), the
newest row of any status by `created_at` and then `id`. Relations are
append-only (migration 0029), and `reconcile.propose` appends a `proposed`
row of any kind between two `source_account:` references, `same_account`
included. A `same_account` proposal recorded after a person's acceptance or
rejection of the same pair therefore replaced that decision in the
candidate's `sameAccount.recorded`, which showed `proposed`, while the change
lifecycle's relation target and the balance projection kept the decision
([ADR 0001's amendment of 2026-11-06](0001-domain-axes.md#amendment-2026-11-06-a-relation-triples-status-is-its-newest-decision),
[ADR 0017's](0017-card-purchase-review-commands.md#amendment-2026-11-06-a-later-proposal-never-replaces-a-relation-decision)).
That amendment moved every other reader that picks one row per relation onto
the rule; this read, merged the same day, was not in its list. The
`connection_contains` rows it reads start at a `connection:` reference, which
no proposal writer produces today, so only `same_account` was reachable.

### Options considered

1. **Leave the read.** Rejected: the review would contradict the lifecycle
   and the projection on the same pair, and a proposal would change what a
   person sees as decided (INV07).
2. **The rule of ADR 0001's amendment, in this read's own order.** Chosen.

### Decision

- A triple's current row is its newest decision (`accepted`, `rejected` or
  `released`) by `created_at` and then `id`; only a triple with no decision
  reads its newest proposal. `ACCOUNT_RELATIONS_SQL` ranks with
  `r.status<>'proposed' DESC` before its order, as `projectionRelationsSql`
  and `LISTED_AS_SQL` do.
- The domain's choice across a pair's references (decision 3, "the newest
  across references wins") is unchanged and compares the current row of each
  reference. A reference whose only rows are proposals would still win over
  an older decision under another reference; no writer records a
  `connection_contains` proposal from a `connection:` reference today.

### Consequences

- On every store where no proposal follows a decision of the same triple the
  read returns exactly what it returned before; elsewhere only that triple's
  status (and its `createdAt` and `id`) changes, from the proposal to the
  decision. The bound still counts current triples, one row past it read.
- Cost: unchanged plan, one keyed range of a `(kind, ref)` index per kind and
  one sort of the rows found, now with one more term.
- No migration, no stored plan changes, nothing adopts.
- The consequence above that the balance projection reads every `accepted`
  row had been stale since ADR 0001's amendment of 2026-11-06; it now states
  what the projection reads.

### Verification

Synthetic data only.

- `packages/application/test/account-candidates.test.ts`: a person accepts a
  `same_account` pair through the change lifecycle, a later proposal of the
  same pair is appended, and the candidate still reports `accepted`; the
  shipped text read `proposed` (fails on it).
- `packages/application/test/account-relations-current.test.ts`, against the
  shipped text frozen with its digest
  (`account-relations-legacy-sql.ts`): on 300 random stores (every status,
  `created_at` ties, ids unrelated to time, kinds and references outside the
  read) the current read equals a model written without SQL, the shipped read
  equals the old rule's model, and the two differ only on triples where a
  proposal follows a decision; on a scaled store past the 10,000-row bound
  with no such triple both return the same 10,001 rows in the same order;
  without table statistics the plan equals the shipped plan, two keyed index
  ranges and no scan.

## Amendment 2026-11-08: the correction history of a source account

- Status: proposed
- Date: 2026-11-08
- Issue: part of #545; roadmap Phase 3 ("Expose the existing correction
  history in the review flow")
- Carried by: `packages/read-model/src/account-history.ts`
  (`ACCOUNT_HISTORY_SQL`, `ACCOUNT_HISTORY_COUNT_SQL`),
  `packages/application/src/query/account-history-read.ts`
  (`readAccountHistoryForGrant`), `services/app/src/account-history-api.ts`
  (`GET /api/identity/account-history`), the `kogane.accounts.history` case of
  `services/app/src/read-tools.ts`, the `accounts.history` entry of
  `packages/application/src/operation-path/catalogue.ts`,
  `packages/observation-shared/src/account-history-contract.ts` (the wire
  check), `apps/web/src/AccountHistory.tsx` and its use in
  `apps/web/src/pages/AccountCandidates.tsx`

### Context

"Explicitly not decided" above left out a history view of a pair's relation
revisions. The `口座の対応候補` page shows a pair's newest decision under each
reference (`recordedContainment`) and nothing older, so a withdrawn
acceptance, the acceptance it withdrew and the reasons given for both are in
`entity_relations` and `decision_revisions` but on no screen and no agent
read. Roadmap Phase 3 asks for the existing correction history in the review
flow. Instruments already have one: `kogane.instruments.history` and the
`訂正履歴を見る` panel of the instrument candidates (ADR 0055). Accounts had
none, for the pair or for the account mapping itself (`identity.assign` and
`identity.release-override` with subject `account` write revisions and
decisions no page lists). ADR 0081 requires the page's read to be an MCP read
over the same function.

### Options considered

1. **A history per pair** (connection reference, direct source account).
   Rejected: a pair is decided under up to three references (this
   connection's, another producer's, a 0029 key 0063 rewrote), so the read
   would repeat the candidate read's reference mapping to find its rows, and
   it would still leave the account mapping's own corrections and the
   `same_account` decisions out.
2. **Every decision on the page's list, inline.** Rejected: it grows each
   page by every candidate's whole history, which the 50-item page bound does
   not cover.
3. **A history per source account, read on request (chosen).** Every row that
   names the account: its mapping revisions, its `account_mapping` decisions
   and every relation row of any kind with `source_account:<id>` on either
   side, each with the decision that wrote it. This is the instrument
   history's shape (mapping, decision, relation) for the account subject, and
   it covers every reference a pair was decided under, since all of them
   share the direct account's `to_ref`.

### Decision

- `readAccountHistoryForGrant` answers `kogane-account-history-v1` for one
  `sourceAccountId` (the candidate read's id pattern): `entries` oldest first
  (`createdAt`, then entry kind, revision and record id), `total` equal to
  their count. A mapping entry carries its target account, method, status,
  label and policy version; a decision entry its kind and `supersededBy`; a
  relation entry its kind, stored status, `fromRef`, `toRef` and the writing
  decision's kind. Every entry carries the closed `decisionOrigin` of
  `decision-origin.ts`, so no actor id leaves the read.
- Authority is the instrument history's: `records.read` over the whole store,
  checked before any read; an unknown source account is
  `evidence_restricted`; the rows are counted through the same keys first and
  a history past the grant's `maxRows` is `budget_exceeded`, never truncated.
- One function behind three adapters: the page's
  `GET /api/identity/account-history` (reader grant behind Access),
  `POST /api/agent/v1/accounts.history` and the MCP tool
  `kogane.accounts.history` (catalogue operation `accounts.history`, R0, a
  `read` audit record with the entry count). The parity guard maps the route
  to the tool.
- The page opens it per candidate, for the candidate's direct source account,
  behind `取得元の口座の訂正履歴を見る`, and fetches nothing until asked. It
  shows the entries as the server ordered them and derives no status; the
  candidate's status still comes from the candidate read.
- Nothing is written, collapsed or reinterpreted: a withdrawal is a later
  entry beside the acceptance it withdraws.

### Consequences

- An acceptance recorded under another reference of the pair (a 0029 row
  under a rewritten key) is another relation triple, so a withdrawal under
  the current key leaves it among the balance projection's declared inputs
  (see Consequences above); the history shows both rows.
- The history is in knowledge order, not effective-date order; there is still
  no validity period of a containment.
- The cost grows with one account's own history: the mapping and decision
  indexes, one probe per relation kind on `entity_relations_from` and
  `entity_relations_to` (the kind leads both), each decision by primary key.
  No migration.
- A new catalogue operation and MCP tool: merging needs the owner's approval
  of the catalogue entry.

### Verification

Synthetic data only, no production access.

- `packages/application/test/account-history-read.test.ts`: over the account
  candidate world, decisions through the change lifecycle (an acceptance, its
  withdrawal, a `same_account` rejection, a manual reassignment, and another
  account's reassignment that must not appear) read back oldest first with
  closed origins; the aggregator side sees the `same_account` row; the count
  equals the read; the read writes nothing; the wire check refuses a relation
  not naming the account, an open kind, a raw actor and a wrong total;
  capability, either narrowed scope and malformed ids refuse before any read;
  an unknown account is restricted; a history past the budget is refused
  before its rows are read; both statements are keyed on the whole CORE
  schema without statistics, with no table scan anywhere in either plan, the
  decision-origin subqueries included.
- `services/app/test/account-history-api.test.ts` on workerd: the route's
  answer, Access, GET/HEAD only, strict query, unknown account; the agent
  route and MCP return the route's answer; strict input; one audit read per
  served agent call with its entry count; no table changes.
- `services/app/test/ui-mcp-parity.test.ts`: the route is mapped to
  `kogane.accounts.history`.
- `apps/web/test/account-candidates.browser.test.ts`: the panel reads only
  when opened, for the candidate's direct source account, lists an acceptance
  and its withdrawal in order, plans nothing and passes the accessibility
  audit; a refused history (`budget_exceeded`) shows the refusal alone, with
  no list, no "no history" line and no footnote.
