# ADR 0017: Add card purchase review command kinds with one rebuild, not relation markers

- Status: proposed
- Date: 2026-09-26
- Decision owner: the owner accepted decision 1.1 of the
  [next-milestone plan](../plans/2026-09-next-milestone.md#11-add-real-command-kinds-with-one-rebuild-not-more-relation-markers)
  on 2026-09-26; this record carries it into the repository.
- Implemented by: the PR that adds this record (plan P1-1)
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
