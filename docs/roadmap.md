# Roadmap

**The infrastructure migration is complete; the financial product roadmap is
not.** The next objective is to turn collected provider displays into connected
transactions, explainable assets and liabilities, valuations, and eventually
cost basis, P&L and tax outputs.

This status was updated with the card purchase recognition slice on 2026-09-24.
It distinguishes implemented contracts and calculation components from a feature
that works with real inputs through its user interface. It is a repository
assessment, not a new production acceptance run. Historical infrastructure
completion evidence belongs in [legacy retirement](legacy-retirement.md) and
the relevant rollout records.

## Current position

| Original phases                         | Implemented foundation                                                                                                                                | Work still needed for product completion                                                                     |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 0–3: collection, evidence, observations | Source collectors, shared raw evidence, versioned parsing and publication                                                                             | Coverage by account and data type; collection requests connected to execution and visible results            |
| 4–5: accounts and instruments           | Provider-local identities, mappings and append-only corrections                                                                                       | Evidence-backed resolution across direct providers, aggregators and brokers; review of unresolved identities |
| 6–7: reconciliation and economic events | Candidate matching, decisions, event/leg/allocation/obligation/settlement contracts                                                                   | More transaction families and continuous event production from adopted observations                          |
| 8: reported state snapshots             | Adopted balance measurements, overlap handling and READ snapshots; reported state on a date (positions, provider valuations, balances, card payables) | Adoption across sources on a date, dated identity, liabilities beyond provider statements                    |
| 9 + 13: prices and valuation            | Price contracts, pure valuation functions and fixed report artifacts                                                                                  | Price/FX acquisition, selection policies and portfolio valuation from actual holdings                        |
| 10: rewards                             | Bucket claims, expiry and conversion functions, READ projections                                                                                      | Classified activity history, verified applicable rules, membership and usable conversion offers              |
| 11: derived balances and positions      | Difference contracts and reconciliation readers                                                                                                       | Applying adopted events to a starting snapshot to reconstruct balances and quantities                        |
| 12 + 14: cost basis and P&L             | Input gates and some P&L decomposition functions                                                                                                      | Lots, carried cost, disposal allocation, realized and unrealized P&L                                         |
| 15: tax                                 | Refusal when required policy or inputs are missing                                                                                                    | Verified rules and tested outputs for a named jurisdiction, period and asset/account class                   |
| 16: AI / MCP                            | Shared query/explanation/proposal service and transports                                                                                              | Complete analysis and correction flows using the same services as the UI                                     |

Concrete limits in the current code:

- **Shared-R2 registration, 2026-09-12 onwards.** From U09 (#184) until the
  fixes below, no shared-R2 run of any source but Mizuho was catalogued into
  sealed, parseable evidence. Four blockers were found on 2026-09-26: the
  producer a collector names differs from its route's for eight terminal
  sources (fixed by #259, [ADR 0014](adr/0014-collector-producer-ids.md)); derived artifacts without stated
  lineage (`artifact_lineage_unstated`: sbi-securities, sbi-shinsei, MyJCB,
  V Point, V Point Pay) and run manifests that named a unit without being
  counted in it (`run_inventory_incomplete` at the seal: sbi-vc-trade, GLOBAL
  PASS, SMBC Direct), both fixed in the collectors by
  [ADR 0021](adr/0021-collector-registration-contract.md), which also fixed
  Vpass statement pages (a provider role with a `redacted` step, refused at
  the seal) and V Point Pay month ranges; and registered artifacts with no
  `dataset` (fixed by #269, [ADR 0022](adr/0022-registration-artifact-datasets.md),
  for the datasets a registered parser reads). Only terminals written after each
  collector's redeploy carry the fixed shapes. The terminals written before
  it are immutable: the 14 sbi-securities and 14 sbi-shinsei runs blocked
  since U09 (counted on 2026-09-26) stay blocked (a block is write-once), and
  re-registering them under a new registration contract version refuses the
  same bytes again: nothing makes them registrable. The 14 sbi-vc-trade runs
  keep their catalogued artifacts unsealed and are tried again whenever the
  scan reaches them, because a seal-trigger refusal is rethrown rather than
  classified as a block
  ([processor §3](processor.md#3-idempotency-and-what-blocks)); recording it as
  a block is a Processor follow-up.

- [Card settlement review](card-settlements.md) now connects authoritative
  Vpass/MyJCB statement totals to SMBC and SBI Shinsei bank debits
  ([bank adapters](card-settlements.md#bank-adapters)) through explicit
  operator decisions. Unknown ownership, stale evidence and occupied
  allocations block acceptance. Production holds no published SBI Shinsei
  transaction yet: 0.1.1 rejected every stored activity capture because the
  provider leaves the window's end empty. 0.1.2 accepts that shape and records
  the end as not stated
  ([ADR 0028](adr/0028-sbi-shinsei-observed-capture-shapes.md)); until the
  repair lane has re-parsed the stored captures after deploy, the adapter
  admits nothing. The SBI Shinsei exchange-rate board is parsed from 1.0.2
  (1.0.1 assumed digits where the stored time ends in two letters and matched
  no board; migration 0059), every `customerCategory` tier kept. A board
  row of the 13 currencies the provider's public pages quote per 1 unit is
  promoted only in the stage category the same run's balance summary states
  ([ADR 0031](adr/0031-sbi-shinsei-stage-category-fx-tier.md); the two were
  observed on 2026-09-27 to use one scheme). A board waits while its run's
  balance-summary parse can still run, and promotes nothing when that page is
  missing, refused or its job failed. A
  debit posted more than three days from the
  due date gets no candidate. Banks whose row ids are fingerprints (Mizuho,
  Sony Bank), partial payments, refunds and complete purchase recognition
  remain extensions; this is not complete event coverage. Which bank account
  a card debits is not configured anywhere: MyJCB's own statement of it (the
  「カード情報」 table: bank name, branch name, 科目 and the first four account
  digits) is read from stored pages into `card_debit_account_statement` and
  attached to MyJCB candidates as proposal-only evidence
  ([ADR 0032](adr/0032-provider-stated-debit-accounts.md), 2026-09-27
  amendment). Limits: the evidence is not shown on the review page yet;
  branch names are not compared (no bank reference carries one); SMBC's
  account reference carries no digits and SBI Shinsei's layout is unverified,
  so neither adapter bank can be matched; Mizuho is comparable but not an
  adapter; and no Vpass statement API carries a debit account (observed
  absent), so Vpass candidates keep amount and date only.
- Vpass and MyJCB pending-to-posted candidates come from the purchase lane's
  [candidate pass](economic-events.md#pending-to-posted-links), which pairs one
  recognised pending event with one posted event per purchase; every pair
  stays a candidate for review. Only a posted row dated on its pending row's
  usage day or up to five days after it is proposed
  ([matching window](economic-events.md#matching-stages)), and an installment
  payment amount is never compared with a purchase amount. A row the purchase
  lane does not recognise (an unsupported payment type, an amount that is not
  exact, an unresolved account) gets no candidate, a MyJCB pending and
  confirmed row whose usage days straddle a month end are not paired, and a
  refund is never paired with a purchase.
  [The reconciliation job](../services/processor/src/reconciliation-job.ts)
  runs stage A only for both sources since 2026-09-26: its stage B read every
  published capture, proposed one candidate per capture pair and skipped every
  statement month with more than 200 published rows
  ([where stage B runs](economic-events.md#matching-stages)). Stage A needs a
  provider-issued row id, which neither source supplies, so the lane reads its
  pages and proposes nothing until a source does. The collector records a
  confirmed MyJCB page by the payment month the page names, so a statement
  keeps its rows' keys while its position moves
  ([release note](observations.md#myjcb-statements-keep-their-identity-when-their-position-moves-collector-no-parser-release));
  pending pages keep the relative `detailMonth-N`, resolved from their
  capture time
  ([`relative-statement-period-v1`](observations.md#relative-period-labels-are-resolved-from-the-capture-time)).
  Limits: a confirmed capture stored under `detailMonth-2` or later (only
  before that fix) names no statement and is never current; the collector
  stops (`credit-statement-period`) on a confirmed page that names no month;
  a pending row and its posted row are still two keys, paired by review; and
  a pending statement's rows get new keys once when it moves from position 0
  to position 1. When both positions are unconfirmed (a closed cycle not yet
  confirmed), both pending statements are current, one slot each
  ([ADR 0016](adr/0016-myjcb-pending-statement-slots.md)).
- [Card purchase recognition](economic-events.md#card-purchase-recognition)
  turns adopted Vpass/MyJCB single-payment rows with an exact JPY amount and a
  trusted card identity into `purchase` and `refund` events, behind
  `PURCHASE_RECOGNITION_ENABLED` (on in production since 2026-09-24; existing
  rows are worked through in bounded five-minute ticks: at most 100 events
  retired and at most 200 guarded recognition writes, so at most 300 event
  mutations per tick, plus the candidate pass's one proposal batch and at most
  20 provider-linked merges). Installment, revolving and bonus rows, amountless
  rows and rows without a stable card identity are excluded, and so is every
  Vpass web payment-type code but `1` until an installment row shows what the
  others mean, and every Vpass customized `bunkatsuYaku` but `0` (the only
  value observed, a single payment on the owner's confirmation) until another
  value is observed and confirmed
  ([single payment, per source](economic-events.md#single-payment-per-source)).
  A pending row and its posted row can now be
  [linked as one purchase](economic-events.md#pending-to-posted-links) by a
  reviewed decision (or by the rule for a pair the provider itself links, which
  no deployed source does yet); candidates are proposed, never merged by
  amount and date. Excluding a row by decision and allocating a refund to a
  purchase are not available yet. The Vpass collector writes a trusted card
  binding with no secret: the token is the unkeyed `vpass-card-v2-` digest of
  the card tuple ([ADR 0029](adr/0029-data-classification-and-unkeyed-identity.md);
  the owner no longer sets a `VPASS_CARD_BINDING_KEY`, which is removed). It
  binds only if the provider's responses still carry the card tuple, which has
  not been observed since the importer was retired; without one, a parsed
  collector capture would retire the importer-era purchases of its card-month
  and its rows would be skipped as `account_not_resolved`. A card's v2 token
  is never its importer-era v1 token, so the two are different account
  entities until a reviewed crosswalk joins them. The collector's statement
  pages are registered without a parser dataset, so none is parsed today;
  releasing them is a later change, made once the v1 and v2 entities of each
  card are decided
  ([ADR 0023](adr/0023-vpass-collector-card-binding.md#amendment-option-3-implemented)).
- Money Forward ME collector runs derive their account identity with no
  secret: the unit key is the unkeyed `moneyforward-account-v2-` digest of
  the account/service tuple
  ([ADR 0029](adr/0029-data-classification-and-unkeyed-identity.md); the owner
  no longer sets a `MONEYFORWARD_ACCOUNT_IDENTITY_KEY`, which is removed). A
  run whose detail pages lack the tuple keeps positional units and every
  account page is `parser_rejected`, as all 52 account pages of the first
  shared-R2 run were before ADR 0027. The importer's v1 identities are never
  equal to the collector's v2 identities, so every collector account is a new
  source account and account entity, and the months both producers captured
  are listed under two source accounts in the transactions read until a
  reviewed crosswalk joins them. Whether the provider's detail pages still
  carry the tuple has not been observed since the importer was retired
  ([ADR 0027](adr/0027-moneyforward-collector-account-identity.md)).
- A Vpass card or MoneyForward account whose collector value differs from the
  importer's is a second account entity until the operator records a
  one-time crosswalk (`identity.crosswalk.accept`,
  [ADR 0030](adr/0030-identity-crosswalk.md)); a read-only script proposes
  them from rows both producers captured. Only a one-to-one overlap can be
  recorded: a card or account whose collector capture shares no stored row
  with the importer's, or shares rows with more than one value, stays split,
  and no command undoes a recorded crosswalk. It joins entities only: the
  MoneyForward months both producers captured are still listed twice in the
  transactions read, now under one entity. No collector Vpass row is parsed
  yet, so no Vpass crosswalk can be proposed until the statement pages are
  released. No proposal has been run against production.
- Vpass, MyJCB, Sony Bank, Money Forward ME, V Point (and its V Point Pay
  email route), V Point Pay and GLOBAL PASS had no registered collector run
  between 2026-09-12 and the release that carries
  [ADR 0014](adr/0014-collector-producer-ids.md): their collectors named a
  producer no route declares, so every terminal was refused as
  `inactive_ingest_route`. Terminals written before that release keep the old
  producer and stay unregistered in R2; for the snapshot sources the next
  capture shows the provider's state again, but V Point Pay notification
  emails of that period are registered only if a later decision registers
  those runs. The `collection_scan` walk no longer stops at a page of such
  terminals: it answers them from their recorded refusal and retries each at
  most once a day, where the refusal repeats
  ([ADR 0014, registration](adr/0014-collector-producer-ids.md#consequences),
  [ADR 0024](adr/0024-collection-scan-judged-terminals.md)).
  Past the route check, registration still stopped for three of them — a
  Vpass run's seal was refused (`run_inventory_incomplete`, a statement page
  was a `provider_response` with a `redacted` step), and MyJCB and V Point
  runs were blocked `artifact_lineage_unstated` — until the collectors
  changed with [ADR 0021](adr/0021-collector-registration-contract.md), for
  terminals written after that release. Those register with the parser
  datasets of [ADR 0022](adr/0022-registration-artifact-datasets.md), except
  that Vpass statement pages are withheld from one and MyJCB's runs written
  before [ADR 0026](adr/0026-collector-unit-coverage.md) are not eligible for
  parsing (below), so for Vpass, and for MyJCB until its first run after ADR
  0026, the importer's captures stay current
  ([ADR 0014, merge safety](adr/0014-collector-producer-ids.md#merge-safety)).
  Terminals written before ADR 0021 (collector-vpass, and the sbi-vc-trade,
  GLOBAL PASS and SMBC Direct runs whose units miscount their artifacts) are
  still refused at the seal. They used to throw and be attempted again on
  every walk; since the
  [ADR 0024 amendment](adr/0024-collection-scan-judged-terminals.md#amendment-2026-09-26-a-seal-core-refuses-is-a-verdict)
  each is blocked `run_inventory_incomplete` once, its fetch run stays
  unsealed and is named by the blocked stage, and the walk answers it from
  its row. Those terminals never register. Two limits remain: a row of an
  earlier contract version whose seal was refused before the amendment keeps
  no verdict (that version is never worked again), and the refusal is
  recognised by the D1 message Miniflare produces; production D1's message
  for it has not been observed, and another shape is rethrown and retried
  every walk as before.
  Once collector-vpass runs register and are parsed, the importer's Vpass
  purchase events of every re-captured card-month are retired and recognised
  again once, on the same account, where the collector's run carries a card
  binding, and not recognised again where it does not (ADR 0023). What a
  collector's successful unit declares decides whether its run registers as
  `success` or `partial`, and identity reads no partial run. The Vpass card
  unit is `complete` only when every month's captured rows equal the total
  the provider states for it, otherwise `partial` with a closed code, so a
  card binds only from such a run (ADR 0023); whether production finalized
  pages state that total has not been observed. The other collectors' units
  are ADR 0026's.
- Shared-R2 registration gives an artifact the parser dataset it needs since
  2026-09-26 ([ADR 0022](adr/0022-registration-artifact-datasets.md); before,
  every registered artifact had none, so only Mizuho's were parsed). The
  registration contract moved to `terminal-registration-v2`: runs sealed
  without a dataset (Mobile Suica since 2026-09-12) register again and are
  parsed once, while a run v2 does not change (Mizuho) is carried over rather
  than parsed a second time. Old terminals are reached only by the scan walk,
  so they drain as the scan cycles through `runs/`. Blocked runs are tried
  once more and block again where their terminal itself is refused. Vpass
  captures are withheld (above). MyJCB's metadata extractor reads the
  collector's shared manifest ([ADR 0025](adr/0025-myjcb-shared-manifest-metadata.md)).
  A MyJCB terminal written before [ADR 0026](adr/0026-collector-unit-coverage.md)
  is never parsed: it reports every unit's coverage as `partial`,
  registration turns that into a `partial` unit outcome, and a run with a
  non-success unit is `not_eligible` for parse jobs. Terminals are immutable
  and the eligibility rule is not loosened, so the confirmed statements of
  those days come back with the next successful run, while pending-only rows
  that disappeared before it are lost. GLOBAL PASS's successful runs are
  `partial` the same way and are not parsed: its collector stores only the
  first page of a month and follows no Next link, while a month with more
  than ten statements is observed to have a second page; such a month is
  marked `activity_pages_unwalked`. Walking the pages is not implemented. No
  GLOBAL PASS run has stored a page since at least the week before
  2026-09-27: the sanitizer refused every page, and still does
  (`globalpass_html_contract_invalid` every night since the code was
  recorded, ADR 0026's amendment of 2026-09-27). A refusal now also logs
  which expectation failed and a counts-only shape of the page
  ([ADR 0026 amendment of 2026-09-28](adr/0026-collector-unit-coverage.md#amendment-2026-09-28-global-pass-sanitizer-refusals-log-a-counts-only-shape));
  the next step is reading that shape from the next night's log and
  correcting the contract from it. A Vpass card run is `partial` the same
  way unless every month's captured rows equal the provider's stated total
  (ADR 0026's amendment). Both stated totals were seen on the live site
  (`allCnt` a string, `total` a number) and are read as exact counts, but the
  finalized walk still ends on its first empty page when `allCnt` or
  `nextPageRow` is unreadable, and the page-number fields (`pageNo`,
  `lastPage`) are not read because their meaning is unobserved
  ([ADR 0023's note](adr/0023-vpass-collector-card-binding.md#note-2026-09-27-both-stated-total-fields-are-on-the-live-site)).
  A MyJCB connection's `complete` unit rests on the same
  unobserved premise (one detail page holds its whole month), and a
  connection whose older month shows rows without a stated state is
  `partial` and its run is not parsed. A MyJCB connection that stops at a
  month keeps the months before it as a `partial` unit with a closed stop
  code ([ADR 0005's amendment](adr/0005-myjcb-statement-state-from-page.md#amendment-2026-09-27-a-stop-ends-the-connection-and-keeps-its-captured-months));
  those months are catalogued but not parsed, and no rule yet makes a
  stopped connection's months eligible. A MyJCB position whose ledger shows
  rows under the observed third header (`お支払日 / 今後のお支払い金額`, seen
  on the ショッピングスキップ払い schedule page) is kept unread
  (`scheduled_payments_page`): the connection goes on, but its run is
  `partial` and not parsed, because what those rows mean is unconfirmed
  ([ADR 0005's amendment (b)](adr/0005-myjcb-statement-state-from-page.md#amendment-2026-09-27-b-export-links-the-third-ledger-header-and-the-stop-page)).
  The collector reads the credit menu's headings: the two schedule pages
  (positions 7 and 8 of the surveyed connection, under
  「ボーナス#回払い・ショッピングスキップ払い」) are not months. They are
  stored and recorded in the manifest, and they do not make the unit
  `partial`, so a night with an outstanding skip payment parses its months;
  an unobserved menu heading stops the connection before its first month
  ([ADR 0005's amendment (c)](adr/0005-myjcb-statement-state-from-page.md#amendment-2026-09-27-c-the-menus-schedule-pages-are-not-months)).
  The ショッピングスキップ払い page, known by its h1, is stored as
  `credit-skip-payment-NN.html` and read by `myjcb-skip-payment-schedule`
  into `scheduled_payment_observations` (a payment still due, not a
  purchase); no read model, API or UI shows those rows yet, and they are not
  matched against statements or settlements. The bonus schedule page stays
  `credit-schedule-NN.html` and unread until it is observed with rows
  ([ADR 0005's amendment (e)](adr/0005-myjcb-statement-state-from-page.md#amendment-2026-09-27-e-the-skip-payment-schedule-page-is-read-as-scheduled-payments)).
  The nightly MyJCB runs of 2026-09-25 to 09-27 (UTC) stopped at position 1 on its ledger
  header (`credit-ledger-headers`): every confirmed page breaks its amount
  label with a `br` (`今回の<br>お支払い金額`), and the collector matched the
  label on space-joined text. It now compares labels with all whitespace
  removed, as the shared page reading already did
  ([ADR 0005's amendment (f)](adr/0005-myjcb-statement-state-from-page.md#amendment-2026-09-28-f-ledger-labels-match-across-line-breaks)).
  A `(確定分)` page under the 「ご利用金額」 header, which amendment (d) accepts
  when the page proves itself, was a misreading of the same `br` and has
  never been observed; that code is kept, unobserved, until the MyJCB
  parsers are next released. The empty skip-payment page reads as zero rows
  only when its one row is the provider's empty row; beside real rows it is
  refused. A later stop on a page's own shape now stores that page. The site's 「通信エラーが発生しました」
  page, served after many consecutive fetches, is not recognised; after the
  first month it would be kept as a month with no ledger. MyJCB export links
  are recorded, not fetched, because the shared bucket refuses the export
  datasets.
- [Collector operation dispatch](../services/processor/src/operations/dispatch.ts)
  leaves collector requests, including unattended session refresh, waiting with
  `awaiting_collector_dispatch`. An accepted request is not a completed capture.
- [`costBasis()`](../packages/domain/src/calculation.ts) returns
  `needs-policy` on every path. It is a contract and refusal gate, not a lot or
  cost-basis engine. `pnlDecomposition()` does not supply the missing transaction
  reconstruction and cost allocation.
- The [balance read model](balance-read-model.md) and
  [agent queries](agent-api.md) expose scoped quantities with unknown liability
  coverage, not a complete net-worth figure.
- [Price and report components](calculation-and-reports.md) do not fetch market
  prices or FX. [Reward components](rewards.md) still require activity
  classification and verified offer inputs before they can provide useful
  forecasts and exchanges for actual holdings.
- The [purchase explanation](card-settlements.md#purchase-explanation-chain)
  shows recognised Vpass/MyJCB purchases through their statement and bank
  debit to an operator, with captured, authorized, refund and unresolved
  figures kept apart. It is not a complete card history: excluded shapes and
  rows the recognition writer has not reached are only counted, a pending row
  and its posted row are separate events until a reviewed link merges them
  (the review screen exists: the purchases page lists the open candidates and
  reviews each purchase's link with accept, reject or withdraw through the
  change lifecycle), and no statement-versus-purchases difference is computed.
  An agent with a whole-store `records.read` grant reads the same page through
  [`kogane.purchases.explain`](agent-api.md#card-purchase-explanation), without
  the review actions; a grant scoped to some sources or accounts is refused
  because the page cannot yet be recomputed inside that scope.

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

The proposed plan for finishing this milestone and starting dated reported
state and valuation is [the next-milestone plan](plans/2026-09-next-milestone.md),
awaiting the owner's go-ahead. The design decisions of 2026-09-24..26 behind
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

## Small independent follow-up — Rollback compatibility

After [legacy retirement](legacy-retirement.md), releases depending on removed
Workers, buckets or CORE projections are invalid rollback targets. Add a
machine-enforced minimum compatible release/resource-schema check before upload;
migration filename/digest prefix compatibility alone does not establish this.

**Done when:** an incompatible pre-retirement target is rejected before any
Worker upload and a compatible target passes the gate. Keep this work bounded
and independent of the main financial milestone.

## Historical MVP boundary

The original MVP was capture → raw evidence → typed observations, with an
operator evidence browser. It intentionally excluded financial analysis and
product UI. That boundary describes the initial delivery, not the remaining
scope of Kogane. The evidence-before-schema principle still applies when
onboarding a new source, but repeating the initial infrastructure build is not
the next roadmap objective.
