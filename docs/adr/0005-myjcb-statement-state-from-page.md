# ADR 0005: Decide the MyJCB statement state from the page, not export links

- Status: accepted; the
  [2026-09-27 amendment](#amendment-2026-09-27-a-stop-ends-the-connection-and-keeps-its-captured-months)
  is accepted (#275); the
  [second 2026-09-27 amendment](#amendment-2026-09-27-b-export-links-the-third-ledger-header-and-the-stop-page)
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

- Status: proposed; accepted when the amending PR merges
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
   a page of that shape is the likely cause, not a confirmed one. Also observed: a detail
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
  grouping read and a decision of its own. A stored page keeps its body
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
