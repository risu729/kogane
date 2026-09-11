# Infrastructure ledgers

`infra/` holds the ledgers the reorganisation is measured against: what runtime resources exist,
what the CORE schema is, what every package resolves its dependencies to, and what must never be
deleted. Unified plan U01 (gate G0); chapters 04, 06, 07 §1 and §6, 15 §4–§5.

They exist because the next work items move directories. A move must not change a Worker name, a
Durable Object class or migration tag, an R2 bucket, a Queue, a cron, an Email route or a D1 id,
and it must not quietly change which dependency version a package resolves to or which tables are
considered safe to drop. A ledger nobody checks drifts, so two of the four are asserted by tests
that regenerate them and compare.

## The files

| file                             | what it records                                                                                                                                                                                                                                                                                                                                                                                                             | kept honest by                                                   |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `infra/resources.json`           | Machine ledger of every `wrangler*.jsonc` under `apps/`, `experiments/`, `poc/` and `services/`: Worker name, config path, D1/R2/KV bindings, Queue producers and consumers, Durable Object classes and migration tags, containers, browser and VPC bindings, service bindings, crons, `email()` handlers, asset directories, var and required-secret **names**, plus each directory's plan disposition and its live status | `scripts/resource-ledger.test.ts`                                |
| `infra/resources.md`             | The same content, readable: summary tables for D1, R2, Queues, DO classes and crons, then a section per directory                                                                                                                                                                                                                                                                                                           | same test (exact text comparison)                                |
| `infra/schema/core-ledger.json`  | Machine ledger of the CORE schema produced by applying every migration in `packages/storage-d1/migrations/core` to `bun:sqlite`: tables with columns, primary keys, foreign keys, indexes, triggers, `STRICT` and `WITHOUT ROWID` flags; views; triggers; indexes; per-migration statement counts and top-level `INSERT`s                                                                                                   | `scripts/core-schema-ledger.test.ts`                             |
| `infra/schema/core-ledger.md`    | The same content, readable: the 04 §2 classification per table with its `*_no_update` / `*_no_delete` guards, and the list of migrations that write rows                                                                                                                                                                                                                                                                    | same test (exact text comparison)                                |
| `infra/schema/read-ledger.json`  | The same, for the READ database of U11, produced from `packages/storage-d1/migrations/read`. The two directories are never mixed: each profile in the generator names its own                                                                                                                                                                                                                                               | `scripts/core-schema-ledger.test.ts`                             |
| `infra/schema/read-ledger.md`    | The readable READ ledger: which tables are the projection and which are the state of a build, and the proof that no foreign key names a CORE table                                                                                                                                                                                                                                                                          | same test (exact text comparison)                                |
| `infra/dependency-resolution.md` | The pre-workspace baseline: declared ranges and resolved versions per package, the dependencies that resolve to more than one version, and a closure digest per package                                                                                                                                                                                                                                                     | snapshot; regenerate on demand                                   |
| `infra/protection.md`            | The retention ledger: what must never be deleted, what may be rebuilt inside READ only, the D1 Time Travel and export runbook, the R2 rules, and the G0 acceptance-test mapping                                                                                                                                                                                                                                             | prose; the rows it points at are asserted by the two tests above |
| `infra/generated-files.json`     | Files a task writes instead of git tracking them, and the task that writes each one. A workspace whose `src/**` imports one must declare that task in its `typecheck`, `test` and `dry-run` `depends` (see [CI](ci.md#generated-inputs))                                                                                                                                                                                     | `tasks/_lib/check-manifests.test.ts`                             |

## Regenerating

```sh
mise run ledger:resources   # infra/resources.json, infra/resources.md
mise run ledger:schema      # infra/schema/core-ledger.{json,md} and read-ledger.{json,md}
mise run ledger:deps        # infra/dependency-resolution.md
```

The generators own the exact bytes of the five generated files, so `.oxfmtrc.json` excludes them
from the formatter: regenerating is enough, there is no second formatting step, and the tests can
compare byte for byte instead of structurally. A new generated ledger has to be added to that
ignore list deliberately.

The generators keep their bodies under `scripts/`; the three tasks above are their only entry
points (decision D4). Their test suites run in `mise run ci:root`, which the CI lint job invokes:
the `root:test` task runs the `scripts/` and `tasks/_lib/` directories rather than a list, so a
new ledger suite joins CI by existing.

## What the tests actually enforce

`scripts/resource-ledger.test.ts`

- the committed JSON equals a fresh read of every config, and the committed markdown equals a
  fresh render — so editing a wrangler config without regenerating fails CI (G0-06);
- every wrangler config tracked by git appears in the ledger, and every `services/*` and `poc/*`
  directory carries a disposition — a new directory or a new config cannot be invisible;
- no config declares a resource-bearing key the generator does not extract, so adding a new
  binding type (KV, Vectorize, Workflows, `send_email`, …) forces the ledger to grow with it;
- every Durable Object class has a migration tag or an explicit sqlite export (G0-07);
- the live workers and buckets of the recorded account inventory are all accounted for, and a
  directory is marked live exactly when one of its configs names a live Worker or bucket (G0-12).

`scripts/core-schema-ledger.test.ts`

- the committed JSON and markdown equal a fresh dump of the migrations, so a new migration must
  update the ledger;
- every table the migrations create has a classification and the classification map has no stale
  names — a new table cannot fall outside the retention decision (G0-01);
- the `unclassified-keep` and `read-candidate` sets are asserted by name, so nothing slides from
  "kept" to "may be dropped" without the diff showing it;
- every table is `STRICT`, and the append-only `*_no_update` / `*_no_delete` guards of the
  evidence, observation and publication tables are still there;
- the statement splitter round-trips: replaying each split statement rebuilds the same set of
  schema objects, which is what makes the seed/backfill inventory of 06 §1 trustworthy.

## Reading the classification

Chapter 04 §2 splits the CORE tables four ways, and `infra/schema/core-ledger.md` uses the same
four labels:

- `core-keep` — history and evidence that stays in CORE. Past parse results are not a cache.
- `read-candidate` — named by 04 §2 as moving to READ in U11 (or U16 for the second stage). They
  are still in CORE today.
- `operational-mutable` — job, replay, work-item and lane state. Rows are mutable by design; the
  tables stay in CORE until checkpoints and intake are separated.
- `unclassified-keep` — not named by 04 §2. The chapter's own rule is that the default is to keep
  them, so they are protected until somebody classifies them on purpose.

A separate `appendOnly` flag per table is derived from the triggers rather than from the label, so
the ledger reports the schema's actual mutability instead of an intention.

`infra/schema/read-ledger.md` uses two labels of its own, because every table in that database is
rebuildable and the CORE vocabulary does not apply:

- `read-projection` — the projection of one fixed input and the CORE references it was built from.
- `read-operational` — the state that drives a build: the published pointer, the checkpoints, and
  the identity of the physical database.

Neither is a retention decision. Losing the whole READ database costs a rebuild and every open
cursor, and nothing else (`docs/read-rebuild-runbook.md`, G0-09).

## Limits

- The live column of the resource ledger is a recorded read of the Cloudflare account from
  2026-09-11, not a live query: the check stays offline and deterministic. Re-read the account and
  update `LIVE_INVENTORY` in `scripts/resource-ledger.ts` when it changes.
- Queues, Durable Object namespaces, cron triggers and Email routes were not listable through that
  API. The ledger proves what the repository declares; it does not prove what the account runs.
- `infra/dependency-resolution.md` is a snapshot with no CI guard. It is the "before" half of the
  diff U03 owes, and the lockfiles it reads are replaced by that work item.
- Nothing in `infra/protection.md` has been executed. It is a reviewed runbook, not a record of a
  restore.
