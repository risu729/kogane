# ADR 0086: Operations requests are read and listed whole-store, newest first, through the indexes of migration 0040, on the route and over MCP

- Status: proposed (accepted when the PR that carries it merges)
- Date: 2026-11-07
- Builds on: [ADR 0048](0048-operation-collector-dispatch.md) (an operation's
  collector execution trail), [ADR 0064](0064-common-audit-log.md) (one audit
  record per operations request), [ADR 0081](0081-ui-parity-through-mcp.md)
  (screen and MCP share one service),
  [ADR 0084](0084-mcp-operator-authority-without-delegation.md) (every MCP
  client applies operations as itself and reads the whole store)
- Revised 2026-11-07 before merge, after #1027, #1030 and #1034 landed on
  main: the MCP tool `kogane.ops.operation.list` is part of this decision, and
  the catalogue entry lists `mcp`. The first draft had no MCP tool and named
  the gap.
- Revised 2026-11-08 before merge, by the owner's decision of 2026-11-08
  04:21 UTC: operations-request reads are whole-store, like every other read
  since ADR 0084. Any caller the transport authenticated (the operator in the
  browser, or any MCP client) reads and lists every operations request, not
  only its own. Writes are unchanged. The draft before this revision scoped
  the list and the single-operation read to the caller's principal, so the
  audit page's link to a request an MCP client made led to a 404 in the
  browser.

## Context

Phase 3 of the [roadmap](../roadmap.md#phase-3--coverage-collection-requests-and-cross-source-identity)
is done when collection can be requested and followed to published
observations. Before this ADR, the App served one request's record at
`GET /api/ops/v1/operations/{id}` ([operations API](../ops-api.md)), but
nothing listed the requests. A request's id was in the 202 answer that
accepted it, and later only in the audit log ([audit log](../audit-log.md)):
an operator who lost the answer had to search the log to follow the request.

Since [ADR 0084](0084-mcp-operator-authority-without-delegation.md) every MCP
client applies operations as `mcp-client:<sub>` and reads the whole store.
Before this ADR, `kogane.ops.operation.get` and the read route were the one
exception: `readOperation` and `ownOperationSource` read only the caller's
own row, so the operator in the browser could not follow a request an MCP
client made, and an MCP client could not follow the operator's. Since #1030,
`services/app/test/ui-mcp-parity.test.ts` fails when a catalogue entry on `ui`
has no `mcp` path and published tool.

What the store already has (`packages/storage-d1/migrations/core/0040_operations_api.sql`):

- `ops_requests`, one row per accepted request; `created_at` and
  `operation_id` never change (trigger `ops_requests_progress_only`);
- the index `ops_requests_principal (principal, created_at)`;
- the index `ops_requests_open (status, kind, created_at)`;
- no index on `created_at` alone.

D1 refuses a compound `SELECT` with more than five terms ("too many terms in
compound SELECT"; seen in the `services/app` workerd tests).

## Options considered

1. **One range of `ops_requests_open` per (status, kind) pair the filters
   allow, merged newest first (chosen).** Five kinds and six statuses are
   thirty pairs: thirty arms with no filter, six for a kind, five for a
   status, one for both. Each arm is limited to the page. No migration.
2. **A scan of `ops_requests` sorted by `created_at`.** With no index on
   `created_at`, every page reads and sorts the whole table.
3. **A new index on `(created_at, operation_id)`.** One range for the
   unfiltered page, but a filter still needs option 1's arms or reads rows
   only to drop them. A new index needs a migration, and a migration needs
   the owner's approval. Option 1 needs neither.
4. **Each principal lists and reads only its own requests.** This was the
   draft before the 2026-11-08 revision. The owner decided against it: every
   other read is whole-store since ADR 0084, and the audit page links every
   `op_` target for every caller to read.
5. **No list; the audit log is the index of operations.** This is the
   situation before this ADR. The audit log records reads and refusals too,
   so it is not a list of requests.

## Decision

1. **Route and tools.** `GET /api/ops/v1/operations` serves one page of every
   request in the store, whichever principal accepted it. It sits behind
   `OPS_API_ENABLED` and the same operator grading as the other operations
   routes (`opsContext`): an agent gets `403 approval_required`, and a subject
   in neither grant list gets `403 subject_not_granted`. The MCP tool
   `kogane.ops.operation.list` calls the same service (`listOperations`)
   under the `operations.read` capability every MCP client holds (ADR 0084),
   and is shown the same page. Both are read-only. The catalogue entry
   (point 6) and the tool are catalogue changes, which need the owner's
   approval before merge.
2. **Whole-store reads (owner, 2026-11-08 04:21 UTC).** `readOperation`,
   behind `GET /api/ops/v1/operations/{id}` and `kogane.ops.operation.get`,
   reads the operation whichever principal accepted it, and `listOperations`
   lists every principal's requests. The caller's principal is not a filter
   on either read; only an id that does not exist answers
   `404 receipt_not_found`. `ownOperationSource` is renamed `operationSource`
   and no longer takes a principal: the MCP get tool reads the operation's
   source with it to refuse, as `400 target_missing`, a principal whose
   delegation scope names fewer sources or accounts (since ADR 0084 no MCP
   client has one). Writes are unchanged: a request is accepted, re-sent and
   bound to an `operation_id` under the caller's own principal, so two
   principals using one idempotency key still hold two operations.
3. **Order and paging.** Newest first by `created_at` descending, then
   `operation_id` descending. `operation_id` is unique and neither column
   changes after insert, so this is a stable total order. The cursor is the
   operation id of the last row of the previous page (`nextCursor`), of any
   principal. The service resolves it to its `created_at`. A cursor that
   names no operation gets `404 receipt_not_found` with ref `cursor`.
4. **Closed query.** The keys are `kind` (the five kinds), `status` (the six
   statuses), `cursor` (`op_` and 64 hex characters) and `limit` (1 to 50,
   default 20). One Zod schema, `operationListSchema` in
   `services/app/src/ops-api.ts`, validates both transports. On the route each
   key appears at most once. An unknown key is `400 invalid_query` with no
   ref, because the key name is the caller's text. A repeated key or a value
   outside its list is `400 invalid_query` with the key as its only ref. The
   tool takes the same keys as arguments, `limit` as an integer, and refuses
   like the other operations tools: `400 invalid_request` with the field
   paths, or `(body)` for an unknown key. The value is never echoed. No new
   error code is added.
5. **Summary only.** Each row carries the operation id, kind, status, source
   id, dispatch state and attempts, failure code and the two timestamps. These
   are identifiers, closed codes, a count and timestamps. The principal is
   not shown; the audit log names who made a request. The stored request
   (`request_json`) is not read, because a rebuild's `reason` is free text.
   Stages and the collector execution stay on the single-operation read.
6. **Plan.** `packages/application/src/operations/list.ts` builds the SQL from
   placeholders only: one arm per allowed (status, kind) pair, each
   `SEARCH ops_requests USING INDEX ops_requests_open (status=? AND kind=?
   [AND created_at<?])` with `LIMIT page+1`, joined by `UNION ALL` and sorted
   newest first. Arms are nested so that no compound has more than five
   terms: the thirty arms of an unfiltered page are two subqueries of three
   subqueries of five.
7. **Audit.** Each list request or tool call is recorded once as a new
   catalogue operation `ops.operation.list` (R0, paths `ui` and `mcp`), with
   result `read`, the number of rows shown and whether a next page exists. The
   record names no operation of the page. The web audit page shows the
   operation as 依頼の一覧.

## Consequences

- An operator can find a request again without the audit log, and then follow
  it with the single-operation read, whichever principal made it. An MCP
  client can follow a request the operator made in the browser, and the
  operator one an MCP client made.
- The audit page's link on an `op_` target leads to a readable request for
  every caller, not only for the principal that made it.
- No migration and no new index.
- A page reads, per arm, at most `page+1` rows plus the rows that share the
  boundary `created_at` (the index has no `operation_id`, so SQLite sorts the
  last order term within one timestamp). No row is read only to be dropped,
  so a page costs at most (arms × (page + 1)) rows plus ties, at any store
  size: thirty arms at most, 1,530 rows for a page of 50. Option 3's index is
  the fix if the unfiltered page's thirty ranges show as a cost.
- The query and paging live in `packages/application` (`listOperations`), not
  in the route or the tool: both adapters pass the store they are given and
  issue no SQL of their own (ADR 0081, decision 2). The route parses the query
  string, the tool its arguments, and both map the result.
- The catalogue entry is on `ui` and `mcp` and its tool is published to every
  MCP client, so the catalogue guard of
  `services/app/test/ui-mcp-parity.test.ts` passes with no new known gap. No
  web page names the route yet, so the read-route guard has nothing to map;
  a page that does maps it to this tool.
- A request's id is shown to every caller the transport authenticated. It
  confirms nothing beyond what the audit log already shows those callers,
  and it grants no write: a re-send under another principal is that
  principal's own request.
- The MCP tool list grows by one tool (seven operations tools).
- The audit catalogue gains one name, and the web audit page's label table
  gains one entry.

## Verification

- `packages/application/test/operations-list.test.ts`:
  - On three random synthetic stores (160 rows each, two principals, many
    `created_at` ties), every filter shape is paged at limits 1, 7 and 50.
    The rows returned are exactly the store's rows of that shape, of both
    principals, in order, each once, as checked against an in-memory
    reference, and either principal is shown the same pages.
  - An empty list is one page; a page that fits exactly has no cursor.
  - The summary's exact shape.
  - A cursor of another principal's operation pages on; an unknown cursor
    gets `receipt_not_found`.
  - Without `sqlite_stat1`, every shape, first page and later page, reads
    `ops_requests` only through `ops_requests_open`, one range per allowed
    pair. There is no table scan.
- `packages/application/test/operations.test.ts`: `readOperation` and
  `operationSource` read an operation whichever principal accepted it.
- `services/app/test/delegated-ops-parity.test.ts` (workerd, real
  migrations, the MCP transport): the tool and the route answer the same page,
  which holds both the operator's browser request and the MCP client's in the
  stored order; `kogane.ops.operation.get` and the read route answer the same
  receipt for each of the two; the operator's operation is a cursor of the
  tool's list; a bad limit, an unknown key and an unknown cursor are refused;
  and the call is recorded once as `read` on `mcp` with its row count.
- `services/app/test/ui-mcp-parity.test.ts`: the catalogue guard passes with
  `ops.operation.list` on `ui` and `mcp`.
- `services/app/test/ops-api.test.ts` (workerd, real migrations):
  - Each of two operators reads the other's request on the read route, and
    the MCP client reads the operator's browser receipt as the route answers
    it.
  - The route answers every principal's requests newest first, two operators
    are shown the same page, and the rebuild reason is never shown.
  - Cursor paging (across the two operators) and filters work.
  - Every refusal gets its code and ref without the refused value.
  - The agent, stranger, flag-off and `POST` answers.
  - One audit record of `rows` and `truncated` per list request.
  - The same plan assertions on D1, the thirty arms of an unfiltered page
    included.
