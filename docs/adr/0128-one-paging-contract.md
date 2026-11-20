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
  stoppedBy: "limit" | "bytes" | "budget" | null;
}
```

Invariants, checked by one shared validator: `hasMore` is false exactly when `stoppedBy` is null;
`next` is non-null exactly when `hasMore` is true and `stoppedBy` is not `budget`; `returned <= limit`
when `limit` is a number.

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
  the same without `requestId` (page reads already do; read tools that drop `refs` keep them from S1
  on for the converted tools). **Keep** `financial-error-v1` for the agent query path: it is a
  versioned schema whose remedies `kogane.capabilities` publishes; **fix later** (S7): it gains
  `invalid_cursor` and `cursor_mismatch` (400, argument names as `argument:<name>` refs) and answers
  `context_expired` at 410.
- **Keep** `invalid_request` (400, refs naming the argument) for a token that fails its published
  pattern, and `invalid_offset` for a malformed offset on a route: those are the argument's form, not
  its meaning. **Keep** `413 raw_too_large`: no argument set retrieves a larger object.

### 5. Migration

- **Outputs are additive for one release.** Each converted read keeps its old continuation fields
  (`nextOffset`, `nextCursor`, `nextPage`, `coverage.truncated`, `pageSize`, audit's result `cursor`)
  beside `next` and `paging`; its description says they are deprecated in favour of `next`. They go in
  S9, after every slice has been deployed for one release. The reason is the asymmetry of the two
  failures: a removed input is refused loudly by a closed schema (`400 invalid_request`), but a removed
  output is silent: an agent session that listed the tools before the deploy and looks for
  `nextOffset` reads its absence as the last page, which is a partial list read as whole.
- **Inputs are replaced outright** where renamed (`after` in S5): the owner's MCP clients re-list the
  tools each session and the web UI moves in the same pull request, and an old name is refused, never
  misread.
- **Web UI.** Each slice's validators accept and check `next` and `paging` on the answers it converts;
  the pages keep reading the old fields until S9 moves them to `next`/`paging` (or a slice that edits
  a page anyway moves it earlier).
- **Conformance.** One walk test (`services/app/test/paging-conformance.test.ts`) calls each converted
  tool over `/mcp`, follows only `next.arguments`, and checks it reaches `next: null` with every
  seeded item once, no duplicate and no gap, and `paging` consistent on every page. A registry test
  lists every published tool that takes a continuation argument as either converted (walked) or not
  yet converted with its slice; the not-yet list must be empty at S9.

### 6. Slices

S1 (this ADR's pull request) adds the contract to `packages/observation-shared/src/paging-contract.ts`
and converts the reads no in-flight branch touches; S2–S7 convert the rest after the branches named in
the plan merge; S8 binds offsets; S9 removes the deprecated fields. The plan's §3 names each slice and
what it waits for.

## Consequences

- An agent learns one rule: "if `next` is not null, call again with `next.arguments` merged in; if a
  refusal carries `retryWith`, call again with `retryWith.arguments` merged in". It never has to know
  whether the read is keyset or offset.
- Rows that follow but the grant withholds are said everywhere (`stoppedBy: "budget"`), including the
  candidate reads where they are silent today (S6).
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
- `services/app/test/paging-conformance.test.ts`: the walk over every converted tool on `/mcp`, and the
  registry of converted and not-yet-converted paged tools.
- The existing parity tests (route, `/api/agent/v1/*` and `/mcp` give one answer) cover the new fields
  on every converted page read; each converted read's own test checks `next` and `paging` against its
  old fields on a first, middle and last page.
- `services/app/test/ui-mcp-parity.test.ts`: every description stays within 2,048 characters.
- The web UI's schema tests accept the converted answers with the new fields.
