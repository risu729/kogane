# ADR 0050: Re-survey official maintenance pages as proposals an operator accepts

- Status: proposed (accepted when its PR merges; production use waits for the
  owner's confirmation of each page, see Consequences)
- Date: 2026-10-08
- Issue: #561; builds on [ADR 0039](0039-alarm-schedule-management.md) and
  consumes the maintenance writer of #560 (ADR 0046, open in PR #564)

## Context

ADR 0039 made provider maintenance windows data: versioned
`provider_maintenance_rules` revisions with an official URL, a verification
time and a scope, joined by `afterMaintenance` so a deferred collection runs
once after the window. The research behind them is a reviewed snapshot
(`config/maintenance-research.json`, 2026-10-04). Nothing re-reads the
official pages, so a moved or new window stays unknown until someone checks
by hand, and the schedule page can only say that provenance is older than
thirty days.

Issue #561 asks for a periodic re-survey of the official pages with
freshness and success/failure visible, a comparison with the stored rules,
review for ambiguous or contradictory notices, explicit adoption conditions,
and no duplicate of the collection alarm path. The standing rules decide much
of the shape: heuristics only propose and nothing changes adopted state until
a decision accepts it (INV07); missing, failed or partial readings are
reasons, never zero (INV05); provider semantics nobody has observed stay
unsupported (ADR 0004); logs and operational records carry counts and closed
codes only; fetched page text is data and is never executed.

## Options considered

1. **Let the lane write rules when a page is clear.** Fastest, and wrong
   here: no provider page has been read by this code, so "clear" would be the
   grammar's opinion of a page nobody observed (ADR 0004), and a misread or
   injected page would move real collection times with no human in between
   (INV07).
2. **Let an agent re-research through the #560 MCP tool.** The tool writes
   bounded revisions with a reason, but every write still adopts, and a
   periodic job would need a standing agent session. It stays a separate,
   explicitly granted path; it is not the periodic mechanism.
3. **Read pages with a language model.** Non-deterministic, a direct
   prompt-injection surface for page text, an external cost per reading, and
   no closed output without a second validator. Rejected.
4. **Per-provider page parsers.** The precise option, but it encodes page
   structures nobody has captured yet. Deferred until stored pages exist to
   write them against (the bodies this ADR keeps are that evidence).
5. **A Processor lane that fetches only allowlisted pages, keeps what it
   fetched, reads windows with a closed grammar and records proposals; an
   operator accepts or rejects each through the version-checked maintenance
   writer.** Chosen.

Libraries, per the owner's rule to reuse maintained ones for generic work:

| Need                      | Choice                                                      | Why                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTML to text              | `parse5` 8.0.1 (already a Processor dependency)             | The repository's HTML parser; scripts, styles, comments and `hidden` elements are not walked                                                                                                                                                                                                                                                                     |
| Date and time expressions | `chrono-node` 2.10.1, strict Japanese configuration (new)   | MIT, no dependencies, ~51 KB minified for the Japanese locale, pure JS that runs in workerd. It reads 年月日, eras (令和), full-width digits, 午前/午後, 時/分, weekdays and zone abbreviations, and reports which components the text stated. 2.10.2 was under two weeks old, so 2.10.1 is pinned                                                               |
| Ranges, recurrence, year  | this repository (`extract.ts`)                              | chrono's own range handling fills in and reorders components the text did not state (measured: `21:00～6:00` became a certain next-day end with a copied weekday), and it has no recurrence (毎週, 第N土曜日の翌日). The text is cut at range separators before chrono sees it; joining, recurrence and year pinning are the closed business grammar of this ADR |
| Time zones                | `wallTimeInstant`/`localCalendarDate` of the schedule model | The same Intl-based code the alarms use, exported rather than duplicated                                                                                                                                                                                                                                                                                         |
| Schema validation         | `zod` 4.6.5 (already adopted in `services/app`)             | Strict objects for the allowlist and the decision body                                                                                                                                                                                                                                                                                                           |
| Hashing, canonical keys   | `sha256Hex` (evidence contract), `canonicalDigest` (domain) | Existing helpers over WebCrypto                                                                                                                                                                                                                                                                                                                                  |
| HTTP with retry           | the platform `fetch`, no retry library                      | A retry is the lane's next attempt after a backoff, not a loop inside one tick: a failing page is never hammered and a tick stays bounded                                                                                                                                                                                                                        |
| Diff                      | none                                                        | The comparison is semantic, over closed patterns and rule revisions; no text diff is involved                                                                                                                                                                                                                                                                    |

## Decision

**Allowlist.** `config/maintenance-survey.json` lists, per source, the page
to read (each is the source's registered reference URL, so the writer's
registered-host check holds), the scope a new window starts with, its time
zone, a cadence in hours, and the provider's terms and cost of automated
reading as `unconfirmed`/`confirmed`. A page is fetched only when its entry is
`fetch: "enabled"`, which the schema allows only once terms and cost are
`confirmed`. Every entry ships `disabled` and `unconfirmed`. The lane as a
whole runs only while `MAINTENANCE_SURVEY_ENABLED` is `"1"` or `"true"`; the
variable is not declared, so it is off.

**Lane.** `maintenance_survey` runs after `report_job` in the five-minute
Processor tick. Each tick claims at most `targetsPerTick` (2) due pages from
`maintenance_survey_cursors` (a claim moves the due time 30 minutes ahead, so
an overlapping tick cannot fetch the same page) and for each: one GET with no
cookie, no redirect following, a 15-second timeout and a 2 MiB cap counted on
the body stream (a body the timeout or a dropped connection ends while it is
read is `timeout`/`network_error`, like one that never started); the body
stored content-addressed in the EVIDENCE bucket under
`maintenance-survey/objects/<2 hex>/<sha256>` (written once, SHA-256 verified
by R2); one append-only `maintenance_survey_fetches` row with the fetch time,
HTTP status, closed media type, byte size, SHA-256, object key, extractor
version, window counts and a closed outcome. A success moves the page's next
due time by its cadence; a failure retries after 1, 2, 4 … hours, never later
than the cadence. The tick's log line and its `processor_lane_ticks` row hold
counts and the closed failure-code map only.

**Failure is never "no maintenance".** A failed, redirected, empty, oversized,
non-text, undecodable page, a page with no recognisable window, or one with
more than 40 is a failure outcome: the fetch row records it, the cursor
shows it, and no proposal (least of all a removal) follows. Only `extracted`
(at least one window read) moves `last_success_at`.

**Extraction.** Lines of visible text are NFKC-normalised and matched against
a closed grammar: a dated window starts at an expression stating month, day
and hour and ends at the next expression after one range separator,
optionally after 翌/翌日 or a weekday; recurring windows are 毎週X曜日
(lists with ・), 毎日, and 毎月第N X曜日 (の翌日/翌々日/N日後) followed directly
by a time range. Anything else is not a window. Ambiguity is a closed reason,
never a silent guess: `year_inferred`, `weekday_mismatch`,
`end_next_day_inferred`, `timezone_mismatch`, `exception_stated`,
`may_change` (including approximate times: 頃, ごろ, 目途, 目安),
`cancellation_stated`, `partial_service`, `long_window`,
`contradictory_windows`. A stated weekday that matches exactly one candidate
year pins it without a reason. Dated windows that ended before the fetch are
counted as past and not proposed.

**Comparison and proposals.** Against the source's current rule revisions: a
window equal to an enabled rule is unchanged; equal only to a disabled one, a
`changed` proposal to re-enable it (`rule_disabled_by_operator`); overlapping
exactly one enabled rule of the same kind, a `changed` proposal against that
rule's current revision, keeping the rule's scope; overlapping several, a
`new` proposal with `ambiguous_rule_match`; otherwise `new` with the page's
scope. An enabled rule recorded from this page's URL that no window matches
is an `absent` proposal to disable it, always `review_pending`, and only when
the page yielded a window of the same family (recurring or dated). Proposals
are append-only, keyed by a digest of (page, kind, rule, base revision, zone,
pattern, enabled, scope): the same reading again proposes nothing, and a
rejected proposal is not proposed again until the rule or the page changes.
A proposal without reasons is `proposed`, with any `review_pending`; both
need the same decision.

**Decision.** Only the configured human operator decides, through
`POST /api/ops/v1/schedules/proposals/:id` (`{"decision":"accept"|"reject"}`,
same-origin JSON with the settings header, like every settings write). A
rejection appends a `maintenance_survey_decisions` row and nothing else. An
acceptance hands the maintenance writer the revision the proposal describes:
the operator as actor, the proposal's rule (or `<source>-survey-<id>` for a
new one) at the revision the proposal was read against, the page URL and
fetch time as reference and verification time, `maintenance-survey:proposal:<id>`
as the decision reference and a closed reason. The writer's own version check
refuses a proposal whose rule moved since (`revision_conflict`); the read side
marks such a proposal not current and offers only rejection. Only after the
writer saved does the acceptance row record the revision it produced. The
writer reconciles the source's alarms, so the next run and the one run after
the window come from the existing alarm code; the survey never touches a
schedule, an alarm or a lease.

**No agent decides.** Accepting or rejecting a proposal is an operator
settings write; agents never approve or commit a change. The #560 MCP tool
writes its own bounded revisions through the same writer and neither reads
nor decides survey proposals; a revision it writes simply moves the rule, and
a proposal read against the older revision then reads as not current.

**The writer.** The decision code depends on the narrowest slice of #560's
`MaintenanceWrite`/`MaintenanceWriteResult` (`RevisionWrite`,
`RevisionResult`), which `writeMaintenanceRevision(env, write)` satisfies as
it is. Until #560 merges, the route passes an adapter over the operator
route's existing writer (`updateMaintenance`), which makes the same
version-checked revision; it does not store the decision reference, which
CORE 0067 of #560 adds. Merging #560 replaces the adapter by
`writeMaintenanceRevision` in one line.

**Read side.** `GET /api/ops/v1/schedules` gains `survey`: whether the lane
runs; per page its freshness (`disabled`, `never`, `fresh`, or `stale` when
the last success is older than twice the cadence), last attempt, success,
failure with its closed code, consecutive failures, next due time and last
page change; and the undecided proposals with their reasons and provenance.
`attention` counts undecided proposals and is the only thing that raises a
notice on the page; failures and staleness are shown, not alarmed.

**Storage.** CORE 0069 adds the three append-only tables (`core-keep`) and the
cursor (`operational-mutable`). Reasons, outcomes, media types and failure
codes are checked closed sets in the schema itself.

## Consequences

- Nothing is fetched in production until the owner confirms, per page, that
  the URL is the right official notice, that automated reading at the cadence
  is acceptable under the provider's terms and cost, and the cadence itself;
  then sets the entry `enabled`/`confirmed` in a reviewed change and sets
  `MAINTENANCE_SURVEY_ENABLED`. Several registered references are a login
  page or a PDF; a PDF is `unsupported_content_type`, and a page that renders
  its notice with JavaScript or needs a session will read as
  `no_window_recognized`. Those stay manual.
- The grammar has been exercised on synthetic text only. Real notices that
  state windows across table cells or lines, as day ranges (月曜日～金曜日) or
  in other forms are not read; that is a failure or a missed window, never an
  invented one, and every reading is reviewed before it counts.
- `absent` and `changed` are guesses about which rule a window revises. They
  are proposals for that reason, and an operator who disagrees rejects them
  and edits the rule by hand.
- Before #560 merges, an accepted revision does not carry its decision
  reference; the acceptance row links proposal and revision instead. The
  writer call and the acceptance row are not one transaction: if the row
  cannot be written after the writer saved, the revision stands, the API
  answers `decision_record_failed`, and the proposal reads as not current (a
  `new` one too: its rule `<source>-survey-<id>` then exists). Accepting it
  again is the writer's `revision_conflict`, so the revision is never written
  twice; the proposal can still be rejected.
- Page bodies of public notices are kept in the raw-evidence bucket under
  their own prefix, outside the collection catalogue, without retention
  pruning. Each distinct body is stored once.
- CORE 0069 follows the numbering agreed for the open PRs: CORE 0067 is
  #560's and 0068 #544's, so 0069 lands after them whatever the merge order.
  Main's 0070 (#586) merged first; a database that already has it applies
  0069 afterwards, and the two share no table.

## Verification

Synthetic tests only; no provider page was fetched by a test or while
writing this. `services/processor/test/maintenance-survey-extract.test.ts`
covers the allowlist schema and the committed configuration, every transport
failure code (also for a body that fails while it is read), strict decoding
(UTF-8 and Shift_JIS), visible-text extraction, the dated and recurring
grammar, every reason code, rejected and past windows, contradictions, the
comparison with rules, and a page whose instruction-like text only ever meets
the closed grammar.
`maintenance-survey-lane.test.ts` runs the lane on the migrated schema in
Miniflare: provenance and the content-addressed body, proposals without any
rule or schedule change, freshness and backoff, the same reading proposing
nothing new, empty and windowless pages as failures, an injected page whose
text reaches no row, log or tick record, a body cut off after its headers
recorded as `timeout` and backed off, and the flag-off tick.
`maintenance-survey-decisions.test.ts` accepts a proposal through the
operator route and the adapter, then shows with the production
`ScheduleAlarm` that the due time moves to the window's end while the nominal
occurrence stays, and that the alarm runs it once after the window; it also
covers rejection, a moved rule (`revision_conflict`), operator-only access,
the exact write handed to a synthetic #560-shaped writer, and an acceptance
whose decision row fails: the revision is written once, the proposal (new or
changed) reads as not current, and a retry is `revision_conflict`.
`services/app/test/schedules.test.ts` covers the relay, and
`apps/web/test/schedules.browser.test.ts` the page section.
