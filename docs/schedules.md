# Schedule administration

Open `/schedules` from **取得履歴** or **収集スケジュール**. Only the configured
Access operator can open this page; maintenance windows alone can also be read
by a granted agent ([below](#agent-maintenance-tools)). The page
shows the original next occurrence, maintenance-adjusted due time, actual alarm
reservation and the latest scheduling receipt separately. All displayed timestamps use Japan time;
daily configuration defaults to Japan time and can use Sydney or UTC explicitly.

Save a daily time/weekdays or an interval and enable/disable the job. A version
conflict requires refreshing before another edit. A successful database save with
pending reservation is not an armed alarm. The five-minute processor job repairs
pending reservations; deployment bootstrap can also reconcile them.

Maintenance settings retain revisions. **停止時間を追加** supports a dated window
or weekly/monthly pattern, including a day offset after an nth weekday. Enter a
URL on the source's already registered official site, the actual time you checked
the announcement, and the affected scope. `collection` defers daily collection; `session` also defers session keepalive.
`feature-only` records provenance but
does not postpone collection. Sources marked `not-found` have no known window;
that is not a claim that maintenance never happens. A rule changes only through
an operator's edit or an operator's acceptance of a re-survey proposal
([below](#official-site-re-survey)). The page flags provenance older than
thirty days.

The initial public snapshot is in `config/maintenance-research.json` (2026-10-04).
It includes Mizuho Saturday night, Sony login/debit windows, the GLOBAL PASS debit
member site, Vpass's partial Monday outage, Mobile Suica PC site availability,
SBI's currently published windows and MyJCB payment/point notices. SBI Shinsei's
transfer/ATM-only notices do not block balance/history reads. Money Forward ME is
not assigned Money Forward Cloud's maintenance hours. SBI VC's trading-system
window conservatively defers session maintenance and collection. SMBC Direct and
VPoint Pay remain unsupported for automatic login.

Receipts link to their exact saved **取得記録** once ingestion has registered it.
Missing links mean a record is not yet available; the page never substitutes the
latest unrelated run. `uncertain` means the provider attempt may have occurred and
is not replayed automatically. The actual collection's partial outcome remains
visible in its evidence record.

If a process dies during collection, the source remains locked against another
manual or scheduled attempt. Inspect its execution state and saved history first.
Only after confirming the previous execution stopped, use **停止した実行を解除**.
The release compares the exact lease reference, clears no newer lease, and starts
no collection. Repeating the confirmed request succeeds while that source's lease
is already empty; if another execution acquired a different reference, the retry
conflicts and leaves it intact. A source with no lease row still conflicts.
The button blocks repeated confirmation and submission for the same source until
the release and its state readback finish. The page refreshes after success or
failure, and keeps the result visible after the released lease disappears. Normal
executions release their own leases on completion.

An accepted operations-API collection or session refresh runs through the same
named collector RPC and the same lease
([ADR 0048](adr/0048-operation-collector-dispatch.md),
[operations API](ops-api.md#collector-execution-adr-0048)). While a lease is
held the request waits (`collection_lease_held`) instead of starting. The
Processor's dispatch only reads the lease and never releases or replaces it;
the collector acquires and releases it exactly as for an alarm run, and a
stopped execution's lease is still released only by the operator. A collector that finds its lease held reports `collection_busy` (alarm
receipts included) rather than `collection_failed`; St George, whose session
coordinator records a refused lease as a failed run, still reports
`collection_failed` and then refuses later runs until the operator resumes it.

Deployment applies CORE 0065 and uploads named collector entrypoints before the
Processor and App. It removes the fourteen configured Cron jobs and reconciles
future alarms only after healthy release checks. Initial reservations have a
twenty-minute activation floor to cover Cron propagation; a failed partial release
requires completing/re-running the same release. Verify the postcheck's actual
alarm count and read back deployed empty Cron arrays through the Cloudflare API
before calling the cutover complete.

Scheduling/storage failures reserve a one-minute bookkeeping wakeup rather than
exhausting only native alarm retries. Receipts still in `started` after one hour
are reported as uncertain; this neither expires leases nor repeats collection.

The trusted workflow refuses pre-alarm release/rollback targets before checkout
and before any production mutation. Removing the ScheduleAlarm class requires a
separate retirement migration; it is not an ordinary old-commit rollback.

## Official-site re-survey

[ADR 0050](adr/0050-maintenance-survey-proposals.md). The Processor lane
`maintenance_survey` re-reads allowlisted official notice pages and turns what
changed into proposals. It never changes a rule, a schedule or an alarm.

- **What may be read.** `config/maintenance-survey.json` lists one page per
  source (the registered reference URL), its default scope, time zone,
  cadence in hours, and the provider's terms and cost of automated reading.
  A page is fetched only while `fetch` is `enabled`, which requires `terms`
  and `cost` to be `confirmed`, and only while the Processor's
  `MAINTENANCE_SURVEY_ENABLED` is `"1"` or `"true"`. Every page ships
  `disabled`/`unconfirmed` and the variable is not set: today nothing is
  fetched.
- **What a reading keeps.** Each attempt is an append-only fetch record:
  time, HTTP status, media type, size, SHA-256 and a closed outcome; the body
  is stored once per SHA-256 in the raw-evidence bucket. A redirect, an error
  status, a non-text or empty page, an undecodable or oversized body, a page
  with no recognisable window or with more than 40 is a failure with its code,
  never "no maintenance", and proposes nothing. A failure retries after 1, 2,
  4 … hours, never later than the cadence.
- **What is read.** Dated windows (date and time to time, with 翌 or a
  weekday for the next day) and 毎週X曜日, 毎日 and 毎月第N X曜日(の翌日) followed
  by a time range. Missing years, weekday or zone mismatches, unmarked
  next-day ends, exception, change, cancellation or partial-service wording,
  approximate times (頃, 目途), windows over three days and contradictory
  times are review reasons.
- **What is proposed.** A window that equals an enabled rule changes nothing.
  One that overlaps one rule is a revision of it; one that overlaps none is a
  new rule; an enabled rule this page backed but no longer states is proposed
  disabled, for review. The same reading never proposes twice, and a rejected
  proposal returns only after the rule or the page changes.
- **Decisions.** The **公式サイトの再調査** section shows each page's freshness
  (`最新`, `古い情報`, `まだ取得できていません`, or not fetched automatically), last
  success and failure with its reason, and the undecided proposals with their
  reasons and source page. Only undecided proposals raise a notice. **採用**
  writes the proposal through the same version-checked maintenance revision
  as an edit, with the page and its fetch time as reference and verification
  time and the proposal as its decision reference; it is refused if the rule
  changed after the proposal was read, and that proposal can then only be
  rejected. **却下** records the judgement and changes nothing.

Not verified: no official page has been fetched; which pages to allow and at
which cadence are the owner's to confirm, and pages that are PDFs, need a
login or render with JavaScript cannot be read this way.

## Settings API

- `GET /api/ops/v1/schedules`: settings, maintenance provenance, reservations
  and receipts.
- `POST /api/ops/v1/schedules/:id`: version-checked job edits.
- `POST /api/ops/v1/schedules/maintenance`: versioned maintenance edits.
- `POST /api/ops/v1/schedules/leases/:sourceId`: release the exact stopped
  execution lease after confirmation, without starting collection.
- `POST /api/ops/v1/schedules/proposals/:id`: accept or reject one undecided
  re-survey proposal (`{"decision":"accept"}` or `"reject"`).

Every write is recorded in the common audit log ([audit log](audit-log.md),
ADR 0064) on the `ui` path: the Processor's writer ends its own batch with the
`applied` record — a job revision, a maintenance revision with its provenance
update, a survey decision with the revision it accepted, a lease release (whose
only durable trace this record is) — and the App records each refusal once.
The maintenance edit, the survey acceptance and the lease release are each one
batch: an accepted proposal's revision and decision exist together or not at
all. The page's `GET` is not recorded.

These routes require the configured human Access operator. Writes require
same-origin JSON, `x-kogane-settings: 1` and strict payload validation
(maximum 16 KiB). They are not agent grants, service-token edit routes or MCP
tools. The separately allowlisted, bodyless deployment `/bootstrap` route
only reconciles reservations after release identity checks.

Maintenance changes are made from the management screen using this HTTP API.
An agent can read maintenance windows through the tool below; revising one
through MCP is an operation the owner may delegate, which no delegation can
execute yet. Automatic online research exists only as the proposal-only
re-survey above, which fetches nothing until pages are confirmed. See
[agent access](agent-api.md) and [current status](current-status.md).

## Agent maintenance tools

[ADR 0046](adr/0046-agent-maintenance-windows.md), as amended by
[ADR 0063](adr/0063-delegated-ai-operation-path.md) item 8 (slice S4 of the
[AI operation path plan](plans/2026-10-ai-operation-path.md#8-implementation-slices-in-dependency-order)).
Job times, enable/disable, lease release and bootstrap stay operator or
deployment only, and the routes above refuse every agent and every MCP-audience
caller. The tools' grading is in [agent access](agent-api.md#maintenance-windows).

- `kogane.schedules.maintenance.read` (`schedules.read`, scoped by
  `scopes.scheduleSources`; on `/mcp` and `POST /api/agent/v1/schedules.maintenance.read`,
  which answer the same object) returns, for the granted sources (or the one
  named), the registered reference, each schedule's original next occurrence,
  saved maintenance-adjusted due time, actual alarm, `armed`/`pending`/`disabled`
  state and latest receipt outcome, each rule with up to 20 revisions (actor
  kind, closed reason, whether the reader wrote it as a delegated principal),
  and the writer's limits on delegated revisions with how many the reader wrote
  today. It returns no run or evidence ids, no lease and no principal's
  identity, and nothing about another source. The Processor serves it on
  `/internal/schedules/agent/read`, which refuses a request that also carries
  the operator header or a delegation reference; no write is reachable under
  `/internal/schedules/agent/`.
- `kogane.schedules.maintenance.update` is a delegated operation: no agent-API
  grant can name it, it is published to nobody, and every call on `/mcp` is
  refused before anything reaches the Processor — at the latest with
  `delegation_execution_unavailable`, because no delegation executes until
  slice S3 connects it. Its arguments are one revision: omit `ruleId` with
  `revision: 0` to create a rule under an id the server chooses, or name a rule
  of that source with its current revision; a closed `reason`; an https
  `referenceUrl` on the source's registered maintenance host (stored, never
  fetched) and `verifiedAt`.

**The writer.** Every maintenance revision goes through the Processor's single
writer, `writeMaintenanceRevision(env, write, append, options?)`
(`services/processor/src/schedule-store.ts`): the operator's edit and an
accepted re-survey proposal call it, as does the private delegated maintenance
adapter after current authority and confirmation checks. It sends the revision, its provenance update and what its
caller appends — the audit record ([audit log](audit-log.md)), an acceptance
row — as one batch, so they exist together or not at all. Its actors are the
operator and a delegated principal (`mcp-client:<sub>`); there is no other
kind. Its reason is a closed code (`MAINTENANCE_CHANGE_REASONS` in
`packages/collection/src/schedule-model.ts`), and its decision reference is
closed per actor:

| Actor     | Reason                                                                                                                                 | Decision reference                                                     | Otherwise                                                                                                                   |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| operator  | `operator-edit` (the page's edit) or any other code except the survey's                                                                | none                                                                   | any other shape (a `delegated-audit:` one included) is `invalid_request`; a survey proposal's reference is `invalid_reason` |
| operator  | `maintenance-survey-proposal-accepted`                                                                                                 | exactly `maintenance-survey:proposal:<id>`                             | none is `invalid_reason`; any other shape is `invalid_request`                                                              |
| delegated | `official-notice-added`, `official-notice-changed`, `official-notice-withdrawn`, `outage-observed`, `owner-instructed` or `correction` | exactly `delegated-audit:aud_<uuid>` (ADR 0064's `audit_id`), required | none, a survey reference or any other shape is `invalid_request`                                                            |
| delegated | `operator-edit` or `maintenance-survey-proposal-accepted`                                                                              | —                                                                      | `invalid_reason`, whatever the reference                                                                                    |

The reference is stored whole in `decision_ref`, so no delegated revision is
ever written without the audit record behind it. The writer answers a closed
code: `invalid_request`, `invalid_reference`, `invalid_reason`,
`maintenance_rule_not_found` (a delegated principal naming another source's
rule is answered like a missing one), `revision_conflict`,
`maintenance_deferral_too_long` or `maintenance_write_budget_exceeded`. For a
delegated principal only, it also requires the rule to be the named source's
or new, refuses a revision after which the source has a joined deferral
longer than its bound that its rules did not already cause (every such union
must lie within one the source already had; a running one counts its part
before the revision, up to the bound back), and caps each principal at 30
revisions per rolling day, counted before writing and again through the
partial index `maintenance_agent_writes` inside the INSERT. The bound is seven
days; only the trusted option below raises it to 31. CORE 0078 records each
revision's actor kind, closed reason and decision reference, and its CHECK
refuses free text, a missing reason, a bare agent kind and `operator-edit`
from anyone but the operator; revisions written before it show them as
unknown. A source with no registered reference (PRESTIA bank) takes no rule. A
collection deferred by any window still runs once after it and resumes its
nominal schedule. The `/schedules` page shows each rule's current revision but
not who wrote it or why: the actor kind and reason are on the read tool and in
the table.

### The writer's contract for delegated execution (plan slice S3)

Three exports of `services/processor/src/schedule-store.ts` are what slice S3
builds its delegated execution and confirmation on. The private delegated
adapter reuses their validation; it does not introduce a second writer.

- `prepareMaintenanceRevision(env, write, options?)` →
  `{ok: true, source, ruleId, expectedRevision, currentRevision, deferralClass, budgetRemaining}`
  or the closed refusal `{ok: false, code, status}`. It runs exactly the
  write's validation chain (actor, a delegated principal's budget, reason and
  reference, fields and reference host, current revision, source match,
  expected revision, a delegated principal's deferral bound) and answers what
  the write would, code for code, under the same option. It writes nothing,
  chooses no id (`ruleId` stays `null` for a create; the id is drawn only when
  the revision is written) and draws no random value. `deferralClass` is
  `within-7d` or `within-31d` for a revision the write would accept from a
  delegated principal, and also `beyond-31d` for the operator, whom no bound
  limits and whom it only classifies. `budgetRemaining` is what is left of the
  principal's 30 revisions in the rolling day, `null` for the operator.
- `currentMaintenanceRevision(db, ruleId)` → `{revision, source}` or `null`:
  the read the writer makes before it checks the expected revision.
- `writeMaintenanceRevision(env, write, append, options?)` runs the same chain
  again at write time, then the atomic batch whose INSERT checks the revision
  and the budget once more. A prepare is never an authorization by itself.

`options.deferralBound` is `"delegated-7d"` (the default) or `"confirmed-31d"`.
Under `"confirmed-31d"` the delegated validation refuses a newly caused,
moved or extended joined deferral over 31 days (`CONFIRMED_MAX_DEFERRAL_MS`).
Pre-existing longer operator windows may remain unchanged or shorten. The
audit reference, named-source rule, native 30/day budget and batch hold under
both bounds. Only the trusted private Processor adapter chooses the option;
the public tool and operator route reject any caller-supplied override.

The App reserves an effect audit id for R1 and references the verified prepared
audit id for an R2 confirmation. The common applied/accepted-effect count
enforces the delegation's actual `budget.writesPerDay` across all operations;
that guard and the native writer's 30/day guard share the domain/audit batch.
The preparation checks the current source/rule/host/bounds and reports the
smaller remaining budget, without saving a maintenance revision. Confirm runs
the validations again and consumes the preparation only with the effect.

The checked-in delegation table is empty, and the MCP financial-reader grant
has no schedule authority. Production migration application and real-client
maintenance writes were not verified by these local synthetic tests.

## S3 maintenance execution and confirmation (2026-10-10)

Status: proposed until the integration PR merges. The implementation reuses
the reviewed S3/R2/jobs slices and #564's native writer. It was integrated
against main `f6fb5bdd`; #652's temporal refusal and #643's release guard are
preserved. The [integration plan](plans/2026-10-mcp-maintenance-followups.md)
records the publication and activation boundaries. No grant or deployment is
implied by this implementation.

The closed MCP payload accepts `apply`, `prepare` and `confirm` plus an
idempotency key. R1 apply keeps the seven-day joined-deferral bound. R2
prepare validates with the trusted 31-day bound and records a capped,
expiring preparation; only a matching confirmation may use that bound to
write. A newly caused, moved or extended joined deferral over 31 days is
refused; pre-existing longer operator windows may remain unchanged or shorten.
A caller cannot supply `decisionRef`,
`deferralBound` or a rollback audit reference. The R1 rule references its
reserved effect audit id; the R2 rule references the verified preparation
audit id, and its effect record links the same preparation.

Current delegation capability and source scope are checked before looking
up a replay receipt. Exact retries return the original saved id/revision
without another writer call or alarm reconciliation. Changed payloads do not
reuse a receipt. Fresh writes revalidate at the private Processor adapter.
The common applied/accepted-effect audit count enforces the actual delegation's
`writesPerDay` across operation kinds and delegation-reference changes. It
shares one D1 batch with the native writer's 30-per-principal rolling-day cap,
revision guard, domain write and audit append; failure rolls back the batch.
Preparation reports the lesser remaining budget. It grants no authority by
itself.

The native writer captures the source's append-only revision count before
reading joined windows. Its delegated INSERT checks that count again inside
the batch, so concurrent edits to different rules cannot jointly exceed the
deferral bound. The count uses the existing covering maintenance source
index and scales with that source's history, not constant time. The immediate
provenance update also requires that INSERT to have changed a row, and the
append guard binds the decision reference: a same-millisecond losing retry
cannot replace a winner's official URL or append an effect.

The write result distinguishes `saved` from reconciliation `completed` or
`pending`; a replay returns reconciliation `null`. None asserts that a
reservation is armed. The maintenance read tool supplies the reservation and
next-run state. Audit rows keep digests, closed codes and references, not the
official URL or other provider text.

The tests use synthetic local D1 data and synthetic Access keys. They cover
signed MCP entry, revocation and scope-before-replay, both hard bounds,
prepare/effect linkage, shared daily budget, rollback, exact retries,
concurrent joined windows and losing-provenance writes. Production migration
state and real-client use were not checked. `MCP_DELEGATIONS` stays empty and
the committed MCP financial-reader grant receives no schedule authority.
S6 survey acceptance remains unavailable pending the separate owner decision;
no survey grammar, grants, Access, authentication or deployment is changed.
