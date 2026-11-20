# Reported state on a date

What each provider last reported, per account, on a date the owner chooses,
beside the card statements due around that date and the payments the card
company's skip-payment page still scheduled. This is phase 8's first
slice ([roadmap](roadmap.md#layers-8--11--dated-reported-and-reconstructed-state)),
decided in [ADR 0019](adr/0019-dated-reported-state.md). It is a list of
provider figures, never a total: nothing is added, converted or netted, and a
container without a capture is named, never shown as zero.

What adopted events imply from a start snapshot, compared with these figures,
is [reconstructed state](reconstructed-state.md) (served by `GET /api/v2/reconstructed-state`, an agent read and the `/reconstruction` page).

| Layer               | Where                                                                                                                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Snapshot CTE        | `SnapshotCteOptions.cutoffParam` in `packages/parsers/src/snapshot-query.ts`                                                                                                                   |
| SQL                 | `packages/read-model/src/dated-state.ts`                                                                                                                                                       |
| Policies            | `packages/domain/src/reported-state.ts` (cutoff, freshness, payable status, perimeter)                                                                                                         |
| Query               | `queryDatedState` in `packages/application/src/query/dated-state.ts`                                                                                                                           |
| HTTP                | `GET /api/v2/reported-state?date=YYYY-MM-DD` (`services/app/src/reported-state-api.ts`)                                                                                                        |
| Request rules       | `readReportedStateRequest` in `packages/application/src/query/reported-state-read.ts`, for the route and the tool                                                                              |
| Agent tool          | `kogane.reported-state.read` (`services/app/src/read-tools.ts`), the route's `readReportedState`                                                                                               |
| Contract            | `validReportedState` in `packages/observation-shared/src/reported-state-contract.ts`                                                                                                           |
| Page                | 基準日の保有状況 at `/state` (`apps/web/src/pages/ReportedState.tsx`), capability `reportedStateOnDate`                                                                                        |
| Two dates           | `queryHoldingsChange` in `packages/application/src/query/holdings-change.ts` ([below](#holdings-changes-between-two-dates))                                                                    |
| Two dates, HTTP     | `GET /api/v2/reported-holdings-change` (`services/app/src/reported-holdings-change-api.ts`)                                                                                                    |
| Two dates, summary  | `summarizeHoldingsChange` in `packages/domain/src/holdings-change-summary.ts` (the default `detail`), validated by `validReportedHoldingsChangeSummary`                                        |
| Two dates, agent    | `kogane.reported-holdings-change.read` (`services/app/src/page-read-tools.ts`), the route's `readHoldingsChange`                                                                               |
| Two dates, contract | `validReportedHoldingsChange` in `packages/observation-shared/src/reported-holdings-change-contract.ts`, with the request shape rule `holdingsChangeQueryRefusal` the route and the page apply |
| Two dates, page     | panel 保有数量の変化 on `/state` (`apps/web/src/pages/ReportedHoldingsChange.tsx`)                                                                                                             |

## The cutoff

The date `D` is a civil date in Asia/Tokyo. A capture belongs to it when it
was fetched before `(D+1) 00:00` Asia/Tokyo. `observation_fetch_artifacts.fetched_at`
stores every instant as UTC `%Y-%m-%dT%H:%M:%fZ`, so the cutoff is written in
that form (`2026-09-10` → `2026-09-10T15:00:00.000Z`, `reportedStateCutoff`)
and compared as text.

The snapshot is chosen by the same rules as the current state: the policy
table (`dataset_snapshot_policies`), coverage claims under `coverage-v1`, the
confined warning adapter under `legacy-warning-compat-v1`, published parses
and the run or unit scope. `snapshotCtes(relations, { cutoffParam: "?1" })`
adds two clauses and nothing else:

- a dataset snapshot (one fetch run's unit) is eligible only when its newest
  artifact is before the cutoff (`HAVING … AND MAX(fa.fetched_at) < ?1`), so a
  run that crossed midnight is never cut in half;
- an artifact container (Mizuho's account list) is eligible only when its
  artifact is before the cutoff.

Without `cutoffParam` the text is byte for byte what every current reader
composes (`packages/parsers/test/snapshot-cutoff.test.ts` pins the digests of
the shipped text). The parameter must be a `?N` reference; a value is refused.

Consequences the tests pin (`packages/read-model/test/dated-state.test.ts`):
a capture at 00:00 Tokyo on `D+1` is not in `D`; a partial run or a partial
`coverage-v1` claim is never chosen; a complete-empty capture is chosen and
holds nothing; a position absent from the chosen capture is not held, whatever
an older capture said.

## Perimeter

Listed (`dated-state-perimeter-v1`): every container in the snapshot policy
table with `snapshot_selection = 1` and the artifact containers
(`ARTIFACT_SNAPSHOT_CONTAINERS`), except the two aggregates below. Not listed,
and named in `coverage.excluded`:

| Scope                                    | Why                                                              |
| ---------------------------------------- | ---------------------------------------------------------------- |
| MoneyForward                             | An aggregator: it restates accounts the direct sources list      |
| `sbi-account-assets-current`             | A provider total over the accounts the other SBI containers list |
| `sony-bank-gross-balance`                | A provider total (assets and loans) over the Sony accounts       |
| Balances restated after each transaction | Registry `timeBasis: event-reported`; counted in `excludedRows`  |
| Reward units                             | Registry `unitDimension: reward`; counted in `excludedRows`      |

A perimeter container with no snapshot before the cutoff is listed in
`coverage.containersWithoutSnapshot` with `no_complete_snapshot_before_cutoff`.

## The answer

`queryDatedState(sql, { date, source?, account? })` returns:

- `snapshots`: every snapshot chosen for the date, a complete-empty one
  included, each with its capture time, the capture's Tokyo date, its age in
  days and its freshness under `dated-state-freshness-v1`: `same-day` (age 0),
  `recent` (1–3 days), `stale` (more).
- `accounts`: one per (source, provider account, resolved account), with the
  snapshots its rows came from, its resolved account and identity status (the
  current account mapping of its rows' identities, or `not-recorded`). A
  provider account whose rows map to two accounts (an identity can key a
  source account on more than the provider account, as SBI Securities'
  foreign positions do with the specific-account code) is listed once under
  each, and its rows without a mapping once more with no account, so no row
  is listed under an account its own mapping does not name; entries of one
  provider account are ordered by account id, the one without first. The
  manifest pins each row with the account it was read under, so the entries
  an answer lists are fixed by its context id. Each entry lists:
  - `positions`: the provider quantity as decimal text, the instrument mapping,
    and the provider valuations matched as `POSITION_VALUATIONS_SQL` matches
    them (same parse run, account and code, and the locator guard
    `POSITION_VALUATION_LOCATOR`), in the provider's currency;
  - `balances`: the stored decimal-v1 value (or its absence with a reason, never
    zero), the provider metric and the registry metric with its measurement
    kind, sign meaning, aggregation rule and overlap group. The aggregation rule
    says whether a balance could be added across disjoint accounts; nothing here
    adds it.
- `payables`: provider statement totals (`card_statement_facts`' rule restated
  with the cutoff: the newest published capture per statement key before it)
  due on or after `D − 31` days, or without a readable due date and captured
  in the 45 days before the cutoff, each with the resolved card account (the
  keyed form of `card_settlement_fact_ownership`) and the settlement review of
  its (account, source, period), accepted first (the purchases page's
  `SETTLEMENT_SQL`). Status on `D`:

  | Status                      | When                                                                 |
  | --------------------------- | -------------------------------------------------------------------- |
  | `settled_on_or_before_date` | An accepted settlement review whose bank debit is on or before `D`   |
  | `payment_date_unknown`      | Otherwise, no readable due date                                      |
  | `due_after_date`            | Otherwise, due after `D`                                             |
  | `due_unsettled`             | Otherwise (due on or before `D`, no accepted debit on or before `D`) |

  A proposed, rejected or withdrawn review settles nothing.

- `scheduledPayments`: the provider's scheduled card payments as of the
  cutoff, per captured page ([below](#scheduled-payments)), never added and
  never matched with a payable.
- `coverage`: containers without a snapshot, stale snapshots, the excluded
  perimeter and excluded row counts, `liabilitiesCoverage: "partial"` with
  `liabilitiesMissing` (`unbilled_card_usage`, `installment_remaining` and
  `loan_balances` always; `statements_before_window` when the answer leaves a
  statement out), the payable window (`payablesFromPaymentDate`),
  `statementsBeforeWindow`, `scheduledPayments` (`listed`, or
  `not_listed_account_filter`) and `netAssets: "not-computed"`.
  `statementsBeforeWindow` counts the statements as of the cutoff that the
  window leaves out, per source and reason: `due_before_window` (a readable
  due date before `D − 31` days) or `undated_captured_before_window` (no
  readable due date, captured more than 45 days before the cutoff). Each
  statement is either a payable or counted there, never both
  (`DATED_STATEMENTS_BEFORE_WINDOW_SQL`, the complement of the window over
  the same statement facts). Only counts above zero are listed, under the same
  `source` and `account` filters as the payables, so a statement whose account
  is unresolved is counted only without an `account` filter. The entry carries
  no amount and no settlement status. The `/state` page lists the counts
  under 一覧にない期間外の請求 in its coverage notes;
  `kogane.reported-state.read` answers the same body.
- `manifest` and `contextId = canonicalDigest(manifest)`. Under
  `reported-state-v3` and later the manifest pins every input the answer reads (INV09;
  [ADR 0019, context amendment](adr/0019-dated-reported-state.md#context-amendment--2026-11-19)
  and
  [statements-before-window amendment](adr/0019-dated-reported-state.md#statements-before-the-window-amendment--2026-11-18)):
  the schema, date and cutoff; the policy ids and `metricRegistryRelease`; the
  request's `filters`; the chosen `snapshotRefs` and the
  `containersWithoutSnapshot` (`source/parser/dataset`); `rows`, every
  position and balance listed or counted as excluded, each as
  `[ref, accountId, accountIdentity, instrumentId, instrumentIdentity]` (the
  row id names its parse run, so a parse activated over the same artifact
  changes it); the `statementRefs` and `statementAccounts`
  (`[ref, accountId]`); `settlementRefs`, each review as
  `card-settlement:<id>@decision:<decision revision id>`, or `@proposed`
  before any decision; and `statementsBeforeWindow`, the statements the
  window leaves out as `{sourceId, accountId, reasonCode, count}` per source,
  resolved account (`null` when none resolves) and reason, only counts above
  zero, ordered by those three. The coverage's counts are these added per
  source and reason, and the wire contract refuses an answer where they
  disagree. Another filter, a mapping revision or identity run that changes
  what a row shows, a review decision, an activated parse, a registry
  release, a changed count, or a statement left out whose resolved account
  changes is therefore a new context id; an unchanged store keeps its id.
  `reported-state-v2` (the context amendment of 2026-11-19, released first)
  has no `statementsBeforeWindow`; since `reported-state-v3` (the
  [ADR 0019 amendment of 2026-11-18](adr/0019-dated-reported-state.md#statements-before-the-window-amendment--2026-11-18))
  every manifest carries it (`[]` when nothing is left out) and names v3, so
  every reported-state `contextId` changed once more with it. Since
  `reported-state-v4` ([scheduled payments amendment](adr/0019-dated-reported-state.md#scheduled-payments-amendment--2026-11-21))
  the manifest also carries `scheduledPaymentCaptures`, each listed page as
  `[artifact:<id>, parse_run:<id>]`, and `scheduledPaymentRefs`, each listed
  payment, both sorted, so a newer page, another parse of the same page or
  another row is a new context id; every reported-state `contextId` changed
  once more with v4.

`queryDatedState` counts the statements before the window and lists the
scheduled payments unless it is called with
`includeStatementsBeforeWindow: false`. The holdings change below, the
[reconstructed state](reconstructed-state.md) and the
[valuation on a date](calculation-and-reports.md#valuation-on-a-date) pass
`false`: they run neither `DATED_STATEMENTS_BEFORE_WINDOW_SQL` nor
`DATED_SCHEDULED_PAYMENTS_SQL`, and the state they build on has no
`statementsBeforeWindow` or `scheduledPayments` in its body, coverage or
manifest and names every liability gap. The reported context ids they pin are
the digests of that manifest without them: they record no input they did not
read, and they differ from the `/state` answer's `contextId` for the same date
and filters. The context amendment of 2026-11-19 (`reported-state-v2`) changed
them once, as it changed every reported-state context id, and
`reported-state-v3` and `reported-state-v4` each changed them once more: their
manifest gains nothing but names the schema version, so those ids, and the
context ids of the reads that pin them, are new under each. Nothing stores
them, so nothing is rebuilt.

`source` narrows accounts, payables, scheduled payments and coverage to one
source; `account` to one resolved account id, under which no scheduled
payment is listed. The answer has no total, subtotal or net worth, and the
wire contract refuses one.

## Scheduled payments

`scheduledPayments` lists what MyJCB's ショッピングスキップ払い page (the
`myjcb-skip-payment-schedule` parser, [ADR 0005 amendment (e)](adr/0005-myjcb-statement-state-from-page.md#amendment-2026-09-27-e-the-skip-payment-schedule-page-is-read-as-scheduled-payments))
said was still to be paid, as of the cutoff
([ADR 0019, scheduled payments amendment](adr/0019-dated-reported-state.md#scheduled-payments-amendment--2026-11-21)).
`DATED_SCHEDULED_PAYMENTS_SQL` chooses, per source and fetch unit (one MyJCB
connection), the newest sealed fetch run with a published parse of that
parser on a page captured before the cutoff, and returns each such page with
its rows. The page has no selecting snapshot policy, so the newest published
run is its capture, as the payables take the newest published statement; a
newer page whose parse is not published leaves the older one current.

Each entry is one page: `ref` (`artifact:<id>`), `sourceId`, `parserName`,
`capturedAt`, `captureDate`, `ageDays` and `freshness`
(`dated-state-freshness-v1`), and its `payments` in due-date order. An empty
`payments` means the page listed none, not that nothing was scheduled after
the capture. A payment is `ref` (`scheduled-payment:<id>`), `sourceAccount`,
`scheduleKind` (`card-skip-payment`), `usageDate`, `dueDate`, `amount` (the
stored canonical integer as an exact decimal in its currency; any other text
stays `unparsed`, never zero), `providerText`, `counterparty` (the merchant
text), `asOf` (the page's own as-of date) and `dueStatus`:

| `dueStatus`             | When                                               |
| ----------------------- | -------------------------------------------------- |
| `due_after_date`        | The due date is after `D`                          |
| `due_on_or_before_date` | The due date is on or before `D`; payment not read |

What the amount covers (one deferred payment or the rest of it) and whether a
later statement month carries it are not confirmed (ADR 0004), so a scheduled
payment is never a payable, never matched with a statement, a settlement or a
purchase, never added and not counted as a liability: `liabilitiesMissing`
is unchanged. The rows have no identity run, so no resolved account: under
an `account` filter the read is skipped, nothing is listed and
`coverage.scheduledPayments` is `not_listed_account_filter`; otherwise it is
`listed`. The `/state` page shows the pages in the panel スキップ払いの予定
after the card statements; `kogane.reported-state.read` answers the same
body.

## HTTP

`GET /api/v2/reported-state?date=YYYY-MM-DD[&source=…][&account=…]`, GET and
HEAD only, served to every signed-in reader (the reader authority the other
GET routes have; it carries no review action). `400 invalid_query` for any
other, repeated or empty parameter or a malformed `source` or `account`,
`400 invalid_date` for a missing, malformed or impossible date,
`400 date_in_future` after today in Tokyo, `413
result_limit_exceeded` past 5,000 rows in one read (refused, never cut), and
`404` where the store lacks `dataset_snapshot_policies`,
`scheduled_payment_observations`, `card_statement_facts` or
`card_settlement_reviews`; `/api/meta` advertises `reportedStateOnDate` on
the same condition.
`GET /api/v2/reconstructed-state` reads this state at both ends of a range
and sets it beside the balances reconstructed from adopted events; it is
served, and `reconstructedStateOnDate` advertised, on the same condition
([reconstructed state](reconstructed-state.md#http-agent-tool-and-page)).

## Holdings changes between two dates

`queryHoldingsChange(sql, { from, to, today, source?, account? })` in
`packages/application/src/query/holdings-change.ts` sets the reported
holdings of two dates side by side
([ADR 0075](adr/0075-reported-holdings-change-between-dates.md)); the rules
are `compareReportedHoldings` in `packages/domain/src/holdings-change.ts`
(`holdings-change-v1`). A route, a wire contract and a panel of the `/state`
page serve it ([below](#http-contract-and-page)), and so does the page read
`kogane.reported-holdings-change.read` ([agent API](agent-api.md#ui-read-pages)).

It reads the reported state on both dates (narrowed by `source` only, so a
capture whose identity is not recorded yet still lists its holdings), each
listed position's decimal-v1 quantity (`DATED_POSITION_QUANTITIES_SQL`, as
valuation on a date reads it) and each chosen snapshot's fetch unit
(`DATED_SNAPSHOT_UNITS_SQL`, keyed by artifact id). A holding is the
provider's own key: source, container (parser and dataset), provider account,
market and security code. On each date it is `listed`,
`listed_more_than_once`, `not_listed` (the complete capture of its container
and fetch unit does not list it), `snapshot_scope_ambiguous` (listed in
captures of several fetch units) or `no_snapshot` (no complete capture of its
container and fetch unit before the end of the date).

| Status                 | When                                                                                  | Figure                          |
| ---------------------- | ------------------------------------------------------------------------------------- | ------------------------------- |
| `compared`             | Listed once on both dates, in different captures, with exact quantities and no reason | `end − start`, exact, zero kept |
| `listed_at_start_only` | Listed on `from`; the capture of its container and unit on `to` does not list it      | None (not a zero)               |
| `listed_at_end_only`   | Listed on `to`; the capture of its container and unit on `from` does not list it      | None (not a zero)               |
| `not_comparable`       | Any reason below                                                                      | None                            |

Reasons, in this order: `no_snapshot_at_start|end`,
`snapshot_scope_ambiguous_at_start|end`, `holding_key_ambiguous_at_start|end`,
`same_capture_both_dates` (no capture between the dates), `capture_order_inverted`,
`account_differs` and `instrument_differs` (both dates name a resolved id and
they differ), `quantity_not_exact_at_start|end`.

`account` keeps a key a listing on either date names for that account; its
other side is still judged on that date's whole listing. The answer lists the
holdings in key order with counts per status, the position containers
without a capture on either date and the stale snapshots, and states
`total: "not-computed"` and `valuation: "not-computed"`: holdings are never
added or valued. The change is between the two chosen captures; a stale one is
shown with its age. The manifest pins both reported context ids (of the dated reads without the
count of statements before the window, above) and every
key's side refs, status and reasons; `contextId` is its digest. More than 500
positions on a date is refused (`holding_limit_exceeded`), as is a reported
state past its own bound (`dated_state_limit_exceeded`); a malformed request,
`from` not before `to`, `to` after today, and an unknown source or account
have their own codes.

### HTTP, contract and page

`GET /api/v2/reported-holdings-change?from=YYYY-MM-DD&to=YYYY-MM-DD[&source=…][&account=…][&detail=summary|full][&limit=…][&cursor=…]`
(ADR 0075, 2026-11-06 amendment) is exposed as the reported state is: GET and
HEAD only, served to every signed-in reader, and `404` exactly where
`/api/v2/reported-state` is not served. `400 invalid_query` for any other,
repeated or empty parameter, a malformed source, account or cursor, a
`detail` other than `summary` or `full`, a `limit` other than 10, 25, 50 or
100, and a `limit` or `cursor` with `detail=full`; `400
invalid_date` for a missing, malformed or impossible date, `400
invalid_range` when `from` is not before `to`, `400 date_in_future` when `to`
is after today in Tokyo, `404 unknown_source` and `404 unknown_account`, and
`413 result_limit_exceeded` (with `refs` naming `holding_limit_exceeded` or
`dated_state_limit_exceeded`) rather than a cut answer. With `detail=full` the
body is `{ apiVersion: 2, …HoldingsChange }`, unpaged.

Without `detail`, or with `detail=summary` (ADR 0075, amendment 2026-11-19;
proposed), the body is one page of `summarizeHoldingsChange` in
`packages/domain/src/holdings-change-summary.ts`
(`reported-holdings-change-summary-v1`) over the same comparison: the
holdings whose change is not an exact zero, in status order (`compared`,
`listed_at_start_only`, `listed_at_end_only`, `not_comparable`) and key order
within; `unchanged` counts the `compared` holdings with a zero change, which
are not listed; `reasonCounts` counts the holdings carrying each reason; a
line keeps its container (a page-local `c1`, `c2`, … ref into `containers`),
provider account, market, code, unit, status, reasons, each side's state with
its position or artifact ref and, when listed, the quantity as exact decimal
text or null with its `quantityStatus`, and the change as exact decimal
text. The full answer's `counts`, `coverage` (no total, no valuation) and
`contextId` are kept; the capture times, identities, provider text and
manifest are not. Ten lines a page by default (`limit` 10, 25, 50 or 100);
`page.nextCursor` continues at any size and is bound to the comparison's
`contextId` and the request's dates and filters: `400 invalid_cursor` for a
cursor that does not decode or names no line, `400 cursor_mismatch` for one
of other dates or filters (its `mustMatch` names `from`, `to`, `source` and
`account`, as ADR 0123's reads do), and `410 context_expired` once the comparison has
moved. Every page computes the comparison again.

`validReportedHoldingsChange` (the full answer) and
`validReportedHoldingsChangeSummary` (a body with `detail: "summary"`) are
applied through `validApiResponse`; the summary's validator refuses a total,
a listed zero change, a number for a quantity that is not exact, a change
off `compared`, lines out of status order, counts that do not add up and
container refs that are not defined once in order of use. The full answer's
validator, which the page applies to its own answer, refuses any field it
does not name (a total, a
valuation, a sum), any status, reason or side state outside the closed lists,
reasons out of the domain's order or missing a side's own reason, a change on
a row that is not `compared`, a change that is not an exact decimal in the
holding's unit, counts that do not match the holdings, and a manifest that
does not describe the body (its dates, filters, and each holding's key, side
references, status and reasons, in the body's order).

The `/state` page carries a panel 保有数量の変化 while `reportedStateOnDate`
is advertised (no capability of its own: the route is served on the same
condition). It asks nothing until a start date 比較の開始日 before the page's
基準日 is chosen, then lists each holding key with each side's provider text
and capture date, the server's change with its sign (`+2.5`, `±0`, `-3.5`)
for `compared` rows, `数値なし` for rows listed on one date only and for
`not_comparable` rows, whose reasons it states in words. Each row's header
reads the whole holding key: code and market, then source, provider account,
parser and dataset. Each row's reasons are a list named after that header (as
in
`1004（sbi-securities · sbi-a · sbi-domestic-cash-positions · domestic-cash-positions）を比較できない理由`),
so no two rows' lists share a name, and the rows of one code in two accounts,
sources or containers are told apart by ear as by eye. It shows counts per
status and the coverage notes, never a total, valuation or sum of changes.

The panel also takes the route's `source` and `account` filters (取得元 and
口座 ID). They live in the page URL as `changeSource` and `changeAccount`, so a
narrowed comparison is a link, and are applied with 比べる; 絞り込みを解除
removes them. The fields suggest the sources and account ids the page's date
lists holdings for (the page's own reported state, no request of its own) and
take any other. The page sends exactly the route's parameters and checks them
with the route's own shape rule, `holdingsChangeQueryRefusal` in the wire
contract, before it asks: a field of the wrong shape is named and nothing is
sent, and a URL holding a repeated, empty or malformed filter asks nothing and
offers to remove it rather than widening the comparison. `404 unknown_source`
and `unknown_account` are stated in words, never shown as an empty
comparison, and the answer's own `filters` are shown beside its dates. The
page asks for `detail=full`, the unpaged answer, and refuses any other shape
(`useReportedHoldingsChange` applies `validReportedHoldingsChange` itself), so
a filter change has no page to reset.

## Cost

Measured on `bun:sqlite` with every CORE migration and no table statistics, on
the statement-scale store of `packages/read-model/test/card-usage-scale-fixture.ts`
(`STATEMENT_SCALE`: 730 daily captures of three Vpass cards, a MyJCB
connection, SMBC and St.George; 27,736 artifacts, 16,786 published parses,
632,599 transaction and 18,250 balance observations, 5,840 statement totals,
3,763 settlement candidates), with `KOGANE_DATED_STATE_SCALE=full`, on
2026-11-18 (median of three, one run on a machine shared with other test
processes):

| Read                                  | Median |
| ------------------------------------- | ------ |
| `queryDatedState`, today              | 507 ms |
| `queryDatedState`, a date a year back | 455 ms |
| `DATED_POSITIONS_SQL`                 | 92 ms  |
| `DATED_BALANCES_SQL`                  | 113 ms |
| `DATED_SNAPSHOTS_SQL`                 | 126 ms |
| `DATED_STATEMENTS_SQL`                | 76 ms  |
| `DATED_STATEMENTS_BEFORE_WINDOW_SQL`  | 79 ms  |

The five reads are issued concurrently through the executor, one statement
each, plus the settlement read. What grows with history: the snapshot CTEs
read every artifact once per read (through
`idx_fetch_artifacts_source_dataset_time`), as the current-state reads do, and
the statement read and the count of the statements before the window each
rank every captured statement total before the cutoff, as
`card_statement_facts` does. Everything else is reached by key: parses through
`published_parse_runs`, observations through their `parse_run_id` indexes,
identities through the identity runs of the chosen parses only, owners through
the keyed ownership CTEs, and reviews through
`card_settlement_candidates_statement_period`. No index was added, so there is
no migration. `packages/application/test/dated-state-scale.test.ts` builds the
smaller `STATEMENT_CI_SCALE` in CI, checks each date's snapshot and statements
against independent queries, fails on a plan that scans an observation, parse,
run or identity table whole, and requires each answer under one second.

A holdings change between two dates is two of these answers (run
concurrently through the executor) plus two keyed reads: the position
quantities by primary key and `DATED_SNAPSHOT_UNITS_SQL` (artifacts and fetch
units by primary key; its plan is checked in
`packages/read-model/test/dated-state.test.ts`). At `STATEMENT_SCALE`, a month
ending today took 915 ms on 2026-11-18, neither answer counting the
statements before the window (median of three, one run on `bun:sqlite` on a
machine shared with other test processes; the store holds no position
container). `packages/application/test/holdings-change-scale.test.ts` records
every statement one answer runs on `STATEMENT_CI_SCALE` and fails on
`DATED_STATEMENTS_BEFORE_WINDOW_SQL` or a whole
scan beyond what the dated reads' own scale test accepts, and requires an
answer under two seconds.

## Limits

- Not measured on workerd or D1 itself. The scaled store holds balance
  containers and statements; it has no SBI position containers, so the position
  read's timing there reflects the snapshot CTEs, not many positions.
- Identity, account mappings and settlement reviews are read as they are today,
  not as they were on `D`: a later mapping correction or review changes an
  earlier date's answer and its `contextId` (the manifest pins each row's
  identity and each review's decision). A correction that leaves every pinned
  row's account, instrument and statuses as they were (a mapping revision to
  the same account and status) keeps the id; one to a balance counted as
  excluded moves it although the answer shows only the count.
- A settlement's debit date is the reviewed bank row's date, whenever that row
  was captured; the bank capture itself is not bounded by the cutoff.
- Statements due before `D − 31` days, and statements without a readable due
  date captured more than 45 days before the cutoff, are not listed, whatever
  their status. The window is ADR 0019's choice (the plan named none). The
  answer counts them per source and reason (`statementsBeforeWindow`) but does
  not say whether any was settled: it bounds how many older captured
  statements could still be unpaid and is not a figure of what is owed.
- The manifest records how many statements were left out per source, resolved
  account and reason, not which ones. A swap that keeps every count keeps the
  `contextId`: a newer capture of an older statement that takes the place of
  the counted one under the same source, account and reason, or one statement
  leaving a count as another enters it.
- Only captured statements are listed or counted. A card or a month whose
  statement was never captured before the cutoff (or whose capture has no
  published parse) is neither, and no coverage entry names it: an empty
  `statementsBeforeWindow` means no captured statement was left out, not that
  no older bill exists.
- Only the Vpass and MyJCB statement parsers supply payables; unbilled usage,
  installment remainders and loans are not shown (`liabilitiesMissing`).
- Scheduled payments come from MyJCB's skip-payment page only (its bonus page
  stays unread). Production has stored only pages that listed none (ADR 0005,
  amendments i and k), so a page with payments is exercised by synthetic
  tests only. A refused newer parse leaves an older page current with its
  age shown, and the answer does not say a newer page was refused. The read
  scans the publication pointers filtered by parser name; its cost is not
  measured on workerd or D1.
- Adoption and overlap across sources (`selectAdoptedSet`) are not applied:
  rows are listed per provider account, which is why nothing is added.
  Valuation of the listed positions in a base unit, under an explicit price
  and FX policy, is `queryValuationOnDate`
  ([calculation and reports §2](calculation-and-reports.md#valuation-on-a-date));
  it has no route yet, refuses holdings of `stale` snapshots, and states no
  total across sources.
- Nothing is stored: a reported state has no fixed report or
  `calculation_runs` row yet.
- The holdings-change page compares only up to its own 基準日. A change is what two captures report, not attributed to any trade or
  transfer (no event moves a security quantity); a parser renamed between the
  dates would make one holding two keys; balances are not compared there.
