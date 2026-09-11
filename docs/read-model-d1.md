# The READ database

The balance read model can be deleted and rebuilt. This document is what that
means physically: a second D1 database, its schema, how a snapshot is
identified and published in it, which flags gate it, in what order it is
deployed, and what happens when it is lost (unified plan 04, 05; U11).

Everything below was exercised locally against synthetic fixtures. Nothing here
is a claim about production data or production performance.

## Why a second database

CORE holds what was collected, parsed, decided and promised: evidence, parses,
identity, decisions, receipts. The balance projection holds none of that. It is
a derived view of CORE under a fixed input, and repairing it is a rebuild, never
a repair of a fact.

Keeping the two in one database made three things awkward at once: the deletion
unit (you cannot drop a projection without writing DDL next to the evidence),
the rebuild schema (a projection wants to be designed from its final shape, not
migrated forward), and the query load. So READ is its own D1 (04 §1).

It is **not** a service boundary. The App and the Processor bind both databases
directly. What the boundary buys is that READ can be dropped and rebuilt while
CORE and the DATA bucket are never touched (G0-09).

Two consequences, and both are rules rather than preferences:

- **no cross-database join and no shared transaction.** A CORE reference lives
  in READ as a copied, digested value in `snapshot_input_refs`, never as a
  foreign key (04 §3). A financial decision commits in CORE alone; losing the
  projection never rolls one back;
- **READ is finished before CORE is completed.** There is no two-phase commit
  between them. The projection is published in READ, and only then is the CORE
  job and its receipt completed (05 §5).

## The schema

`packages/storage-d1/migrations/read/0001_read_baseline.sql`, generated into
[`infra/schema/read-ledger.md`](../infra/schema/read-ledger.md). Every table is
`STRICT`; no foreign key names a CORE table; the mutable tables are mutable on
purpose, because a rebuildable database gains nothing from append-only guards
that would make a rebuild harder.

| Table                        | What it holds                                                                                                                                                                 |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read_instance`              | The identity of this physical database: one row, written by the first writer that finds the table empty. A rebuilt database is a new instance, which is what expires cursors. |
| `balance_read_snapshots`     | One build: its content key and attempt, the fixed input's digest, revision, visibility revision and epoch, its status, row count, output digest and writer fence.             |
| `current_balance_projection` | One candidate measurement per row, with the `row_digest` that makes a re-sent chunk decidable. Same columns as CORE's table, so the reviewed read SQL runs unchanged.         |
| `scope_relations`            | The typed scope relations **of one snapshot**. A decision revised later does not change what an already published snapshot says.                                              |
| `snapshot_input_refs`        | The CORE references the build was made from — decisions, releases, the published high-water parse run, the restriction revision — with a digest each (04 §3).                 |
| `balance_snapshot_pointer`   | What is published: the snapshot, the revision and visibility revision it was verified against, the epoch, the instance and the output digest.                                 |
| `read_build_checkpoints`     | Where a bounded build got to, written in the same batch as the chunk it records.                                                                                              |

## Identity, and the limit it fixes

```text
contentKey = sha256(inputDigest ‖ buildDigest ‖ contractVersion)
snapshotId = sha256(contentKey ‖ ':' ‖ attempt ‖ ':' ‖ contractVersion)
```

`contentKey` is exactly CORE's snapshot id (U10), so both databases agree on
when content is unchanged. `attempt` is the new part, and it exists to fix a
limit U10 recorded:

> **A retired snapshot id is final.** Migration 0030 lets a snapshot leave
> `retired` for nothing, so a capture whose content digests to a retired
> snapshot was reported as `skipped(snapshot_retired)`, the pointer's watermark
> never advanced, and an outbox row waiting on that revision kept polling.

Here the row identity carries an attempt, allocated when a build starts and
**only when no `building` or `complete` build of that content exists**:

- a build already under way, or a published one, is reused — nothing is rebuilt
  for nothing, and a capture that digests to the published snapshot advances the
  watermark without writing a row;
- content whose builds were all retired starts the next attempt, which is a new
  `snapshot_id` and a new row. The wedge cannot happen.

`retired` stays terminal: a retired build is never revived, its rows are
deleted, and no cursor that names it is served again. The alternative — making
`retired` non-terminal — was rejected because it would make "this snapshot is
gone" a reversible statement, and a reader that had been told `context_expired`
would have to be told otherwise.

One consequence to know: **a snapshot id repeats across rebuilds.** It is the
digest of content, an attempt and a contract, so a rebuilt database with the
same content produces the same ids. That is why a cursor carries the read
instance; the id alone cannot say which physical database answered.

## Publication

A build writes rows while `building`, and:

- each chunk and its checkpoint are one D1 batch, so a statement error rolls
  both back (G2-08), and a re-sent chunk is a no-op only when its content is
  identical — different content for a row that exists raises `projection chunk
conflict` in a trigger (G2-07);
- a writer holds a 60 s lease and a fence; a writer whose lease was taken can no
  longer write, seal or publish (G2-09);
- the seal and the pointer switch are one batch. The pointer moves only to a
  snapshot at least as current as the published one under the same epoch, so a
  build that finishes late is complete but not published (G2-10);
- the App reads only through the pointer. There is no "newest complete build"
  fallback, so an unfinished or unpublished build is never served.

The pointer's `source_revision` and `visibility_revision` are the watermark
"the published content was verified against these". A capture that digests to
the published snapshot moves that watermark without rebuilding — which is how a
decision that changes no row still becomes "published", and how a restriction
that changes no candidate row lets the page serve again.

## Reading

`GET /api/v2/balances/latest` and `/history` read the published snapshot. What
is different from the CORE path:

| Situation                                     | Answer                                                |
| --------------------------------------------- | ----------------------------------------------------- |
| No published snapshot                         | `503 read_model_unavailable` — never an empty success |
| Cursor from another read instance or snapshot | `410 context_expired`                                 |
| Cursor for another query                      | `400 cursor_mismatch`                                 |
| CORE restored under a new epoch               | `503 read_model_context_changed`                      |
| A use restriction changed                     | `503 read_model_restriction_changed`                  |

The last one is the rule of 05 §7: a restriction does not only hide rows. A
subtotal computed before it is wrong, so the affected snapshot is refused whole
— aggregates included — until a build re-verifies it at the new visibility
revision. Filtering rows out of a published snapshot is never the answer.

The cursor is `{ snapshotId, readInstanceId, filterDigest, position }`
(`packages/storage-d1/src/read/cursor.ts`), base64url of the same JSON shape the
CORE path uses. Nothing in it is trusted: every field is compared with what the
server resolved for this request, and it is never an authorisation.

`/api/meta` advertises `balancesV2ReadModel`: `none`, `core-d1` or `read-d1`. A
client is told which store answered rather than inferring it from a cursor that
stopped working. Two details of its semantics:

- `balancesV2` and `balancesV2ReadModel` say whether a page can be served
  **now**: while nothing is published in READ they are `false` and `none`. The
  v2 routes nevertheless exist as soon as the app reads READ, so a request in
  that state is `503 read_model_unavailable`, not a `404` that would read as
  "this deployment has no such route";
- a READ database whose `read_instance.contract_version` is not this code's
  `READ_CONTRACT_VERSION` (`packages/storage-d1/src/read/identity.ts`) is
  another baseline (06 §2). The app advertises `balancesV2: false` and answers
  `503 read_model_unavailable`; the processor refuses to build into it
  (`refused(read_contract_mismatch)`).

## Flags

| Flag                         | Where          | Default | Effect                                                                         |
| ---------------------------- | -------------- | ------- | ------------------------------------------------------------------------------ |
| `BALANCE_PROJECTION_ENABLED` | processor, app | `0`     | The existing A07 gate: nothing builds or reads the projection while it is off. |
| `READ_PROJECTION_ENABLED`    | processor      | `false` | The build writes the `READ` binding instead of the CORE tables of 0030.        |
| `READ_PROJECTION_ENABLED`    | app            | `false` | The v2 routes read the `READ` binding instead of the CORE tables.              |

Both are off everywhere. Merged is not enabled.

## The resource

One D1 database named **`kogane-read`**, id
`320ebe31-a031-48a1-985f-0e6fabbd517a` (account `risu`, region APAC). It was
created **empty** on 2026-09-11: no migration has been applied to it, and none
is applied by anything but the deploy step below. It is bound as `READ` in:

- `services/processor/wrangler.jsonc`;
- `services/processor/wrangler.read-migrations.jsonc` (also
  `migrations_dir` `../../packages/storage-d1/migrations/read`);
- `services/app/wrangler.jsonc`.

Dry runs and tests never contact the account: the tests bind a local D1 and
apply the read migrations from the directory. The demo Worker deliberately gets
no `READ` binding — it answers from a committed synthetic snapshot and is not
given a handle on the production read model.

Wrangler takes **one `migrations_dir` per configuration**, which is why the
processor has a second configuration used only for the READ migration step. It
has no `main`, deploys nothing, and is listed in `infra/workers-ci.json` under
`excluded` with that reason. The deploy order ledger of U14
(`infra/deploy-order.json`, `schema.read`) is where the CD job is expected to
find this configuration; it is not on this branch yet.

## Deploy order

1. **Create the database.** Done: `kogane-read` exists, empty, and its id is
   in the three configs above.
2. **Apply the READ migrations.**
   `wrangler d1 migrations apply kogane-read --remote --config services/processor/wrangler.read-migrations.jsonc`.
   The database is empty afterwards: `read_instance` has no row yet, because a
   migration cannot generate an identity. The first build claims it.
3. **Deploy the processor.** Both flags still off; it writes nothing new.
4. **Deploy the app.** Both flags still off; every caller sees today's answers.
5. **Enable on the processor.** `READ_PROJECTION_ENABLED=true` with
   `BALANCE_PROJECTION_ENABLED=1`. The next cron tick captures an input, builds
   a snapshot in READ and publishes it. Watch the `balance_projection` line of
   the scheduled log for `status`, `written` and `active`.
6. **Enable on the app.** `READ_PROJECTION_ENABLED=true` once a snapshot is
   published. `/api/meta` reports `balancesV2ReadModel: "read-d1"`, and open
   cursors from the CORE path expire with `410` — which is the honest answer,
   since their positions belong to another database.

## Rollback

Set `READ_PROJECTION_ENABLED=false` on the app, then on the processor. The v2
routes go back to the CORE projection of migration 0030, which is still being
maintained by the same job under the same flag, and cursors issued by READ
expire. Nothing in CORE has to be undone, and READ can be left alone or dropped
entirely; no observation, parse, publication, decision or receipt depends on it.

Dropping READ while the flag is on is the total-loss case below, not a
rollback.

## Losing the whole database

The runbook is [read-rebuild-runbook.md](read-rebuild-runbook.md). In short:
the App reports the projection unavailable, an operator creates an empty
database and applies the read migrations, the Processor rebuilds from CORE and
the fixed inputs, and the old cursors are `context_expired`. CORE rows, CORE
digests and the DATA objects are untouched — that is the property the whole
separation exists for, and it is tested in
`services/processor/test/read-projection.test.ts` (G0-09, G3-12).

## Verified locally (synthetic data only)

| Acceptance                                                                                                                 | Where                                             |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| The schema: STRICT, no CORE foreign key, the instance guard                                                                | `packages/storage-d1/test/read-schema.test.ts`    |
| Identity, the retired-content rebuild, the racing start, G2-07, G2-08, G2-09 (late seal after a successor), G2-10          | `packages/storage-d1/test/read-writer.test.ts`    |
| The cursor codec and the pointer-only reader (G3-01, G3-03)                                                                | `packages/storage-d1/test/read-cursor.test.ts`    |
| The lane end to end on real D1: G2-05, G2-07, G2-11, G2-12, the attempt rebuild, and the total loss (G0-09, G3-12)         | `services/processor/test/read-projection.test.ts` |
| The routes: G3-01, G3-02, G3-03, G3-04, another baseline refused, and a saved report with every READ table dropped (G0-11) | `services/app/test/balances-v2-read.test.ts`      |
| The READ schema ledger is the generator's output and is built from its own directory                                       | `scripts/core-schema-ledger.test.ts`              |

Not verified: production volumes, a real second Worker racing the lease (the
displaced writer is simulated), R2 failure injection, and the retention of
stored inputs, whose collection is still left to a later maintenance workflow.
