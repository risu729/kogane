# ADR 0005: Decide the MyJCB statement state from the page, not export links

- Status: accepted; the
  [2026-09-27 amendment](#amendment-2026-09-27-a-stop-ends-the-connection-and-keeps-its-captured-months)
  is accepted (#275); the
  [second 2026-09-27 amendment](#amendment-2026-09-27-b-export-links-the-third-ledger-header-and-the-stop-page)
  is accepted (#331); the
  [amendment (c)](#amendment-2026-09-27-c-the-menus-schedule-pages-are-not-months)
  is accepted (#337); the
  [amendment (d)](#amendment-2026-09-27-d-a-confirmed-page-under-the-usage-header-proven-by-the-page)
  is accepted (#336); the
  [amendment (e)](#amendment-2026-09-27-e-the-skip-payment-schedule-page-is-read-as-scheduled-payments)
  is accepted (#338); the
  [amendment (f)](#amendment-2026-09-28-f-ledger-labels-match-across-line-breaks)
  is accepted (#358); the
  [amendment (g)](#amendment-2026-09-28-g-the-statement-heading-may-carry-its-payment-day)
  is accepted (#360); the
  [amendment (h)](#amendment-2026-09-29-h-a-stored-page-states-only-what-the-page-states)
  is accepted (#372); the
  [amendment (i)](#amendment-2026-10-02-i-the-first-stored-skip-payment-page-was-refused)
  is accepted (#394); the
  [amendment (j)](#amendment-2026-10-04-j-the-menus-schedule-heading-is-an-h3-and-the-bonus-page-is-known-by-its-h1)
  is accepted (#407); the
  [amendment (k)](#amendment-2026-10-08-k-the-skip-payment-empty-row-inside-one-more-div)
  is proposed
- Date: 2026-09-25
- Implemented by: #248
- Carried by:
  [observations](../observations.md#myjcb-statement-state-from-the-page-statement-parser-110),
  `creditStatementState` in `services/collector-myjcb/src/parsers.ts`,
  `readMyJcbStatementPage` in `packages/domain/src/myjcb-statement-page.ts`

## Context

The MyJCB collector treated `detailMonth` 0, and 1 without export links, as
`unconfirmed`. The surveyed connection offers no export links in any month, so
position 1, the newest closed statement, was always recorded as
`unconfirmed`, although every production capture of that page carries exactly
one `<h1>カードご利用代金明細(確定分)</h1>`. Statement parser 1.0.1 rejected
every position-1 page, and recognition treated its posted charges as
`authorized`.

## Options considered

1. Keep export links as the signal. Rejected: it is wrong on the surveyed
   connection.
2. Re-state the stored rows in a ledger parser release. Rejected: a ledger
   artifact holds no page evidence, the snapshot slot comes from append-only
   artifact metadata, and the state is part of each row's external id, so a
   re-stated row would be a new key.
3. Read the state from the page with a position-aware rule that the collector
   and the statement parser share. Chosen.

## Decision

- Only the `(確定分)` heading states that a page is closed. The ledger amount
  labels (`今回のお支払い金額` for confirmed, `ご利用金額` for unconfirmed)
  must agree with it.
- Position 0 is always `unconfirmed`. A page without the heading whose ledger
  is missing or has no rows is `unknown` and gets no ledger artifact. A page
  that contradicts itself stops the run with `credit-statement-state` at any
  position. (Amended 2026-09-27, [below](#amendment-2026-09-27-a-stop-ends-the-connection-and-keeps-its-captured-months):
  it stops the connection, not the run, and the months captured before it
  are kept.)
- Older positions do not stop the run: every production run captured
  positions 7 and 8 with empty ledgers and no heading.
- `readMyJcbStatementPage` is the one reader of headings, rows and labels.
  Statement parser 1.1.0 uses it, and the collector manifest's state becomes a
  cross-check only (`statement_state_differs_from_manifest`).

## Consequences

- Stored position-1 rows stay `unconfirmed` observations, the record of what
  the collector said at the time; they stop being current on the first run of
  the fixed collector.
- Position 0's pending rows are no longer displaced from the connection's one
  unconfirmed snapshot slot by position 1. (Amended by
  [ADR 0016](0016-myjcb-pending-statement-slots.md): each pending statement
  now has its own slot.)
- The next position change of a statement (1 → 2) still changed its keys until
  [ADR 0007](0007-myjcb-statement-identity.md).

## Verification

Collector, parser and processor tests on synthetic pages. The production
evidence was read as counts only.

## Amendment 2026-09-27: a stop ends the connection and keeps its captured months

- Status: accepted (#275)
- Date: 2026-09-27
- Carried by: `collectCredit`, `collectConnection` and `connectionStopCode`
  in `services/collector-myjcb/src/collector.ts`, `CONNECTION_STOP_CODES` in
  `services/collector-myjcb/src/types.ts`, `myJcbRunPlan` in
  `services/collector-myjcb/src/shared-collection.ts`,
  [ADR 0026](0026-collector-unit-coverage.md) (the MyJCB row),
  [collection: MyJCB](../collection.md#myjcb-servicescollector-myjcb-kogane-myjcb-collector-poc),
  [MyJCB source note](../sources/myjcb.md)

### Context

A contradiction on one page (this ADR), a failed month fetch, a failed export
or a ledger that did not parse threw out the whole connection: the Worker
kept none of its artifacts, and the terminal recorded the unit as `unknown`
with `collector_failed` (or no unit at all when the run failed). The collector
manifest coarsened every failure to `collector-failure`. So a stored terminal
said neither which stage stopped the connection nor which months had been
captured. The MyJCB collector reported `collector_failed` on 7 of the 14
nights before this amendment, and the only record of why was the Worker's
logs, which expire.

### Decision

A contradiction stops the connection, not the run; captured months are kept
as a partial unit with a stop code.

- `collectCredit` reads the credit months in ascending `detailMonth` order,
  one at a time. A month is kept whole or not at all: its page, ledger and
  exports join the connection's artifacts only once every one of them was
  read. When a month's fetch, statement state, period, ledger parse or export
  fails, the connection stops at that month. It keeps the credit menu, the
  past-months response, every month before it and its `discovery.json`, and
  reads nothing further (no later month, no debit menu).
- Such a connection is `partial`. Its summary and the collector manifest
  carry `stopCode`, `stopPosition` (the `detailMonth` it stopped at) and
  `capturedMonthCount`. Its manifest failure entry is
  `{ connectionId, operation: "collect", code, position }`, and its terminal
  unit is `partial` with `safeErrorCode` set to the stop code.
- A connection that stops before its first month (login, discovery, the
  credit menu, the first detail page that carries the past-months
  discriminator, or the past-months response) keeps nothing. It is `failed`
  (`human-required` for `human_required`), its unit is `unknown` with the stop
  code, and its failure entry has no position. A failed debit read (`debit`)
  is handled the same way; shared mode refuses debit captures in any case
  (`artifact_dataset_unobserved`). When every connection of a
  run keeps nothing, the run is `failed` and persists only its terminal, as
  before. Its units are now still written, each with its stop code, so the
  terminal says where every connection stopped. Registration still refuses
  such a run (`provider_run_failed`): it is recorded, not sealed, and its
  units are not registered.
- The stop codes are a closed list (`CONNECTION_STOP_CODES`): `human_required`,
  `login`, `discovery`, `credit_menu`, `credit_first_detail`,
  `credit_past_months`, `month_fetch`, `month_parse`,
  `credit_statement_state`, `credit_statement_period`, `ledger_parse`,
  `export_fetch`, `debit`, `no_route` and `unclassified`. Each collector stop
  condition maps to one stage through a `Record` over every condition, so a
  new condition does not compile without a stage. `unclassified` is an error
  that names no stage. The manifest rebuilds each connection and failure from
  these closed fields and refuses a plan whose code is not on the list
  (`manifest_stop_code_invalid`) or whose position is not a `detailMonth`
  (`manifest_stop_position_invalid`). No error message, HTTP body, provider
  text or amount is stored or logged.
- The run's `safeErrorCode` is the stop code when every connection that is
  not whole stopped at the same stage (as `human_required` already was);
  otherwise it stays `collector_partial` or `collector_failed`.
- A month whose page shows rows without a stated state still keeps its page
  without a ledger and makes the connection `partial` with
  `collector_partial` (ADR 0026). It is not a stop.

Registration is unchanged. A `partial` unit with a safe error code registers
as a `failed` unit report, so the run is `partial` in
`observation_fetch_runs` and `not_eligible` for parse jobs, exactly as a
connection that withheld a month's rows is (ADR 0026). Nothing about
eligibility is loosened. The months a stopped connection captured are
catalogued and sealed but not parsed. What changes is that the evidence and
the cause are kept: the captured months exist as stored artifacts, and the
terminal and the manifest say where the connection stopped and how many
months it captured.

### Options considered

1. Keep discarding the connection and log more detail. Rejected: logs expire,
   and the cause would still not be in the stored evidence.
2. Keep the captured months and make them parseable. Rejected: it would need
   a partial unit to be eligible, which is exactly what ADR 0026 keeps closed.
   A later month missing from a run must not read as a whole snapshot.
3. Keep the captured months as a `partial` unit with a closed stop code.
   Chosen.

### Consequences

- A stopped connection's run registers `partial` and is never parsed, as
  before. Its captured months are recoverable evidence: a later parser change
  or eligibility decision could read them without a new capture, and nothing
  here makes that decision.
- Production terminals written before this amendment keep `collector_failed`
  and no months. They are immutable.
- The stop position and the count of captured months are recorded. The stage
  is the collector's own, and it does not say what the provider meant.
- `r2-write` is not a stop code: the collector writes nothing until the run's
  plan is persisted, and a failed put leaves no terminal (G1-01).

### Verification

- `services/collector-myjcb/test/credit-statement-state.test.ts`:
  `collectCredit` stopping at position k keeps positions below k and nothing
  from k on, for a failed fetch (`month_fetch`), a contradicting page
  (`credit_statement_state`), a page naming no month
  (`credit_statement_period`), a ledger header missing a label
  (`ledger_parse`), and a failed export, which also drops that month's page
  and ledger (`export_fetch`). The stop log carries codes and counts only. A
  failure at the menu or the past-months response is thrown. Every stop
  condition maps to a closed code. The Worker, with a session connection
  whose month 2 returns HTTP 500, persists months 0 and 1 as a `partial` unit
  with `month_fetch` and a manifest with `stopPosition: 2` and
  `capturedMonthCount: 2`, without the response body. Through the manual
  trigger, an error message, an HTTP error body or an unparsable page that
  carries a digit string, a merchant-like word and a URL, at a month, at the
  credit menu, at the past-months response or at login, reaches no stored
  byte, no log line and no HTTP response; only the stop code does.
- `services/collector-myjcb/test/shared-collection.test.ts`: the stopped unit,
  its artifacts and its manifest entries; distinct stages keep distinct unit
  codes; a failure before the first month keeps nothing and its `unknown`
  unit carries the code; free text passed into a summary or a failure does
  not reach the manifest, and an unknown code or position refuses the plan;
  the Worker with no browser records `login`.
- `services/processor/test/myjcb-shared-r2.test.ts`: the collector's real
  plan for a stopped connection registers and seals, catalogues its captured
  artifacts, has run status `partial` and unit report `failed` with
  `month_fetch`, is sealed under `terminal-registration-v2`, and ends
  `not_eligible` with nothing parsed. A failed run whose only unit stopped
  before its first month persists only its terminal (unit `unknown`, 0
  artifacts, the stop code) and registration records it as blocked
  `provider_run_failed` with no fetch run and nothing sealed.
  `services/processor/test/collector-plans.test.ts` (the successful plan) is
  unchanged and passes.
- No production data was read for this amendment.

## Amendment 2026-09-27 (b): export links, the third ledger header and the stop page

- Status: accepted (#331)
- Date: 2026-09-27
- Carried by: `discoverCreditExports`, `scheduledLedgerRowCount` in
  `services/collector-myjcb/src/parsers.ts`; `collectCredit` (the month loop,
  `CreditExportMode`, `STOP_PAGE_CODES`) in
  `services/collector-myjcb/src/collector.ts`; `UNREAD_MONTH_CODES`,
  `ConnectionSummary.unreadMonths` and `exportOffers` in
  `services/collector-myjcb/src/types.ts`; `connectionErrorCode` and the
  manifest in `services/collector-myjcb/src/shared-collection.ts`;
  [ADR 0026's MyJCB amendment](0026-collector-unit-coverage.md#amendment-myjcb-unread-months-and-export-offers-2026-09-27);
  [MyJCB source note](../sources/myjcb.md)

### Context

The owner's agent surveyed the live credit detail pages of one connection on
2026-09-27, recording structure only (element counts, header labels, link
shapes, no values). Four findings bear on this ADR.

1. **Export links.** The confirmed months (positions 1 and 2) link their
   exports, PDF `detailDbPdf.html?output=pdf`, CSV
   `detail.html?output=csv` and OFX `detail.html?output=money`, with relative
   hrefs that name no `detailMonth` (the month is the page they are on).
   `discoverCreditExports` resolved
   every href against the origin alone, so a relative link named
   `/detail.html` and never matched
   `/iss-pc/member/details_inquiry/detail.html`. Every stored run found no
   export; this ADR's Context ("the surveyed connection offers no export
   links in any month") was that bug, not the provider.
2. **Three ledger headers.** Positions 0 and 7 show
   `ご利用日 / ご利用先など / 支払区分 / ご利用金額` (unconfirmed), positions 1
   and 2 show `ご利用日 / ご利用先など / 支払区分 / 今回のお支払い金額`
   (confirmed), and position 8 shows a third header,
   `ご利用日 / ご利用先など お支払日 / 今後のお支払い金額`, over an empty
   ledger. Positions 3 to 6 have no ledger element. A second structure-only
   look the same day (round 4) found what positions 7 and 8 are: the menu's
   nine 「明細を見る」 links (DOM order 0, 1, 7, 8, 2, 3, 4, 5, 6) put
   positions 0 and 1 under 「最新のご利用明細」 and 2 to 6 under 「過去の明細」
   (the months), and 7 and 8 under 「ボーナス#回払い・ショッピングスキップ払い」:
   position 7 is the ボーナス払い schedule and position 8 the
   ショッピングスキップ払い schedule (h1 「ショッピングスキップ払いご利用明細
   (未確定分)」, no payment month named). They are payment schedules, not
   statement months. The third header's live `div.head` (a `div` grid, not a
   `<table>`) has three cells: 「ご利用日」, 「ご利用先など」 and 「お支払日」 on
   two lines of one cell, and 「今後のお支払い金額」; the first survey wrote
   it as four labels. The third header carries neither read amount label:
   with rows at position 0 or 1, or under the confirmed heading, the page
   stops the connection (`ledger_parse` at position 0 or under the heading,
   `credit_statement_state` at position 1 without it); at position 2 or later
   without the heading its rows were already withheld as an unstated page.
   Empty, it is `unknown` and withholds nothing, as today.
3. **A variable page at position 1.** The runs of 2026-09-25 and 2026-09-26
   stopped with `credit-ledger-headers` at position 1 and kept no artifact
   (they ran before the first amendment). On 2026-09-27 the live position 1
   was the confirmed form, which passes. What position 1 showed on those
   nights was not stored and cannot be recovered. A position-1 page stored
   by an earlier run (counted by label only, round 4) carries the
   `(確定分)` heading but no `今回のお支払い金額` label anywhere, only
   `ご利用金額`; the rule of this ADR stops on such a page with rows (a
   confirmed ledger must show the confirmed header set, `ledger_parse`), so
   a page of that shape is the likely cause, not a confirmed one.
   (Reinterpreted by [amendment (f)](#amendment-2026-09-28-f-ledger-labels-match-across-line-breaks):
   the count was a string-matching artifact, and the stops were the
   collector's own header match.) Also observed: a detail
   page fetched without visiting `detailMenu.html` first in the session is a
   different page (h1 `カードご利用明細一覧`, no ledger), and after many
   consecutive fetches the site served a 「通信エラーが発生しました」 page.
4. **The shared bucket refuses export datasets.** `myJcbRunPlan` throws
   `artifact_dataset_unobserved` for `credit-csv`, `credit-pdf` and
   `credit-ofx`, a decision carried over from the importer (no validator
   for their bytes on the central path). Once exports are discovered,
   fetching them would make every run with a confirmed month throw before
   its terminal is written.

### Options considered

For the export links:

1. Fix discovery and fetch the exports as the collector was written to.
   Rejected: every such run would fail its plan (finding 4), and the export
   datasets have no registration or parser support. It would also add three
   requests per confirmed month to a site that served an error page after
   many consecutive fetches.
2. Fix discovery, record the offered kinds, fetch nothing. Chosen: the
   offer is a fact about the page, stored as closed values; fetching can be
   enabled when the datasets are accepted end to end.

For the third header (ADR 0004: record what was observed, support only that):

1. Parse its rows as a statement. Rejected: what its rows mean (a payment
   schedule, instalments still due) has not been observed with rows or
   confirmed.
2. Keep stopping on it. Rejected: a page shape seen on the live site would
   stop the whole connection and lose every later month.
3. Recognise the header as a closed reading, keep the page as evidence of
   that month, read none of its rows, and go on to the next month. Chosen.

For the undiagnosable stops (finding 3):

1. Keep dropping the page a connection stopped on. Rejected: the next
   `ledger_parse` stop would again leave nothing to diagnose.
2. Keep that page, redacted like every stored page, when the stop is about
   the statement page's own shape. Chosen. A page that could not be read as
   a statement page at all (`month_parse`) is still not kept: it may be any
   page, and the first amendment's no-provider-text test covers it.

### Decision

- **Export discovery.** A link is resolved against the detail page's own
  URL (`https://my.jcb.co.jp/iss-pc/member/details_inquiry/detail.html`), so
  relative, `./`, root-relative and absolute hrefs are read alike. It must
  stay on the MyJCB origin, name the export path (`detail.html` or
  `detailDbPdf.html` in `/iss-pc/member/details_inquiry/`) and an `output` of
  `csv`, `money` or `pdf`. A link on a month's page that names no
  `detailMonth`, as observed, is that month's export; a link that does name
  one counts only when it names exactly this month (before, `Number(null)`
  made a month-less link month 0's and no other month's).
- **Exports are recorded, not fetched.** `collectCredit` records, for each
  month kept, the export kinds its page offers
  (`exportOffers: [{ position, kinds }]` on the connection summary and in
  the manifest, kinds from `csv`, `pdf`, `ofx`). The Worker fetches none.
  `collectCredit(..., { exports: "fetch" })` keeps the earlier fetch path,
  tested but passed by no caller. A page that offers exports without being
  a confirmed statement still stops the connection
  (`credit_statement_state`), as this ADR decided; with discovery fixed,
  that check now runs on live pages.
- **The third header.** A ledger whose header text, whitespace removed,
  shows `ご利用日`, `ご利用先など`, `お支払日` and `今後のお支払い金額` and
  none of `支払区分`, `今回のお支払い金額` or `ご利用金額` is the third header
  (`scheduledLedgerRowCount`); labels are matched in the head's text, never
  by cell, so the observed three-cell head and a four-cell one are read
  alike. The code is `scheduled_payments_page` because the header was
  observed only on the ショッピングスキップ払い schedule page. When such
  ledgers have rows, the position is captured unread, whatever it is:
  before the statement state is read, its
  page is kept as `unknown` evidence with its relative or API period, no
  ledger is derived, no export is fetched, and the next month is read. The
  unread month is recorded as `unreadMonths: [{ position, code:
"scheduled_payments_page" }]` on the summary and in the manifest, and is
  logged as `myjcb-credit-month-unread` with the position and the code only.
  A page that carries the third header beside another ledger is unread
  whole. An empty third-header ledger withholds nothing and is read as before.
- **Positions, not months.** The collector enumerates `detailMonth`
  positions from the menu and the past-months response and does not tell a
  statement month from a schedule page: positions 7 and 8 are fetched,
  kept, counted in `periodCount` and `capturedMonthCount`, and, when
  unread, named in `unreadMonths` like any month, with the relative period
  labels
  `detailMonth-7` and `detailMonth-8`, which no reader resolves to a
  calendar month (only `detailMonth-0` and `-1` are). A schedule page with
  rows keeps the connection `partial`: the rows are unread, and whether
  they appear in any statement month has not been observed (INV05).
  (Amended by [amendment (c)](#amendment-2026-09-27-c-the-menus-schedule-pages-are-not-months):
  the menu's headings now tell the two apart.)
- **Unread months are one closed list** (`UNREAD_MONTH_CODES`):
  `scheduled_payments_page`, and `rows_unstated` for the months ADR 0026
  already withheld (rows without a stated state at position 2 or later),
  which were counted but not named. A connection with an unread month is
  `partial` (ADR 0026). Its unit's `safeErrorCode` is `scheduled_payments_page`
  when every unread month is under the third header and the connection did
  not stop, and `collector_partial` otherwise, as before. The run carries
  that code when every connection that is not whole carries it. The manifest
  rebuilds each unread month and each offer from closed values and refuses
  any other code (`manifest_unread_code_invalid`), kind
  (`manifest_export_kind_invalid`) or position
  (`manifest_stop_position_invalid`). An unread month is not a failure: the
  manifest's `failures` does not list it.
- **A truly unknown header still stops.** A ledger with rows whose header is
  none of the three stops the connection at that month as before
  (`ledger_parse` or `credit_statement_state`).
- **The stop page.** When a connection stops at a month with
  `credit_statement_state`, `credit_statement_period` or `ledger_parse`, the
  page it stopped on is kept, redacted, as a `credit-detail` artifact with
  state `unknown`, the month's API or relative period, no ledger and no
  export. `capturedMonthCount` stays the number of months before it, and
  `stopPosition` names it. The stop log adds `stopPageKept`. This narrows the
  first amendment's "a month is kept whole or not at all" for these three
  stops only.
- **Menu first, verified.** `collectCredit` reads `detailMenu.html` once, in
  the same session and before any detail page, then the first month, the
  past-months response and the remaining months in ascending order. The
  order was already so; a test now pins it.
- **The error page is not recognised.** Its structure was not recorded, and
  whether normal pages carry the same text (for a hidden dialog, say) is
  unknown, so a detection rule would be a guess. It is a limit (below).

Registration and eligibility are unchanged. A unit with
`scheduled_payments_page` is `partial`, registers as a `failed` unit report,
and its run is `partial` and `not_eligible`: the unread page is catalogued
and sealed, and no parser reads it.

### Consequences

- A connection whose page shows the third header with rows no longer loses
  the months after it: they are read, and the run registers `partial`.
  Because a `partial` run is not parsed, such a night parses nothing at all,
  including the months read whole; that is ADR 0026's rule, unchanged.
- The manifest now names the unread months and the offered exports. A night
  whose confirmed months offer exports records them, so whether discovery
  works is visible in stored evidence.
- The next `ledger_parse`, `credit_statement_state` or
  `credit_statement_period` stop stores the page it stopped on, so its
  header can be read from the stored run. A stop page is a `credit-detail`
  artifact at `stopPosition`; a later eligibility decision about stopped
  connections must not read it as a captured month.
- Limits: the export contents on this connection were last checked
  2026-08-31 and are not stored. What the third header's rows mean is
  unconfirmed. The cause of the 2026-09-25/26 stops is not confirmed
  (finding 3 names the likely one). While the ショッピングスキップ払い
  page shows rows, every run is `partial` and nothing of it is parsed; a
  rule that treats a schedule page apart from the months needs the menu's
  grouping read and a decision of its own (made in
  [amendment (c)](#amendment-2026-09-27-c-the-menus-schedule-pages-are-not-months)). A stored page keeps its body
  text, so a stop page carries the page's 「カード情報」 table as every
  stored credit detail page does. The
  「通信エラーが発生しました」 page is not detected: served for the first
  detail page it stops the connection before any month
  (`credit_first_detail`, no discriminator), and served for any later month
  it would be kept as an `unknown` month with nothing withheld, which reads
  as whole. The collector reads the menu once per connection; whether a
  month needs the menu again after the past-months response has not been
  observed.

### Verification

- `services/collector-myjcb/test/parsers.test.ts`: relative, `./`,
  root-relative and absolute export hrefs are found, the observed
  month-less relative hrefs at months 1 and 0 included; another origin,
  another or a malformed month, a link one directory away, a link without an
  export `output` and the notice PDF are not. `credit-statement-state.test.ts`
  records the observed month-less links as an offer of their page's month,
  and stops on them on a page that is not a confirmed statement.
- `services/collector-myjcb/test/credit-statement-state.test.ts`: the three
  headers in one connection (unconfirmed with rows, confirmed with rows,
  the third with rows under the heading, no ledger, both empty variants):
  the third-header month is kept `unknown` without a ledger, later months
  are read, and only it is unread; third-header rows at positions 0 and 1
  are unread too; the page reading alone would stop on them; an unobserved
  header with rows stops with `ledger_parse` and keeps its page as
  `unknown`; a contradicting page keeps its page; an offered export is
  recorded and not fetched by default, and the fetch path still stops with
  `export_fetch`; the menu is read once, before any detail page. Through the
  Worker, a third-header month at position 2 persists a `partial` unit with
  `scheduled_payments_page`, `unreadMonths` in the manifest, no failure, and
  logs with codes only.
- `services/collector-myjcb/test/shared-collection.test.ts`: the unit and
  run codes for third-header-only, `rows_unstated` and mixed unread months;
  the manifest's `unreadMonths` and `exportOffers`; refusal of an unknown
  code, kind or position; an offer on a whole connection keeps it
  `complete`.
- `services/processor/test/myjcb-shared-r2.test.ts`: the collector's real
  plan with a `scheduled_payments_page` month registers and seals, catalogues
  the unread page without a ledger, has run status `partial` and unit report
  `failed` with `scheduled_payments_page`, and ends `not_eligible` with no
  parse job.
- No production data was read for this amendment; the findings above are
  the owner's agent's structure-only survey.

## Amendment 2026-09-27 (c): the menu's schedule pages are not months

- Status: accepted (#337); the heading level it groups by (the last `h2`)
  is amended by (j): the schedule heading is an `h3`
- Date: 2026-09-27
- Carried by: `readCreditMenuGroups` in
  `services/collector-myjcb/src/parsers.ts`; `collectCredit` and
  `collectConnection` in `services/collector-myjcb/src/collector.ts`;
  `SCHEDULE_PAGE_CODES`, `ConnectionSummary.schedulePages` and
  `schedulePageCount`, the stop code `credit_menu_group_unrecognized` in
  `services/collector-myjcb/src/types.ts`; the manifest in
  `services/collector-myjcb/src/shared-collection.ts`;
  [ADR 0026's MyJCB coverage](0026-collector-unit-coverage.md#amendment-myjcb-schedule-pages-are-outside-the-coverage-2026-09-27);
  [MyJCB source note](../sources/myjcb.md)

### Context

The round-4 structure survey (2026-09-27, structure and counts only) read
the credit menu `detailMenu.html`. It has nine links, all
`detail.html?detailMonth=N` and all with the text 「明細を見る」, in DOM
order 0, 1, 7, 8, 2, 3, 4, 5, 6. Each sits in a card box under an `h2`:

| `detailMonth` | `h2` heading                                  | box text (values replaced)                  |
| ------------- | --------------------------------------------- | ------------------------------------------- |
| 0, 1          | 「最新のご利用明細」                          | 未確定 / 確定 … お支払い分                  |
| 2–6           | 「過去の明細」                                | … お支払い分 #円, or 「ご請求はありません」 |
| 7             | 「ボーナス#回払い・ショッピングスキップ払い」 | 未確定 … お支払い分ボーナス#回払い          |
| 8             | 「ボーナス#回払い・ショッピングスキップ払い」 | 未確定 ショッピングスキップ払い (no month)  |

`#` stands for a digit or an amount the survey did not record. The page
at position 8 has the h1 「ショッピングスキップ払いご利用明細(未確定分)」
and a `div.detail-list-01` grid with the third header
(「ご利用日」 / 「ご利用先など お支払日」 / 「今後のお支払い金額」) over two
rows. Position 7 has not been observed with rows.

After amendment (b), a position whose ledger shows rows under the third
header is stored unread (`scheduled_payments_page`) and the connection goes
on, but it stays `partial`. Registration turns a `partial` unit into a
`failed` unit report, so the run is `partial` and `not_eligible` and nothing
of it is parsed (ADR 0026). While a skip payment is outstanding, position 8
shows rows on every night, so no MyJCB run is parsed at all, including the
months that were read whole.

### Options considered

1. **A: read the menu's groups.** The months are the positions under the
   two month headings; the schedule positions are stored as evidence
   outside the unit's coverage. Chosen.
2. **B: parse the ショッピングスキップ払い schedule as a dataset of its
   own.** Deferred to a later PR, and only for pages observed with rows:
   what the rows mean (a payment schedule, instalments still due, whether
   they also appear in a statement month) is not confirmed (ADR 0004), and
   position 7 has never been seen with rows.
3. **C: status quo.** Rejected: every night with an outstanding skip
   payment parses nothing.

### Decision

- **The menu's grouping is read, not guessed.** `readCreditMenuGroups`
  reads every link to `/iss-pc/member/details_inquiry/detail.html` with a
  one- or two-digit `detailMonth` (resolved against the menu's URL, so
  relative, root-relative and absolute hrefs are read alike; a link to
  another page or origin is not a menu position). A link belongs to the
  last `h2` before it in document order. The heading, whitespace removed,
  must be exactly 「最新のご利用明細」 or 「過去の明細」 (months) or
  「ボーナス」, one or more digits, 「回払い・ショッピングスキップ払い」
  (schedule pages; the observed text has a digit where the survey wrote
  `#`). Any other heading, a link before any `h2`, or a position listed in
  both groups stops the connection before its first month with the closed
  code `credit_menu_group_unrecognized` (condition `credit-menu-group`). The
  stop keeps nothing, like every stop before the first month, and logs
  `myjcb-credit-menu-groups` with link counts only, never the heading. It
  replaces `parseCreditMenuMonths`, which also read `detailMonth` values
  outside links; the survey found only links.
- **Months.** The unit's months are the month-group positions and the
  past-months response's available positions, read as before.
  `periodCount` and `capturedMonthCount` count months only. A position the
  past-months response offers that the menu lists as a schedule page is not
  resolved either way: it stops with `credit_past_months`.
- **Schedule pages.** After the last month, each schedule position is
  fetched once, in ascending order, and stored whole, redacted, as
  `credit-schedule-NN.html` (dataset `credit-schedule`, state `unknown`,
  period `detailMonth-N`), whatever it shows. Nothing reads its rows, its
  state or its links. The file name is not a `credit-detail-NN.html`, so no
  registration rule gives it a parser dataset: it is catalogued and sealed
  as evidence, and no parse job is created for it. The summary and the
  manifest record each schedule position as `schedulePages: [{ position,
code }]` with a code from `SCHEDULE_PAGE_CODES`:
  `scheduled_payments_page` (stored) or `schedule_page_fetch` (the fetch or
  decoding failed; nothing stored; logged as
  `myjcb-credit-schedule-page-failed` with the position and code only), and
  `schedulePageCount`, the number stored. The manifest rebuilds both from
  closed values and refuses another code (`manifest_schedule_code_invalid`),
  position (`manifest_stop_position_invalid`) or a count that is not the
  number of stored entries (`manifest_schedule_count_invalid`).
- **Coverage.** A connection is `success`, and its unit `complete`, when
  every month was read whole, whatever the schedule pages showed and
  whether or not they were fetched. A failed schedule page is not a stop,
  not a manifest `failures` entry and not an unread month: the page is
  outside what the unit claims, and its reason is recorded (INV05). A
  connection that stopped at a month reads no schedule page.
- **Unchanged.** A MONTH position whose ledger shows rows under the third
  header is still kept unread with `scheduled_payments_page` in
  `unreadMonths`, and keeps the connection `partial` (amendment (b)); that
  has not been observed. `detailMonth-7` and `detailMonth-8` still never
  resolve to calendar months.

### Consequences

- A night with an outstanding skip payment registers `success` and its
  months are parsed; the schedule page is stored beside them unread.
- Empty schedule pages move from `credit-detail-07.html` and
  `credit-detail-08.html` (read by the statement parser, which found no
  confirmed statement in them) to `credit-schedule-07.html` and
  `credit-schedule-08.html` (read by nothing). Stored runs are not
  rewritten.
- A menu redesign that renames a heading stops the connection before its
  first month and keeps nothing until the new heading is observed and
  recorded here; the log says how many links fell under an unrecognised
  heading.
- Limits: what the schedule rows mean is unconfirmed; position 7 has not
  been observed with rows; whether the digit in 「ボーナス#回払い」 is a
  half-width or full-width character was not recorded, so both are
  accepted. The menu page is stored redacted without `href` attributes, so
  the stored menu cannot show which link opened which position.

### Verification

- `services/collector-myjcb/test/parsers.test.ts`: the synthetic menu
  fixture has the nine links in the observed DOM order under the three
  headings and reads as months 0–6 and schedule pages 7 and 8; headings
  match across whitespace and markup and with any half- or full-width
  digits (a kanji numeral or other character in the count stops); an `h3`
  inside a card box leaves its link under the section's `h2`; an
  unrecognised heading, an unobserved `h2` inside a card box, near misses of the observed texts, a link before any heading
  and a position in both groups stop with `credit-menu-group`, and the
  log carries counts only.
- `services/collector-myjcb/test/credit-statement-state.test.ts`: schedule
  pages are read after the months, stored as `credit-schedule-NN.html`
  with state `unknown` and a relative label, and never counted as months;
  a failed schedule page is recorded and the next one is read; a stopped
  month reads none; an unrecognised heading and a schedule position the
  past-months response offers stop before any month. Through the Worker's
  manual trigger, months 0 and 1 read whole beside a skip page with rows
  and a failed bonus page persist a `complete` unit, the manifest's
  `schedulePages` and `schedulePageCount`, no failure and no unread month,
  and the error body reaches no stored byte, log line or response; an
  unrecognised heading stops with `credit_menu_group_unrecognized` and its
  text reaches nothing.
- `services/collector-myjcb/test/shared-collection.test.ts`: stored and
  failed schedule pages keep the unit `complete` and are named in the
  manifest; an unknown code, position or count, or a count with no
  entries, refuses the plan.
- `services/processor/test/myjcb-shared-r2.test.ts`: the collector's plan
  for a whole connection with a stored schedule page registers and seals,
  has run status `success` and unit report `success`, catalogues the
  schedule page with no dataset, and creates and completes parse jobs for
  the four month artifacts only.
- No production data was read for this amendment; the findings above are
  the owner's agent's structure-only survey.

## Amendment 2026-09-27 (d): a confirmed page under the usage header, proven by the page

- Status: accepted (#336); its premise is withdrawn by
  [amendment (f)](#amendment-2026-09-28-f-ledger-labels-match-across-line-breaks):
  no stored page has shown the variant it accepts. The code stays, unobserved
- Date: 2026-09-27
- Decision owner: the owner chose option 3 below on 2026-09-27; this record
  carries it into the repository.
- Carried by: `provenUsageHeader` and `USAGE_HEADER_REFUSALS` in
  `packages/domain/src/myjcb-statement-page.ts` (`readMyJcbStatementPage`
  `usageHeader`); `myjcbSinglePayment` and `myjcbDisplayQuantity` in
  `packages/domain/src/myjcb-amounts.ts`; `creditStatementState` and
  `parseCreditLedger` in `services/collector-myjcb/src/parsers.ts`;
  `myjcb-credit-ledger@1.2.0` and `myjcb-credit-statement-total@1.2.0` in
  `packages/parsers/src/parsers/myjcb.ts`;
  [MyJCB source note](../sources/myjcb.md),
  [observations](../observations.md#myjcb-a-confirmed-page-under-the-usage-header-ledger-and-statement-parsers-120)

### Context

This ADR accepts a page with the `(確定分)` heading only when its ledger
header shows the confirmed amount label, 「今回のお支払い金額」. A heading over
the unconfirmed header set, 「ご利用日 / ご利用先など / 支払区分 / ご利用金額」,
is a `conflict`: the collector stops the connection at that month
(`credit_statement_state`) and the statement parser fails the page. The
reason is what the fourth label says. It names the one amount the row's
summary shows: this statement's payment under 「今回のお支払い金額」, the usage
amount under 「ご利用金額」. For an installment, revolving or bonus row the
two differ, so reading a 「ご利用金額」 cell as this statement's payment could
be wrong.

A structure-only look on 2026-09-27 (round 4, counts and label shapes only,
no values) found that such pages exist:

- The position-1 page an earlier run stored (the same bytes on three nights)
  has the `(確定分)` heading and the unconfirmed header set. Counted by label,
  「今回のお支払い金額」 occurs 0 times and 「ご利用金額」 11 times.
- The live page of the same position on 2026-09-27 showed 「今回のお支払い金額」.
  So the label a closed month shows varies between nights or sessions. Why it
  varies is not known.
- The page states its own total: `div.detail-box-price-01 dl`, with the `dt`
  「YYYY年M月D日(曜)お支払い金額合計」 and the `dd` 「#,###円」. The statement
  parser already reads this total.

The runs of 2026-09-25 and 2026-09-26 stopped at position 1 and kept no page
(amendment (b), finding 3). A page of this shape is the likely cause. It is
not confirmed, because the pages of those nights were not stored.

### Options considered

1. Accept the heading over the usage header unconditionally. Rejected: an
   installment, revolving or bonus row's usage amount is not this
   statement's payment, and nothing would check it.
2. Keep stopping on it (the status quo). Rejected by the owner: whenever the
   provider shows this form, the connection loses that month and every later
   one, and a month with only single-payment rows is refused for a label that
   says nothing false about it.
3. Accept it only when the page itself proves that its usage amounts are this
   statement's payment. Otherwise keep stopping. Chosen.

### Decision

A page with exactly one `(確定分)` heading, whose ledgers all show the
unconfirmed header, is read `confirmed` only when its rows are all in its
first `detail-list-01` and both of these hold. Otherwise it stays
`conflict` and stops exactly as before.

0. **The rows are the ones the collector stores.** `parseCreditLedger`
   stores the first ledger of a page only (as it always has). A page whose
   other `detail-list-01` has rows is refused,
   `usage_header_rows_outside_first_ledger`, even when those rows would
   complete the sum: accepting it would publish a proven total over a
   stored ledger that lacks some of the rows. A second ledger without rows
   changes nothing.
1. **Every row is one single payment.** A row's payment type is read with
   the grammar card purchase recognition reads the same cell with
   (`myjcbSinglePayment`, now in `packages/domain/src/myjcb-amounts.ts`). The
   cell is the combined 「ご利用先など／支払区分」 cell (`summaryCells[1]`). The
   rule is that at least one payment count is present, every count is 1,
   and no 分割, リボ, ボーナス or キャッシング appears. The count may be written
   `1回払` (the form every production row shows), `1回払い` or `一回払い`, and
   full-width digits are allowed. No new label is added. A row that is 分割,
   リボ, ボーナス or 2回払, a cell with no payment type or an empty one, or a
   row whose four cells cannot be read, is refused:
   `usage_header_payment_type_unproven`.
2. **The rows add up to the page's total.** Each row amount is the one cell
   of the third and fourth that reads as an exact JPY amount, as the ledger
   parser reads it. The amounts are added exactly with `sumQuantities`
   (INV03) and compared with the one 「…お支払い金額合計」 total on the page.
   No total, more than one, or an unreadable one is refused:
   `usage_header_total_missing`. A row amount that does not read, or a sum
   that differs from the total, is refused: `usage_header_total_mismatch`.
   A refund row is added with its sign. A ledger without rows proves only a
   zero total.

The checks run in this order, so a page always reports the same code. The
codes are a closed list (`USAGE_HEADER_REFUSALS`). `readMyJcbStatementPage`
returns `usageHeader`: `proven`, a refusal code, or `null` for every other
page. The collector's stop log and its unstated-page log carry this field,
beside the existing counts and label codes. No amount is logged.

When the page is proven:

- **Collector.** `creditStatementState` returns `confirmed`, and the
  position rules are unchanged. Position 0 still stops on any closed page.
  `parseCreditLedger` stores the header set the page shows, the unconfirmed
  one. The expanded labels are a confirmed page's (「ご利用金額」, 摘要, 今回回数,
  備考, 訂正サイン): the stored page shows 「ご利用金額」 and no
  「今回のお支払い金額」 anywhere. Called on an unproven page, it still refuses
  it (`credit-ledger-headers`).
- **Ledger parser (`myjcb-credit-ledger@1.2.0`).** A `confirmed` ledger may
  carry the unconfirmed header set. Its amount cell is read as the usage
  amount it is labelled as: `amountBasis: "confirmed-usage"` and
  `usageAmountText`. It records no `paymentAmountText`. Nothing on the row
  states this statement's payment for the row, and the proof is about the
  page, not about each row. Every other header and state pair is read as in
  1.1.2, and an unconfirmed ledger under the confirmed header is still
  refused.
- **Statement parser (`myjcb-credit-statement-total@1.2.0`).** The page
  yields its total. The observation records
  `statementStateBasis: "page-heading-usage-total-proof"` and
  `ledgerAmountLabel: "ご利用金額"`. A page under the confirmed header is
  recorded exactly as in 1.1.0, with `page-heading` and no new key.
- **Downstream.** The statement's payment is the page total. Card
  settlement matching and `card_statement_facts` read it from the statement
  parser, as for every confirmed page. Card purchase recognition reads the
  row through its one MyJCB amount rule (`myjcbAgreedAmount`), which needs a
  usage text and a payment text that agree. The row has no payment text, so
  it is excluded `payment_split_unknown`, and pending-to-posted matching
  never compares it (`comparableCardPayment`). Recognition is not loosened
  here. Counting such a row as a captured purchase would claim a per-row
  payment the page does not state (see "Why the proof does not make each
  row's payment its usage" below).

The MyJCB cell grammars (`myjcbSinglePayment`, `MYJCB_NOT_SINGLE_WORDS` and
the display-amount reader) move from `card-purchase.ts` to
`myjcb-amounts.ts`, and `card-purchase.ts` re-exports them. The MyJCB
parsers' code digest covers every module they import. With the move, that
set is this module and `values.ts`, not the whole recognition module. All
four MyJCB parsers share `myjcb.ts`, so all four change digest. The
past-month and evidence-boundary parsers move to 1.1.3 with no change in
behaviour.

### Why the proof does not make each row's payment its usage

The proof establishes two page-level facts: every row's 支払区分 reads one
single payment, and the rows' usage amounts add up exactly to the page's
payment total. It does not establish, row by row, that this statement pays
each row's usage amount, and the repository does not accept that inference
anywhere today:

- Recognition already reads the same 1回払 grammar on confirmed rows under
  the confirmed header, and still requires the row's own usage text
  (expanded 「ご利用金額」) and payment text (「今回のお支払い金額」) to agree
  (`myjcbAgreedAmount`; [economic events](../economic-events.md#single-payment-per-source):
  "the amount rules still follow the payment type"). ADR 0004 trusts the
  observed 1回払 wording for the payment type only; that a 1回払 row's
  payment always equals its usage has not been observed as a rule or
  confirmed by the owner, so it stays unsupported.
- An equal sum does not imply equal parts. It would only if the page's total
  were exactly the sum of its rows' payments (no fee, adjustment or carried
  amount outside the rows, and no rows outside the stored ledger) and no
  1回払 row paid more than its usage this statement. Neither premise is
  observed: what the second `detail-list-01` of the stored page holds is
  unknown, and the page's rows were counted, not read.

So the rows stay excluded (`payment_split_unknown`); they are never
guessed, and never counted twice. The follow-up that could lift this is a
separate decision with its own evidence: a count-only survey of stored
confirmed rows under the confirmed header (how many 1回払 rows have usage
equal to payment, and whether any differ), and a structure-only reading of
what the second `detail-list-01` holds. If both support it and the owner
confirms, a proven `confirmed-usage` row could carry the proof as its
amount check and be recognised with one live holder per recognition key
(INV06), whichever header the month was captured under.

### Consequences

- A night whose position-1 page shows the usage header over single-payment
  rows that add up to the total no longer stops. The month is `confirmed`,
  its total is published, and later months are read. A month with any
  installment, revolving or bonus row under that header still stops, as
  before.
- The rows of such a month are recorded but not recognised as purchases
  (`payment_split_unknown`). The pending rows of the same purchases,
  captured earlier at position 0, follow the existing rules for pending
  rows ([ADR 0016](0016-myjcb-pending-statement-slots.md)); no captured
  event from this month replaces them. The captured total therefore
  undercounts such a month's purchases; it never double-counts them. A
  month already recognised from an earlier night's confirmed-header
  capture is superseded by a later usage-header capture of the same period
  (`superseded_representation`). When a row's cells and expanded values
  are the same under both headers, its external id is the same, and its
  event keeps its last revision (a current row that can no longer be
  recognised); when they differ, the event is retired to `unknown` with no
  leg. Either way it is churn, never a double count. Recognising them would need a
  per-row payment the page does not state, and that is a separate decision.
- In the activity view the rows fall under the MyJCB ledger's catch-all
  metric (`card.statement-line`) and the label 「明細の記録額（内訳未判定）」,
  because no metric names `confirmed-usage`.
- Stored pages are not rewritten. On the next sweeps, the repair lane
  re-parses the stored MyJCB artifacts under the new releases. A stored
  closed page under the usage header that 1.1.0 failed as a conflict, in a
  run that is eligible for parsing, publishes its total at 1.2.0 when the
  page proves it. Which stored pages
  do was not surveyed. Stored ledgers were written before this amendment
  and never carry the confirmed state with the usage header, so their rows
  parse as before.
- Limits: why the provider shows 「ご利用金額」 on a closed month on some
  nights is unknown. Whether the second `detail-list-01` on the stored page
  is a second part of the statement is unknown. The stored ledger artifact
  holds the first ledger only, as before, so the proof refuses a page with
  rows in any other ledger (`usage_header_rows_outside_first_ledger`); if
  the stored page's second ledger has rows, that page still stops. The
  expanded
  labels of such a page were counted, not read row by row. That the
  09-25/26 stops had this cause is likely, not confirmed.

### Verification

- `services/collector-myjcb/test/credit-statement-state.test.ts`: a proven
  page (single-payment rows including a refund, sum equal to the total, and
  a total with full-width digits and spaces) is `confirmed` at positions 1,
  2 and 5, also with a second ledger that has no rows, and its ledger
  stores the unconfirmed header set with a confirmed page's expanded
  labels. Each refusal stops with `credit_statement_state` and logs its
  code, with no amount or provider text in the log: rows in a second
  ledger (under the usage header or no amount label, even when they
  complete the sum), a 分割,
  2回払 or リボ row, a cell with no payment type, an empty cell, a
  three-cell row, no total, two totals, an unreadable or empty total, a sum
  off by one yen, an unreadable row amount, and an empty ledger. Position 0
  still stops. The same rows without the heading are `unconfirmed`. A second
  heading, or a second ledger under the confirmed header, is still a
  conflict (`usageHeader: null`). Through `collectCredit`, a proven month is
  stored `confirmed` with the header it shows, and an unproven one stops
  the connection at that month.
- `packages/parsers/test/myjcb-statement.test.ts`: statement parser 1.2.0
  publishes the total of a proven page with the new basis and label. A
  confirmed-header page has neither key. An installment row, a missing
  payment type, a mismatched or missing total, an empty ledger and rows in a
  second ledger all fail as conflicts. A confirmed-header page's whole
  result, key order included, is the 1.1.0 result. Ledger parser 1.2.0 reads a confirmed ledger under the usage
  header as `confirmed-usage` with no `paymentAmountText`. The other pairs
  are read as in 1.1.2, and the confirmed state with the unconfirmed
  expanded label is refused.
- `services/processor/test/card-purchase-parser-shapes.test.ts`: such a row,
  parsed by the deployed ledger parser, carries the observed usage amount
  and no payment amount. Recognition excludes it `payment_split_unknown`,
  and the matching guard does not compare it.
- The existing conflict, unconfirmed and unknown cases in these files pass
  unchanged.
- No production data was read for this amendment. The findings above are
  the owner's agent's structure-only survey; every test value is synthetic.

## Amendment 2026-09-27 (e): the skip-payment schedule page is read as scheduled payments

- Status: accepted (#338); the empty-row rule and the parser version are
  amended by (f)
- Date: 2026-09-27
- Decision owner: the owner chose option B of amendment (c), after option A,
  on 2026-09-27, only for pages observed with rows; this record carries it
  into the repository.
- Carried by: `myjcbSchedulePageKind`, `readMyJcbSkipPaymentSchedule` and
  `SKIP_PAYMENT_SCHEDULE_REFUSALS` in
  `packages/domain/src/myjcb-skip-payment-schedule.ts`; `schedulePageKind`
  in `services/collector-myjcb/src/parsers.ts` and `collectCredit` in
  `services/collector-myjcb/src/collector.ts`; the `credit-skip-payment-NN.html`
  rule in `packages/application/src/collection/descriptors.ts`;
  `myjcb-skip-payment-schedule@0.1.0` in
  `packages/parsers/src/parsers/myjcb-skip-payment-schedule.ts`;
  `ScheduledPaymentObservation` in `packages/parsers/src/scheduled-payment.ts`;
  `fields.scheduled_payment` and `scheduledPaymentRows` in
  `services/processor/src/worker.ts`; migration
  `0061_scheduled_payment_observations.sql`; the classifier branch in
  `services/processor/scripts/parser-rejection.ts`;
  [MyJCB source note](../sources/myjcb.md),
  [observations](../observations.md#myjcb-the-skip-payment-schedule-page-is-read-as-scheduled-payments-schedule-parser-010),
  [parser coverage](../parser-coverage.md)

### Context

Amendment (c) stores every menu schedule page whole and reads none. The
round-4 structure survey (2026-09-27, structure and counts only) recorded
the page at position 8:

- the h1 「ショッピングスキップ払いご利用明細(未確定分)」, and a second heading
  「YYYY年M月D日(曜)時点のショッピングスキップ払いご利用明細(YYYY年M月以降のお支払い分)」;
- one `div.detail-list-01` ledger whose `div.head` has three cells:
  「ご利用日」 / 「ご利用先など」 and 「お支払日」 on two lines of one cell /
  「今後のお支払い金額」, over two body rows;
- before it the notice `p.em-02` that the page shows usage before the bill is
  settled, the month-switch form and a link about unrecognised charges;
  after it 「利用覚えのない請求がある場合」 and the 「カード情報」 table.

The survey recorded the body rows as a count only: what the body cells
contain, and how many there are, was not recorded. The page at position 7
(ボーナス払い) has never been observed with rows.

The rows are future payments of purchases whose payment was deferred. They
are not purchases to recognise (the purchases are the usage rows of the
statement months), not rows of a confirmed statement, and not a balance.

### Options considered

1. **Leave the page unread** (amendment (c)). Rejected by the owner: the
   page is the only place the provider states the deferred payments.
2. **Read the rows as transactions** (`transaction_observations`). Rejected:
   every transaction reader would see them. The activity read
   (`TRANSACTIONS_SQL`) lists every parser's rows except the ones it names,
   so they would appear as activity and would need a rewrite of shipped
   query text; purchase recognition and settlement matching would have to
   be taught to skip them (INV06).
3. **Read them as balances.** Rejected: the latest-balance read keeps one
   value per account and metric, so two rows would collapse into one, and
   the metric would be shown as a balance.
4. **A fifth observation kind, `scheduled_payment`, in a table of its own.**
   Chosen. Nothing that reads transactions, balances, positions or
   valuations reads it, so nothing is counted twice and nothing adopted
   changes (INV07). Declaring the kind in the parser contract's `types.ts`
   was rejected: every parser's code digest covers that file, and migration
   0028 refuses the same parser name and version with another digest, so it
   would re-identify every deployed parser. The kind is declared in its own
   module, which only the new parser and the processor import.
5. **Read every schedule page, and let the parser refuse the others.**
   Rejected: registration gives datasets by artifact key, and the bonus page
   is fetched every night, so it would fail a parse job every night.

### Decision

- **The collector names the page by its h1.** After the months, each
  schedule page is still fetched and stored whole, redacted, with state
  `unknown` and period `detailMonth-N`, and recorded in `schedulePages` as
  before. A page with exactly one h1 that is, after whitespace removal,
  「ショッピングスキップ払いご利用明細(未確定分)」 (`myjcbSchedulePageKind`) is
  stored as `credit-skip-payment-NN.html`; every other page (the ボーナス払い
  page, a page with no or two such headings, a full-width variant) keeps the
  name `credit-schedule-NN.html`. Nothing else on the page is read for the
  name, and the manifest, the codes and the coverage are unchanged: the unit
  is `complete` whatever the schedule pages show (amendment (c)).
- **Registration.** `credit-skip-payment-NN.html`
  (`sanitized_provider_capture`, `text/html`) gets the dataset
  `credit-schedule`; `credit-schedule-NN.html` still gets none and no parse
  job.
- **Parser `myjcb-skip-payment-schedule@0.1.0`.** It accepts MyJCB
  `credit-schedule` HTML, requires a failure-free run (or a unit-scope
  admission), the key `<connection>/credit-skip-payment-NN.html`, state
  `unknown` and period `detailMonth-N`, and the redaction boundary of the
  other MyJCB page parsers. It reads only the observed shape
  (`readMyJcbSkipPaymentSchedule`), in this order, and refuses any other
  with one closed code:
  - exactly one h1 with the skip heading, else `schedule_kind_unobserved`;
  - at least one `detail-list-01`, else `schedule_ledger_missing`; at most
    one with rows, else `schedule_ledger_ambiguous`;
  - the ledger's `div.head` is exactly the three observed `cell`s (the one
    with rows, or every ledger when none has rows), else
    `schedule_head_unobserved`; a four-cell head is refused here;
  - at most 1,000 rows, else `schedule_row_limit`;
  - a page with rows names exactly one as-of heading (any `h1`–`h6`) whose
    date and month are on the calendar, else `schedule_as_of_invalid`; a
    page with no rows may omit it;
  - the ledger read (the one with rows, or every ledger when none has
    rows) has as element children its `head` first and then only `content`
    rows, else `schedule_row_shape_unobserved`: rows nested anywhere else
    are refused, never read as an empty ledger (INV05);
  - each row is one `item-cell` of exactly three `cell`s whose middle cell
    renders exactly two non-empty lines (a `br` ends a line, a block element
    starts and ends one), else `schedule_row_shape_unobserved`. The body
    layout was not recorded; this is the one that mirrors the observed head.
    The first line is the merchant text (ご利用先など), the second the payment
    date (お支払日), as the head's two lines name them;
  - the usage date and the payment date are `YYYY/MM/DD` on the calendar,
    else `schedule_date_invalid`;
  - the amount reads as an exact JPY amount with the MyJCB display grammar
    (`myjcbDisplayInteger`), else `schedule_amount_invalid`.

  Its own checks throw `schedule_run_ineligible`,
  `schedule_artifact_metadata_invalid` and `schedule_html_boundary`. Every
  message is one of these codes (`SKIP_PAYMENT_SCHEDULE_PARSER_CODES`), and
  the read-only rejection classifier prints the code and nothing else. A
  ledger with no rows (the known empty row included) is zero observations,
  not a failure.

- **Observation.** Each row is one `scheduled_payment` observation:
  `source_account` `myjcb:<connection>:root`, `external_id`
  `myjcb-skip-payment:<fingerprint of the three displayed cells>:<occurrence>`
  (the as-of date is not part of it, so a row keeps its id across nights),
  `schedule_kind` `card-skip-payment`, `usage_date`, `due_date` (the payment
  date), `amount_text` as an exact integer decimal with the displayed sign
  and `amount_scale` 0, `currency` JPY, `counterparty` the merchant text,
  `as_of` the page's as-of date, and in `extra_json` the displayed cells and
  `_kogane.paymentFromMonth` (the 「YYYY年M月以降のお支払い分」 month),
  `detailMonth` and `amountBasis` `future-payment-amount`.
- **Storage.** Migration 0061 adds `scheduled_payment_observations`,
  append-only (`*_no_update`, `*_no_delete`), with an index on
  `parse_run_id`, closed checks on the kind, the date shapes, a canonical
  integer `amount_text` and `amount_scale` 0, and no float or minor-unit
  column (INV03). It is classified `core-keep` with the other observation
  tables. The processor writes it in the same pending parse run as the other
  kinds, so it is visible only once the parse run is published.
- **The boundary check.** Because the kind is declared outside the parser
  contract's `Observation` union and reaches it through a cast
  (`scheduledPaymentsAsObservations`), the type system does not check what
  is persisted as `scheduled_payment`. The processor checks it instead
  (`scheduledPaymentRows`), after the parse and before anything is written:
  a row of that kind from any parser other than
  `myjcb-skip-payment-schedule`, or with any key other than the declared
  ones, an empty text field, a date that is not a calendar `YYYY-MM-DD`, an
  `amount_text` that is not a canonical integer, a scale other than 0, a
  currency other than JPY, a schedule kind other than `card-skip-payment` or
  an `extra` that is not an object, fails the parse with
  `parse_contract_invalid`. The table's CHECKKs stay the last line. This is
  a deliberate trade: the four older kinds are checked by the type system
  and the tables only, this one by a runtime check and the table, until a
  parser contract release widens the union.
- **Nothing downstream reads it.** No read path, purchase recognition,
  settlement candidate, identity run, release comparison, decimal
  projection or explanation reads the table.

### Consequences

- A night with an outstanding skip payment stores its rows as scheduled
  payments beside the months; the months are parsed as before, and the unit
  stays `complete`.
- A page in any other shape fails its parse job with a closed code and stays
  stored; the months are unaffected. If the body cells differ from the
  mirrored layout (a detail list under each row, four cells, the payment
  date in its own cell), the first production parse fails with
  `schedule_row_shape_unobserved`, and the shape is read in a structure-only
  survey before a new release.
- The ボーナス払い page stays stored as `credit-schedule-07.html` and unread
  until it is observed with rows (ADR 0004).
- Skip pages stored before this amendment are named `credit-schedule-NN.html`
  and stay unread: the key does not say which kind they are, and stored
  runs are not rewritten.
- Limits: what a row's amount covers (one deferred payment, or the rest of
  it) and whether a row's payment later appears in a statement month is not
  confirmed, so rows are not matched against statements, settlements or
  purchases. No read model, API or UI shows scheduled payments yet. A
  candidate release of this parser is not compared by release adoption,
  whose comparison reads the four older tables only. The kind has no identity
  run or account mapping. Whether the headings use half-width parentheses
  was recorded as half-width and is matched exactly.

### Verification

- `packages/parsers/test/myjcb-skip-payment-schedule.test.ts` on synthetic
  pages (`myjcb-skip-payment-fixture.ts`): two rows become two scheduled
  payments with exact decimal text, the page's dates and months, distinct
  ids, and ids that do not change with the as-of date; the whole 0.1.0
  observation is frozen; a refund keeps its sign; the middle cell may split
  on a `br` or on block elements; an empty ledger is zero rows with or
  without the as-of heading; one case per closed code reaches it (a bonus
  heading, two skip headings, no ledger, two ledgers with rows, a four-cell
  head, 1,001 rows, a missing or impossible as-of date, a four-cell or
  one-line row, an impossible date, a missing amount, an ineligible run,
  wrong key, period or state, a link in the page, a fragment, rows nested
  under a wrapper, a stray element beside an empty ledger), and no
  message carries a date, merchant or amount. Only this parser accepts the
  metadata, and its digest is recorded.
- `services/collector-myjcb/test/parsers.test.ts`: only exactly one h1 with
  the observed heading is `skip-payment`; a bonus heading, none, two, the
  full-width parentheses, the heading without 「(未確定分)」 and an `h2` are
  `unobserved`. `credit-statement-state.test.ts`: the skip page is stored
  as `credit-skip-payment-08.html` and the bonus page as
  `credit-schedule-07.html`, through `collectCredit` and through the
  Worker's manual trigger.
- `scripts/artifact-datasets.test.ts`: `credit-skip-payment-08.html` gets
  `credit-schedule`, `credit-schedule-07.html` gets none, and a parser
  accepts the dataset.
- `services/processor/test/myjcb-shared-r2.test.ts`: the collector's plan
  for a whole connection with a bonus page and a skip page registers, gives
  only the skip page the dataset, and creates and completes a
  `myjcb-skip-payment-schedule@0.1.0` job for it and none for the bonus
  page; the two rows land in `scheduled_payment_observations` with the
  synthetic dates, amounts and months, the parser wrote no row to any other
  observation table, and the table refuses `UPDATE` and `DELETE`. A page
  stored under the old name gets no dataset (amendment (c)'s test). The
  boundary check accepts the declared row and refuses it from another
  parser and with each malformed field.
- `services/processor/test/parser-rejection.test.ts`: every refusal
  classifies as exactly the code it threw; any other message prints
  `parser_rejected_other`.
- `services/processor/test/lanes.test.ts`: the migration list ends at 0061.
- No production data was read for this amendment. The findings above are the
  owner's agent's structure-only survey; every test value is synthetic.

## Amendment 2026-09-28 (f): ledger labels match across line breaks

- Status: accepted (#358); the MyJCB statement parser releases are amended by (g)
- Date: 2026-09-28
- Carried by: `compactText` and `parseCreditLedger` in
  `services/collector-myjcb/src/parsers.ts`; `ledgerRows`,
  `isEmptyLedgerRow` and `EMPTY_LEDGER_LABEL` in
  `packages/domain/src/myjcb-skip-payment-schedule.ts`;
  `myjcb-skip-payment-schedule@0.1.1` in
  `packages/parsers/src/parsers/myjcb-skip-payment-schedule.ts`;
  [MyJCB source note](../sources/myjcb.md),
  [observations](../observations.md#myjcb-confirmed-months-stopped-on-a-line-break-in-the-ledger-header-schedule-parser-011)

### Context

The owner's agent surveyed the stored MyJCB pages on 2026-09-28 (round 5:
R2 objects read through the evidence browser, structure and counts only,
no values) and read the collector's stop logs for the three nightly runs of
2026-09-25 to 09-27 (UTC; the mornings of 09-26 to 09-28 in Japan).

1. **Why every night stopped at position 1.** Each of the three nights
   stopped with `ledger_parse` and the sub-code `credit-ledger-headers` at
   position 1. Every stored confirmed page (8 distinct pages over the stored
   runs) shows its third head cell as
   `今回の<br class="pc-none">お支払い金額`: the label broken by a line
   break that only narrow screens render. The collector's `nodeText` joins
   child nodes with a space, and `parseCreditLedger` collapsed whitespace to
   one space before `includes("今回のお支払い金額")`. The header read
   「今回の お支払い金額」, the check failed, and every confirmed month
   stopped the connection. Position 0's 「ご利用金額」 has no `br`, so it
   passed. The shared page reading (`readMyJcbStatementPage`) and
   `myjcb-credit-statement-total` already compare head labels with all
   whitespace removed, so they read the same pages as confirmed; the ledger
   parser reads the collector's JSON, whose `headers` are the collector's
   constant set, and never compares page text.
2. **The 「ご利用金額」 header on a confirmed page was never there.**
   Amendment (b) finding 3 and amendment (d) counted 「今回のお支払い金額」 0
   times and 「ご利用金額」 11 times on a stored `(確定分)` page. The 11 were
   the label of each row's expanded `item-more` list, and the 0 was the
   `br`. No stored confirmed page has a 「ご利用金額」 head. The variant
   amendment (d) accepts is unobserved.
3. **Empty schedule pages.** The stored skip-payment page (position 8, 12
   nights) and the ボーナス払い page (position 7, the same bytes on 12
   nights) both show one `div.detail-list-01` with a three-cell head and
   exactly one `content` row: one `item-cell` holding one
   `div.cell.w-100per` with the provider's empty label
   「ご利用明細はございません。」, and no `item-more`. The bonus page's h1 is
   「ボーナス#回払いご利用代金明細(未確定分)」 (# one digit), and its head
   cells are 「ご利用日」 / 「ご利用先など」+「支払区分」 (two `span.row` in one
   cell) / 「ご利用金額」. The skip-payment reader of amendment (e) read this
   page as zero rows, but by a loose rule shared with the statement reading:
   an empty wording anywhere in the ledger, and any row with one `w-100per`
   cell, was dropped, so the empty row beside real rows would have hidden
   nothing but read the rest.
4. **`myjcb-skip-payment-schedule@0.1.0` is registered.** Production has no
   parse run or job of it (no skip page was fetched after it deployed,
   because every night stopped at position 1), but `parser_releases` holds
   0.1.0 with its digest. Migration 0028 refuses the same name and version
   with a different digest, so any change to its sources is a new version.

### Options considered

1. **A: compare labels with all whitespace removed.** The collector matches
   header labels (and headings) on text with every whitespace character
   removed, as the shared page reading already does. Chosen. Only
   whitespace is ignored; a different word still stops. Because `nodeText`
   puts a space at every element boundary, the boundaries are ignored too:
   a label split over elements matches.
2. **B: read text the way a browser's `innerText` does** (a `br` becomes a
   newline, CSS decides which elements break). Rejected: it needs layout
   rules the collector does not have (`pc-none` is a CSS class), and
   the labels would still need whitespace-insensitive matching.
3. **C: keep failing.** Rejected: every night stops at the first confirmed
   month and the connection keeps only position 0.

For amendment (d)'s acceptance path: removing it touches
`packages/domain/src/myjcb-statement-page.ts`, which is in the digest
closure of all four released MyJCB parsers (`myjcb-credit-ledger@1.2.0`,
`myjcb-credit-statement-total@1.2.0`, `myjcb-credit-past-month-balances@1.1.3`,
`myjcb-canonical-evidence-boundary@1.1.3`). Removing it means four new
releases and a repair-lane re-parse of every stored MyJCB artifact, with no
change in any observation, because no stored page takes the path. It is
kept, and recorded as unobserved.

### Decision

- The collector compares every provider label it matches (the ledger header
  labels, the menu's `h2` headings, the statement-month `h2`) on the node's
  text with all whitespace removed (`compactText`). `nodeText` is
  unchanged, and cell values keep their space-joined text
  (`normalizeText`), so a stored ledger row reads exactly as before. The
  expanded-label lookup (`findLabelValue`) is unchanged: its observed labels
  have no line break.
- `packages/domain/src/myjcb-statement-page.ts` is not changed: it already
  removes whitespace before it compares a head label.
- The skip-payment reader treats a ledger as empty only when its one
  `content` row is the observed empty row: the row's only element child an
  `item-cell`, whose only element child is one `div.cell.w-100per` showing
  exactly 「ご利用明細はございません。」 after whitespace removal. In every
  other ledger each `content` row is a row, the empty row included, so the
  empty row beside real rows fails the row check
  (`schedule_row_shape_unobserved`), a mix nobody has observed. The release
  is `myjcb-skip-payment-schedule@0.1.1`; every observation it writes is the
  same as 0.1.0's.
- The collector's row counts (`scheduledLedgerRowCount`,
  `creditPageRowCount`) keep the shared page reading: the observed empty
  row counts zero, and beside real rows it is dropped while the real rows
  are counted, so the page is kept unread, never read as empty.
- The ボーナス払い page stays `credit-schedule-07.html`, unread
  (`schedule_kind_unobserved` if it reached the parser): it has been
  observed only empty.
- Amendment (d)'s acceptance path stays in code, unobserved: no stored page
  has a `(確定分)` heading over a 「ご利用金額」 head.

### Consequences

- The first night after deployment reads position 1 and later confirmed
  months as `confirmed` and stores their ledgers under the confirmed header
  set, as the ledger parser has always expected. Months 2 to 6 and the
  schedule pages are fetched again.
- Amendment (d)'s premise is withdrawn. Its code accepts a variant that has
  not been observed; it never ran on a stored page, and nothing it records
  (`confirmed-usage`, `page-heading-usage-total-proof`) exists in
  production. Under ADR 0004 it would not be written today. It is removed
  the next time the MyJCB parsers are released for another reason.
- Amendment (b)'s finding 3 is reinterpreted: the stops of the three runs
  were this `br`, not a page that varies between nights. The 09-25 and 09-26
  pages were not stored; their stop code is the same, and every stored
  confirmed page has the `br`.
- The stored skip-payment and bonus pages still read as empty. A stored page
  whose empty row is not the one observed (another wording, a second cell,
  another element) is a row, and fails its parse with a closed code instead
  of reading as empty (INV05).
- Limits: labels are matched with `includes` on the whole head's compacted
  text, so a label split over two adjacent head cells matches as one label,
  exactly as `readMyJcbStatementPage` already reads it. The per-row checks
  (four summary cells, `credit-ledger-cell-count`) are unchanged. Whether a
  skip page with rows also shows the empty row is not
  observed (refused if it does). The live skip page with rows (round 4) was
  not stored, so its body cells are still unobserved (amendment (e)).

### Verification

- `services/collector-myjcb/test/credit-statement-state.test.ts`
  (「ADR 0005 amendment (f)」): a confirmed page whose head is the observed
  three cells with `今回の<br class="pc-none">お支払い金額` is `confirmed`,
  its ledger is read under the confirmed header set with cell values
  space-joined as before, and `collectCredit` stores it at position 1 with
  no stop; a `br` inside 「ご利用先など」, 「支払区分」 or 「ご利用日」 is matched
  the same way; a different word, or a missing character, still stops with
  `credit-ledger-headers`; the observed empty schedule ledger counts zero
  scheduled rows and the empty row beside a real row counts one. Without
  the collector change, three of these fail with the production stop.
- `packages/parsers/test/myjcb-statement.test.ts`: the statement parser
  (1.2.0, unchanged) reads the observed head as confirmed.
- `packages/parsers/test/myjcb-skip-payment-schedule.test.ts`: the stored
  empty shape (head with `span.row`, the lone empty row) is zero rows with
  or without the as-of heading; the empty row before or after real rows,
  and a lone one-cell row with another wording, are refused with
  `schedule_row_shape_unobserved`; the bonus page as stored (its h1 and
  head, the lone empty row) is `schedule_kind_unobserved`; 0.1.1's whole
  observation equals 0.1.0's frozen one.
- `mise run //packages/parsers:digests`: only `myjcb-skip-payment-schedule`
  changes digest (0.1.1); the four MyJCB statement parsers keep theirs.
- `services/processor/test/myjcb-shared-r2.test.ts`: the skip page job runs
  under 0.1.1.
- Production was read only as metadata: the `parser_releases` rows of the
  MyJCB parsers (names, versions, digest prefixes, times). The findings in
  the context are the owner's agent's structure-only survey; every test
  value is synthetic.

## Amendment 2026-09-28 (g): the statement heading may carry its payment day

- Status: accepted (#360); its limit on the bonus page's dated `h2` is
  corrected by (j): the page was stored as a month, and 1.4.0 refuses it
- Date: 2026-09-28
- Carried by: `readMyJcbStatementHeading` in
  `packages/domain/src/myjcb-statement-heading.ts`; `statedPaymentMonths`
  and `creditStatementPeriod` in `services/collector-myjcb/src/parsers.ts`;
  `myjcb-credit-statement-total@1.3.0` in
  `packages/parsers/src/parsers/myjcb.ts`;
  [MyJCB source note](../sources/myjcb.md),
  [observations](../observations.md#myjcb-confirmed-months-stopped-on-a-dated-statement-heading-statement-parser-130)

### Context

1. **The run after amendment (f) stopped one step later.** The nightly run
   of 2026-09-28 21:01Z, the first after amendment (f) deployed, stopped at
   credit position 1 with `credit_statement_period`. The night before, it
   had stopped at the same position with `ledger_parse`, which amendment (f)
   fixed. The ledger header now matches, and the page's month is the next
   check.
2. **The confirmed page's heading carries a day.** The owner's round-5
   structure survey (the stored position-1 page of the 09-27 run, structure
   only, no values) shows the confirmed page's `h2` as
   「YYYY年MM月DD日(曜)お支払い分のカードご利用明細」: the payment day and a
   one-character weekday in parentheses before お支払い分. The stored
   ボーナス払い schedule page's `h2` has the same dated form. The collector
   and the statement parser matched only
   「YYYY年M月お支払い分のカードご利用明細」, so the collector found no stated
   month. Position 1 has no past-months `settlementYM`, so
   `creditStatementPeriod` stopped the connection
   (`credit-statement-period`), and `myjcb-credit-statement-total@1.2.0`
   would have failed the page ("statement period missing or ambiguous").
3. **The undated heading exists too.** Production has 24 `ok` parses of
   `myjcb-credit-statement-total@1.2.0` with no warning. Each of them passed
   the undated heading match, so earlier stored confirmed pages show the
   undated form. Both forms have been observed.
4. **The page's own total label is already dated.** The parser reads the
   total as 「YYYY年M月D日(曜)お支払い金額合計」 (ASCII parentheses, one of
   月火水木金土日, no NFKC), and the skip-payment page's as-of heading
   (amendment (e)) is written the same way.
5. **All four MyJCB statement parsers share one module.**
   `myjcb-credit-ledger`, `myjcb-credit-statement-total`,
   `myjcb-credit-past-month-balances` and
   `myjcb-canonical-evidence-boundary` are defined in
   `packages/parsers/src/parsers/myjcb.ts`, so they have one source closure
   and one code digest. Any change to the statement parser changes all four
   digests, and migration 0028 refuses a changed digest under a registered
   version.

### Options considered

1. **A: read both forms, and compare the day with the total.** One shared
   reading (`readMyJcbStatementHeading`) accepts exactly the undated form and
   the dated form written like the total label. The collector records the
   month. The parser also requires the heading's day to be the total's
   payment date. Chosen.
2. **B: match the month prefix and ignore the rest.** Rejected: any text
   after 「YYYY年M月」 would name a month, including shapes nobody has
   observed (ADR 0004).
3. **C: normalize with NFKC and accept full-width parentheses and digits.**
   Rejected: neither the heading nor the total label has been observed with
   them, and the total label is matched without NFKC. A full-width form
   stops, as any unobserved form does.
4. **D: move the statement parser into its own module** so the other three
   parsers keep their digests. Rejected for this change: removing it from
   `myjcb.ts` changes that module, and with it all four digests, in the same
   way. Keeping a stale copy in `myjcb.ts` so its bytes stay the same would
   leave a second, unregistered `myjcb-credit-statement-total` in the code.

### Decision

- `readMyJcbStatementHeading` (domain) reads a heading's text with all
  whitespace removed, as the collector's `compactText` and the parser's
  heading text already are. It accepts exactly
  - 「YYYY年M月お支払い分のカードご利用明細」, and
  - 「YYYY年M月D日(W)お支払い分のカードご利用明細」, where W is one of
    月火水木金土日 in ASCII parentheses.

  The month must be 1 to 12 and the day a real day of that month
  (`parseLocalDate`). It returns the month `YYYY-MM` and, for the dated
  form, the date `YYYY-MM-DD`. Any other text is not a statement heading.
  The weekday's shape is checked, not its agreement with the date, as for
  the total label.

- The collector (`statedPaymentMonths`) records the heading's month as
  before. A confirmed page that names no month, or more than one (a dated
  and an undated heading together count as two), still stops with
  `credit-statement-period`. The past-months label must still agree with
  the page's month.
- `myjcb-credit-statement-total@1.3.0` requires exactly one statement
  heading, as before. When the heading is dated, its date must equal the
  total label's payment date, or the parse fails ("myjcb statement heading
  date and payment date conflict"). A page with the undated heading is
  recorded exactly as by 1.2.0.
- Because the module is shared, the other three MyJCB parsers are released
  with a patch bump and no behaviour change: `myjcb-credit-ledger@1.2.1`,
  `myjcb-credit-past-month-balances@1.1.4`,
  `myjcb-canonical-evidence-boundary@1.1.4`. `myjcb-skip-payment-schedule`
  and every other parser keep their digests.
- Amendment (d)'s unobserved acceptance path is not removed in this
  release. Amendment (f) planned to remove it at the next MyJCB release;
  doing so here would widen a stop fix into a behaviour change of the
  shared page reading, which the collector also uses. It stays unobserved
  and is removed separately.

### Consequences

- The first night after deployment reads position 1 with the dated heading
  as a confirmed month with its payment month as the period, and goes on
  to the later months and the schedule pages.
- The repair lane re-parses the stored MyJCB artifacts under the four new
  releases. Pages with the undated heading, ledgers and past-month
  summaries publish identical observations. A stored confirmed page with
  the dated heading, in a run eligible for parsing, now publishes its
  total; how many exist was not counted.
- A dated heading whose day is not the total's payment date fails the
  parse. That page states two payment dates, and neither is chosen.
- Limits: a heading in full-width parentheses or digits, with another
  weekday form, or with any other wording still stops the collection. The
  weekday is not checked against the date. The collector does not compare
  the heading's day with anything; only the parser does. The bonus page's
  dated `h2` is not read: that page stays `credit-schedule-07.html`, unread.

### Verification

- `services/collector-myjcb/test/credit-statement-state.test.ts`
  (「ADR 0005 amendment (g)」): the dated heading (with or without a leading
  zero, with whitespace and markup inside) names its month at any position;
  the undated heading still does; a past-months label must agree with it;
  a wrong weekday character, a multi-character weekday, missing or
  full-width parentheses, no weekday, an impossible day or month, a
  three-digit day, and two headings (dated and undated, or two dated) stop
  with `credit-statement-period`; `collectCredit` stores the dated page at
  position 1 with period `YYYY-MM` and no stop. Without the change, all
  three tests fail, the first and last with the production stop.
- `packages/parsers/test/myjcb-statement.test.ts` (1.3.0): a dated heading
  whose day is the total's date gives the same result as the undated
  heading; another day fails with the heading date conflict, another month
  with the month conflict; the malformed shapes above and two headings fail
  as a missing or ambiguous period; a dated page with no total is
  `statement_total_missing` as before.
- `mise run //packages/parsers:digests`: only the four MyJCB statement
  parsers change digest.
- `packages/read-model/test/card-usage.test.ts`: the pin names
  `myjcb-credit-ledger@1.2.1`; every other column is unchanged.
- Production was read only as counts by the caller: the stop code of the
  run and the 24 `ok` parses of 1.2.0. The heading shape is the owner's
  structure-only survey; every test value is synthetic.

## Amendment 2026-09-29 (h): a stored page states only what the page states

- Status: accepted (#372); its first night is recorded in amendment (i),
  and amendment (j) settles its two open questions
- Date: 2026-09-29
- Carried by: `collectCredit` and `schedulePageArtifact` in
  `services/collector-myjcb/src/collector.ts`; the stop code
  `credit_page_repeated` (condition `credit-page-repeated`) and the
  `SchedulePage` notes in `services/collector-myjcb/src/types.ts`;
  [MyJCB source note](../sources/myjcb.md),
  [observations](../observations.md#myjcb-one-page-at-four-positions-and-the-skip-payment-page-read-as-a-month-collector-no-parser-release).
  The metadata extractor ([ADR 0025](0025-myjcb-shared-manifest-metadata.md))
  and every parser are unchanged.

### Context

The first nightly run after amendment (g) (collection run 561, fetch run
908, 2026-09-29 21:03Z) read every month: the unit is `success` and all
five ledgers parsed. Production was read only with aggregate queries
(counts, digests compared inside SQL, closed codes, position numbers):

1. **One page at four positions.** The run stored 11
   `credit-detail-NN.html` pages with 8 distinct digests: positions 3, 4, 5
   and 6 are one object, byte for byte. `myjcb-credit-statement-total@1.3.0`
   failed on those four artifacts with `manifest_artifact_ambiguous` (12
   `error` parse runs: 4 artifacts × 3 attempts); the 7 other pages parsed
   `ok`.
2. **Why the extractor refused.** The shared manifest names a page by its
   bytes (ADR 0025), and the four entries naming this object disagreed. The
   collector read each page as `unknown` (no `(確定分)` heading, no rows)
   and gave it the period `settlementYM ?? detailMonth-N`: a label of the
   position, from the past-months response or the position number, not
   anything the page states. The same bytes therefore carried four periods.
   The extractor refuses rather than choose, as ADR 0025 decided.
3. **The provider shows this page at several positions; the collector's
   navigation did not repeat it.** In the 12 earlier runs that stored
   positions 0–8, 10 and 13 (fetch runs 215–719, with importer-era manifests that
   name each entry by file, so nothing was ambiguous), positions 2–6 were
   one object in every run (60 artifacts, one digest across all 12 runs,
   state `unknown`, each period its own position's label). In run 908
   position 2 is a distinct confirmed statement and the group is positions
   3–6: it lost exactly the position a closed statement moved into. The
   collector requests each position with its own `detailMonth`, after the
   menu, in one session, and positions read after the group in the same
   run (7, 8, 11 and 14) returned distinct pages, 11 and 14 confirmed
   statements with ledgers. The round-4 survey recorded positions 3–6 with
   no ledger and the menu's 「過去の明細」 boxes as 「… お支払い分 #円」 or
   「ご請求はありません」. The page is what the provider shows for a past
   position with no bill, and it names no month. Its text was not read for
   this amendment (limits below).
4. **The ショッピングスキップ払い page was read as a month.** No
   `credit-schedule-NN.html` or `credit-skip-payment-NN.html` artifact has
   ever been registered for MyJCB (0 rows). In run 908 positions 7 and 8
   were stored as `credit-detail-07.html` and `credit-detail-08.html`: the
   collector took them as months, so no skip-payment page, no
   `credit-schedule` dataset and no `myjcb-skip-payment-schedule` parse run
   exist. Both were read `unknown` with no rows, so the unit stayed
   `success`; the statement parser recorded `statement_total_not_confirmed`
   for both. Position 8 had a distinct digest in each of the 13 runs that
   stored it (the skip page's as-of heading carries the day), and position 7
   one digest across the 12 earlier runs (the bonus page, amendment (f)).
   The deployed Worker contains `readCreditMenuGroups`, and neither the
   menu grouping nor the past-months overlap check stopped the run. So
   either the menu that night put the links of 7 and 8 under a month
   heading (for instance a schedule heading that is not an `h2`, leaving
   them under 「最新のご利用明細」, which precedes them in the observed DOM
   order 0, 1, 7, 8, 2–6), or the menu did not list them and the
   past-months response offered them. The stored menu has no `href`s, and
   the manifest and the past-months response are R2 bytes that were not
   read, so which of the two is not known.

### Options considered

1. **A: the extractor picks a value for repeated bytes** (the first entry,
   or the entry at the artifact's position). Rejected: the shared manifest
   has no position to match, and choosing is what ADR 0025 refused
   (ADR 0004, INV07).
2. **B: the collector records what a page states, from the page.** An
   `unknown` page states no month, so its entry states no period, and the
   same bytes state the same thing at every position. A page that would
   still state two things (the same bytes read as two states or two
   periods) stops the connection rather than choosing. A month position
   whose page carries the observed ショッピングスキップ払い h1 is that
   schedule page. Chosen.
3. **C: store a repeated page once.** Rejected: that a position showed the
   page is evidence, and the artifact key is the only record of the
   position; dropping it would also make the month look unread.
4. **D: make the stored bytes differ per position** (a marker in the page).
   Rejected: stored evidence is the redacted provider bytes; adding
   collector text to them makes the page claim something the provider did
   not send.
5. **E: fix only the menu reading.** Not possible from the evidence: which
   menu shape put 7 and 8 among the months is unobserved (context 4).

### Decision

- **An `unknown` page's entry states no period.** Every `credit-detail`
  page the collector records as `unknown` (a read month with no stated
  state, a month kept unread, and the page a stop keeps) has no `period`
  in the collector manifest. The position stays in the artifact key, and a
  past-months label stays in `credit-past-months.json`. Pages with a state
  keep the period they had (`detailMonth-0`/`-1` for unconfirmed pages, the
  stated month or the past-months label for confirmed ones), and ledgers
  are unchanged. Nothing downstream reads an `unknown` page's period: the
  read model reads ledgers only, and the statement parser compares the
  period only on a confirmed page.
- **One page states one thing.** Within a connection, a month page whose
  redacted bytes equal a page kept at an earlier position must state the
  same state and period. Otherwise the connection stops at that position
  with the closed code `credit_page_repeated` (condition
  `credit-page-repeated`), and the page is not kept again; the months
  before it are kept, as for every stop. This has not been observed (it
  would be, for example, one pending page at positions 0 and 1, which
  would otherwise be two pending statements). The stop log carries the
  position and codes only.
- **The page's h1 decides a schedule page at a month position.** Before a
  month page's state is read, `schedulePageKind` (amendment (e)) is
  applied. When the page's one h1 is the observed
  「ショッピングスキップ払いご利用明細(未確定分)」, it is stored exactly as the
  menu's schedule pages are: `credit-skip-payment-NN.html`, dataset
  `credit-schedule`, state `unknown`, period `detailMonth-N` (which
  `myjcb-skip-payment-schedule` checks against the key). It is listed in
  `schedulePages` with `scheduled_payments_page` and counted in
  `schedulePageCount`, and it is not a month: not in `periodCount`,
  `capturedMonthCount` or `unreadMonths`. The log
  `myjcb-credit-month-schedule-page` carries the position and code only.
  `schedulePages` is ascending by position; after a stop it lists the
  schedule pages found at month positions before the stop (the menu's
  schedule positions are still not read after a stop).
- **Unchanged.** The metadata extractor still refuses repeated bytes whose
  entries disagree (also across connections, which has not been
  observed). The menu reading, the bonus page and every parser are
  unchanged. Stored runs are not rewritten.

### Consequences

- From the next night, the no-bill page at several positions registers
  with one reading (`unknown`, no period), and the statement parser records
  `statement_total_not_confirmed` for each instead of an error. The 12
  `error` rows of run 908 stay as history: its manifest is fixed evidence,
  and a re-parse reads the same manifest.
- A night whose month list includes the ショッピングスキップ払い page stores it
  as `credit-skip-payment-NN.html`, and `myjcb-skip-payment-schedule@0.1.1`
  parses it (an empty page is zero rows, amendment (f)).
- The bonus page at a month position stays a `credit-detail` month read
  `unknown`: its h1 was surveyed, but it has not been observed with rows,
  and recognising it would change the domain module that every MyJCB
  parser's digest covers.
- Limits: the repeated page's text was not read, so that it is the
  provider's no-bill page, and not the 「通信エラーが発生しました」 page
  (which the collector does not recognise, amendment (b)), rests on the
  pattern in context 3. Why the menu gave positions 7 and 8 to the months
  is not known (context 4). The repeated-page check covers `credit-detail`
  month pages only: a schedule page's entry keeps its position's label
  (`myjcb-skip-payment-schedule` requires it), so the same skip-payment
  bytes stored at two positions (two month positions, or a month position
  and a menu schedule position) would state two periods and the extractor
  would refuse both with `manifest_artifact_ambiguous`. That has not been
  observed: position 8's digest differed in every stored run. The
  observation that settles the first two is in the
  [source note](../sources/myjcb.md#同じ-page-を示す複数の-position-と月として読まれたスキップ払い-page2026-09-29adr-0005-の-amendment-h).

### Verification

- `services/collector-myjcb/test/credit-statement-state.test.ts`
  (「ADR 0005 amendment (h)」): one no-bill page at positions 3–6, with
  distinct past-months labels, is kept at each position as `unknown` with
  no period, and the manifest `myJcbRunPlan` writes has four identical
  entries for its digest; the same pending page at positions 0 and 1 stops
  at position 1 with `credit_page_repeated`, keeps position 0 and logs
  codes only; the skip page at a month position is stored as
  `credit-skip-payment-08.html`, listed in `schedulePages` and not counted
  as a month; a skip page at a month position is listed beside the menu's
  schedule page, and is kept when a later month stops; a stop page whose
  bytes an earlier position kept as a confirmed month is not kept again as
  `unknown`. Tests that expected
  an `unknown` page's position label now expect none.
- `services/processor/test/myjcb-shared-r2.test.ts`: four entries for one
  page with position labels (the shape before this amendment) fail with
  `manifest_artifact_ambiguous`; the same pages as the collector now writes
  them parse `done`, and the observation view shows state `unknown` and
  period null.
- No parser file changed, so there is no parser release and no migration.

## Amendment 2026-10-02 (i): the first stored skip-payment page was refused

- Status: accepted (#394)
- Date: 2026-10-02
- Carried by: `skipScheduleShape`, `replayStatementMetadata`,
  `REPLAY_SOURCES` and `replaySelectionSql` in
  `services/processor/scripts/parser-rejection.ts`;
  `services/processor/scripts/replay-diagnostics.ts`;
  [operations: replaying a parser rejection](../operations.md#replaying-a-parser-rejection);
  [MyJCB source note](../sources/myjcb.md),
  [observations](../observations.md#myjcb-the-first-stored-skip-payment-page-was-refused-no-parser-release).
  No parser, collector or extractor file changed.

### Context

The first nightly run after amendment (h) (collection run 612, fetch run
956, first fetch 2026-10-02 21:00Z) succeeded with 19 artifacts.
`myjcb-credit-statement-total@1.3.0` parsed all 10 statement pages `ok`, so
the repeated no-bill page now registers as amendment (h) intended. For the
first time a `credit-schedule` artifact was registered: position 8, a month
position, stored as `credit-skip-payment-08.html`. Its one parse run of
`myjcb-skip-payment-schedule@0.1.1` is `error` with `parser_rejected`, its
job `failed` with the same code (a rejection is not retried at the same
version), and there are no `parse_issues` rows: the processor keeps only
the closed stage code, never the parser's message (operations).

Production was read only with aggregate queries (counts, booleans, closed
codes, sizes compared inside SQL, timestamps). What they rule out:

1. **Not the metadata.** The parser's own metadata check
   (`schedule_artifact_metadata_invalid`) passes on what the processor
   handed it: the key has the shape `<connection>/credit-skip-payment-NN.html`
   (connection characters and position inside the parser's pattern), the
   metadata projection (`legacy-metadata-v1`, status `ok`) states `unknown`
   and exactly the key's `detailMonth-N`, and the artifact row states the
   same. The media type `text/html` is accepted. The collector's
   month-position path writes the same entry as the menu path (one
   function, `schedulePageArtifact`), so the suspected mismatch between the
   two paths does not exist.
2. **Not the run.** The fetch run is `success` with no failure, so
   `schedule_run_ineligible` cannot be thrown.
3. **Not the HTML boundary.** `schedule_html_boundary` applies the same size
   limit, UTF-8 decoding and document, active-content, card-number and
   form-value checks as `myjcb-credit-statement-total`, character for
   character. That parser ran those checks `ok` on the 15 earlier position-8
   pages (the same provider page, stored as `credit-detail-08.html` before
   amendment (h), redacted by the same unchanged `redactedStatementHtml`).
4. **Not after the parser.** The processor sets the stage to
   `parser_rejected` only for the call to `parse`; the checks that follow it
   throw their own codes (`parse_contract_invalid`,
   `observation_limit_exceeded`).
5. **It is the empty page.** Its size is within 2 bytes of each of the 15
   earlier position-8 pages (equal to 3 of them), which the round-5 survey
   (amendment (f)) recorded as the empty page: the h1, the three-cell head
   and the one empty row. A row would add far more than 2 bytes; the
   difference is the as-of heading's date digits.

So the reader refused the stored empty page on one of its structural checks:
`schedule_head_unobserved`, `schedule_row_shape_unobserved`,
`schedule_as_of_invalid` or `schedule_ledger_ambiguous` (the last two only if
the empty row is not the one `isEmptyLedgerRow` admits, which makes it a
row). `schedule_kind_unobserved` is unlikely (the collector named the page
by the same h1 reading). Which one is in the bytes, and production R2 cannot
be read from this session: the counts-only replay needs wrangler signed in
to the owner's Cloudflare account. The round-5 survey did not record what
these checks rely on beyond its summary: whether the head's three cells are
its direct element children, whether the ledger's element children are only
the head followed by `content` rows, and whether the empty row's `item-cell`
has exactly one element child.

The replay diagnostic could not have answered it either: it selected only
`sony-bank` and `sbi-shinsei-bank` failures, and printed only the first
failing code. It also handed every parser the artifact row's state and
period. Under `legacy-metadata-v1`, the release this dataset reads (no
`active_releases` row), that is the same value the processor hands the
parser, since both come from `observation_artifact_metadata`; under
`manifest-metadata-v2` the projection reads the collector manifest and can
differ.

### Options considered

1. **A: change the reader to accept a guessed shape** (cells one level
   down, extra ledger children, a looser empty row). Rejected: which shape
   the page has is unobserved, and ADR 0004 forbids reading a shape nobody
   has seen. A guess that is wrong costs a further release and still reads
   nothing.
2. **B: change the collector's entry.** Rejected: the metadata passes
   (context 1); there is nothing to fix there.
3. **C: make the counts-only replay able to answer, and stop there until
   the owner runs it.** Chosen. One run gives the closed code and every
   structure the reader checks, as counts, booleans and closed names.
4. **D: store the parser's message in CORE.** Rejected here: the
   processor's rule (never store parser exception text) stays; this
   parser's messages are closed codes, but widening what the processor
   stores is a separate decision.

### Decision

- `replay-diagnostics.ts` replays MyJCB failures too (`REPLAY_SOURCES`).
  Every MyJCB parser throws fixed messages; `myjcb-skip-payment-schedule`'s
  are its closed codes, and the others pass through `legacySafeReason`,
  which prints only closed reasons.
- For MyJCB, the replay hands the parser the statement state and period of
  the artifact's newest completed (`ok` or `absent`) metadata projection
  under the extractor release the processor reads for that parser (the
  `active_releases` row's, else `legacy-metadata-v1`, as the worker's
  `extractorRelease`); an `error` projection or another release's
  projection is never taken. Without one the artifact row stands. A failed
  parse records no `parse_input_references`, so this is the projection a
  normal (non-candidate) run reads now, not a recorded link to the failed
  attempt. Other sources are unchanged.
- For a `myjcb-skip-payment-schedule` failure the replay prints
  `skipScheduleShape`: the number of h1s and of exact skip-payment h1s, the
  number of h1–h6 that contain the as-of heading's fixed words, and for
  each `detail-list-01`: its element children as signatures (tag from a
  closed list or `other`, plus only the reader's own class names), the
  number of `head` elements, the first head's children, whether they are
  exactly the three expected cells, whether the head's whole text is the
  three labels, and each `content` row's structure (its children, the
  `item-cell`'s children, whether a lone cell shows the empty label, the
  middle cell's `br` count and children) with a count. No text, attribute
  value or provider class name is printed.
- The reader, the parser and its version are unchanged. Once the owner's
  replay names the check and the shape, the next amendment changes the
  reader for that observed shape only, as `myjcb-skip-payment-schedule`
  0.1.2 with its parser-release migration, and the repair lane re-parses
  the stored page.

### Consequences

- Until then, every night's skip-payment page fails the same way and no
  `scheduled_payment` observation exists. Nothing that reads transactions,
  balances or statements depends on the page (amendment (e)), and the unit
  stays `success`; the months are unaffected.
- The owner's run is one command (operations); its output is the closed
  code, the shape line and the summary, all safe to paste.
- Limits: the cause is narrowed to the reader's structural checks by
  inference from metadata, sizes and the statement parser's identical
  boundary checks, not by reading the page; the replay settles it. If the
  replay instead reports `schedule_html_boundary` or the metadata code, the
  inference in context 1–3 was wrong and the replay's code stands.

### Verification

- `services/processor/test/parser-rejection.test.ts`
  (「myjcb-skip-payment-schedule: the page's structure in counts and closed
  names」): the stored empty shape (span-row head, lone empty row) reads as
  three direct cells, `textAsExpected`, and one `emptyLabel=true` row; a
  page with rows shows each row's structure and none of its synthetic dates,
  merchants, amounts or labels; a head whose cells sit inside an
  `item-cell`, and an extra ledger child with a provider-chosen class, are
  shown as `div.item-cell` and `div` with the class name withheld; non-UTF-8
  bytes print only `utf8: false`; a page carrying synthetic merchant,
  amount, date, URL, id, attribute and provider-class values in text,
  attributes, comments and unknown tags prints none of them, and every word
  of its line is a field name, a closed tag or reader class, a boolean or a
  count; `replayStatementMetadata` uses the projection for MyJCB only, and
  falls back on an errored or missing one.
- The replay-selection test against the migrated CORE schema selects a
  MyJCB skip-payment failure with the newest completed projection of the
  release the processor reads: a newer `error` row and a newer
  `manifest-metadata-v2` row are skipped under `legacy-metadata-v1`, and
  the `manifest-metadata-v2` row is read once an `active_releases` row
  names that release; the existing SBI Shinsei and Sony rows are selected as
  before and other sources stay out.
- Production was read only with aggregate queries; every test input is
  synthetic.

## Amendment 2026-10-04 (j): the menu's schedule heading is an h3, and the bonus page is known by its h1

- Status: accepted (#407); the MyJCB statement parser releases are amended by (k)
- Date: 2026-10-04
- Carried by: `readCreditMenuGroups` and `schedulePageKind` in
  `services/collector-myjcb/src/parsers.ts`; `collectCredit` and
  `schedulePageArtifact` in `services/collector-myjcb/src/collector.ts`;
  `myjcbSchedulePageHeadingKind` and `BONUS_SCHEDULE_HEADING` in
  `packages/domain/src/myjcb-schedule-page-kind.ts`;
  `myjcb-credit-statement-total@1.4.0` in
  `packages/parsers/src/parsers/myjcb.ts`;
  [MyJCB source note](../sources/myjcb.md),
  [observations](../observations.md#myjcb-the-menus-schedule-heading-is-an-h3-and-the-bonus-page-is-not-a-statement-statement-parser-140).

### Context

The owner observed the live MyJCB pages after login (round 9, 2026-10-04;
shapes, counts, fixed labels and booleans only, no values) and read
production with aggregate queries only (round 7). They settle the two open
questions of amendment (h).

1. **The menu's schedule heading is an `h3`.** The credit menu
   (`detailMenu.html`) has nine `detail.html?detailMonth=N` links, in DOM
   order 0, 1, 7, 8, 2, 3, 4, 5, 6. Its headings in document order are
   `h2.hdg-H2` 「最新のご利用明細」, `h3.hdg-H3`
   「ボーナス#回払い・ショッピングスキップ払い」 (# a digit), `h2.hdg-H2`
   「過去の明細」, and then guidance `h2`s and `h3`s at the bottom of the page,
   after every link. Each card box has a `p.hdg` before it. Amendment (c)
   recorded three `h2`s; `readCreditMenuGroups` grouped each link under the
   last `h2` before it, so links 7 and 8 fell under 「最新のご利用明細」 and
   were read as months. That is the path amendment (h) could not choose
   between: fetch run 908 (2026-09-29) stored `credit-detail-07.html` and
   `credit-detail-08.html` and no schedule page, and
   `myjcb-credit-statement-total@1.3.0` parsed both `ok`.
2. **The bonus page's `h2` has the dated statement heading's form.** Position
   7 shows `h1.hdg-H1` 「ボーナス#回払いご利用代金明細(未確定分)」 (# a digit),
   three `h2`s, one of which (`hdg-H2`) matches
   「YYYY年M月D日(曜)お支払い分のカードご利用明細」 exactly, the form
   amendment (g) reads; one `detail-list-01`, three tables, the phrase
   「ご利用明細はございません」, and one `form` (method `get`, action path
   `/iss-pc/member/details_inquiry/detail.html`, no hidden input). So by its
   `h2` alone a statement reader cannot tell it from a month. Position 8
   shows 「ショッピングスキップ払いご利用明細(未確定分)」 and an `h2` of the form
   「YYYY年M月D日(曜)時点のショッピングスキップ払いご利用明細(YYYY年M月以降のお支払い分)」,
   which does not match the dated heading. Amendment (h) recognises the skip
   page by its h1 at a month position; the bonus page was left a month.
3. **Positions 3–6 are one empty-month page.** Their responses are byte for
   byte the same (one SHA-256) and name no month anywhere: `h1.hdg-H1`
   「カードご利用代金明細」 (without 「(確定分)」, and not
   「カードご利用明細一覧」), the phrase 「当該月の請求はございません」, no `h2`,
   no `detail-list-01`, no table, no form. 「ご請求はありません」,
   「通信エラーが発生しました」 and 「ご利用明細はございません」 are all absent, so
   it is not the error page amendment (b) does not recognise. This is the page
   amendment (h) inferred; its identical bytes caused
   `manifest_artifact_ambiguous` on 03–06 in fetch runs 908, 921 and 940
   (60 `error` parse runs in all), and the run of 2026-10-02 (956), the first
   after amendment (h), parsed all ten statement pages `done`.
4. **What 1.3.0 made of the bonus page.** The bonus page has no
   「カードご利用代金明細(確定分)」 h1, so `readMyJcbStatementPage` reads it
   `unknown` (its one ledger shows only the provider's empty row), and 1.3.0
   records it `ok` with no observation and `statement_total_not_confirmed`,
   as amendment (h) recorded for run 908. No statement total was published
   from it. The `h2` collision is a reading that depends on the h1 alone
   keeping the page out: a bonus page that also carried the `(確定分)` h1, or
   whose state reading changed, would reach the `h2` and could be read as a
   month's total.
5. **The empty-month page under 1.3.0.** The same reading gives `unknown`
   (no `(確定分)` h1, no ledger): `ok`, no observation,
   `statement_total_not_confirmed`. No zero total is emitted, so INV05 holds
   without a change.

### Options considered

1. **A: read the schedule heading at any level (`h1`–`h6`).** Rejected:
   only `h2` and `h3` were observed as section headings; each box's own
   heading is a `p.hdg`, and admitting `h4`–`h6` would group links under
   elements nobody has seen there (ADR 0004).
2. **B: the group boundary is the last `h2` or `h3`.** With the observed menu
   it gives 0, 1, 2–6 to the months and 7, 8 to the schedules; the trailing
   guidance headings have no link under them and decide nothing. An `h3`
   that is not one of the three observed headings, before a link, stops the
   connection, as an unrecognised `h2` does. Chosen.
3. **C: recognise the bonus page by its menu position (7).** Rejected: the
   menu's positions move (amendment (h) context 3), and the page names what
   it is.
4. **D: recognise the bonus page by its h1, as the skip page is.** The h1
   form is fixed text with one digit run. Chosen, for the collector and as a
   refusal in the statement parser.
5. **E: refuse a schedule page in the statement parser by throwing.**
   Rejected: an `error` parse run never supersedes
   ([observations: versioning and supersession](../observations.md#versioning-and-supersession)),
   so the 1.3.0 `ok` run of every stored `credit-detail-07.html` would stay
   the published reading of that page. An `ok` run with no observation and a
   closed warning supersedes it.
6. **F: read the bonus page.** Rejected: it has never been observed with
   rows (ADR 0004).

### Decision

- **Menu.** `readCreditMenuGroups` groups each link under the last `h2` or
  `h3` before it in document order. The three headings, their groups and
  their comparison (whitespace removed, any run of ASCII or full-width digits
  for #, every other character exact) are unchanged, at either level. A link
  before any `h2` or `h3`, a link under any other `h2` or `h3`, and a
  position in both groups stop with `credit-menu-group`, logging counts
  only. The all-`h2` shape of amendment (c) groups the same.
- **The bonus page by its h1.** `myjcbSchedulePageHeadingKind`
  (`packages/domain/src/myjcb-schedule-page-kind.ts`) returns `skip-payment`
  when amendment (e)'s reading does (exactly one skip h1; checked first,
  unchanged), else `bonus` when exactly one h1, whitespace removed, matches
  `ボーナス[0-9０-９]+回払いご利用代金明細\(未確定分\)`, else `unobserved`. It
  lives in its own module so that `myjcb-skip-payment-schedule`'s digest
  does not move; `schedulePageKind` in the collector reads it.
- **Collector.** A `bonus` page is stored as `credit-schedule-NN.html`
  (dataset `credit-schedule`, state `unknown`, period `detailMonth-N`), the
  name registration gives no parser dataset, so nothing reads it. At a menu
  schedule position that is what amendment (c) already did. At a month
  position it is now handled exactly as the skip page is since amendment
  (h): before the state is read, stored as that schedule page, listed in
  `schedulePages` with `scheduled_payments_page`, counted in
  `schedulePageCount`, not in `periodCount`, `capturedMonthCount` or
  `unreadMonths`, and logged as `myjcb-credit-month-schedule-page` with the
  position and code only.
- **`myjcb-credit-statement-total@1.4.0`.** After the HTML boundary and
  before the state is read, a page whose `myjcbSchedulePageHeadingKind` is
  `skip-payment` or `bonus` is parsed `ok` with no observation and the
  closed warning `schedule_page_not_statement`, whatever its `h2`s, `(確定分)`
  h1 or total say. Every other page reads exactly as in 1.3.0; the
  empty-month page still yields `statement_total_not_confirmed` and no
  total (context 5). `myjcb-credit-ledger@1.2.2`,
  `myjcb-credit-past-month-balances@1.1.5` and
  `myjcb-canonical-evidence-boundary@1.1.5` change digest only: the four
  parsers share `myjcb.ts`. `myjcb-skip-payment-schedule@0.1.1` is
  unchanged, digest included.
- **No migration.** The processor registers each deployed release in
  `parser_releases` itself, and no migration pins a MyJCB parser version (as
  for 1.3.0), so this release needs none; the migration pin is unchanged.
- **Unchanged.** The metadata extractor, the empty-month page's handling
  (one `unknown` page with no period at each position, amendment (h)), the
  skip-payment parser and its open refusal (amendment (i)). Stored runs are
  not rewritten.

### Consequences

- From the next night the menu gives 7 and 8 to the schedules: the bonus
  page is stored as `credit-schedule-07.html` and unread, and the skip page
  as `credit-skip-payment-08.html`, read by the skip parser (which still
  refuses it, amendment (i)). The amendment (h) and (j) month-position paths
  stay as a defence for a menu that lists a schedule page as a month.
- **Production exposure, as a limit.** Every stored `credit-detail-07.html`
  is the bonus page registered as a month: in the 12 runs 215–719 that
  stored position 7 (amendment (h)), in run 908, and in every later run
  until this deploys (run 956's ten statement pages include it; runs 921
  and 940 were not broken down by position). Each was parsed `ok` with no
  observation and `statement_total_not_confirmed`, by 1.3.0 since
  2026-09-29 and by earlier versions before. The same holds for
  `credit-detail-08.html` (the skip page) until amendment (h) deployed;
  run 956 stored it as `credit-skip-payment-08.html`. No total came from
  either, because neither has the `(確定分)` h1 (context 4); but the
  published reading of those artifacts is a statement reading, and only
  that h1 rule stood between the bonus page's dated `h2` and a total.
- **How 1.4.0 supersedes it.** The repair lane re-parses the stored
  `credit-detail` pages under the new release, as it did for 1.3.0. For each
  bonus or skip page stored as a month, 1.4.0 writes an `ok` run with
  `schedule_page_not_statement`; it is a newer version than the live 1.3.0
  `ok` run of the same artifact, so the processor's publish batch
  (`publishBatch` in `packages/storage-d1/src/atomic/publication.ts`) marks
  that run superseded by the new one and moves the artifact's
  `published_parse_runs` pointer to it. Nothing
  observable changes in the read model (both runs have no observation); the
  warning now says what the page is. A run not eligible for parsing is not
  re-parsed, as before. The `manifest_artifact_ambiguous` artifacts of runs
  908, 921 and 940 stay failed under 1.4.0: their manifest is fixed evidence
  (amendment (h)). How many artifacts the re-parse touches was not counted.
- Stored pages are not reclassified: a `credit-detail-07.html` stays a
  `credit-detail` artifact; only its published reading changes.
- Limits: the round-9 menu is one connection on one night; a menu whose
  schedule heading moves to another level, or whose guidance headings move
  above a link, stops the connection before its first month (nothing is
  guessed). The bonus page has still not been observed with rows. The
  empty-month page is recognised by no rule of its own: it is an `unknown`
  page because it has no `(確定分)` h1 and no ledger, and a change to it that
  adds rows would be read as before (`rows_unstated`).

### Verification

- `services/collector-myjcb/test/parsers.test.ts`
  (「readCreditMenuGroups」): the fixture menu in the observed levels (`h2`,
  `h3`, `h2`, then guidance `h2`/`h3` after every link) groups 0–6 as months
  and 7, 8 as schedules; the all-`h2` shape groups the same; an `h3` schedule
  heading matches after whitespace removal with a full-width digit; an
  unrecognised `h3` before a link, or inside a box, stops with
  `credit-menu-group` and logs counts only; a link after only an `h1` or
  `h4` stops; a `p.hdg` or `h4` inside a box moves nothing.
- `services/collector-myjcb/test/credit-statement-state.test.ts`
  (「ADR 0005 amendment (j)」): the bonus h1 with ASCII, full-width and
  multi-digit counts is `bonus`, near misses (no digit, kanji numeral,
  full-width parentheses, `(確定分)`, two bonus h1s) and a statement page are
  `unobserved`; with the observed menu, 7 is stored as
  `credit-schedule-07.html` and 8 as `credit-skip-payment-08.html`; the bonus
  page at a month position, with its dated `h2`, is stored as
  `credit-schedule-07.html`, listed in `schedulePages`, not counted as a
  month, and logged with codes only; the same page under a near-miss h1 is a
  `credit-detail` month read `unknown`, as before; the empty-month page at
  positions 3–6 is kept at each as `unknown` with no period.
- `packages/parsers/test/myjcb-statement.test.ts` (1.4.0): the bonus page,
  whose `h2` matches the dated heading, and the skip page stored as a month
  are `ok` with no observation and `schedule_page_not_statement`, whatever
  the manifest states; a schedule h1 beside a `(確定分)` h1, a dated `h2` and
  a total is still refused; near misses of the bonus h1 read as 1.3.0 did
  (`statement_total_not_confirmed`); a confirmed statement yields its total;
  the empty-month page yields `statement_total_not_confirmed` and no
  observation.
- `packages/parsers/test/parser-digests.test.ts` checks the regenerated
  digests; the read-model pin names `myjcb-credit-ledger@1.2.2`.
- Production was read only by the owner, with aggregate queries and a
  counts-only survey; every test input is synthetic.

## Amendment 2026-10-08 (k): the skip-payment empty row inside one more div

- Status: proposed; accepted when the amending PR merges
- Date: 2026-10-08
- Carried by: `isEmptyLedgerRow`, `isEmptyItemCell` and `READER_CLASSES` in
  `packages/domain/src/myjcb-skip-payment-schedule.ts`;
  `myjcb-skip-payment-schedule@0.1.2` in
  `packages/parsers/src/parsers/myjcb-skip-payment-schedule.ts`; the
  digest-only releases `myjcb-credit-ledger@1.2.3`,
  `myjcb-credit-past-month-balances@1.1.6`,
  `myjcb-credit-statement-total@1.4.1` and
  `myjcb-canonical-evidence-boundary@1.1.6` in
  `packages/parsers/src/parsers/myjcb.ts`;
  [MyJCB source note](../sources/myjcb.md),
  [observations](../observations.md#myjcb-the-skip-payment-empty-row-inside-one-more-div-schedule-parser-012).

### Context

Amendment (i) narrowed the refusal of the stored skip-payment page to the
reader's structural checks and waited for the owner to name the check and
the shape. The owner did so for one stored capture, from the nightly run of
2026-10-06 (artifact 11644, `credit-skip-payment-NN.html`), refused by
`myjcb-skip-payment-schedule@0.1.1` with `schedule_row_shape_unobserved`.
The owner read the stored object, identified by its SHA-256 and byte size,
and reported structure, counts and booleans only; no text, value or
provider class name was shared, and none is recorded here.

1. **Everything but the row is the known empty page.** One exact
   skip-payment h1, one `div.detail-list-01` whose element children are its
   `div.head` and then `content` rows only, and a head of three `div.cell`
   with the expected labels (amendment e).
2. **The one `content` row is the empty row one level down.** Its only
   element child is a `div` carrying none of the reader's class names
   (`detail-list-01`, `head`, `content`, `item-cell`, `cell`, `w-100per`).
   That `div`'s only element child is a `div.item-cell`, whose only element
   child is a `div.cell.w-100per` with no element child. The row has exactly
   one `item-cell` and one `w-100per`. At every level, from the row down to
   the cell, the text with whitespace removed is exactly the empty label
   「ご利用明細はございません。」 (`EMPTY_LEDGER_LABEL`): nothing but the label.
3. **Why 0.1.1 refused it.** `isEmptyLedgerRow` required the row's only
   element child to be the `item-cell`, so the row was a row; the row check
   then found no `item-cell` as the row's child and refused the page.
4. **The collector already read it as empty.** Its shared statement reading
   (`isEmptyLedgerRow` in `packages/domain/src/myjcb-statement-page.ts`)
   finds the `item-cell` at any depth under the row, so
   `scheduledLedgerRowCount` counted this row as zero and the page was
   stored by its h1 as before.
5. **The reader is in four other digests.** `myjcb-schedule-page-kind.ts`
   (amendment j) imports `myjcbSchedulePageKind` from
   `myjcb-skip-payment-schedule.ts`, so that module is in the digest closure
   of the four MyJCB statement parsers, which share `myjcb.ts`. Any change to
   it changes their digest, and the digest generator and migration 0028
   refuse a changed digest under an unchanged version.

### Options considered

1. **A: refuse as today.** Rejected: the shape is now observed, every
   night's skip page stays an `error` with no reading, and nothing about the
   page is in doubt beyond this one level.
2. **B: accept a wrapper at any depth** (find the `item-cell` anywhere under
   the row, as the shared statement reading does). Rejected: deeper or other
   wrappers are not observed (ADR 0004), and a search at any depth would
   also admit structures that could hold rows.
3. **C: accept exactly the observed wrapper, every level checked.** Chosen.
   Where it lives:
   - **C1: in the reader's `isEmptyLedgerRow`, with the reader's own
     helpers** (`children`, `hasClass`, `text`, `compact`). Chosen. The
     empty-row rule is the reader's: inside `readMyJcbSkipPaymentSchedule`,
     `ledgerRows` decides whether a ledger has rows, and that answer feeds
     every later check in their fixed order (which ledger is read and
     `schedule_ledger_ambiguous`, the head, the row limit, the as-of rule)
     before the row check. Only the reader can change that answer without a
     second reading of the same rows. It moves the four MyJCB statement
     parsers' digest (context 5), so they are released again with nothing
     else changed (decision).
   - **C2: a parser-local override**: a module imported only by the
     skip-payment parser that removes the wrapper from the parse tree before
     the reader reads the page (or re-decides the empty ledger around it).
     Rejected: it would keep the four statement parsers' digests (the reason
     amendment (f) kept amendment (d)'s path), but it needs its own copies of
     the reader's tree helpers and of the empty label, splits one rule over
     two modules, and leaves `readMyJcbSkipPaymentSchedule` refusing a page
     the parser reads. The owner asked that the fix reuse the reader's
     existing helpers and add no generic utilities. No dependency is added
     either way: the input is still the parse5 tree the parser already
     builds.

### Decision

- `isEmptyLedgerRow` accepts two shapes. The amendment (f) shape: the
  row's only element child an `item-cell` whose only element child is one
  `div.cell.w-100per` with no element child, showing exactly the label
  (`isEmptyItemCell`). The amendment (k) shape: the row's only element
  child is a `div` carrying none of `READER_CLASSES`, whose only element
  child is an `item-cell` that `isEmptyItemCell` accepts. In both shapes
  the row, the wrapper (when there is one) and the `item-cell` each show
  exactly the label after whitespace removal (the cell is checked by
  `isEmptyItemCell`).
- Both shapes are `div`s at every level, as both were observed: the row
  (`div.content`), the wrapper, the `item-cell` and the cell. Any other
  element in their place is a row. For the amendment (f) shape this narrows
  0.1.1, which required only the cell to be a `div` and took any element
  as the row and the `item-cell`, text beside the cell in the row or the
  `item-cell`, and elements inside the cell; that difference is in shapes
  nobody has observed.
- `ledgerRows` is unchanged: the empty row, in either shape, is zero rows
  only when it is its ledger's one `content` row. Beside any other row,
  twice, or beside the other shape, each is a row and the page is refused
  with `schedule_row_shape_unobserved`.
- Not accepted, so a row and refused: two or more wrapper levels; any
  element other than a `div` at any level of either shape (a `span.content`
  row, a `span`, `section` or `p` wrapper, a `span.item-cell`, a
  `span.cell`); a wrapper that carries any of the reader's classes or has
  another element child; in either shape, text anywhere beside the label,
  another label, and an element inside the cell; and a wrapper around a
  data row. A data row is
  read exactly as before: the row's only element child is one `item-cell` of
  three `cell`s.
- The refusal codes are unchanged; there is no new code.
- `myjcb-skip-payment-schedule@0.1.2`. Every page 0.1.1 read whose empty
  row is `div`s showing nothing but the label, with no element in the cell,
  it reads the same, and every observation it writes is
  0.1.1's (and 0.1.0's).
- `myjcb-credit-ledger@1.2.3`, `myjcb-credit-past-month-balances@1.1.6`,
  `myjcb-credit-statement-total@1.4.1` and
  `myjcb-canonical-evidence-boundary@1.1.6` change digest only, and their
  output is byte-identical. From this module they reach only
  `myjcbSchedulePageKind` and its `skipHeadingCount` (through
  `myjcbSchedulePageHeadingKind`), which are unchanged; the changed
  functions are reachable only from `readMyJcbSkipPaymentSchedule`. No other
  release changes.
- No migration: the processor registers each deployed release in
  `parser_releases` itself, and no migration pins a MyJCB parser version (as
  for amendment j). Amendment (i) expected one; none is needed.
- The collector, the metadata extractor and the replay diagnostic are
  unchanged.

### Consequences

- Once deployed, the repair lane, which re-parses stored artifacts after a
  version bump ([observation lanes](../observation-lanes.md#repair-budget-and-drain-rate)),
  can read a stored skip page of this shape as an empty schedule: an `ok`
  run with no observation, where 0.1.1 wrote an `error`. There is still no
  `scheduled_payment` observation, because the page has no rows.
- The same lane re-parses every stored MyJCB statement artifact under the
  four new statement releases. Their observations are the same as their
  previous releases'; each new `ok` run supersedes the previous `ok` run of
  its artifact, and its rows are identified again by the identity sweep, as
  for any release. How many artifacts this touches was not counted. Read
  rows that carry the parser label now name the new versions.
- Limits: one capture was read. Whether the other stored skip pages
  (amendment (i)'s first one included) have this shape, the amendment (f)
  shape or another was not established, and whether the round-5 summary
  omitted this wrapper or the page changed after it is not known; any other
  shape is still refused. The skip page with rows is still unobserved
  (amendment e), so a data row inside a wrapper stays refused. The skip
  reader stays in the four statement parsers' digest closure, so its next
  change releases them again; separating the h1 reading from it is not done
  here. Production replay and deployment are not verified by this change.

### Verification

- `packages/parsers/test/myjcb-skip-payment-schedule.test.ts`
  (「the wrapped empty row (ADR 0005 amendment k)」): the lone wrapped empty
  row is zero rows under either head, with or without the as-of heading,
  with an invented non-reader class on the wrapper, and with whitespace
  between the levels; the amendment (f) row still is; on ten pages (the row
  alone, alone without the as-of heading, before and after data rows,
  beside one data row without the as-of heading, twice, in a ledger beside a
  ledger with rows, in each of two ledgers, under a four-cell head, on the
  bonus page) the wrapped row gives exactly the outcome of the amendment (f)
  row, covering zero rows, rows read and four refusal codes; a wrapper carrying each of the six
  reader classes, two wrapper levels, a second element child, two
  `item-cell`s, text in the row, the wrapper or the `item-cell`, another
  label, an element inside the cell, a `span` wrapper and a wrapped data row
  are each refused with `schedule_row_shape_unobserved`; the wrapped row
  beside a data row (before or after), twice, beside the amendment (f) row
  (either order), and a wrapped data row beside data rows are refused. The
  positive tests fail without the reader change. Every input is synthetic
  and mirrors the reported structure; no stored text is copied.
- The same file, the element cases: a `span.content` row, a `span.item-cell`
  and a `span.cell.w-100per`, each wrapped and unwrapped, and a `span`,
  `section` or `p` wrapper are refused with `schedule_row_shape_unobserved`;
  the observed `div` shapes, wrapped and unwrapped, read as zero rows.
  Without the `div` checks on the row and the `item-cell`, the `span.content`
  and `span.item-cell` cases fail.
- The same file, the level cases: text (an invented amount included) in the
  unwrapped row beside its `item-cell`, text in the unwrapped `item-cell`
  beside its cell, and an element or a line break inside the unwrapped
  cell are refused, as in the wrapped shape; so are a wrapper around the
  cell's parent without the `item-cell` class, an `item-cell` with a second
  element child or a second cell, and text in the row after the wrapper.
  Without the level text check, or without the check that the cell has no
  element child, the matching cases fail.
- `packages/parsers/test/parser-digests.test.ts`: the digests regenerated
  with `mise run //packages/parsers:digests` change exactly five releases,
  the skip parser (0.1.2) and the four MyJCB statement parsers (one shared
  digest).
- The four statement parsers' output is unchanged:
  `packages/parsers/test/myjcb-statement.test.ts` (their statement, schedule
  and bonus page cases) passes unchanged, and
  `packages/read-model/test/card-usage.test.ts` pins the ledger's rows with
  only the parser label changed to `myjcb-credit-ledger@1.2.3`. A one-off
  differential run of the four parsers at the base commit and at this
  change, over every synthetic MyJCB input in the repository (the
  observation-pipeline fixture run, the collector's fixture pages as
  `credit-detail` in three states, and skip and bonus pages with rows, the
  empty row and the wrapped empty row; 40 parses), gave byte-identical
  output.
- `services/processor/test/myjcb-shared-r2.test.ts`: the skip page job runs
  under 0.1.2.
- Production was read only by the owner, structure and counts only.
