# ADR 0074: A pure planner states multi-debit allocations of a card statement and answers unsupported for partial payments and excesses

- Status: accepted (merged 2026-11-06 in #935)
- Date: 2026-11-06
- Issue: #548 (partial payments, multiple debits, refund allocation and correction)
- Related: [ADR 0002](0002-card-purchase-recognition.md) (one live holder per
  recognition key), [ADR 0004](0004-payment-type-shapes-from-evidence.md)
  (unobserved provider semantics stay unsupported),
  [ADR 0018](0018-sbi-shinsei-bank-debit-adapter.md) (the SBI Shinsei bank
  debit adapter), [ADR 0034](0034-card-settlement-automation-prerequisites.md)
  (a rule needs an owner-authorised, versioned policy; two-sided uniqueness),
  [ADR 0054](0054-economic-consumption-guard.md) (claims and alias classes in
  book `cash-movement`), [ADR 0057](0057-own-transfer-proposals.md) (a pure
  engine under an explicit policy, nothing registered)
- Carried by: `packages/domain/src/card-settlement-allocation.ts`,
  `packages/domain/test/card-settlement-allocation.test.ts`,
  [card settlements](../card-settlements.md#multiple-debits-and-partial-payments-adr-0074)

## Context

The `card_settlement_sweep` lane pairs one card statement payment total with
one bank debit: `cardSettlementCandidate` (`packages/domain/src/card-settlement.ts`)
returns facts only for an exact equal amount within three days of the due
date, and the sweep writes a candidate only when it does. Nothing else
connects a statement to a debit. Read and tested before this ADR
(`packages/domain/test/card-settlement-allocation.test.ts`, "what the
one-to-one matcher does today"):

- A statement of 3,000 that two debits of 1,000 and 2,000 pay together: both
  calls return null, so the sweep writes nothing and records no reason.
- A statement of 3,000 and one debit of 2,000: null, nothing written, no
  reason.

Either way the statement is indistinguishable from one that has no debit at
all. Issue #548 asks for partial payments, multiple debits and refunds as
their own states, with every unresolved difference left with a reason.

What the evidence shows. A statement's total is the provider's finalized
payment total (Vpass `payTotal`, MyJCB `お支払い金額合計`). A bank debit is a
row an adapter admits: a provider row id, the provider's own debit direction,
an exact amount and a civil date ([bank adapters](../card-settlements.md#bank-adapters)).
Both shapes are observed. Nobody has observed, and the owner has not
confirmed, how a provider represents a partial payment (a carried-forward
balance, a re-debit after a failed one, a payment by transfer), an
overpayment, one debit paying several statements, or a refund against a
statement. Under ADR 0004 none of them may be guessed.

## Options considered

1. **Widen `cardSettlementCandidate` to sums of debits and keep it in the
   sweep.** Rejected: the sweep writes every candidate it proposes, the
   candidate table's contract is one statement and one bank row
   (`statement_observation_id`, `bank_observation_id`, one `bank_key`), and
   the acceptance writer claims one debit. A multi-debit candidate would need
   a new table, a new acceptance writer claiming several keys in one batch,
   and a new review page; none exists, and writing candidates nothing can
   accept only adds rows.
2. **Model a partial payment as a debit below the total with a computed
   remainder.** Rejected: amount equality is the only evidence today's
   matcher uses; a debit below the total has none. Which debit is "the"
   partial payment, and whether the remainder is unpaid, carried forward or
   paid elsewhere, are provider semantics nobody has observed (ADR 0004). A
   remainder amount would read as an unpaid liability (INV05: an unknown is a
   reason, never a number).
3. **A pure planner in `packages/domain` that proposes exact allocations of
   one or more whole debits to each statement and answers every other case
   with closed codes; no table, no lane, no writer.** Chosen. It is the
   smallest step that states what today's matcher drops, adopts nothing, and
   is the input contract a later writer and review page would build on.

## Decision

### The planner (`planCardStatementAllocations`)

Pure and deterministic: the same input in any order gives the same output; no
storage and no clock. Inputs:

- **Statements**, at most 16: each a `CardStatementFact` (the type the sweep
  already builds) and its `statement_key`.
- **Debits**, at most 32: each a `CardBankDebitFact`, its `bank_key` and the
  alias class the registry's provider identity function computes for it
  (`humanAdoptedRowIdentity`), or null when the identity is not admitted.
- **Held**: the keys and alias classes live holders hold in book
  `cash-movement`, and the statement keys accepted settlements reserve.
- **Policy** `CardStatementAllocationPolicy`: `policyVersion`, `window:
  { minDaysFromDue, maxDaysFromDue }` (the debit date minus the due date,
  inclusive, within ±31 days) and `maxDebitsPerAllocation` (1 to 3). No field
  has a default and the module has no default policy: a missing policy is
  `policy_missing`, any other shape `policy_unsupported`. Nothing in the
  repository supplies a policy. An input past a bound is
  `input_bound_exceeded`, never cut.

Each debit, first failure wins: `debit_invalid`, `debit_repeated` (the same
ref twice: every copy), `identity_not_admitted`, `amount_not_exact`,
`amount_not_positive`, `debit_date_missing`, then INV06:
`duplicate_unresolved` (two debits sharing a key or an alias class: all of
them, never asserted separate or the same), `economic_claim_held`,
`alias_conflict`. Each statement: `statement_invalid`, `statement_repeated`,
`amount_not_exact`, `amount_not_positive`, `payment_date_missing`,
`statement_already_allocated`. For each statement and admitted debit:
`currency_differs`, then `date_outside_window`.

A candidate allocation is a set of at most `maxDebitsPerAllocation` admitted,
same-unit, in-window debits whose exact sum (`values.ts`, INV03) equals the
statement total. Each member allocates its whole amount; no debit is split.
Outcome per statement:

- `proposed`: exactly one candidate, none of its debits is in a candidate
  of another statement of the run, and no refused debit competes (below). `single-debit` is the shape the
  sweep already proposes; `multiple-debits` is new.
- `needs_review` with `candidate_not_unique`: two or more candidates (a
  statement is paid once, so even disjoint candidates are ambiguous), or a
  member debit in another statement's candidate (also
  `debit_in_other_statement_allocation`; ADR 0034's two-sided uniqueness),
  or a refused debit that competes (also `excluded_debit_competes`). Every
  candidate is counted, the first 50 are listed (amendment "a bounded list
  of allocations" below) and none is chosen.
- `unsupported`: no candidate. `no_debit_in_window`, or
  `no_exact_allocation` with `in_window_debits_below_total` when the
  in-window debits together are below the total (the shortfall shape a partial
  payment would have) and `debit_above_total` when one is above it (the shape
  of an overpayment or a debit paying several statements). No difference is
  computed and no debit is named as a partial payment.

A refused debit still competes, as in ADR 0057, so a refusal never picks the
payer: for a statement that has a candidate, a same-unit debit refused
`duplicate_unresolved` inside the window, or refused `debit_date_missing`
(checked without the window, which cannot exclude it), that could complete
an exact combination within the size bound with the in-window admitted
debits makes the statement `needs_review` with `excluded_debit_competes`.
Such a debit is never a member of a listed allocation. A held debit
(`economic_claim_held`, `alias_conflict`) does not compete: another holder
already consumed it. A statement without a candidate stays `unsupported`.

Ownership is carried as today's matcher carries it: `established-same`,
`unknown` or `different` over the statement's and every member's owner, with
`owner_not_established` or `owner_differs` as a rejection condition, never a
refusal and never a decision. The manifest pins the planner release
(`card-statement-allocation-v1`; `-v2` since the amendment "a bounded list of
allocations"), the policy version and the arithmetic version.

### Nothing calls it

No lane, command, planner registry or route imports the module (a test
checks that no file under `packages/*/src` outside `packages/domain`,
`services/*/src` or `apps/*/src` names it). The sweep, the candidate table,
the review page and the acceptance and withdrawal writers are unchanged, so a
statement two debits pay still has no candidate in production. A proposed
allocation adopts nothing (INV07).

### What a writer would need (not decided here)

A later change that lets an operator accept a `multiple-debits` allocation
needs its own ADR: a candidate table (or a widened one) citing several debits,
an acceptance writer that claims every member's key and alias class in one
batch under ADR 0054's guard, a withdrawal that releases all of them, the
review contract and page, and the owner's policy values. Partial payments,
overpayments, debits paying several statements and refunds need observed
provider evidence first.

## Consequences

- A multi-debit statement and a statement with a shortfall or an excess now
  have a closed, tested answer in the domain instead of silence; the answer
  is not yet visible anywhere.
- The planner may disagree with the sweep on a single-debit case: the sweep
  writes every equal-amount pair, while the planner calls two equal debits
  `needs_review`. The sweep is unchanged; acceptance's allocation guard still
  lets only one of them be accepted.
- A combination larger than three debits is never formed; such a statement is
  `unsupported` (`no_exact_allocation`).
- The bounds (16 statements, 32 debits) are below what one sweep page reads
  (100 statements, up to 1,000 debits per due date); a caller must partition
  its input, and a run past them is refused. Cross-statement contests and
  competing refused debits are judged within one run only: a caller that
  splits statements whose windows overlap, or the debits of one window,
  across runs loses them, so the caller's ADR must state a partition that
  keeps them together.
- A debit refused for another reason (`identity_not_admitted`,
  `amount_not_exact`, `amount_not_positive`, `debit_repeated`,
  `debit_invalid`) does not compete; it is listed in the run's exclusions.
- The refusals are checked in order, so a dateless debit whose key or alias
  class a live holder holds is refused `debit_date_missing` and still
  competes, as in ADR 0057; that only makes a statement `needs_review`,
  never `proposed`.

## Verification

`packages/domain/test/card-settlement-allocation.test.ts`, synthetic inputs
only (invented ids, keys, round amounts and dates in the adapters' shapes):
today's matcher on a two-debit and a partial case; every policy refusal and
bound; exact two- and three-debit allocations across decimal scales; the
size bound; ownership as a condition; every unsupported code; the signed
window; mixed currencies never combined; ambiguity within and across
statements; dateless and unresolved-duplicate debits competing, held ones
not; every debit and statement refusal; the module's exports and that
nothing outside the domain calls it; and a property comparison on 300 seeded
random runs against a brute-force subset oracle: every allocation sums
exactly to its statement's total, members are whole, distinct, same-unit and
never held or dateless, each statement's status and codes match the oracle's
uniqueness, cross-statement and competition rules, no debit is proposed for
two statements, the result is
independent of input order, and every outcome and code occurs. That
comparison found an order-dependent search when debits of two units were
sorted together by amount, fixed before this ADR. The independent review added the competition rule
(the planner first let a refused duplicate or dateless debit drop out
silently, so a statement could be `proposed` beside another possible payer)
and the oracle's status check.

The oracle property draws no refusal, so it did not see that a debit or
statement ref id given at two revisions (both refused `debit_repeated` or
`statement_repeated`) was listed in input order. The ref revision is now the
last key of both lists' order (2026-11-08), so the order is total: entries
equal on every key are equal. A second property shuffles the input three
times on 400 seeded runs that draw every debit exclusion, statement refusal,
pair exclusion and outcome code, with ties on every key but the revision in
both lists, and compares the whole output.

## Amendment 2026-11-07: a read-only caller on the review page

Phase 2 plan unit 2e (owner approval of the whole plan, 2026-11-07 03:58 UTC,
"すべて推奨される手順でいいです") makes the planner's answer visible, and only
visible. `reviewUnmatchedCardStatements`
(`packages/application/src/query/card-statements-unmatched.ts`) is the one
caller; the `カード照合` page
(`GET /api/v2/reconciliation/card-statements-unmatched`) and the agent tool
`kogane.card-settlements.unmatched` both call it
([card settlements](../card-settlements.md#statements-without-a-candidate)).
No lane, table, command or writer uses its answer, and the acceptance writer
still claims exactly one debit, so nothing it lists can be accepted
(`acceptable: false` on every item). "Nothing calls it" above is replaced by
this.

- **Policy** (the owner's values for plan question 3, 2026-11-07 03:58 UTC):
  `card-statement-unmatched-display-v1`, the window the sweep uses (three days
  either side of the due date) and at most three debits per allocation
  (`CARD_STATEMENT_UNMATCHED_ALLOCATION_POLICY`,
  `packages/domain/src/card-settlement-unmatched.ts`). It is a display
  policy; no rule or writer is authorised by it.
- **Who is asked.** Only a statement that no candidate cites and whose window
  holds debits but none of an equal amount (`no_equal_amount_debit`), the one
  case where the planner can say more than the sweep. A window with an equal
  debit the matcher accepts is `equal_amount_debit_awaiting_sweep` instead:
  the sweep writes its candidate on its next pass.
- **Partition.** The statements so asked on one page (at most 50, by
  statement id) are sorted by due date and grouped while consecutive due
  dates are at most six days apart, so any two whose windows share a day are
  in one run with the union of their windows' debits (each window read once,
  with the sweep's own `CARD_SETTLEMENT_BANK_DEBITS_SQL`). A group past 16
  statements or 32 debits, or whose window read reached its 1,000-row bound,
  is answered `input_bound_exceeded` for every statement, never cut.
- **What a run does not see.** Statements that already have a candidate, and
  statements on another page, are not in the run, so a debit one of them
  could use is not contested here. Held keys, alias classes and reserved
  statement keys are read for the run's debits and statements (live
  `economic_claims` rows and accepted settlements of live revisions in book
  `cash-movement`), so a debit another holder consumed takes no part.
- **Identity.** Each debit's alias class is `humanAdoptedRowIdentity` over its
  row and resolved account, as the acceptance plan computes it; a debit
  without a resolved account or an admitted identity is
  `identity_not_admitted`.
- **Rows the sweep does not compare.** A window row without an exact amount
  or with a debit date that is not a civil date is passed to the planner as
  it is (an absent amount, an unknown date), not dropped, so the planner
  excludes it under its own code and a dateless one competes, as above.

Verification: `services/processor/test/card-statements-unmatched.test.ts`
on the complete CORE schema (two debits paying one statement exactly, a
shortfall, overlapping windows contesting one pair, every closed code, a
swept statement leaving the list, no write, keyed lookups without
statistics); `services/app/test/card-statements-unmatched-api.test.ts` (the
route and the agent tool answer the same page; grants; audit);
`apps/web/test/card-settlement.browser.test.ts` (the page shows the reason
and the answer and offers no action). The module test now pins this caller
and its wire contract as the only files naming the module.

## Amendment 2026-11-07: a bounded list of allocations

- Status: accepted (merged 2026-11-08 in [#1100](https://github.com/risu729/kogane/pull/1100))
- Date: 2026-11-07

### Context

`needs_review` listed every candidate. Under the display policy (at most
three debits) and the run bound of 32 debits, one statement can have
C(32,1) + C(32,2) + C(32,3) = 5,488 debit sets, and a window of 32 equal
debits, each a third of the total, has 4,960 exact three-debit sums. The
planner built every one as an allocation object, and the review read sent
them all: a run at both bounds (16 such statements) serialized to about
112 MB (measured with the shipped planner, the same synthetic input as the
verification below), and a 50-statement page can hold several such runs,
against the 128 MB one Worker isolate has. The page rendered every one, and
the browser's wire contract refused a list above 1,000, so such a statement
broke the whole page. PR #1099 widened that contract bound to 5,488 to
match the uncapped planner; this amendment bounds the list instead, and the
contract now bounds the list at 50 and `allocationCount` at 5,488.

### Options considered

1. **Cut in the review read** (`reviewUnmatchedCardStatements`): the planner
   still builds every allocation, so the memory is spent before the cut.
2. **Stop the search at the bound**: bounded time and memory, but the
   status and codes need every candidate (whether a debit is in a candidate
   of another statement decides `debit_in_other_statement_allocation`), and
   the count of what is not shown would be lost.
3. **Count every candidate, keep only the first ones** (chosen): the search
   visits each exact combination once (at most 5,488 per statement, which the
   run bounds already cap), records which debits any candidate uses, and
   keeps at most twice the bound, sorting and cutting back when it fills.

### Decision

- `CARD_STATEMENT_ALLOCATION_LISTED_MAX = 50`
  (`packages/domain/src/card-settlement-allocation.ts`). Fifty matches the
  review read's page of 50 statements, keeps a worst page at 2,500 listed
  allocations, and is more than an operator can compare by eye; the page
  accepts none of them anyway (`acceptable: false`), so past a few the list
  only shows that the statement is ambiguous, which the status and count
  already say.
- Every outcome carries `allocationCount` (every exact allocation: 1 for
  `proposed`, 0 for `unsupported`) and `allocationsTruncated`, true exactly
  when the count is above the allocations listed. The list is the first 50 in
  the order it always had (fewest debits first, then by the members' ref
  ids), so it is deterministic and, at or below 50, unchanged. Status, codes,
  pair and debit exclusions are decided from every candidate, as before.
- The competition check stops at the first exact combination a refused debit
  completes; it only ever asked whether one exists.
- The planner release becomes `card-statement-allocation-v2`: the listed
  output changed.
- The review read passes both fields through and states the bound in
  `manifest.planner.bounds.allocations`. Its wire contract
  (`packages/observation-shared/src/card-statements-unmatched-contract.ts`)
  refuses a list above 50, a list shorter than its count without the marker,
  a marker with nothing left out, and members above
  `CARD_STATEMENT_ALLOCATION_SIZE_MAX`. The `カード照合` page says
  `一致する組み合わせ N件のうち、出金の件数が少ない順に先頭の50件を表示しています。`
  above a truncated list. `kogane.card-settlements.unmatched` is the same
  service and returns the same fields.
- The wire `schemaVersion` stays `kogane-card-statements-unmatched-v1`: the
  fields are added, and an answer at or below the bound lists what it listed
  before.

### Consequences

- A statement with more than 50 exact allocations shows the first 50 and the
  count; the rest are not reachable through the page or the tool. They are
  not decisions either way, and no allocation is acceptable.
- Memory per statement is the kept list (at most 100 debit sets) and the set
  of debits any candidate uses (at most 32); the run at both bounds
  serializes to about 1.1 MB instead of 112 MB, and its time is unchanged
  (about 0.1 s here, the same search).

### Verification

`packages/domain/test/card-settlement-allocation.test.ts`, "a bounded list of
allocations": a window of 32 equal debits counted whole (4,960) with the
first 50 of the shipped planner's list, marked truncated; a run at both
bounds listing 800 allocations in under 2 MB; exactly 50 listed whole and 51
truncated, singles first; and a differential test on 200 seeded runs of up to
32 debits against the planner as shipped
(`packages/domain/test/card-settlement-allocation-legacy.ts`, frozen): equal
at or below the bound, the shipped list's first 50 above it, with the same
status, codes and exclusions, both sides drawn. The oracle property test now
checks the count and the marker. `packages/observation-shared/test/card-statements-unmatched-contract.test.ts`
covers the contract;
`services/processor/test/card-statements-unmatched.test.ts` adds the worst
window on the complete CORE schema;
`services/app/test/card-statements-unmatched-bound-api.test.ts` shows the
operator's route, the agent route and the MCP tool answer the same bounded
page; `apps/web/test/card-settlement.browser.test.ts` shows the note and the
50 listed combinations.
