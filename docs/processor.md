# Processor: shared-R2 terminals, registration, lanes and operations dispatch

Unified plan U08 (chapters 02 §1-3 and §5, 03 §4-§7, 05 §6, 15 §2). What the
Processor (`services/processor`, Worker `kogane-observation-pipeline`)
does with a collection run that a collector persisted into the shared DATA
bucket, how it stays exactly-once, what it records per stage, and what it took
over from `services/collector-r2-importer`.

Everything new here is behind a flag that is **off**. Merged is not enabled.

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

| Path                        | Trigger                                                              | Boundedness                                         |
| --------------------------- | -------------------------------------------------------------------- | --------------------------------------------------- |
| Queue consumer              | R2 event notification on the DATA bucket, `runs/` + `/terminal.json` | one batch of at most 10 messages                    |
| `collection_scan` cron lane | every 5 minutes                                                      | one R2 list page (25 keys), at most 5 registrations |

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

| Outcome of `handleTerminalNotification`                        | Message   | Why                                                                                      |
| -------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------- |
| `flag_off`                                                     | **acked** | the flag is off; the message is logged and dropped, never retried into the DLQ           |
| `invalid` (account, bucket, shape), `ignored` (not a terminal) | acked     | not a fact about a terminal in the DATA bucket                                           |
| `registered`, `already_registered`, `blocked`, `missing`       | acked     | done, or nothing further a retry could change                                            |
| `pending` (artifact budget spent)                              | acked     | the run is unsealed and the scan continues it; retrying would push large runs to the DLQ |
| `retryable` (ingest client or route absent)                    | retried   | a configuration fix will make it succeed; after `max_retries` it lands in the DLQ        |
| the handler threw                                              | retried   | a CORE or R2 failure; the log carries a safe code only                                   |

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
revision and the old registration is kept.

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
| Artifact budget spent                                                                                                    | pending, **unsealed**                              | `registered` pending; the next call catalogues only what is missing (G1-10)                     |

A resumed registration reads what the run already has in `fetch_artifacts`
and skips it, so the budget (500 artifacts per call) is spent on new work and
a run of any size converges over as many ticks as it needs. Every port
operation is idempotent on its own key, so a call that re-runs one anyway is
a no-op rather than a conflict.

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
  → reconciliation_sweep → reward_claims_sweep → report_job
  → operation_dispatch → decision_outbox
```

`collection_scan` sits after the parse sweep and before identity so a run
found this tick can reach identity and parsing on the same tick.
`operation_dispatch` sits before `decision_outbox`, which stays last, after
the projections a decision may have invalidated. Each lane is isolated: a
failure is logged as its own event and stops nothing else. Both new lanes are
always wired, like `balance_projection`: while their flags are off each logs
one line per tick — `{"event":"collection_scan","enabled":false,"status":"skipped",…}`,
`{"event":"operation_dispatch","enabled":false,"status":"skipped",…}` — and
touches neither R2 nor CORE, so an operator can see from the log that the
lane exists and is off ([observation-lanes.md](observation-lanes.md)).

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

## 8. Legacy import

`services/collector-r2-importer` keeps running unchanged until U15. U08 moved
its source-agnostic half into `src/legacy-import/`:

- `reconciler.ts` — the Queue message schema, the source table
  (`RECONCILER_SOURCES`) and the bounded repair walk;
- `adapters/contract.ts` — the import contract, now generic over the Worker
  environment;
- `adapters/registry.ts` — route indexing, one import step, the Queue
  continuation mapping, the registry consistency check;
- `error.ts` — `ImportError`.

The importer imports them back through re-export shims at the old paths, so
there is one implementation rather than two, and its wrangler config, routes,
queue and behaviour are untouched. Its twelve per-source adapters stay with it
because each binds that Worker's own R2 bindings and secrets; giving the
Processor twelve legacy bucket bindings is exactly what plan 02 §1 says not to
do.

`legacy-import/index.ts` matches the `LEGACY_ADAPTERS` of
`packages/collection` against `RECONCILER_SOURCES` rather than describing the
old buckets a second time: a key must satisfy both the reconciler's terminal
pattern and the adapter's matcher. **Only vpass is covered.** The other
eleven legacy sources — `global-pass`, `mobile-suica`, `moneyforward`,
`myjcb`, `sbi-securities`, `sbi-shinsei`, `sbi-vc-trade`, `smbc-direct`,
`sony-bank`, `v-point`, `v-point-pay-email` — are listed by
`uncoveredLegacySources()`, and **their legacy buckets stay importer-only
until U15**: a run that exists only in one of those buckets is imported by
`services/collector-r2-importer` exactly as today, and the Processor neither
reads those buckets nor re-persists their runs. Each needs its own reviewed
mapping from its own manifest shape, and a guessed one would make a terminal
claim something the collector never said. That is also the path a late
notification takes after the old Workers stop (G5-18): the key is still
recognised and its bucket named, so unprocessed work is recoverable.

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
   legacy ingest Worker, which is intended. To retire a route, set its
   `active` to `false`, re-render and re-apply; the Processor then answers
   `retryable` with `inactive_ingest_route` for that source.

Until (1) exists, the consumer has nothing to consume; until (3) exists,
registration answers `retryable` with `inactive_ingest_client` and records it
as a stage rather than blocking the run.

## 11. Deploy order and rollback

1. **Schema.** Apply CORE `0039_collection_runs.sql`. Additive and inert: no
   existing table, view, trigger or row changes, and a Worker that predates it
   never reads or writes what it adds.
2. **Processor.** Deploy `kogane-observation-pipeline` with the new consumer
   and lanes, flags still off. This creates the queue. The consumer must exist
   **before** any collector is switched to the shared layout (U09): the plan's
   rule is consumer before producer (13 §U08→U09).
3. **Queue and notification rule**, if the deploy did not create them.
4. **Ingest client, producers and routes**: apply
   `infra/bootstrap/ingest-clients.sql` (§10, step 3). Safe to apply before
   any collector is switched, and safe to re-apply.
5. **Turn `SHARED_R2_INGEST_ENABLED` on.** With no collector writing the
   shared layout yet, the scan lists nothing and the consumer receives
   nothing; this is the safe way to prove the lane runs.
6. **U09** switches one collector at a time.

`OPS_DISPATCH_ENABLED` is independent and can be turned on once the
operations API (U06) is enabled on the App.

**Rollback:** set the flag back to `"false"` (a var change plus a redeploy),
or redeploy the previous Worker revision. Both are immediate and lose nothing:
the terminals stay in R2, the `collection_runs` rows stay, and re-enabling
continues from where the scan stopped. The migration is **not** rolled back —
it is additive, and rolling it back would drop the record of which runs were
already registered.

## 12. Verified locally / not verified

Verified with synthetic data only
(`services/processor/test/collection.test.ts`,
`operation-dispatch.test.ts`, `legacy-import.test.ts`, `lanes.test.ts`;
`packages/storage-d1/test/migrations.test.ts`;
`scripts/config-bootstrap.test.ts`): the acceptance rows of §3 and §4, the
budget-bounded resume, failed and mapped-source terminals, per-unit runs
sharing one acquisition session, the lane order with flags off and on, the
append-only triggers, the importer's reconcile logic through its shims, the
bootstrap SQL applied twice to a fresh CORE, and `wrangler deploy --dry-run`.

Not verified against a real collector: the producer ids in
`config/ingest-clients.json` follow the `collector-<collector id>` convention
U09 states; a collector that names itself differently answers
`inactive_ingest_route` (retryable) until the declaration is corrected.

Not verified: the queue and the R2 event-notification rule (they do not exist,
and the notification body is checked against the documented shape rather than
a live delivery), the CPU and D1 cost of a scan page on a real bucket, and
anything about production. No production resource was created, read or
changed.

## 13. Seams for later work items

- **U09** (collectors to shared R2): the producer ids in
  `config/ingest-clients.json` must be what each collector writes as
  `producer`; new collector ids go into `COLLECTOR_SOURCE_IDS` with a route;
  and the Service Binding the `collection` dispatch branch is waiting for
  (`awaiting_collector_dispatch`).
- **U11** (READ projection): the `projected` stage of `collection_runs` and of
  `ops_request_stages` is unwritten; the projection publisher completes it.
- **U15** (retiring the old Workers): the importer's shims and its per-source
  adapters are what is left to remove; `uncoveredLegacySources()` is the list
  of sources still reachable only through it.
