# Roadmap

**The infrastructure migration is complete; the financial product roadmap is
not.** The next objective is to turn collected provider displays into connected
transactions, explainable assets and liabilities, valuations, and eventually
cost basis, P&L and tax outputs.

The code status was reviewed on 2026-10-05 against main 6d04d71. It distinguishes implemented
contracts and calculation components from a feature that works with real inputs
through its user interface. This is a repository assessment, not a new production
acceptance run. Dated production observations in the linked history describe those observations,
not a fresh measurement of the deployed system. Historical infrastructure
completion evidence belongs in [legacy retirement](legacy-retirement.md) and
the relevant rollout records.

## Current position

| Original phases                         | Implemented foundation                                                                                                                                                           | Work still needed for product completion                                                                                             |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 0–3: collection, evidence, observations | Source collectors, shared raw evidence, versioned parsing and publication; operations-API collection requests executed through the named collector RPC and traced to publication | Coverage by account and data type; enabling and verifying request dispatch in production, requested windows, READ projection tracing |
| 4–5: accounts and instruments           | Provider-local identities, mappings and append-only corrections                                                                                                                  | Evidence-backed resolution across direct providers, aggregators and brokers; review of unresolved identities                         |
| 6–7: reconciliation and economic events | Candidate matching, decisions, event/leg/allocation/obligation/settlement contracts                                                                                              | More transaction families and continuous event production from adopted observations                                                  |
| 8: reported state snapshots             | Adopted balance measurements, overlap handling and READ snapshots; reported state on a date (positions, provider valuations, balances, card payables)                            | Adoption across sources on a date, dated identity, liabilities beyond provider statements                                            |
| 9 + 13: prices and valuation            | Price contracts, pure valuation functions and fixed report artifacts                                                                                                             | Price/FX acquisition, selection policies and portfolio valuation from actual holdings                                                |
| 10: rewards                             | Bucket claims, expiry and conversion functions, READ projections                                                                                                                 | Classified activity history, verified applicable rules, membership and usable conversion offers                                      |
| 11: derived balances and positions      | Difference contracts and reconciliation readers; a pure fold from a start snapshot and adopted events, without a read path ([ADR 0052](adr/0052-reconstructed-state-fold.md))    | Applying adopted events to a starting snapshot to reconstruct balances and quantities                                                |
| 12 + 14: cost basis and P&L             | Input gates and some P&L decomposition functions                                                                                                                                 | Lots, carried cost, disposal allocation, realized and unrealized P&L                                                                 |
| 15: tax                                 | Refusal when required policy or inputs are missing                                                                                                                               | Verified rules and tested outputs for a named jurisdiction, period and asset/account class                                           |
| 16: AI / MCP                            | Shared query/explanation/proposal service and transports                                                                                                                         | Complete analysis and correction flows using the same services as the UI                                                             |

Current implementation and limits are maintained in [current status](current-status.md).
The detailed source-by-source fixes and dated rollout observations previously
listed here are preserved in [implementation notes through 2026-10-04](history/2026-10-04-implementation-notes.md).
Do not use those historical counts as a current production measurement.

## Delivery order and the next milestone

The main sequence is:

```text
account/instrument identity and data coverage
  → cross-source reconciliation and economic events
  → dated balances, holdings and liabilities
  → price/FX acquisition and valuation
  → lots, cost basis and P&L
  → jurisdiction-specific tax outputs
```

Rewards are a parallel workstream. UI and AI/MCP work accompany every stage.
Valuation of provider-reported holdings can proceed before all transaction
history has been reconstructed. Adding every source is not a prerequisite for
finishing a representative bank, card, broker or rewards flow.

**The current milestone is to complete card usage → statement → bank debit
coverage without counting an expense twice.** The first statement/debit review
slice is implemented, and so is the first purchase-event writer for supported
single-payment card usage (on in production since 2026-09-24), and so is the
pending-to-posted link review: the purchases page lists the open candidates
and reviews each purchase's link (accept, reject, withdraw) through the change
lifecycle. Source ownership, supported bank coverage, partial payments and
refund handling still need completion.
Securities executions, settlement, holdings and valuation follow that flow.

The [2026-09 next-milestone plan](plans/2026-09-next-milestone.md) is a
partially superseded proposal. Its remaining suggestions require a decision;
its migration numbers and in-flight PR list are historical, not current work
instructions. This roadmap records the current delivery order. The design decisions of 2026-09-24..26 behind
the card slice and the processor and identity work around it are recorded as
architecture decision records,
[ADR 0002](adr/0002-card-purchase-recognition.md) to
[ADR 0013](adr/0013-agent-card-purchase-read.md).

The numbered phases below retain the original layer identifiers. They describe
the remaining work and its acceptance criteria, not a requirement to finish
each phase everywhere before starting the next.

## Phases 0–5 — Coverage and cross-source identity

Track coverage per owned account and data type: balances, bank movements, card
usage, statements, security positions, executions, settlement cash, and reward
balances/activity/expiry. A deployed collector or a balance response does not
prove the trade history needed for P&L is available. Use the
[account inventory](account-inventory.md), [source research](source-research.md)
and [parser coverage contract](parser-coverage.md) for this inventory.

Connect collection and replay requests to execution, terminal status and
published observations. Resolve the same account seen directly and through
MoneyForward, and the same instrument held at different brokers, with explicit
evidence. Preserve different products with similar names and unresolved
references. Expose the existing correction history in the review flow.

Source expansion remains part of this work: the inventory includes further
payments, banks, overseas accounts and reward programs. Complete representative
flows first, then extend them under the same contracts.

**Done when:** a user can request collection, follow it to published
observations, and distinguish resolved accounts/instruments from unresolved
ones for the selected scope. Missing data types remain visible.

Contracts: [collection](collection.md), [observations](observations.md),
[identity](identity.md), [source identities](identity-sources.md).

## Phases 6–7 — Reconciliation and economic event generation

Build on Vpass and MyJCB pending/posted matching, then add card statement/payment
matching, bank transfers and securities transactions. Continuously generate
corrigible events from adopted source observations; event tables and matching
functions alone do not complete this stage.

| Transaction family                                 | Meaning to establish                                                    |
| -------------------------------------------------- | ----------------------------------------------------------------------- |
| Pending → posted, cancellation, partial refund     | Revision of one purchase versus a separate transaction                  |
| Card purchase → statement → bank debit             | Purchase recognition versus settlement, without double counting         |
| Transfers between owned accounts                   | Internal movement versus external spending                              |
| FX and overseas transfers                          | Changes per currency, explicit fees and unexplained differences         |
| Securities orders, executions, settlement and cash | Quantity changes linked to the relevant cash movement                   |
| Reward exchanges and stored-value funding          | Request, deduction, arrival, cancellation and return as separate stages |

Limit: only the card purchase and card settlement rows have an event writer
today. No event is written for bank or stored-value movements, transfers, FX, remittances,
securities, crypto, reward exchanges or stored-value funding; the
transaction-family registry states, per parser, which family its rows belong to
and the closed reasons no event is written
([economic events](economic-events.md#non-card-families-unsupported-today),
[ADR 0053](adr/0053-transaction-family-registry.md)).

Connect candidate review, acceptance, rejection and correction to guarded
commands and the UI. Amount/date proximity stays a proposal; provider evidence
or an explicit recorded decision establishes adoption. Preserve explanation
links through events, allocations and source facts to original statements.

**Done when:** for a card purchase, a user can identify its statement and bank
payment, inspect the original evidence, and correct a mistaken match without
erasing the earlier decision. The resulting purchase and cash-movement views
must account for the same case without treating settlement as another expense.

Contracts: [economic events](economic-events.md),
[decision log](decision-log.md), [change lifecycle](change-lifecycle.md).

## Phases 8 + 11 — Dated reported and reconstructed state

Maintain two distinct views: what a provider reported at a point in time, and
what adopted events imply from a starting snapshot. Extend reported state to
security/crypto quantities, provider valuations, card payables and other
liabilities.

Apply events to reconstruct balances and positions. Preserve transaction and
settlement dates, pending and posted states, late-arriving evidence and missing
history. Differences against provider snapshots are explained discrepancies,
never invented adjustment transactions. Show historical holdings and changes
between dates; incomplete account or liability coverage must remain a scoped
result rather than a whole-portfolio net worth.

**First slice (P2-1, [ADR 0019](adr/0019-dated-reported-state.md)):**
[reported state on a date](reported-state.md) lists, per account, the latest
complete capture before the end of the date (positions with provider
valuations, balances with their registry metric, freshness), and the
Vpass/MyJCB statements due around it with their settlement status, naming
containers without a capture and the liabilities it does not cover. Nothing is
added or converted. Not yet: adoption across sources, identity as of the date,
unbilled usage, installments and loans, and reconstruction from events.

**Done when:** for a requested date, quantities and liabilities in the supported
scope are available, with discrepancies traced to transactions, timing or
missing evidence. Unknown causes remain explicitly unresolved.

Contracts: [balance READ](balance-read-model.md), [economic events](economic-events.md),
[fixed projection inputs](projection-input.md).

## Phases 9 + 13 — Market data and portfolio valuation

Acquire and retain price/FX history, link it to instruments, and choose prices
under explicit as-of, freshness, holiday and missing-data policies. Distinguish
provider-reported valuations from Kogane calculations.

Start with supported cash, deposits, equities, funds and crypto. Product-specific
valuation needs must not be forced through quantity × price. Fix the holdings,
prices, FX, policies and calculation version used by each retained result.
Reported holding snapshots allow this stage to progress even where complete
transaction history is unavailable.

**Done when:** a user can value the supported holdings on a specified date in a
chosen base currency, inspect the prices/FX used, reproduce the result, and see
the unvalued portion and its reasons.

Contract: [calculation policies and reports](calculation-and-reports.md).

## Phase 10 — Usable reward forecasts and conversion simulation

Run this alongside the main financial sequence. Collect regular, promotional,
restricted-use and pending buckets, qualifying activity and membership state.
Version the applicable terms with evidence and effective dates. Keep
provider-displayed expiry separate from calculated expiry, and preserve unknown
activity classification or rules.

Populate verified offers with ratio, minimum, increment, cap, membership
conditions, application deadline, arrival delay and fees. Simulate routes that
meet a requested use and deadline, respecting shared quotas and availability.

**Done when:** actual holdings show near-term expiry and unknown expiry
separately, and eligible conversion candidates explain expected quantities,
timing and conditions. Executing a real exchange is outside this milestone.

Contract: [rewards](rewards.md).

## Phases 12 + 14 — Lots, cost basis and P&L

Implement acquisition and disposal history, additional purchases, partial
sales, transfers, fees and supported corporate actions such as splits. Carry
cost across owned accounts; an absent acquisition history is unknown cost,
never zero.

Allocate cost to disposals under a selected method, calculate realized and
remaining unrealized P&L, then separate market change, FX, income and fees.
Investment-analysis cost/P&L and tax recognition use shared events but distinct,
explicit purposes and policies.

**Done when:** a disposal can be traced to its acquisitions, quantity, allocated
cost, fees, FX and gain/loss; period results distinguish external cash flows
from investment performance. Missing cost history prevents an exact result.

Contract: [calculation policies and reports](calculation-and-reports.md).

## Phase 15 — Jurisdiction- and period-specific tax outputs

Begin with one jurisdiction, tax period and asset/account class. Add verified
rules, required inputs, calculation traces, independent reference examples and
export together. JP/AU support remains a goal, not a present capability of the
policy gate. Do not turn an investment P&L export into an implied tax result.

Freeze each output with its inputs and rule versions. Corrections or new rules
produce a new report that can be compared with the previous one.

**Done when:** a report names its supported scope, traces results to events and
applied rules, identifies missing information and passes independent expected
examples for that scope.

Contracts: [calculation policies and reports](calculation-and-reports.md),
[design](design.md).

## Phase 16 and product UI — Deliver with every stage

Use the same application services and results for UI and AI/MCP. Match review
comes with reconciliation; valuation explanation comes with valuation; expiry
and offer comparison come with rewards. Do not build separate AI arithmetic.
AI mappings/classifications remain proposals with evidence and model/version
information, and humans can correct them.

Before granting a real agent access, verify authorization across queries,
evidence, explanations, proposals and their human confirmation paths, including
scope restrictions. This is the entry gate to agent use, not a substitute for
the financial work above.

**Done for each feature when:** the supported flow can begin in UI or MCP and
reach its result, evidence, missing-input explanation and applicable correction
or confirmation. A stored row or HTTP 200 alone is insufficient.

Contracts: [agent API](agent-api.md), [operations API](ops-api.md),
[frontend](frontend.md), [website data boundaries](website-data-boundaries.md).

## Completed infrastructure guard — Rollback compatibility

The trusted [deployment workflow](../.github/workflows/_deploy-workers.yml)
checks the production compatibility floor introduced by #207 before target
code is checked out, production credentials are used or a Worker is uploaded. It applies
both to releases and to every rollback subset. An ancestor predating the
CORE/ingestion and public-demo retirements cannot pass by carrying its own
older workflow; [guard tests](../tasks/_lib/rollback-floor.test.ts) cover the
floor, compatible descendants and incompatible targets.

This guard is implemented. Future incompatible resource retirements must
advance the floor and its tests. A code rollback still does not undo database
migrations, stored evidence or recorded decisions
([rollout](rollout.md), [legacy retirement](legacy-retirement.md)).

## Historical MVP boundary

The original MVP was capture → raw evidence → typed observations, with an
operator evidence browser. It intentionally excluded financial analysis and
product UI. That boundary describes the initial delivery, not the remaining
scope of Kogane. The evidence-before-schema principle still applies when
onboarding a new source, but repeating the initial infrastructure build is not
the next roadmap objective.
