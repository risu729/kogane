# ADR 0064: One append-only audit record per operation, for the human UI and the AI alike, referencing the existing logs

- Status: proposed (accepted when its pull request merges). Slice S1 of the
  [plan](../plans/2026-10-ai-operation-path.md#8-implementation-slices-in-dependency-order)
  implements the table, the chokepoint for the existing `ui`, `agent-http` and
  `mcp` paths, the daily caps with their overflow aggregate and the operator's
  `GET /api/v2/audit` ([audit log](../audit-log.md)); slice S4 (#564) adds the
  maintenance read and revision to the catalogue, the revision on `mcp` only
  as a recorded refusal. The `alarm` and `lane` writers, the agent read and
  delegated execution (ADR 0063) are not implemented.
- Date: 2026-10-09
- Related: [ADR 0063](0063-delegated-ai-operation-path.md) (the delegated AI
  operation path, whose two-step confirmation and idempotency use this
  record).
- Migration: CORE 0075 (`0075_audit_records.sql`: `audit_records` and
  `audit_overflow_counters`).

## Context

The owner, 2026-10-09:
「これは人間の操作もだけど、監査ログみたいなの記録してこれもAIから読めるようにしてね」
(record something like an audit log — of human operations too — and make it
readable from the AI). The owner asked for append-only records of subject,
delegated principal, operation path (UI, HTTP agent route, MCP, alarm, lane),
operation, target, result, time, correlation id, idempotency key and a safe
change diff; refusals and failures recorded; no credentials, tokens, OTPs or
raw bank bodies; readable by the AI according to its permissions; and the
existing logs reused, not duplicated.

What is recorded today (the plan's section 6.1 has the full table):

- **Decisions and their commits** — `decision_operations`,
  `decision_revisions` (0029), `change_plans`, `approvals`,
  `operation_receipts`, `decision_outbox` (0031, 0038), `economic_commit_log`
  (0070) — carry an actor or principal and an operation id. No path, no
  refusal.
- **Operations requests** — `ops_requests`, `ops_request_stages` (0040),
  `ops_collector_dispatches` (0068) — carry the principal; the dispatch row is
  mutable execution state.
- **Settings** — `collection_schedule_revisions` (0065; written, never read),
  `provider_maintenance_rules` (0065; `actor_kind`, `change_reason`,
  `decision_ref` on #564's 0067, renumbered 0078 in slice S4),
  `maintenance_survey_decisions` (0069) — carry
  an actor. `collection_schedules`, `collection_schedule_occurrences` and
  `collection_execution_leases` are mutable; releasing a lease leaves no trace
  at all.
- **Lanes** — `processor_lane_ticks` (0049): counts and closed codes, pruned to
  the latest day.
- **Other actor logs** — `publication_events`, `release_activation_events`,
  `report_events`, `account_connection_reviews`, `ingestion_attempts`,
  `raw_object_verification_events`.
- **The Worker request log** — route, status, request id, error code; durable
  only as long as Workers Logs keeps it.

None of them records the path, a delegated principal, a refusal after
authentication, a correlation id across the App and the Processor, AI reads,
or the link between a prepared and a confirmed operation. None is readable by
an agent.

The standing rules: stored operational records carry counts and closed codes
only, never provider text or amounts; evidence and decisions are append-only;
a scoped reader must not learn anything outside its scope (SC18; #565's P1
finding is a `LIMIT 501` window applied before the scope filter).

## Options considered

1. **No new table: a union view over the existing logs.** Rejected: it cannot
   show refusals, a path, a delegation or a correlation id, which no source
   table has; leases and occurrences are mutable, so the view would rewrite
   history.
2. **A full event log that copies each operation's content.** Rejected: it
   duplicates decisions, plans, rule contents and economic claims, creates a
   second truth that can disagree with the first, and multiplies the places
   where provider text or amounts could leak.
3. **Workers Logs or Analytics Engine.** Rejected: not in CORE, retention is
   the platform's, it cannot be read inside a grant's scope, and it cannot be
   written atomically with the effect it describes.
4. **A thin append-only envelope per operation, in CORE, that references the
   existing logs by id and revision, written at one chokepoint in the same D1
   batch as the effect.** Chosen.

## Decision

**Table.** `audit_records`, `STRICT`, `core-keep`, append-only
(`audit_records_no_update`, `_no_delete`, `_no_replace`), listed in
`REVISION_EXCLUDED_TABLES` so an audit write never moves the CORE source
revision. Columns: `audit_id` (`aud_` + UUID), `recorded_at` (canonical UTC
milliseconds), `path` (`ui` / `agent-http` / `mcp` / `alarm` / `lane`),
`subject` (the verified Access subject; NULL exactly for `alarm` and `lane`),
`principal`, `principal_kind` (`human` / `agent` / `delegated` /
`automatic`, the change lifecycle's `human` for the operator),
`delegation_ref` (set exactly for `delegated`), `operation` (pattern-checked;
the closed list is `OPERATION_CATALOGUE` in code),
`risk_class` (`R0`–`R4`), `step` (`call` / `prepare` / `confirm`),
`scope_namespace` + `scope_source`, `target_ref`, `result` (`applied` /
`accepted` / `prepared` / `read` / `replayed` / `refused` / `failed` /
`overflow`), `result_code` (required for `refused` and `failed`), `reason_code`,
`correlation_id`, `idempotency_key`, `payload_digest`, `confirmation_digest` +
`confirm_expires_at` (set exactly on `prepared`), `confirms_audit_id` (set
exactly on `confirm`), `reverts_audit_id`, `refs_json` (≤ 16 closed refs into
the existing logs) and `diff_json` (≤ 2,048 bytes, one closed schema per kind:
`revision`, `decision`, `request`, `read`, `lane`, `release`, `overflow`,
`none`; the `lane` kind holds only the sizes of the ranges its refs name).
Every column is an enum, a bounded pattern, a digest, a count or a canonical time;
there is no free-text column. Indexes: by principal, by scope, by operation
(each with `recorded_at`), by target and by correlation id; unique partial
indexes on `confirms_audit_id` and on `(principal, operation,
idempotency_key)`, each over `applied`/`accepted` records only.

**Reuse, not duplication.** The record names what changed by reference —
decision revision ids, `commit-seq:<epoch>:<n>`, `<rule>@<revision>`, the
`op_` operation id, the plan id — and holds counts and closed codes. It never
copies decision content, plan payloads or simulations, stage progress, rule
patterns, economic members or claims, lane tick counts or page contents.

**One chokepoint.** `packages/application/src/audit/` builds every record;
`executeOperation` (ADR 0063, `packages/application/src/operation-path/`) is
the single entry every adapter calls — the UI's operator routes, the HTTP
agent routes and the MCP dispatcher. The writer appends the `applied` or
`accepted` record as the **last statement of its own D1 batch**, as a plain
`INSERT … SELECT … WHERE` joined to its own guard or to the row its effect
wrote (never `OR IGNORE`, never unconditional), so the record exists exactly
when the effect does: a guard that raises rolls back both, a guard that
matches no row leaves neither (the adapter then records the refusal), and a
unique-index violation on the record rolls the effect back. Writers that are
not one batch today (the maintenance writers, the survey acceptance, lease
release) become one in the implementation slice (plan, section 6.3). Writers
in the Processor receive the envelope (correlation id, path, delegation ref)
over the private `PIPELINE` binding in closed headers validated by the same
schema and call the same builder. **One refusal writer:** for `ui`,
`agent-http` and `mcp`, the App adapter writes every `refused` and `failed`
record, once, after the Processor answers, carrying the Processor's closed
code; the Worker that runs the writer writes the `applied`, `accepted` and
`prepared` records in its own batch (the Processor for commands and schedule
writes, the App for operations requests and proposals), and the Processor the
`failed` records of `alarm` and `lane`. An applied operation whose answer was
lost leaves the Processor's `applied` record and the App's `failed`
(`upstream_unavailable`) record under one correlation id; the `applied` record
is authoritative.

**Writers by path.** `ui`: the operator routes under the browser Access
application (command, operations, schedule settings); a browser-session script
is indistinguishable from a click and is recorded as `ui`; UI page loads (GET)
are not recorded. `agent-http` and `mcp`: every tool call, reads included
(`result = "read"`, a row count). `alarm`: one record per occurrence of a
`collection`-kind job the `ScheduleAlarm` claims; the outcome stays in the
occurrence row, and the `processor` tick and `keepalive` jobs write none.
`lane`: one record per tick of a lane that wrote decisions, proposals or
settings, carrying refs only — the decision-revision range, the
commit-sequence range when it committed economic events, and the proposals it
wrote, by proposal kind — and none of `processor_lane_ticks`' cost or progress
counts; idle ticks write none.

**Refusals and failures.** Every refusal after authentication is recorded with
its existing closed code (authorization, delegation, validation, confirmation,
stale, idempotency, writer codes), and a failed writer batch as `failed`. A
refused value is never echoed: `refs_json` holds the field path, not the value.
A 401 has no subject and is not recorded. Writing a refusal record never
changes the answer.

**Daily caps.** Per principal and UTC day: 200 `prepared`, 2,000 `read` and
500 `refused` records (code constants). `applied` and `accepted` records are
never capped. Past the `prepared` cap a prepare is refused
(`audit_cap_reached`). Past the `read` and `refused` caps the read is served
and the refusal answered, but each event only increments a row of
`audit_overflow_counters` (`operational-mutable`, same migration); the first
Processor tick after the day ends appends one aggregated `overflow` record
per counter row (`diff_json` `{of, count, cap}`) and deletes the row in the
same batch, so each principal has at most one overflow record per capped
result per day, with the exact count.

**Never recorded.** Credentials, Access assertions, OAuth tokens, cookies,
service-token ids, OTPs, MFA or passkey material, sessions, raw bank or
provider bodies, provider text, amounts, account numbers or labels, free-text
reasons, request or response bodies, URLs, SQL and exception text.

**Reading.** The operator reads the whole log at `GET /api/v2/audit` (and a
page). An agent reads it with `audit.read` in `AGENT_API_GRANTS`, through
`kogane.audit.search` / `kogane.audit.get` on `/mcp` and the matching
`/api/agent/v1` routes: a record is visible when its scope source is in the
grant (`scopes.sources`, or `scopes.scheduleSources` for schedule sources); a
record with no scope only to a `"*"` grant; a grant listed on the account axis
is refused before any read; `subject`, and the subject inside `principal`, is
shown only when it is the caller's own delegator, otherwise as `subj_` + 16 hex
of its SHA-256; a record whose target or read spans more than one source has no
scope and is visible only to a `"*"` grant; a refusal's scope is only a
server-resolved source; the scope is in the SQL `WHERE` before any `LIMIT`; no
unfiltered total is returned; the cursor binds the perimeter and the filters.

**Retention.** Kept, append-only, without pruning. A later pruning rule needs
its own ADR, as an exception to an append-only table. Estimated volume: about
12 `alarm` records a day (collection occurrences only; recording the
5-minute Processor tick and the 15-minute keepalive as well would add about
400 a day), lane records only for writing ticks, a handful of `ui` records,
and per agent principal at most the write budget plus the caps above.

**Two uses beyond the record.** ADR 0063's two-step confirmation stores its
prepare as a `prepared` record and makes a confirm single-use through the
unique index on `confirms_audit_id`; writers without idempotency of their own
get it from the unique index on `(principal, operation, idempotency_key)`.

## Consequences

- Every operator write gains one row and every agent or MCP tool call one row,
  below the daily caps (past them, one aggregated row per day); the effect
  batches gain one statement.
- Lease release gets its first durable trace (who released which source, and
  when); its own table stays mutable.
- The Processor's command and schedule routes must accept and validate the
  envelope headers; a request without them from the App is refused as today's
  missing actor header is.
- Volume is bounded by the operations themselves, ADR 0063's per-principal
  budget and the MCP call rate; the owner measures it with a read-only count
  after the first delegated stage.
- Because records are kept unpruned, the audit table is part of the CORE
  protection runbook (`infra/protection.md`) once it exists.
- The alarm and lane writers are a later slice; until they ship the log records
  subject-originated operations only, and says so.

## Verification

This ADR is a design record; its pull request changes documentation only.
The implementation slice (plan S1) is verified on synthetic data by: the
migration guards (no update, delete or replace; the CHECK constraints refuse
free text and mismatched optional columns; both unique partial indexes); the regenerated
schema ledger with the table classified `core-keep`; the migration pin in
`services/processor/test/lanes.test.ts`; per route, a success record in the
same batch as the effect (a failing guard leaves neither), refusal and replay
records, and no echo of a refused value; a deep scan of every stored record
after seeding provider text with a token-shaped string and an amount; and, for
the agent read, the plan's leakage tests (section 7). Not verified: anything in
production.

## Amendment: implementation details fixed by slice S1 (2026-10-09)

The implementation slice settled four details this decision left open or
stated too tightly; none changes what is recorded or who may read it.

- **A time index.** Besides the indexes listed above, `audit_records_by_time`
  on `(recorded_at, audit_id)` serves the operator's whole-store page newest
  first without scanning and sorting the table on every page.
- **The overflow counter's key and columns.** `audit_overflow_counters` is
  keyed by `(day, principal, path, result)` and also keeps the principal kind,
  so the aggregate record carries exactly the counted path and kind. One
  principal on one path — the case the decision describes — gets at most one
  overflow record per capped result per day; a principal on several paths gets
  one per path.
- **A confirm cites its prepare when it applies.** `confirms_audit_id` is
  required on an `applied` or `accepted` confirm and allowed only on a
  confirm, instead of being set exactly on every confirm: a confirm refused
  because no matching prepare exists (`confirmation_invalid`) has nothing to
  cite and is still recorded with `step = 'confirm'`. The unique index still
  allows one applied confirm per prepare.
- **One effect record per effect.** The effect statement also refuses a second
  `applied`/`accepted` record for the same effect (same target and operation,
  and the same revision, approval or operation id), so a batch that lost a race
  but still sees the winner's row adds no record of its own; the unique
  indexes remain the backstop.

The plan's S1 verification is in [the audit log](../audit-log.md#cost) and its
test files.
