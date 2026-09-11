# Runbook: rebuilding the READ database

What to do when the balance read model is lost, corrupt, or has to be replaced
(unified plan 15 §3, 11 §7; acceptance G0-09, G3-12). The contract of the
database itself is [read-model-d1.md](read-model-d1.md).

**What losing READ costs:** a rebuild, the time it takes, and every open cursor.
**What it does not cost:** any evidence, parse, observation, identity, decision,
receipt or saved report. Those are in CORE and in the DATA bucket, and nothing in
this runbook touches either.

"READ can be dropped" does not mean "restored instantly with the same cursors".
Measure the recovery time when you run this; do not assume it.

## 0. Before anything

Confirm which database you are about to operate on.

```sh
wrangler d1 info kogane-read
```

The id must match the one in `services/observation-pipeline/wrangler.jsonc`,
`services/observation-pipeline/wrangler.read-migrations.jsonc` and
`services/evidence-browser/wrangler.jsonc` (`320ebe31-a031-48a1-985f-0e6fabbd517a`
as of 2026-09-11, when the database was created empty). If the command reports
no such database, or the three configs disagree, you are in section 2, not
section 3.

**Never** aim a `DROP`, a `--remote` execute or a migration at
`kogane-raw-evidence` or at the R2 bucket. The CORE directory
(`packages/storage-d1/migrations/core`) and the READ directory
(`packages/storage-d1/migrations/read`) are configured in different files for
exactly this reason; use the READ configuration only for the READ database.

## 1. Stop the writer

The rebuild is done with the writer stopped, so a half-built snapshot from the
old deployment cannot be mistaken for the new one.

```sh
# Processor: stop writing to READ.
wrangler deploy --config services/observation-pipeline/wrangler.jsonc \
  --var READ_PROJECTION_ENABLED:false
```

The `balance_projection` lane keeps running against the CORE tables of migration
0030 while this flag is off, so the projection does not stop existing; only the
READ copy does. If the CORE path is not wanted either, set
`BALANCE_PROJECTION_ENABLED=0` as well and the lane reports `skipped(flag_off)`.

The App can stay as it is: with no published snapshot it answers
`503 read_model_unavailable` on the v2 balance routes, which is the intended
display state (G3-01). Every other route — history, evidence, identity,
operations, receipts, saved reports — is unaffected, because none of them reads
READ (G0-11).

## 2. Prepare an empty database with the schema

Either the same database emptied, or a new one. A **new** one is preferable when
the schema is being replaced (06 §2: a destructive change is a new empty READ,
not a migration of the old one).

```sh
# Only when creating a fresh database:
wrangler d1 create kogane-read
# → put the new id into the three configs above, and deploy the two Workers.

# Apply the READ schema. Note the separate configuration: wrangler takes one
# `migrations_dir` per config, and the processor's own config points at CORE.
wrangler d1 migrations apply kogane-read --remote \
  --config services/observation-pipeline/wrangler.read-migrations.jsonc
```

To empty an existing database instead, drop its tables and apply the migrations
again. The table list is in
`services/observation-pipeline/test/read-projection.test.ts` (`READ_TABLES`) and
in the ledger, and the order matters because of the foreign keys:

```text
read_build_checkpoints, scope_relations, snapshot_input_refs,
current_balance_projection, balance_snapshot_pointer, balance_read_snapshots,
reward_build_checkpoints, reward_conversion_simulations,
reward_expiry_estimates, reward_snapshot_input_refs, reward_snapshot_pointer,
reward_expiry_snapshots,
read_instance
```

The second block is the reward stage of migration 0002 (U16). It lives in the
same database, so emptying READ empties it too; its CORE claims, rules and
offers are untouched, and the next tick of `reward_read_projection` rebuilds
the estimates at a new evaluation instant (`docs/rewards.md` §12).

After this step the database is empty **and has no identity**: `read_instance`
carries no row, because a migration cannot generate one. The first build claims
it, and that new instance id is what makes every cursor of the lost database
expire instead of being answered from new rows.

## 3. Rebuild

```sh
wrangler deploy --config services/observation-pipeline/wrangler.jsonc \
  --var READ_PROJECTION_ENABLED:true
```

The next cron tick:

1. claims the new read instance;
2. captures a fixed input from CORE at a revision that did not move while it was
   reading, or resumes from an input already stored in
   `projection-inputs/<digest>/input.json` and recorded in CORE's
   `projection_input_records` — the rebuild does not need a fresh capture when
   the input it needs is still on record (05 §3, G2-05);
3. writes the rows in bounded chunks, each with its checkpoint;
4. verifies row count, dense order and every row digest;
5. seals the snapshot and switches the pointer in one batch.

A build that needs more than one tick reports `status: "building"`; the lane log
line carries `written`, `rowCount` and `active`. Nothing is visible to a reader
until the pointer switches.

## 4. Verify before declaring it done

- `SELECT status,row_count,output_digest FROM balance_read_snapshots` — the
  published snapshot is `complete` with a digest;
- `SELECT * FROM balance_snapshot_pointer` — it names that snapshot, and its
  `core_epoch` and `visibility_revision` equal CORE's current
  `core_source_revision` row. If they do not, the App refuses the snapshot on
  purpose (`read_model_context_changed` / `read_model_restriction_changed`) and
  the next build will re-verify it;
- `SELECT count(*) FROM snapshot_input_refs WHERE snapshot_id = …` — the CORE
  references the build was made from are recorded;
- the App: `/api/meta` reports `balancesV2ReadModel: "read-d1"` and
  `balancesV2: true`, and `/api/v2/balances/latest` answers 200;
- CORE is untouched: the protected row counts and digests are what they were.
  `infra/schema/core-ledger.md` and the CORE tables are not part of this
  procedure at all.

Then re-enable the reader if it was turned off:

```sh
wrangler deploy --config services/evidence-browser/wrangler.jsonc \
  --var READ_PROJECTION_ENABLED:true
```

## 5. What to tell people

- open cursors are gone. A continuation answers `410 context_expired`; clients
  start the list again. Do not try to translate an old cursor: its positions
  belong to a database that no longer exists;
- an old snapshot's permissions are not restored. The current restrictions in
  CORE decide what is visible, always — a rebuilt READ never resurrects a grant;
- approvals are not re-consumed. A decision that was already accepted stays
  accepted, and its receipt keeps its evidence; the projection catching up is a
  downstream completion, not a second approval (05 §6).

## 6. Replacing the schema instead of the data

A destructive schema change is a **new empty database**, verified, then a
binding switch:

1. create `kogane-read-<n>` and apply the new READ migrations to it;
2. point the processor's `READ` binding at it and let it build;
3. verify as in section 4;
4. point the App's `READ` binding at it;
5. keep the old database until the retention window for open cursors has passed,
   then delete it.

There is no dynamic multi-generation routing layer, and none is wanted (05 §8).
A generation switch is a configuration change deployed like any other.

## What is tested, and what is not

`services/observation-pipeline/test/read-projection.test.ts` runs section 2 and
section 3 against real D1 under Miniflare: it drops every READ table, applies the
migrations again, rebuilds, and asserts that the CORE rows and digests and the
DATA objects are exactly what they were, that the new instance differs, and that
a cursor from the lost instance is `context_expired` (G0-09, G3-12).
`services/evidence-browser/test/balances-v2-read.test.ts` asserts that a saved
report answers with every READ table dropped (G0-11).

Not tested here: the platform commands themselves, the recovery time on
production volumes, and a partial loss that leaves a corrupt database answering
— for that, empty the database and rebuild rather than repairing rows.
