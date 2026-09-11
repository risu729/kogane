# Retention and protection ledger

Unified plan U01; chapters 04 (CORE/READ placement and retention), 06 §5 (bootstrap tests),
15 §4 (CORE/R2 protection) and 15 §5 (deletion). Gate G0.

This file says what must never be deleted, what may be rebuilt, and how a CORE backup and
restore is performed. It is a runbook: **nothing in it has been executed**, and no command here
was run against the live account. Every command is written so it can be reviewed before anyone
runs it.

The machine-readable halves are `infra/resources.json` (runtime resources and their live status)
and `infra/schema/core-ledger.json` (every CORE table with its classification and its
append-only guards). Both are regenerated and asserted by tests; see `docs/infra-ledgers.md`.

## 1. Must never be deleted

| #   | Object                                                                                               | Where                                                                                                                                                                                                                                                                                                                                                                                                         | Why                                                                                                                                                                                                                                                 | Gate before any removal                                                                                                                                                          |
| --- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | The 86 `core-keep` tables and their rows                                                             | D1 `kogane-raw-evidence` (`b335a887-250d-45c9-bd72-af83f35fdc60`)                                                                                                                                                                                                                                                                                                                                             | Originals, observations, adoption and human decisions. 04 §2 keeps them in CORE; past B results are not treated as a cache.                                                                                                                         | Never in the first release. A later removal needs its own work item with the reference check of 15 §5.                                                                           |
| P2  | The 5 `unclassified-keep` tables                                                                     | same                                                                                                                                                                                                                                                                                                                                                                                                          | 04 §2 lists confirmed groups, not the whole schema, and sets the default: an unclassified table is kept. Currently `dataset_snapshot_policies`, `fetch_run_annotations`, `observation_artifact_metadata`, `observation_scan_state`, `parse_issues`. | Classify it deliberately first. `scripts/core-schema-ledger.test.ts` fails if a new table has no classification (G0-01).                                                         |
| P3  | The 4 `operational-mutable` tables                                                                   | same                                                                                                                                                                                                                                                                                                                                                                                                          | Job, replay, work-item and lane state. Rows are mutable by design; the **tables** stay until checkpoints and intake are separated (04 §2).                                                                                                          | U10/U11, with the receipts of in-flight work drained first.                                                                                                                      |
| P4  | Existing run / observation / decision / parse ids and hashes                                         | same                                                                                                                                                                                                                                                                                                                                                                                                          | 06 §2: existing database ids, run/observation/decision ids and hashes do not change. Directory moves and the workspace merge must not renumber anything.                                                                                            | Nothing may rewrite them. A migration that would is rejected by rule 1 of the programme brief.                                                                                   |
| P5  | Every file in `services/raw-evidence/migrations/`                                                    | repository                                                                                                                                                                                                                                                                                                                                                                                                    | Applied migrations are immutable (06 §2). U05 moves the directory with `git mv`; filenames and bytes stay identical.                                                                                                                                | Only `git mv`, never an edit.                                                                                                                                                    |
| P6  | Objects in the DATA bucket `kogane-raw-evidence`                                                     | R2                                                                                                                                                                                                                                                                                                                                                                                                            | Originals and produced artifacts. 15 §4: this is not the same operation as a normal READ cleanup, and bucket durability is not an independent backup against a wrong DELETE.                                                                        | Never as part of a cleanup. Removal of a specific object is a privileged, recorded operation, and it downgrades the affected runs rather than erasing their history.             |
| P7  | The 12 legacy per-source buckets                                                                     | R2: `kogane-globalpass-collector-poc`, `kogane-mobile-suica-collector-poc`, `kogane-moneyforward-collector-poc`, `kogane-myjcb-collector-poc`, `kogane-sbi-collector-poc`, `kogane-sbi-shinsei-collector-poc`, `kogane-sbi-vc-trade-poc`, `kogane-smbc-direct-backfill-poc`, `kogane-sony-bank-collector-poc`, `kogane-vpass-collector-poc`, `kogane-vpoint-collector-poc`, `kogane-vpoint-pay-collector-poc` | 13 §3: bytes that exist only in a legacy bucket are verified and moved, or kept. G0-10.                                                                                                                                                             | U15, after every source is switched (U09), the byte-level verification is done and the retention period has passed. Deleting a bucket is a separate step from stopping a Worker. |
| P8  | The 17 deployed Workers, their DO classes and migration tags, Queue names, crons and the Email route | Cloudflare account `59ea63cc00914b30ca410b062ae2bb7f`                                                                                                                                                                                                                                                                                                                                                         | 07 §1: runtime resource identities never change with a directory rename. 07 §6: a collector is not deleted because no import points at it — its cron, Queue or Email route still starts it (G0-06, G0-07, G0-12).                                   | U15, per resource, after the ledger shows zero references and zero unprocessed work.                                                                                             |
| P9  | Synthetic fixtures, byte for byte                                                                    | repository                                                                                                                                                                                                                                                                                                                                                                                                    | Moved with `git mv` and a SHA-256 parity check; excluded from the formatter (G0-04).                                                                                                                                                                | U04 performs the move and proves the bytes.                                                                                                                                      |

`kogane-globalpass-container-probe-20260827` is live in the account and has **no config in this
repository**. It cannot be redeployed from here, so U15 has to decide about it explicitly; the
resource ledger lists it under `liveWorkersWithoutConfig` so it cannot be forgotten by silence.

## 2. May be rebuilt, and only inside READ

`balance_read_snapshots`, `current_balance_projection`, `scope_relations` and the second-stage
candidates `expiry_estimates`, `conversion_simulations` are the `read-candidate` tables. They
still live in CORE today. Once U11 creates the READ database, losing READ must leave everything
in §1 untouched (G0-09), and a rebuild is a READ-side operation only:

- A READ rebuild never issues a DROP against CORE or against the DATA bucket (15 §3 step 2).
- No API accepts a database id or a bucket name to delete (15 §5).
- A rebuilt snapshot that cannot reproduce an old one returns `context_expired`/`unavailable`
  instead of presenting today's numbers as yesterday's snapshot (04 §4).

## 3. CORE backup runbook — D1 (not executed)

Two mechanisms, for different failures. Time Travel restores the whole database to a point in
time inside its retention window; an export is a file that outlives the window and can be loaded
into a **non-production** database for verification.

All commands below use the deployed ingest config so the database name and id come from the
repository rather than from memory. Run them from the repository root.

### 3.1 Before applying a migration

```sh
# 1. What is applied now, and what would be applied.
wrangler d1 migrations list kogane-raw-evidence \
  --config services/raw-evidence/wrangler.jsonc --remote

# 2. Record the restore point. Keep the bookmark in the pull request or the deploy log.
wrangler d1 time-travel info kogane-raw-evidence \
  --config services/raw-evidence/wrangler.jsonc

# 3. Take a file copy that outlives the Time Travel window.
wrangler d1 export kogane-raw-evidence \
  --config services/raw-evidence/wrangler.jsonc --remote \
  --output core-$(date -u +%Y%m%dT%H%M%SZ).sql

# 4. Schema-only copy, useful for comparing a fresh bootstrap against an upgrade (06 §5).
wrangler d1 export kogane-raw-evidence \
  --config services/raw-evidence/wrangler.jsonc --remote --no-data \
  --output core-schema-$(date -u +%Y%m%dT%H%M%SZ).sql
```

Only the CD job applies migrations to production (06 §2, decision D3):

```sh
wrangler d1 migrations apply kogane-raw-evidence \
  --config services/raw-evidence/wrangler.jsonc --remote
```

### 3.2 Restoring

```sh
# The bookmark for a wall-clock time, before deciding anything.
wrangler d1 time-travel info kogane-raw-evidence \
  --config services/raw-evidence/wrangler.jsonc --timestamp 2026-09-11T00:00:00Z

# Restore. This is a write to production and it is not reversible by re-running it.
wrangler d1 time-travel restore kogane-raw-evidence \
  --config services/raw-evidence/wrangler.jsonc --bookmark <bookmark>
```

Restore rules (15 §4):

1. Stop the writers first — the Processor cron, the importer cron and the ingest route — so the
   restore point does not move under the restore.
2. Confirm the restore point with `time-travel info` before restoring, not after.
3. Bump `coreEpoch` and invalidate the old READ instance afterwards; a READ built against the
   pre-restore CORE must not keep serving.
4. Re-registering terminals that still exist in R2 is a deliberate step, checked against ids,
   contract version and retention — not an automatic consequence of the restore.
5. Say plainly that decisions recorded after the restore point are lost. Do not hide it.

The Time Travel window is a property of the D1 plan, not of this repository: read the actual
window from `time-travel info` rather than assuming one. An export is the only copy that
survives beyond it, and `wrangler d1 export` is also the only way to get the data off the
platform for the non-production restore test of G0-08.

### 3.3 Verifying a restore without touching production (G0-08)

The check is not "the file imported". 06 §5 asks for column, NULL, PK, FK, `STRICT`,
`WITHOUT ROWID`, partial index, trigger, view and fixed-row equality, plus the decimal, lease
and seal behaviour. Two comparable inputs exist:

```sh
# a) A fresh database built from the migrations alone.
wrangler d1 create kogane-core-restore-check          # non-production, new id
wrangler d1 migrations apply kogane-core-restore-check \
  --config services/raw-evidence/wrangler.jsonc --remote

# b) The export loaded into another non-production database.
wrangler d1 execute kogane-core-restore-check-import \
  --remote --file core-<stamp>.sql
```

The local half of that comparison already runs offline and needs no account: `bun run
scripts/core-schema-ledger.ts` applies the same migrations to `bun:sqlite` and
`scripts/core-schema-ledger.test.ts` asserts the result equals the committed ledger, so the
"fresh bootstrap" side of 06 §5 is checked on every CI run. What is **not** checked offline is
whether a production export re-imports under the current triggers (15 §4 warns against assuming
it does: original ids, dependency order, writes rejected after a seal, and derived triggers
firing twice). That needs the live check above.

Never point a restore check at `b335a887-250d-45c9-bd72-af83f35fdc60`, and never give a
verification job DROP rights on CORE or on the DATA bucket.

## 4. R2 protection (not executed)

```sh
# Inventory. The ledger records which bucket each Worker binds; this confirms the account.
wrangler r2 bucket list

# Read a single object for a byte-level check. No bulk copy, no lifecycle rule.
wrangler r2 object get kogane-raw-evidence/<key> --remote --file ./check.bin
```

- The DATA bucket has no automatic GC in the first release (15 §5). Objects a collector retry or
  an in-flight run still references are not removed on age alone.
- A legacy bucket is retired in its own step, after its Worker is stopped, after the byte-level
  verification of 13 §3, and after the retention period — never as part of "cleaning up the
  repository".
- Ending the second copy (source bucket + central bucket) is not the same as deciding backups are
  unnecessary (15 §4). If an independent low-frequency backup is wanted, it is a separate
  operational decision, not a return to double writes in every collector.

## 5. G0 acceptance-test mapping

`covered` means a test added or already present in this repository fails if the property breaks.
`runbook` means this file defines the procedure but nothing is asserted automatically.
`later` means the work item that owns it has not run yet.

| id    | scenario                                                                                           | status                              | where                                                                                                                                                                                            |
| ----- | -------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| G0-01 | Unclassified tables in the schema inventory are kept and never enter a cleanup                     | covered                             | `scripts/core-schema-ledger.test.ts`: every table is classified, the classification map has no stale names, and the `unclassified-keep` set is asserted by name                                  |
| G0-02 | Existing CORE run / observation / decision ids still resolve after the move                        | later (U05, U11)                    | The ledger records every table's primary key and foreign keys, so a renumbering shows up as a ledger diff; proving that references still resolve needs the extraction work and a live check      |
| G0-03 | Existing R2 object hashes and keys are not changed by the reorganisation                           | later (U07, U09)                    | `infra/resources.json` fixes the bucket names and their readers; the key layout contract is U07's, and byte-level confirmation is a live check                                                   |
| G0-04 | Fixtures keep their SHA-256 across the move and the formatter does not touch them                  | later (U04)                         | `hk.pkl` already excludes `**/fixtures/**`; the parity test belongs to the move                                                                                                                  |
| G0-05 | Parser sources moved to `packages/` keep the old release digest                                    | covered (pre-existing)              | `packages/parsers/test/parser-digests.test.ts`                                                                                                                                                   |
| G0-06 | Renaming a Worker directory does not change the physical Worker/DO/R2/Queue identity               | covered                             | `scripts/resource-ledger.test.ts`: the committed ledger must equal a fresh read of every config, so a changed `name`, bucket or queue fails CI                                                   |
| G0-07 | DO migration tag and class still address the same state                                            | covered (repository side) + runbook | `scripts/resource-ledger.test.ts` asserts every DO class has a tag or an explicit sqlite export; that the namespace still holds the same state is verified at the first deploy under supervision |
| G0-08 | A CORE backup restored to a non-production database verifies dependencies, triggers, seals and ids | runbook (§3.3)                      | The fresh-bootstrap half runs offline in `scripts/core-schema-ledger.test.ts`; the export re-import half needs the live check                                                                    |
| G0-09 | Losing only READ leaves CORE protected rows, digests and DATA originals unchanged                  | later (U11)                         | §2 states the rule; the test belongs to the READ split                                                                                                                                           |
| G0-10 | Originals that exist only in a legacy bucket are not deleted before the copy is verified           | runbook (§1 P7, §4)                 | The ledger lists every legacy bucket and every Worker that reads it; the object-level verification is a live check in U15                                                                        |
| G0-11 | A stored report that references READ keeps its fixed body and evidence                             | later (U11, U16)                    | 04 §4 requires the fixed body on the durable side; no code path exists yet                                                                                                                       |
| G0-12 | A PoC with a live cron is not deleted just because nothing imports it                              | covered                             | `scripts/resource-ledger.test.ts`: every cron and its deployed status is in the ledger, and each directory's live status is asserted against its configs                                         |

## 6. What was not verified

- No command in this file was run. Nothing was deployed, exported, restored or deleted.
- Queues, Durable Object namespaces, cron triggers and Email routes could not be listed through
  the API the live inventory was read with. They are derived from the wrangler configs, so the
  ledger proves what the repository declares, not what the account currently runs.
- The Email route that delivers to the `email()` handler of `kogane-vpoint-collector-poc` is
  configured outside this repository. It is listed as a protected resource (P8) precisely because
  no file here would show its removal.
