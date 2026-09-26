# Processor: shared-R2 terminals, registration, lanes and operations dispatch

Unified plan U08 (chapters 02 §1-3 and §5, 03 §4-§7, 05 §6, 15 §2). What the
Processor (`services/processor`, Worker `kogane-observation-pipeline`)
does with a collection run that a collector persisted into the shared DATA
bucket, how it stays exactly-once, what it records per stage, and what it took
over from the retired importer.

Production enables the current lanes. Collection is shared-only and projections
use READ exclusively; see [rollout.md](rollout.md).

## 1. What the terminal is, and is not

A collector writes its objects first and its terminal manifest last
(`packages/collection`, [collection-contract.md](collection-contract.md)). The
terminal is the record that the run **finished persisting the bytes it decided
to keep**. It is not a claim that the provider returned everything, not a
claim that the parse worked, and not a claim that a reader ever saw the result
(plan 03 §5). A `partial` acquisition stays partial the whole way through; no
step below widens it.

The Processor therefore records per run and per stage, not one
`last_success_at`: a newer run succeeding says nothing about an older run that
is still unregistered.

## 2. Two ways in, one use case

| Path                        | Trigger                                                              | Boundedness                                                                                                      |
| --------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Queue consumer              | R2 event notification on the DATA bucket, `runs/` + `/terminal.json` | one batch of at most 10 messages, all sharing one registration budget of 500 operations (§3.3)                   |
| `collection_scan` cron lane | every 5 minutes                                                      | up to 5 staged registrations continued first, then one R2 list page (25 keys) and at most 5 registrations (§3.3) |

Both call `registerTerminal(source, runId)`
(`packages/application/src/collection/register-terminal.ts`). The queue only
wakes the Processor sooner; the terminal in R2 is the record, so:

- a **lost notification** costs time, not evidence — the scan finds the run
  and no provider is contacted (G1-04);
- a **duplicate notification** costs one query — the run already has a
  completed `registered` stage (G1-05, G1-11);
- a message the consumer cannot vouch for (another account, another bucket,
  a malformed body) is acknowledged and dropped rather than retried forever,
  because the scan covers it anyway.

What the consumer does with each outcome, exactly:

| Outcome of `handleTerminalNotification`                        | Message   | Why                                                                                        |
| -------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------ |
| `flag_off`                                                     | **acked** | the flag is off; the message is logged and dropped, never retried into the DLQ             |
| `invalid` (account, bucket, shape), `ignored` (not a terminal) | acked     | not a fact about a terminal in the DATA bucket                                             |
| `registered`, `already_registered`, `blocked`, `missing`       | acked     | done, or nothing further a retry could change                                              |
| `pending` (operation budget spent, progress recorded)          | acked     | the run is unsealed and the next scan tick continues it; retrying would push it to the DLQ |
| `deferred` (the batch's budget was spent before it started)    | retried   | nothing was registered; a later delivery starts it, or the scan if it lands in the DLQ     |
| `retryable` (ingest client or route absent)                    | retried   | a configuration fix will make it succeed; after `max_retries` it lands in the DLQ          |
| the handler threw                                              | retried   | a CORE or R2 failure; the log carries a safe code only                                     |

With the flag off the queue therefore drains harmlessly: every message is
acknowledged with a `flag_off` log line, and the terminals stay in R2 for the
scan to find once the flag is on.

The scan is a **full bounded walk of the whole `runs/` prefix** with an R2
list cursor in `collection_scan_state`. It is deliberately not a recent-time
window and not a lexicographic watermark: a run whose terminal is confirmed
late sorts wherever its run id puts it, and "everything after the newest key I
saw" steps straight over it (03 §6, G1-12). When the walk finishes, the cursor
is cleared and the next tick starts at the beginning of the prefix again.

A tick that spends its registration budget leaves the cursor where it was, so
the next tick lists the same page; the runs it already registered answer in
one query each and the rest make progress. That cannot skip a run, which a
remembered position inside a page could.

A registration that **throws** — R2 or CORE unavailable, or a refusal CORE
made that the derivation did not foresee — is counted in the lane's `failed`
and logged by its error class only; nothing is recorded for that run, the
page still advances and the next cycle tries it again. One failing run never
stops the page and never pins the cursor (G1-13).

## 3. Idempotency and what blocks

The identity is the tuple of plan 03 §4:

```text
(source, runId, terminalDigest, registrationContractVersion)
```

`registrationContractVersion` is `terminal-registration-v1`, the version of the
`terminal-v1` → ingest-contract derivation in
`packages/application/src/collection/descriptors.ts`. When that derivation
changes what a terminal _means_ in CORE, the same run registers again as a new
revision and the old registration is kept. The one exception so far is the
artifact dataset table (§3.4, ADR 0022): a bump would register every persisted
run a second time and list a parsed Mizuho capture's transactions twice, so the
table shipped under `terminal-registration-v1` and applies to terminals first
registered after it.

| Situation                                                                                                                | Outcome                                            | Recorded                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| First sighting of a valid terminal                                                                                       | registered                                         | `persisted` completed, `registered` completed, run linked to `fetch_runs`                       |
| Same terminal again                                                                                                      | no-op                                              | nothing new                                                                                     |
| Different manifest, same run id                                                                                          | blocked `terminal_digest_conflict`                 | the _new_ sighting is blocked; the earlier rows are untouched (G1-06)                           |
| Source not in the collector mapping (§3.1)                                                                               | blocked `unknown_source`, **no port call**         | `persisted` completed, `registered` blocked                                                     |
| Source maps to an id CORE has no active row for                                                                          | blocked `source_undeclared`, no port call          | as above                                                                                        |
| `providerOutcome: failed` with no provider artifact                                                                      | blocked `provider_run_failed`, **no seal**         | `persisted` completed, `registered` blocked; the run and its outcome stay on record (§3.2)      |
| Manifest CORE would refuse at the seal (a sanitized capture with no `redacted` step, a derived artifact with no lineage) | blocked with the derivation's safe code, no seal   | `registered` blocked; the derivation checks CORE's rules before any port call                   |
| Referenced object missing or resized                                                                                     | blocked with the object's reason code, **no seal** | `registered` blocked (G1-14)                                                                    |
| Terminal unreadable or not canonical                                                                                     | blocked with the reader's reason code              | a run row under the digest of the stored bytes, `persisted` blocked; the scan continues (G1-13) |
| Processor's ingest client or route absent                                                                                | **retryable**, not blocked                         | `registered` retryable, one row per change of state                                             |
| Operation budget spent (§3.3)                                                                                            | pending, **unsealed**                              | `registered` pending naming the fetch run; the next call does only what is missing (G1-10)      |

A resumed registration reads what the run already has — its units, ranges,
catalogued artifacts, staged inventory items and unit reports, one statement
each — and skips it, so the budget is spent on new work and a run of any size
the manifest schema allows converges over as many invocations as it needs.
Every port operation is idempotent on its own key, so a call that re-runs one
anyway is a no-op rather than a conflict.

### 3.1 Collector ids, CORE source ids and producers

A collector names itself in its terminal and in its `runs/<source>/` prefix
by its **own** id. For most collectors that is the CORE source id; for three
it is not (`sbi-shinsei` → `sbi-shinsei-bank`, `prestia-globalpass` →
`global-pass`, `smbc-direct` → `smbc-bank`), and `v-point-pay-email` shares
the `v-point-pay` source with the V Point Pay collector. The mapping is the
closed table `COLLECTOR_SOURCE_IDS` in
`packages/application/src/collection/descriptors.ts`:

- `collection_runs.source` keeps the collector's id — it is the R2 identity
  the terminal key is derived from;
- `fetch_runs.source_id` is the CORE id, so nothing downstream has to know a
  collector's name;
- a terminal whose source is not a key of the table is recorded and blocked
  as `unknown_source` before any registration; extending the table is a code
  change with a test, not a runtime guess.

The terminal's `producer` is registered as the CORE producer, and a shared-R2
collector names itself `collector-<collector id>` (U09). Those producers do
not exist before U09, so the Processor's ingest routes are declared together
with them in `config/ingest-clients.json` and applied as one idempotent SQL
file (§10). `scripts/config-bootstrap.test.ts` checks that the declared
routes are exactly the mapping table's entries and that every CORE id the
table points at is a declared source.

### 3.2 Failed runs

A terminal exists for a run that failed at the provider: the collector
persisted whatever it decided to keep — often only its own `manifest.json`,
sometimes an error capture — and wrote the terminal with
`providerOutcome: failed` (plan 03 §2). Registration distinguishes two cases
by the artifact roles, never by the outcome alone:

- **no provider bytes** (nothing, or only `collector_manifest`,
  `collector_error`, `collector_summary`, `collector_derived`): the run is
  recorded with its outcome and blocked as `provider_run_failed`. No fetch
  run is created and nothing is sealed, so an empty sealed run can never read
  as a successful acquisition with no observations;
- **a provider artifact is present** (`provider_*`,
  `sanitized_provider_capture`, `user_capture`): the run registers and seals
  like any other, and its terminal report says `failed`. Nothing is widened.

`success` with `coverageStatus: partial` (GLOBAL PASS by design) is a
success that registers as such, with the partial coverage recorded on the
run row and in the unit reports.

The collector's normalized `manifest.json` is one artifact among the others;
registration never reads it. The terminal's own `artifacts[]` is the
authoritative list, and its `storageRef.key` values are the content-addressed
`objects/<2 hex>/<sha256>` keys, checked against each artifact's digest by
the manifest validator.

A block is write-once, which is why a missing ingest route is retryable
instead: the block would outlive the operator's fix. A retryable stage row is
appended only when the state or the code changes, so an append-only table does
not fill with one row per tick.

### 3.3 Operation budget and staged registration (issue #87)

Issue #87 was filed against the retired Vpass importer, whose initial path
catalogued every page group and five artifacts through Service Binding calls
in one invocation, against Cloudflare's limit of 32 Worker invocations per
request. That importer, its signed continuations and its queue are gone
(§8, [legacy-retirement.md](legacy-retirement.md)). Registration now runs in
process here, and the Processor declares no Service Binding, so it makes no
such call at all; `scripts/service-binding-chain.test.ts` fails if a
collector or the Processor ever gains one, and pins the longest chain in the
account at two Workers (App → Processor).

The question the issue asked still applied to the successor: registration was
bounded by artifact count (500 per call) and nothing else. Every call added
every unit and every range of the manifest, re-verified every referenced
object and re-staged every inventory item before cataloguing anything, and the
manifest schema allows 1,000 units, 1,000 ranges and 10,000 artifacts. Each of
those is several CORE statements or an R2 call, against a documented
[D1 limit](https://developers.cloudflare.com/d1/platform/limits/) of 1,000
queries per Worker invocation and a
[Workers limit](https://developers.cloudflare.com/workers/platform/limits/#subrequests)
of 10,000 subrequests per invocation (Workers Paid). Measured before this
change, one 34-artifact Vpass card cost 669 D1 statements and 69 R2 calls in a
single call, and a queue batch holds up to ten such terminals. Staging an
inventory was also broken: its chunk of 50 items was above the contract's 30,
so a run of more than 50 artifacts failed `invalid_items` on every attempt and
never sealed.

**The budget.** Every registration of one Worker invocation — the queue
consumer's whole batch, or the cron's `collection_scan` and
`operation_dispatch` lanes together — spends from one `RegistrationBudget`
of **500 operations**, where an operation is one D1 statement (each statement
of a batch counts) or one R2 call
(`packages/application/src/collection/budget.ts`). The count is measured,
not estimated: registration wraps the bindings it is handed in a meter and
builds its port over them. 500 is half the documented D1 limit — the queue
consumer spends nothing else, and a cron invocation shares the rest with its
other lanes — and a twentieth of the subrequest limit. No lower provider
limit is assumed.

**The steps.** Registration is a sequence of steps, each idempotent on its own
key, and a step only starts while its reserve and the audit reserve still fit.
Each reserve is what the step measured against the real CORE schema plus a
margin, and `services/processor/test/registration-budget.test.ts` fails when a
step outgrows its reserve:

| Step                                                               | Measured                              | Reserve              |
| ------------------------------------------------------------------ | ------------------------------------- | -------------------- |
| Preamble: terminal read, run row, conflict and refusal checks      | 8                                     | 16                   |
| The run, a unit, a range, the inventory declaration, a unit report | 5-6                                   | 16                   |
| An artifact: its R2 head, adoption and catalogue row               | 19, +1 per transform, +2 per relation | 32, +1 each, +2 each |
| An inventory chunk (at most 30 items, the contract's maximum)      | 7 + 3 per item (97 full)              | 16 + 4 per item      |
| Final: run report, seal (direct of ≤ 50, or staged), link          | 32 direct, 16 staged                  | 64                   |
| Audit: a `pending` row for a yield, or a stage row and the block   | 1-2                                   | 4, always kept back  |

So no invocation spends more than 500 operations on registration, and a
failure at the edge of the budget still records its audit. A Vpass card of
about twenty statement pages registers in one invocation; a 34-artifact card
takes two (467 and 292 operations); the schema's largest structure converges
over as many as it needs. No step can be too large for every invocation: the
descriptor contract accepts at most 100 transformation steps and 100 relations
per artifact, and that artifact's reserve (332) still fits what a fresh
invocation has left after its preamble and the run. A manifest whose derived
descriptor the contract refuses — a transformation with more inputs than 100
relations, which the manifest schema allows — is blocked with the contract's
code (`invalid_relations`, say) instead of failing on every tick.

**The continuation.** A registration that reaches the budget yields `pending`:
the `registered` stage says `pending` and names the fetch run, and everything
written so far stays in CORE, unsealed and invisible to normal readers. The
next call reads what exists and does only what is missing. The
`collection_scan` lane continues up to five pending runs, oldest first, before
it lists anything, so a large run finishes over consecutive ticks instead of
waiting for the walk to come round to it. A registration that could not start
because the invocation's budget was already spent is `deferred`: nothing was
registered, the queue retries the message, the scan leaves its cursor, and an
`import` operation waits with `registration_deferred`. A message deferred on
every delivery reaches the DLQ after `max_retries` like any retried message,
and the scan walk registers its run anyway (G1-04).

The final step is never split by a yield, but an invocation can still end
inside it. The next call then re-enters it: the run report is found under its
report key, the seal under its attempt id
(`<runId>:terminal-registration-v1`), and the link is made once, so each is
recorded once. The same test file kills an invocation after the run report
and after the seal, for a direct and a staged seal.

Objects are verified before anything is recorded for them. On the first call
that happens before the fetch run exists, for as many artifacts as the
invocation can go on to catalogue — every artifact of a run that fits one
invocation — so a missing or resized object still blocks with no fetch run at
all (G1-14). Beyond that window each object is verified in its own step just
before it is catalogued; a problem there blocks the run before its seal.

**Versioning.** The registration contract stays `terminal-registration-v1`.
Staging changes how many calls a registration takes, not what a terminal means
in CORE: the descriptors, the inventory digest and the seal's attempt id are
byte-identical, so a bump would only register every run a second time as a new
revision. No signed continuation exists any more to be versioned: the
importer's `vpass-transfer-v2.` state travelled on the deleted Vpass import
Queue, whose backlog was verified empty before deletion, and its ingest
clients are deactivated. A body of that shape arriving on the terminal queue
is not an R2 notification; it is refused as `invalid` and acknowledged.

**Deploy consequence.** In-flight state of the previous release completes
under this one without an operator: a run it left `pending` is continued on
the next tick, reusing its fetch run, units, ranges, inventory declaration and
catalogued artifacts; a run above 50 artifacts it could never seal has no
`pending` row, so it is picked up when the scan walk next reaches it (or at
once by an `import` operation) and completes on its existing inventory. Both
cases are tested. Queue messages are R2 notifications before and after, so
none in flight changes meaning. The health route's `registration` counts
(§13) show how many terminals are still short of registration.

### 3.4 Artifact datasets (ADR 0022)

`terminal-v1` has no dataset field, and every parser except Mizuho's selects
its artifacts by dataset, so the derivation supplies one. `artifactRequest`
looks the artifact up in the closed table `ARTIFACT_DATASETS` (in
`descriptors.ts`), keyed by the terminal's `source`: a rule names an exact
artifact key or a whole-key pattern, the role and the media types the
collector declares, and the dataset. An artifact that matches no rule — or
matches a key with another role or media type — is registered with no
dataset, which no parser but Mizuho's reads. Nothing is guessed.

What the table maps (from each collector's persist path and each parser's
`accepts`; [ADR 0022](adr/0022-registration-artifact-datasets.md) has the
full list):

- Mobile Suica `sf-history.json` → `sf-history`; Money Forward's index,
  detail and monthly pages; MyJCB's discovery, past-months, detail and ledger
  artifacts; GlobalPass activity pages; the SBI Securities, SBI Shinsei and
  SBI VC Trade datasets; SMBC's normalized balance and transactions; Sony
  Bank's balance, history pages, history CSVs and wallet pages; St George's
  account snapshot; V Point's balance, SMFG point and history pages; the V
  Point Pay notification event.
- Not mapped: evidence no parser reads (manifests, summaries, raw pages beside
  their normalized form); Mizuho, whose parsers read artifacts without a
  dataset; MyJCB `credit-menu.html`, whose parser requires a media type
  parameter a terminal cannot carry.
- **Withheld: Vpass.** The statement-page rule is kept in
  `WITHHELD_ARTIFACT_DATASETS` and not applied, so collector-vpass captures
  are registered but never parsed. A parsed collector capture would become
  the current statement snapshot of its card-month and retire the importer-era
  purchases, because it cannot yet bind to the trusted card identity
  (ADR 0023). It is applied when the collector derives the binding.

`scripts/artifact-datasets.test.ts` checks the table against both sides:
every mapped or withheld dataset is accepted by a registered parser, every
dataset a parser requires from a shared-R2 source is mapped, withheld or named
unreachable, and the withheld list is pinned.

**Contract version.** The table did not bump `REGISTRATION_CONTRACT_VERSION`.
A bump registers every persisted terminal again (the version is part of the
`collection_runs` key and of the fetch run's `sourceRunKey`): a second fetch
run in the same session over the same objects, new artifacts, a new seal and
new parse runs. For a capture already parsed that doubles what has no provider
identity in the read model — a Mizuho terminal registered under two versions
lists its transactions twice (`services/processor/test/registration-datasets.test.ts`).
So the table applies to terminals first registered after it: the Mobile Suica
runs registered before it keep `dataset = NULL` and stay unparsed, and runs
blocked before it stay blocked. A registration left `pending` across the
deploy may block with `inventory_mismatch` at its seal, because part of it was
catalogued before the table.

MyJCB artifacts are mapped but do not parse yet: the metadata extractor finds
their manifest entry by `connectionId` and `filename`, which the shared
collector's manifest does not carry, so each parse fails with
`manifest_artifact_mismatch` and publishes nothing.

## 4. No byte is copied

The shared DATA bucket **is** the existing central bucket
(`kogane-raw-evidence`), and `packages/collection` stores objects at exactly
the key the ingest registration uses (`objects/<2 hex>/<sha256>`), with the
same digest, size and content type. Registration therefore _adopts_ the
objects: `adoptStoredObject`
(`packages/application/src/ingest/objects.ts`) heads the key, verifies size,
digest and metadata, and writes the `raw_objects` row. It has no write path at
all — an object that is absent, the wrong size or the wrong digest is refused
(G1-15). The collection contract's bucket interface has no copy operation, so
there is none to call.

`services/processor/test/collection.test.ts` asserts this by
comparing the bucket's put log before and after registration.

## 5. Stage records

`collection_runs` and `collection_run_stages` (migration
`0039_collection_runs.sql`) hold the per-run record, in the vocabulary of
`contracts/stages.json`: `persisted → registered → parsed → adopted →
projected`, each with a state of `pending | completed | retryable | blocked`.

- `collection_runs` is append-only by trigger. Its identity columns never
  change; `blocked_code`, the `fetch_runs` / `acquisition_sessions` links and
  `registered_at` are write-once. A registered run is never re-pointed.
- `collection_run_stages` is append-only in the strict sense: one row per
  attempt, never updated, so a failed attempt is never rewritten into a
  success and what was tried survives. The current state of a stage is its
  newest row.
- An unvalidated terminal has **no** `provider_outcome` and no
  `coverage_status`. Its corruption is not evidence about what the provider
  returned.
- `collection_scan_state` is operational: resetting it re-walks the prefix
  rather than losing anything.

`completed` is refused for the four reasons that are never completion
(`queued`, `building`, `flag_off`, `no_processor`) by the shared stage
contract in `packages/collection/src/stages.ts`, before this table is reached.

## 6. Lanes

`runScheduled` in `src/worker.ts`, in order:

```text
observation_sweep → collection_scan → identity_sweep → balance_projection
  → reconciliation_sweep → card_settlement_sweep → purchase_recognition
  → reward_claims_sweep → reward_read_projection → report_job
  → operation_dispatch → decision_outbox
```

`card_settlement_sweep` shares `RECONCILIATION_ENABLED` with
`reconciliation_sweep` and used to run inside it, its counts nested in that
lane's log line as `cardSettlements`. It is its own lane now, with its own
`card_settlement_sweep` log line, `card_settlement_sweep_failed` event and tick
record ([card-settlements.md](card-settlements.md)), so a failure of either
sweep no longer hides the other's counts.

`purchase_recognition` runs only while `PURCHASE_RECOGNITION_ENABLED` is `"1"`
or `"true"` (`"true"` in production since 2026-09-24); it turns adopted
Vpass/MyJCB usage rows into purchase and refund events with rule decisions,
then writes the pending-to-posted candidates of the groups it read and merges
only the pairs a provider itself linked, bounded per tick
([economic-events.md](economic-events.md#card-purchase-recognition)). A
reviewed merge or split is the change lifecycle's commit, not this lane's.

`observation_sweep` executes at most 12 incremental, 28 repair and 8 replay
jobs a tick, and `identity_sweep` takes up to 40 parse runs, the incremental
and repair budgets together, so a re-parse is identified on the tick that
published it unless the sweep's 200-observation cap or an older backlog defers
it to the next ticks; the repair budget sets how fast a parser version bump drains
([observation-lanes.md](observation-lanes.md#repair-budget-and-drain-rate)).

`collection_scan` sits after the parse sweep and before identity so a run
found this tick can reach identity and parsing on the same tick.
`operation_dispatch` sits before `decision_outbox`, which stays last, after
the projections a decision may have invalidated. Each lane is isolated: a
failure is logged as its own event and stops nothing else. Both new lanes are
always wired, like `balance_projection`: while their flags are off each logs
one line per tick — `{"event":"collection_scan","enabled":false,"status":"skipped",…}`,
`{"event":"operation_dispatch","enabled":false,"status":"skipped",…}` — and
touches neither R2 nor any table it owns, so an operator can see from the log
that the lane exists and is off ([observation-lanes.md](observation-lanes.md));
the one row `operation_dispatch` writes then is its `skipped-by-flag` tick
(§6.1).

### 6.1 Tick records

Most lanes keep no state of their own, so until migration 0049 the only trace
of a tick was its log line, and "did `purchase_recognition` run?" could only be
answered from Workers Logs. `runScheduled` now also writes one row per tick of
each such lane to `processor_lane_ticks` (`src/lane-ticks.ts`,
`packages/storage-d1/src/core/lane-ticks.ts`):

| Lane                    | Counts recorded                                                                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `identity_sweep`        | `processedRuns`, `identifiedRuns`, `identifiedObservations`                                                                                                                                      |
| `reconciliation_sweep`  | `slices`, `scanned`, `groups`, `groupsSkipped`, `groupsDeferred`, `proposed`, `known`, `written`, `failed`, `autoAccepted`                                                                       |
| `card_settlement_sweep` | `scanned`, `proposed`, `written`                                                                                                                                                                 |
| `purchase_recognition`  | the whole log line: `scanned`, `recognized`, `revised`, `reanchored`, `retired`, `skipped` (per closed exclusion code), `conflicts`, `failed`, `deferred`, `proposed`, `merged`, `groupsSkipped` |
| `reward_claims_sweep`   | `scanned`, `promoted`, `skipped` (not the cursor or the release name)                                                                                                                            |
| `operation_dispatch`    | `claimed`, `dispatched`, `retried`, `failed`, `awaiting`                                                                                                                                         |
| `decision_outbox`       | `claimed`, `processed`, `failed`, `waiting`, `blocked`, `published` (not the open-ended `outcomes` map)                                                                                          |

Not recorded, because they already keep their own record: `observation_sweep`
(`observation_lane_state`), `collection_scan` (`collection_scan_state`),
`balance_projection` and `reward_read_projection` (their build records and
READ pointers), and `report_job` (its runs and report events).

Each row carries the lane, `started_at_ms` and `finished_at_ms`, an `outcome`,
an `error_code` and `counts_json`:

- `ran` — the stage returned; `counts_json` holds the fields above, by name.
- `skipped-by-flag` — the lane's flag is off, so the stage was not called
  (or, for the always-wired `operation_dispatch`, it reported
  `enabled: false`); the log still gets no line, and `counts_json` is `{}`.
- `failed` — the stage threw; `error_code` is the same safe code the
  `<lane>_failed` log line carries (a pipeline code or the error's constructor
  name, `unknown` for anything that is not a code) and `counts_json` is `{}`.

A lane whose stage is not wired at all records nothing. Only counts, flags and
the closed exclusion codes of `purchase_recognition` are copied, by field
name; the 0049 trigger refuses any text value, so no amount, key, account label
or provider wording can be stored. A tick killed mid-lane (a Worker limit)
leaves no row for that lane, and the gap is the signal.

The table is bounded: each insert deletes that lane's rows beyond the latest
288 (one day of the five-minute cron) in the same batch. Rows are never
updated. It is `operational-mutable` in the CORE ledger and outside the
source-revision ledger, so recording a tick never makes a projection stale. A
row that cannot be written is logged as
`{"event":"lane_tick_record_failed","lane":…,"code":…}` and changes nothing
the lane did. `GET /status` (`mise run //services/processor:ops status`) and
`GET /internal/health` (§13) report the latest tick of each lane as
`laneTicks`; reading them is in [operations.md](operations.md#lane-tick-records).

## 7. Operations dispatch

The App accepts an operations-API request, stores it and answers 202;
notifying the executor is a separate step that may be lost, so the request
stays `dispatch_pending` until someone takes it (02 §5,
[ops-api.md](ops-api.md)). `operation_dispatch` is that someone.

| Kind                                       | What the Processor does                                                             | What it completes                             |
| ------------------------------------------ | ----------------------------------------------------------------------------------- | --------------------------------------------- |
| `import`                                   | `registerTerminal` in process                                                       | `registered`, and only with the CORE evidence |
| `replay`                                   | starts the `planned` replay plan the acceptance created                             | nothing                                       |
| `projection`                               | records the handover; the projection lane rebuilds                                  | nothing                                       |
| `collection`, unattended `session-refresh` | records `dispatch_pending` with `awaiting_collector_dispatch` and backs off an hour | nothing                                       |

**Enqueuing is never completing.** A queued replay, a projection that will run
next tick and a collector call that does not exist yet all leave the operation
short of `completed` (`contracts/stages.json` `neverCompleteOn`). The Service
Binding call to a collector is U09's; until it exists the request is visible
and pending rather than silently completed or dropped.

A failed dispatch never deletes the request. An import whose terminal is not
in the bucket is retried, not failed: the collector may still be running.

## 8. Retired legacy import

The importer and ingest Workers, old Queues and per-source buckets have been
removed. The Processor registers shared terminals directly through the
application layer. Original evidence and repair outcomes are preserved in
[the retirement record](legacy-retirement.md); there is no legacy adapter tree
or old-bucket binding in the Processor.

## 9. Flags

| Flag                       | Default   | What it gates                                         |
| -------------------------- | --------- | ----------------------------------------------------- |
| `SHARED_R2_INGEST_ENABLED` | `"false"` | the Queue consumer **and** the `collection_scan` lane |
| `OPS_DISPATCH_ENABLED`     | `"false"` | the `operation_dispatch` lane                         |

Only `"1"` and `"true"` enable. An absent, empty or misspelled value leaves
the Processor doing what it does today. A flag that is off is not a completed
scan: nothing is recorded and the scan cursor does not move.

Supporting vars: `COLLECTION_DATA_BUCKET` (`kogane-raw-evidence`),
`COLLECTION_ACCOUNT_ID` — a notification for another bucket or account is
refused — and `COLLECTION_INGEST_CLIENT` (`processor-shared-r2`), the ingest
client the Processor registers as.

## 10. Resources to create before the flag is turned on

The Queue **does not exist yet**. `infra/resources.md` says so per queue
("to be created by the first deploy"), and the first deploy that carries
`services/processor/wrangler.jsonc` creates it:

1. `kogane-collection-terminals` and `kogane-collection-terminals-dlq`;
2. an R2 event-notification rule on `kogane-raw-evidence` for object creation,
   prefix `runs/`, suffix `/terminal.json`, delivering to
   `kogane-collection-terminals`;
3. CORE rows for the ingest client `processor-shared-r2`, the shared-R2
   producers `collector-<collector id>` and one route per source. They are
   declared in `config/ingest-clients.json` and rendered by
   `mise run bootstrap:ingest-clients` to `infra/bootstrap/ingest-clients.sql`
   (committed; a test fails when it is stale). The file is idempotent —
   insert-if-absent for every row, `active` converged — so it is applied, and
   re-applied after any change to the declaration, with:

   ```sh
   wrangler d1 execute kogane-raw-evidence --remote --file infra/bootstrap/ingest-clients.sql --config services/processor/wrangler.jsonc
   ```

   It is not a migration: it creates no schema, and it is applied by an
   operator, not by CD. No token is generated — the client registers in
   process through `directRegistrationPort` and cannot authenticate to the
   retired HTTP ingest Worker. To retire a route, set its
   `active` to `false`, re-render and re-apply; the Processor then answers
   `retryable` with `inactive_ingest_route` for that source.

Until (1) exists, the consumer has nothing to consume; until (3) exists,
registration answers `retryable` with `inactive_ingest_client` and records it
as a stage rather than blocking the run.

## 11. Deploy order and rollback

GitHub Actions applies CORE then READ migrations and deploys consumers before
collectors. The current collection Queue, notification rule and 13 registration
routes are configured. Deploying a Worker does not invoke a collector.

Turning a lane flag off pauses its work; terminals and recorded progress remain.
Projections use READ only. Select only code compatible with the current schema
and retained resources for rollback. See [rollout.md](rollout.md) and
[legacy-retirement.md](legacy-retirement.md).

## 12. Verified locally / not verified

Verified with synthetic data only
(`services/processor/test/collection.test.ts`,
`registration-budget.test.ts`, `invocation-probe.test.ts`,
`operation-dispatch.test.ts`, `lanes.test.ts`;
`packages/storage-d1/test/migrations.test.ts`;
`scripts/config-bootstrap.test.ts`, `scripts/service-binding-chain.test.ts`):
the acceptance rows of §3 and §4, the budget-bounded resume and every
invocation's operation count at, below and above the one-invocation edge,
the failure audits at the budget edge, the previous release's unfinished
runs, failed and mapped-source terminals, per-unit runs sharing one
acquisition session, the lane order with flags off and on, the metered
bindings against Miniflare and (in `services/collector-st-george`'s
worker test) real workerd D1 and R2, the append-only triggers, the
bootstrap SQL applied twice to a fresh CORE, and `wrangler deploy --dry-run`.

Production deployment, resource identity and migration verification are recorded
in [legacy-retirement.md](legacy-retirement.md). These checks do not establish
every source's next scheduled run or the cost of every future scan.

## 13. Internal health and the release postcheck

This Worker is published on **no hostname at all**: `workers_dev: false`, no
routes, no custom domain. That is deliberate (every route it has is an internal
service-binding route), and it meant CD could not check it — a broken Processor
uploaded and the release reported success, because the postcheck only read the
ingest Worker's public `/health` (plan 11 §6).

`GET /internal/health` closes that (`src/internal-health.ts`). It is reachable
the same way everything else here is: the App authenticates the caller through
Cloudflare Access and asks over the `PIPELINE` service binding
([ops-api.md](ops-api.md#get-apiopsv1health--the-release-postchecks-route)).
A caller that did not arrive that way is **refused, not answered**: the route
requires the `x-kogane-internal-caller` header the calling Worker sets and
refuses any request carrying `CF-Connecting-IP`, which Cloudflare's edge
attaches to every request that entered from the internet.

What the answer carries — counts, identifiers, file names, flags and ages, and
never a value:

| Field              | What it is                                                                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ok`               | true with HTTP 200; false with HTTP 503                                                                                                                  |
| `releaseSha`       | the commit the deploy stamped into `RELEASE_SHA`, or `""` outside a release                                                                              |
| `core`, `read`     | `SELECT 1` and the applied migration file names of each database                                                                                         |
| `data`, `evidence` | one R2 `head` of the fixed key `health/release-marker` through each binding                                                                              |
| `bindings`         | which of `DB`, `READ`, `EVIDENCE`, `DATA` this deployment actually has                                                                                   |
| `flags`            | the declared value of every lane flag of §9                                                                                                              |
| `lanes`            | `observation_lane_state`: how long ago each lane last swept                                                                                              |
| `laneTicks`        | the latest `processor_lane_ticks` row of each lane (§6.1): outcome, code, age, counts                                                                    |
| `collectionScan`   | the bounded scan's cursor: how stale it is, whether it is mid-cycle, pages and cycles                                                                    |
| `registration`     | the operation budget and the documented limits (§3.3); terminals still unregistered, how many of them are staged (`pending`), and the oldest pending age |
| `readPointer`      | the READ active pointer: present or not, and how long ago it was switched                                                                                |

The queue _consumer_ cannot be introspected from inside the isolate — it is a
property of the configuration, not of the runtime — so what is asserted is the
binding set instead; a deploy that lost a binding is a broken deploy. Nothing
in this route writes, runs a lane, moves a cursor or contacts a provider.
`laneTicks` is diagnosis, not health: a lane whose latest tick `failed` does
not turn the answer into a 503, and before migration 0049 the list is empty.

## 14. Seams for later work items

- **U09** (collectors to shared R2): the producer ids in
  `config/ingest-clients.json` must be what each collector writes as
  `producer`; new collector ids go into `COLLECTOR_SOURCE_IDS` with a route;
  and the Service Binding the `collection` dispatch branch is waiting for
  (`awaiting_collector_dispatch`).
- **U11** (READ projection): the `projected` stage of `collection_runs` and of
  `ops_request_stages` is unwritten; the projection publisher completes it.
- **U15** completed the legacy resource and source retirement; historical
  originals remain recoverable through the central archive mapping.
