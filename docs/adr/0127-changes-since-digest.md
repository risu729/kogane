# ADR 0127: What was recorded since a time, per source, as `kogane.changes.since`

- Status: proposed. A new published MCP tool (`kogane.changes.since`), a new
  catalogue operation (`changes.since`) and a new read route: **the owner's
  approval is needed before merge**, as for every published tool change
  (AGENTS.md, merging: an agent or MCP operation added to `catalogue.ts`).
  The owner allowed new tools where needed for issue #1414 (2026-11-19, "you
  may add new tools if needed"); that allows the proposal, not this tool.
- Date: 2026-11-19
- Tracking: [issue 1414](https://github.com/risu729/kogane/issues/1414), gap G3
  of the MCP everyday-questions audit (`docs/plans/2026-11-mcp-everyday-questions.md`,
  proposed in its own pull request; question Q15, "what changed since
  yesterday?")
- Related: [ADR 0081](0081-ui-parity-through-mcp.md) (UI/MCP parity, one
  service), [ADR 0084](0084-mcp-operator-authority-without-delegation.md) (MCP
  clients hold the operator's authority), [ADR 0001](0001-domain-axes.md)
  (INV05, INV07), [read model: cost](../read-model.md#cost)

## Context

The owner asked for MCP improvements so that everyday questions take one or
two calls, each answer under 8 KB, because an MCP client shows only the first
8 KB of an answer (#1414). "What changed since yesterday?" took
`kogane.store.read` (`overview`), pages of `kogane.events.read`,
`kogane.reported-holdings-change.read`, `kogane.balances.read` (`history`) and
`kogane.collection-quality.read`: more than 300 KB, and the client diffed it
all by time itself. None of those reads takes a time: the overview lists the
newest 100 fetch runs and parse runs across every source, `events.read` pages
200 events with no date filter, and collection quality says what each stage
last did, not what is new.

What the store records, and when (main `339067a`):

- A fetch run is stamped `first_recorded_at_ms` when ingest records it; it is
  read per source through `idx_fetch_runs_source (source_id, id DESC)`. Its
  state is its terminal report's `normalized_outcome` once sealed (the
  evidence browser's `outcome`); before that it has no seal or no terminal
  report.
- A capture (`fetch_artifacts`) belongs to its run, through
  `idx_fetch_artifacts_run_role (fetch_run_id, …)`.
- A parse run is stamped `parsed_at` (`new Date().toISOString()`) when the
  Processor inserts it, and never restamped; no index has its time, but its id
  is its rowid. Its observations carry its `parse_run_id`, with an index per
  table.
- An event revision is stamped `created_at` when a writer inserts it; no index
  has its time, but the table has a rowid.

Each table is append-only and inserted with an increasing id, so its insertion
order is its recording order.

## Options considered

1. **Filters on the existing reads.** A `since` on `events.read`, on the
   evidence browser's run list and on the observation lists. Each still answers
   its page's shape, so the question still needs four or five calls and the
   client still sums them; the event filters also need query-rewrite proofs
   (below). Kept as the next slice for events, not as the answer.
2. **A digest read with its own route and one shared service (chosen).**
   `kogane.changes.since`, `GET /api/v2/changes` and their agent HTTP route
   call `readChangesSince`.
3. **A time index and an additive migration.** Indexes on
   `first_recorded_at_ms`, `parsed_at` and `created_at` would let a read start
   exactly at `since`. The walks below need no index, cost a fixed number of
   rows whatever the store holds, and say when they stop short, so no migration
   is added.

## Decision

1. **One service.** `readChangesSince`
   (`packages/application/src/query/changes-since.ts`) answers
   `kogane-changes-since-v1` for one instant `since`. The route (reader
   authority, any signed-in subject, as the evidence browser's GET routes), the
   agent HTTP route and the MCP tool are adapters over it (ADR 0081 point 2).
   No screen reads the route yet, so the parity guard lists the tool among the
   tools without a UI route; a page is a later slice. (Amended
   2026-11-20: the ホーム page's 最近の変化 panel reads the route, and the
   guard maps it to the tool;
   [amendment below](#amendment-2026-11-20-the-ホーム-panel-reads-the-route).)
2. **What "new" means.** Recorded in the store at or after `since`: a fetch run
   by its first recording, a capture with its run, a parse run by its parse
   time, an observation row with its parse run, an event revision by its
   creation. A run recorded before `since` that is sealed after it is not new;
   an old capture parsed again since is (a re-parse after a parser release).
3. **The answer.** Per visible source with something new, in source order:
   `runs` (new fetch runs by their state now: `success`, `partial`, `failed`,
   `human_required`, `cancelled`, `unknown`, or `open` before seal and terminal
   report), `captures` (artifacts of those runs), `parses` (new parse runs by
   state: `published`, `superseded`, `unadopted`, `failed`, `pending`),
   `observations` (rows of the new parse runs a reader may see, that is
   published, superseded or failed, for the store overview's four kinds), the
   newest run time, the newest sealed run id (`r_<id>`, as the evidence browser
   names it), the newest parse time and the artifact of the newest recorded
   parse. Counts are positional in the closed order the answer states
   (`order`). `unchanged` lists the sources with nothing new in any counted
   section and no count cut. `events` counts event revisions created since per
   kind, first revisions (`new`) apart from later ones (`revised`); it is
   `unavailable` with `not_served` where the projection is absent. Closed codes,
   counts, times and ids only: no amount, label or provider text, and nothing is
   compared by value (`notCovered` names `value.change`, which
   `kogane.reported-holdings-change.read` answers).
4. **Handlers.** Each count names the existing read that lists its items and
   the argument a line's value goes in (ADR 0126's pattern): runs
   `kogane.evidence.read` (`page: runs`, `source`); captures
   `kogane.evidence.read` (`page: artifacts`, `runId` from `newestSealedRunId`);
   parses `kogane.observations.get` (`kind: artifact`, `id` from
   `newestParsedArtifactId`); observations `kogane.observations.list`
   (`source`, `kind` per position); events `kogane.events.read`
   (`collection: activity`); an unchanged source
   `kogane.collection-quality.read` (`source`), which says why nothing came.
5. **The grant decides first.** `records.read` over the whole store, refused
   (`unauthorized`, `evidence_restricted`) before the request is checked or
   anything is read. `runs` and `captures` also need `evidence.read`, the
   catalogue capability of their handler: without it both are `null` with
   `sections` saying `unauthorized`, and their tables are not read. Each
   handler's capability is its tool's catalogue capability
   (`CHANGES_SINCE_HANDLER_CAPABILITIES`, held equal by a test).
6. **Bounds.** `since` is an instant with a zone, at most 31 days back
   (`maxDays`) and not in the future (`invalid_query` with `since:format`,
   `since:future` or `since:too_old`). 31 days covers "since my last
   statement" and "since last month"; the cost does not depend on it (point 7),
   and a longer horizon is a history question the existing reads answer. More
   than 200 visible sources is refused (`budget_exceeded`), never cut.
7. **Bounded reads, walked newest first.** Per source, the newest 500 financial
   fetch runs through `idx_fetch_runs_source` (`runWalk`), each with its seal
   and terminal report by key, and their captures counted through
   `idx_fetch_artifacts_run_role`, at most 20,000 rows (`captures`); store-wide,
   the newest 5,000 parse runs by rowid (`parseWalk`), each with its artifact by
   primary key, its publication through `published_parse_runs_run` and its
   annotation by key, and their observation rows through each table's
   `parse_run_id` index, at most 50,000 rows per kind (`observations`); the
   newest 2,000 event revisions by rowid (`eventWalk`). A walk whose next row is
   also new cuts its counts, which are then lower bounds: `cut` names `runs` and
   `captures` on the source, or `parses` and `observations` on every source (no
   source is then `unchanged`), and the events line is `complete: false`. A
   count that reached its row bound cuts the same way. A walk relies on
   recording order (the writers stamp the time when they insert, and nothing is
   deleted); clock skew between Workers can move a row near `since` by that
   skew.
8. **8 KB.** The answer is cut between sources before it passes 8,192 bytes
   (`maxBytes`, measured with the continuation it would carry); `next.after`
   names the last source listed, and the same request with `after` continues.
9. **Reads only (INV07).** The service decides, proposes and writes nothing;
   each served agent call records one R0 audit read (catalogue entry
   `changes.since`, `records.read`) with the sources it covers, truncated when
   it continues or a count is cut.

## Consequences

- Q15 is one call under 8 KB at today's scale: twenty sources with a run every
  hour, three captures and three parses per run, answer in 7,500 bytes with
  every count complete (the size test).
- A call reads a fixed number of rows whatever the store holds: on D1, with 37
  sources, one of them past its run walk, the four queries read 37, 1,194,
  15,201 and 6,003 rows over a history and over a history three times larger
  (the cost test).
- After a replay that re-parses more than 5,000 captures since `since`, every
  source's parse and observation counts are lower bounds and the answer spans
  several calls; the walk says so rather than reading further.
- The digest does not say what a value changed to, does not list terminals
  that never registered as fetch runs (`collection_runs` has no index by time;
  collection quality reads them per source), and does not count scheduled
  payment, identity or price observations (`notCovered`).
- Its events line counts revisions, but `kogane.events.read` still pages every
  current event with no date, account or source filter, so an agent cannot yet
  list only the new ones.
- New published tool and route: one more adapter each; the parity guard lists
  the tool with the route no screen reads. (Since the 2026-11-20 amendment, the
  guard maps the route to the tool.)

### Next slice

`kogane.events.read` filters by date (the event's effective time), account and
source, so the events line's handler can list exactly the revisions it counts.
The filters rewrite a shipped query, so they need what a rewrite needs
([read model: cost](../read-model.md#cost)): the shipped text frozen, a
differential test against it on scaled and random stores, and plan checks
without table statistics. A ホーム panel reading the route would also take the
tool off the parity guard's list of tools without a UI route (done by the
2026-11-20 amendment).

## Verification

- `packages/application/test/changes-since.test.ts`: an empty store (every
  source unchanged, events zero, nothing written); the grant refusals before any
  read and before the request is checked; `since` forms, offsets and the two
  bounds; `after` and its form; new runs per state with their captures, newest
  time and newest sealed run, a run at exactly `since`, an excluded run; a
  source past its run walk cut and one at exactly the walk not cut; `runs` and
  `captures` unauthorized without `evidence.read` with their tables unread;
  parse runs per state with the rows a reader may see, a re-parse of an old
  capture, an excluded run's parse; a parse walk that ends on a new parse
  cutting every source, across several answers; event revisions per kind,
  first and later, and a walk past its bound; capture and observation rows past
  their bounds; more sources than the bound refused; twenty busy sources under
  8 KB in one answer; the largest lines the contract allows continuing across
  answers, each under 8 KB, every source once; every source's counts and
  newest values against a whole read of the base tables on four random stores;
  each handler's capability equal to its tool's catalogue capability; plans
  without table statistics (every table by key or one index range, the two
  rowid walks under their LIMIT, no sort of a table); every answer against the
  wire contract.
- `packages/observation-shared/test/changes-since-contract.test.ts`: the wire
  contract admits what the service produces and refuses a code, order, bound
  or handler outside the domain's lists, a newest value without its count,
  rows of no recorded parse, an unchanged source listed as a line, run
  sections counted for a grant that cannot read them, and a continuation that
  is not the last source listed.
- `services/processor/test/changes-since-cost.test.ts`: on workerd's SQLite
  with every CORE migration, each query's `rows_read` is equal over two
  histories past every walk, the answers are equal, and the queries run under
  D1's limit of five terms in a compound SELECT.
- `services/app/test/changes-since-api.test.ts`: the route, the agent HTTP
  route and MCP give the same answer (but `asOf`), valid against the contract
  and under 8 KB; GET-only, a signed-in subject, `since` and `after` only and
  once each; the grant refusals and the unauthorized run sections; the audit
  read; no write. The UI/MCP parity guard lists the tool; the published tool
  lists include it; its description is under 2,048 characters.

## Amendment 2026-11-20: the ホーム panel reads the route

- Status: proposed (accepted when its pull request merges)
- Date: 2026-11-20
- Revises: decision 1 (no screen reads the route) and the parity consequence
- Owner approval: required before merge. The ホーム page gains a panel; the
  owner approves additions to the UI. The route, the service, the MCP tool,
  its description and the catalogue are unchanged.

### Context

Decision 1 left `GET /api/v2/changes` without a screen, so the UI/MCP parity
guard (`services/app/test/ui-mcp-parity.test.ts`) listed `kogane.changes.since`
among the published tools without a UI route, and the next slice above named
a ホーム panel as the way to take it off. The operator answered "what changed
since yesterday?" on the web only by reading the ホーム page's newest-runs
table and the parse history, which are the newest windows across every
source, with no time bound and no per-source view. ADR 0126's 判断待ち panel
(pull request 1457, open) is the same pattern for another read.

### Options considered

1. **A ホーム panel over the route, with three fixed windows (chosen).** The
   panel reads the route only, shows its answer as it is, and takes the tool
   off the guard's list.
2. **A page of its own.** It would need a navigation entry and a URL state
   for the window. The answer is one screen at today's scale (ADR 0127's
   size test: twenty busy sources in one answer), so ホーム holds it.
3. **Keep the guard entry.** ADR 0081 point 1 makes a read the UI offers an
   MCP read too, not the reverse, so the entry was allowed; but the owner
   asked for the panel rather than the entry.

### Decision

1. **Panel.** 最近の変化 on the ホーム page, after the summary counts and
   before the source cards (`apps/web/src/changes-since.tsx`). It reads
   `GET /api/v2/changes` only, through `useInfiniteQuery` and `getJson`, so
   every answer is checked by `validChangesSince` before it renders, and a
   malformed answer is an error, never a partial panel. It writes nothing.
2. **Window.** Three fixed windows, 24時間 (the default), 7日間 and 30日間,
   each sent as `since` = the browser's clock minus the window, in the
   canonical form the digest echoes. 24 hours is the default because it
   answers "since yesterday" the same way at any hour; "since 00:00 in
   Asia/Tokyo" would show a few minutes just after midnight. 30 days, not 31,
   leaves a day for a browser clock behind the server's before
   `since:too_old`. Each first read of a window (choosing it, a refetch on
   focus, a retry) takes the instant from the clock at that read, and the
   panel's note shows the instant the answer on screen was read for
   (Asia/Tokyo), as the digest echoes it.
3. **Shown, per source.** Its name from the overview's source list beside the
   id; new runs by state (the evidence pages' outcome labels, and 結果未確定
   for `open`), captures, parse runs by state (現行の解析, 旧解析（置換済み）,
   未採用の解析, 解析失敗, 解析待ち), observation rows by kind (the app's
   取引, 残高, 保有資産, 評価額), the newest run and parse times, and a link to
   the newest parse's artifact. Only non-zero states are listed; a section
   with none says なし. Each label map is typed by the domain's closed list,
   so a code added to a list fails the web typecheck until it has a label.
   A section the grant cannot read (`sections.runs: unauthorized`) is not
   shown and the panel says it was not counted.
4. **Lower bounds (INV05).** Every count of a section in a line's `cut`, and
   every count of an events line that is not `complete`, is shown with 以上
   and an 上限で打ち切り badge; a cut section with no count reads 0件以上, not
   なし. A cut section that lists some states adds そのほか 0件以上, and an
   incomplete events line that lists some kinds adds そのほかの種類: 0件以上,
   because a state or kind read as 0 may have new records past the bound; an
   unlisted state reads as exactly none only in a section that is not cut.
   The panel's header count (sources listed) and the unchanged count read 以上
   while the answer continues.
5. **The rest of the answer.** `unchanged` sources in a closed disclosure,
   with a link to 収集の状況 (the collection-quality page, the handler of an
   unchanged source); the events line per kind as 新規 and 更新 counts, or
   its `unavailable` reason (この環境では提供されていません for
   `not_served`); `notCovered` in a closed disclosure, each kind with its
   reason.
6. **Continuation.** When `next` is not null the panel says the list
   continues and offers 続きを読み込む, which sends the same `since` with
   `after` = `next.after` and appends that answer's sources and unchanged
   sources. The events line and `notCovered` are the first answer's. A failed
   continuation is an error beside the button, and the answers already read
   stay.
7. **Refusals.** A `403` (the grant refusals, `unauthorized` and
   `evidence_restricted`) or `404` (a deployment without the route, such as
   the local store) shows no panel. Any other failure (`400`, `413
   budget_exceeded`, a server error, a timeout, a malformed answer) shows the
   app's error state in the panel with a retry, and no count.
8. **Parity.** The guard maps `/api/v2/changes` to `kogane.changes.since` and
   no longer lists the tool among the tools without a UI route.

### Consequences

- Opening ホーム, choosing a window and each continuation read the route once
  each. The route records no audit read (decision 9 records one per agent
  call, not per route read), so the panel adds no audit rows.
- Each continuation is a fresh read (decision 8): a source registered between
  two reads before `after` appears only on a new first read, as for an agent.
- A page left open and refetched (on focus) reads its window from the clock
  again, so the window keeps its length and a 30-day window is not refused
  as `since:too_old` a day later. A continuation sends its first answer's
  `since`, and a refetch reads every page again from the new first answer,
  so the pages on screen always share one instant.
- The panel links only to the artifact of the newest parse and to 収集の状況.
  The runs handler (`kogane.evidence.read`) serves only the configured
  evidence source, and the observation lists take no recorded-time filter, so
  the panel offers no per-count link to the items behind it.

### Verification

- `apps/web/test/changes-since.browser.test.ts`, against a synthetic server
  whose answers the contract admits (checked in the file): per-source labels
  and counts and the artifact link; the default 24-hour `since` and the
  7-day window; a refetch a day later that reads the 30-day window from the
  clock again, with its continuation on the same `since`; cut counts and the
  events line as 以上 with the badge, the states and kinds they do not list
  as そのほか 0件以上, and なし only for uncut sections; unchanged sources
  collapsed until opened;
  `notCovered` with its reasons; a continued answer with `after`, its header
  and unchanged counts as 以上 until the last answer; the unauthorized run
  sections and an events line that is not served; no panel on `403` and on
  `404`; the error state, with no count, on a server error and on an answer
  the contract refuses; the accessibility audit at 1280px and 390px with the
  disclosures open, on the first and on a continued answer.
- `services/app/test/ui-mcp-parity.test.ts`: the web sources name
  `/api/v2/changes`, the guard maps it to `kogane.changes.since`, and the
  tool is not listed among the tools without a UI route.
