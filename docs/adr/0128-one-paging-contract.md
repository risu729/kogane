# ADR 0128: One paging contract for every paged tool result: `next.arguments`, `paging` and one refusal family

- Status: proposed. The owner asked for this on 2026-11-20 ("unify the paging method, and fix the other
  places that are needlessly inconsistent"); that request allows the proposal, not the published
  changes. Every change below to a published tool's arguments, results or refusals needs **the
  owner's approval before merge**, as for every published tool change.
- Date: 2026-11-20
- Plan: [MCP consistency](../plans/2026-11-mcp-consistency.md) (inventory with file and line
  references, and the slices)
- Related: [ADR 0081](0081-ui-parity-through-mcp.md) (one service per UI page and MCP read; its
  2026-11-07 amendment introduced `nextPage`), [ADR 0119](0119-cursor-page-size.md) (a snapshot cursor
  continues at any offered `limit`), [ADR 0123](0123-summary-detail-for-large-reads.md) (`mustMatch` on
  `cursor_mismatch`), [ADR 0127](0127-changes-since-digest.md) (`next.after`)

## Context

The MCP protocol defines cursor paging only for its list methods (`tools/list` and the like). A
`tools/call` result has no protocol-level paging, so every kogane read pages through its own
arguments and result fields. The inventory in the plan (§1) found, across 53 published tools and their
routes:

1. **Eight ways to say "continue here"**: `cursor` (opaque keyset), `cursor` (`c_<id>`), `cursor` (an
   operation id), `cursor` (an artifact id as text), `offset`, `offset` plus `latestOffset`, `after`
   (a source id) and `filters` + `cursor` (audit). The next position is named `nextCursor`,
   `nextOffset`, `latestNextOffset`, `coverage.nextOffset`, `page.nextCursor`, `data.nextCursor`,
   `result.nextCursor`, `next.after`, or a result field called `cursor`. Events and reports return an
   offset as text in a field named `nextCursor`.
2. **Five ways to say "rows follow"**: `coverage.truncated`, `page.hasMore`, `nextPage` (`offered`,
   `none`, `budget_exceeded`), a non-null token, and `next`. `truncated` also means "a data bound cut
   this" (`explain`, the survey, the overview's run windows, financial `coverage.truncated`), and the
   artifacts list sets it on every page after the first, the last one too. The audit record's row
   counter needs ten per-tool rules to tell (`services/app/src/audit.ts:189-381`).
3. **Six refusals for a bad token**, with three status codes for one meaning: `400 cursor_mismatch` +
   `mustMatch`, `400 invalid_cursor`, `400 invalid_query`, `409 stale_context`, `404
   receipt_not_found`, `410 context_expired`, while `financial-error-v1` maps `context_expired` to 409.
4. **Silent edges**: an offset read whose filter changes mid-walk pages another list without a word;
   the candidate reads null `nextOffset` when the grant's `maxRows` would refuse the next page, with no
   code saying rows follow; the operations list's cursor is not bound to its filters.

An agent that guesses one tool's dialect from another's does not fail loudly: it stops early and reads
a partial list as the whole one, which is what INV05 forbids a total to do.

## Options considered

1. **Leave each read as it is and document each dialect better.** No code risk, but the agent still
   has to learn 15 dialects, and the silent edges stay.
2. **One opaque `cursor` for every read, every offset hidden inside a token.** One input and one output
   name. But the web UI jumps to numbered pages by `offset`, three reads hold two positions at once
   (observation balances: history and latest), and a byte-bounded answer (`changes.since`) has no row
   offset; every page of the UI would move in one change, and the in-flight branches would be redone.
3. **One continuation surface over the existing positions (chosen).** Every paged answer says how to
   continue as the exact arguments to add to the same call (`next.arguments`) and how the page ended
   (`paging`). The position underneath stays what each read needs (keyset, offset, two offsets, an id),
   because a client never builds it: it copies `next.arguments`. Server-minted tokens share one input
   name (`cursor`); offsets stay `offset` where the UI uses them as page numbers. The refusals become
   one family with fixed codes. This is additive per tool, can move in batches, and does not redo the
   in-flight work.
4. **Return a `next` that is a whole new call (`{tool, arguments}`).** It could hand a continuation to
   another tool, but no read continues in another tool, and a full argument set repeats every filter
   (bytes in an 8 KB answer) and invites a client to drop its own arguments.

## Decision

### 1. `next`: how to continue

Every paged answer carries

```ts
next: { arguments: Record<string, string | number> } | null;
```

- `next.arguments` holds exactly the argument names and values to **set** on the same call: a client
  repeats its last call's arguments with these merged over them. On a route the same names are query
  parameters. It names only continuation arguments (`cursor`, `offset`, `latestOffset`), never a filter
  and never a page size: every other argument repeats as it was.
- `next` is null on the last page, and also when rows follow but the grant's `maxRows` withholds the
  next page (`paging.stoppedBy: "budget"`, below).
- It sits at the top level of the answer the route serves, beside the read's existing fields, so a
  page read's MCP answer has it under `data` and route, agent HTTP and MCP stay one answer. Where an
  agent wrapper decides the budget (`purchases.explain`'s `nextPage`), it sits at the wrapper's top
  level.
- `next.arguments` hides the position kind. Keyset reads put an opaque `cursor`; offset reads put
  `offset`; the observation balance list will put both `offset` and `latestOffset` (slice S3).

### 2. `paging`: how this page ended

```ts
paging: {
  limit: number | null; // the most items a page holds, in the page's unit; null when only a byte bound applies
  returned: number; // items on this page, in the same unit
  hasMore: boolean; // items follow this page in the read's order
  stoppedBy: "limit" | "bytes" | "budget" | "walk" | null;
}
```

Invariants, checked by one shared validator: `hasMore` is false exactly when `stoppedBy` is null;
`next` is non-null exactly when `hasMore` is true and `stoppedBy` is not `budget`; `returned <= limit`
when `limit` is a number; `returned == limit` when `stoppedBy` is `limit`; `returned < limit` when
`stoppedBy` is `walk` and `limit` is a number.

- **Why `paging`, not `page`.** `page` already names an input (`store.read`, `evidence.read`) and two
  versioned result shapes with exact keys: `snapshot-page-v1`'s page info (balances, reward expiry,
  the in-flight cash page) and the holdings change summary's page. Reusing the name would change those
  versioned shapes; a new name is additive.
- **Why `hasMore`, not `complete`.** `hasMore` is what `snapshot-page-v1` and the holdings change
  already say. `complete` and `completeness` already mean data completeness (financial-result-v1,
  `dataCoverage`, card purchase figures, changes-since events, pending decision lines), and a last page
  says nothing about whether the data behind it is complete (`packages/domain/src/paging.ts:1-6`).
  `paging` describes the page only; INV05 reasons stay where they are.
- **Why `stoppedBy`.** It separates "the page is full" (`limit`), "the answer reached its byte bound"
  (`bytes`, purchase lines, changes since) and "rows follow but this grant may not read them"
  (`budget`, today `nextPage: "budget_exceeded"`, and today silent on the candidate reads).
- **`walk`** (added 2026-11-20 in review, for the events-filters branch; the owner asked for one
  paging contract, not for this value, which needs the owner's approval with the rest of this ADR):
  a scan bound ended the page before it was full. A filtered read that walks at most so many rows
  per call (the filtered `events.read` activity list walks at most 5,000 live revisions) can stop
  before it has `limit` matches: `returned` is below `limit`, perhaps zero, and `hasMore` is true,
  because the read continues where the walk stopped (`next` names that position). A page that holds
  `limit` items says `limit`, even when the walk ended at the same row. None of the other three is
  honest for a short page: it is not full (`limit`), no byte bound applied (`bytes`), and nothing is
  withheld (`budget`). A client treats it like any other continuing page and calls again with
  `next.arguments`; a short or empty `walk` page is never the end of the list. No S1 read answers
  it.

### 3. Argument names

| Inconsistency                                                                                                            | Decision                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token argument: `cursor`, `after`                                                                                        | **Fix**: every server-minted token is `cursor`. `changes.since`'s `after` becomes `cursor` (S5).                                                                                                                                                                                                                                         |
| Position argument `offset` (and `latestOffset`)                                                                          | **Keep**: an offset is a position the caller may choose (the UI's numbered pages), not a token; `next.arguments` carries it, so an agent never builds one. **Fix later** (S8): offset reads also bind their filters by minting a `cursor`, so a changed filter is `cursor_mismatch` instead of another list's page.                      |
| Page size: `limit` (input); `limit`, `pageSize` or nothing (output)                                                      | **Fix**: `limit` is the one input name (already true); every paged answer reports `paging.limit`. **Keep** each read's offered sizes (1–1000, sets of 4–6 sizes, fixed): each is what its page bound and cursor digest support (ADR 0119).                                                                                               |
| `account`, `accounts`, `sourceAccountId`, `identifierId`                                                                 | **Keep**: `sourceAccountId` names a source reference, not an account; one name for two identifiers would invite passing one as the other.                                                                                                                                                                                                |
| Days: `from`/`to` inclusive, `from`/`before` (reward expiry), `date`, `period`/`usageMonth`, `since`                     | **Keep**: `before` says its end is exclusive, `since` takes an instant, `period` and `usageMonth` are months; each name states a different meaning.                                                                                                                                                                                      |
| `audit.search`: `filters: {...}` nested, days in UTC                                                                     | **Fix later**: top-level filter arguments like every other read; whether its days move to Asia/Tokyo is the owner's decision (the audit records are UTC instants).                                                                                                                                                                       |
| Selector: `collection`, `kind`, `page`, `view`; `view` also the measure view                                             | **Keep for now**: each is its route's path segment (ADR 0081), its values are an enum, and a wrong name is refused loudly. `view` meaning two things is the owner's decision after S3, which already edits the balance reads.                                                                                                            |
| Instants                                                                                                                 | **Keep**: answers write UTC with `Z`; inputs that need an instant say which form they take.                                                                                                                                                                                                                                              |
| `schemaVersion` names, `apiVersion`                                                                                      | **Keep**: they are versions clients and stored records key on. New answers use `schemaVersion: "kogane-<name>-v<n>"`. Adding `next` and `paging` does not bump a version: the only clients are the owner's MCP clients, which re-list the tools each session, and the web UI and conformance tests, which move in the same pull request. |
| Data bounds: `cut`, `budget.trimmed`, `cardsTruncated`, `counterpartyCut`, `leadSearch`, survey and overview `truncated` | **Keep**: they say a count, a graph or a text is bounded, not that another page exists; `paging` never replaces them. A `truncated` that does mean "a next page exists" (`coverage.truncated` on paged reads) is superseded by `paging.hasMore` and goes in S9.                                                                          |

### 4. One refusal family

| Code                    | Status | When                                                                                                                                                 | Hint                                                                                              |
| ----------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `invalid_cursor`        | 400    | the token is not one this read issued: it does not decode, names no row (today `404 receipt_not_found` on the operations list) or lies past the list | –                                                                                                 |
| `cursor_mismatch`       | 400    | the token was issued for other arguments (today `409 stale_context` on `audit.search`)                                                               | `mustMatch`: the argument names that must repeat as they were, names only                         |
| `context_expired`       | 410    | the fixed context the token names (a snapshot, a READ instance, a comparison) is gone; read again without `cursor`                                   | –                                                                                                 |
| `result_limit_exceeded` | 413    | the answer would pass the read's bound                                                                                                               | `retryWith: {arguments}` when another argument set answers (today `retryWith: {detail}` on #1483) |

- 400 for both token errors: the request is wrong as sent and repeating the named arguments (or none)
  fixes it; 409 says "the server state conflicts", which a mismatched filter is not. 410 for an expired
  context: it is gone, and it will not come back.
- `retryWith` has the same shape as `next` so one client rule covers both: merge `.arguments` into the
  last call.
- **Body.** Routes answer `{error, requestId, refs?, mustMatch?, retryWith?}` as today; a tool answers
  the same without `requestId` (page reads already do). The read tools still drop `refs` from an
  `HttpError` they catch (`services/app/src/read-tools.ts`); none of the S1 paging refusals carries
  refs, and keeping them there is left to the slice that next edits that path. **Keep** `financial-error-v1` for the agent query path: it is a
  versioned schema whose remedies `kogane.capabilities` publishes. **Open** (S7, the owner's
  decision, [below](#s7-open-decision)): whether it gains `invalid_cursor` and `cursor_mismatch` (400,
  argument names as `argument:<name>` refs) and answers `context_expired` at 410 in place, or a
  `financial-error-v2` carries them. Until the owner decides, the agent query path answers its
  refusals exactly as before.
- **Keep** `invalid_request` (400, refs naming the argument) for a token that fails its published
  pattern, and `invalid_offset` for a malformed offset on a route: those are the argument's form, not
  its meaning. **Keep** `413 raw_too_large`: no argument set retrieves a larger object.

### Published changes in S1, for the owner's approval

Every item below changes what a published tool or route answers; none merges before the owner
approves it.

- **New result fields** `next` and `paging` on `kogane.identity.read`, `kogane.events.read`,
  `kogane.reports.read` (list), `kogane.evidence.read` (runs, artifacts),
  `kogane.reported-holdings-change.read` (summary), `kogane.card-settlements.read`, `.statements`
  and `.unmatched`, `kogane.purchases.explain` (`view: events` and `lines`, at the wrapper's top
  level), `kogane.ops.operation.list`, `kogane.audit.search` and `kogane.schedules.maintenance.read`
  (summary), and on their routes (`/api/identity/account-list`, `accounts`, `instruments` and
  `coverage`, not `connections`; `/api/v2/activity`, `/api/v2/obligations`, `/api/v2/reports`,
  `/api/evidence/v1/.../runs` and `.../artifacts`, `/api/v2/reported-holdings-change` (summary),
  `/api/v2/reconciliation/card-settlements[/statements]`,
  `/api/v2/reconciliation/card-statements-unmatched`, `/api/ops/v1/operations`, `/api/v2/audit`;
  `kogane.purchases.explain` and `kogane.schedules.maintenance.read` have no route, and
  `GET /api/v2/card-purchases` is unchanged). Every other field is unchanged.
- **The stop values S1 answers**: `limit`; `budget` on the card settlement reads and
  `kogane.purchases.explain` when the grant's `maxRows` withholds the next page (`next: null`,
  `hasMore: true`; the card settlement reads already said this as `nextPage: "budget_exceeded"`);
  `bytes` on `kogane.purchases.explain` `view: lines` when the byte bound ends a page short. The
  contract and the agent API doc also define `walk` (§2), which no S1 read answers.
- **`audit.search` and `GET /api/v2/audit`**: a cursor issued under other filters, `409
  stale_context`, becomes `400 cursor_mismatch` with `mustMatch` (the six filter parameters on the
  route, `["filters"]` on the tool); a cursor that does not decode, `400 invalid_query`, becomes
  `400 invalid_cursor`. A malformed filter stays `400 invalid_query`.
- **`ops.operation.list` and `GET /api/ops/v1/operations`**: a cursor that names no operation,
  `404 receipt_not_found` with ref `cursor`, becomes `400 invalid_cursor` with ref `cursor`.
  `kogane.ops.operation.get` keeps `404 receipt_not_found` for an id that names nothing.
  `invalid_cursor` joins the command error codes (400).
- **Audit records** of those refused calls carry the new codes as their `resultCode`
  (`cursor_mismatch`, `invalid_cursor`), so `kogane.audit.search` lists them under the new codes.
- **Descriptions** of the twelve tools name `next.arguments` and `paging`; eleven also name their
  deprecated fields. `kogane.purchases.explain`'s does not (`nextPage`, `data.nextOffset`,
  `data.nextCursor`): it is 2,028 characters of the 2,048 a description may hold, so the agent API
  doc's list of kept fields is where an agent learns they go. Those of `kogane.audit.search` and
  `kogane.ops.operation.list` also name their new refusals.
- **Web UI**: the 監査ログ and 依頼の一覧 pages explain a refused cursor by the new codes (the
  operations page's message for `invalid_cursor` is new); no page reads `next` or `paging` yet.

### Published changes in S6 and S7, for the owner's approval

Implemented on the branch stacked on this ADR's pull request
(`claude/adoring-faraday-co4por-mcp-consistency-s6-s7`). Every item changes what a published tool
or route answers; none merges before the owner approves it.

- **S6, new result fields** `next` and `paging` on `kogane.accounts.candidates` and
  `kogane.instruments.candidates` and their routes (`/api/identity/account-candidates`,
  `/api/identity/instrument-candidates`), beside the deprecated `nextOffset`; their descriptions
  name `next.arguments`, `paging`, the `budget` stop and the deprecated `nextOffset`.
- **S6, a stop that was silent**: a page whose next page the grant's `maxRows` refuses says
  `stoppedBy: "budget"` with `hasMore: true` and `next: null`. `nextOffset` is null there as before,
  as it is on the last page, so only the new fields tell the two apart. The stop values S6 answers:
  `limit` and `budget`.
- **S7, new result fields** `next` and `paging` on `kogane.financial.query` and
  `GET /api/v2/query`, for the row intents only (`activity`, `reported-state`): at the top level of
  `kogane-query-response-v1`, beside `result`, not inside `financial-result-v1` (see the open
  decision below). `next.arguments` is `{cursor}`, the token `result.nextCursor` already carries;
  `paging.limit` is the resolved page size. `coverage` and `holdings` answer whole and carry
  neither field. The stop value S7 answers: `limit`. The description names `next.arguments` and
  `paging`, and says `result.nextCursor` names the same cursor; it does not call
  `result.nextCursor` deprecated, because removing it from `financial-result-v1` is part of the
  open decision.
- Nothing else in any of the three answers changes: with `next` and `paging` removed, each answer
  is byte for byte the one shipped before (the differential tests under Verification). No refusal
  changes: the candidate reads keep `413 budget_exceeded` for a page past `maxRows`, and the agent
  query keeps every `financial-error-v1` code and status.
- **Web UI**: none of its pages reads the new fields yet; the shared validators check them when
  present (`validApiResponse` for both candidate routes and `/api/v2/query`).

### S7: open decision

The owner has not decided whether `financial-error-v1` gains the paging refusals in place or moves
to a v2 (plan, owner decision 5). S7 implements nothing that depends on the answer:

- **Refusals, unchanged.** A cursor this context or query did not issue, or one that does not
  decode, stays `409 stale_context` with the context id as its ref; `context_expired` stays 409;
  a page past `maxRows` stays `413 budget_exceeded`. Neither `invalid_cursor` nor
  `cursor_mismatch` is answered on the agent query path, and `kogane.capabilities` publishes the
  same remedies.
- **Where `next` and `paging` sit.** Inside `financial-result-v1` they would change a versioned
  shape whose validator checks exact keys (`packages/domain/src/result.ts`), which is the same
  in-place-or-v2 question; beside `result`, in the open `kogane-query-response-v1` wrapper, they
  are additive and pre-empt nothing. If the owner chooses a v2, the fields can move into
  `financial-result-v2`; in place, they can stay where they are.
- **No budget stop.** The query offers its cursor whenever rows follow, and a continued call
  whose `offset + limit + 1` passes `maxRows` is refused `413 budget_exceeded`, where the other
  reads withhold the page (`stoppedBy: "budget"`). Withholding would null `result.nextCursor`, a
  `financial-result-v1` field, and the honest refusal for the continued call is a code of the
  open decision (a `413 result_limit_exceeded` with `retryWith: {arguments: {limit}}`, since a
  smaller `limit` reads the same position). Until the decision, `next` says exactly what
  `nextCursor` says, and the limit is written in the agent API doc.
- **The options.** (a) In place: `financial-error-v1` adds `invalid_cursor` and `cursor_mismatch`
  to `FINANCIAL_ERROR_CODES`, maps `context_expired` to 410, and splits today's `stale_context`
  on a cursor into the two; a client keyed on `409 stale_context` for a bad cursor silently
  changes branch. (b) A `financial-error-v2` (and with it, if wanted, a `financial-result-v2`
  holding `next` and `paging`) for the agent query path; v1 stays as it is until clients move.

### 5. Migration

- **Outputs are additive for one release.** Each converted read keeps its old continuation fields
  (`nextOffset`, `nextCursor`, `nextPage`, `coverage.truncated`, `pageSize`, audit's result `cursor`)
  beside `next` and `paging`; its description says they are deprecated in favour of `next` (in S1, every
  converted description but `kogane.purchases.explain`'s, which has no room; see the S1 list above). They go in
  S9, after every slice has been deployed for one release. The reason is the asymmetry of the two
  failures: a removed input is refused loudly by a closed schema (`400 invalid_request`), but a removed
  output is silent: an agent session that listed the tools before the deploy and looks for
  `nextOffset` reads its absence as the last page, which is a partial list read as whole.
- **Inputs are replaced outright** where renamed (`after` in S5): the owner's MCP clients re-list the
  tools each session and the web UI moves in the same pull request, and an old name is refused, never
  misread.
- **Web UI.** Each slice's shared validators check `next` and `paging` when an answer carries them,
  and that they say what the old fields say; until S9 they also accept an answer without them (the
  wire types declare them optional, `PagedWireFields`), so the UI's fixtures and any answer cached
  across a deploy still validate. The server sends both on every converted read, which the
  conformance walk checks. The pages keep reading the old fields until S9 moves them to
  `next`/`paging` (or a slice that edits a page anyway moves it earlier); S9 makes the new fields
  required. A page that explains a refused cursor moves with the refusal in the same slice (S1: the
  監査ログ and 依頼の一覧 pages).
- **Conformance.** A shared walk (`packages/observation-shared/test-support/paging-walk.ts`) calls a
  converted tool, follows only `next.arguments`, and checks it reaches `next: null` with every seeded
  item once, no duplicate and no gap, and `next` and `paging` valid on every page. A registry
  (`services/app/test/paging-registry.ts`) names every published tool that takes a continuation
  argument as either walked (with the test that walks it) or waiting (with its slice), and
  `ui-mcp-parity.test.ts` checks the published tool list against it; the waiting list must be empty
  at S9.

### 6. Slices

S1 (this ADR's pull request) adds the contract to `packages/observation-shared/src/paging-contract.ts`
and converts the reads no in-flight branch touches, except `rewards.read`, whose holdings page unit
needs a decision first (S1b); S2–S7 convert the rest after the branches named in the plan merge; S8 binds offsets; S9 removes the deprecated fields. The plan's §3 names each slice and
what it waits for.

| Slice  | State                                                                                                                                                    |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1     | implemented on this ADR's branch                                                                                                                         |
| S6     | implemented on the stacked branch `claude/adoring-faraday-co4por-mcp-consistency-s6-s7` (#1457, which it waited for, has merged)                         |
| S7     | `next` and `paging` implemented on the same stacked branch; the `financial-error-v1` refusals wait for the owner's decision ([above](#s7-open-decision)) |
| others | proposed (plan §3)                                                                                                                                       |

## Consequences

- An agent learns one rule: "if `next` is not null, call again with `next.arguments` merged in; if a
  refusal carries `retryWith`, call again with `retryWith.arguments` merged in". It never has to know
  whether the read is keyset or offset.
- Rows that follow but the grant withholds are said everywhere (`stoppedBy: "budget"`), including the
  candidate reads where they were silent before S6, except `kogane.financial.query`, which offers
  its cursor and refuses the continued call until the S7 decision.
- Answers grow by about 100 bytes (`next` and `paging`); byte-bounded answers count them inside their
  bound, so no answer passes its published size.
- Until S9 a converted answer says the same thing twice; a test checks the two never disagree.
- The audit record's row counter can read `paging.hasMore` alone once S9 lands; until then it keeps
  its per-tool rules, which two in-flight branches edit.
- Not decided here: the selector names and the two meanings of `view`, the audit days' zone, and
  whether `financial-error-v1` moves to a v2.

## Verification

- `packages/observation-shared/test/paging-contract.test.ts`: the validator accepts each legal
  combination of `next` and `paging` and refuses each broken invariant; the builders produce only
  valid values; the refusal builders produce the family's codes and statuses.
- `services/app/test/paging-conformance.test.ts` and `paging-conformance-cards.test.ts`: the walk
  over the converted reads on `/mcp` (the operations list on its route too, with the same calls and
  rows), with the refusals of a changed filter and a foreign cursor; the holdings change and the
  purchase lines and events are walked in their own test files on their seeded stores, and the
  maintenance summary over the pure function the tool answers
  (`packages/collection/test/maintenance-summary.test.ts`).
- `services/app/test/ui-mcp-parity.test.ts`: every published tool that takes a continuation argument
  is walked or waiting for a named slice; each walked tool's description names `next.arguments` and
  `paging`.
- The existing parity tests (route, `/api/agent/v1/*` and `/mcp` give one answer) cover the new fields
  on every converted page read; each converted read's own test checks `next` and `paging` against its
  old fields on a first, middle and last page.
- `services/app/test/ui-mcp-parity.test.ts`: every published description stays within 2,048
  characters.
- The frozen-handler differential tests of the card settlement routes strip `next` and `paging` only
  after checking they agree with `nextOffset` and `nextPage`, so every other byte is still compared.
- The web UI's schema tests accept the converted answers with the new fields.
- S6 and S7: `services/app/test/paging-conformance-candidates.test.ts` walks both candidate reads
  over `/mcp` by `next.arguments` alone, each page the same answer on its route, the agent HTTP
  path and `/mcp`, and the `budget` stop at `maxRows` 99 and 100;
  `services/app/test/paging-conformance-query.test.ts` walks `activity` and `reported-state`,
  checks the three transports page for page, and pins the unchanged refusals of the open
  decision. `packages/observation-shared/test/paged-answers-s6-s7-contract.test.ts` refuses
  fields that disagree with `nextOffset` and `total`, or with `result.nextCursor`.
- Differential, S6 and S7: `packages/application/test/candidate-reviews-paging-differential.test.ts`
  runs both candidate readers beside their frozen pre-S6 text (`candidate-reviews-legacy.ts`) on
  the synthetic worlds, scaled stores and seeded random ones, over every view, offsets and grant
  budgets around the page edges; `services/app/test/paging-conformance-query.test.ts` runs
  `queryResponse` beside its frozen pre-S7 text (`query-response-frozen.ts`) over every intent,
  limits, filters, every page of each walk and three refusals. Every answer without `next` and
  `paging` is byte-identical to the frozen one, and every refusal is identical.
