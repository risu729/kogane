# Roadmap

**The infrastructure migration is complete; the financial product roadmap is
not.** The next objective is to turn collected provider displays into connected
transactions, explainable assets and liabilities, valuations, and eventually
cost basis, P&L and tax outputs.

The code status was reviewed on 2026-11-06 against main `46246f3`. It distinguishes implemented
contracts and calculation components from a feature that works with real inputs
through its user interface. This is a repository assessment, not a new production
acceptance run. Dated production observations in the linked history describe those observations,
not a fresh measurement of the deployed system. Historical infrastructure
completion evidence belongs in [legacy retirement](legacy-retirement.md) and
the relevant rollout records.

## Work order

This section is the work order. Agents continue with the next unit of the
current phase after each merged PR, until the phase's done-when holds; then the
next phase. Issues track the individual items
([product backlog #541](https://github.com/risu729/kogane/issues/541),
[collector backlog #440](https://github.com/risu729/kogane/issues/440) and their
children); this section names which issues belong to which phase, and the issue
holds the progress. Plans in [plans/](plans/README.md) hold proposed slices.

The owner adopted these phases on 2026-11-06 (13:25 UTC) and said their order matters little: a thread may take a unit from a later phase when it does not depend on unfinished work.

### Phase 1 — Land or close the open work and re-baseline

On 2026-11-06 at 12:45 UTC, 45 pull requests were open: 32 agent PRs opened
that day (#922–#957), all with a green `CI Check`; 9 older PRs from agent sessions (Codex, Cursor and others) from
2026-10-04 to 2026-11-04 (8 of them drafts); and 4 Renovate PRs. 74 branches
existed. The [status page](current-status.md) was last reviewed on 2026-10-05.

Every merge to `main` releases to production through
[deploy.yml](../.github/workflows/deploy.yml), so landing this backlog is a
sequence of production releases, not only a review exercise.

**Done when:** every PR open on 2026-11-06 is merged after an independent
review, or closed with a comment giving the reason, or listed here as waiting
on a named owner decision; branches without an open PR (counting stacked base
branches as in use) are deleted; and [current status](current-status.md) and
this roadmap are re-reviewed against a stated `main` SHA.

The owner decided on 2026-11-06 (12:49 UTC) that this project's threads fix
and merge the `claude/adoring-faraday-…` PRs. That session keeps working on
other accounts but does not merge, and marks the PRs it is still changing as
drafts. A unit skips a PR while it is a draft. The owner also assigned the older PRs in unit 1i to this project's threads.

The units run in five threads: 1a with 1c; 1b with 1d; 1e with 1g; 1f; and 1h with 1i. Unit 1j follows them. Reviews run in parallel, but merges go through one
queue: 16 of these PRs touch `docs/current-status.md` and 14 touch
`docs/adr/README.md`, so each merge is followed by a rebase of the next PR on
the latest `main` and a fresh CI run.

| Unit                           | PRs                                                                     | Stacks and notes                                                                                                                         |
| ------------------------------ | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 1a Card flow                   | #935, #957, #924, #951                                                  | #935 adds ADR 0074; #957 changes the READ balance projection                                                                             |
| 1b Dated state                 | #944, #950, #953                                                        | #950 is stacked on #944 (ADR 0075); #953 adds an MCP read (owner list in AGENTS.md)                                                      |
| 1c Rewards                     | #937, #940                                                              | #940 is stacked on #937                                                                                                                  |
| 1d Identity and instruments    | #936, #946, #948, #949                                                  | #946 is stacked on #936; #946 and #949 add MCP reads; ADRs 0073, 0076, 0077                                                              |
| 1e App and Processor hardening | #933, #939, #934, #945, #947, #954                                      | #939 is stacked on #933                                                                                                                  |
| 1f Web, audit and reports      | #923, #925, #926, #927, #928, #942, #929                                | #942 is stacked on #928 (ADR 0072 and its amendment)                                                                                     |
| 1g Tests and tooling           | #938, #943, #952, #956                                                  |                                                                                                                                          |
| 1h Renovate                    | #822, #856, #932, #960                                                  | #856 and #932 change `.github/workflows/` and need the owner; #960 has native auto-merge on                                              |
| 1i Older PRs                   | #436, #580, #639, #648, #714, #729, #887, #914, #915                    | Decide per PR: finish, supersede or close. #436 (Container runtime) needs owner approval for a hosted run; #887 has a failing `CI Check` |
| 1j Status re-baseline          | #922, #955, then a fresh review of `current-status.md` and this roadmap | Runs last, after the other units                                                                                                         |

**Outcome (2026-11-06, 23:10 UTC, main `46246f3`):** of the 45 PRs, 37 were
merged after an independent review and a green `CI Check`, and 8 were closed with
a comment giving the reason:

- [#639](https://github.com/risu729/kogane/pull/639), [#729](https://github.com/risu729/kogane/pull/729),
  [#856](https://github.com/risu729/kogane/pull/856) and [#914](https://github.com/risu729/kogane/pull/914)
  were superseded by [#968](https://github.com/risu729/kogane/pull/968),
  [#966](https://github.com/risu729/kogane/pull/966), [#976](https://github.com/risu729/kogane/pull/976)
  and [#995](https://github.com/risu729/kogane/pull/995), which re-landed them on the current `main`.
- [#580](https://github.com/risu729/kogane/pull/580), [#648](https://github.com/risu729/kogane/pull/648)
  and [#887](https://github.com/risu729/kogane/pull/887) were stale snapshots. Most of their still-true content is in
  [#922](https://github.com/risu729/kogane/pull/922). The three items still missing from `main`
  landed after this outcome, on 2026-11-06 and 2026-11-07: the MCP recovery runbook from #887 in
  [#998](https://github.com/risu729/kogane/pull/998); and, from #580, the synthetic
  preview's empty state (表示対象の記録がありません) on financial routes in
  [#999](https://github.com/risu729/kogane/pull/999) and the Docker daemon that Container
  identity checks need as an AGENTS.md rule in
  [#1000](https://github.com/risu729/kogane/pull/1000).
- [#436](https://github.com/risu729/kogane/pull/436) (Container runtime) is closed at the
  owner's request and tracked in [#988](https://github.com/risu729/kogane/issues/988); the
  owner decides near 2026-12-31 whether to resume it.

[Current status](current-status.md) was re-reviewed against `main` in #922 and in this
re-baseline. Phase 1 is done except branch cleanup: cloud sessions cannot delete
branches, so 28 branches without an open PR remain for the daily cleanup or the owner. The
29th, `refactor/container-direct-api` (#436), is kept on purpose.
PRs opened after 12:45 UTC, including the re-landed ones above, are ordinary work in the phase they belong
to, not Phase 1.

### Phase 2 — Card usage → statement → bank debit

**Status:** done on 2026-11-08 ([outcome](#phase-2-outcome)).

Issues: [#543](https://github.com/risu729/kogane/issues/543),
[#547](https://github.com/risu729/kogane/issues/547),
[#548](https://github.com/risu729/kogane/issues/548); sources
[#445 Vpass](https://github.com/risu729/kogane/issues/445),
[#444 MyJCB](https://github.com/risu729/kogane/issues/444).

This puts the card flow before the rest of coverage and identity (Phase 3),
unlike the order in [#541](https://github.com/risu729/kogane/issues/541) and
the delivery-order diagram below. It followed Phase 1. Phase 2
includes the parts of [#542](https://github.com/risu729/kogane/issues/542) and
[#545](https://github.com/risu729/kogane/issues/545) the card flow needs: the
card and its debit bank account resolved to the owner's accounts, and coverage
of the card's statements and the bank's debits.

**Done when:** for one Vpass card and one MyJCB card in production, each with a
debit from SMBC or SBI Shinsei, a user can
open its statement and bank debit, inspect the original evidence and correct a
wrong match without erasing the earlier decision, and the purchase and
cash-movement views count the case once. Installments, revolving, bonus
payments, partial payments and refund allocation are either supported or shown
as unsupported with a closed reason
([acceptance criteria, layers 6–7](#layers-67--reconciliation-and-economic-event-generation)).

The [Phase 2 plan](plans/2026-11-phase2-card-flow.md) (accepted 2026-11-07, 03:58 UTC) holds
the units and the production baseline of 2026-11-06: candidates exist for Vpass → SMBC,
Vpass → SBI Shinsei and MyJCB → SMBC statements, none was ever decided, and recorded
ownership was the only blocker. On 2026-11-07 the owner decided that an account with no
recorded owner is assumed to be the owner's, and that settlement decisions are delegated
to agents through MCP over the same API as the screens
([plan, section 4](plans/2026-11-phase2-card-flow.md#4-owner-decisions-2026-11-07)).
Since [ADR 0084](adr/0084-mcp-operator-authority-without-delegation.md)
(2026-11-07) no delegation entry or grant is needed: an MCP client the MCP Access
application admits acts with the UI's authority, as itself. Both decisions were first exercised
in production on 2026-11-07, 16:48 to 17:07 UTC: an MCP client recorded the owner default on the
ten accounts the candidates name and accepted one MyJCB and one Vpass settlement (both SMBC
debits), withdrawing one Vpass acceptance on the way; purchase totals did not change and only
the accepted debits hold a cash-movement claim
([verification](card-settlements.md#first-production-decisions-2026-11-07)). On 2026-11-08
the cash-movement view itself was read through `kogane.events.read` (#1094): it lists each
accepted settlement's debit once and the withdrawn one not at all.

<a id="phase-2-outcome"></a>**Outcome (2026-11-08, main `76a01e1`):** the done-when holds, so Phase 3 is the
current milestone. The settlement half is the production run above. For the second sentence,
none of the five shapes is supported, and none is detected by name: each is kept out of the
figures under a closed reason for the condition the code cannot handle, on the screens and over
MCP. [#547](https://github.com/risu729/kogane/issues/547) and
[#548](https://github.com/risu729/kogane/issues/548) stay open for supporting them.

- **Installments, revolving and bonus payments** (purchase side): `/purchases` and
  `kogane.purchases.explain` count the current rows no event holds per source and closed
  reason (`unrecognizedReasons`, [#1020](https://github.com/risu729/kogane/pull/1020)). A row
  whose payment type is not the observed single payment is `payment_type_unsupported`: on
  Vpass any code other than the single-payment one (blank and unknown codes included), on
  MyJCB a cell such as 分割, リボ, ボーナス or N回払 with N≠1
  ([ADR 0004](adr/0004-payment-type-shapes-from-evidence.md)). A MyJCB row that reads as
  1回払 but whose usage and payment amounts differ or do not parse is
  `installment_amount_differs` or `payment_split_unknown`. A row reports the first check it
  fails, so an earlier reason (for example `amount_not_exact`) can hide its payment type.
- **Partial payments** (statement side): a statement no single equal debit pays is listed
  under `照合候補のない請求` on `カード照合` and by `kogane.card-settlements.unmatched`, as
  `no_equal_amount_debit` with the ADR 0074 planner's `unsupported` / `no_exact_allocation`
  (with `in_window_debits_below_total` or `debit_above_total` when the window's sum is below
  the total or one debit exceeds it), or as `no_debit_in_window` when no debit falls within
  three days of the due date. A multi-debit allocation is listed but not acceptable.
- **Refund allocation**: a statement with a zero or negative total is
  `statement_total_refund_or_zero` on the same list; on `/purchases` a refund is summed apart
  with `refundsAllocated: false`, and planning `card-refund.allocate` is refused
  `unsupported_semantics`.

Production on 2026-11-08 (01:50 UTC), read through the MCP Portal:
`kogane.card-settlements.unmatched` lists eight statements without a candidate: five Vpass
statements with a zero total (`statement_total_refund_or_zero`), one Vpass statement whose
four window debits have no exact combination of up to three (`no_equal_amount_debit`, planner
`unsupported` / `no_exact_allocation` alone) and two MyJCB statements whose due-date window
holds no bank debit (`no_debit_in_window`). `kogane.purchases.explain` reports 6 current
provider rows no event holds, all Vpass `amount_not_exact`, with `complete: true`; no current
row's first failing check is the payment type, so the installment, revolving and bonus codes
are exercised by the synthetic tests only.

Left open, outside the done-when: the `カード照合` page's grouped read
(`/api/v2/reconciliation/card-settlements/statements`) has no MCP read yet (it is on the
parity guard's `READ_ROUTE_GAPS`; `kogane.card-settlements.read` returns the same candidates
ungrouped). [#1088](https://github.com/risu729/kogane/pull/1088) adds it and waits on the
owner's approval of its catalogue entry. The production run corrected a wrong match by
withdrawing it and accepting another statement's candidate; the withdrawn statement's next
candidate is still undecided.

### Phase 3 — Coverage, collection requests and cross-source identity

**Status:** current milestone since 2026-11-08.

Issues: [#542](https://github.com/risu729/kogane/issues/542),
[#545](https://github.com/risu729/kogane/issues/545), the per-source issues
under [#440](https://github.com/risu729/kogane/issues/440) for sources already
collected (#441–#454).

**Done when:** the layers 0–5 criteria hold for the owner's accounts in scope:
collection can be requested and followed to published observations in
production, coverage is visible per account and data type, and resolved and
unresolved accounts and instruments are distinguished. New collectors
(#455–#510) are not part of this phase.

### Phase 4 — Non-card events and dated state

Issues: [#549](https://github.com/risu729/kogane/issues/549),
[#550](https://github.com/risu729/kogane/issues/550),
[#551](https://github.com/risu729/kogane/issues/551).

**Done when:** the layers 8 + 11 criteria hold: bank transfers between owned
accounts and securities executions produce events from adopted observations,
and balances and quantities on a date are reconstructed with discrepancies
traced or left explicitly unresolved.

### Phase 5 — Market data and valuation

Issues: [#552](https://github.com/risu729/kogane/issues/552),
[#553](https://github.com/risu729/kogane/issues/553).

**Done when:** the layers 9 + 13 criteria hold for supported holdings, with an
owner-decided price/FX selection policy
([ADR 0056](adr/0056-as-of-price-fx-selection.md) leaves the values open).

### Phase 6 — Lots, cost basis and P&L

Issues: [#556](https://github.com/risu729/kogane/issues/556),
[#557](https://github.com/risu729/kogane/issues/557).

**Done when:** the layers 12 + 14 criteria hold.

### Phase 7 — Tax for one jurisdiction, period and asset class

Issue: [#558](https://github.com/risu729/kogane/issues/558). The owner names the
first scope before this phase starts.

**Done when:** the layer 15 criteria hold for that scope.

### Parallel track R — Rewards

Issues: [#554](https://github.com/risu729/kogane/issues/554),
[#555](https://github.com/risu729/kogane/issues/555) and reward-program
collectors. Runs alongside Phases 2–7 when a thread is free; done when the
layer 10 criteria hold.

### Parallel track A — AI/MCP, maintenance windows and UI

Issues: [#559](https://github.com/risu729/kogane/issues/559),
[#560](https://github.com/risu729/kogane/issues/560),
[#561](https://github.com/risu729/kogane/issues/561). Each phase's feature is
done only when it also works from the UI and MCP (layer 16 criteria).
Grants (`AGENT_GRANTS`, `OPERATOR_SUBJECTS`), Access policies and secrets are owner
decisions and never part of an agent PR; there is no delegation table and no agent read
grant table since [ADR 0084](adr/0084-mcp-operator-authority-without-delegation.md).
Every screen operation also exists as an MCP operation over the same
application service ([ADR 0081](adr/0081-ui-parity-through-mcp.md)). The
inventory and its guard tests landed on 2026-11-07 with allow-lists of the
known gaps ([agent API: parity guards](agent-api.md#ui-and-mcp-parity-guards-adr-0081-2026-11-07));
each later unit of this track closes gaps and shrinks those lists.

### New sources

New collectors (#455–#510) start only when the owner asks, or after Phase 3.

## Current position

| Original phases                         | Implemented foundation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Work still needed for product completion                                                                                             |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 0–3: collection, evidence, observations | Source collectors, shared raw evidence, versioned parsing and publication; operations-API collection requests executed through the named collector RPC and traced to publication                                                                                                                                                                                                                                                                                                                                 | Coverage by account and data type; enabling and verifying request dispatch in production, requested windows, READ projection tracing |
| 4–5: accounts and instruments           | Provider-local identities, mappings and append-only corrections; instrument candidates on a page and an agent read, decided through the change lifecycle except SBI's bare domestic code onto its listing, adopted by rule `instrument-auto-v1`; per-source counts of their states ([ADR 0055](adr/0055-instrument-candidates.md), [0073](adr/0073-instrument-coverage-per-source.md)); aggregator-to-direct account containment candidates the same way ([ADR 0077](adr/0077-account-connection-candidates.md)) | Evidence-backed resolution across direct providers, aggregators and brokers; review of unresolved identities                         |
| 6–7: reconciliation and economic events | Candidate matching, decisions, event/leg/allocation/obligation/settlement contracts; own-transfer proposals and unregistered planners, nothing adopts ([ADR 0057](adr/0057-own-transfer-proposals.md))                                                                                                                                                                                                                                                                                                           | More transaction families and continuous event production from adopted observations                                                  |
| 8: reported state snapshots             | Adopted balance measurements, overlap handling and READ snapshots; reported state on a date (positions, provider valuations, balances, card payables); reported holdings changes between two dates, served by a route and a panel of the `/state` page ([ADR 0075](adr/0075-reported-holdings-change-between-dates.md))                                                                                                                                                                                          | Adoption across sources on a date, dated identity, liabilities beyond provider statements                                            |
| 9 + 13: prices and valuation            | Price contracts, pure valuation functions, fixed report artifacts with a list route and a read-only page ([ADR 0072](adr/0072-report-artifact-pages.md)); as-of price/FX selection under explicit policies (values not yet decided)                                                                                                                                                                                                                                                                              | Price/FX acquisition, owner-decided selection policy values and portfolio valuation from actual holdings                             |
| 10: rewards                             | Bucket claims, expiry and conversion functions, READ projections with displayed and computed expiry apart and their basis                                                                                                                                                                                                                                                                                                                                                                                        | Classified activity history, verified applicable rules, membership and usable conversion offers                                      |
| 11: derived balances and positions      | Difference contracts and reconciliation readers; a pure fold from a start snapshot and adopted events, a commit-log knowledge selector, a one-account query, its route, agent tool, page ([ADR 0052](adr/0052-reconstructed-state-fold.md), [ADR 0058](adr/0058-knowledge-selector-and-reconstruction-adapter.md))                                                                                                                                                                                               | Applying adopted events to a starting snapshot to reconstruct balances and quantities                                                |
| 12 + 14: cost basis and P&L             | Input gates, some P&L decomposition functions, a pure lot/disposal-allocation engine over provisional inputs, and an adapter from selected revisions that answers unsupported until a securities writer exists ([ADR 0059](adr/0059-lot-adapter-from-selected-revisions.md))                                                                                                                                                                                                                                     | A securities writer, transfers with carried cost, fee and FX evidence, persisted results, realized and unrealized P&L                |
| 15: tax                                 | Refusal when required policy or inputs are missing                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Verified rules and tested outputs for a named jurisdiction, period and asset/account class                                           |
| 16: AI / MCP                            | Shared query/explanation/proposal service and transports; scoped audit, instrument-history, instrument-coverage, account-candidate, economic-readiness and dated reported-state reads; MCP operations applied by any MCP client Access admits, as itself ([ADR 0063](adr/0063-delegated-ai-operation-path.md), [ADR 0084](adr/0084-mcp-operator-authority-without-delegation.md))                                                                                                                                | Complete analysis and correction flows using the same services as the UI                                                             |

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

**The current milestone is [Phase 3](#phase-3--coverage-collection-requests-and-cross-source-identity):
coverage, collection requests and cross-source identity.** [Phase 2](#phase-2--card-usage--statement--bank-debit),
card usage → statement → bank debit without counting an expense twice, was
done on 2026-11-08 for the representative cases. The first statement/debit review
slice is implemented, and so is the first purchase-event writer for supported
single-payment card usage (on in production since 2026-09-24), and so is the
pending-to-posted link review: the purchases page lists the open candidates
and reviews each purchase's link (accept, reject, withdraw) through the change
lifecycle. Statements without a settlement candidate are listed on
`カード照合` (and to agents through `kogane.card-settlements.unmatched`) with
a closed reason, refund and zero totals under their own code, and the ADR 0074
planner's read-only answer for statements whose window holds no equal debit
([card settlements](card-settlements.md#statements-without-a-candidate)); a
multi-debit allocation is shown but cannot be accepted. Source ownership is
recorded by the owner default (ADR 0082) for the accounts the candidates name.
Installments, revolving and bonus payments, partial payments and refund
allocation are shown as unsupported with closed reasons and still need support
([#547](https://github.com/risu729/kogane/issues/547), [#548](https://github.com/risu729/kogane/issues/548));
bank coverage beyond the current adapters still needs completion.
Securities executions, settlement, holdings and valuation follow that flow.

The [2026-09 next-milestone plan](plans/2026-09-next-milestone.md) is a
partially superseded proposal. Its remaining suggestions require a decision;
its migration numbers and in-flight PR list are historical, not current work
instructions. This roadmap records the current delivery order. The design decisions of 2026-09-24..26 behind
the card slice and the processor and identity work around it are recorded as
architecture decision records,
[ADR 0002](adr/0002-card-purchase-recognition.md) to
[ADR 0013](adr/0013-agent-card-purchase-read.md).

## Acceptance criteria by layer

The sections below keep the original layer identifiers (0–16), which are not
the roadmap phases above. They describe the remaining work and its acceptance
criteria per layer, not a requirement to finish each layer everywhere before
starting the next.

### Layers 0–5 — Coverage and cross-source identity

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

Collection timing depends on provider maintenance windows. The official-site
re-survey only proposes window changes for an operator to accept
([ADR 0050](adr/0050-maintenance-survey-proposals.md)); no page is enabled
until the owner confirms its URL, terms and cadence, so the windows are still
refreshed by hand, and pages that are PDFs, need a login or render with
JavaScript stay manual ([schedules](schedules.md#official-site-re-survey)).

Source expansion remains part of this work: the inventory includes further
payments, banks, overseas accounts and reward programs. Complete representative
flows first, then extend them under the same contracts.

**Done when:** a user can request collection, follow it to published
observations, and distinguish resolved accounts/instruments from unresolved
ones for the selected scope. Missing data types remain visible.

Today `/identities` shows, per source (or for the selected source), the
account mapping status of eligible observations and how many security, crypto
and product identifiers are resolved by a person's decision or by rule
`instrument-auto-v1`, wait on a candidate, share an instrument without a
recorded decision, were kept apart
or have no candidate
([ADR 0073](adr/0073-instrument-coverage-per-source.md)). These are counts of
identifiers, not a match rate; money and reward units have no resolution
state, and a candidate across providers needs a second source whose identity
rule records comparable identifiers.

Contracts: [collection](collection.md), [observations](observations.md),
[identity](identity.md), [source identities](identity-sources.md).

### Layers 6–7 — Reconciliation and economic event generation

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

### Layers 8 + 11 — Dated reported and reconstructed state

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

**Since then:** [reconstructed state](reconstructed-state.md)
([ADR 0052](adr/0052-reconstructed-state-fold.md),
[ADR 0058](adr/0058-knowledge-selector-and-reconstruction-adapter.md)) folds
one account's adopted events from a start snapshot on the cash basis and sets
the difference against the provider's end balance beside it, explained or
`difference_unexplained`, never an adjustment; it is served by a route, an
agent read and a page. [Holdings changes between two dates](reported-state.md#holdings-changes-between-two-dates)
([ADR 0075](adr/0075-reported-holdings-change-between-dates.md)) compare the
reported holdings of two dates per provider holding key, with the exact
change where both dates list a holding and a reason where a capture is
missing or ambiguous; nothing is totalled, and it is served by a route and a
panel of the `/state` page, without an agent tool. Still open: positions folded from events (no
securities writer), several accounts at once, and the scoped net worth of
#551.

**Done when:** for a requested date, quantities and liabilities in the supported
scope are available, with discrepancies traced to transactions, timing or
missing evidence. Unknown causes remain explicitly unresolved.

Contracts: [balance READ](balance-read-model.md), [economic events](economic-events.md),
[fixed projection inputs](projection-input.md).

### Layers 9 + 13 — Market data and portfolio valuation

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

### Layer 10 — Usable reward forecasts and conversion simulation

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

### Layers 12 + 14 — Lots, cost basis and P&L

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

### Layer 15 — Jurisdiction- and period-specific tax outputs

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

### Layer 16 and product UI — Deliver with every stage

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
