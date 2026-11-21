# ADR 0019: Reported state on a date from the latest complete capture before it

- Status: accepted (merged 2026-09-27 in #263)
- Date: 2026-09-26
- Implemented by: P2-1 of the
  [next-milestone plan](../plans/2026-09-next-milestone.md)
- Carried by: [reported state](../reported-state.md),
  `packages/parsers/src/snapshot-query.ts` (`cutoffParam`),
  `packages/read-model/src/dated-state.ts`,
  `packages/domain/src/reported-state.ts`,
  `packages/application/src/query/dated-state.ts`

## Context

Phase 8 asks what each provider reported at a point in time, including
positions, provider valuations and card payables, not only today's cash
balances ([roadmap](../roadmap.md#layers-8--11--dated-reported-and-reconstructed-state)).
The current-state reads already choose one complete container snapshot per
partition (policy table, coverage claims, published parses), but only the
newest one. The plan's binding decisions 4.1 (what "reported state on D"
means), 4.2 (perimeter) and 4.5 (reproducibility) were proposed there and are
recorded here as they apply to this first slice; 4.3 and 4.4 (price promotion
and valuation) belong to P2-2 and P2-3.

## Options considered

1. Filter observations by their own `as_of`. Rejected: `as_of` is optional,
   provider-shaped and says nothing about container completeness; a position
   missing from a later capture would still look held.
2. A stored daily projection. Rejected for now: it needs a new table, rebuild
   triggers and a migration, and the per-request read measures under the
   one-second target (below).
3. The latest complete snapshot per container partition captured before
   `(D+1) 00:00` Asia/Tokyo, chosen by the existing snapshot rules through a
   `cutoffParam` option. Chosen.

For the dated snapshot itself, bounding each artifact (`fa.fetched_at < cutoff`
in the `WHERE`) was rejected: a run that crossed the cutoff would contribute
only its earlier artifacts and look like a smaller complete snapshot. Bounding
the snapshot's newest artifact (`HAVING MAX(fa.fetched_at) < cutoff`) keeps a
run whole, and matches the capture time the ranking already uses.

For which statements are payables on D, the plan named no window. Listing
every statement ever captured was rejected (it grows without bound and turns
years of paid bills into rows to read past); listing only statements due after
D was rejected (it hides a bill due before D and not yet seen settled). Chosen:
a fixed window, decision 2.

## Decision

1. **Reported state on D** (4.1) is, per container partition, the latest
   complete snapshot with `observation_fetch_artifacts.fetched_at` before
   `(D+1) 00:00` Asia/Tokyo, compared as the UTC text the column stores. A
   dataset snapshot counts when its newest artifact is before the cutoff, so a
   run that crossed midnight is never split. Without `cutoffParam` the snapshot
   SQL is byte-identical to the shipped text.
   - Freshness `dated-state-freshness-v1`: `same-day` (captured on D in Tokyo),
     `recent` (1–3 days before), `stale` (more).
   - A container without a snapshot is a named coverage entry, never a zero.
2. **Perimeter** (4.2), `dated-state-perimeter-v1`: every selecting policy row
   and the artifact containers, except `sbi-account-assets-current` and
   `sony-bank-gross-balance` (provider aggregates over listed accounts).
   MoneyForward, balances restated after each transaction (registry
   `event-reported`) and reward units are excluded and named. Card payables
   come only from the Vpass and MyJCB statement parsers (`card_statement_facts`
   restated with the cutoff; the view is unchanged). A payable is settled on D
   only by an accepted settlement review whose bank debit is on or before D.
   The payables of D are the statements due on or after `D − 31` days, and
   those without a readable due date captured in the 45 days before the
   cutoff (`PAYABLE_WINDOW_DAYS`, `UNDATED_STATEMENT_WINDOW_DAYS`). This window
   is this ADR's choice, not the plan's: an older statement is not listed, and
   every answer names that gap (`liabilitiesMissing` carries
   `statements_before_window`, with `payablesFromPaymentDate`).
3. **Reproducibility** (4.5): every answer carries a manifest (date, cutoff,
   policy ids, snapshot artifacts, statement observations, settlement reviews)
   and `contextId = canonicalDigest(manifest)`. Nothing is stored yet; fixed
   reports reuse the existing report tables when P2-4 needs them.
4. **No sums.** The answer lists provider figures per provider account with
   their registry metric and aggregation rule; it has no total, subtotal or net
   worth, `liabilitiesCoverage` is always `partial` with the missing kinds
   named, and the wire contract refuses anything else.

## Consequences

- The current-state reads are untouched; the dated reads compose their own
  `dated_`-prefixed CTEs.
- Identity, mappings and settlement reviews are today's: correcting a mapping
  changes an earlier date's answer and its `contextId`. Dated identity is not
  modelled.
- A settlement's debit date is the reviewed bank row's own date; the capture
  of that bank row is not bounded by the cutoff, so a debit captured after D
  but dated on or before D settles the statement on D.
- A statement due before the window (or undated and captured before it) is
  not listed even when no settlement was ever accepted for it; the answer
  states the gap but does not count those statements.
- Adoption across sources is not applied, so two providers reporting one
  holding both appear; P2-3 applies `selectAdoptedSet` before valuing anything.
  _Note (2026-10-09, [ADR 0056 amendment](0056-as-of-price-fx-selection.md#amendment-2026-10-09-valuation-on-a-date-as-implemented)):_
  the valuation on a date does not apply it; it values each listing on its
  own and withholds a total across sources (`adoption_not_applied`). The
  adoption rule is left to the owner.
- No migration: measured without an index (below).

## Verification

`packages/parsers/test/snapshot-cutoff.test.ts` (unchanged text without the
option), `packages/read-model/test/dated-state.test.ts` (cutoff, incomplete,
complete-empty, vanished position, artifact containers, identity, statements
as of the cutoff equal to the view past every capture),
`packages/application/test/dated-state-query.test.ts` (freshness, missing
values, exclusions, coverage, payable transitions, bounds),
`packages/application/test/dated-state-scale.test.ts` (plan checks without
statistics; 398 ms today and 346 ms a year back at `STATEMENT_SCALE` on
`bun:sqlite`), `services/app/test/reported-state-api.test.ts`, and the web
contract and browser tests, all on synthetic data.

## Agent read amendment — 2026-11-06

- Status: accepted (merged 2026-11-06 in #953)
- Date: 2026-11-06

**Context.** The reported state on a date had a route and a page but no agent
read. The `reported-state` intent of `kogane.financial.query` answers the
latest balances and positions, not a dated state. Row D5 of the
[AI operation path plan](../plans/2026-10-ai-operation-path.md#53-reads-searches-and-details)
plans `kogane.reported-state.read` under `records.read`, whole-store only, and
[ADR 0063](0063-delegated-ai-operation-path.md) decision 10 requires a new
read tool to call the route's own reader and to refuse a listed source or
account grant before any read.

**Options considered.** (1) A new `dated-reported-state` intent of
`kogane.financial.query`: rejected, because that service's intents are graded
per scope and paged under a context, and this read is neither scoped nor
paged. (2) A tool with its own validation over `queryDatedState`: rejected,
because two copies of the request rules can drift. (3) One function for the
route's request rules and read, called by the route and by a read tool:
chosen.

**Decision.** `kogane.reported-state.read` (`POST /api/agent/v1/reported-state.read`
and MCP `tools/call`) takes `{date, source?, account?}` as a closed object with
the route's patterns, requires `records.read` over `"*"` sources and accounts
(else `403 unauthorized` or `403 evidence_restricted` before the body is
validated), and answers through `readReportedState`
(`services/app/src/reported-state-api.ts`), which the route also calls: the
same body (`apiVersion: 2` and the reported state), the same refusals
(`invalid_date`, `date_in_future`, `413 result_limit_exceeded`) on both agent
paths. It exists while the route does (`reportedStateOnDate`): otherwise its
name is `unknown_tool` and its path `404`. It is listed only to a grant that
can call it. It is R0: one audit record per served call, whose row count is
the answer's accounts plus payables.

**Consequences.** The committed MCP reader grant (`summary.read` and
`records.read` over the whole store) is listed the tool. The route's own grant
check is unchanged (the reader authority's `summary.read`). The grant's
`budget.maxRows` does not bound the answer; the read's own 5,000-row bound
does, and is refused rather than cut. A scoped version stays unproven.

**Verification.** `services/app/test/reported-state-api.test.ts` ("the agent
tool"): both agent paths answer exactly the route's body; listing per grant
shape and per store; route refusals with equal status and body on HTTP and
MCP; grant refusals before the body is validated; absence without the views; one
R0 audit record per served call with a row count and nothing else. The
pinned tool lists in `services/app/test/agent-api.test.ts` (schema snapshot
included) and `services/app/test/mcp-client.test.ts`.

## Request rules amendment — 2026-11-08

- Status: accepted (merged 2026-11-08 in [#1173](https://github.com/risu729/kogane/pull/1173))
- Date: 2026-11-08

**Context.** The agent read amendment above shared `readReportedState`
between the route and the tool, but the tool validated its body against the
published schema first. A body outside the patterns was therefore
`400 invalid_request` on both agent paths where the route answered the same
request differently: `date=20260910` or a missing date was the route's
`invalid_date`, and a malformed `source` or `account`, an unknown or an empty
parameter its `invalid_query`. [ADR 0081](0081-ui-parity-through-mcp.md)
point 2 asks for the service's refusal codes on both adapters.

**Options considered.** (1) Keep the schema check and document the
divergence: rejected, against ADR 0081. (2) Map the schema's issues to the
route's codes in the tool: rejected, a second copy of the rules that can
drift. (3) Move the request rules into `packages/application` and have both
adapters hand them the same body: chosen.

**Decision.** `readReportedStateRequest`
(`packages/application/src/query/reported-state-read.ts`) takes an untrusted
body and answers the state or a closed refusal with its status:
`invalid_query` (not an object, another key, an empty value; a malformed
`source` or `account`), `invalid_date` (a missing date or one that is not a
`YYYY-MM-DD` calendar day), `date_in_future`, and `result_limit_exceeded`
(413). The route turns its query string into that body
(`reportedStateBodyFromQuery`, which also refuses a repeated parameter as
`invalid_query`); the tool passes its arguments unchanged after its grant
checks. The tool's published schema keeps the service's patterns as a hint.

**Consequences.** The route's answers are unchanged. On both agent paths a
body outside the patterns now gets the route's code instead of
`invalid_request`. The grant checks are unchanged (the tool's
`records.read` over the whole store before the body; the route's reader
authority).

**Verification.** `packages/application/test/reported-state-read.test.ts`
(each body and the query string that spells it get one refusal before any
read; wrong types; the row bound) and
`services/app/test/reported-state-api.test.ts` ("refuses with the route's
codes and the same status on the route and both agent paths": the route,
`POST /api/agent/v1/reported-state.read` and `/mcp` on the same requests).

## Account entries amendment — 2026-11-18

- Status: accepted (merged 2026-11-19 in [#1399](https://github.com/risu729/kogane/pull/1399))
- Date: 2026-11-18

**Context.** `queryDatedState` listed one account entry per (source,
provider account) and named it after the first row that had an account
mapping, in row-id order. An identity can key a source account on more than
the provider account (SBI Securities' foreign positions add the provider's
specific-account code, `packages/identity/src/sbi.ts`), so the rows of one
provider account can map to two resolved accounts, and a capture whose
identity is not recorded yet can sit beside a mapped one of the same
provider account. The rows of the second account were then listed under the
first one's id, and the holdings change between two dates, which takes each
holding's account from its entry, read a holding whose mapping never changed
as `account_differs` and kept it under the `account` filter of an account
its mapping does not name.

**Options considered.** (1) Leave the entry per provider account with no
account when its rows disagree: rejected, the holdings change's `account`
filter would then lose rows that do name the account. (2) Carry an account
on each position and balance: rejected, a wider wire contract for what an
entry already states. (3) One entry per (source, provider account, resolved
account): chosen; it is what the `account` filter already listed for each
account.

**Decision.** An entry is keyed by the source, the provider account and the
resolved account of its rows (null when a row has no mapping). Entries of one
provider account are ordered by account id, the entry without one first. A
provider account whose rows all map to one account is listed exactly as
before.

**Consequences.** The answer is unchanged for every store in which all rows
of a provider account map to one account. The manifest names no account
entry, so the manifest and the context id are unchanged in every store: for
a provider account whose rows map apart, the same context id now names the
corrected entries. The wire shape and `reported-state-v1` are unchanged; the
contract already took several entries of one provider account. A provider
account with rows of two accounts is two entries; a capture whose identity is
not recorded yet beside a mapped one of the same provider account is listed
apart as `not-recorded` instead of under the mapped account. The page keys
its account cards by the three values. The holdings change takes each
holding's account from its own entry, so it no longer reports
`account_differs` for such a holding.

**Verification.** `packages/application/test/dated-state-query.test.ts` (a
provider account whose containers map to two accounts is listed under each,
and each entry equals the `account`-filtered answer) and
`packages/application/test/holdings-change-query.test.ts` (each holding keeps
its own row's account, is `compared`, and the `account` filter keeps only
the holdings of that account); both fail on the previous keying.
`apps/web/test/reported-state.browser.test.ts` ("a provider account whose
rows map apart is one card per resolved account, each named by it") pins the
page.

## Statements before the window amendment — 2026-11-18

- Status: proposed
- Date: 2026-11-18

**Context.** Decision 2 lists as payables of D only the statements due on or
after `D − 31` days and those without a readable due date captured in the 45
days before the cutoff. Every answer named the gap
(`liabilitiesMissing: statements_before_window`) but did not count it, so a
reader could not tell an answer that left nothing out from one that left out
years of statements, and the gap was named even on a store holding no
statement at all ([reported state, limits](../reported-state.md#limits)).

**Options considered.**

1. List every statement as of the cutoff. Rejected for the reason decision 2
   gives: it grows without bound and turns years of paid bills into rows.
2. Count the statements left out and give each its settlement status, through
   the settlement read over every older statement. Rejected for now: it reads
   a review per older statement on every answer, and a status per older bill
   would want its review refs in the manifest, which grows without bound.
3. Count the statements left out per source and reason, from the same
   statement facts as the payables, with no amount and no status. Chosen.

For where the count sits, keeping it out of the manifest (coverage only) was
rejected: decision 3 lists statement observations among the manifest's
inputs, and INV09 ([domain contracts](../domain-contracts.md)) asks for a new
`contextId` when an input differs, so a late parse of an older capture would
change the answer under the same id. Recording the counts per source and
reason only was rejected: under no filter, resolving an older statement's
account would change the inputs and not the id. Chosen: the counts per
source, resolved account and reason, decision 4.

For the reads that build on `queryDatedState` and never show the count (the
holdings change, the reconstructed state and the valuation on a date),
counting anyway was rejected (a second ranking of every statement total per
dated state, discarded), and so was a marker such as
`statementsBeforeWindow: "not-read"` in their dated manifest (it would change
their context ids for no input they read). Chosen: they skip the read, and
their dated manifest has no `statementsBeforeWindow` key, decision 6.

**Decision.**

1. `coverage.statementsBeforeWindow` lists `{sourceId, reasonCode, count}`
   for every source and reason with at least one statement as of the cutoff
   that the window leaves out: `due_before_window` (a readable due date before
   `payablesFromPaymentDate`) or `undated_captured_before_window` (no readable
   due date, captured before the undated bound). It is the complement of the
   payable window over the same statement facts
   (`DATED_STATEMENTS_BEFORE_WINDOW_SQL` beside `DATED_STATEMENTS_SQL`, with
   the same parameters): a statement is a payable or counted, never both and
   never neither. The read counts rows (`count(*)` per source, resolved
   account and reason) and reads no amount; the counts are added per source
   and reason in the query layer.
2. The `source` and `account` filters apply as they do to the payables: the
   account is the one the keyed ownership CTEs resolve, so a statement with
   no resolved account is counted only without an `account` filter.
3. `liabilitiesMissing` names `statements_before_window` exactly when
   `statementsBeforeWindow` is not empty; the other three gaps are always
   named. The wire contract refuses a count that is not a positive integer, an
   unknown reason, any other field (an amount included), and an answer that
   names the gap without a count or counts without naming it.
4. The manifest records the counts: `manifest.statementsBeforeWindow` lists
   `{sourceId, accountId, reasonCode, count}` per source, resolved account
   (`null` when none resolves) and reason, under the answer's filters, only
   counts above zero, ordered by source, account (`null` first) and reason in
   UTF-16 code units. `contextId` is its digest as before, so a changed count,
   a statement left out that moves to another resolved account, or a new
   source or reason gives a new `contextId`. The coverage's counts are the
   manifest's added per source and reason, and the wire contract refuses an
   answer where they disagree, a count that is not a positive integer, an
   empty or non-text account, a repeated (source, account, reason) and any
   other field.
5. The `/state` page lists the counts under 一覧にない期間外の請求; the agent
   read `kogane.reported-state.read` answers the same body through
   `readReportedState` (ADR 0081: no new route or tool, and the parity map's
   entry for `/api/v2/reported-state` is unchanged).
6. `queryDatedState` takes `includeStatementsBeforeWindow` (counted unless it
   is `false`). The reported-state read leaves it unset. The holdings change
   (ADR 0075), the reconstructed state (ADR 0052) and the valuation on a date
   (ADR 0056) pass `false`: they do not run
   `DATED_STATEMENTS_BEFORE_WINDOW_SQL`, and the state they read
   (`UncountedReportedState`) has no `statementsBeforeWindow` in its coverage
   or its manifest, names every liability gap (it cannot tell whether one is
   left out), and has the `contextId` of that manifest. The reported context
   ids those reads pin are therefore ids of a manifest without the count:
   they claim no input that was not read, they are not the `/state` answer's
   `contextId` for the same date and filters, and a statement left out
   changes neither them nor the reads' own context ids.
7. `reported-state-v3`. The context amendment of 2026-11-19 below was
   released first, as `reported-state-v2` without `statementsBeforeWindow`,
   and the wire contract's exact keys refuse a body with a key it does not
   know or without one it requires. Adding the key under the same version
   would make the released v2 contract and this one refuse each other's
   bodies under one version string, so the counts ship as a new version (as
   ADR 0015 and the context amendment did when the manifest changed). A
   client that validates `reported-state-v2` refuses a v3 body instead of
   displaying it.

**Consequences.**

- The window and the payables are unchanged; `DATED_STATEMENTS_SQL` keeps its
  text.
- Every reported-state answer runs one more statement, which ranks the
  statement totals before the cutoff again (as `card_statement_facts` does)
  and resolves owners for the older statements through the keyed ownership
  CTEs. The holdings change, the reconstructed state and the valuation on a
  date skip it (decision 6) and run what they ran before. At
  `STATEMENT_SCALE` on 2026-11-18 the count took 79 ms and the whole answer
  507 ms today and 455 ms a year back (`bun:sqlite`, a shared machine;
  [reported state, cost](../reported-state.md#cost)), under the one-second
  target.
- Every reported-state `contextId` changes once more with this amendment,
  after the context amendment of 2026-11-19 changed it: every manifest
  gains `statementsBeforeWindow` (`[]` when nothing is left out) and names
  `reported-state-v3`. The dated manifests of the holdings change, the
  reconstructed state and the valuation on a date gain no count, but they
  name the schema version too, so the reported context ids they pin
  (`reportedContextIds`, the valuation's reported `contextId`, and
  `startContextId` and `endContextId`), and with them those reads' own
  context ids, also change once more; until this amendment, the context
  amendment of 2026-11-19 had been the last to change them. Nothing stores a
  reported-state context id or one that embeds it, so nothing is rebuilt. No
  test or fixture pinned a literal context id of any of these reads.
- The count says nothing about settlement: an older statement that was
  settled long ago is counted as one that never was. It bounds how many
  older captured statements could still be unpaid; it is not a figure of what
  is owed.
- The count covers captured statements only. Before this amendment a store
  with no statement still named `statements_before_window`; now it names no
  such gap, and a card or month whose statement was never captured is
  neither listed nor counted, with no coverage entry of its own (a limit,
  [reported state, limits](../reported-state.md#limits)).
- The manifest records counts, not which statements were counted (their refs
  would grow without bound). A swap that keeps every count keeps the
  `contextId`: a newer capture of an older statement that takes the place of
  the counted one under the same source, resolved account and reason, or one
  statement leaving a count as another enters it (a limit,
  [reported state, limits](../reported-state.md#limits)).
- The manifest grows with the number of sources, resolved accounts and
  reasons that have a statement left out, not with history; the read's own
  row bound (5,000, refused rather than cut) bounds it.

**Verification.** `packages/read-model/test/dated-state.test.ts` ("statements
the payable window leaves out": per source, account and reason; on random
synthetic stores the listed and counted statements split the statements as
of the cutoff exactly, with statements placed on each boundary: a due date on
`D − 31` days and the day before, an undated capture on the 45-day bound and
a millisecond before, and captures just before and at the cutoff), `packages/application/test/dated-state-query.test.ts`
(counts under the source and account filters in the coverage and the
manifest, the gap named only when a statement is left out; an older
statement published after an answer, and then its account resolved, each
give a new `contextId` while the listed refs stay the same; a state read
without the count runs no `DATED_STATEMENTS_BEFORE_WINDOW_SQL`, records no
count and is otherwise the counted answer),
`packages/application/test/holdings-change-query.test.ts`,
`packages/application/test/valuation-on-date-query.test.ts` and
`packages/application/test/reconstructed-state-query.test.ts` (each records
every statement it runs: no `DATED_STATEMENTS_BEFORE_WINDOW_SQL`; the pinned
reported context id is the uncounted state's; a statement left out changes
the reported state's `contextId`, not theirs),
`packages/application/test/holdings-change-scale.test.ts` (the same on the
scaled store), `packages/application/test/dated-state-scale.test.ts`
(the count equals an independent count of the due-before-window statement
keys; no whole scan beyond the statement ranking's own),
`apps/web/test/reported-state-contract.test.ts` (the refusals above, and
manifest counts that do not add up to the coverage's),
`apps/web/test/reported-state.browser.test.ts` (the page lists the counts) and
`services/app/test/reported-state-api.test.ts` (on workerd, a store without
statements counts none and does not name the gap), all on synthetic data.

## Context amendment — 2026-11-19

- Status: proposed
- Date: 2026-11-19

**Context.** Decision 3 made `contextId = canonicalDigest(manifest)` and the
manifest named the date, cutoff, policy ids and the ids of the chosen
snapshots, listed statements and settlement reviews. The answer reads more
than that, so its context id stayed equal while the answer changed (INV09,
[ADR 0001](0001-domain-axes.md)):

- the `account` filter: two filters over the same snapshots and statements
  listed different accounts under one id;
- the current account and instrument mappings, and the identity run each row
  is read under: a mapping correction changed an entry's account or a
  position's instrument, although the Consequences above and
  [reported state: limits](../reported-state.md#limits) said it changed the
  context id;
- a review's decision: `card_settlement_reviews` is a candidate with its
  newest decision, so accepting a listed review settled a payable under the
  same `card-settlement:<id>`;
- the published parse run of a chosen artifact: an activation or rollback onto
  another parse of the same artifact changed every row while `artifact:<id>`
  stayed;
- the metric registry release (each balance's metric and which rows are
  excluded) and the perimeter's containers without a snapshot (the policy
  rows a migration adds).

**Options considered.** (1) Add each mapping row's id: rejected, it needs the
dated reads to select more columns, a query rewrite with its own proof, while
the answer already carries the values those rows decide. (2) Digest the whole
answer: rejected, the manifest would no longer say what was read, and the id
would move with the presentation. (3) Pin what the answer reads in the
manifest: the filters, the releases, every listed or counted row with the
identity it was read under, each payable's account and each review at its
decision: chosen.

**Decision.** `reported-state-v2`. The manifest adds `metricRegistryRelease`,
`filters`, `containersWithoutSnapshot` (`source/parser/dataset`, sorted),
`rows` (every position and balance the answer lists or counts as excluded, as
`[ref, accountId, accountIdentity, instrumentId, instrumentIdentity]` in ref
order; a row id names its parse run) and `statementAccounts`
(`[statementRef, accountId]`), and each `settlementRefs` entry becomes
`card-settlement:<id>@decision:<decision revision id>`, or `@proposed` before
any decision. The wire contract checks the new keys and that the manifest's
filters are the body's. This amendment was released before the
statements-before-window amendment above: `reported-state-v2` has no
`statementsBeforeWindow`. From `reported-state-v3` (that amendment's seventh
decision) the counts are the manifest's last key, after `settlementRefs`; a
state read without the count (its decision 6) has the keys of this amendment
and no counts.

**Consequences.** Every reported-state context id changes once, and with it
the `reportedContextIds` of the holdings change between two dates, the
reported state's `contextId` inside a valuation on a date, and the
`startContextId` and `endContextId` of a reconstructed state, so their context
ids change once too. Nothing stores a reported-state context id, so
nothing is rebuilt; the cost is a larger manifest (at most one row entry per
position and balance, inside the existing 5,000-row bounds). A mapping
correction that leaves every pinned row's account, instrument and statuses as
they were keeps the id. A balance counted as excluded is pinned with its
identity too, although the answer shows only its count (its account decides
whether an `account` filter counts it), so a correction to its instrument
alone is a new id over an unchanged answer. A stale client that validates
`reported-state-v1` refuses a v2 body instead of displaying it. Identity and
reviews are still today's, not as of `D` (Consequences above): the id now
says which ones were read.

**Verification.** `packages/application/test/dated-state-query.test.ts`
("the context id moves with every input the answer reads": the account filter,
an account mapping revision, an instrument mapping revision, another parse of
the same artifact activated, and a decision on a listed review each change the
id; an unchanged store keeps it; each case failed on the v1 manifest) and
"the context id is a digest of the manifest" (which also checks that the
manifest names the registry release and the coverage's containers without a
snapshot);
`apps/web/test/reported-state-contract.test.ts` (a manifest whose filters are
not the body's, without `rows`, with an unknown identity status or a short
statement account is refused).

## Scheduled payments amendment — 2026-11-21

- Status: proposed
- Date: 2026-11-21
- Issue: [#551](https://github.com/risu729/kogane/issues/551) (liabilities on
  a date), Phase 4 of the [roadmap](../roadmap.md#phase-4--non-card-events-and-dated-state)

**Context.** Since [ADR 0005, amendment (e)](0005-myjcb-statement-state-from-page.md#amendment-2026-09-27-e-the-skip-payment-schedule-page-is-read-as-scheduled-payments)
`myjcb-skip-payment-schedule` stores each row of MyJCB's
ショッピングスキップ払い page, the only place the provider states payments it
deferred, as a `scheduled_payment` observation
(`scheduled_payment_observations`, migration 0061): usage date, payment date,
the exact 今後のお支払い金額, merchant text and the page's as-of date. Nothing
reads that table: the amendment's limits say "no read model, API or UI shows
scheduled payments yet", and [economic events](../economic-events.md#scheduled-card-payments-are-observations-not-obligations)
calls the missing read path a limit, not a design. The reported state on a
date lists card statements as payables and names what it does not show
(`liabilitiesMissing`), but a deferred payment the provider listed was in
neither. What the amount covers (one deferred payment or the rest of it) and
whether a later statement month carries it are not confirmed (ADR 0004), and
the kind has no identity run, so no resolved account.

**Options considered.**

1. A read of its own (route, agent tool and page) for scheduled payments.
   Rejected: what the provider said was still to be paid on a date is the
   reported state's question, and a second dated read would repeat its cutoff,
   freshness and manifest rules.
2. List the rows as payables. Rejected: a payable is a statement total with a
   settlement status, and these rows are not statement totals; matching them
   with a statement or a settlement needs the unconfirmed meaning (INV06,
   ADR 0004).
3. Give the skip-payment container a selecting snapshot policy, so the dated
   snapshot rules choose its capture. Rejected: it changes a policy row every
   current-state read uses, puts the container in the perimeter and its
   coverage, and needs coverage claims the parser does not write.
4. List the newest published capture's rows beside the payables, apart from
   them, with no status but the due date's and never added. Chosen.

**Decision.** `reported-state-v4`.

1. `DATED_SCHEDULED_PAYMENTS_SQL` chooses, per source and fetch unit (a MyJCB
   connection), the newest sealed fetch run that has a published parse of
   `myjcb-skip-payment-schedule` on an artifact captured before the cutoff,
   and returns every such published page of that run with the rows its parse
   stored. A page that listed none is returned once with no row. A newer page
   whose parse is not published leaves the older published run the capture,
   as `card_statement_facts` takes the newest published statement.
2. The served answer gains `scheduledPayments`, after `payables`: one entry
   per chosen page (`artifact:<id>`, source, parser, capture time, its Tokyo
   date, age and freshness under `dated-state-freshness-v1`) with its
   `payments` in due-date order: `scheduled-payment:<id>`, the provider
   account, `scheduleKind`, usage and due dates, the amount as an exact
   decimal of the stored canonical integer (a text that is not one stays
   `unparsed`, never zero), the provider's text, the merchant text, the
   page's as-of date and `dueStatus`: `due_after_date` or
   `due_on_or_before_date`, from the due date alone (whether it was paid is
   not read). An empty `payments` means the page listed none.
3. Nothing is added, matched or adopted: no total, no settlement status, no
   link to a statement or a purchase, and `liabilitiesMissing` and
   `netAssets: "not-computed"` are unchanged.
4. `source` narrows the captures to one source. Under `account` (or a scope
   of accounts) none can match, since the rows have no resolved account: the
   read is skipped, `scheduledPayments` is empty and
   `coverage.scheduledPayments` is `not_listed_account_filter`; otherwise it
   is `listed`.
5. The manifest records `scheduledPaymentCaptures`, each chosen page as
   `[artifact:<id>, parse_run:<id>]`, and `scheduledPaymentRefs`, each listed
   payment, both sorted, so a newer capture, another parse of the same page
   or another row is a new `contextId` (INV09). The wire contract checks the
   new shapes, that the manifest pins exactly the listed pages and payments,
   and that nothing is listed under `not_listed_account_filter`.
6. The state the holdings change, the reconstructed state, the valuation on
   a date and the upcoming bills view of the card debit-account read
   (ADR 0114) build on (`includeStatementsBeforeWindow: false`, the
   statements-before-window amendment's decision 6) skips this read as it
   skips the count: it has no `scheduledPayments`, no
   `coverage.scheduledPayments` and no manifest keys for them.
7. `datedState` (`packages/application/src/query/store-schema.ts`) also
   requires `scheduled_payment_observations`, so the route, the agent read
   and the page are served only on a store that has it.
8. The `/state` page shows the captures in a panel スキップ払いの予定 after
   the card statements; `kogane.reported-state.read` answers the same body,
   and its audit record counts the captures among its rows.

**Consequences.** Every reported-state `contextId` changes once more
(`reported-state-v4`), and so do the reported context ids that the holdings
change, the valuation on a date and the reconstructed state pin, since their
manifest names the schema version, although they read nothing new. Nothing
stores them, so nothing is rebuilt. A stale client that validates
`reported-state-v3` refuses a v4 body. The upcoming bills view of the card
debit-account read (ADR 0114) uses only the state's accounts and pins no
reported-state context id, so it reads the state without the count and
without this read (decision 6), and its answer is the one the full state
gives: `packages/application/test/card-upcoming-bills.test.ts` compares the
two byte for byte on a synthetic store and on random stores. The one
difference is a store where the count or this read alone passes
`DATED_STATE_ROW_BOUND`: the full state is refused there, which left every
balance of the view `missing` with `reported_state_limit_exceeded`, and the
view now reads them. The read scans the
publication pointers (`published_parse_runs`) filtered by parser name and
reaches each page's artifact by primary key and its rows through
`idx_sched_pay_obs_parse_run`: on workerd, D1's own plan without statistics is
that, and its `rows_read` is the pointers plus a few rows per page
(`services/processor/test/myjcb-shared-r2.test.ts`, on a small store). It is
not timed on D1 ([reported state, cost](../reported-state.md#cost)).

Limits: only MyJCB's skip-payment page is read; the bonus page stays unread
(ADR 0005, amendment e). Production has stored only pages that listed none
(amendments i and k), so a row shape with payments is the parser's mirror of
the observed head, exercised by synthetic tests only. A newer page whose parse
is not published (pending, refused, or never parsed because its run was not
failure-free), and a newer run that stored no skip page, leave an older
capture current with its age shown, and the answer does not say that a newer
page exists. A scheduled payment is not a liability
figure: unbilled usage, installment remainders and loans stay named as
missing.

**Verification.** `packages/read-model/test/dated-state.test.ts` ("scheduled
payments as of the cutoff": the newest run per fetch unit before the cutoff,
rows as stored, an empty page kept, a later capture and an unpublished page
ignored, two pages of one run listed, and the plan without table statistics);
`packages/application/test/dated-state-query.test.ts` ("scheduled payments on
the date": exact amounts and due statuses, an empty capture, the manifest pins
and a new capture's new context id, the source and account filters, the
uncounted state skipping the read, the pure due rule and contract refusals;
the random-store test now also holds skip pages); `packages/application/test/propose-store.test.ts`;
`services/app/test/reported-state-api.test.ts`;
`apps/web/test/reported-state.browser.test.ts` (the panel lists both
payments with their due statuses, the empty page as empty, no sum, and before
any capture says that is not "none scheduled");
`packages/application/test/dated-state-scale.test.ts` (on the complete CORE
schema without statistics, the read walks no stored table whole but the
publication pointers); `services/processor/test/myjcb-shared-r2.test.ts` (on
workerd, a skip page the collector's plan registers and the processor parses
is listed with both rows by the read and by `queryDatedState` through the wire
contract, with D1's plan and `rows_read` as above).
