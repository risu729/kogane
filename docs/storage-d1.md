# `packages/storage-d1`: CORE database access

Unified plan **U05** (chapters 02 §3, 04, 06 §2, 09 §2–3; decisions D2, D3, D11).

Until this change, three deployed Workers each held part of the CORE SQL.
`kogane-ingest` owned registration, cataloguing and sealing; the observation
pipeline owned the publication gate, the identity projection and the decision
outbox; `packages/application` owned the change lifecycle but reached the
database through its own adapter. Nothing was wrong with any one of them. The
problem was that the App and the Processor could not both perform the same
write without either an HTTP hop or a second copy of the statements — and a
second copy of "move the adoption pointer" or "seal this run" is a second
answer to what readers see.

This package is that one copy. It is pure TypeScript: no Cloudflare `Env`, no
wrangler, no HTTP, no `@cloudflare/workers-types`. It binds against a
structural `D1Like` (`src/d1.ts`) that a real `D1Database` satisfies
unchanged, the same way `packages/read-model` already did.

**Deploy order for the change that introduced it: none.** No migration, no
flag, no binding and no resource identity changed. It is a move of code
between modules, proved by the parity and byte-identity tests listed at the
end. Rollback is reverting the commits.

## Layout

```
packages/storage-d1/
  migrations/core/      0001…0037, moved byte-for-byte from services/raw-evidence
  migrations/read/      empty; U11 adds 0001_read_baseline.sql
  src/d1.ts             D1Like, D1StatementLike, first/all/run/statement/runBatch
  src/migrations.ts     where the two directories are, named once
  src/core/             one module per group of CORE tables
  src/codecs/           column ⇄ value conversions
  src/atomic/           guarded batches: whole commands, not CRUD
```

### `src/core/`

| Module                                                                                                     | Owns                                                                                                  | Came from                                      |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `ingest-registry.ts`                                                                                       | `ingest_clients`, `active_ingest_routes`, run lookup                                                  | `services/raw-evidence/src/http.ts`            |
| `raw-objects.ts`                                                                                           | `raw_objects`, `raw_object_verification_events`                                                       | `services/raw-evidence/src/store.ts`           |
| `fetch-runs.ts`                                                                                            | `acquisition_sessions`, `fetch_runs`, `fetch_run_reports`                                             | `services/raw-evidence/src/store.ts`           |
| `structure.ts`                                                                                             | `fetch_run_ranges`, `fetch_page_groups`, `fetch_units`, `fetch_unit_reports`                          | `services/raw-evidence/src/structure.ts`       |
| `artifacts.ts`                                                                                             | `fetch_artifacts` and its ranges, transform steps and relations                                       | `services/raw-evidence/src/store.ts`           |
| `origins.ts`                                                                                               | `http_scope_rules`, `origin_template_policies`, the four `artifact_*_metadata` tables                 | `services/raw-evidence/src/origins.ts`         |
| `inventories.ts`                                                                                           | `run_inventories`, `run_inventory_items`, `fetch_run_seals`, `ingestion_attempts`                     | `services/raw-evidence/src/store.ts`           |
| `identity-store.ts`, `identity-commands.ts`, `identity-keys.ts`, `identity-audit.ts`, `identity-policies/` | the identity projection and its decision commands                                                     | `services/observation-pipeline/src/`           |
| `decision-outbox.ts`                                                                                       | `decision_outbox` dispatch and the receipt's `accepted → published` transition                        | `services/observation-pipeline/src/`           |
| `operations.ts`                                                                                            | the expected-revision expression over `account_mappings` / `instrument_mappings` / `entity_relations` | `packages/application/src/operations/sql.ts`   |
| `command-store.ts`                                                                                         | the D1 adapter that turns a `{sql, binds}` list into one batch                                        | `packages/application/src/operations/store.ts` |

Every SQL string moved unchanged. Where a module's old path is still imported,
the service keeps a re-export shim naming the new home
(`docs/package-layout.md`).

### `src/codecs/`

Four conversions, each with a value it must never produce (09 §4):

| Codec            | Columns                               | Must never produce                                             |
| ---------------- | ------------------------------------- | -------------------------------------------------------------- |
| `decimal.ts`     | `coefficient` TEXT, `scale`, `status` | zero for a missing, unparsed or conflicting amount (INV05)     |
| `date-only.ts`   | `YYYY-MM-DD` TEXT                     | a shifted calendar day, or a neighbouring day for `2026-02-30` |
| `boolean.ts`     | `0` / `1`                             | `true` for an unreadable flag — `Boolean("0")` is `true`       |
| `nullable-id.ts` | nullable `INTEGER` references         | row `0` for a NULL reference                                   |

The decimal coefficient is an arbitrary-precision integer stored as TEXT. It
is never a JS number and never a float column, and a row whose status says
`exact` but whose columns are not a valid decimal-v1 pair decodes as
`conflict` — "the stored value cannot be read" — rather than as a number
nobody wrote. `packages/read-model`'s balance projection encodes its columns
through this codec so the rule is stated once.

### `src/atomic/`

A guarded batch is one command, not a set of CRUD calls. These stay **native
SQL** and will not be ported to an ORM (09 §2, decision D11):

| Command              | What it commits atomically                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| `seal.ts`            | the run inventory, its items, the seal and the ingestion attempt                                      |
| `publication.ts`     | `status='ok'`, supersession, the publication event, the adoption pointer and the job close            |
| `decision-commit.ts` | the operation receipt reservation, the mutation, the approval use, the plan close and the outbox rows |

Two facts decide the shape of all three:

1. **A preceding SELECT is not a guard.** Reading a revision and then writing
   is a TOCTOU: a concurrent commit can move it in between. Every precondition
   is therefore a condition of the _writing_ statement.
2. **D1 rolls a batch back on an SQL error, not because a conditional INSERT
   matched zero rows.** A batch does not stop when its first statement writes
   nothing, so each later statement restates the guard (`EXISTS(… receipt …)`,
   the inventory's identifying columns, the live lease). Without that, a
   failed guard would leave a partial write — exactly what G2-14 forbids.

The publication statements also carry a lease fence and a "not already the
pointer" guard, so a replayed publish batch appends no second event and does
not rewrite `published_at`.

### What stays native SQL, and why

Simple selects, filters, pagination and simple projection writes are
candidates for the Drizzle pilot (U12). These are not:

- the three atomic commands above, and any future one;
- the publication gate views (`publication_gate_gaps`,
  `publication_gate_mismatches`) and the snapshot CTEs — query-plan-sensitive
  reads whose shape is asserted by `EXPLAIN QUERY PLAN` tests;
- anything expressed with `json_each`, window functions, `STRICT` /
  `WITHOUT ROWID` semantics, partial indexes, triggers or views. A table
  declaration cannot express them; the SQL and a behavioural test can.

`sql<T>` is a type assertion, not runtime validation. Decoding a row is the
codecs' job.

## Migration directories

CORE migrations moved with `git mv` from `services/raw-evidence/migrations/`
to `migrations/core/`. Filenames, numbers and bytes are unchanged, because D1
records the applied history by filename: re-applying a rewritten `0001` would
be a different database. Existing files are immutable; the move was the one
allowed path change (09 §2, decision D3).

`migrations/read/` is empty on purpose. READ is a separate database with a
separate history starting again at `0001`; keeping the two directories apart
is what stops a job applying or resetting the wrong one.

Consumers repointed by this change:

| Consumer                                                                 | What it uses the directory for        |
| ------------------------------------------------------------------------ | ------------------------------------- |
| `services/raw-evidence/wrangler.jsonc`                                   | `migrations_dir`                      |
| `services/observation-pipeline/wrangler.jsonc`                           | `migrations_dir`                      |
| `services/raw-evidence/vitest.config.ts`                                 | `readD1Migrations` for the test D1    |
| `services/evidence-browser/vitest.config.ts`                             | `readD1Migrations` for the test D1    |
| `services/observation-pipeline/test/harness.ts`                          | `layerBMigrations()`                  |
| five pipeline tests reading one migration file                           | query-plan and schema assertions      |
| `packages/read-model/test/{events,identity,read-model}`                  | applying CORE to `bun:sqlite`         |
| `packages/observation-shared/test/normalized-decimal`                    | the 0024 views                        |
| `poc/observation-pipeline/src/store.ts` and its test                     | the 0024/0025/0037 views              |
| `scripts/publication-gate-predicates.test.ts`                            | the "no legacy rule after 0026" guard |
| `services/raw-evidence/scripts/{deploy.sh,generate-decimal-triggers.ts}` | digests and trigger generation        |
| `scripts/core-schema-ledger.ts`                                          | the CORE schema ledger (U01)          |

Only the deploy job applies migrations to production. Tests apply them from
the directory, never from a checked-in schema dump.

## Registration moved with it

`packages/application/src/ingest/` holds the use cases that used to live in
`kogane-ingest`: register a run, record its reports and structure, store an
object, catalogue an artifact, stage and seal an inventory, record an attempt.
They take a parsed request body rather than a `Request`, because a Processor
registering a terminal run has no request to hand them.

`RunRegistrationPort` (`src/ingest/port.ts`) is the operation set both callers
implement: `CentralClient` over the legacy HTTP protocol, and
`directRegistrationPort` in-process. `services/raw-evidence` is now only the
adapter decision D2 keeps deployed — routing, authentication and status codes.

## What is verified, and how

All of it with synthetic data, locally. Nothing here was run against
production.

| Claim                                                                                              | Test                                                                                                           |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| G0-02: the CORE migrations kept their names, numbers and bytes                                     | `packages/storage-d1/test/migrations.test.ts`                                                                  |
| G2-14: a guard matching 0 rows leaves no receipt, decision, approval use, plan close or outbox row | `packages/storage-d1/test/decision-commit.test.ts`                                                             |
| G2-15: a revision that moved between approve and commit makes the whole command fail               | same file                                                                                                      |
| G2-16: the immutability triggers still refuse a rewrite of what a commit wrote                     | same file                                                                                                      |
| The codecs never produce zero, a shifted day, a false `true` or row 0                              | `packages/storage-d1/test/codecs.test.ts`                                                                      |
| The HTTP route and the in-process port register identically                                        | `services/raw-evidence/test/registration-parity.test.ts`                                                       |
| The ingest wire protocol is unchanged                                                              | `services/raw-evidence/test/{api,schema,source-usecases,evidence-contract}.test.ts` and the nine route scripts |
| The publication gate's writers and counts are unchanged                                            | `scripts/publication-gate-predicates.test.ts`, `services/observation-pipeline/test/publication-gate.test.ts`   |
| No package imports a service back                                                                  | `scripts/import-boundaries.test.ts`                                                                            |

## Flags, deploy order, rollback

- **Flags:** none. This change introduces no feature flag and turns none on.
- **Deploy order:** none — no schema, binding, resource name or wire format
  changed. Whenever the Workers are next deployed, any order works.
- **Rollback:** revert the commits. There is no data to undo.
- **Manual settings required:** none.
