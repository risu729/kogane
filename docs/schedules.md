# Schedule administration

Open `/schedules` from **取得履歴** or **収集スケジュール**. Only the configured
Access operator can read or change these settings. The page shows the original
next occurrence, maintenance-adjusted due time, actual alarm reservation and the
latest scheduling receipt separately. All displayed timestamps use Japan time;
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
that is not a claim that maintenance never happens. Research is not automatically
refreshed. The page flags provenance older than thirty days.

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
`collection_failed`.

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

## Settings API

- `GET /api/ops/v1/schedules`: settings, maintenance provenance, reservations
  and receipts.
- `POST /api/ops/v1/schedules/:id`: version-checked job edits.
- `POST /api/ops/v1/schedules/maintenance`: versioned maintenance edits.
- `POST /api/ops/v1/schedules/leases/:sourceId`: release the exact stopped
  execution lease after confirmation, without starting collection.

These routes require the configured human Access operator. Writes require
same-origin JSON, `x-kogane-settings: 1` and strict payload validation
(maximum 16 KiB). They are not agent grants, service-token edit routes or MCP
tools. The separately allowlisted, bodyless deployment `/bootstrap` route
only reconciles reservations after release identity checks.

Maintenance changes can be made from the management screen using this HTTP API.
An AI/MCP integration, its credentials/permissions and automatic online research
refresh remain unimplemented. See [agent access](agent-api.md) and
[current status](current-status.md).
