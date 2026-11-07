# ADR 0086: The operator lists its own operations requests, newest first, through the indexes of migration 0040

- Status: proposed (accepted when the PR that carries it merges)
- Date: 2026-11-07
- Builds on: [ADR 0048](0048-operation-collector-dispatch.md) (an operation's
  collector execution trail), [ADR 0064](0064-common-audit-log.md) (one audit
  record per operations request), [ADR 0081](0081-ui-parity-through-mcp.md)
  (screen and MCP share one service)

## Context

Phase 3 of the [roadmap](../roadmap.md#phase-3--coverage-collection-requests-and-cross-source-identity)
is done when collection can be requested and followed to published
observations. Before this ADR, the App served one request's record at
`GET /api/ops/v1/operations/{id}` ([operations API](../ops-api.md)), but
nothing listed the requests an operator holds. A request's id was in the 202
answer that accepted it, and later only in the audit log
([audit log](../audit-log.md)): an operator who lost the answer had to search
the log to follow the request.

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

1. **Route.** `GET /api/ops/v1/operations` serves one page of the caller's own
   requests. It sits behind `OPS_API_ENABLED` and the same operator grading as
   the other operations routes (`opsContext`): an agent gets
   `403 approval_required`, and a subject in neither grant list gets
   `403 subject_not_granted`. It is read-only and has no MCP tool. A tool needs
   the owner's approval of a catalogue change (below).
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
   default 20). Each key appears at most once. An unknown key is
   `400 invalid_query` with no ref, because the key name is the caller's text.
   A repeated key or a value outside its list is `400 invalid_query` with the
   key as its only ref. The value is never echoed. No new error code is added.
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
6. **Audit.** Each list request is recorded once as a new catalogue operation
   `ops.operation.list` (R0, path `ui` only), with result `read`, the number of
   rows shown and whether a next page exists. The record names no operation of
   the page. The web audit page shows the operation as 依頼の一覧.

## Consequences

- An operator can find a request again without the audit log, and then follow
  it with the single-operation read.
- No migration and no new index.
- A page reads at most `page+1` rows per arm, plus the rows that share the
  boundary `created_at` (the index has no `operation_id`, so SQLite sorts the
  last order term within one timestamp). An arm also reads rows of other
  principals with the same status and kind and skips them. The committed
  deployment names one operator, and an agent cannot create an operation.
- The query and paging live in `packages/application`
  (`listOperations`), not in the route, so that a later MCP read can call the
  same service with the store it is given, without SQL of its own (ADR 0081,
  decision 2). The route only parses the query string and maps the result.
- The route has no web page, so ADR 0081's parity rule for screen operations
  does not strictly apply. Its catalogue entry `ops.operation.list` is still
  a `ui` entry without an `mcp` path or tool, which ADR 0081, decision 4, asks
  for. That gap closes when the owner approves an MCP tool
  `kogane.ops.operation.list` over `listOperations`, with the authority the
  MCP path has then for `kogane.ops.operation.get` (today the `operations.read`
  delegation capability). ADR 0081's guard test does not exist yet, so nothing
  fails today.
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
- `services/app/test/ops-api.test.ts` (workerd, real migrations):
  - The route answers newest first, scoped to the caller, without the
    rebuild reason.
  - Cursor paging and filters work.
  - Every refusal gets its code and ref without the refused value.
  - The agent, stranger, flag-off and `POST` answers.
  - One audit record of `rows` and `truncated` per list request.
  - The same plan assertions on D1, a kind filter's six arms included.
