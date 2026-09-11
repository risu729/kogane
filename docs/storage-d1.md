# `packages/storage-d1`: CORE database access

Unified plan **U05** (chapters 02 §3, 04, 06 §2, 09 §2–3; decisions D2, D3, D11),
extended by **U12**, whose Drizzle pilot has its own section below.

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
  migrations/core/      0001…0037 moved byte-for-byte from services/raw-evidence; 0039 (U08), 0040 (U06) and later land here
  migrations/read/      empty; U11 adds 0001_read_baseline.sql
  src/d1.ts             D1Like, D1StatementLike, first/all/run/statement/runBatch
  src/migrations.ts     where the two directories are, named once
  src/core/             one module per group of CORE tables
  src/codecs/           column ⇄ value conversions
  src/atomic/           guarded batches: whole commands, not CRUD
  src/drizzle/          the U12 pilot: a schema mirror and the reads that moved
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
| `identity-store.ts`, `identity-commands.ts`, `identity-keys.ts`, `identity-audit.ts`, `identity-policies/` | the identity projection and its decision commands                                                     | `services/processor/src/`                      |
| `decision-outbox.ts`                                                                                       | `decision_outbox` dispatch and the receipt's `accepted → published` transition                        | `services/processor/src/`                      |
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

Simple selects, filters, pagination and simple projection writes were the
candidates for the Drizzle pilot; six of them moved (see "Drizzle pilot"
below). These did not, and will not:

- the three atomic commands above, and any future one;
- the publication gate views (`publication_gate_gaps`,
  `publication_gate_mismatches`) and the snapshot CTEs — query-plan-sensitive
  reads whose shape is asserted by `EXPLAIN QUERY PLAN` tests;
- anything expressed with `json_each`, window functions, `STRICT` /
  `WITHOUT ROWID` semantics, partial indexes, triggers or views. A table
  declaration cannot express them; the SQL and a behavioural test can.

`sql<T>` is a type assertion, not runtime validation. Decoding a row is the
codecs' job.

## Drizzle pilot

Unified plan **U12** (chapter 09, decision D11; acceptance G2-16, G2-17, G4-11,
G4-12). `drizzle-orm@0.45.2` — the stable line, not the 1.x release candidate —
is a dependency of **this package only**, and `drizzle-kit` is not installed.

The question the pilot exists to answer is narrow: can a typed query builder
take over the reads where SQL adds nothing, without becoming a second opinion
about what the data means? Everything below is the evidence, including the
parts that argue against widening it.

### What was added

```
src/drizzle/
  schema/core.ts    fifteen tables as sqliteTable declarations — a mirror of the SQL
  columns.ts        customType columns backed by ../codecs/: money, date-only, flags, row ids
  client.ts         coreDrizzle(db: D1Like) — one factory, one schema
  raw-objects.ts    the pilot's reads and one append, beside ../core/raw-objects.ts
  ingest-registry.ts, artifacts.ts, fetch-runs.ts
```

`src/d1.ts` gained one method on `D1StatementLike`: `raw()`, which returns rows
as positional arrays. A real `D1PreparedStatement` has always had it; the ORM's
row mapper reads every projected select and every `RETURNING` that way, and
`test/sqlite.ts` implements it over `bun:sqlite`. Nothing in `src/core/` or
`src/atomic/` uses it. Every `D1Like` a test hands to the pilot is either that
adapter or a real D1 (the `services/raw-evidence` suite runs the switched reads
on the Workers runtime through `@cloudflare/vitest-plugin`), so `raw()` is
exercised on both. The mapper coerces nothing: a NULL stays `null` before any
column type sees it, `integer()` and `text()` columns return the driver value
untouched, and the codec-backed columns below raise on anything they cannot
read. The `id` columns the six reads return are rowids; no column that could
exceed 2^53 (a decimal coefficient) is read as a number on either path.

`services/raw-evidence/tsconfig.json` gained `skipLibCheck: true`, which every
package `tsconfig` in the repository already had. Without it, `tsc` on
TypeScript 7.0.2 reports 85 errors, all inside `drizzle-orm`'s own declaration
files (`gel-core`, `mysql-core`, `pg-core`, `singlestore*`, `sqlite-core`,
`d1/driver.d.ts`): `Buffer` without `@types/node`, optional peer modules that
are not installed (`gel`, `mysql2/promise`, `@miniflare/d1`) and `keyof this`
constraints TypeScript 7 rejects — none in repository code. The Worker's own
sources are still checked in full. `services/app` keeps checking
library declarations and still passes, because `packages/application/src/index.ts`
does not export the ingest use cases; a Worker that starts importing them
without `skipLibCheck` will meet the same 85 errors.

### The parity guard

A hand-written mirror of an immutable schema drifts, and neither direction of
drift is a type error: a column added in SQL and not here is invisible, and a
property renamed here compiles and then fails in production as "no such
column". So the mirror is not trusted — it is checked.

`test/drizzle-schema-parity.test.ts` applies **all** the CORE migrations to
`bun:sqlite` exactly as wrangler applies them, reads every declared table back
with `PRAGMA table_info`, and compares:

| Compared                                | Rule                                                                                                                                         |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| the table exists, as a table            | a declaration naming a view or nothing at all fails                                                                                          |
| the table is `STRICT`                   | so the compared affinity is the storage class the database enforces; every declared type is one STRICT accepts                               |
| column names, both directions           | a column in SQL and not in the mirror fails; a column in the mirror and not in SQL fails                                                     |
| declared type, as SQLite's **affinity** | `INTEGER` and `int` are the same column; TEXT where SQL has INTEGER is not                                                                   |
| NOT NULL                                | equal, except the rowid alias — exactly `INTEGER PRIMARY KEY` on a rowid table — which SQLite reports nullable and no row ever holds NULL in |
| the primary key and its column order    | including the composite keys of `published_parse_runs`, `ops_request_stages` and the decimal table                                           |
| the declared default                    | `'default'`, `'unknown'`, `'single'`, `0`, `1` — compared at driver level, so `flag` maps `true` to 1                                        |

Fifteen tables, 809 assertions. The tables are enumerated from the schema
module rather than listed, so a declaration that is added and forgotten is
still compared; a separate assertion pins the list itself, so deleting one is a
failure rather than a silent narrowing.

**Only declared tables are compared.** CORE creates 102 tables and the mirror
declares the fifteen the pilot reads, writes or asserts immutability on. A table
that exists in SQL without a declaration is scope, not drift, and is not a
failure; a table that _must_ be mirrored is one the pinned list names. Widening
the pilot means adding the declaration and the list entry together.

What a declaration _cannot_ express is not compared and not claimed:
every CHECK constraint, the triggers, the partial and unique indexes, the views
and the foreign keys stay in SQL and are proved by behaviour
(`test/drizzle-immutability.test.ts`, `test/seal.test.ts`,
`test/decision-commit.test.ts`).

### Which call sites switched

A query moved only after its Drizzle twin returned the same rows **and** ran
the same plan. `test/drizzle-equivalence.test.ts` runs both halves against one
database — the whole CORE schema plus the synthetic fixture of
`test/core-fixture.ts` — and compares three things: the answer, the
`EXPLAIN QUERY PLAN` of every statement each half actually issued, and how many
statements and bound values each used. The statements are recorded from the
`D1Like` the halves are handed, not copied into the test, so the plan compared
is the plan of the SQL that ran.

| Query                    | Table                            | Plan (both halves, identical)                                                                     | Call site now                                     |
| ------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `readRawObjectRecord`    | `raw_objects`                    | `SEARCH raw_objects USING INDEX sqlite_autoindex_raw_objects_1 (sha256=?)`                        | `packages/application/src/ingest/objects.ts`      |
| `readRecentVerification` | `raw_object_verification_events` | `SEARCH … USING INDEX idx_raw_object_verification (sha256=? AND checked_at_ms>?)`                 | `packages/application/src/ingest/objects.ts`      |
| `ingestClientActive`     | `ingest_clients`                 | `SEARCH ingest_clients USING INDEX sqlite_autoindex_ingest_clients_1 (id=?)`                      | `packages/application/src/ingest/access.ts`       |
| `readFetchRun`           | `fetch_runs`                     | `SEARCH fetch_runs USING INTEGER PRIMARY KEY (rowid=?)`                                           | `packages/application/src/ingest/access.ts`       |
| `readRunCatalogue`       | `fetch_artifacts`                | `SEARCH fetch_artifacts USING COVERING INDEX sqlite_autoindex_fetch_artifacts_2 (fetch_run_id=?)` | `packages/application/src/ingest/seal.ts`         |
| `readRunReport`          | `fetch_run_reports`              | `SEARCH … USING INDEX sqlite_autoindex_fetch_run_reports_1 (fetch_run_id=? AND report_key=?)`     | `packages/application/src/ingest/registration.ts` |

The native twins in `src/core/` are unchanged and still exported; the switch is
one import line per file. Each pair issues exactly one statement. Drizzle binds
up to two more values per statement — it parameterises the row limit and the
`1` of `active = 1`, which the native statements write as literals — and never
fewer, which would mean a dropped filter.

The four cases the plan asks a pilot to break (09 §7) are in the fixture rather
than in prose: the terminal report leaves eleven nullable columns empty, the two
artifact keys differ only in case so a BINARY ordering and a case-insensitive
one disagree, two verification events share a millisecond so "most recent" is
decided by the id tiebreaker, and `byte_size` 0 is a size rather than an absence.

### What did not switch, and why

| Kept native                                                                         | Reason                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `insertVerificationEvent` (the append the pilot also implemented)                   | Drizzle wraps a driver error in one whose message is the SQL **and every bound value**. A read's binds are the lookup key the caller already holds; a write's binds are the content being recorded, and that error can reach a log. Asserted, not assumed: `test/drizzle-equivalence.test.ts`                                                                       |
| `insertRawObjectIfAbsent`, `insertRunReportIfAbsent`, the other conditional inserts | `INSERT … SELECT … WHERE NOT EXISTS` **is** the guard. Splitting it into a read and a write is the TOCTOU those statements exist to close                                                                                                                                                                                                                           |
| `ingestRouteActive`                                                                 | `active_ingest_routes` is a view                                                                                                                                                                                                                                                                                                                                    |
| `ops_requests` / `ops_request_stages` writes                                        | They live in `packages/application` behind the `CommandStore` port, which is a transport-neutral `{sql, binds}` list that the App and the Processor share. An ORM handle in that package would be a database driver in a package that deliberately has none. The tables are still in the mirror, parity-checked, and are the subject of the immutability test below |
| everything in `src/atomic/`                                                         | A guarded batch is one command. Unchanged by this PR and not a candidate                                                                                                                                                                                                                                                                                            |

### Immutability through the ORM (G2-16)

`db.update(...)` and `db.delete(...)` are ordinary methods, and nothing in a
table declaration says a table is append-only — a declaration cannot say it.
`test/drizzle-immutability.test.ts` attempts each mutation through Drizzle and
requires the database to refuse it by name, then re-reads the row to show
nothing was written on the way to the refusal:

| Attempt through Drizzle                                      | Refused by                                                                           |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| update / delete `raw_objects`                                | `raw_objects is append-only`                                                         |
| update / delete `fetch_artifacts`                            | `fetch_artifacts is append-only`                                                     |
| update / delete `observation_decimal_values`                 | `versioned decimal values are immutable`                                             |
| delete `ops_requests`, or re-insert an accepted id           | `operations requests are append-only`, `operations request replacement is forbidden` |
| rewrite an accepted request's payload digest                 | `operations request is immutable except its progress`                                |
| turn a `completed` stage back into `pending`, delete a stage | `a completed stage is never reopened`, `operations stages are append-only`           |

The same test also shows the half that must still work: a request's
`dispatch_state` and attempt count move forward through the ORM, because
`ops_requests` is progress-mutable by design.

### Money and dates through the ORM (G4-11, G4-12)

The failure to guard against here is not an exception; it is a query that works
and is wrong. A coefficient of thirty digits arriving as
`1.2345678901234568e+29`, an `unparsed` amount arriving as `0`, a statement
date arriving as a `Date` at UTC midnight and displaying as the previous day in
Tokyo — each is a plausible ORM default and none is the stored fact.

So four column types in `src/drizzle/columns.ts` call the same functions in
`src/codecs/` that the native path calls, and produce the domain's types rather
than JavaScript's:

| Column type                           | Produces                         | Refuses                                                       |
| ------------------------------------- | -------------------------------- | ------------------------------------------------------------- |
| `decimalCoefficient` / `decimalScale` | `string` / non-negative `number` | a numeric coefficient; a fractional or negative scale         |
| `valueStatus`                         | a decimal-v1 status              | reading an unknown status as `exact` — it reads as `conflict` |
| `dateOnly`                            | `CivilDate` (`{year,month,day}`) | `2026-02-29`, an RFC 3339 instant, a number — and any `Date`  |
| `flag`                                | `boolean`                        | `"0"`, which `Boolean(...)` calls `true`                      |
| `rowId`                               | a positive safe integer          | `0` and other ids no `INTEGER PRIMARY KEY` ever produced      |

`test/drizzle-codecs.test.ts` reads real rows through them: a 30-digit
coefficient comes back digit for digit and decodes through `decodeDecimal` to
the same `ValueState` the native path produces; an `unparsed` row keeps both
columns NULL and decodes as `unparsed`, never as zero; a date-only window
round-trips as `{year: 2024, month: 2, day: 29}` and writes back the bytes
`2024-02-29`; an absent window is null rather than an epoch.

### Pilot pass criteria (09 §7), with results

| Criterion                                   | Result                                                                                                                                                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NULL                                        | **Pass** — eleven nullable columns of a terminal report, and `byte_size` 0, survive both paths identically                                                  |
| boolean                                     | **Pass** — `ingest_clients.active` filters through the codec; `creation_complete` reads as a boolean                                                        |
| decimal text                                | **Pass** — 30-digit coefficient, exact, as text (G4-11)                                                                                                     |
| date-only                                   | **Pass** — `CivilDate` in, `YYYY-MM-DD` out, leap day included (G4-12)                                                                                      |
| ordering                                    | **Pass** — BINARY order on keys differing only in case; the `ORDER BY … DESC, id DESC` tie                                                                  |
| query plan                                  | **Pass** — every plan identical, literally, statement by statement                                                                                          |
| bind / query count                          | **Pass with a note** — one statement per read on both sides; Drizzle binds up to two more values per statement, all of them literals the native SQL inlines |
| trigger replace/delete refusal              | **Pass** — G2-16 above                                                                                                                                      |
| JSON                                        | **Not attempted** — no `json_each` query moved; JSON stays native by decision                                                                               |
| error rollback, guard 0 rows, expired lease | **Not attempted** — no batch, guard or lease moved; `src/atomic/` is out of scope by decision                                                               |
| candidate rows stay unpublished             | **Not attempted** — the publication-gate views did not move                                                                                                 |
| **bundle size**                             | **The cost.** `kogane-ingest` grew from 113.93 KiB (20.81 KiB gzip) to 305.03 KiB (57.40 KiB gzip) — a 2.7× upload for six single-table reads               |

The bundle number is the finding that matters for whether this widens. Where
the 191 KiB went, from an esbuild metafile of the same entry (`src/worker.ts`,
unminified, as `wrangler deploy` builds it):

| Part of the bundle                                                        | Bytes in output | Note                                                                                               |
| ------------------------------------------------------------------------- | --------------: | -------------------------------------------------------------------------------------------------- |
| `drizzle-orm/sqlite-core` (dialect, select/insert/update/delete builders) |          99,523 | reached statically from `drizzle-orm/d1`; the bundler cannot drop a builder the dialect references |
| `drizzle-orm` root (`relations`, `utils`, `alias`, `subquery`, entity)    |          28,275 |                                                                                                    |
| `drizzle-orm/sql`                                                         |          14,615 | the SQL template and parameter binding                                                             |
| `drizzle-orm/pg-core`                                                     |          12,983 | not used here; drizzle's own `relations.js` and `sql/sql.js` import two Postgres modules           |
| `drizzle-orm/d1`, `cache`, `query-builders`                               |           8,151 |                                                                                                    |
| `src/drizzle/schema/core.ts` — all fifteen tables                         |           9,269 | the whole mirror                                                                                   |
| `src/drizzle/columns.ts`, `client.ts` and the four read modules           |           4,292 |                                                                                                    |

So the growth is the ORM's runtime (~160 KiB), not the schema file. Trimming
the mirror per call site — importing only the six tables a Worker reads — would
save under 7 KiB of 305 and was **not** done: `drizzle-orm` already declares
`sideEffects: false`, the query builders the bundler keeps are the ones the
dialect references, and the fifteen declarations are what the parity guard
compares. Context for the number: a Worker script may be 3 MiB gzipped on the
free plan and 10 MiB on paid; this one uploads 57.40 KiB gzipped. No Worker in
this repository minifies its bundle; with `minify` the same entry is 143.8 KiB
(36 KiB gzipped), recorded here and not enabled, because that is a deployment
setting for every Worker and not a decision for this pilot.

The increase is comfortably inside the limit, and it buys typed columns and a
parity guard on a Worker that D2 retires at U15 anyway; it would want
re-measuring before the ORM reaches a Worker with a tighter budget. Nothing here
argues for replacing the native path where the native path is the guarantee.

### Rules that survive the pilot

- **Wrangler owns migration history.** No `drizzle-kit push`, `generate` or
  `reset`, against any database, ever. The declarations are generated from
  nothing and applied to nothing.
- **`sql<T>` is an assertion, not validation.** It is not used in the pilot;
  where a row must be interpreted, `src/codecs/` interprets it.
- **The ORM's types stay in this package.** No `packages/domain` type, HTTP
  schema or DTO is derived from a `sqliteTable`, and no caller's signature
  mentions Drizzle. `coreDrizzle` takes the same `D1Like` everything else takes.
- **A new query moves only with its evidence**: an equivalence case, a plan
  comparison, and a line in the table above.

## Migration directories

CORE migrations moved with `git mv` from `services/raw-evidence/migrations/`
to `migrations/core/`. Filenames, numbers and bytes are unchanged, because D1
records the applied history by filename: re-applying a rewritten `0001` would
be a different database. Existing files are immutable; the move was the one
allowed path change (09 §2, decision D3).

Migrations written straight into `migrations/core/` after the move have no
bytes at the old path, so `test/migrations.test.ts` compares them against its
recorded digest only, and lists them in `INTRODUCED_AT_THE_NEW_PATH` so the
git-history check knows there is nothing to compare rather than reporting them
missing. `0039_collection_runs.sql` (U08, shared-R2 terminal registration —
see `docs/processor.md`) is the first of them.

`migrations/read/` is empty on purpose. READ is a separate database with a
separate history starting again at `0001`; keeping the two directories apart
is what stops a job applying or resetting the wrong one.

Consumers repointed by this change:

| Consumer                                                                 | What it uses the directory for        |
| ------------------------------------------------------------------------ | ------------------------------------- |
| `services/raw-evidence/wrangler.jsonc`                                   | `migrations_dir`                      |
| `services/processor/wrangler.jsonc`                                      | `migrations_dir`                      |
| `services/raw-evidence/vitest.config.ts`                                 | `readD1Migrations` for the test D1    |
| `services/app/vitest.config.ts`                                          | `readD1Migrations` for the test D1    |
| `services/processor/test/harness.ts`                                     | `layerBMigrations()`                  |
| five pipeline tests reading one migration file                           | query-plan and schema assertions      |
| `packages/read-model/test/{events,identity,read-model}`                  | applying CORE to `bun:sqlite`         |
| `packages/application/test/sqlite-store.ts`                              | applying CORE to `bun:sqlite` (U06)   |
| `packages/observation-shared/test/normalized-decimal`                    | the 0024 views                        |
| `poc/observation-pipeline/src/store.ts` and its test                     | the 0024/0025/0037 views              |
| `tasks/_lib/publication-gate-predicates.test.ts`                         | the "no legacy rule after 0026" guard |
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

| Claim                                                                                                                                                                                     | Test                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| G0-02: the CORE migrations kept their names, numbers and bytes                                                                                                                            | `packages/storage-d1/test/migrations.test.ts`                                                                  |
| G2-14: a guard matching 0 rows leaves no receipt, decision, approval use, plan close or outbox row                                                                                        | `packages/storage-d1/test/decision-commit.test.ts`                                                             |
| G2-14: a seal whose inventory key does not match leaves no item, seal or attempt; a replayed attempt aborts the whole batch                                                               | `packages/storage-d1/test/seal.test.ts` (whole CORE schema, foreign keys on)                                   |
| G2-15: a revision that moved between approve and commit makes the whole command fail                                                                                                      | same file                                                                                                      |
| G2-16: the immutability triggers still refuse a rewrite of what a commit wrote                                                                                                            | same file                                                                                                      |
| G4-11: a coefficient beyond 2^53 stays text, an unsafe scale or id is a conflict, never rounded                                                                                           | `packages/storage-d1/test/codecs.test.ts`                                                                      |
| G4-12: a date-only value round-trips as a calendar triple, never a `Date` or an instant; NULL stays null                                                                                  | `packages/storage-d1/test/codecs.test.ts`                                                                      |
| The codecs never produce zero, a shifted day, a false `true` or row 0                                                                                                                     | `packages/storage-d1/test/codecs.test.ts`                                                                      |
| The HTTP route and the in-process port write the same rows (every column of every table touched, minus ids and clocks) and refuse a revoked route or client with the same status and code | `services/raw-evidence/test/registration-parity.test.ts`                                                       |
| The ingest wire protocol is unchanged                                                                                                                                                     | `services/raw-evidence/test/{api,schema,source-usecases,evidence-contract}.test.ts` and the nine route scripts |
| The publication gate's writers and counts are unchanged                                                                                                                                   | `tasks/_lib/publication-gate-predicates.test.ts`, `services/processor/test/publication-gate.test.ts`           |
| No package imports a service back                                                                                                                                                         | `tasks/_lib/import-boundaries.test.ts`                                                                         |
| G2-17: the Drizzle table declarations match the schema the migrations create, column for column, in both directions                                                                       | `packages/storage-d1/test/drizzle-schema-parity.test.ts`                                                       |
| G2-17: each switched read returns the same rows and runs the same query plan as the native statement it replaced                                                                          | `packages/storage-d1/test/drizzle-equivalence.test.ts`                                                         |
| G2-16: an `update` or `delete` through the ORM is refused by the same trigger, and leaves the row untouched                                                                               | `packages/storage-d1/test/drizzle-immutability.test.ts`                                                        |
| G4-11, G4-12: a coefficient beyond 2^53, a NULL amount and a date-only window keep their meaning through the ORM's columns                                                                | `packages/storage-d1/test/drizzle-codecs.test.ts`                                                              |
| G4-14: a dependency change that moves a parser digest is a new release, and this change moves none                                                                                        | `packages/parsers/test/parser-digests.test.ts`, `docs/libraries.md`                                            |

## Flags, deploy order, rollback

- **Flags:** none. This change introduces no feature flag and turns none on.
- **Deploy order:** none — no schema, binding, resource name or wire format
  changed. Whenever the Workers are next deployed, any order works.
- **Rollback:** revert the commits. There is no data to undo.
- **Manual settings required:** none.

The U12 Drizzle pilot adds nothing to that list: no migration, no flag, no
binding, no resource identity and no wire format. It adds one dependency to
`packages/storage-d1` and changes six import lines, so `kogane-ingest` must be
redeployed for the switched reads to run there — in any order, at any time —
and rolling back is reverting the commits. The Worker's upload size changes
(113.93 → 305.03 KiB); nothing else about the deployment does.
