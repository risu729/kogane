# ADR 0086: Operations requests are read and listed whole-store, newest first, through the indexes of migration 0040, on the route and over MCP

- Status: accepted (merged 2026-11-08 in [#1074](https://github.com/risu729/kogane/pull/1074))
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
   `status` is the stored status, and the `status` filter matches it: READ is
   not read, so a request the single read reports `completed` through its
   derived `projected` stage
   ([ADR 0048, amended 2026-11-07](0048-operation-collector-dispatch.md#amendment-2026-11-07-the-projected-stage-is-derived-from-the-read-pointer))
   is listed, and filtered, as `running`. (Revised by the
   [second 2026-11-18 amendment](#amendment-2026-11-18-a-listed-requests-status-is-the-one-its-record-reads):
   `status` is the record's, `storedStatus` the stored one, and the filter
   matches `storedStatus`.)
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
  last order term within one timestamp, and after a cursor skips the tied
  rows at or ahead of it). No arm reads a row of another (status, kind) pair
  or filters on a column the index does not hold; the rows a page reads but
  does not return are the other arms' candidates and those ties. A page costs
  at most (arms × (page + 1)) rows plus ties, at any store size: thirty arms
  at most, 1,530 rows for a page of 50. Option 3's index is
  the fix if the unfiltered page's thirty ranges show as a cost.
- The query and paging live in `packages/application` (`listOperations`), not
  in the route or the tool: both adapters pass the store they are given and
  issue no SQL of their own (ADR 0081, decision 2). The route parses the query
  string, the tool its arguments, and both map the result.
- The catalogue entry is on `ui` and `mcp` and its tool is published to every
  MCP client, so the catalogue guard of
  `services/app/test/ui-mcp-parity.test.ts` passes with no new known gap. No
  web page named the route when this ADR merged; the 依頼の一覧 page does
  since the [2026-11-18 amendment](#amendment-2026-11-18-the-依頼の一覧-page-reads-the-list),
  and the read-route guard maps it to this tool.
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

## Amendment 2026-11-18: the 依頼の一覧 page reads the list

- Status: proposed (accepted when its pull request merges)
- Date: 2026-11-18

### Context

Decision 7 gave `ops.operation.list` the paths `ui` and `mcp`, and the
consequences above said that no web page named the route yet. The operator
could follow one request on its 依頼の経過 page (`/operations/op_<id>`), but
reached that page only from the audit log's `op_` targets or from the
schedules page right after sending a collection request. A request whose id
was lost had to be found again in the audit log, which also holds reads,
refusals and lane records (option 5 above). The list route and the MCP tool
already answered "which requests exist" over one service, `listOperations`.

### Options considered

1. **A read-only page at `/operations` over the list route, with the route's
   closed filters in the URL and the cursor kept per paging session
   (chosen).** The audit log page pages the same way.
2. **Leave the audit log as the only index of requests.** This keeps the
   catalogue's `ui` path without a screen that uses it.
3. **Put the cursor in the URL too.** A cursor names a row of one paging
   session. A reload after new requests would then show the rows after an old
   position under a URL that reads like a first page.

### Decision

1. **Page.** `依頼の一覧` at `/operations`, in the navigation of every caller
   like `監査ログ` (the server's operator check is the only gate), drawn
   outside the observation metadata guard as the audit log and 依頼の経過
   are. It reads `GET /api/ops/v1/operations` only, through
   `useOperationList` in `apps/web/src/operations-api.ts`, and writes nothing.
2. **Query.** The page sends `kind` and `status` from its URL
   (`?kind=…&status=…`, each at most once and only a closed value; anything
   else is refused on the page without a request) and the cursor of the page
   it pages to. It sends no `limit`, so a page is the route's default of 20
   rows. A new filter or 最新の依頼から読み直す starts from the newest
   request again.
3. **Shown.** Per row: accepted time, kind, stored status, failure code, source,
   dispatch state and attempts, last update and the operation id, each closed
   code by its Japanese name beside the code, and the id as the link to its
   依頼の経過 page. The 依頼の経過 page's breadcrumb leads back to the list
   instead of the audit log. Neither the principal nor the request payload is
   shown, because the summary carries neither (decision 5). The page says
   that the status, and the status filter, are the stored ones (READ is not
   consulted, decision 5), so a collection its 依頼の経過 page shows as 完了
   can be listed 進行中, and that each read is recorded once in the audit log
   (decision 7). (Revised by the
   [amendment below](#amendment-2026-11-18-a-listed-requests-status-is-the-one-its-record-reads):
   the status is the one 依頼の経過 shows, and the note names the filter's
   stored basis.)
4. **Checks in the browser.** `validOperationListPage`
   (`packages/observation-shared/src/operation-contract.ts`) accepts a page
   only with the exact summary keys and closed values of decision 5, at most
   50 rows, in the list's order (accepted time, then id, both descending, each
   row once), and a cursor that is the last row's id or null. The page also
   refuses a page with a row of another kind or status than it asked for.
   A refused page is shown as an error, never as a partial list.
5. **Refusals.** `401` and `403` say the list is the operator's; a `404`
   without a code the page knows says this deployment does not provide it
   (`OPS_API_ENABLED` off); `404 receipt_not_found` on a cursor offers to
   start from the newest request again.

### Consequences

- The read-route guard of `services/app/test/ui-mcp-parity.test.ts` maps
  `/api/ops/v1/operations` to `kogane.ops.operation.list`. The catalogue, the
  MCP tool list, the route and `listOperations` are unchanged, so this adds no
  operation or capability and no migration.
- Every opening and every page turn is one audited `ops.operation.list` read,
  as for an MCP client's call; the page does not poll.
- A request a reader saw as `running` on the list can be `completed` on its
  依頼の経過 page, where the `projected` stage is derived from READ. The list
  says so rather than deriving it per row. (Removed by the
  [amendment below](#amendment-2026-11-18-a-listed-requests-status-is-the-one-its-record-reads),
  which derives it per page.)
- Paging keeps decision 3's limits: a request accepted while a reader pages
  appears at the head of the list and is not met on a later page.

### Verification

- `packages/observation-shared/test/operation-list-contract.test.ts`: the
  order with tied accepted times, a repeated row, the cursor rule, the
  50-row bound, unknown keys, open vocabulary and the record's own fields,
  and the filter agreement.
- `packages/application/test/operations-list.test.ts`: every page of every
  filter shape on the three random stores is one the contract accepts for its
  filters. `packages/application/test/operation-record-contract.test.ts` pins
  the 50-row bound to `OPERATION_LIST_MAX_LIMIT`.
- `services/app/test/ops-api.test.ts` (workerd, real migrations): the route's
  first, second and filtered pages are accepted by the same contract.
- `apps/web/test/operations.browser.test.ts`, against pages `listOperations`
  reads from a synthetic store with every migration, on a desktop and a phone
  viewport: the navigation entry, the labels, no total, no principal and no
  payload text, the link to each request, cursor paging and its tie order,
  filters sent as closed query parameters that reset paging, a deep-linked
  filter, a refused URL that sends nothing, one read per page and a re-read
  only when asked, the non-operator and not-provided answers, a malformed
  page and a page that answers other filters, and the accessibility audit.
- `apps/web/test/operation.browser.test.ts`: the 依頼の経過 breadcrumb leads
  to `/operations`.

## Amendment 2026-11-18: a listed request's status is the one its record reads

- Status: proposed (accepted when its pull request merges)
- Date: 2026-11-18
- Revises: decision 5 (`status` is the stored status), and the amendment
  above (decision 3's note, and its consequence that a request the list
  shows `running` can read `completed` on its 依頼の経過 page)
- Owner approval: required before merge. The published answer of the MCP
  tool `kogane.ops.operation.list` changes incompatibly (v2) and its
  description changes; published MCP answer and description changes have
  been owner-gated before
  ([ADR 0081's `nextPage`](0081-ui-parity-through-mcp.md),
  [ADR 0088's `view`](0088-collection-quality-per-account.md)).

### Context

The single read (`readOperation`, behind `GET /api/ops/v1/operations/{id}`
and `kogane.ops.operation.get`) derives the `projected` stage of an adopted
request from READ when it is read. It reads the request `completed` when the
stored status is `running` and that makes every stage of its kind complete
([ADR 0048, amended 2026-11-07](0048-operation-collector-dispatch.md#amendment-2026-11-07-the-projected-stage-is-derived-from-the-read-pointer)).
Nothing stores that completion: a published collection stays `running` in
`ops_requests` for good. Decision 5 listed the stored status, so the list and
the 依頼の一覧 page said 進行中 (`running`) for a request whose 依頼の経過 page
said 完了 (`completed`). The amendment above stated that as an open limit.

How the record derives it (`withProjection` in
`packages/application/src/operations/requests.ts`):

- per request: the stored status, the kind's stages from
  `ops_request_stages` (an unreported stage is `pending`), and the
  `projected` row's stored requirement `core-revision:<epoch>:<revision>`;
- once for the whole store: READ's `read_instance` and
  `balance_snapshot_pointer`, and CORE's `core_source_revision` epoch. These
  three singleton reads do not depend on the request.

Only a stored `running` request of a kind that reaches both `adopted` and
`projected` (collection, import, replay) can read otherwise than stored, and
only as `completed`.

### Options considered

1. **Derive each page row's status after the page is read, with one batched
   read of the page's stages and one reading of READ per page. Keep the
   `status` filter on the stored status, and say so in the answer (chosen).**
   The list query, its order and its cursor are unchanged. A page adds at most
   four reads, whatever its size: the stages of its derivable rows by primary
   key, READ's instance and pointer, and CORE's epoch.
2. **Push the derivation into the list query.** READ is another database and
   cannot be joined, but its pointer could be read first and bound. Each
   (`running`, kind) arm would then filter on correlated reads of
   `ops_request_stages`, which `ops_requests_open` does not hold. A
   published collection is never stored `completed`, so almost every stored
   `running` collection reads `completed`. A `status=running` page would
   therefore read and drop an unbounded number of rows to find the few still
   running. Decision 6's bound (arms × (page + 1) rows plus ties) would no
   longer hold, and the shipped SQL would change.
3. **Option 1, but filter on the derived status after the page is read.**
   A page would come back short or empty while rows remain. The cursor would
   then have to name the last row read rather than the last row shown, which
   changes the cursor contract (decision 3), and a `status=running` filter
   could take many empty pages to reach its rows.
4. **Store the derived completion** (write `projected` completed, or the
   status, when READ is seen to cover it). ADR 0048's amendment rejected this
   (its option 5): the derivation falls back to `running` when READ is lost
   or CORE is restored under a new epoch, and a read must not write.
5. **Keep the stored status and the open limit.** The list and the record
   would keep disagreeing about the same request.

### Decision

1. **Status.** Each summary's `status` is the status `readOperation` answers
   for the same request at that moment. `listOperations` passes the page's
   rows to `recordStatuses`. That function applies the record's own
   derivation (`projectionToDerive`, `withVerdict` and `coverageAt`, the
   functions `withProjection` uses) to the page's stored `running`
   collections, imports and replays. `projectionCoverage` is split into
   `projectionWatermark` (the three singleton reads) and `coverageAt` (the
   comparison, no read), so a page reads READ once and the single read is
   unchanged. No existing SQL text changes.
2. **Stored status and the filter.** Each summary also carries
   `storedStatus`, which is `ops_requests.status`. The `status` filter, the
   (status, kind) arms and the cursor read the stored status as before, and
   every page says so with `statusFilterMatches: "storedStatus"`. A
   `status=running` page can therefore hold rows whose `status` is
   `completed`, and a `status=completed` page does not hold them. No row is
   silently outside its filter, because the field the filter matched is on
   the row.
3. **Answer shape.** The page's `schemaVersion` becomes
   `kogane-operation-list-v2`, because `status` changed meaning. The page
   gains `statusFilterMatches`, and each summary gains `storedStatus`. The
   MCP tool `kogane.ops.operation.list` returns the same page (it declares no
   output schema), and its description now says what `status`,
   `storedStatus` and the filter mean. Its input schema, the route's query,
   the catalogue entry and the capability are unchanged.
4. **Contract.** `validOperationListPage` accepts only a v2 page with the
   exact keys and `statusFilterMatches: "storedStatus"`. Each `status` must
   equal `storedStatus`, or be `completed` for a stored `running`
   collection, import or replay (`OPERATION_PROJECTED_KINDS`). With filters,
   each row's kind and `storedStatus` must match them.
5. **Cost.** `recordStatuses` takes at most one page
   (`RECORD_STATUSES_MAX_ROWS`, equal to `OPERATION_LIST_MAX_LIMIT`). With no
   derivable row it reads nothing. Otherwise it reads the derivable rows'
   stages once (`SELECT_STAGES_OF_PAGE`: `operation_id IN (SELECT value FROM
   json_each(?1))`, a primary-key search per id). Only when one of them has a
   stored requirement does it read READ's two singletons and CORE's epoch,
   once.
6. **Page.** 依頼の一覧 shows `status`. Where `storedStatus` differs, the row
   also shows it as 保存された状態. The status filter is labelled
   保存された状態. The note above the list says that the status is the one
   依頼の経過 shows and that the filter reads the stored status, so a 進行中
   filter can list 完了 rows while a 完了 filter does not list them.

### Consequences

- The list, the 依頼の一覧 page, the single read and the 依頼の経過 page give a
  request the same status at the same moment. The open limit of the
  amendment above is removed.
- A page compares all its rows with one reading of READ and CORE, taken
  after its rows and stages are read, as the single read takes its own after
  its row and stages. A single read made later takes a later reading: if READ
  publishes, is lost or CORE changes epoch between the two, they can differ,
  exactly as two single reads made at those two moments would. Within one
  page, every row is judged against the same reading.
- The status filter still reads the stored status. This is a stated basis
  that the answer shows: every page names it, and every row carries the
  value it matched.
- A page of 50 makes at most four more reads than before, none of them a
  scan. The list query's cost (decision 6 and its consequences) is
  unchanged.
- A reader that pinned `kogane-operation-list-v1` gets a version it does not
  know, rather than a `status` whose meaning changed silently.
- The answer changes shape, but the tool set, inputs, capabilities and
  catalogue do not. No operation or capability is added, which AGENTS.md
  names as needing the owner; the changed published answer and description
  of `kogane.ops.operation.list` still need the owner's approval before
  merge, as ADR 0081's and ADR 0088's changes to published tools did.

### Verification

- `packages/application/test/operations-list-projection.test.ts` (real CORE
  and READ migrations on `bun:sqlite`):
  - Differential against the single read. The setup is two random 120-row
    stores, with stages of seven shapes on requests of every status: none,
    adoption pending, a `projected` row without a requirement, no `projected`
    row, a requirement at revision 1–6, a requirement of another epoch, and
    `projected` stored complete. READ is in one of seven states: no binding,
    nothing published, another contract, unreadable, another epoch, a
    pointer at revision 3, or a pointer covering every requirement. Seven
    filter shapes are paged at limits 1, 7 and 50. Every row of every page
    has the `status` that `readOperation` answers for its id, and its stored
    `storedStatus`. Each shape pages to exactly the stored rows of that
    shape. Only the covering READ states move a status.
  - A `status=running` page lists a covered collection `completed` beside one
    still behind, in the exact v2 shape; a `status=completed` page lists
    neither.
  - Cost: a page of 1 or 50 derivable rows makes three CORE reads (the list,
    the stages, the epoch) and two READ reads. A page with no derivable row
    makes only the cursor and list reads. More than one page of rows is
    refused.
  - Without `sqlite_stat1`, `SELECT_STAGES_OF_PAGE` is one
    `SEARCH ops_request_stages USING INDEX sqlite_autoindex_ops_request_stages_1 (operation_id=?)`.
  - The suite fails when the list is built from the stored status.
- `packages/application/test/operations-list.test.ts`: the paging, plan and
  shape tests of decision 6 pass on the unchanged list SQL, with the v2
  shape.
- `packages/application/test/operation-record-contract.test.ts` pins
  `OPERATION_PROJECTED_KINDS`, `RECORD_STATUSES_MAX_ROWS` and
  `STATUS_FILTER_MATCHES` to the application's values.
- `packages/application/test/projection-trace.test.ts`: the single read's
  derivation is unchanged after the split.
- `packages/observation-shared/test/operation-list-contract.test.ts`: a v1
  page is refused; `statusFilterMatches` is required and closed;
  `storedStatus` is required; a `status` differs only as derived; the filter
  is checked against `storedStatus`.
- `services/app/test/ops-api.test.ts` (workerd, real migrations): as a
  published collection's READ moves from nothing to behind to covering, the
  list route and `kogane.ops.operation.list` answer the same page filtered
  `status=running`, with each request's `status` equal to its record's and
  `storedStatus: "running"`. It also checks the summary keys, and that on D1
  without statistics the stage read is a primary-key search.
- `apps/web/test/operations.browser.test.ts`: under a 進行中 filter, a stored
  `running` collection whose requirement READ covers shows 完了 with
  保存された状態 進行中; under 完了 it is absent. The note and the filter's
  label are checked too.
