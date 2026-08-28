# Raw evidence store

This document is the implementation plan for phase 2 of `docs/roadmap.md`:
the layer-A store that holds raw bytes and the metadata describing where
they came from. It replaces the four-table sketch in the roadmap with
complete DDL, an API surface, an importer CLI, and a backfill plan,
derived from what the two live collectors already write and from what
`poc/observation-pipeline` already implements.

## Scope

The raw store answers one question: what did a source hand us, when, and
where are those bytes now. It consists of

- a private R2 bucket holding content-addressed blobs;
- a D1 database holding the source registry, fetch runs, raw object
  records, and fetch artifacts;
- a Worker exposing a small authenticated ingestion API;
- a local CLI that feeds it from Kuebiko captures, file exports, and the
  collector buckets that already exist.

### What this layer refuses to do

Ingestion never parses. It does not know what a transaction is, what a
balance means, which account a payload belongs to, or whether two
payloads describe the same thing. It stores bytes, records metadata about
the transfer, and returns an identifier.

`docs/collection.md` gives the reason: any future client — the importer
CLI, a scheduled collector, an email handler, a manual upload from a
phone — must be able to use the same API unchanged. The moment ingestion
understands a payload, every new source needs an ingestion change before
its evidence can be stored, and evidence collection stops being decoupled
from modelling. It also refuses:

- **Normalizing bodies.** No re-encoding, no pretty-printing, no
  Shift-JIS-to-UTF-8 conversion, no NFKC. `docs/tooling.md` records this
  as the specific defect to fix in `smcc-meisai-scraper`'s
  `downloader.ts`: save the raw bytes first, decode in the parser. A
  digest over decoded text is a digest over our decoding decision, not
  over the evidence.
- **Splitting composite payloads.** The Vpass collector writes one
  `snapshot.json` per card run containing several captured pages as
  embedded raw JSON strings (`poc/vpass-json/src/worker.ts`). Ingestion
  stores that object as one artifact, because that is the object the
  collector wrote. Addressing a page inside it is the parser's job, via
  the `raw_locator` recorded on every observation (phase 3).
- **Deduplicating semantically.** Identical bytes are stored once; that
  is a storage property, not a claim that two fetches mean the same
  thing. Every fetch keeps its own artifact row.
- **Deleting or updating evidence.** Raw objects, fetch artifacts, and
  fetch runs are append-only per the mutation policy in `docs/design.md`,
  with no exception. See "Why there is no run status update" below.

## Named resources

Both live collectors name their bucket exactly in their
`wrangler.jsonc`: `kogane-sbi-collector-poc` and
`kogane-vpass-collector-poc`, each bound as `SNAPSHOTS`. The evidence
store follows the same convention and does not yet exist:

```text
Worker      kogane-ingest
R2 bucket   kogane-raw-evidence      binding EVIDENCE
D1 database kogane-raw-evidence      binding DB
```

The bucket is private and has no public route. It is deliberately not
named `-poc`: the collector buckets are disposable experiments
(`docs/vpass-cloudflare-temporary-collector.md` documents how to delete
one), while this bucket is the store of record and nothing else may hold
the only copy of an artifact.

## Tables

The starting point is the layer-A section of
`poc/observation-pipeline/schema.sql`, which is already written to stay
valid on D1: STRICT tables, no `PRAGMA` statements, foreign keys enforced
by the connection as D1 does by default. Phase 2 adds the columns the two
live collectors turn out to need.

```sql
-- migrations/0001_raw_store.sql

CREATE TABLE sources (
  id        TEXT PRIMARY KEY,     -- 'sbi-securities', 'vpass', 'paypay'
  provider  TEXT NOT NULL,        -- display name
  ingestion TEXT NOT NULL
    CHECK (ingestion IN ('kuebiko', 'collector-r2', 'file-export')),
  active    INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
) STRICT;

CREATE TABLE url_patterns (
  id        INTEGER PRIMARY KEY,
  source_id TEXT REFERENCES sources(id),  -- NULL: applies to every source
  kind      TEXT NOT NULL CHECK (kind IN ('allow', 'deny')),
  host_glob TEXT NOT NULL,
  path_glob TEXT NOT NULL DEFAULT '*',
  note      TEXT,
  UNIQUE (source_id, kind, host_glob, path_glob)
) STRICT;

-- SQLite treats NULLs as distinct in a UNIQUE index, so the constraint
-- above does not deduplicate the global rows. A partial unique index
-- does, and schema.sql already relies on partial indexes working here
-- (idx_parse_runs_success).
CREATE UNIQUE INDEX idx_url_patterns_global
  ON url_patterns (kind, host_glob, path_glob)
  WHERE source_id IS NULL;

CREATE TABLE fetch_runs (
  id              INTEGER PRIMARY KEY,
  source_id       TEXT NOT NULL REFERENCES sources(id),
  external_run_id TEXT NOT NULL,  -- collector runId / capture dir / file key
  tool            TEXT NOT NULL,  -- 'sbi-securities-worker' | 'import-kuebiko'
  tool_version    TEXT,           -- manifest schemaVersion, CLI version
  started_at      TEXT NOT NULL,  -- ISO 8601 UTC, from the collector
  completed_at    TEXT,
  status          TEXT NOT NULL
    CHECK (status IN ('success', 'partial', 'failed')),
  ingested_at     TEXT NOT NULL,  -- when we recorded it; bookkeeping only
  UNIQUE (source_id, external_run_id),
  UNIQUE (id, source_id)          -- FK target for fetch_artifacts
) STRICT;

CREATE TABLE raw_objects (
  sha256        TEXT PRIMARY KEY  -- hex digest; also the object key
    CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  size          INTEGER NOT NULL CHECK (size >= 0),
  content_type  TEXT NOT NULL,    -- the first observer's claim only
  blob_key      TEXT NOT NULL,    -- R2 key
  first_seen_at TEXT NOT NULL
) STRICT;

CREATE TABLE fetch_artifacts (
  id           INTEGER PRIMARY KEY,
  fetch_run_id INTEGER NOT NULL,
  source_id    TEXT NOT NULL,
  artifact_key TEXT NOT NULL,     -- unique within the run; see below
  dataset      TEXT,              -- collector dataset name, if any
  url          TEXT,              -- provisional; see below
  method       TEXT,              -- provisional
  http_status  INTEGER,           -- provisional
  mime         TEXT NOT NULL,     -- declared media type, verbatim
  fetched_at   TEXT NOT NULL,
  window_from  TEXT,              -- period the payload covers, if declared
  window_to    TEXT,
  origin_key   TEXT,              -- key in the collector's own bucket
  sequence     INTEGER,           -- provisional
  sha256       TEXT NOT NULL REFERENCES raw_objects(sha256),
  UNIQUE (fetch_run_id, artifact_key),
  FOREIGN KEY (fetch_run_id, source_id)
    REFERENCES fetch_runs(id, source_id)
) STRICT;

CREATE INDEX idx_fetch_runs_source
  ON fetch_runs (source_id, started_at);
CREATE INDEX idx_fetch_artifacts_source
  ON fetch_artifacts (source_id, dataset, fetched_at);
CREATE INDEX idx_fetch_artifacts_sha
  ON fetch_artifacts (sha256);
```

There is no separate index on `fetch_artifacts (fetch_run_id)`: the
`UNIQUE (fetch_run_id, artifact_key)` constraint already creates an index
with `fetch_run_id` leftmost, which serves every lookup by run.

### Why each choice

`raw_objects.sha256` is the primary key, not a surrogate id, because the
digest is the identity of the bytes. There is no second row that can
describe the same content, no way to write a different `blob_key` for the
same digest, and no insert-versus-update decision at the call site: the
existence check in `putRawObject` is a primary-key lookup
(`poc/observation-pipeline/src/store.ts`). `blob_key` is kept as a
separate column rather than derived, so the key layout can change without
rewriting history; the PoC already exercises this by pointing it at a
filesystem path.

`fetch_artifacts` is append-only and keeps HTTP-level fields because, as
`docs/roadmap.md` says, URL and status are the most useful signal for
later parser development, and because the same bytes reached us through a
particular request that may itself become interesting (an endpoint that
starts returning 302, a dataset that silently empties). One row per fetch
is what makes "we confirmed the same state again at 07:00" a recorded
fact rather than a no-op.

`fetch_artifacts.source_id` duplicates its run's `source_id`, so a
composite foreign key to `fetch_runs (id, source_id)` makes the two
unable to disagree; that is what the extra `UNIQUE (id, source_id)` on
`fetch_runs` exists for. Dropping the column and joining through
`fetch_runs` was the alternative. It was rejected because phase 3 selects
parsers from artifact metadata alone — every `accepts` predicate in
`poc/observation-pipeline/src/parsers/` reads `artifact.sourceId` — and
`idx_fetch_artifacts_source (source_id, dataset, fetched_at)` is the
access path for the parser sweep. The denormalization is kept and
enforced rather than kept and trusted.

`fetch_runs.external_run_id` carries the collector's own run identifier.
With `UNIQUE (source_id, external_run_id)` it is the idempotency key for
the whole run. It is opaque text and must never be parsed: the two live
collectors use different shapes, and a third appears in the PoC fixtures.

| Producer | Shape | Source |
| --- | --- | --- |
| SBI Securities Worker | `crypto.randomUUID()` | `poc/sbi-securities-worker/src/worker.ts` |
| Vpass Worker | `toISOString()` with `:` and the first `.` replaced by `-` | `poc/vpass-json/src/worker.ts` |
| PoC fixture | `20260820-210000-poc01` | `poc/observation-pipeline/fixtures/` |

Dates therefore come from `started_at` or from the collector's own key
prefix, never from the run id.

`UNIQUE (fetch_run_id, artifact_key)` is the per-artifact idempotency
key. `artifact_key` is a caller-assigned, run-local name: the dataset
name for SBI runs (`domestic-trade-records`), the card-scoped path for
Vpass (`card-003/snapshot.json`), the file name for `ingest-file`, and,
provisionally, a sequence-plus-URL key for a Kuebiko entry. Re-posting
the same artifact is then a detectable no-op, and posting different bytes
under a key already used in the same run is a conflict worth surfacing
rather than a second silent row.

`ingested_at` is bookkeeping, not a fourth measurement timestamp. The
three timestamps `docs/design.md` distinguishes — `as_of`, `observed_at`,
`fetched_at` — describe the value and the source; `ingested_at` describes
our own storage and must never be substituted for `fetched_at`.

CHECK constraints cover the three columns the prose treats as closed
enums (`sources.ingestion`, `url_patterns.kind`, `fetch_runs.status`) and
the digest format. The Worker validates the same values, but the Worker
is not the only writer: the registry seed and the backfill reconciliation
queries run through `wrangler d1 execute`, and a typo there would
otherwise land a value no reader expects.

### mime versus content_type

`fetch_artifacts.mime` is authoritative. It records what the source
declared for that particular fetch, verbatim and including parameters
(`application/json; charset=utf-8` is what the Vpass collector sets on
every object it writes; the SBI collector sets `application/json`).

`raw_objects.content_type` is only the first observer's claim about those
bytes, and it is frozen: a deduplicated write does nothing at all, so a
later fetch that declares a different type never reaches the row. It
exists so the evidence browser can serve `/raw/:sha256` with some
declared type when no artifact is in hand
(`poc/observation-pipeline/src/ui.ts`). Any question of the form "what
did the source call these bytes" is answered by joining through
`fetch_artifacts`.

Keeping the declared value verbatim in `mime` is also how the charset
problem from `poc/observation-pipeline/RESULTS.md` gets its input:
parsers there decode UTF-8 strictly and fail loudly, because the
artifact's encoding is not recorded and no decoder can be selected.
Several documented sources are CP932. A second `charset` column was
considered and rejected — two columns describing one header is the same
defect as `content_type` versus `mime`. When a source declares no media
type at all, the importer writes `application/octet-stream` rather than
inventing one.

### Differences from the roadmap sketch

- The sketch calls the blob column `r2_key`; it is `blob_key` here,
  matching the PoC, because the same schema runs against a filesystem
  store in local development and tests. The production value is an R2
  key.
- The sketch puts the domain allowlist inside `sources`. It is a separate
  `url_patterns` table because the allowlist needs `deny` rules
  (sensor telemetry, authentication endpoints) as data rather than code,
  and because rules that apply to every source cannot be a column on one
  source's row.
- `dataset`, `window_from` / `window_to`, `origin_key`, `tool_version`,
  and `first_seen_at` are not in the sketch. Each is present in something
  a live collector already writes: `ArtifactManifest` in
  `poc/sbi-securities-worker/src/types.ts` carries `dataset`, `key`,
  `sha256`, `bytes`, and an optional `window`, and `CollectionManifest`
  carries `schemaVersion`.

### Differences from the PoC schema

- `external_run_id` becomes `NOT NULL`. In SQLite, NULLs are distinct in
  a UNIQUE index, so a nullable column would silently disable the
  idempotency it exists to provide. Every ingestion path can synthesize
  an identifier; `ingestFile` already does.
- `artifact_key` and its UNIQUE constraint are new. The PoC achieves
  idempotency only at run granularity, which is sufficient for a fixture
  demo and insufficient for an API where a client may retry one artifact.
- `sources.active` is new, and is load-bearing for the `403` rule below:
  a source that must stop being ingested is deactivated rather than
  deleted, because its existing runs and artifacts must keep resolving.
- The composite foreign key, the `UNIQUE (id, source_id)` it needs, the
  CHECK constraints, `ingested_at`, `first_seen_at`, and the
  `url_patterns` table are new.
- Nothing is removed. The PoC's layer-A columns all survive.

### What is provisional

`docs/roadmap.md` states the sequencing rule plainly: collect and analyze
real captures before freezing any schema, and phase 1 owns "which
artifact metadata to keep, the source allowlist structure, and the
ingestion tables". That rule is satisfied for one half of this schema and
not the other, and the difference is recorded here rather than papered
over.

Grounded in live output: `dataset`, `window_from` / `window_to`,
`origin_key`, `tool_version`, `external_run_id`, `status`, `started_at`,
`completed_at`, `sha256`, and `size`. Every one of them is read from a
manifest the SBI or Vpass collector writes today, and
`poc/observation-pipeline` ingests a fixture shaped like that manifest.

Provisional: `url`, `method`, `http_status`, `sequence`, and the
capture-side `artifact_key` rule. These exist only for Kuebiko-style
ingestion. `docs/collection.md` states the mapping as "`metadata.ndjson`
line → `fetch_artifact` (URL, method, status, timing)", but nothing in
this repository establishes that file's field names, ordering guarantees,
or identity guarantees, and `data/` contains only
`account-inventory.csv` — there is no capture on disk to have
characterized. These columns are therefore a hypothesis to be confirmed
against a real capture before the migration is applied, and the open
questions below keep that gate visible. Nothing else in phase 2 depends
on them: the backfill of the two collector buckets leaves all four NULL.

## Content addressing and deduplication

Blobs are keyed by the SHA-256 of their bytes. Writing a blob is: compute
the digest, look up `raw_objects`, and if the row exists do nothing at
all — no R2 write, no D1 write to that table. `putRawObject` in
`poc/observation-pipeline/src/store.ts` returns `{ sha256, deduplicated }`
so callers can report this.

The fetch history is stored separately and is never deduplicated. A daily
collector that finds an unchanged statement page writes one new
`fetch_artifacts` row per day and zero new blobs. The expensive thing
(bytes) is stored once and the cheap thing (the claim that a source still
said this at 07:00 on this date) is preserved in full. Phase 3 and later
depend on that distinction: a value that stopped changing and a source
that stopped being fetched look identical if only blobs are kept. The PoC
test `re-fetching an unchanged export records a second confirmation`
(`poc/observation-pipeline/test/pipeline.test.ts`) pins exactly this — two
artifacts, one blob.

Re-importing an old capture or run directory is safe at three levels:

1. the run row already exists, is found by `(source_id,
   external_run_id)`, and is reused rather than duplicated;
2. bytes seen before are recognized by digest, so only artifact rows are
   written;
3. an artifact re-posted inside the same run collides with
   `(fetch_run_id, artifact_key)` and is a no-op.

Note that level 1 reuses the run; it does not stop the import. That
distinction is the whole of the resumability rule below, and getting it
wrong is how a half-imported run becomes permanently un-finishable.

Old directories can consequently be imported at any time, in any order,
repeatedly. This is what lets phase 0 run for months with no
infrastructure and lose nothing.

## R2 key layout

Two namespaces exist, and they are not the same thing.

**Collector landing zones (already live, unchanged).** The SBI Securities
Worker writes to bucket `kogane-sbi-collector-poc`, with the prefix built
from the run's `startedAt` date and its `runId`
(`poc/sbi-securities-worker/src/storage.ts`):

```text
raw/sbi-securities/YYYY/MM/DD/<runId>/<dataset>.json
raw/sbi-securities/YYYY/MM/DD/<runId>/manifest.json
```

The Vpass Worker writes to bucket `kogane-vpass-collector-poc`:

```text
vpass/YYYY/MM/DD/<runId>/card-NNN/snapshot.json
vpass/YYYY/MM/DD/<runId>/card-NNN/manifest.json
vpass/YYYY/MM/DD/<runId>/card-NNN/error.json   (that card failed)
vpass/YYYY/MM/DD/<runId>/error.json            (the session failed)
```

There is no run-level manifest in the Vpass bucket. The Worker builds an
`AllCardsRunSummary` and only writes it to the log
(`poc/vpass-json/src/worker.ts`); nothing run-level reaches R2 except the
run-level `error.json`, which is written when the session cannot be
opened and is then the only object in the run.

Both layouts are date-partitioned and run-scoped, which makes them easy
to enumerate for backfill but means the same bytes are stored once per
run. Phase 2 does not rewrite either collector. They keep writing what
they write; the importer reads those prefixes and copies bytes into the
store.

**The evidence store.** One private bucket holds content-addressed
objects under a single prefix:

```text
objects/<aa>/<sha256>
```

where `aa` is the first byte of the digest in hex, matching the shape
`putRawObject` already builds. R2 has no directories, so the fan-out is
only about keeping listings and any future lifecycle rules manageable.
The key is fully derivable from the digest, but it is still stored in
`raw_objects.blob_key` so the layout can be changed for new objects
without invalidating old rows.

The original collector key is retained per artifact in
`fetch_artifacts.origin_key`, so any object can be traced back to the
bucket and path the collector chose, and the manifest that described it
re-read.

## The source registry and the allowlist

The registry — the `sources` rows and every `url_patterns` row — is
checked into the repository as `registry/sources.sql` and applied to D1
on deploy. That file is authoritative. The Worker reads the registry from
D1 to enforce `403`; the importer CLI loads the same file into an
in-memory SQLite database and matches with the same `GLOB` operator, so
both sides evaluate identical semantics from one text.

This resolves the question of where the allowlist lives, and it means
phase 2 adds no read route: the ingestion API writes only. A
`GET /registry/...` route was the alternative and was rejected for two
reasons. It would be the first read route on an API that otherwise only
accepts writes, widening what a leaked token can do from "write evidence"
to "enumerate which sources are collected". And a registry in D1 is not
reviewable: the privacy argument for batch import (below) is that
filtering decisions can be inspected before anything leaves the machine,
which requires the filter to be a diff in a pull request.

The registry is configuration, not evidence. `docs/design.md` places raw
objects, fetch history, source observations, and price observations in
the Immutable class; the source registry is in none of them. Re-applying
the seed may update a `note` or flip `active`, and its history lives in
git.

Matching rules:

- `host_glob` and `path_glob` use SQLite `GLOB` syntax.
- `deny` is evaluated before `allow`, and a `deny` match is final.
- A row with `source_id IS NULL` applies to every source. The default
  deny set — sensor and anti-bot telemetry, authentication endpoints —
  is expressed this way, which is why `source_id` is nullable.
- A URL that matches `allow` patterns belonging to two different sources
  is an error, not a choice. The importer refuses the entry and reports
  it; the fix is to make the path patterns disjoint in the registry. Two
  sources genuinely sharing a host is expected (`docs/sources/README.md`
  gives each confirmed shared API family its own research record), and
  silently picking one would attribute evidence to the wrong source.

## Ingestion API

A Worker exposes the two endpoints sketched in `docs/collection.md`. All
requests require `Authorization: Bearer <token>`; the token is a Worker
secret (`INGEST_TOKEN`), compared with a constant-time comparison. There
is no unauthenticated route, no CORS allowance, and no read route.

### POST /ingest/run

Records a fetch run.

```json
{
  "sourceId": "sbi-securities",
  "externalRunId": "0f2b6d5a-9c41-4f0e-8a3c-1d7f9b2e64aa",
  "tool": "import-collector-run",
  "toolVersion": "sbi-worker-poc-v1",
  "startedAt": "2026-08-20T21:00:07Z",
  "completedAt": "2026-08-20T21:01:42Z",
  "status": "success"
}
```

Response `201 {"runId": 41, "created": true}`, or `200 {"runId": 41,
"created": false}` when the run already exists with identical fields. A
second call for the same `(sourceId, externalRunId)` carrying a different
`status` or `completedAt` is `409`: the run row is written once and never
rewritten.

### Why there is no run status update

An earlier draft of this plan gave runs an `open` status and allowed one
`open → success | partial | failed` transition. That is an UPDATE on a
table this document calls append-only, and `docs/design.md` names fetch
history in the Immutable class explicitly. `schema.sql` shows what
justifying such an exception costs: it permits exactly one UPDATE,
`parse_runs.superseded_by_parse_run_id`, and argues it in the file as
lineage data rather than a mutation of any observation. No comparable
argument exists here — a run's status is a fact about the collection,
already decided before we hear about it.

So the exception is avoided instead. Every phase-2 client knows the
outcome before it posts anything: the importer reads a finished manifest,
and `ingest-file` describes a fetch that has already happened. The status
enum is exactly the collector's own (`CollectionManifest.status` in
`poc/sbi-securities-worker/src/types.ts` is `'success' | 'partial' |
'failed'`), and the Vpass `error.json` value `"error"` maps onto
`failed`.

If a future client genuinely streams — a collector posting artifacts as
it fetches them, with the outcome unknown until the end — the answer is
an append-only `fetch_run_events` table with the status derived from the
latest event, not a mutable column. Nothing needs it today, and the
safest version of an unused feature is its absence.

### POST /ingest/artifact

`multipart/form-data` with two parts: `meta` (JSON) and `body` (the raw
bytes, sent verbatim, with no transformation).

```json
{
  "sourceId": "sbi-securities",
  "externalRunId": "0f2b6d5a-9c41-4f0e-8a3c-1d7f9b2e64aa",
  "artifactKey": "domestic-trade-records",
  "dataset": "domestic-trade-records",
  "mime": "application/json",
  "fetchedAt": "2026-08-20T21:01:42Z",
  "sha256": "1bfcad18281c80aaf1143f0c9be6d0179"
              "6ccdf791439783cfb1a86f2a937dae8",
  "bytes": 2009,
  "window": { "from": "2026-05-22", "to": "2026-08-20" },
  "originKey":
    "raw/sbi-securities/2026/08/20/<runId>/domestic-trade-records.json"
}
```

The `meta` schema is closed: any field not in the table below is a `400`,
which is how the metadata whitelist is enforced structurally rather than
by review.

| Field | Type | Required for |
| --- | --- | --- |
| `sourceId` | string | every path |
| `externalRunId` | string | every path |
| `artifactKey` | string | every path |
| `mime` | string | every path |
| `fetchedAt` | ISO 8601 UTC | every path |
| `sha256` | 64 lowercase hex | every path |
| `bytes` | integer | every path |
| `dataset` | string | collector runs |
| `window` | `{from, to}` dates | collector runs, when declared |
| `originKey` | string | collector runs |
| `url` | string | file exports; captures (provisional) |
| `method` | string | captures (provisional) |
| `httpStatus` | integer | captures (provisional) |
| `sequence` | integer | captures (provisional) |

The `body` part may be omitted when `raw_objects` already holds `sha256`,
so a re-import does not re-upload gigabytes. If the digest is unknown,
the Worker answers `412 {"error": "blob_required"}` — the precondition
the client asserted by omitting the body is false — and the client
retries with the bytes.

| Status | Meaning |
| --- | --- |
| 201 | artifact recorded (blob stored or already present) |
| 200 | identical artifact already recorded for this run and key |
| 400 | malformed or non-whitelisted metadata |
| 401 | missing or invalid bearer token |
| 403 | unknown source, inactive source, or URL not allowlisted |
| 409 | same `artifactKey` in this run with different bytes |
| 412 | body omitted and the digest is unknown |
| 422 | uploaded bytes do not hash to the declared `sha256` |

Order of operations inside the handler: verify the digest, write the R2
object, then write the D1 rows in one atomic batch. An interrupted
request can therefore leave an orphan blob (harmless, unreferenced,
content-addressed) but never a row pointing at bytes that do not exist.
The reverse order would produce silent corruption and is forbidden.

### Resumability

`POST /ingest/run` never short-circuits an import. Finding an existing
run returns `200 {"created": false}` and the client continues posting
every artifact; the ones already recorded return `200` and the missing
ones are written. A client that crashes after ten of thirty artifacts is
resumed by running it again.

This differs from the PoC on purpose, and the difference is worth
stating because the PoC's behaviour is correct for the PoC.
`ingestRunDirectory` in `poc/observation-pipeline/src/ingest.ts` returns
`{ skippedExisting: true }` and imports nothing when the run row already
exists. It can do that safely because it reads and hash-verifies every
artifact in the directory before writing anything and then commits the
run row and all its artifacts in one `store.db.transaction()`. A run row
therefore implies a complete run, and a failed import leaves nothing
behind at all — pinned by the tests `a rejected run leaves nothing behind
and can be re-ingested` and `a run whose file is missing leaves nothing
behind` in `poc/observation-pipeline/test/pipeline.test.ts`.

The API cannot make that guarantee, because a run is many independent
requests and the client may die between any two of them. Its unit of
atomicity is one artifact, so an existing run row implies nothing about
completeness, so it must not be treated as a stop signal. Completeness is
established by reconciling artifact rows against the manifest, not by the
presence of the run.

Open at this stage: the maximum request body size, which must be chosen
against the Worker plan's limit and against real Kuebiko body sizes; and
whether many small capture artifacts need a batch endpoint.

## Importer CLI

A local Bun CLI, run by hand or from a script. It holds the bearer token
in the local environment; it is not deployed anywhere.

```text
kogane import-kuebiko <run-dir>
kogane ingest-file <path> --source <source-id> [--fetched-at <iso>]
                          [--mime <type>]
kogane import-collector-run <bucket-prefix>
```

`import-kuebiko` reads `metadata.ndjson` line by line and matches each
entry's URL against the registry. A matched entry is uploaded as one
artifact: the response body from the capture's content-addressed body
store, with the digest verified against the file name before upload, plus
the whitelisted metadata. Unmatched hosts are never uploaded; they are
aggregated into a report (host, request count, sample paths) for review,
after which genuinely financial hosts are added to the registry and the
rest — ads, analytics, unrelated browsing — stay out permanently.
Re-running the import after a registry change picks up newly allowlisted
entries from the same directory, because the run is keyed by directory
name and each artifact by its own key. This command is the part of the
CLI that depends on the provisional columns, and it cannot be finished
before a real capture has been characterized.

`ingest-file` covers exports that CDP capture cannot see: CSV, OFX, QIF,
statement PDFs, browser downloads. It synthesizes a single-artifact run
keyed `file:<basename>@<fetchedAt>`, which is what `ingestFile` in
`poc/observation-pipeline/src/ingest.ts` already does. The fetch time is
part of the key deliberately: run identity is the fetch, not the content,
so re-downloading an unchanged export next month is a second confirmation
with its own run and artifact row and no second blob, while importing the
same file twice from the same fetch is a no-op.

`import-collector-run` is the backfill path and is new relative to
`docs/collection.md`: it lists a run prefix in a collector bucket, reads
what that collector wrote there, and replays it through the same API. It
exists because the SBI and Vpass collectors write R2 directly and predate
the ingestion API.

Batch import is preferred over a live Kuebiko plugin for the reasons in
`docs/collection.md` — it works on past captures, keeps network activity
out of the capture loop, and is trivially re-runnable — and for one more
that only becomes visible once the allowlist is real: filtering decisions
are reviewable before anything leaves the machine, and a corrected
allowlist can be re-applied to captures already on disk. A live plugin
would have to make those decisions irrevocably, at capture time, with no
review step.

## Privacy rules enforced on upload

`docs/collection.md` states these as importer rules. Phase 2 makes them
checks on both sides, because a rule enforced only in the client is a
rule that a future client forgets.

| Rule | Enforcement |
| --- | --- |
| Request headers are never uploaded | The `meta` schema has no header field; unknown fields are `400`. Structurally unrepresentable. |
| Authentication request bodies are never uploaded or retained | Only response bodies are modelled at all — an artifact has exactly one body. Auth endpoints additionally carry `deny` patterns. |
| Sensor and anti-bot telemetry excluded | `deny` patterns with `source_id IS NULL`, which is why that column is nullable. |
| Allowlisted sources only | Unknown or inactive `sourceId` is `403`; a URL that matches no `allow` pattern for its source is `403`. |
| Metadata whitelist per artifact | Exactly the fields in the `meta` table above, none of which can carry credential material. Anything else is `400`. |

The keyed diagnostic hash that `docs/collection.md` permits for auth
bodies "when operationally needed" is not implemented in phase 2. Nothing
currently needs it.

One rule is not yet expressible: some sites place session identifiers in
URL query strings, and `fetch_artifacts.url` stores the URL verbatim. See
open questions.

## Backfill

Evidence already exists in the two collector buckets and must be loaded
without touching the collectors. Both write daily from a Cloudflare Cron
Trigger at 21:00 UTC.

### SBI Securities

`poc/sbi-securities-worker/README.md` records the initial load as
`scripts/backfill.sh 2024-08-28 2026-05-29`, split into non-overlapping
windows of 90 days or fewer, with the daily Cron adding runs since. The
number of run directories and artifacts now in the bucket is not recorded
anywhere in this repository; it is established by listing the bucket
during the backfill and is one of the exit criteria below, not a figure
to be quoted in advance.

Each run directory becomes one `fetch_run` keyed by the manifest's
`runId`, with `tool_version` from `schemaVersion`, `started_at` and
`completed_at` from the manifest, and `status` copied verbatim — the
manifest's enum is already ours. Each entry in `artifacts[]` becomes one
`fetch_artifact` with `dataset`, `origin_key` from `key`, `window_from` /
`window_to` when `window` is present, and `sha256` from the manifest,
cross-checked against the bytes.

The manifest carries no per-artifact time. `ArtifactManifest` is
`{ dataset, key, sha256, bytes, window? }`, and only the run has
`startedAt` and `completedAt`. So for collector runs, `fetched_at` is the
run's `completedAt`, falling back to `startedAt` when it is absent —
which is what `poc/observation-pipeline/src/ingest.ts` does. Every
artifact in a run therefore shares one timestamp. That is coarser than
`docs/design.md` would like from a distinguished timestamp, and the
honest fix is for the collector to record a per-artifact fetch time in
`ArtifactManifest`; until it does, the derived value is used and its
coarseness is documented here rather than disguised by a plausible-looking
per-artifact value.

The manifest itself is ingested as an artifact
(`artifact_key = "manifest"`), because `failures[]` and `scope` are
evidence about the collection and are worth re-reading later.

One gap cannot be closed by backfill: the manifest is written after
collection, so a run that failed before reaching R2 — a missing Worker
secret, for instance — leaves no directory at all. "The source was
unreachable" and "we never ran" are distinguishable only where a manifest
exists.

### Vpass

The Vpass bucket needs a different rule for every run-level field,
because there is no run-level manifest to read.

Each `card-NNN` directory contributes artifacts with
`artifact_key = "card-NNN/snapshot.json"` and
`"card-NNN/manifest.json"`, or `"card-NNN/error.json"` for a card that
failed. A run whose session could not be opened is a single run-level
`error.json` and no card directories at all; it is ingested as one
artifact under `artifact_key = "error.json"`.

The `fetch_run` is synthesized from what the run contains:

- `external_run_id`: the `runId` field carried inside every card
  manifest, card `error.json`, and run-level `error.json`.
- `started_at`: the `startedAt` field from any of those objects. All
  cards in a run share one `started` timestamp, because the scheduled
  handler passes one `Date` to every card.
- `completed_at`: the latest `completedAt` across the card manifests, or
  the `failedAt` of the run-level `error.json`.
- `status`: `success` when every card directory has a `manifest.json`;
  `partial` when at least one card has a `manifest.json` and at least one
  has an `error.json`; `failed` when no card manifest exists. The
  `"status": "error"` written in `error.json` maps onto `failed`.
- `tool_version`: NULL. The card manifest carries no `schemaVersion`.
  `snapshot.json` carries `format: "kogane-vpass-r2-snapshot/v1"`, but
  that describes the object, not the collector that wrote it.

Two further differences from SBI matter.

First, the Vpass manifest records counts and status but no per-artifact
SHA-256, so there is no independent hash to cross-check: the digest we
compute is the only integrity anchor. The right fix is for the collector
to record one, as SBI's `storeArtifact` already does.

Second, `snapshot.json` embeds every captured page of every month as a
raw JSON string inside one object. It is ingested as a single artifact;
the phase-3 parser addresses individual pages through `raw_locator`.
Splitting it during ingestion would be parsing.

Per-card times are better than SBI's: each card manifest carries its own
`completedAt` (its `startedAt` is the shared run start, one `Date` created
once in `collectAllCards` and passed to every card), so a card's artifacts
take that card's `completedAt` as `fetched_at` rather than a whole-run
value.

How many cards a run should have contained is not always recoverable.
`cardCount` appears only in a successful card manifest, so a run in which
every card failed cannot be reconciled against an expected count.

### What can go wrong

- **Manifest and byte hash disagree.** A per-artifact rejection must not
  abort a two-year import: the artifact is rejected and reported, the
  rest of the run continues, and the CLI exits non-zero with a list. This
  is a change from the PoC, not inherited behaviour — `ingestRunDirectory`
  aborts the whole directory on the first mismatch, which is right for
  four fixture files and wrong for a backfill. The PoC also skips the
  comparison when the manifest declares no `sha256`; the importer must
  instead treat a missing declared hash as a rejection for any source
  whose manifest is supposed to carry one, which is every SBI run, since
  `ArtifactManifest.sha256` is not optional.
- **Partial and failed runs.** A `partial` SBI run has real artifacts and
  a populated `failures[]`; both are ingested. A Vpass card run that
  failed wrote `error.json` and no snapshot; that file is the artifact. A
  `failed` run with zero artifacts still gets a `fetch_runs` row.
- **Dataset names that changed over time.** Parsers select on
  `artifact.dataset` (see the `accepts` predicates in
  `poc/observation-pipeline/src/parsers/`). Historical `dataset` values
  are never rewritten to match a newer name. A rename is handled in the
  parser's `accepts` — a parser version bump and a re-parse, the
  operation phase 3 is built around — not by a data migration.

The backfill is idempotent and re-runnable by construction: run identity
comes from the collector's own `runId`, artifact identity from `(run,
artifact_key)`, and blob identity from the digest. Interrupting it
halfway and starting over costs a listing pass and nothing else.

## Integrity and failure handling

Every upload is verified: the Worker hashes the received bytes and
compares against the declared `sha256`, rejecting a mismatch with `422`
before writing anything. The digest is recomputed rather than trusted
because the client is the party most likely to be wrong about it.

A periodic verification job re-reads a sample of `raw_objects` from R2
and re-hashes them, so that bit rot or a lost object surfaces as an alert
rather than as a parse failure years later. Its frequency and sample size
are undecided.

Run status is the collector's status, recorded verbatim. It is not a
judgment about our ingestion. A failed run is evidence: "the source was
unreachable on 2026-03-11" and "we never tried on 2026-03-11" are
different facts, and every later gap analysis, freshness check, and "why
is this balance stale" question depends on telling them apart.

Ingestion-side incompleteness — an artifact the importer refused to send,
or one that failed hash verification — is reported by the CLI and is
deliberately not written into `fetch_runs.status`, because that would
overload a collector-owned field and reintroduce the mutable column this
plan removed.

## Exit criteria

Phase 2 is done when all of the following hold.

- [ ] `migrations/0001_raw_store.sql` applied to D1; schema checked in.
- [ ] `kogane-raw-evidence` R2 bucket created, private, with no public
      route; `kogane-ingest` deployed with `INGEST_TOKEN` as a secret and
      no unauthenticated and no read route.
- [ ] `POST /ingest/run` and `POST /ingest/artifact` implemented with the
      status codes above, including the `409`, `412`, and `422` paths.
- [ ] `registry/sources.sql` populated for every source being collected
      today, including the global deny set, and applied to D1 by the
      deploy step.
- [ ] The CLI and the Worker are demonstrated to reach the same
      allow/deny verdict for a shared set of URLs, including one that two
      sources' patterns both match, which both must refuse.
- [ ] `ingest-file` and `import-collector-run` work end to end against
      the deployed Worker.
- [ ] Every SBI Securities run directory in `kogane-sbi-collector-poc` is
      backfilled, and the count of runs and artifacts in D1 reconciles
      against a bucket listing. That listing is the first record of those
      counts in this repository; it is written down when it is taken.
- [ ] Every Vpass run in `kogane-vpass-collector-poc` is backfilled,
      including at least one run containing a card `error.json` and, if
      one exists, a run that is a single run-level `error.json`.
- [ ] Re-running the full backfill produces zero new blobs, zero new
      artifact rows, and zero new run rows, demonstrated by the CLI
      report.
- [ ] Resuming an interrupted import completes the run: kill the importer
      mid-run, re-run it, and confirm the artifact count matches the
      manifest.
- [ ] Privacy checks covered by tests: non-whitelisted metadata rejected,
      non-allowlisted URL rejected, globally denied host rejected for a
      source that has no deny rule of its own.
- [ ] CI runs typecheck, tests, and a migration dry-run on every PR.
- [ ] Every artifact's bytes are retrievable by digest and re-hash
      correctly.

`import-kuebiko` is deliberately not on this list. It cannot be completed
before a real capture has been characterized, and blocking phase 2 on it
would invert the sequencing rule in `docs/roadmap.md`. The two collector
buckets are enough evidence to build and prove the store.

Phase 3 starts only after the last item, because a parser is worthless if
the bytes it re-reads are not provably the bytes that were collected.

## Open questions

These are unresolved. None should be closed by guessing.

- **The Kuebiko capture shape.** `url`, `method`, `http_status`,
  `sequence`, and the capture-side `artifact_key` rule are provisional
  until `metadata.ndjson` from a real capture has been read: field names,
  whether order is guaranteed, and whether an entry has any stable
  identity of its own. Nothing in this repository establishes them, and
  no capture is on disk here.
- **Session identifiers in URLs.** Some sites carry them in query
  strings, and `fetch_artifacts.url` stores the URL verbatim. Redaction
  conflicts with byte-exactness of metadata; storing it conflicts with
  the credential rules. Needs a real capture to judge how often it
  occurs.
- **Request size limit and batching.** The per-request body cap and
  whether a batch endpoint is needed cannot be settled before real
  Kuebiko body-size distributions are measured.
- **Per-artifact time and hash from the collectors.** SBI's
  `ArtifactManifest` has no timestamp and Vpass's card manifest has no
  hash. Both are one-line collector changes that would remove a derived
  value and an unverifiable one, but changing a live collector is its own
  risk and no decision has been taken.
- **Do the live collectors keep writing R2 directly?** They work, and
  phase 2 does not change them. Whether they should later POST to the
  ingestion API instead — making their buckets a transient landing zone,
  or removing them — is a separate decision with its own failure modes.
- **Does ingestion completeness need its own column?** Reporting
  client-side leaves no queryable record that an artifact was refused.
  Any stored form would be a second status on a table with no mutable
  columns, so it would have to be an append-only events table. Deferred
  until a real gap is missed.
- **Vpass snapshot granularity.** One artifact per card run is the
  phase-2 decision. If `raw_locator` addressing into the embedded pages
  proves painful in phase 3, the alternative is changing the collector to
  write one object per page — a collector change, not a store change.
- **Per-client tokens and rotation.** One shared bearer token is the
  phase-2 answer. Whether the importer, each collector, and any future
  email handler should hold distinct, source-scoped tokens is unexamined.
- **Growth and verification cadence.** D1 row counts and R2 object counts
  per year are unknown until the backfill and then Kuebiko imports run at
  volume, and so are the right sample size and frequency for the
  re-hashing job and whether any R2 storage-class or lifecycle option is
  worth using. Nothing is ever deleted regardless.
