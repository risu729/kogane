# The READ database

The balance read model can be deleted and rebuilt. This document is what that
means physically: a second D1 database, its schema, how a snapshot is
identified and published in it, which flags gate it, in what order it is
deployed, and what happens when it is lost (unified plan 04, 05; U11).

Since U16 the same database also holds the reward second stage of 04 §2 —
expiry estimates and replayed conversion simulations — under the same rules and
its own flag. Everything below about identity, publication, cursors and loss
applies to both; what is specific to rewards is in
[rewards.md](rewards.md#read-second-stage) and summarised under "The reward
second stage".

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

`packages/storage-d1/migrations/read/0001_read_baseline.sql` and
`0002_reward_read.sql`, generated into
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

Migration 0002 adds the reward second stage, table for table the same shape
(U16):

| Table                           | What it holds                                                                                                                                               |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reward_expiry_snapshots`       | One reward build: the baseline's content key and attempt, plus the fixed `evaluated_at`, the evaluation calendar, the rule-set digest and the claim window. |
| `reward_expiry_estimates`       | One estimated deadline per bucket and rule version, with a date-only `expires_on`, the amount at risk in the programme's own unit, and a `row_digest`.      |
| `reward_conversion_simulations` | One saved simulation, replayed when its request was retained and `not_reproducible` with a reason code when only its digest survived.                       |
| `reward_snapshot_input_refs`    | The rules, offers, claim set, evaluation clock and calendar the build was made from, each with a digest (04 §3).                                            |
| `reward_snapshot_pointer`       | What is published, and the watermark it was verified against.                                                                                               |
| `reward_build_checkpoints`      | Where a bounded reward build got to, per stage.                                                                                                             |

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

## The reward second stage

The identity rule is the baseline's with one addition that is the whole point:
**the evaluation instant is part of the content.** A reward capture reads the
rules, the current claims, the membership, the offers and the saved simulations
_and_ fixes the instant the deadlines are computed against, all inside the
content that is hashed. Consequences:

- the instant is the start of the captured UTC day (`YYYY-MM-DDT00:00:00.000Z`,
  calendar `UTC:start-of-day:assumed`), because the rules consume a calendar
  day and nothing reads a time of day. Two ticks of one day are therefore one
  input, and re-evaluating the same claims on a later day is a different input
  digest, a different content key and a new snapshot. The trigger refuses to
  change the published one, so "what did this say yesterday?" stays answerable
  (G2-19);
- a resumed build keeps the instant of its own stored input. An invocation that
  read the clock again would produce rows from two different "nows";
- the pointer is forward-only in two ways: never to an older source revision
  under one epoch, and — at the same revision — never to an older evaluation
  instant.

A saved simulation is replayed only when the stored row retained its request;
a row that kept nothing but a digest is written as `not_reproducible` with
`simulation_input_not_retained`, and one naming an offer version the input does
not carry as `offer_not_in_fixed_input`. Nothing recomputes a digest-only
simulation against today's offers (G2-20).

The CORE tables of migration 0033 are read, never written by this lane, and
`reward_programs`, `expiry_rules`, `conversion_offers`,
`reward_bucket_claims` and `membership_state_claims` stay in CORE as 04 §2
requires — they are versioned reference claims and provider claims, not a
projection. CORE migration 0041 adds them to the dependency ledger of 0038 so
the r0/r1 capture can see a rule or claim change. Migration 0042 removes the
two obsolete CORE projection tables. New reward inputs contain no legacy
simulation cache; archived inputs retain their captured replay semantics.

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

| Flag                             | Where          | Default | Effect                                                                         |
| -------------------------------- | -------------- | ------- | ------------------------------------------------------------------------------ |
| `BALANCE_PROJECTION_ENABLED`     | processor, app | `0`     | The existing A07 gate: nothing builds or reads the projection while it is off. |
| `REWARD_READ_PROJECTION_ENABLED` | processor      | `false` | The `reward_read_projection` lane runs and builds the reward snapshot (U16).   |

Production enables the remaining flags. Both writers and App readers use READ
exclusively; there is no storage-target switch.

## The resource

One D1 database named **`kogane-read`**, id
`320ebe31-a031-48a1-985f-0e6fabbd517a` (account `risu`, region APAC). It was
created on 2026-09-11 and has READ migrations through 0002 applied by CD. It is bound as `READ` in:

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
find this configuration.

## Deploy order and incident controls

GitHub Actions applies schema migrations, deploys Processor before App and
checks both through authenticated health. Writers need a compatible READ schema;
readers need a published snapshot. Production has both balance and reward
writers enabled. CORE migration 0042 retires the old projection tables after a
verified READ-only release.

Pause the Processor with `BALANCE_PROJECTION_ENABLED=0` and
`REWARD_READ_PROJECTION_ENABLED=false`. The App can hide balance or reward routes
with its corresponding feature flag. No flag restores a CORE projection path.
Choose schema-compatible releases for code rollback; reconstruct READ using
[the rebuild runbook](read-rebuild-runbook.md).

## Losing the whole database

The runbook is [read-rebuild-runbook.md](read-rebuild-runbook.md). In short:
the App reports the projection unavailable, an operator creates an empty
database and applies the read migrations, the Processor rebuilds from CORE and
the fixed inputs, and the old cursors are `context_expired`. CORE rows, CORE
digests and the DATA objects are untouched — that is the property the whole
separation exists for, and it is tested in
`services/processor/test/read-projection.test.ts` (G0-09, G3-12).

## Verified locally (synthetic data only)

| Acceptance                                                                                                                     | Where                                                    |
| ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| The schema: STRICT, no CORE foreign key, the instance guard                                                                    | `packages/storage-d1/test/read-schema.test.ts`           |
| Identity, the retired-content rebuild, the racing start, G2-07, G2-08, G2-09 (late seal after a successor), G2-10              | `packages/storage-d1/test/read-writer.test.ts`           |
| The cursor codec and the pointer-only reader (G3-01, G3-03)                                                                    | `packages/storage-d1/test/read-cursor.test.ts`           |
| The lane end to end on real D1: G2-05, G2-07, G2-11, G2-12, the attempt rebuild, and the total loss (G0-09, G3-12)             | `services/processor/test/read-projection.test.ts`        |
| The routes: G3-01, G3-02, G3-03, G3-04, another baseline refused, and a saved report with every READ table dropped (G0-11)     | `services/app/test/balances-v2-read.test.ts`             |
| The READ schema ledger is the generator's output and is built from its own directory                                           | `scripts/core-schema-ledger.test.ts`                     |
| U16 — the reward schema and writer: the fixed instant, the replay, the chunk, the displaced writer, the pointer (G2-19, G2-20) | `packages/storage-d1/test/reward-read-writer.test.ts`    |
| U16 — the reward lane end to end on real D1, and its total loss (G2-19, G2-20, G0-09)                                          | `services/processor/test/reward-read-projection.test.ts` |
| U16 — the reward routes: the published instant, the replay states, the cursor rules                                            | `services/app/test/rewards-v2-read.test.ts`              |

Not verified: production volumes, a real second Worker racing the lease (the
displaced writer is simulated), R2 failure injection, and the retention of
stored inputs, whose collection is still left to a later maintenance workflow.
