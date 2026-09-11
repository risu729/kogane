# Legacy path retirement: checklist and runbook

Unified plan **U15** (chapter 13 §U15 and §3, 15 §5, 03 §7, 11 §7); acceptance
tests **G0-10**, **G0-12**, **G5-18**.

Five things outlive the change programme: the legacy ingest Worker
`kogane-ingest`, the legacy importer `kogane-collector-r2-importer`, the twelve
per-source R2 buckets, the CORE projection tables of migration `0030`, and one
live Worker with no configuration in this repository. None of them is deleted
here, and **no command on this page has been run**. Retiring a live resource is
an operational decision that follows live verification (15 §5), so what U15
produced is this: for each one, the evidence that has to exist first, the exact
query or command that produces that evidence, and the order the steps go in.

Read it together with:

- [infra/protection.md](../infra/protection.md) — what must never be deleted,
  and the CORE backup/restore runbook the "backup confirmed" rows point at;
- [docs/processor.md](processor.md) — the shared-R2 path that replaces the
  legacy one, and the eleven sources whose legacy buckets stay importer-only;
- [docs/rollout.md](rollout.md) — the flags, their order and their rollback;
- [infra/resources.md](../infra/resources.md) — the generated ledger; every
  directory below carries its disposition there.

## 0. The rules this page does not bend

1. **Nothing is deleted because nothing imports it.** A collector is started by
   a cron, a Queue or an Email route, none of which is an import (07 §6,
   G0-12). The ledger, not the import graph, decides what is live.
2. **Stopping a Worker, retiring a Queue and deleting a bucket are three
   steps**, taken in that order, each with its own evidence (15 §5).
3. **Bytes that exist only in a legacy bucket are verified or kept.** Age alone
   never deletes an object a retry or an in-flight run may still reference
   (03 §7, 13 §3, G0-10).
4. **The retention window is not decided in this repository.** Every row seeded
   into `retention_classes` carries `"legalObligation": "undecided"`
   ([operations.md §3](operations.md#3-retention-classes)). A concrete window
   has to be written down by the owner before any of the deletions below, and
   the checklist rows say "recorded", not "elapsed", because this page cannot
   know it.
5. **A code rollback does not undo a deletion.** Once a Worker is deleted or a
   bucket is emptied, the release that preceded it is no longer a rollback
   target for that resource (11 §7). Each section names what stops being
   reversible.

## 1. What is still deployed, and what replaced it

| Legacy thing                                 | What now does the work                                                              | Still needed because                                                                         |
| -------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `kogane-ingest` (`services/raw-evidence`)    | `packages/storage-d1` + `packages/application`, in process in the Processor         | The importer still calls it over its service binding; twelve sources still import through it |
| `kogane-collector-r2-importer`               | The Processor's `legacy-import` adapters and the shared-R2 registration             | Only `vpass` has a reviewed shared-R2 mapping; the other eleven buckets are importer-only    |
| The twelve per-source buckets                | The shared DATA bucket `kogane-raw-evidence`, key layout `objects/<2 hex>/<sha256>` | They are the only copy of everything collected before the switch                             |
| CORE `0030` projection tables                | The READ database `kogane-read` when `READ_PROJECTION_ENABLED` is on                | The flag is off; with it off the CORE tables are the live projection                         |
| `kogane-globalpass-container-probe-20260827` | Nothing; it is a finished probe                                                     | It has no configuration here, so nothing in this repository can prove what it is             |

`services/raw-evidence` and `services/collector-r2-importer` keep their
`retire-after-verification` disposition in `scripts/resource-ledger.ts`, which
names this page. The disposition is the ledger's record that the code is
deliberately still here.

## 2. Evidence every retirement needs

Four rows, filled in per resource in the sections that follow.

| Row                  | What counts as evidence                                                                                                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **References zero**  | No tracked code, Wrangler configuration, Queue consumer/producer, cron, Email route or CORE route still names it                                                                          |
| **Unprocessed zero** | No message in flight, no cursor mid-scan, no CORE row waiting for it, and a full scan that finds nothing new                                                                              |
| **Retention window** | A written window for the affected retention class, and the date it started, recorded by the owner                                                                                         |
| **Backup confirmed** | For CORE: a `wrangler d1 export` file taken after the last write, plus a Time Travel bookmark. For R2: a verified second copy of every object, or an explicit decision to keep the bucket |

The repository half of "references zero" is the same three commands every time,
run from the repository root:

```sh
# 1. Every tracked mention of the name, in code, config, workflows and docs.
git grep -n -- '<resource-name>'

# 2. The generated ledger's own view: bindings, crons, queues, email handlers.
grep -n -- '<resource-name>' infra/resources.md

# 3. The deploy ledger CD works from.
grep -n -- '<resource-name>' infra/deploy-order.json
```

A mention left in `docs/` or in an applied migration's comment is not a
reference — applied migrations are immutable, comments included. A mention in a
`wrangler*.jsonc`, in `infra/deploy-order.json` or in `infra/workers-ci.json`
is.

The account half needs the Cloudflare token of the `production` environment and
is read-only:

```sh
wrangler deployments list --name <worker>          # when it was last deployed
wrangler tail <worker> --format json               # whether anything still calls it
wrangler queues list                               # the queues that exist
wrangler queues info <queue>                       # backlog and dead letters
wrangler r2 bucket list
wrangler r2 bucket info <bucket>                   # object count and size
wrangler r2 bucket notification list <bucket>      # event rules pointing at a queue
```

`wrangler` has **no** `r2 object list`: a key-level inventory of a bucket comes
from the importer's own paging scan (§5), not from the CLI.

## 3. `kogane-ingest` (`services/raw-evidence`)

The legacy central ingest API. `POST /v1/runs` accepts one run descriptor and
writes CORE rows and DATA objects; `GET /health` is its only other route. Its
SQL and registration use cases moved to `packages/storage-d1` and
`packages/application` in U05 (decision D2); what is deployed is a thin adapter
over them.

### 3.1 Who still calls it

Exactly one caller, and it is not a collector:

- `services/collector-r2-importer/wrangler.jsonc` binds it as the service
  `RAW_EVIDENCE` → `kogane-ingest`.

The twelve collectors bind **the importer** (`RAW_EVIDENCE_IMPORTER` →
`kogane-collector-r2-importer`), not the ingest Worker, so the call chain is
`collector → importer → ingest`. `kogane-ingest` therefore cannot be retired
before the importer (§4), and the two are one decision taken in that order.

`workers_dev` is `true` on this config, so it also has a `workers.dev`
hostname. Whether anything reaches it that way is not knowable from the
repository; `wrangler tail` over a full collection cycle is the only check.

### 3.2 References zero

```sh
git grep -n -- 'kogane-ingest'
git grep -n -- 'RAW_EVIDENCE_TOKEN'      # per-source tokens the importer holds
```

Expected to remain until the importer goes: the service binding above, the
`ingest` entry of `infra/deploy-order.json`, the ledger rows, and this page.

In CORE, the legacy path is identified by its ingest client ids. Thirteen were
created by migrations — `collector-r2-global-pass`, `collector-r2-mobile-suica`,
`collector-r2-moneyforward`, `collector-r2-myjcb`, `collector-r2-sbi`,
`collector-r2-sbi-shinsei`, `collector-r2-sbi-vc`, `collector-r2-smbc-direct`,
`collector-r2-sony-bank`, `collector-r2-v-point`,
`collector-r2-v-point-pay-email`, `collector-r2-vpass` and `local-backfill` —
against the one the shared path uses, `processor-shared-r2`.

```sh
# Who last wrote through the legacy API, per client and per source.
wrangler d1 execute kogane-raw-evidence --remote \
  --config services/raw-evidence/wrangler.jsonc \
  --command "SELECT ingest_client_id, source_id, COUNT(*) AS attempts,
                    MAX(completed_at_ms) AS last_ms
             FROM ingestion_attempts
             GROUP BY ingest_client_id, source_id
             ORDER BY last_ms DESC;"
```

**References zero** for the ingest Worker means: for every source, the most
recent `ingestion_attempts` row is `processor-shared-r2`, and no
`collector-r2-*` client has written for longer than one full collection cycle
of its slowest source (the weekly importer cron makes that at least eight days).

Retiring a route rather than the Worker is a CORE change, not a deploy: set the
route's `active` to `false` in `config/ingest-clients.json`, re-render with
`mise run bootstrap:ingest-clients`, and apply
`infra/bootstrap/ingest-clients.sql`. Legacy client rows created by migrations
are deactivated the same way — with an `UPDATE ingest_clients SET active=0`,
never a `DELETE`; `ingest_client_producers` and `ingest_client_routes` reference
them `ON DELETE RESTRICT`, and `ingestion_attempts` names them forever.

### 3.3 Unprocessed zero

```sh
# a) Runs the legacy path opened and never sealed. Must be empty.
wrangler d1 execute kogane-raw-evidence --remote \
  --config services/raw-evidence/wrangler.jsonc \
  --command "SELECT r.source_id, r.first_recorded_by_client_id,
                    COUNT(*) AS unsealed
             FROM fetch_runs r
             LEFT JOIN fetch_run_seals s ON s.fetch_run_id = r.id
             WHERE s.fetch_run_id IS NULL
             GROUP BY r.source_id, r.first_recorded_by_client_id;"

# b) Inventories declared but not completed: a run whose artifacts never all
#    arrived is exactly the work a stopped ingest Worker would strand.
#    (The count is repeated instead of reusing the alias: SQLite does not
#    resolve a result alias inside WHERE.)
wrangler d1 execute kogane-raw-evidence --remote \
  --config services/raw-evidence/wrangler.jsonc \
  --command "SELECT i.id, i.fetch_run_id, i.expected_artifact_count,
                    (SELECT COUNT(*) FROM run_inventory_items t
                      WHERE t.inventory_id = i.id) AS items
             FROM run_inventories i
             WHERE (SELECT COUNT(*) FROM run_inventory_items t
                     WHERE t.inventory_id = i.id) <> i.expected_artifact_count;"

# c) Attempts that ended incomplete or failed, newest first.
wrangler d1 execute kogane-raw-evidence --remote \
  --config services/raw-evidence/wrangler.jsonc \
  --command "SELECT source_id, ingest_client_id, outcome, error_code,
                    COUNT(*) AS n, MAX(completed_at_ms) AS last_ms
             FROM ingestion_attempts
             WHERE outcome <> 'complete'
             GROUP BY source_id, ingest_client_id, outcome, error_code
             ORDER BY last_ms DESC;"
```

An unsealed run is not automatically a blocker — a run can be legitimately
abandoned — but every one of them has to be classified before the Worker stops,
because afterwards there is no path that can finish it.

The mirror-image check on the new side is that every terminal the shared path
wrote is registered:

```sh
# Terminals seen in the shared bucket that never became CORE rows. Each row
# carries the reason in blocked_code; an empty result is the goal.
wrangler d1 execute kogane-raw-evidence --remote \
  --config services/processor/wrangler.jsonc \
  --command "SELECT source, run_id, terminal_key, blocked_code, first_seen_at
             FROM collection_runs
             WHERE registered_at IS NULL
             ORDER BY first_seen_at;"

# And the scan's own position, so that 'nothing pending' is not just 'the scan
# never ran'.
wrangler d1 execute kogane-raw-evidence --remote \
  --config services/processor/wrangler.jsonc \
  --command "SELECT * FROM collection_scan_state;"
```

### 3.4 Retention window and backup

The evidence the ingest Worker wrote is `financial-evidence`; it is **not**
deleted by retiring the Worker, and nothing in §3 touches a row or an object.
What needs a recorded window is the ingest **tokens**: plan 12 §1 puts the
internal legacy ingest token in the "revoke after the migration completes" row,
per caller. Record which token was revoked, for which caller, and when.

Take the CORE export and the Time Travel bookmark from
[infra/protection.md §3.1](../infra/protection.md#31-before-applying-a-migration)
before the first deactivation, because deactivating a client changes rows.

### 3.5 The retirement itself, in order

1. Every source runs shared (`COLLECTION_TARGET=shared`, U09) and
   `SHARED_R2_INGEST_ENABLED` has been on long enough for §3.3 to be empty.
2. Deactivate the legacy routes and clients (§3.2). Collection keeps working;
   a collector still in legacy mode now fails loudly instead of writing.
3. Leave it deactivated for one full retention/observation window. This is the
   step that catches a late notification (§7).
4. Remove the `RAW_EVIDENCE` service binding from the importer — or retire the
   importer first (§4), which removes the last caller outright.
5. Remove the `ingest` entry from `infra/deploy-order.json`, its
   `infra/workers-ci.json` entry and `services/raw-evidence/tasks.toml`, and
   delete the directory. CD stops deploying it; the Worker is still live.
6. `wrangler delete kogane-ingest` (the Worker name is the positional argument;
   `--dry-run` first shows what would go). **Irreversible from this
   repository** once step 5 landed: the previous release can no longer
   redeploy a directory that is gone. To keep a rollback target, do step 6
   before step 5 and keep the directory for one more release.

## 4. `kogane-collector-r2-importer`

The legacy collector importer. It binds all twelve per-source buckets, exposes
`POST /v1/<source>/import-run` and `POST /v1/<source>/backfill-page` to the
collectors over service bindings, consumes and produces the Queue
`kogane-r2-outbox-reconciler` (dead-letter `kogane-r2-outbox-reconciler-dlq`),
and runs a weekly repair cron `23 19 * * SUN` that seeds one repair message per
reconciler source. Its queue consumer and adapters were absorbed by the
Processor in U08; the Worker keeps running (decision D2).

### 4.1 References zero

```sh
git grep -n -- 'kogane-collector-r2-importer'
git grep -n -- 'RAW_EVIDENCE_IMPORTER'
git grep -n -- 'kogane-r2-outbox-reconciler'
```

Eleven collectors bind it today (`poc/*-worker`, `poc/vpass-json`); the twelfth
source, `v-point-pay-email`, has no collector-side backfill route and is reached
only by the weekly repair pass. References reach zero when every collector's
`COLLECTION_TARGET` is `shared`, the `RAW_EVIDENCE_IMPORTER` binding is gone
from each collector configuration, and the Processor covers each source's legacy
manifest shape — `uncoveredLegacySources()` in
`services/processor/src/legacy-import` is the list that has to be empty, and
today it holds eleven of the twelve.

```sh
wrangler queues list
wrangler queues info kogane-r2-outbox-reconciler
wrangler queues info kogane-r2-outbox-reconciler-dlq
wrangler queues info kogane-vpass-raw-evidence-import   # the vpass collector's own
```

### 4.2 Unprocessed zero

Three independent things must be empty, and a Queue with a backlog is the one
that silently loses work when a consumer disappears.

```sh
# a) Queue backlog and dead letters: both zero, read twice a day apart.
wrangler queues info kogane-r2-outbox-reconciler
wrangler queues info kogane-r2-outbox-reconciler-dlq

# b) A full repair pass that imports nothing. Drive it from each collector's
#    admin route, which calls the importer over the service binding:
#      POST https://<collector-host>/backfill-raw-evidence?limit=1
#    and repeat until the response reports no next cursor. The pass is clean
#    when, over a complete cycle, importedRecordCount, deferredRecordCount and
#    failedRecordCount are all 0 and truncated is false.
#    `v-point-pay-email` has no such route: use one weekly cron firing and read
#    its reconciler log lines instead.

# c) Nothing new reached CORE through the importer during that pass.
wrangler d1 execute kogane-raw-evidence --remote \
  --config services/raw-evidence/wrangler.jsonc \
  --command "SELECT ingest_client_id, MAX(completed_at_ms) AS last_ms
             FROM ingestion_attempts
             WHERE ingest_client_id LIKE 'collector-r2-%'
             GROUP BY ingest_client_id;"
```

The importer never modifies or deletes a source object, so (b) can be repeated
as often as wanted; it is a read of the buckets plus idempotent writes to CORE.

### 4.3 Retention window and backup

The importer stores nothing of its own: its state is the Queue, the cursors the
collectors hold, and the CORE rows it wrote through the ingest Worker. The
window that matters is the one in §5, because the buckets it reads are the
thing with a retention decision.

### 4.4 The retirement itself, in order

1. `uncoveredLegacySources()` is empty, or the remaining sources are recorded
   as deliberately importer-only for longer.
2. Remove the `RAW_EVIDENCE_IMPORTER` binding from each collector, one source
   at a time, and re-deploy that collector. After each one, §4.2 (a) and (c)
   must stay empty for that source.
3. Pause the queue rather than deleting it, so a late producer is visible
   instead of silently dropped:
   `wrangler queues pause-delivery kogane-r2-outbox-reconciler`.
   Leave it paused for one observation window and read
   `wrangler queues info` again. A message that arrives while paused is exactly
   the G5-18 case: it is recoverable, and it is the signal not to continue.
4. Remove the cron by removing the Worker's `triggers`, or stop deploying it.
5. Remove its entries from `infra/deploy-order.json` and
   `infra/workers-ci.json`, drop `services/collector-r2-importer/tasks.toml`
   from `mise.toml`, and delete the directory. The twelve audit configurations
   under that directory go with it; they are local-only and deploy nothing.
6. `wrangler delete kogane-collector-r2-importer`, then
   `wrangler queues delete kogane-r2-outbox-reconciler` and its dead-letter
   queue. **Irreversible**: a Queue's messages are not recoverable after the
   delete, which is why step 3 pauses instead.

## 5. The twelve legacy per-source buckets

`kogane-globalpass-collector-poc`, `kogane-mobile-suica-collector-poc`,
`kogane-moneyforward-collector-poc`, `kogane-myjcb-collector-poc`,
`kogane-sbi-collector-poc`, `kogane-sbi-shinsei-collector-poc`,
`kogane-sbi-vc-trade-poc`, `kogane-smbc-direct-backfill-poc`,
`kogane-sony-bank-collector-poc`, `kogane-vpass-collector-poc`,
`kogane-vpoint-collector-poc`, `kogane-vpoint-pay-collector-poc`.

They are `P7` in [infra/protection.md](../infra/protection.md) and the subject
of acceptance test **G0-10**: an original that exists only in a legacy bucket is
not deleted before the copy is verified.

### 5.1 References zero

```sh
git grep -n -- 'collector-poc'
git grep -n -- 'kogane-sbi-vc-trade-poc'
git grep -n -- 'kogane-smbc-direct-backfill-poc'
wrangler r2 bucket list
wrangler r2 bucket notification list <bucket>
```

A bucket has zero references when no `wrangler*.jsonc` binds it (the collector's
own `SNAPSHOTS` binding and the importer's twelve are the ones to remove), no
event-notification rule points at a queue, and `infra/resources.md` lists no
reader for it. The collector that writes it must be in `shared` mode first:
while `COLLECTION_TARGET` is `legacy` the bucket is the run's only home.

### 5.2 Unprocessed zero, and the byte-level check (G0-10)

This is the expensive one, and there is no shortcut. Two questions have to be
answered per bucket, per object:

1. **Is this object already in the shared DATA bucket?** Every object CORE
   imported is stored content-addressed at `objects/<2 hex>/<sha256>` in
   `kogane-raw-evidence` (`blobKeyFor` in `packages/application/src/ingest`),
   and `raw_objects` records its `sha256`, `byte_size` and that key. So the
   question is whether the legacy object's sha256 has a `raw_objects` row — a
   digest comparison, never a key comparison.
2. **Is it referenced by something that still resolves?** An object in a legacy
   bucket with no `raw_objects` row was never imported, and is therefore the
   only copy that exists.

```sh
# Size of the problem, per bucket. Not an inventory: a count and a byte total.
wrangler r2 bucket info kogane-vpass-collector-poc
wrangler r2 bucket info kogane-raw-evidence

# What CORE holds: the total the central bucket should account for.
wrangler d1 execute kogane-raw-evidence --remote \
  --config services/raw-evidence/wrangler.jsonc \
  --command "SELECT COUNT(*) AS objects, SUM(byte_size) AS bytes
             FROM raw_objects;"

# Which object stores the artifacts still name. `container_name` is the bucket
# an artifact's storage metadata records; a legacy name here is a live
# reference, not history.
wrangler d1 execute kogane-raw-evidence --remote \
  --config services/raw-evidence/wrangler.jsonc \
  --command "SELECT storage_kind, container_name, COUNT(*) AS artifacts
             FROM artifact_storage_metadata
             GROUP BY storage_kind, container_name
             ORDER BY artifacts DESC;"
```

The key-level inventory comes from the importer's paging scan, which is the
only reviewed reader of these buckets in the repository:
`POST /v1/<source>/backfill-page` reads exactly one object per request, returns
`scannedObjectCount` and a cursor, and never modifies or deletes the source
object. A complete pass that reports `importedRecordCount: 0` for every page is
the statement "every object in this bucket is already in CORE".

Until that pass exists per bucket, the bucket stays. Plan 13 §3 allows either
outcome — copy the bytes to the shared bucket with a verified digest and a
recorded mapping from the old reference, or keep the bucket and keep serving
reads from it through an explicit legacy `storageRef`. It does not allow a
third: deleting on age.

### 5.3 Retention window and backup

A bucket's durability is not a backup ([protection.md §4](../infra/protection.md#4-r2-protection-not-executed)):
it does not protect against a wrong `DELETE`. Before a bucket is deleted there
must be a second verified copy of every object it holds, or an explicit written
decision that those objects are not worth keeping — which for
`financial-evidence` downgrades the affected runs to `restricted`/`unavailable`
and is recorded in `evidence_use_restrictions`, not done silently.

### 5.4 The retirement itself, in order

1. The source runs `shared`; the collector no longer writes the legacy bucket.
2. A complete importer pass reports nothing new (§5.2).
3. The byte-level reconciliation is done and recorded: every object is in the
   shared bucket with the same sha256, or kept deliberately.
4. Remove the bucket binding from the collector and from the importer, and
   re-deploy both. The bucket now has no reader.
5. Wait out the recorded retention window with the bucket still there.
6. `wrangler r2 bucket delete <bucket>`. **Irreversible, and not covered by any
   backup this repository controls.**

## 6. The CORE projection tables of migration `0030`

`balance_read_snapshots`, `current_balance_projection` and `scope_relations`
(plus `balance_snapshot_pointer` from `0038`) are classified `read-candidate` in
`infra/schema/core-ledger.md`. U11 gave the same build a second home — the READ
database `kogane-read` — selected by `READ_PROJECTION_ENABLED`.

The second-stage pair `expiry_estimates` and `conversion_simulations` is the
same shape one step later: U16 put its READ side in `0002_reward_read.sql`
behind `REWARD_READ_PROJECTION_ENABLED`. Everything below applies to it word for
word, with that flag in place of the first one. What is **not** a candidate for
either treatment is the CORE claim and rule side — `reward_programs`,
`expiry_rules`, `conversion_offers`, `reward_bucket_claims`,
`membership_state_claims` — which 04 §2 keeps in CORE and which losing READ must
not cost a single row of.

**U15 writes no DDL for them and this section proposes none.** What it records
is the supersession:

- With `READ_PROJECTION_ENABLED` off — the default — the CORE tables of `0030`
  are the live projection. The App reads them and the Processor writes them.
- With it on, the same build writes READ instead and the App reads READ; the
  CORE tables stop being written and keep whatever they last held.
- They are `read-candidate`, which means rebuildable, **not** disposable: while
  the flag can be turned back off they are the rollback target for the whole
  READ change. Dropping them turns "set the flag to false" into "rebuild from
  CORE", which is a different and much slower operation (11 §7).

Evidence before any later work item removes them:

```sh
# Is anything still writing them? A max timestamp that stops moving after the
# flag goes on is the signal; one that keeps moving means a writer was missed.
wrangler d1 execute kogane-raw-evidence --remote \
  --config services/processor/wrangler.jsonc \
  --command "SELECT (SELECT COUNT(*) FROM balance_read_snapshots) AS snapshots,
                    (SELECT MAX(created_at) FROM balance_read_snapshots) AS last_snapshot,
                    (SELECT COUNT(*) FROM current_balance_projection) AS rows,
                    (SELECT COUNT(*) FROM scope_relations) AS relations,
                    (SELECT COUNT(*) FROM balance_snapshot_pointer) AS pointers;"
```

```sh
# Is anything still reading them? The readers are in this repository, so this
# is a code question, not an account one.
git grep -n -- 'current_balance_projection'
git grep -n -- 'balance_read_snapshots'
git grep -n -- 'expiry_estimates'
git grep -n -- 'conversion_simulations'
```

Removal, when it is proposed, is a **new** migration and its own work item: the
existing `0030` file is immutable, the tables carry `*_sealed_no_update` /
`*_sealed_no_delete` triggers, and the CORE schema ledger digests both. The
gate is `READ_PROJECTION_ENABLED` having been on, uninterrupted, for longer than
any rollback would reach back — and the acceptance property of **G0-09** (losing
READ leaves CORE untouched) still holding afterwards, which it cannot if CORE no
longer has the tables. That is the argument for keeping them well past the
first release.

## 7. `kogane-globalpass-container-probe-20260827`

Live in the account — created 2026-08-26 and last modified 2026-08-27 according
to the account's Worker listing of 2026-09-11, which is not something the
repository can re-check — with **no configuration in this repository**. `infra/resources.json` lists it under
`liveWorkersWithoutConfig` and `scripts/resource-ledger.test.ts` asserts that
list by name, so it cannot drop out of sight.

- It cannot be redeployed from here: deleting it is not reversible by any
  release of this repository.
- Nothing here can prove what it binds, what calls it, or whether it holds
  state. A probe named for a date is very likely finished, but "very likely" is
  not the standard this page uses for a live resource.
- **Disposition: delete manually after the owner confirms.** Before that:

```sh
wrangler deployments list --name kogane-globalpass-container-probe-20260827
wrangler tail kogane-globalpass-container-probe-20260827 --format json   # over a full day
# then, only after the owner confirms:
wrangler delete kogane-globalpass-container-probe-20260827
```

If it turns out to matter, the opposite action is the right one: add its
configuration to this repository so that it stops being invisible.

## 8. Late work after the old path stops (G5-18)

A notification, a retry or a manual re-run that arrives **after** the importer
and the ingest Worker are gone must be recoverable, and it must not be silently
discarded. Three things make that true today:

1. `services/processor/src/legacy-import` still recognises every legacy key
   shape and names the bucket it belongs to, including for the eleven sources
   whose manifests it cannot yet map. An unrecognised key is reported, not
   dropped.
2. The Processor answers `retryable`, never `completed`, for anything it cannot
   finish — `queued`, `building`, `flag_off` and `no_processor` are never
   completions — and records the reason as a stage in `collection_run_stages`.
3. Pausing the reconciler queue (§4.4 step 3) instead of deleting it turns a
   late producer into a visible backlog.

The recovery path for a late run is therefore: read the key, identify its source
and bucket, and re-drive it through the shared path (`persistRun` into the DATA
bucket, then the terminal), rather than resurrecting the importer. Nothing about
that path deletes the unprocessed item.

## 9. Acceptance mapping, and what was not done

| id        | property                                                                        | where it stands                                                                                                                  |
| --------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **G0-10** | Originals that exist only in a legacy bucket survive until the copy is verified | runbook §5; the bucket list and its readers are asserted by `scripts/resource-ledger.test.ts`, the byte check is live work       |
| **G0-12** | A PoC with a live cron is not deleted because nothing imports it                | covered: the ledger records every cron and its deployed status; §0 rule 1 and §5.1 make the cron, not the import graph, the gate |
| **G5-18** | A late notification after the old path stops is recovered, not discarded        | §8; the recognition half is covered by `services/processor/test/legacy-import.test.ts`, the live half is a drill                 |

**Not done by U15, deliberately:** no bucket, Worker, Queue, cron, CORE table,
route or row was deleted or deactivated; no legacy per-source code path was
removed; no command on this page was run against the account; no retention
window was decided. U15 changed only what is provably dead in the repository
itself — two risk-gate patterns whose directories no longer exist — and wrote
this page, the dispositions that point at it, and the flag and settings tables
of [docs/rollout.md](rollout.md).
