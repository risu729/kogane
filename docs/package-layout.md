# Package layout and import boundaries

Design review finding **D07** (PR-02) and unified plan **U04** (chapter 07 §1,
§3, §6). The deployed Workers used to import the parsers, the identity
resolver, the observation types and the shared HTTP contracts directly out of
`poc/observation-pipeline`, and then kept reading its fixtures and serving its
build output long after the modules had moved. The directory name was not the
problem. The problem was that the contracts that must stay stable, the
experiments that must stay free to change, and the code that is deployed all
had one owner, so neither side could be changed without reasoning about the
other.

D07 promoted the modules. U04 finished the job: the client, the fixtures and
the local store left `poc/`, the 27 compatibility re-exports were deleted and
`poc/observation-pipeline` no longer exists. This document states where each
piece lives, what may import what, and what proves that nothing about the
pipeline's behaviour changed when it moved.

## Ownership

| Directory                                  | Holds                                                                                                                                                                                                                                                                                                                              | May import                                                                                                                                                                                                                                                                 |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/domain`                          | Value, time, metric, scope, coverage, context and decision contracts.                                                                                                                                                                                                                                                              | Nothing outside itself.                                                                                                                                                                                                                                                    |
| `packages/evidence-contract`               | Ingest descriptor schema, normalization, canonical encoding, digest.                                                                                                                                                                                                                                                               | `packages/domain`.                                                                                                                                                                                                                                                         |
| `packages/collection`                      | Shared DATA bucket contract: key layout, the `terminal-v1` manifest, its digest, the terminal-last writer, the reader/verifier and the stage vocabulary.                                                                                                                                                                           | `packages/evidence-contract`.                                                                                                                                                                                                                                              |
| `packages/observation-shared`              | The HTTP/UI contracts and the value semantics every reader shares: `api-contract`, `api-schema`, `api-validation`, `balance-semantics`, `activity-semantics`, `financial-products`, `identity-contract`, `organization-contract`, `account-connection-contract`, `normalized-decimal`, `evidence-contract`, `evidence-validation`. | `packages/domain`, `packages/parsers` (money only).                                                                                                                                                                                                                        |
| `packages/observation-shared/test-support` | The API conformance checks the production Worker and the local store both run. Test code, imported only by tests.                                                                                                                                                                                                                  | The package's own `src`.                                                                                                                                                                                                                                                   |
| `packages/parsers`                         | The deployed parsers (`src/parsers/**`), the parser contract (`src/types.ts`), money formatting and minor-unit rules (`src/money.ts`), the snapshot-selection SQL (`src/snapshot-query.ts`), the build-digest generator and the coverage-contract freezer (`scripts/`).                                                            | `packages/domain`.                                                                                                                                                                                                                                                         |
| `packages/identity`                        | Identity resolution over stored observations and the per-source rules.                                                                                                                                                                                                                                                             | `packages/domain`. Today it imports nothing outside itself.                                                                                                                                                                                                                |
| `packages/read-model`                      | The explicit query repository and DTO mappers.                                                                                                                                                                                                                                                                                     | `packages/domain`, `packages/observation-shared`, `packages/parsers` (the snapshot CTEs), and one codec of `packages/storage-d1` (`src/codecs/decimal.ts`), which is the one edge that runs against the layering and is listed so that it is not mistaken for an accident. |
| `packages/storage-d1`                      | CORE database access: the SQL adapters (`src/core`), the column codecs (`src/codecs`), the guarded atomic commands (`src/atomic`) and the CORE and READ migration directories. See [storage-d1.md](storage-d1.md).                                                                                                                 | `packages/domain`, `packages/evidence-contract`, `packages/identity`, `packages/read-model` (the projection SQL and readers it hosts on D1).                                                                                                                               |
| `packages/application`                     | QuerySpec / command application services shared by HTTP, UI and MCP.                                                                                                                                                                                                                                                               | The packages above.                                                                                                                                                                                                                                                        |
| `packages/collector-diagnostics`           | The redaction-safe diagnostics buffer every collector records its stages and failures into.                                                                                                                                                                                                                                        | Nothing.                                                                                                                                                                                                                                                                   |
| `packages/sbi-vc-trade-client`             | The local read-only SBI VC TRADE client. Never deployed; the collector owns the schedule and the session.                                                                                                                                                                                                                          | Nothing.                                                                                                                                                                                                                                                                   |
| `apps/web`                                 | The React client: `index.html`, `src/**`, `vite.config.ts`, the three build modes and the frontend tests.                                                                                                                                                                                                                          | The packages, over the HTTP contract. **Never a service's `src`, `packages/storage-d1`, the read model's SQL, `poc/` or `experiments/`.**                                                                                                                                  |
| `services/app`                             | The App Worker: UI delivery, the HTTP and MCP surface, queries and commands. Deploys `kogane-evidence-browser`, `kogane-demo` and the test configuration.                                                                                                                                                                          | Any package. **Never `poc/`, `experiments/` or `apps/`.**                                                                                                                                                                                                                  |
| `services/processor`                       | The Processor Worker: ingest and registration, parsing, projection and the job lanes, plus the CORE and READ migration steps. Deploys `kogane-observation-pipeline`.                                                                                                                                                               | Any package. **Never `poc/`, `experiments/` or `apps/`.**                                                                                                                                                                                                                  |
| `services/collector-*`                     | One deployed Worker per financial source: authentication, collection, the source's own R2 bucket, and the hand-off to the importer.                                                                                                                                                                                                | Any package. **Never `poc/`.**                                                                                                                                                                                                                                             |     | `services/raw-evidence` | The legacy ingest adapter (`kogane-ingest`). Its SQL and registration use cases moved to `packages/storage-d1` and `packages/application` in U05; the Worker stays deployed until U15 (decision D2). | Any package. **Never `poc/`, `experiments/` or `apps/`.** |
| `services/raw-evidence`                    | The legacy ingest adapter (`kogane-ingest`). Its SQL and registration use cases moved to `packages/storage-d1` and `packages/application` in U05; the Worker stays deployed until U15 (decision D2).                                                                                                                               | Any package. **Never `poc/`, `experiments/` or `apps/`.**                                                                                                                                                                                                                  |
| `services/collector-r2-importer`           | The legacy collector importer (`kogane-collector-r2-importer`). Its queue consumer and adapters were absorbed by the Processor in U08; the Worker stays deployed until U15 (decision D2).                                                                                                                                          | Any package. **Never `poc/`, `experiments/` or `apps/`.**                                                                                                                                                                                                                  |
| `experiments/observation-pipeline-local`   | The local SQLite store standing in for D1/R2, its read-only Hono API, `serve.ts`, `demo.ts`, `export-demo.ts` and the tests that need a store. Owner, expiry and stop condition in its `EXPERIMENT.md`.                                                                                                                            | Any package, and the built client as bytes.                                                                                                                                                                                                                                |
| `tests/fixtures`                           | Synthetic fixtures shared by the parser tests, the importer audit tests, the identity tests and the experiment, with `MANIFEST.sha256`.                                                                                                                                                                                            | Nothing: they are data.                                                                                                                                                                                                                                                    |
| `tests/`                                   | The repository-wide tests that belong to no workspace, and `tests/fixtures`.                                                                                                                                                                                                                                                       | Anything; it is test code.                                                                                                                                                                                                                                                 |
| `config/`                                  | Declarative source and operational configuration that is data, not code: today `ingest-clients.json`, the ingest clients, producers and routes (decision D1).                                                                                                                                                                      | Nothing: it is data, rendered by `scripts/config-bootstrap.ts`.                                                                                                                                                                                                            |
| `infra/`                                   | The resource, CORE/READ schema, dependency, deploy-order, CI-worker, risk-path, generated-file and retention ledgers, and the rendered bootstrap SQL. See [infra-ledgers.md](infra-ledgers.md).                                                                                                                                    | Nothing: generated or hand-maintained data.                                                                                                                                                                                                                                |
| `scripts/`, `tasks/_lib/`                  | The generators behind the ledgers and the repository-wide guards, with their tests. `tasks/_lib` holds what a mise task runs; `scripts/` holds what a ledger task runs.                                                                                                                                                            | Each other and the packages; never a service's `src`.                                                                                                                                                                                                                      |

Packages are imported by relative path (`../../../packages/parsers/src/...`).
Everything is one Bun workspace with one root `bun.lock`; nothing is published.

## Where the layout stands

Chapter 07 §1 (decision D1) names five moves. Four are done, and the directory
that proves it is always `infra/resources.md`: it is generated from the Wrangler
configurations on disk, so it says which directory each deployed Worker is
built from today, whatever this prose says.

| Move                                                                                                 | State                                                                                                               |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| PoC client → `apps/web`, fixtures → `tests/fixtures`                                                 | done (U04)                                                                                                          |
| Local store → `experiments/observation-pipeline-local`                                               | done (U04), with an `EXPERIMENT.md` carrying owner, expiry and stop condition                                       |
| New packages `collection` and `storage-d1`                                                           | done (U07, U05); CORE and READ migrations live in `packages/storage-d1/migrations`                                  |
| `services/evidence-browser` → `services/app`, `services/observation-pipeline` → `services/processor` | done, `git mv` only (see below)                                                                                     |
| `poc/<source>-worker` → `services/collector-<source>`                                                | the collector promotion; each collector moves with its Worker name, cron, Email route, bucket and secrets unchanged |

Two directories stay where they are on purpose:

- **`services/raw-evidence`** and **`services/collector-r2-importer`**. Their
  logic moved into the packages and into the Processor (U05, U08); the Workers
  stay deployed as the legacy adapters until each is retired against the
  checklist in [legacy-retirement.md](legacy-retirement.md). They carry the
  `retire-after-verification` disposition in the resource ledger, which is the
  record that the code is deliberately still here.
- **`experiments/`**, for the probes that are still open: each carries an
  `EXPERIMENT.md` with its owner and expiry. A probe is not deleted because
  nothing imports it (07 §6, acceptance G0-12) — two of them are deployed
  Workers with their own resources, and each carries its disposition in the
  ledger. `poc/` is gone, as its own README said its last step would be: the
  collector runtime inventory is now
  [collector runtime profiles](collector-runtime-profiles.md), the finished
  probes are in `docs/research/`, and `COMPLETED_DISPOSITIONS` in
  `scripts/resource-ledger.ts` names the commit each one's code was last on.

There is no `tools/` directory and there will not be one (decision D1): a
generator belongs next to the ledger it writes (`scripts/`), and anything a
developer runs is a mise task (`tasks/`).

### `experiments/`

One experiment, and the rule that keeps the list short: an experiment carries
an `EXPERIMENT.md` with an owner, an expiry and a stop condition, and when it
stops it becomes a `docs/research/<name>.md` with its code removed — not a
directory nobody dares delete.

| Experiment                               | Owner   | Expiry     | Stop condition                                                                                                                           |
| ---------------------------------------- | ------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `experiments/observation-pipeline-local` | risu729 | 2026-12-31 | The App API covers replay and status through `/api/ops/v1/*`; what it settled is appended to `docs/research/observation-pipeline-poc.md` |

It declares no Cloudflare resource. Two things still depend on it and both are
named rather than accidental: `local-pipeline:export-demo` writes the
synthetic snapshot the `kogane-demo` Worker serves (declared in
`infra/generated-files.json`, so the tasks that read it must depend on the task
that writes it), and its SQLite queries are the independent second
implementation the D1 reader's snapshot and publication-gate tests are compared
against.

`docs/research/observation-pipeline-poc.md` is the finished half of the same
rule: the PoC that produced the pipeline is written down there and its code is
gone.

## The rules CI enforces

Three guards, all in the repository-wide task (`mise run ci:root`), because
they belong to no single workspace.

**1. Specifiers.** `tasks/_lib/import-boundaries.ts` states the rules and
`tasks/_lib/import-boundaries.test.ts` runs them over every tracked TypeScript
file:

1. **Nothing under `services/*/src` or `packages/*/src` may import a module
   inside `poc/`, `experiments/` or `apps/`.** A deployed Worker that imports
   an experiment cannot be reviewed apart from it; and the client is a consumer
   of the contracts, never a source of them.
2. **Nothing under `apps/web` may import a service's `src`, the SQL of
   `packages/read-model`, `packages/storage-d1`, a PoC or an experiment.** The
   UI reads the HTTP contract; a query builder in the UI would be a second,
   unreviewed reader in front of the same database.

Every rule is pinned by a positive and a negative fixture string, so a guard
that stopped recognising the crossing it exists to catch fails instead of
passing vacuously. Only `import`, `export … from` and dynamic `import()`
specifiers count: a fixture path is data, not a dependency.

There is exactly one exception, and it is asserted by name:
`apps/web/test/evidence-preview.browser.test.ts` imports
`services/app/src/http.ts` to boot the Worker's own response
helper in-process and prove the client still renders under the production CSP.
Vite never sees `test/`, so that edge is not in the shipped bundle — and the
test that records the exception fails if a second file starts using it.

Tests and scripts are otherwise outside rule 1 on purpose: the importer's audit
tests compare against the PoC collectors that produced the bytes they audit.

**2. Resolved modules.** `mise run root:depcruise` runs dependency-cruiser over
`services packages apps experiments` with the same two rules
(`dependency-cruiser.config.mjs`). A text guard reads specifiers as written; a
bare specifier that resolves into a workspace through `node_modules`, an
`exports` map, an alias or a type-only import is only visible in the resolved
graph (`tsPreCompilationDeps: true` is what keeps the type-only edges).

dependency-cruiser 18 supports `typescript` < 7 and, with none resolvable,
cruises ~44 modules instead of 530 while still exiting 0. The root manifest
therefore keeps `typescript@5.9.3` (the Worker workspaces keep their own 7.x),
and `tasks/_lib/depcruise.ts` fails unless a TypeScript transpiler was found,
at least 400 modules were cruised, and three known cross-workspace edges are
still in the graph.

**3. Build closure.** Imports are not the whole dependency. A Worker that
serves bytes built inside an experiment depends on it just as hard as one that
imports it, and no import guard can see that. `assetViolations` reads every
tracked Wrangler `assets.directory` and fails when it resolves inside `poc/` or
`experiments/`. Both evidence-browser configs now serve `apps/web/dist*`.

## Fixtures

`tests/fixtures/observation-pipeline/**` are the synthetic fixtures, moved with
`git mv` and unchanged byte for byte.
`tests/fixtures/MANIFEST.sha256` records each file's SHA-256 as
`git show d096178:poc/observation-pipeline/fixtures/<path>` produced it, and
`tests/fixture-manifest.test.ts` re-hashes what is on disk, asserts the
manifest, `git ls-files` and the directory on disk describe the same set (a
fixture copied in and never pinned fails, tracked or not), and pins the
`**/fixtures/**` exclusion in hk.pkl, oxfmt, oxlint and typos. A byte guarantee
is only worth the tools that agree not to rewrite the bytes (acceptance test
G0-04).

## Compatibility re-exports are gone

The 27 one-line `export * from` modules D07 left under
`poc/observation-pipeline/{src,shared}` were deleted in U04, together with the
last importer of any of them. Every consumer now names the package path. There
is no compatibility layer left to keep in step.

U05 added the same kind of shim in the two services whose modules moved into
`packages/storage-d1` and `packages/application`:
`services/processor/src/{publication-gate,identity-store,
identity-commands,identity-keys,identity-audit,identity-policies/index,
decision-outbox}.ts` and
`services/raw-evidence/src/{store,structure,origins,canonical}.ts`. Each is a
re-export with a note naming the new home; none carries behaviour. They exist
so that no call site had to move in the same change as the code, and so that
the diff of the move is readable as a move.

## The two service directories renamed

The App and the Processor now sit at the names of the target layout (chapter
07 §1, decision D1):

| Was                             | Is                   | Deploys                                  |
| ------------------------------- | -------------------- | ---------------------------------------- |
| `services/evidence-browser`     | `services/app`       | `kogane-evidence-browser`, `kogane-demo` |
| `services/observation-pipeline` | `services/processor` | `kogane-observation-pipeline`            |

Both moves are `git mv` and nothing else: the task short names were already
`app` and `processor`, and **no runtime resource identity changed**. The Worker
names, the cron `*/5 * * * *`, the `kogane-collection-terminals` queue consumer
and its dead-letter queue, the `kogane-raw-evidence` and `kogane-read` database
ids, the R2 buckets, the service bindings and every `var` name are what they
were. `wrangler deploy` from the new directory updates the same scripts; it
does not create new ones (acceptance tests G0-06, G0-07, G5-15).

Nothing inside the Wrangler configurations had to change either. Both
directories stayed two levels below the repository root, so
`../../apps/web/dist`, `../../apps/web/dist-production`,
`../../packages/storage-d1/migrations/core` and
`../../packages/storage-d1/migrations/read` still resolve. Six of the seven
configurations are therefore byte-identical to their pre-move bytes; the
seventh, `services/processor/wrangler.read-migrations.jsonc`, differs only in
the comment that quotes the `wrangler d1 migrations apply --config <path>`
command whose path is the file's own.

`scripts/resource-ledger.test.ts` freezes the identity line of all seven — Worker
name, cron, queue, bucket, database id, Durable Object class and tag, bindings,
`var` and secret names, and the configuration's SHA-256 — captured before the
move, so a later edit that renames a resource under cover of a directory move
fails there rather than in production.

One reference deliberately keeps an old path:
`packages/storage-d1/migrations/core/0036_publication_event_guard.sql` names
`services/observation-pipeline/src/publication-gate.ts` in a comment. Applied
migrations are immutable, bytes included, and the CORE schema ledger digests
them.

`infra/risk-paths.json` carried `services/evidence-browser/src/auth.ts` next to
`services/app/src/auth.ts` until U15, so that a pull request opened against an
older base was still high risk. U15 dropped it together with
`services/raw-evidence/migrations/**`, which U05 had already emptied: both
directories are gone, so the patterns could only have matched a file re-created
at an abandoned path. `scripts/automerge.test.ts` keeps one negative case over
exactly those two paths, so a rule set that started matching everything fails
there.

The collector task short names (`<source>-worker`, `vpass-json`) and the npm
package names (`@kogane/evidence-browser`, `@kogane/observation-pipeline`) are
not part of this change; a later item renames them.

## Parser build identity did not move

`parser_releases.code_digest` is SHA-256 over the **paths and contents** of a
parser's source closure, migration 0028 refuses to register the same parser
name and version with a different digest, and the digest feeds the transform
manifest and `input_fingerprint`. A relocation that changed it would not be a
refactor: it would invalidate every historical parse and be refused at
deployment.

Two things keep every digest byte-identical:

- The three files in the digest range whose relative imports would otherwise
  have changed — `src/types.ts`, `src/parsers/coverage.ts`,
  `src/parsers/util.ts` — resolve their existing specifiers unchanged from the
  new location. `src/money.ts` moved into `packages/parsers` for the same
  reason, even though the HTTP contract also uses it: `parsers/util.ts` names
  it as `../money.ts`, and rewriting that line would have changed 33 digests.
- `RECORDED_PATHS` in `packages/parsers/scripts/parser-digests.ts` records each
  file under the repository path it had when its digest was first written. Only
  the name is pinned; a content change still changes the digest, which is the
  rule the review asks for.

`packages/parsers/src/parsers/digests.ts` is therefore unchanged, and
`packages/parsers/test/parser-digests.test.ts` still asserts that a Sony
parser's sources contain `poc/observation-pipeline/src/parsers/util.ts` and
`poc/observation-pipeline/src/types.ts` — the historical names, which is why
they survive a directory that no longer exists. That test failing is the signal
that a digest moved (acceptance test G0-05).

## What was verified locally

With synthetic fixtures only, on this checkout, after U04:

- `apps/web` — typecheck, the three isolated builds and 71 tests across 16
  files, browser tests included. Built from the same root lockfile, the
  evidence bundle is byte-identical to the pre-move build of
  `poc/observation-pipeline/web`; the local and production bundles differ by
  exactly one token, the `opsApi` capability that U06 added to
  `packages/observation-shared/src/api-schema.ts` after the move. A build of
  `origin/main`'s PoC with its own former `bun.lock` differs further, and only
  in the minifier's output (`while(1)` for `while(!0)`, boolean rewrites):
  that lockfile resolved `rolldown@1.2.6` where the root lockfile resolves
  `1.2.8`. The CSS is identical in every comparison.
- `experiments/observation-pipeline-local` — typecheck, the demo export and
  254 tests across 18 files, browser tests included.
- `packages/parsers` and `packages/observation-shared` — their suites, digest
  parity test and frozen coverage contract included.
- `services/app`, `services/processor`,
  `services/collector-r2-importer`, `services/raw-evidence` — their CI plans,
  `wrangler deploy --dry-run` included.
- `ci:root` — the manifest guard, the repository-wide tests and
  `root:depcruise` (530 modules, no violations).

Nothing was deployed and nothing was run against production data.

## Deployment

There is no migration, no flag and no schema change, and no stored value
changes. The deployed bundles are rebuilt from the new paths with the same
content the same lockfile produced before the move (see above), so writer and
reader can be deployed in any order and a rollback is the previous revision of
each Worker. `kogane-demo` must be deployed from a
checkout where `local-pipeline:export-demo` has run: its snapshot is generated,
not committed.

The same holds for the App and Processor directory rename above: it changes no
migration, flag, schema or stored value, and no resource identity, so the
deploy order of `infra/deploy-order.json` is unchanged and a rollback is the
previous revision of each Worker. What the rename does change is where CD runs
Wrangler from — `services/app` and `services/processor` — so a deploy or a
rollback must be driven from a checkout that contains this change, or from one
that predates it entirely; a `working-directory` from one half and a
configuration from the other resolves to nothing and fails before any upload.
