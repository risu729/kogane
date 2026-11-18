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
4. The count is coverage, not part of the manifest, so `contextId` is
   unchanged for the same listed statements, snapshots and reviews.
5. The `/state` page lists the counts under 一覧にない期間外の請求; the agent
   read `kogane.reported-state.read` answers the same body through
   `readReportedState` (ADR 0081: no new route or tool, and the parity map's
   entry for `/api/v2/reported-state` is unchanged).

**Consequences.**

- The window and the payables are unchanged; `DATED_STATEMENTS_SQL` keeps its
  text.
- Every reported state runs one more statement, which ranks the statement
  totals before the cutoff again (as `card_statement_facts` does) and resolves
  owners for the older statements through the keyed ownership CTEs. The
  holdings change, the reconstructed state and the valuation on a date, which
  build on `queryDatedState`, run it too. At `STATEMENT_SCALE` on
  2026-11-18 the count took 79 ms and the whole answer 507 ms today and
  455 ms a year back (`bun:sqlite`, a shared machine;
  [reported state, cost](../reported-state.md#cost)), under the one-second
  target.
- The count says nothing about settlement: an older statement that was
  settled long ago is counted as one that never was. It bounds how many
  older captured statements could still be unpaid; it is not a figure of what
  is owed.
- A count can change without a change to `contextId` when a parse of an older
  capture is published late or, under an `account` filter, when an older
  statement's account mapping changes.

**Verification.** `packages/read-model/test/dated-state.test.ts` ("statements
the payable window leaves out": per source, account and reason; on random
synthetic stores the listed and counted statements split the statements as
of the cutoff exactly), `packages/application/test/dated-state-query.test.ts`
(counts under the source and account filters, the gap named only when a
statement is left out), `packages/application/test/dated-state-scale.test.ts`
(the count equals an independent count of the due-before-window statement
keys; no whole scan beyond the statement ranking's own),
`apps/web/test/reported-state-contract.test.ts` (the refusals above),
`apps/web/test/reported-state.browser.test.ts` (the page lists the counts) and
`services/app/test/reported-state-api.test.ts` (on workerd, a store without
statements counts none and does not name the gap), all on synthetic data.
