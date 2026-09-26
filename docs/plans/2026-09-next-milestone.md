# Plan: finish the card milestone, then dated reported state and valuation

- Status: **proposed**, awaiting the owner's go-ahead. Nothing here is
  decided until it is accepted; accepted parts become ADRs under
  [`docs/adr/`](../adr/).
- Written: 2026-09-24, from `origin/main` 9d51f23, by the next-milestone plan
  agent, and stored here unchanged except for the dated notes marked
  "Update 2026-09-26", which record facts that later merges superseded.
- Linked from: [roadmap](../roadmap.md#delivery-order-and-the-next-milestone).

> **Update 2026-09-26.** Since this plan was written, #242–#252, #254
> (Mizuho identity policy 2, [ADR 0012](../adr/0012-mizuho-identity-policy-v2.md))
> and #255 (MyJCB statement identity, [ADR 0007](../adr/0007-myjcb-statement-identity.md))
> merged.
> CORE migrations 0048 (`reconciliation_scan_cursor`, #243), 0049
> (`processor_lane_ticks`, #249) and 0050 (`statement_fact_indexes`, #251)
> are now taken on main, so the plan's numbering from 0051 stands. The
> "in-flight payment-type-shape PR" is #246, merged
> ([ADR 0004](../adr/0004-payment-type-shapes-from-evidence.md)); the
> "purchases agent intent" landed as the separate tool
> `kogane.purchases.explain` (#245,
> [ADR 0013](../adr/0013-agent-card-purchase-read.md)). Open at the time of
> this note: #253, #256, #257 (this record) and #258.

## 0. Facts (origin/main 9d51f23, 2026-09-24)

**Migrations**

- The highest CORE migration is **0047** (`packages/storage-d1/migrations/core/0047_card_purchase_recognition.sql`). The highest READ migration is 0002.
  - _Update 2026-09-26:_ the highest CORE migration on main is now 0050 (0048 #243, 0049 #249, 0050 #251).
- The in-flight PRs take 0048–0050, so every number below starts at **0051** and is provisional. Each PR takes the next free number when it rebases.
- For each new migration, the PR must also:
  - update the pin in `services/processor/test/lanes.test.ts:47-81`;
  - classify every new table in `scripts/core-schema-ledger.ts` `CLASSIFICATION` (all tables `STRICT`);
  - run `mise run ledger:schema`;
  - add operational-only tables to `REVISION_EXCLUDED_TABLES` (`packages/read-model/src/source-revision.ts:85-106`).
- `packages/storage-d1/test/migrations.test.ts` needs no entry.

**Commands.** Same as the last plan:

- per workspace: `mise run //packages/<ws>:ci`, `//services/processor:ci`, `//services/app:ci`, `//apps/web:ci` (Playwright Chromium);
- repository guards: `mise run ci:root`;
- full gate: `mise exec -- hk check --all --no-fail-fast`;
- formatting: `mise run fix`.

**Corrections to the brief**

- **Mizuho is merged.** #216 (direct collection) and #221 (commit 7162308, login and daily collection) are both on main. It still cannot supply canonical debits: its history ids are fingerprints (`mizuho:<fingerprint>:<occurrence>`, `identityOrigin: provider-fields-and-occurrence`).
- **Sony Bank ids are fingerprints too** (`sony-bank-history:<date+signed amount+after-balance+currency>:<n>`).
- **SBI Shinsei is the only other bank with provider row ids.** It has `txnReferenceNo`, an explicit `debit`/`credit` side (`_kogane.amountSignSource`), source id `sbi-shinsei-bank` and parser `sbi-shinsei-top-balances-and-activity`. Its `status` is NULL.
- **SBI Shinsei already collects exchange rates every day, and nothing parses them.**
  - Where: `services/collector-sbi-shinsei/src/browser-page.ts:290-293`.
  - Schema `sbi-shinsei-exchange-rate-v1`: `{transactionTime?, exchangeRates[{currency, customerCategory?, buyRate, sellRate, midRate}]}` (validator `response-schemas.ts:218-249`).
  - This is the first FX source, and it needs no new collector.
- **SBI Securities positions already carry provider unit prices.**
  - Domestic: `current_price` valuation observations (`sbi-domestic-cash-positions.ts`).
  - Foreign: `stockPrice.last` in the position `extra`. The fixture reconciles exactly: VT 12 × 130.70 = 1,568.40 = `frnEvaluationAmount`, and AAPL 5 × 224.35 = 1,121.75.
- **SBI VC Trade holds nothing to value right now.** The live position summary body was empty when surveyed (`docs/sources/sbi-vc-trade.md:399`). Executions carry execution prices, which are for cost basis, not valuation.
- **Nothing writes `price_observations`.** `report-job.ts:320-335` reads it only by provider-scoped ref, quoted directly in the base unit, with no as-of date, no freshness and no FX step. With `REPORTS_ENABLED="true"`, every production report cell is `missing-price` today.
- **No open PRs besides #42 (research).** Issue #87 is a Vpass collector issue and is unrelated.
  - _Update 2026-09-26:_ superseded; #254 (Mizuho identity) and #255 (MyJCB statement identity) have merged, and #253 (St. George daily), #256 (settlement readiness cost), #257 (these ADRs and this plan) and #258 (reconciliation lane stage B retirement) are open.

**Reuse these; do not duplicate them**

- **0032 tables.** `obligation_revisions` with `schedule_json`: each entry has `sequence`, `due` (a TemporalValue, including `period` month), `principal` (may be `missing`), `fee`, and `confirmed|projected`. Also `allocations` role `refund`, plus `refundAllocation`, `settlementCheck` and `legTotal` (`packages/domain/src/events.ts`).
- **0047 and the guarded builders** in `packages/storage-d1/src/atomic/card-purchase-recognition.ts` (`cardPurchaseRecognitionWrites`, merge/split writes and guards), and the drafts in `packages/domain/src/card-purchase.ts`.
- **Review plumbing**:
  - `REVISION_OF` (`packages/storage-d1/src/core/operations.ts:32-57`);
  - `resolveAndSimulate` (`packages/application/src/operations/targets.ts:103-121`);
  - commit re-simulation (`packages/application/src/command/commit.ts:285-296`);
  - `MutationPlanners` (`services/processor/src/change-commands.ts`);
  - Confirm panels keyed by invalidation (`apps/web/src/pages/Confirm.tsx`).
- **`currentCardUsageSql`** (`packages/read-model/src/card-usage.ts`) already returns `payment_type`, `usage_amount_text`, `payment_amount_text` and `installment_count_text` (MyJCB `expanded.今回回数`).
- **The purchase lane's candidate pass** builds MatchFacts from the sidecar `facts.amount` (`card-purchase-job.ts` `matchFactOf`), not from the displayed row amount.
- **Settlement views (0044)**: `card_statement_facts`, `card_bank_debit_facts`, `card_settlement_fact_ownership`, `card_settlement_readiness`, and the sweep `services/processor/src/card-settlement-job.ts`.
- **Valuation pieces**:
  - `valueHolding`, `summarizeValuation`, `netWorth`, `applyRoundingPolicy` (`calculation.ts`);
  - `valueAtPrice` and `PriceObservation` (`metrics.ts:699-790`);
  - `multiplyByRatio` (`values.ts`);
  - `snapshotCtes` (`packages/parsers/src/snapshot-query.ts`);
  - `POSITIONS_SQL` and `POSITION_VALUATIONS_SQL` (`read-model/src/sql.ts:491-536`);
  - `buildBalanceProjection` (`read-model/src/balance-projection.ts:429`) and `selectAdoptedSet` (`domain/src/scope.ts:282`);
  - the report job's manifest and context machinery.

**Gaps found in passing** (each is fixed by the PR named)

1. **P1-5:** `card_bank_debit_facts` hard-codes `smbc-bank`, and the sweep parses the bank date with an SMBC-only regex (`bankDate`, `YYYY-MM-DDT00:00:00+09:00`).
2. **P1-3:** `allocations_live_pair` is unique per (source, target, role), so one refund could be allocated to two purchases.
3. **P1-3:** `current_allocations` (0044:204) excludes only card-settlement withdrawals, and an allocation can be superseded only by another allocation.
4. **P1-4:** `/api/v2/obligations` computes `outstanding = principal − settlement_relations` (`read-model/src/events.ts:515-590`). An installment obligation settled through statements would read as fully outstanding.
5. **P1-4:** `UNRECOGNIZED_CARD_USAGE_COUNT_SQL` (`read-model/src/card-purchase-keys.ts:102`) counts every row no event holds as one number.
6. **P1-4:** the 0047 trigger `card_purchase_recognitions_facts` requires exactly 6 keys and `paymentType='single-payment'`. No other plan shape can be stored.
7. **P2-2/P2-3/P2-4:** covered by the `price_observations` correction above.
8. **Note only:** `price_observations` is outside the source-revision ledger. That is fine while valuation reads CORE per request; a READ projection over prices would need bump triggers.

---

# Part 1 — finish "card usage → statement → bank debit without counting an expense twice"

## 1. Binding decisions

### 1.1 Add real command kinds with one rebuild, not more relation markers

- **Why markers worked before:** pending-to-posted and ownership each had an honest relation kind (`pending_to_posted`, `liable_party`/`beneficial_owner`).
- **Why they don't work now:** no `entity_relations` kind means "this row is not a purchase", "refund of" or "installment portion of". Widening that list means rebuilding the most-referenced table. Reusing `supports`/`contradicts` would store relations that claim something other than what was decided.
- **Decision:** P1-1 rebuilds `change_plans`, `approvals`, `operation_receipts` and `decision_outbox` once, following 0045 statement by statement. It adds six kinds: `card-purchase.exclude`, `card-purchase.restore`, `card-refund.allocate`, `card-refund.withdraw`, `card-installment.link` and `card-installment.unlink`. Later PRs only register planners.
- **Fallback if a rebuild is refused:** exclusion alone can ride on `relation.accept`, kind `contradicts`, from `event:<id>` to `policy:card-purchase-recognition-v1`, with marker `card-usage-exclusion:<reason>`. Refunds and installment links have no honest kind either way.

### 1.2 Excluding a row: "this row is not a purchase"

- **Scope:** only a live `authorized` or `captured` purchase or refund can be excluded. The review is started from the event.
- **What a commit writes:**
  - event revision n+1, action `retire`, state `unknown` with reason `kind_undecided` ("a reviewer said this is not a purchase; what it is stays undecided"), no leg, keeping all keys and the same sidecar facts. A retired event keeps its keys, so no other event can take the row.
  - two manual decisions keyed by the operation: `event:<id>` (`supersede`) and `card-usage-exclusion:<id>` (`accept`, then `supersede` for later revisions);
  - an exclusion row (reason code plus the excluded amount).
- **Reason codes (closed list):** `card_fee` (年会費・手数料), `cash_advance`, `own_account_transfer` (charging your own stored value, which is an internal movement, not spending), `provider_adjustment`, `other`.
- **Restore:** writes revision n+2, action `revise`, with the pre-exclusion revision's exact content (legs, keys, sidecar, effective time). `unknown → captured/authorized` is allowed by `eventTransition`. After that the lane revises, re-anchors or retires the event as for any other.
- **The lane never re-recognises an excluded key.** It reads the excluded keys once per tick and skips them as `excluded_by_decision`. Such events are never paired as candidates or auto-merged.
- **Known limit:** if the provider re-keys a row, it appears as a new purchase and must be excluded again. A recurring annual fee means one review per year.
- **Figures:** new `excluded` figures per unit, plus a count, kept apart from `unresolved`.

### 1.3 Refund → purchase allocation

- **Candidates are computed at read time and never stored.** Criteria: same resolved account and source, refund `captured`, purchase `captured`, purchase usage date ≤ refund usage date, refund ≤ the purchase's remaining amount. At most 10 are shown, ordered by: counterparty equal (read from the rows, never stored), amount equal, date proximity. All are labelled as heuristic.
- **What an accept writes:**
  - one `allocations` row: id `ra_<sha256>`, source `event:<refund id>`, target `event:<purchase id>`, role `refund`, amount = the refund's full leg magnitude;
  - its decision `allocation:<id>`;
  - a sidecar row.
- **Withdraw:** writes a supersede decision on `allocation:<id>` plus a row in a new generic `allocation_withdrawals` table, which `current_allocations` excludes.
- **Invariants:**
  - at most one live refund allocation per refund (enforced by trigger);
  - total allocated to a purchase ≤ the purchase amount (checked in the domain at plan and commit; pins guarantee nothing moved in between);
  - an over-refund is refused, never absorbed.
- **Effect on figures:**
  - per purchase: `refunds[]` and a net amount via `refundAllocation`;
  - summary: `capturedRefunds` split into allocated and unallocated;
  - no combined purchases-minus-refunds total across periods (a refund in one period may belong to a purchase in another).
- **Event events are not changed** by an allocation.
- **If a side is later retired or revised,** the allocation stays but is flagged (`refund_not_current`, `purchase_not_current`, `amount_changed`) and left out of the net figure.
- **Pending-to-posted merge** is blocked (`refund_allocated`) while either event is part of a live refund allocation.

### 1.4 Installment and deferred payments

**Payment plan classification** (`CardPaymentPlan`):

- `single` and `bonus-lump-sum`: recognised as today, at the full amount, billed once.
- `installment{count|null, sequence|null}`, which includes 2回払い.
- `revolving`: new exclusion code `revolving_unsupported`.
- `unknown`: `payment_type_unsupported`, as today.

**Recognised once.** An installment purchase is recognised only from:

- its pending row (usage amount, `authorized`); or
- the posted row the provider marks as sequence 1 (`captured`).

The amount is the provider-stated usage amount (MyJCB `ご利用金額`, read with `myjcbDisplayInteger`). Rows with sequence ≥ 2 get the non-purchase disposition `installment_portion`. They are never recognised, and they are counted apart from "unrecognised". If the sequence or usage amount can't be read, the row is excluded as `installment_shape_unverified`.

**Obligation.** A lane pass keeps one obligation per live captured installment purchase:

- id `obl_cp_<sha256(policy, eventId)>`; creditor `issuer:<source>`; debtor `account:<card account>`; principal = the purchase leg;
- schedule entry 1 `confirmed`: due = the statement period month, principal = the displayed portion (or `missing`), fee only if the provider states one;
- entries 2..count `projected`, with principal `missing` (`not_stated_by_provider`) and due `unknown`;
- state `open`, or `unknown` (`provider_status_absent`) once the purchase is retired;
- recorded under decisions `rule:card-installment-v1`.

**Obligation figures:**

- `outstanding` is never computed as principal − 0. It is `null` with reason `settled_through_statements`.
- `billedToDate` = sum of the confirmed entries.
- `remainingUnbilled` is exact only when no later statement of that card has been collected after the last confirmed entry's period. Otherwise it is null with `later_portions_unlinked`.
- P1-7 fills in later entries by reviewed links.

**No double count:** one purchase per plan; later portions are never purchases; one live obligation per purchase (trigger); the obligation principal is never added to purchase or cash figures; settlement still adds no purchase leg.

**Schema:** 0047's `card_purchase_recognitions_facts` trigger is replaced by one that accepts either the v1 shape (6 keys, unchanged) or a v2 shape (7 keys, adding `plan`).

### 1.5 Bank adapters

- `card_bank_debit_facts` becomes a union of per-bank adapters. The SMBC branch keeps exactly its current predicate.
- SBI Shinsei branch: JPY only, non-empty `txnReferenceNo`, `amountSignSource='debit'`, negative amount, `status IS NULL`, date `YYYY-MM-DD`.
- New output columns: `debit_date` and `adapter`.
- Candidates still come only from equal amount within ±3 days, and still need explicit ownership plus a human decision.
- Mizuho and Sony (fingerprint ids) are a later, separate adapter class.

### 1.6 Per-statement explanation

- One statement shows every current row with its disposition: purchase, refund (with allocation), installment first portion, installment later portion, excluded by decision, unrecognised (with its code), or pending and not yet billed.
- Each disposition group has an exact sum of the provider's own displayed amounts.
- The row sum is compared with the provider total as an explained discrepancy with reason codes. It is never used as a payment total, never allocated, never written.
- Recognised purchases are never subtracted from the statement total.
- The page shows the purchase view and the cash view (the settlement's bank debit, once) side by side, plus the full decision history.

## 2. Part 1 pull requests

Dependencies:

- P1-1 has none.
- P1-2 and P1-3 need P1-1 and can run in parallel.
- P1-4 needs the in-flight payment-type-shape PR and is independent of P1-1.
  - _Update 2026-09-26:_ that PR is #246, merged 2026-09-25.
- P1-5 is independent.
- P1-6 needs P1-2, P1-3 and P1-4.
- P1-7 (optional) needs P1-1 and P1-4.

### P1-1 — `feat: add the card purchase review command vocabulary` (~1.3k lines)

**Scope.** Schema and contract only. No planner behaviour and no UI actions.

**Files**

- **`migrations/core/0051_card_purchase_review_commands.sql`.** A copy of 0045:
  - build `*_expanded` tables with the kind CHECK plus the six new kinds (in both `change_plans.kind` and `operation_receipts.operation_kind`);
  - copy rows with explicit column lists, drop old tables leaf-first, rename;
  - recreate every index and trigger byte-identical to 0045, including the 0038 `decision_outbox_completion_guard`.
- **`packages/domain/src/card-purchase-review.ts` (new).** Exclusion reason codes; subject prefixes `card-usage-exclusion:`, `card-refund:`, `card-refund-target:`, `card-installment:`; invalidations `review:card-purchase-exclusion`, `review:card-refund-allocation`, `review:card-installment-link`.
- **`packages/application/src/command/contract.ts`.** Add to `CHANGE_KINDS` and add exact-key payload validators:
  - `{eventId, reasonCode, reason}`;
  - `{eventId, reason}`;
  - `{refundEventId, purchaseEventId, reason}`;
  - `{allocationId, reason}`;
  - `{obligationId, portionRefs[], reason}` (≤ 36 refs);
  - `{obligationId, portionKeys[], reason}`.
- **`operations/targets.ts`.** A registry `REVIEW_PLANNERS: Partial<Record<ChangeKind, Planner>>`. An unregistered kind returns `unsupported_semantics` and no plan row is written.
- **`command/commit.ts`.** `failureReason` re-simulates these kinds.
- **`services/processor/src/change-commands.ts`.** A `cardReviewMutation` slot that returns null for now.
- **`apps/web/src/pages/Confirm.tsx`** and **`apps/web/src/command-api.ts`.** Kind labels.
- Regenerate `infra/schema/core-ledger.*`; update `lanes.test.ts`.

**Tests**

- `packages/storage-d1/test/command-vocabulary-migration.test.ts`, seeded from 0017–0050:
  - every row of the four tables is preserved;
  - `PRAGMA foreign_key_check` is empty;
  - index and trigger SQL (normalised) is identical apart from the CHECK;
  - the new kinds are accepted and an unknown kind is refused;
  - append-only and forward-only triggers still fire.
- `packages/application/test/command.test.ts`: the closed list; validators refuse extra keys, bad ids and unknown reason codes.
- Planning any new kind is refused (`unsupported_semantics`, no row written).

**Docs.** `docs/change-lifecycle.md` (kind list, 0051). A pointer in `docs/economic-events.md`.

**Risks and reviewer invariants.** This must be the only in-flight migration that touches these four tables (coordinate with the owners of 0048–0050). D1 applies a migration atomically. History is copied verbatim.

### P1-2 — `feat: exclude a card usage row from purchases by reviewed decision` (~3k lines; needs P1-1)

**Scope.** Exclude and restore. Out of scope: rule-proposed exclusions, and recognising fees as `fee` events.

**Data model (0052)**

- **`card_purchase_exclusions`** `(event_id, revision, status excluded|restored, reason_code, event_revision, unit_ref, coefficient, scale, decision_revision_id, created_at)`. PK `(event_id, revision)`. FK `(event_id, event_revision)` → `economic_event_revisions`.
- **Guard trigger:**
  - `revision = max + 1`; revision 1 is `excluded`; statuses alternate;
  - the decision's subject is `card-usage-exclusion:<event_id>` at `NEW.revision`, method manual;
  - the named event revision is live;
  - `excluded` ⇒ state `unknown`, reason `kind_undecided`, sidecar action `retire`, amount = the previous revision's leg;
  - `restored` ⇒ state authorized or captured, sidecar action `revise`, amount = its leg.
- No update, delete or replace.
- Views `current_card_purchase_exclusions` and `excluded_card_usage_keys`.
- `REVISION_OF` gains `card-usage-exclusion:` = max revision.

**Files**

- **Domain:**
  - `card-purchase.ts`: add `excluded_by_decision` to `CARD_USAGE_EXCLUSIONS`; `cardPurchaseRetirement` reason union adds `kind_undecided`.
  - `card-purchase-review.ts`: `cardPurchaseExclusion` and `cardPurchaseRestore` drafts, with eligibility blockers `not_live`, `already_excluded`, `not_excluded`, `state_unknown`.
  - `pending-posted-review.ts`: blocker `excluded_by_decision`.
- **`packages/storage-d1/src/atomic/card-purchase-exclusion.ts`.** Statement 1 is the exclusion decision, guarded on the event live at n and the chain state. Then the event decision, revision, supersede, sidecar, keys, and finally the exclusion row. Every later statement is `WHERE EXISTS(decision) AND NOT EXISTS(own row)`.
- **`packages/application/src/operations/card-purchase-exclusion.ts`.** Plan: validate, pin `card-purchase:<id>` and `card-usage-exclusion:<id>`, simulation targets, invalidation. Mutation writes. Register in P1-1's registries.
- **`services/processor/src/card-purchase-job.ts`.** Read the excluded keys once per tick; skip them in recognition, revise and reanchor; drop them from the candidate pass and the auto-merge.
- **`packages/read-model/src/card-purchase-keys.ts`.** `EXCLUDED_CARD_USAGE_KEYS_SQL`.
- **`query/card-purchases.ts`.** Each view gains `exclusion` and `actions: ["exclude"|"restore"]`. Summary gains `excluded` per unit and a count; `unresolved` stops counting excluded events.
- **`packages/observation-shared/src/card-purchase-contract.ts`.** Validator changes.
- **Web:** `Purchases.tsx` (「購入ではない」: reason select plus written reason → plan → `/confirm`), a `Confirm.tsx` panel (reads the event back; pins must match), badges in `purchase-display.tsx`.

**Idempotency and correction.** Every id is keyed by the operation. A replay or stale batch writes nothing. Undo is `restore`; the exclusion history stays.

**Tests**

- **storage-d1:** order, replay, stale event, double exclusion refused, restore requires a live exclusion, append-only.
- **Domain:** drafts validate; a merged event excluded with both of its keys.
- **Application:** plan → simulate → approve → commit; agent refused; resend returns the receipt; concurrent commits write once.
- **Processor, on `test/card-purchase-world.ts`:**
  - an excluded captured row stays excluded across re-fetch, re-anchor and a content change;
  - restore captures it again;
  - an excluded pending event is not paired;
  - the captured total drops by exactly the excluded amount; settlement figures unchanged;
  - a row that vanished after exclusion writes nothing; restoring it then gets retired next tick.
- **Browser:** the action, the confirm panel, and a stale pin disabling approval.

**Docs.** `economic-events.md` ("Excluding a row by decision"), `change-lifecycle.md`, `card-settlements.md` (figures), `roadmap.md` (limits).

### P1-3 — `feat: allocate a refund to its purchase by reviewed decision` (~3k lines; needs P1-1; parallel with P1-2)

**Data model (0053)**

- `allocation_withdrawals(allocation_id PK → allocations, decision_revision_id, created_at)`. Guard: one per allocation; supersede decision on `allocation:<id>`; role ≠ `settlement` (card settlements keep their 0044 table).
- `DROP VIEW current_allocations` and recreate it excluding both withdrawal tables. It must stay valid for `card_settlement_readiness`.
- Trigger `allocations_refund_one_live_source` (BEFORE INSERT when `role='refund'` and a live refund allocation from the same source exists).
- **`card_refund_allocations`** `(allocation_id PK, refund_event_id, refund_revision, purchase_event_id, purchase_revision, account_id, source_id, created_at)`. Guard:
  - the allocation row matches (`event:` refs, role, and unit/coefficient/scale equal the refund leg);
  - both revisions are live and `captured`, of kinds refund and purchase, on the same account and source according to `current_card_purchase_recognitions`.
- View `current_card_refund_allocations`.
- `REVISION_OF` gains `card-refund:<refund>` and `card-refund-target:<purchase>`, each = sidecar rows + their withdrawals (monotonic).

**Files**

- **Domain:** `refundAllocationCandidates`, the allocation and withdrawal drafts, blockers (`amount_exceeds_remaining`, `account_differs`, `not_captured`, `refund_already_allocated`, `refund_before_purchase`), and `refund_allocated` added to the pending-to-posted blockers.
- **Storage:** atomic `card-refund-allocation.ts`.
- **Application:** `operations/card-refund-allocation.ts`; `query/card-purchases.ts` gains `refunds[]`, `allocatedTo`, `netAmount`, `candidates` for refunds, and the summary split.
- **Processor:** the auto-merge skips allocated events.
- **Web:** Purchases gains 「返金の対象を選ぶ」 on refunds and 「充当を取り消す」; Confirm gets a panel.

**Cross-guard with P1-2.** A trigger cannot reference a table that may not exist yet, so **whichever of P1-2 and P1-3 lands second** adds two guards: you can't exclude an event that is part of a live allocation, and you can't allocate to or from an excluded event (a trigger on `card_refund_allocations` plus a blocker).

**Tests**

- INV06: a second allocation of one refund is refused by the trigger.
- Withdraw then re-allocate elsewhere works.
- Over-refund is refused at plan.
- Card-settlement withdrawals are still excluded from `current_allocations` (regression), and `allocation_available` is unchanged.
- Net figures after refund, retire and revise, each with its explicit reason.
- A merge is blocked while an allocation is live.
- Application lifecycle tests and browser tests.

**Docs.** `economic-events.md` ("Refund allocation"), `change-lifecycle.md`, `card-settlements.md`.

### P1-4 — `feat: recognise installment and bonus purchases once, with the provider-stated schedule as an obligation` (~3.5k lines)

Needs the in-flight payment-type-shape PR to be merged.

_Update 2026-09-26:_ #246 merged on 2026-09-25, so this dependency is met.

**First commit: a survey (docs only).** Run read-only aggregate queries on production that return shapes and counts, never values:

- the distinct normalised payment-type texts per source;
- whether MyJCB installment rows have `今回回数` and `ご利用金額`;
- which Vpass web `data[7..13]` cells and customized cells (`bunkatsuPay`, `shiharaiTotal`, `tesuWariKin`) are populated on non-single rows.

Record the findings in `docs/sources/myjcb.md` and the Vpass notes. Build synthetic fixtures that mirror the shapes. If Vpass fields cannot be confirmed, Vpass installment rows stay `installment_shape_unverified` and the PR ships MyJCB only.

**Data model (0054)**

- Replace the trigger `card_purchase_recognitions_facts`. It accepts:
  - v1, byte-equivalent to today; or
  - v2: 7 keys, adding `plan{kind: bonus-lump-sum|installment, count, sequence, portion, fee}`, with `paymentType` in `bonus-lump-sum|installment` and `amountCheck='provider-usage-amount'` for installments.
- `amount` means the provider-stated purchase amount (usage), so the 0047 leg-equality guard still holds unchanged.
- **`card_installment_obligations`** `(obligation_id, revision, event_id, event_revision, content_digest, policy_release, created_at)`:
  - PK `(obligation_id, revision)` → `obligation_revisions`;
  - guard: the obligation revision is live; the event revision is live with a v2 installment sidecar; principal equals the leg's unit and value;
  - trigger: at most one live obligation per event;
  - append-only; view `current_card_installment_obligations`.

**Files**

- **Domain:**
  - `card-purchase.ts`: `classifyPaymentPlan`; `classifyCardUsage` returns the plan; exclusions add `revolving_unsupported` and `installment_shape_unverified`; a disposition `installment_portion`;
  - `cardPurchaseContent` gains `plan` **only for non-single rows**, so every stored single-payment digest is unchanged (a test pins a stored digest);
  - `validCardPurchaseFacts` accepts v1 and v2;
  - new `card-installment.ts`: obligation draft, schedule entries, `remainingUnbilled` rule.
- **Storage:** atomic `card-installment-obligation.ts`.
- **Processor:** an obligation pass after recognition (≤ 100 per tick; content-digest compare; rule decisions; count-only log fields `obligationsWritten` and `installmentPortions`).
- **Read model:** `card-usage.ts` reads the confirmed plan cells.
- **`query/card-purchases.ts`:** plan and schedule per event; `coverage.unrecognizedByReason{code:n}` and `installmentPortions` computed in TypeScript from the same current-usage pass (replacing the SQL count; a test shows the old total is preserved).
- **`read-model/src/events.ts` obligations:** surface the schedule, `billedToDate` and `remainingUnbilled`; installment obligations report `outstanding: null`, `settled_through_statements`.
- **Web:** a plan and schedule panel on the purchase detail page.

**Idempotency and correction.** Purchases follow the existing lane rules. The obligation follows its event on revise, merge, split and retire, with at most one tick of lag. A replay writes nothing.

**Tests**

- A 3-installment MyJCB plan: the sequence-1 row is captured at 12,000; sequence 2 and 3 rows are never events; the captured total is 12,000 exactly once.
- The pending usage row pairs with the sequence-1 row through `facts.amount`.
- Bonus-lump-sum is recognised once. Revolving is excluded.
- One live obligation per purchase (trigger). The obligation retires with its event.
- `remainingUnbilled` becomes null once a later statement is collected.
- Settlement adds no purchase leg.
- Old v1 rows still validate. A v2 insert with text in `plan` is refused.
- `card-purchase-parser-shapes.test.ts` still agrees with the matching guard.

**Risks.**

- Rolling the app back below P1-4 makes v2 rows fail closed on the purchases page.
- Portion fees stay unknown unless stated.
- `comparableCardPayment` in the reconciliation lane is deliberately unchanged, to avoid colliding with the in-flight reconciliation work.
  _Update 2026-09-26:_ that work merged as #243; retiring the lane's Vpass/MyJCB stage B is still in flight as #258 ([ADR 0006](../adr/0006-reconciliation-lane-scope.md)).

### P1-5 — `feat(settlement): SBI Shinsei as a second bank adapter for card settlement review` (~1.8k lines; independent)

**Check before building.** Run a read-only count of SBI Shinsei debit rows whose amount equals a Vpass or MyJCB statement total within ±3 days. This confirms the adapter is useful; ship regardless, and document which card pays from which bank.

**Data model (0055).** `DROP VIEW card_bank_debit_facts` and recreate it as a `UNION ALL` of two adapter branches:

- SMBC: the predicate unchanged;
- SBI Shinsei: `source_id='sbi-shinsei-bank'`, parser `sbi-shinsei-top-balances-and-activity`, `currency='JPY'`, non-empty external id, `amountSignSource='debit'`, `coefficient LIKE '-%'`, `status IS NULL`.

Each branch is ranked on its provider key, and both output `debit_date` and `adapter`. `card_settlement_readiness` needs no change.

**Files.**

- `card-settlement-job.ts`: use `debit_date` instead of the SMBC regex.
- Domain `card-settlement.ts`: comments only.
- Web: the source label.
- Docs: `card-settlements.md` ("Source evidence" and a bank adapter table), `economic-events.md`, `roadmap.md`.

**Tests** (fixture `tests/fixtures/observation-pipeline/sbi-shinsei-parser-boundaries/top-accounts-balance-and-activity.json`, through the deployed parser):

- an equal-amount statement produces a candidate;
- credit rows, foreign-currency rows and zero rows are excluded;
- re-observing the same `txnReferenceNo` is not a second payment;
- `allocation_available` holds across adapters;
- ownership is still required;
- the SMBC suite passes unchanged.

**Risk.** Long Japanese holidays can push a debit past ±3 days; document it.

### P1-6 — `feat: explain one card statement row by row, beside its bank debit` (~3k lines; needs P1-2, P1-3, P1-4)

**Scope.** Read-only. Closes the phase 6–7 "Done when": a user can identify the statement and bank payment, inspect the evidence, correct a decision while history is kept, and see the purchase and cash views reconciled.

**Files**

- **`packages/application/src/query/card-statement.ts`.**
  - `listCardStatements`: `card_statement_facts` with ownership, joined to the settlement review status.
  - `queryCardStatement({sourceId, accountId, period})`:
    - rows from the current-usage pass, filtered by resolved account, source and period (plus pending rows), each with its disposition and linked event, allocation or obligation;
    - an exact sum per disposition group, `rowSum`, `providerTotal`, and `difference` with reason codes `rows_incomplete`, `fees_or_interest_not_itemized`, `statement_not_final`, `row_amount_not_exact` (null when not exact, never zero);
    - `purchaseBasis` (captured, including full installment amounts first billed here, refunds, excluded) beside `cashBasis` (the accepted settlement's bank debit, once);
    - a history timeline: settlement decisions, event revisions, exclusions, allocations, obligation revisions.
- **Domain:** `card-statement-view.ts`.
- **App:** `card-statements-api.ts`: `GET /api/v2/card-statements` (list, or detail with `source`, `accountId`, `period`). Operator-only, 404 unless 0047 exists.
- **Web:** `CardStatements.tsx`, routes `/purchases/statements` and `/purchases/statements/<source>/<accountId>/<period>`.
- If the in-flight purchases agent intent has landed, add a `statement` detail through the same function.
  - _Update 2026-09-26:_ it landed as a separate tool, `kogane.purchases.explain` (#245), not a `financial.query` intent; a `statement` detail would go through that tool.

**Tests.**

- Group sums add up to `rowSum` exactly.
- A difference is never zero-filled.
- A later installment portion is shown as "purchased earlier".
- An excluded fee is shown apart.
- An allocated refund names its purchase.
- The bank debit appears once, and no purchase figure changes when a settlement is accepted.
- A withdrawn settlement keeps its history.
- Paging; API 401/403/405/404; browser tests.

**Docs.** `card-settlements.md` (statement explanation), `roadmap.md` (the "Done when" status), `agent-api.md`.

### P1-7 (optional) — `feat: link later installment portions to their obligation by reviewed decision` (~2.5k lines; needs P1-1 and P1-4)

- **Candidates are computed at read time:** same account and source, same provider usage date, usage amount and count, sequence = next expected. Ambiguity is a blocker (`candidate_not_unique`).
- **Data model (0056+):** `card_installment_portion_links(obligation_id, obligation_revision, recognition_key, sequence, observation_id, parse_run_id)`:
  - one-live-holder trigger per key;
  - a trigger refusing a key currently held by a purchase;
  - a new additive trigger on `card_purchase_recognition_keys` refusing a key that is live-linked as a portion.
- **Link:** obligation revision r+1 with entry k confirmed (portion amount, statement period). **Unlink:** revision r+2 with entry k projected again.
- **Payload** carries up to 36 portions per plan.
- **Result:** `remainingUnbilled` becomes exact.

## 3. Part 1 deploy and rollback

There are no flags. A release applies the migration before the Workers (processor, then app), and a PR is live when deployed. Rollback is a Worker revert; tables and rows stay; nothing is deleted. Corrections are new revisions. 0051 (the rebuild) is the only migration that copies history.

---

# Part 2 — dated reported state (phases 8 and 11) and price/FX valuation (phases 9 and 13)

## 4. Binding decisions

1. **"Reported state on date D"** is the latest complete snapshot per container partition with `observation_fetch_artifacts.fetched_at < (D+1) 00:00 Asia/Tokyo`. That field is uniformly UTC `%Y-%m-%dT%H:%M:%fZ`, so string comparison works. Snapshots are chosen by the existing snapshot rules (policy table, coverage claims, published parses) through a new `cutoffParam` option on `snapshotCtes`.
   - Freshness policy `dated-state-freshness-v1`: `same-day` / `recent` (≤ 3 days) / `stale`.
   - A missing snapshot is a stated reason, never a zero.
2. **Perimeter.**
   - Included: the containers in `SNAPSHOT_DATASETS` and `ARTIFACT_SNAPSHOT_CONTAINERS` (Mizuho).
   - Excluded, with a coverage note: MoneyForward (aggregator), SBI `account-assets-current` and Sony gross totals (aggregates), balance-after-transaction metrics, rewards.
   - Card payables come only from the authoritative statement parsers.
3. **Prices are observations promoted by rule.** Each row is written to the existing `price_observations` with `source_claim_ref` naming the claim.
   - A domestic `current_price` or foreign `stockPrice.last` is promoted only when quantity × price equals the provider's market value on the same row (verifies the per-share basis).
   - FX: SBI Shinsei `midRate` → `reference`, `buyRate` → `bid`, `sellRate` → `ask`, base CCY and quote JPY, admitted only for currencies whose quote basis the survey verified (per 1 unit).
   - Execution prices are never used for valuation.
4. **Valuation follows `VALUATION_STEPS`.**
   - Adoption and overlap come first: `buildBalanceProjection` / `selectAdoptedSet` over the dated balance candidates; an overlapping row is `overlap`, not `missing-price`.
   - Then quantity × price, then FX.
   - FX policy `fx-sbi-shinsei-mid-v1`: pivot JPY; freshness 4 days; missing FX is never 1:1 and never zero. Multiplying by a CCY/JPY rate is exact. The inverse (for a non-JPY base) is rounded under the policy and its rounding inputs are kept.
   - Provider-reported values are shown beside, never substituted.
   - `netWorth` returns a known-assets subtotal with `incomplete-liabilities`.
5. **Reproducibility.** Every result carries a manifest (artifact, observation, price and policy ids) and `contextId = digest(manifest)`. Fixed reports reuse the existing `calculation_runs`, `calculation_results` and `report_artifacts`.

## 5. Part 2 pull requests

Dependencies: P2-1 and P2-2 are independent of everything, including Part 1. P2-3 needs both. P2-4 needs P2-3. P2-5 is optional.

### P2-1 — `feat: dated reported holdings, cash and card payables per account` (~2.8k lines; no migration unless measurement needs an index)

**Files**

- **`packages/parsers/src/snapshot-query.ts`.** `SnapshotCteOptions.cutoffParam` adds the cutoff predicate in `eligible_snapshots` and `eligible_artifact_containers`. Without it the SQL text must be byte-identical (test).
- **`packages/read-model/src/dated-state.ts`.** With prefixed CTEs, three queries:
  - positions and matched valuations (reuse the `POSITION_VALUATIONS_SQL` rules);
  - container balances with registry metric, additivity and identity (account id, instrument id via `current_identity_observations`, `identity_instrument_uses`, `current_instrument_mappings`);
  - statements "as of cutoff" (the `card_statement_facts` predicate restated with the cutoff; the view itself unchanged) with settlement review status and debit date.
- **`packages/application/src/query/dated-state.ts`.** `queryDatedState(sql, {date, source?, account?})` returns accounts, each with its snapshot (capture time, age, freshness), positions (with provider valuations) and balances (with additivity), plus `payables[]` with status `due_after_date`, `settled_on_or_before_date`, `due_unsettled` or `payment_date_unknown`. Coverage lists sources without a snapshot, stale sources, exclusions, and `liabilitiesCoverage: "partial"` naming what is missing. **No sums.**
- **App:** `services/app/src/reported-state-api.ts`: `GET /api/v2/reported-state?date=YYYY-MM-DD`, reader authority, GET-only, capability `reportedStateOnDate`.
- **Web:** `apps/web/src/pages/ReportedState.tsx` at `/state` (「基準日の保有状況」). Date picker, account cards, 取得日時 and freshness badges, 取得元の評価額 (unconverted), a card payables table, coverage notes. Plus NAV, router and capabilities.

**Tests.**

- A snapshot after the cutoff is ignored; an incomplete one is never chosen; a complete-empty snapshot removes positions; a position missing from the later snapshot is not held.
- Identity resolved and unresolved.
- Payable status transitions around the payment date and the settlement's debit date.
- Without `cutoffParam` the SQL is unchanged.
- Cost measured on the scaled store (target < 1 s).
- API and browser tests.

**Docs.** `docs/balance-read-model.md` ("dated reported state"), `roadmap.md` (phase 8), a new section `docs/reported-state.md`.

### P2-2 — `feat: parse SBI Shinsei exchange rates and promote provider prices to price observations` (~3k lines)

> **Update 2026-09-26 (P2-2).** Implemented with migration **0053** (0051 and
> 0052 are taken by other pull requests of this plan) and recorded in
> [ADR 0020](../adr/0020-price-promotion-by-rule.md). The survey could read
> only artifact metadata: 29 `exchange-rate` artifacts, `artifact_key`
> `raw-exchange-rate.json`, all from successful runs. The currency list,
> `customerCategory` values and `transactionTime` presence are in the payload
> bytes in R2 and were not surveyed, so no currency's quote basis is verified
> and the lane promotes no FX row yet (`unsupported_currency`). The position
> rules promote today. The lane runs without a flag, right before
> `report_job`.

**Survey (read-only).** The stored `exchange-rate` artifacts' `dataset`/`artifact_key`, the currency list, `customerCategory` values and `transactionTime` presence. Shapes only.

**Parser.** `packages/parsers/src/parsers/sbi-shinsei-exchange-rate.ts` 1.0.0:

- a strict schema equal to the collector's validator;
- valuation observations: `sourceAccount 'sbi-shinsei:fx-board'`, `subject '<CCY>'`, metrics `bank_buy_rate`, `bank_sell_rate`, `bank_mid_rate`, currency JPY, exact decimal text, `asOf` = `transactionTime` if present;
- `extra._kogane.quoteBasis`;
- a complete-container coverage claim.

Register the parser, regenerate digests, and add it to `SNAPSHOT_DATASETS`.

**Migration (0057).**

- A `dataset_snapshot_policies` row (`coverage-v1`, required version `1.0.0`).
- `price_observation_claims(price_id PK → price_observations, rule_id, claim_kind valuation|position, observation_id, parse_run_id, json_path, created_at)`, append-only, `core-keep`.
- `price_promotion_cursor(claim_kind PK, last_observation_id)`, operational, excluded from the revision ledger.

**Domain.** `packages/domain/src/price-sources.ts` holds the closed rule list:

- FX rows;
- domestic `current_price` paired with its position through the `POSITION_VALUATIONS_SQL` rules, base `instrument:<source>:<market>:<code>` as in `report-job.ts`, per 1 share, quote JPY;
- foreign `$.stockPrice.last`, quote = `currencyCode`.

Each rule has its basis check and an effective-time rule: provider instant, else the fetch instant with basis `collector`. The price id is `price_<sha256(rule, claimRef)>`.

**Processor lane `price_promotion`.** Placed after `identity_sweep` and before `report_job`. At most 500 claims per tick, `INSERT … WHERE NOT EXISTS`, cursor per claim kind. The log carries counts only: `promoted`, `basis_unverified`, `unsupported_currency`.

**Read model.** `price-selection.ts`: the latest price with effective time ≤ cutoff, whose claim parse is **currently published** (joining `published_parse_runs`), so a re-parse supersedes naturally while old rows stay for old contexts.

**Tests.**

- Parser boundaries: unknown field, empty board, per-100 quote refused.
- The basis check promotes VT and AAPL from the fixture and refuses a tampered row.
- Replay writes nothing; a re-parse yields new price rows and selection moves to them.
- Append-only.
- Lane order in `lanes.test.ts`.

**Docs.** `calculation-and-reports.md` §1 (price sources), `docs/sources/sbi-shinsei-bank.md`, `parser-coverage.md`, `observation-lanes.md`.

### P2-3 — `feat: value holdings on a date in a base currency with the unvalued portion explained` (~3.5k lines; needs P2-1 and P2-2)

**Migration (0058).** Seed `calculation_policies`:

- `fx-sbi-shinsei-mid-v1` (kind `fx`: rule, pivot, freshness days, inverse rounding);
- `valuation-rounding-v1` (aggregate, half-even, precision per unit).

**Domain.** `packages/domain/src/valuation.ts`:

- `instrumentClassOf` (instrument kind and market → class; unknown → unsupported);
- `fxPath` / `convertToBase` (exact multiplication chain, rounded inverse);
- `valueDatedState`: cells with step and reason; provider values beside; `summarizeValuation`; `netWorth` with the reported payables.

**Application.** `query/valuation.ts` `queryValuation(sql, {date, base})`. It runs dated state, then adoption via `buildBalanceProjection` over the dated balance candidates, then price selection, then valuation. It returns the manifest and `contextId`, cells grouped by account, the unvalued portion with reasons, and the prices and FX used (ids, kinds, effective times, claim links).

**App.** `GET /api/v2/valuation?date=&base=JPY|<quoted CCY>`, capability `valuation`.

**Web.** `Valuation.tsx` at `/valuation` (「基準日の資産評価」):

- the partition label (評価できた資産の小計, never 純資産);
- an unvalued section by reason;
- drill-down quantity × price × FX with `ObservationLink`s;
- the provider value beside, with a labelled difference;
- a "prices and FX used" panel.

**Tests.**

- SYN22 basis; exact FX product; missing FX never 1:1 or zero; a stale price; overlap before price.
- A foreign stock valued in JPY equals quantity × last × mid exactly.
- USD base rounds under the policy with its rounding inputs kept.
- The subtotal is never labelled net worth.
- The same inputs give the same `contextId`; a new price gives a new one.
- API and browser tests.

**Docs.** `calculation-and-reports.md` (§2 order in practice), `roadmap.md` (phases 9 and 13), `agent-api.md` (not yet an intent).

### P2-4 — `feat: fix daily valuation reports, compare two dates, and answer the net-worth intent` (~2.5k lines; needs P2-3)

**Report job v2** (`report-job.ts`). Each tick:

- values D = the last completed JST day in JPY through `queryValuation`'s core;
- manifest `report-inputs-v2`;
- body `report-valuation-v2`;
- the same run, result and artifact tables, reused when unchanged.

v1 bodies remain re-displayable.

**Application.** Report listing and a two-report comparison: quantity, price and FX change per holding. The FX/market split uses `pnlDecompositions` with `factual: false` under both policies.

**Web.** `/valuation/reports` list, re-display and compare.

**Agent.** Implement the `net-worth` intent (today `unsupported_semantics`) in `query/spec.ts` and `execute.ts`: filters `on` and `base`, capability `summary.read`. It answers from the latest fixed report on or before the date: known-assets subtotal, `liabilitiesCoverage`, reasons, report id. Never a net-worth figure while liabilities are partial. MCP descriptions updated.

**Tests.** Reuse without rewrite; a corrected price produces a new report while the old digest is unchanged; restriction handling; the intent refuses when no report exists; agent and HTTP parity.

**Docs.** `calculation-and-reports.md` §4–5 and `agent-api.md` (intents).

### P2-5 (optional) — `feat: reconstruct card liabilities on a date` (phase 11 first slice; needs P2-1 and P1-4/P1-6)

For date D, per card: statements due after D (reported), plus recognised captured purchases not yet on a collected statement (derived), plus installment `remainingUnbilled`, with authorized purchases shown apart. Any difference against a provider figure is an explained discrepancy, never an adjustment.

The alternative fifth PR, a public crypto reference-price collector, is deprioritised because SBI VC positions are currently empty.

## 6. Reviewer invariants and risks

**Invariants**

- Append-only everywhere; only `superseded_by` and the proposal resolution pointer move.
- Every judgement is a decision revision; heuristics (refund candidates, installment portion candidates, bank debit matches) are candidates until a human decides.
- One live holder per recognition key.
- One live refund allocation per refund; allocated total ≤ purchase amount.
- One live obligation per purchase.
- Installment later portions are never purchases.
- Settlement adds no purchase leg; purchases add no cash leg; the obligation principal is in neither figure.
- Captured and authorized are never summed.
- Exact decimals in `@kogane/domain`; no SQL sums of amounts.
- Missing values are reasons, never zero; missing FX is never 1:1.
- Provider-reported values sit beside Kogane's own calculations.
- Logs carry counts only; no provider text is stored in facts.

**Risks**

- The 0051 rebuild must not collide with another migration touching the command tables.
- Provider re-keys defeat exclusions and allocations: the old event retires and the new one needs a new review.
- Vpass installment cells are unverified, so P1-4 may ship MyJCB-only.
- SBI Shinsei's FX board is a customer rate (possibly tiered by `customerCategory`), not a market reference; the policy name says so, and ECB or TTM can be added later as another `fx` policy.
- The statement row-sum check may expose parser or page gaps (a wanted signal).
- Cost of the dated snapshot CTEs must be measured.
- Rolling back Workers below P1-4 makes v2 rows fail closed.

---

## Summary and recommended order

- **CORE migrations:** highest on main is **0047**. 0048–0050 are taken by in-flight PRs, so this plan starts at **0051**, provisional and renumbered at rebase.
  _Update 2026-09-26:_ 0048–0050 are now merged (#243, #249, #251); the plan still starts at 0051.
- **Correction to the brief:** Mizuho #216 and #221 are merged, but its fingerprint ids rule it out as a debit adapter, like Sony. SBI Shinsei is the adapter to build.
- **Main discovery:** SBI Shinsei already stores daily FX boards (buy, sell, mid) that nothing parses. SBI Securities positions already carry per-share prices that reconcile exactly with the provider's market values. The first price and FX PR therefore needs no new collector.
- **Main decision to confirm:** add real command kinds with one 0045-style rebuild (P1-1) instead of stretching relation markers. The marker fallback works only for exclusion.

**Recommended order**

1. **Wave 1, in parallel:** P1-1 (vocabulary, small), P1-5 (SBI Shinsei adapter), P2-1 (dated reported state, read-only), P2-2 (FX parser and price promotion).
2. **Wave 2:** P1-2 (exclusion) and P1-3 (refund allocation) in parallel, whichever lands second adding the cross-guard; P1-4 (installments) once the in-flight payment-type-shape PR is merged; P2-3 (valuation on a date).
   _Update 2026-09-26:_ #246 is merged, so P1-4 is unblocked.
3. **Wave 3:** P1-6 (per-statement explanation, which closes the phase 6–7 "Done when"); P2-4 (fixed daily reports, date comparison, `net-worth` intent).
4. **Optional:** P1-7 (reviewed installment portion links); P2-5 (reconstructed card liabilities).

### Critical files for implementation

- packages/domain/src/card-purchase.ts
- packages/storage-d1/migrations/core/0047_card_purchase_recognition.sql
- packages/storage-d1/migrations/core/0045_expand_card_settlement_commands.sql
- services/processor/src/card-purchase-job.ts
- packages/parsers/src/snapshot-query.ts
- services/processor/src/report-job.ts
