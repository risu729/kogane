# ADR 0074: A pure planner states multi-debit allocations of a card statement and answers unsupported for partial payments and excesses

- Status: proposed (accepted when its pull request merges)
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

- `proposed`: exactly one candidate, and none of its debits is in a
  candidate of another statement of the run. `single-debit` is the shape the
  sweep already proposes; `multiple-debits` is new.
- `needs_review` with `candidate_not_unique`: two or more candidates (a
  statement is paid once, so even disjoint candidates are ambiguous), or a
  member debit in another statement's candidate (also
  `debit_in_other_statement_allocation`; ADR 0034's two-sided uniqueness).
  Every candidate is listed and none is chosen.
- `unsupported`: no candidate. `no_debit_in_window`, or
  `no_exact_allocation` with `in_window_debits_below_total` when the
  in-window debits together are below the total (the shortfall shape a partial
  payment would have) and `debit_above_total` when one is above it (the shape
  of an overpayment or a debit paying several statements). No difference is
  computed and no debit is named as a partial payment.

Ownership is carried as today's matcher carries it: `established-same`,
`unknown` or `different` over the statement's and every member's owner, with
`owner_not_established` or `owner_differs` as a rejection condition, never a
refusal and never a decision. The manifest pins the planner release
(`card-statement-allocation-v1`), the policy version and the arithmetic
version.

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
  its input, and a run past them is refused.

## Verification

`packages/domain/test/card-settlement-allocation.test.ts`, synthetic inputs
only (invented ids, keys, round amounts and dates in the adapters' shapes):
today's matcher on a two-debit and a partial case; every policy refusal and
bound; exact two- and three-debit allocations across decimal scales; the
size bound; ownership as a condition; every unsupported code; the signed
window; mixed currencies never combined; ambiguity within and across
statements; every debit and statement refusal; the module's exports and that
nothing outside the domain calls it; and a property comparison on 300 seeded
random runs against a brute-force subset oracle: every allocation sums
exactly to its statement's total, members are whole, distinct, same-unit and
never held, no debit is proposed for two statements, the result is
independent of input order, and every outcome and code occurs. That
comparison found an order-dependent search when debits of two units were
sorted together by amount, fixed before this ADR.
