# Card statement settlement review

This slice connects an authoritative Vpass or MyJCB statement payment total to
an observed SMBC bank debit. It records a reviewable correspondence and its
correction history. It does not reconstruct all purchases, infer loan principal
from a statement, or calculate net assets.

## Source evidence

- Vpass uses the finalized Web statement header's `payTotal`, `shiharaiDate`
  and `seikyuYm`, on page zero only. A statement still being created is excluded.
  Customized/unconfirmed `shiharaiKin1/2/3` fields are not finalized bill totals.
- MyJCB uses the confirmed HTML heading and the exact dated
  `お支払い金額合計` definition/value pair. The page month must agree with the
  due date. Archived HTML lacking manifest statement metadata can establish
  these facts from the explicit page markers; contradictory metadata fails.
- Both emit `credit_statement_payment_amount` with an explicit `paymentDate`.
  These observations are statements, excluded from net-asset summation.
  Monthly MyJCB summaries without an exact due date remain useful evidence but
  cannot supply a guessed payment date to this matcher.
- The first bank adapter uses SMBC's canonical `smbc-bank` transactions with a
  provider identifier and explicitly signed debit direction. It preserves the
  provider's civil date. Other banks and aggregator copies are not implicitly
  interchangeable with this adapter.

The parsers preserve zero and refund totals as source values. The positive-debit
matcher excludes them; a refund or a partial/multiple settlement requires its
own supported model. No payment total is manufactured by summing purchase rows.

## Candidate and decision lifecycle

A bounded Processor sweep reads published observations, retaining provider
identity and acquisition namespace. Exact same-unit amounts and nearby dates
produce candidates only. They never cause automatic acceptance.

The `照合` page shows the source facts, evidence links, candidate rationale,
current readiness blockers and decision history. An authenticated human operator
can plan an acceptance or rejection; the confirmation page then simulates,
approves and commits the pinned plan. Agents do not acquire acceptance rights.

Acceptance also requires explicit ownership evidence: the card account's
`liable_party` and bank account's `beneficial_owner` must identify the same
party through current accepted decisions. A login, matching account labels,
amounts or dates do not establish ownership. Resolve missing ownership through
the existing evidence-backed relation decision lifecycle; do not infer it while
collecting or generating candidates.

The commit rechecks the source publication/currentness, ownership, allocation
availability and expected candidate revision in the same database batch that
reserves the receipt. If any condition fails, it consumes no approval and writes
no partial receipt or decision. A resend returns the existing receipt.

An accepted decision can be withdrawn through a new approved plan. Withdrawal
retracts the interpretation, never the bank movement or original evidence.
Rejected and withdrawn candidates remain in history; a different correspondence
is reviewed as a different candidate. Historical citations keep resolving.

## Financial meaning and limits

Acceptance allocates the observed payment to a statement. It adds no new cash
movement and no new purchase expense: the bank debit is already in the source
evidence. Statement payment totals do not prove principal, fees or the unpaid
balance, so an obligation principal or exact liability reduction is not invented.
The screen keeps fee breakdown and net-asset impact unknown.

A successful source collector, parser or candidate scan is not proof of complete
card history. Missing ownership, unavailable exact dates, unsupported bank
adapters and stale evidence remain visible limitations. This milestone does not
complete the broader [economic-event roadmap](roadmap.md).

## Verification

Synthetic tests cover authoritative totals, missing/ambiguous dates and totals,
refunds, unconfirmed pages, ownership blockers, stale plans, idempotent decisions,
allocation conflicts and withdrawal history. Browser tests exercise the explicit
review/approval flow and refuse a detail revision that changed after planning.
Archived production samples were inspected read-only to verify provider field
shapes; private values are not test fixtures and no live financial decision is
accepted by those checks.
