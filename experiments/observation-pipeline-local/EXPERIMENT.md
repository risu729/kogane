# Experiment: local observation pipeline

|                        |                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Owner**              | risu729                                                                                                                                                                                                                                                                                                               |
| **Expiry**             | 2026-12-31                                                                                                                                                                                                                                                                                                            |
| **Stop condition**     | The App API covers replay and status. When `services/app` can re-run a parse over stored evidence and report pipeline freshness through `/api/ops/v1/*`, this directory is deleted and what it settled is appended to [`docs/research/observation-pipeline-poc.md`](../../docs/research/observation-pipeline-poc.md). |
| **Deployed resources** | None. No Worker, no bucket, no queue, no cron. It runs on a developer's machine against a local SQLite file.                                                                                                                                                                                                          |

## What it is

Everything that happens **after** collection, in one process: an
already-collected raw artifact is ingested, parsed into typed observations by
the deployed parsers, and served read-only with full provenance.

- `src/store.ts` — SQLite (`bun:sqlite`) plus a filesystem blob directory,
  standing in for D1 and R2. The SQL is written to stay valid on D1.
- `src/ingest.ts`, `src/parse.ts` — the ingest and parse entry points.
- `src/queries.ts` — the read queries, including the `CURRENT` snapshot rule
  that `packages/read-model` and `services/processor` are compared
  against.
- `src/api.ts` — the read-only Hono API, the same contract the production
  Worker serves (`packages/observation-shared`).
- `src/serve.ts`, `src/demo.ts`, `src/export-demo.ts` — the local entry points.
- `schema.sql` — the local schema; `SCHEMA_VERSION` in `src/store.ts` is
  bumped whenever its shape changes.

The parsers, the identity resolver, the observation types and the HTTP
contracts are **not** here: they live in `packages/parsers`,
`packages/identity` and `packages/observation-shared`, and this experiment
imports them like everything else does. The client is `apps/web`.

## Why it still exists

Two things in this repository depend on it today, and both are named so that
the dependency is a decision rather than an accident:

1. **Local API conformance fixtures.** `//experiments/observation-pipeline-local:export-demo`
   ingests committed fixtures into a throwaway store and captures the API
   responses in `services/app/demo-snapshot.json`. The test adapter consumes
   that generated snapshot; it has no deployed Worker or production UI use.
2. **A second implementation of the read rules.** The snapshot-selection and
   publication-gate tests compare the D1 reader against this store's
   independent SQLite implementation of the same rule. That comparison is the
   evidence that a change to one of them is deliberate.

Neither is a reason to keep it forever. Both are covered by the stop condition:
the App API takes over the operational half, and the comparison tests move to
whatever replaces this store's queries.

## Running it

From the repository root:

```sh
mise run install
mise run //experiments/observation-pipeline-local:preview     # build the client + isolated synthetic-only store
mise run //experiments/observation-pipeline-local:demo        # ingest the fixtures into state/, print row counts
mise run //apps/web:build                  # build the client into apps/web/dist
mise run //experiments/observation-pipeline-local:serve       # API + built client on http://127.0.0.1:8787/
mise run //apps/web:dev                    # Vite dev server on 5173, proxying /api to 8787
mise run //experiments/observation-pipeline-local:ci          # typecheck, demo export, tests (Chromium included)
```

`local-pipeline:preview` uses only committed synthetic fixtures in a fresh
temporary store and removes that store on normal shutdown; `/api/meta` reports
it as synthetic. `local-pipeline:demo` and `local-pipeline:serve` use the
regular store in `state/` (gitignored), whose data classification is reported
as unknown: an operator may have ingested real evidence into it. Neither is a
connection to the production D1 or R2.

`local-pipeline:serve` binds loopback only and has no authentication: it
renders real financial evidence and must never be reachable from a network.
The same holds for the dev server, which binds localhost unless it is given
`--host`.

Ingest and parse are idempotent. Running the demo twice ingests nothing new
and parses nothing new, because runs are keyed by their external run id, blobs
by their SHA-256, and parse runs by (artifact, parser, version). Deleting
`state/` and re-running is always safe — that is the point of the
architecture.

## Boundaries

Nothing under `services/*/src` or `packages/*/src` may import this directory,
and `apps/web` may not either; `tasks/_lib/import-boundaries.ts` and
`mise run root:depcruise` enforce it. This experiment may import any package
and may read the built client as bytes. It declares no Cloudflare resource, so
it appears in `infra/resources.json` with a disposition and no Worker.
