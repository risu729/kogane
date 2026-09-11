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

| Directory                                  | Holds                                                                                                                                                                                                                                                                                                                              | May import                                                                                                                                |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/domain`                          | Value, time, metric, scope, coverage, context and decision contracts.                                                                                                                                                                                                                                                              | Nothing outside itself.                                                                                                                   |
| `packages/evidence-contract`               | Ingest descriptor schema, normalization, canonical encoding, digest.                                                                                                                                                                                                                                                               | `packages/domain`.                                                                                                                        |
| `packages/collection`                      | Shared DATA bucket contract: key layout, the `terminal-v1` manifest, its digest, the terminal-last writer, the reader/verifier and the stage vocabulary.                                                                                                                                                                           | `packages/evidence-contract`.                                                                                                             |
| `packages/observation-shared`              | The HTTP/UI contracts and the value semantics every reader shares: `api-contract`, `api-schema`, `api-validation`, `balance-semantics`, `activity-semantics`, `financial-products`, `identity-contract`, `organization-contract`, `account-connection-contract`, `normalized-decimal`, `evidence-contract`, `evidence-validation`. | `packages/domain`, `packages/parsers` (money only).                                                                                       |
| `packages/observation-shared/test-support` | The API conformance checks the production Worker and the local store both run. Test code, imported only by tests.                                                                                                                                                                                                                  | The package's own `src`.                                                                                                                  |
| `packages/parsers`                         | The deployed parsers (`src/parsers/**`), the parser contract (`src/types.ts`), money formatting and minor-unit rules (`src/money.ts`), the snapshot-selection SQL (`src/snapshot-query.ts`), the build-digest generator and the coverage-contract freezer (`scripts/`).                                                            | `packages/domain`.                                                                                                                        |
| `packages/identity`                        | Identity resolution over stored observations and the per-source rules.                                                                                                                                                                                                                                                             | `packages/domain`, `packages/parsers` (types only).                                                                                       |
| `packages/read-model`                      | The explicit query repository and DTO mappers.                                                                                                                                                                                                                                                                                     | `packages/domain`, `packages/observation-shared`, `packages/parsers` (the snapshot CTEs).                                                 |
| `packages/application`                     | QuerySpec / command application services shared by HTTP, UI and MCP.                                                                                                                                                                                                                                                               | The packages above.                                                                                                                       |
| `apps/web`                                 | The React client: `index.html`, `src/**`, `vite.config.ts`, the three build modes and the frontend tests.                                                                                                                                                                                                                          | The packages, over the HTTP contract. **Never a service's `src`, `packages/storage-d1`, the read model's SQL, `poc/` or `experiments/`.** |
| `services/*`                               | Workers: HTTP, D1, R2, queues, scheduling, authentication.                                                                                                                                                                                                                                                                         | Any package. **Never `poc/`, `experiments/` or `apps/`.**                                                                                 |
| `experiments/observation-pipeline-local`   | The local SQLite store standing in for D1/R2, its read-only Hono API, `serve.ts`, `demo.ts`, `export-demo.ts` and the tests that need a store. Owner, expiry and stop condition in its `EXPERIMENT.md`.                                                                                                                            | Any package, and the built client as bytes.                                                                                               |
| `poc/*` (collectors)                       | Per-source collection experiments.                                                                                                                                                                                                                                                                                                 | Themselves.                                                                                                                               |
| `tests/fixtures`                           | Synthetic fixtures shared by the parser tests, the importer audit tests, the identity tests and the experiment, with `MANIFEST.sha256`.                                                                                                                                                                                            | Nothing: they are data.                                                                                                                   |

Packages are imported by relative path (`../../../packages/parsers/src/...`).
Everything is one Bun workspace with one root `bun.lock`; nothing is published.

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
`services/evidence-browser/src/http.ts` to boot the Worker's own response
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
- `services/evidence-browser`, `services/observation-pipeline`,
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
