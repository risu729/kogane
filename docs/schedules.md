# Schedule administration

Open `/schedules` from **取得履歴** or **収集スケジュール**. Only the configured
Access operator can open this page; maintenance windows alone can also be read
and revised by a granted agent ([below](#agent-maintenance-tools)). The page
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

These routes require the configured human Access operator. Writes require
same-origin JSON, `x-kogane-settings: 1` and strict payload validation
(maximum 16 KiB). They are not agent grants, service-token edit routes or MCP
tools. The separately allowlisted, bodyless deployment `/bootstrap` route
only reconciles reservations after release identity checks.

Maintenance changes can be made from the management screen using this HTTP API,
and by an agent through the two MCP tools below. Automatic online research
exists only as the proposal-only re-survey above, which fetches nothing until
pages are confirmed. See [agent access](agent-api.md) and
[current status](current-status.md).

## Agent maintenance tools

[ADR 0046](adr/0046-agent-maintenance-windows.md). An agent-API grant with
`schedules.read` and `schedules.maintenance.update`, scoped by
`scopes.scheduleSources`, reaches two MCP tools and nothing else here: job
times, enable/disable, lease release and bootstrap stay operator or deployment
only, and the routes above still refuse every agent.

- `kogane.schedules.maintenance.read` returns, for the granted sources (or the
  one named), the registered reference, each schedule's original next
  occurrence, saved maintenance-adjusted due time, actual alarm,
  `armed`/`pending`/`disabled` state and latest receipt outcome, and each rule
  with up to 20 revisions (actor kind, reason, whether the caller wrote it).
  It returns no run or evidence ids, no lease and no principal's identity, and
  nothing about another source.
- `kogane.schedules.maintenance.update` appends one revision: omit `ruleId` with
  `revision: 0` to create a rule under an id the server chooses, or name a rule
  of that source with its current revision. It needs a one-line `reason`, an
  https `referenceUrl` on the source's registered maintenance host (stored,
  never fetched) and `verifiedAt`. It answers the saved revision, whether the
  reservations were reconciled, and the source's view after the save.

Both go through the Processor's single writer, `writeMaintenanceRevision`
(`services/processor/src/schedule-store.ts`), which the operator route and an
accepted re-survey proposal also use. It answers a closed code:
`invalid_request`, `invalid_reference`, `reason_required`,
`maintenance_rule_not_found` (another source's rule answers like a missing
one), `revision_conflict`, `maintenance_deferral_too_long` (after an agent
revision, every joined deferral of the source longer than seven
days must lie within one its rules already caused; a running one counts its
part before the revision, up to seven days back) or
`maintenance_write_budget_exceeded` (30 agent revisions per principal per
rolling day). CORE 0067 records each revision's actor kind, reason and optional
decision reference; older revisions show them as unknown.
A source with no registered reference (PRESTIA bank) takes no rule. A
collection deferred by any window still runs once after it and resumes its
nominal schedule. An agent revision is in effect once saved; no one accepts it
first (ADR 0046). The `/schedules` page shows each rule's current revision but
not who wrote it or why: the actor kind and reason are on the read tool and in
the table.

Not verified in production: no grant names a maintenance principal, CORE 0067
is not applied, and no Claude or Codex client has called these tools.
