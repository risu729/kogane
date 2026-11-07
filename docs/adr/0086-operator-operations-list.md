# ADR 0086: A principal lists its own operations requests, newest first, through the indexes of migration 0040, on the route and over MCP

- Status: proposed (accepted when the PR that carries it merges)
- Date: 2026-11-07
- Builds on: [ADR 0048](0048-operation-collector-dispatch.md) (an operation's
  collector execution trail), [ADR 0064](0064-common-audit-log.md) (one audit
  record per operations request), [ADR 0081](0081-ui-parity-through-mcp.md)
  (screen and MCP share one service),
  [ADR 0084](0084-mcp-operator-authority-without-delegation.md) (every MCP
  client applies operations as itself)
- Revised 2026-11-07 before merge, after #1027, #1030 and #1034 landed on
  main: the MCP tool `kogane.ops.operation.list` is part of this decision, and
  the catalogue entry lists `mcp`. The first draft had no MCP tool and named
  the gap.

## Context

Phase 3 of the [roadmap](../roadmap.md#phase-3--coverage-collection-requests-and-cross-source-identity)
is done when collection can be requested and followed to published
observations. Before this ADR, the App served one request's record at
`GET /api/ops/v1/operations/{id}` ([operations API](../ops-api.md)), but
nothing listed the requests an operator holds. A request's id was in the 202
answer that accepted it, and later only in the audit log
([audit log](../audit-log.md)): an operator who lost the answer had to search
the log to follow the request.

Since [ADR 0084](0084-mcp-operator-authority-without-delegation.md) every MCP
client applies operations as `mcp-client:<sub>`, and `kogane.ops.operation.get`
reads one of that principal's own operations through `readOperation`, the
same service as the read route. Since #1030,
`services/app/test/ui-mcp-parity.test.ts` fails when a catalogue entry on `ui`
has no `mcp` path and published tool.

What the store already has (`packages/storage-d1/migrations/core/0040_operations_api.sql`):

- `ops_requests`, one row per accepted request; `created_at` and
  `operation_id` never change (trigger `ops_requests_progress_only`);
- the index `ops_requests_principal (principal, created_at)`;
- the index `ops_requests_open (status, kind, created_at)`;
- no index on `(principal, kind, status, created_at)`.

D1 refuses a compound `SELECT` with more than five terms ("too many terms in
compound SELECT"; seen in the `services/app` workerd tests).

## Options considered

1. **A list over the existing indexes, chosen per filter (chosen).** With no
   filter, read one range of `ops_requests_principal`. With a kind and/or a
   status, read one range of `ops_requests_open` per (status, kind) pair the
   filters allow, each limited to the page, and merge the ranges newest first.
   No migration.
2. **The principal index, with kind and status checked on the rows it
   reads.** This is the audit page's shape. A filter that matches few
   requests then walks the operator's whole history to fill one page.
3. **A new index `(principal, kind, status, created_at)`.** A single range for
   the both-filters case only: a single filter still needs one range per
   value of the other column, as in option 1. A new index needs a migration,
   and a migration needs the owner's approval. Option 1 needs neither.
4. **No list; the audit log is the index of operations.** This is the
   situation before this ADR. The audit log records reads and refusals too,
   so it is not a list of requests.

## Decision

1. **Route and tool.** `GET /api/ops/v1/operations` serves one page of the
   caller's own requests. It sits behind `OPS_API_ENABLED` and the same
   operator grading as the other operations routes (`opsContext`): an agent
   gets `403 approval_required`, and a subject in neither grant list gets
   `403 subject_not_granted`. The MCP tool `kogane.ops.operation.list` calls
   the same service (`listOperations`) for the MCP client's own principal
   `mcp-client:<sub>`, like `kogane.ops.operation.get`, under the
   `operations.read` capability every MCP client holds (ADR 0084). Each
   principal lists only the requests it accepted: the MCP client is not shown
   the operator's browser requests, and the operator is not shown the MCP
   client's. Both are read-only. The catalogue entry (point 6) and the tool
   are catalogue changes, which need the owner's approval before merge.
2. **Order and paging.** Newest first by `created_at` descending, then
   `operation_id` descending. `operation_id` is unique and neither column
   changes after insert, so this is a stable total order. The cursor is the
   operation id of the last row of the previous page (`nextCursor`). The
   service resolves it to its `created_at` with the caller's principal. A
   cursor that names no operation of the caller gets
   `404 receipt_not_found` with ref `cursor`, the same answer as for an id that
   does not exist.
3. **Closed query.** The keys are `kind` (the five kinds), `status` (the six
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
4. **Summary only.** Each row carries the operation id, kind, status, source
   id, dispatch state and attempts, failure code and the two timestamps. These
   are identifiers, closed codes, a count and timestamps. The stored request
   (`request_json`) is not read, because a rebuild's `reason` is free text.
   Stages and the collector execution stay on the single-operation read.
5. **Plan.** `packages/application/src/operations/list.ts` builds the SQL from
   placeholders only:
   - no filter: `SEARCH ops_requests USING INDEX ops_requests_principal
     (principal=? [AND created_at<?])`;
   - a filter: one arm per allowed (status, kind) pair (one for both filters,
     five for a status, six for a kind), each `SEARCH ops_requests USING INDEX
     ops_requests_open (status=? AND kind=? [AND created_at<?])` with
     `LIMIT page+1`, joined by `UNION ALL` and sorted newest first. The
     principal is written `+principal=?1` so that the planner stays on
     `ops_requests_open`, and is checked on the rows each arm reads. Arms are
     nested so that no compound has more than five terms.
6. **Audit.** Each list request or tool call is recorded once as a new
   catalogue operation `ops.operation.list` (R0, paths `ui` and `mcp`), with
   result `read`, the number of rows shown and whether a next page exists. The
   record names no operation of the page. The web audit page shows the
   operation as 依頼の一覧.

## Consequences

- An operator can find a request again without the audit log, and then follow
  it with the single-operation read.
- No migration and no new index.
- A page reads `page+1` rows of the caller per arm, plus the rows that share
  the boundary `created_at` (the index has no `operation_id`, so SQLite sorts
  the last order term within one timestamp). On a filtered page an arm also
  reads every row of another principal with its status and kind until it has
  its page, and an arm in which the caller has fewer rows than the page reads
  to the end of its range. The bound of a filtered page is therefore every
  row of the allowed (status, kind) pairs below the cursor, of all
  principals, not the page size. Today the committed deployment names one
  operator, and since ADR 0084 each MCP client that applies an operation is a
  second principal (`mcp-client:<sub>`), so a filtered page of one grows with
  the other's history of the same status and kind. Option 3's index, or a
  principal-first index per filter, is the fix when that cost shows, and it
  needs a migration.
- The query and paging live in `packages/application` (`listOperations`), not
  in the route or the tool: both adapters pass the store they are given and
  issue no SQL of their own (ADR 0081, decision 2). The route parses the query
  string, the tool its arguments, and both map the result.
- The catalogue entry is on `ui` and `mcp` and its tool is published to every
  MCP client, so the catalogue guard of
  `services/app/test/ui-mcp-parity.test.ts` passes with no new known gap. No
  web page names the route yet, so the read-route guard has nothing to map;
  a page that does maps it to this tool.
- Neither read tool reaches an operation the operator requested in the
  browser: each principal follows its own requests. Reading the operator's
  requests over MCP would widen what an MCP client is shown beyond what it
  applied, and is not part of this decision.
- The MCP tool list grows by one tool (seven operations tools).
- The audit catalogue gains one name, and the web audit page's label table
  gains one entry.

## Verification

- `packages/application/test/operations-list.test.ts`:
  - On three random synthetic stores (160 rows each, two principals, many
    `created_at` ties), every filter shape is paged at limits 1, 7 and 50.
    The rows returned are exactly the caller's rows of that shape, in order,
    each once, as checked against an in-memory reference.
  - An empty list is one page; a page that fits exactly has no cursor.
  - The summary's exact shape.
  - A foreign or unknown cursor gets `receipt_not_found`.
  - Without `sqlite_stat1`, every shape, first page and later page, reads
    `ops_requests` only through the index named above. There is no table
    scan, and the unfiltered page has no sort beyond the last order term.
- `services/app/test/delegated-ops-parity.test.ts` (workerd, real
  migrations, the MCP transport): the tool lists the MCP client's own
  requests in the stored order and none of the operator's, the summary of a
  request equals the route's for the same request, a bad limit, an unknown
  key and the operator's operation as a cursor are refused, and the call is
  recorded once as `read` on `mcp` with its row count.
- `services/app/test/ui-mcp-parity.test.ts`: the catalogue guard passes with
  `ops.operation.list` on `ui` and `mcp`.
- `services/app/test/ops-api.test.ts` (workerd, real migrations):
  - The route answers newest first, scoped to the caller, without the
    rebuild reason.
  - Cursor paging and filters work.
  - Every refusal gets its code and ref without the refused value.
  - The agent, stranger, flag-off and `POST` answers.
  - One audit record of `rows` and `truncated` per list request.
  - The same plan assertions on D1, a kind filter's six arms included.
