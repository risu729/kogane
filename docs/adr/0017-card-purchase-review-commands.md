# ADR 0017: Add card purchase review command kinds with one rebuild, not relation markers

- Status: accepted (merged 2026-09-27 in #261); the
  [2026-11-06 amendment](#amendment-2026-11-06-a-later-proposal-never-replaces-a-relation-decision)
  is accepted (owner approved 2026-11-07 13:39 UTC)
- Date: 2026-09-26; amended 2026-11-06
- Decision owner: the owner accepted decision 1.1 of the
  [next-milestone plan](../plans/2026-09-next-milestone.md#11-add-real-command-kinds-with-one-rebuild-not-more-relation-markers)
  on 2026-09-26; this record carries it into the repository.
- Implemented by: PR #261 (plan P1-1)
- Carried by: `packages/storage-d1/migrations/core/0051_card_purchase_review_commands.sql`,
  `CHANGE_KINDS` and `validPayload` in `packages/application/src/command/contract.ts`,
  `REVIEW_PLANNERS` in `packages/application/src/operations/targets.ts`,
  `packages/domain/src/card-purchase-review.ts`,
  [change lifecycle](../change-lifecycle.md#card-purchase-review-kinds-migration-0051)

## Context

Three reviews of a recognised card purchase are planned
([plan §1.2–§1.4](../plans/2026-09-next-milestone.md#12-excluding-a-row-this-row-is-not-a-purchase)):
excluding a row that is not a purchase (an annual fee, a cash advance, a
charge of the owner's own stored value), allocating a refund to the purchase
it refunds, and linking later installment portions to the obligation of
their purchase. Each is a human decision made through the change lifecycle,
and each must be undoable by a later revision.

The lifecycle's kinds are a closed list, enforced twice: in code
(`CHANGE_KINDS`) and by CHECK constraints on `change_plans.kind` and
`operation_receipts.operation_kind`. Earlier reviews did not need new kinds.
Pending-to-posted links and card ownership each had an honest relation kind
(`pending_to_posted`, `liable_party`/`beneficial_owner`) and ride on
`relation.accept`/`relation.reject` with a marker evidence ref. Card
settlement review needed its own kinds, and 0045 added them by rebuilding the
four command tables.

No `entity_relations` kind means "this row is not a purchase", "refund of" or
"installment portion of".

## Options considered

1. **More relation markers.** Add relation kinds for the three meanings and
   ride on `relation.accept`/`relation.reject`, as the link and ownership
   reviews do. Rejected: the relation kind list is a CHECK on
   `entity_relations`, the most referenced table in CORE. Widening it is a
   larger rebuild than the command tables, and the review would still need
   a payload that the relation shape does not carry (a reason code, a list of
   portions).
2. **Reuse `supports`/`contradicts`.** Exclusion could be `relation.accept`
   of `contradicts` from `event:<id>` to `policy:card-purchase-recognition-v1`
   with a marker `card-usage-exclusion:<reason>`. Rejected as the main path:
   the stored relation would claim something other than what was decided,
   and refunds and installment links have no honest kind at all. The plan kept
   it only as a fallback for exclusion if the rebuild were refused. It was not
   refused.
3. **Rebuild the four command tables once, following 0045, and add six
   kinds.** Chosen.

## Decision

- CORE migration 0051 rebuilds `change_plans`, `approvals`,
  `operation_receipts` and `decision_outbox` statement by statement as 0045
  did. It builds `*_expanded` tables, copies every row with explicit column
  lists, drops the old tables leaf-first, renames, and recreates every index
  and trigger byte-identical, including the 0038
  `decision_outbox_completion_guard`. The only difference is the kind CHECK
  on `change_plans.kind` and `operation_receipts.operation_kind`, which gains:
  `card-purchase.exclude`, `card-purchase.restore`, `card-refund.allocate`,
  `card-refund.withdraw`, `card-installment.link` and
  `card-installment.unlink`.
- `CHANGE_KINDS` gains the same six, listed as `CARD_REVIEW_KINDS`. Their
  payloads have exact keys. `{eventId, reasonCode, reason}`,
  `{eventId, reason}`, `{refundEventId, purchaseEventId, reason}`,
  `{allocationId, reason}`, `{obligationId, portionRefs, reason}` and
  `{obligationId, portionKeys, reason}`, with the id shapes and closed reason
  codes listed in the
  [change lifecycle](../change-lifecycle.md#card-purchase-review-kinds-migration-0051).
  The portion ref shape (`transaction:<id>@parse_run:<id>`) and the portion
  key shape (a recognition key's JSON text) are this record's choice. The
  change that implements installment links may amend them here.
- The vocabulary exists before any behaviour. `REVIEW_PLANNERS` is empty, so
  planning a review kind is refused with `unsupported_semantics` before the
  plan is stored. The processor's `cardReviewMutation` slot returns null, and
  the commit's `failureReason` re-simulates these kinds, so a plan row that
  reached the table any other way commits nothing. No screen offers the
  kinds; the confirmation screen only has labels for them.
- Later changes register one planner and one writer per kind. None of them
  adds a kind or rebuilds these tables again.

## Consequences

- 0051 is the only Part 1 migration that copies history. It must not collide
  with another migration that touches the four command tables. None of
  0046–0050 does, and none of the PRs in flight on 2026-09-26 does. D1
  applies a migration atomically, so an interrupted run leaves the old graph
  in place.
- A rollback of the Workers below this change leaves the widened CHECK in
  place. It admits kinds the older code never plans, so nothing reads
  differently.
- Every review keeps the lifecycle's guarantees: plan digests, expected
  revisions checked inside the commit batch, human-only approval and commit
  (agents never approve or commit), receipts and the outbox.
- The payload contract is fixed before the planners exist. A planner that
  needs another field changes the contract in a reviewed change and amends
  this record.

## Verification

- `packages/storage-d1/test/command-vocabulary-migration.test.ts` seeds a
  store migrated through 0050 with history of every earlier kind, plan status
  and receipt state. It checks the following:
  - every row of the four tables and of `decision_revisions` is preserved;
  - `PRAGMA foreign_key_check` is empty after every statement, with
    enforcement on;
  - index and trigger SQL is byte-identical;
  - table SQL is identical apart from the widened CHECK;
  - the six kinds are accepted and unknown kinds are refused;
  - the append-only and forward-only triggers still fire;
  - an interrupted migration rolls back whole.
- The regenerated schema ledger shows only the `change_plans` and
  `operation_receipts` table digests changed.
- `packages/application/test/command.test.ts` checks the closed list, and
  that the validators refuse extra or missing keys, bad ids, unknown reason
  codes, and empty, oversized or duplicate portion lists.
- `packages/application/test/card-review-plan.test.ts` and
  `services/processor/test/change-lifecycle.test.ts` check that planning any
  review kind is refused with `unsupported_semantics` and writes no row, and
  that a directly inserted plan of these kinds commits nothing.

## Amendment 2026-11-06: a later proposal never replaces a relation decision

- Status: accepted (merged 2026-11-07 in [#991](https://github.com/risu729/kogane/pull/991))
- Date: 2026-11-06
- Carried by: `RELATION_SQL` in `packages/application/src/operations/targets.ts`,
  `LISTED_AS_SQL` in `packages/read-model/src/instrument-resolution.ts`,
  `CANDIDATE_RELATIONS_SQL` in
  `packages/application/src/query/card-purchase-candidates.ts`,
  `ACCEPTED_APART_GUARD_SQL` in `services/processor/src/card-purchase-job.ts`,
  `cardSettlementOwnershipCtes` in
  `packages/read-model/src/card-settlement-ownership.ts`,
  `CARD_OWNERSHIP_CLAIMS_SQL` in `packages/application/src/query/card-ownership.ts`,
  [card settlements](../card-settlements.md),
  [change lifecycle](../change-lifecycle.md#pending-to-posted-link-review),
  [identity](../identity.md)

### Context

`entity_relations` is append-only (migration 0029). Every judgement of a
relation appends a row with its own decision: `relation.accept` and
`relation.reject` write `accepted` and `rejected` rows, the rule paths of the
reconciliation and purchase lanes write `accepted` rows, and an agent's
`reconcile.propose` (`services/app/src/proposals.ts`) writes a `proposed` row
of any relation kind. No write retires an earlier row, so which row of a
relation is in force is each reader's rule.

Six readers that pick one row per relation took the newest row of any status.
A proposal recorded after a decision then replaced the decision, though INV07
says a proposal changes nothing until a decision accepts it
([ADR 0001](0001-domain-axes.md)):

| Reader                                                                             | Order                                    | What a later proposal did                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Change lifecycle relation target (`RELATION_SQL`)                                  | `created_at`, `id`                       | A plan showed an accepted or rejected relation as `proposed`, so a reviewer withdrawing an acceptance approved `proposed → rejected`. Display only: the plan digest (kind, payload, pins and context), the pin (the row count) and the commit were right. |
| Instrument candidates (`LISTED_AS_SQL`)                                            | `created_at`, `id`                       | Re-opened a candidate a person kept apart: `rejected` became `proposed` and the candidate named its adoption command again.                                                                                                                               |
| Pending-to-posted candidates (`CANDIDATE_RELATIONS_SQL`)                           | `created_at`, insertion order            | An accepted link read as not linked: a merged link lost its `withdraw` action (`proposal_closed`), and the lane skipped merging a pair the reconciliation lane had accepted by rule.                                                                      |
| Purchase lane merge guard (`ACCEPTED_APART_GUARD_SQL`)                             | `created_at`, insertion order            | The same pair's merge was refused inside the batch even once the read above was right.                                                                                                                                                                    |
| Card settlement ownership (`cardSettlementOwnershipCtes`, every settlement reader) | insertion order, the two account aliases | Retired an accepted owner (the account became unowned), and retired a dated claim's veto, so a conflicting timeless owner was adopted.                                                                                                                    |
| Card ownership review claims (`card-ownership.ts`)                                 | insertion order, the two account aliases | Hid the accepted owner the readers adopt behind the proposal, so the review offered no rejection of it.                                                                                                                                                   |

Only the change lifecycle target is reachable by a shipped writer today:
`reconcile.propose` takes two `source_account:` refs, and no shipped path
writes a `proposed` row whose ends are `transaction:`, `instrument:` and
`identifier:`, or an account and a party. The other five follow from the
table's contract, not from a current writer, and a later proposal writer
would have reached them.

A later proposal could only disable the pending-to-posted paths (they act on
`accepted` alone); it could both remove and add an owner.

### Options considered

1. **Leave the readers.** Rejected: the outcome of a decision would depend on
   whether anyone proposed the same relation later.
2. **Retire earlier rows on write** (set a superseding decision). Rejected:
   rows and decisions are append-only, and migration 0029's trigger only lets
   a decision supersede a decision on the same subject, while each relation row
   is its own subject.
3. **A CORE view of current relations every reader joins.** Not now: it is a
   migration, the readers order rows three ways (`created_at` and `id`,
   `created_at` and insertion order, insertion order over two aliases), and
   each would need its own equality proof against the view.
4. **The newest decision; a proposal never replaces a decision.** Chosen,
   applied in each reader's own order.

### Decision

- A relation's current row is its newest **decision** (`accepted`, `rejected`
  or `released`) in the reader's order, which does not change. Only a relation
  with no decision reads its newest proposal. Every reader above applies this.
- The card settlement ownership CTEs retire an accepted claim, and a dated
  claim's veto, only by a later decision naming the same owner through either
  alias. The card ownership review shows per owner the same current row,
  so the owner the readers adopt is the one the review offers to reject.
- The migration 0044 views `card_settlement_fact_ownership` and
  `card_settlement_readiness` keep the older rule. No reader queries them
  (every reader uses the keyed CTEs; [ADR 0011's amendment](0011-keyed-ownership-ctes.md#amendment-2026-11-06-the-ctes-depart-from-the-views-in-one-rule) records the departure),
  they agree with the CTEs wherever no proposal follows a decision of the same
  owner, and replacing them would rebuild two views for no reader.
  `card-settlements-api.ts` only checks that they exist.
- Pins do not change: the change lifecycle's relation pin, the
  pending-to-posted relation pin and the ownership pin still count every row,
  so a proposal still moves a pin and stales an open plan, which is safe.
- Readers that deliberately read every row stay as they are: row counts (the
  pins above, the ownership declaration context, where any recorded claim
  blocks a self-declaration, and the instrument history count), histories (the
  instrument history), lists of unlogged legacy rows (instrument temporal
  blockers), evidence pins (economic row readiness), and the one row a receipt
  names (delegated reversal). The balance projection's relation read applies
  the same rule in its own change
  ([ADR 0001's amendment of 2026-11-06](0001-domain-axes.md#amendment-2026-11-06-a-relation-triples-status-is-its-newest-decision)),
  ranked with `row_number()` as `LISTED_AS_SQL` is.

### Consequences

- No migration and no operator step. The plan digest covers the kind, the
  payload, the pins and the context, not the shown status, so no stored plan's
  digest changes and approve and commit refuse nothing new. Stored plans are
  not re-simulated at approve or commit for relation kinds, and planning the
  same change again over unchanged data returns the stored plan, so a plan
  made before deploy keeps showing the status it was planned with until it
  expires (at most 24 hours).
- Cost: the ownership CTEs' two newer-row checks are still keyed searches of
  `entity_relations_from` by a rowid range, but they now read past the
  proposals that follow a claim until they meet a decision, where the shipped
  checks stopped at the first later row of the owner. A read therefore costs,
  per observation it resolves, up to the number of proposals recorded after
  its owners' newest decisions; no shipped writer records such a proposal
  today. The claims read's added check, for a proposal row, is one keyed
  search of the account's rows up to the pin.
- On every store where no proposal follows a decision of the same relation,
  every reader returns what it returned before. Production has no such
  proposal on the five readers no shipped writer reaches.
- The 0044 views and the readers can disagree on a store with such a
  proposal. A test or a manual query against the views reads the older rule.

### Verification

Synthetic data only. Each reader has a test that fails on the shipped text: a
decision followed by a later proposal
(`relation-target-current.test.ts`, `listed-as-current.test.ts`,
`card-ownership-query.test.ts` in `packages/application`;
`card-purchase-merge.test.ts` and `card-settlement-ownership.test.ts` in
`services/processor` on D1). Each changed SQL text is frozen as shipped with
its digest and compared:

- on random stores (one to many rows per relation, every status, `created_at`
  ties, ids and insertion order unrelated to time; for ownership, both
  aliases, superseded decisions, dated claims and a pin below the newest row)
  the current read equals a model written without SQL, the shipped read
  equals the old rule's model, and the two differ only where a proposal
  follows a decision (`packages/read-model/test/relation-history.ts`);
- for the ownership CTEs, on the settlement random stores the current and
  shipped CTEs are equal, and on the same seeds with ownership proposals
  appended last the current CTEs read exactly the store without them while
  the shipped CTEs (equal to the view) both lost and gained owners; every
  caller's own differential test against its frozen text still passes;
- on scaled stores (5,000 relations or more) with no proposal after a decision
  the two reads return the same rows;
- without table statistics every lookup is a keyed search of
  `entity_relations_from` or `_to`, the ownership plans pass the statement plan
  checks, and the `listed_as` and claims plans are the shipped ones but for
  one more sort term and one more keyed check.
