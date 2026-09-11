# Package layout and import boundaries

Design review finding **D07** (PR-02): the deployed Workers imported the parsers, the identity resolver, the
observation types and the shared HTTP contracts directly out of
`poc/observation-pipeline`. The directory name was not the problem. The
problem was that the contracts that must stay stable, the experiments that
must stay free to change, and the code that is deployed all had one owner, so
neither side could be changed without reasoning about the other.

This document states where each of those modules lives now, what may import
what, and why nothing about the pipeline's behaviour changed when they moved.

## Ownership

| Directory                        | Holds                                                                                                                                                                                                                                                                                                                              | May import                                                                                |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `packages/domain`                | Value, time, metric, scope, coverage, context and decision contracts.                                                                                                                                                                                                                                                              | Nothing outside itself.                                                                   |
| `packages/evidence-contract`     | Ingest descriptor schema, normalization, canonical encoding, digest.                                                                                                                                                                                                                                                               | `packages/domain`.                                                                        |
| `packages/collection`            | Shared DATA bucket contract: key layout, the `terminal-v1` manifest, its digest, the terminal-last writer, the reader/verifier and the stage vocabulary.                                                                                                                                                                           | `packages/evidence-contract`.                                                             |
| `packages/observation-shared`    | The HTTP/UI contracts and the value semantics every reader shares: `api-contract`, `api-schema`, `api-validation`, `balance-semantics`, `activity-semantics`, `financial-products`, `identity-contract`, `organization-contract`, `account-connection-contract`, `normalized-decimal`, `evidence-contract`, `evidence-validation`. | `packages/domain`, `packages/parsers` (money only).                                       |
| `packages/parsers`               | The deployed parsers (`src/parsers/**`), the parser contract (`src/types.ts`), money formatting and minor-unit rules (`src/money.ts`), the snapshot-selection SQL (`src/snapshot-query.ts`) and the build-digest generator (`scripts/parser-digests.ts`).                                                                          | `packages/domain`.                                                                        |
| `packages/identity`              | Identity resolution over stored observations and the per-source rules.                                                                                                                                                                                                                                                             | `packages/domain`, `packages/parsers` (types only).                                       |
| `packages/read-model`            | The explicit query repository and DTO mappers.                                                                                                                                                                                                                                                                                     | `packages/domain`, `packages/observation-shared`, `packages/parsers` (the snapshot CTEs). |
| `packages/application`           | QuerySpec / command application services shared by HTTP, UI and MCP.                                                                                                                                                                                                                                                               | The packages above.                                                                       |
| `services/*`                     | Workers: HTTP, D1, R2, queues, scheduling, authentication.                                                                                                                                                                                                                                                                         | Any package. **Never `poc/`.**                                                            |
| `poc/observation-pipeline`       | The local entry points (`src/ingest.ts`, `src/parse.ts`, `src/store.ts`, `src/queries.ts`, `src/api.ts`, `src/serve.ts`), the synthetic fixtures, and the web UI.                                                                                                                                                                  | Any package, over the HTTP contract for the UI.                                           |
| `services/collector-*`           | One deployed Worker per financial source: authentication, collection, the source's own R2 bucket, and the hand-off to the importer.                                                                                                                                                                                                | Any package. **Never `poc/`.**                                                            |
| `packages/collector-diagnostics` | The redaction-safe diagnostics buffer every collector records its stages and failures into.                                                                                                                                                                                                                                        | Nothing.                                                                                  |
| `packages/sbi-vc-trade-client`   | The local read-only SBI VC TRADE client. Never deployed; the collector owns the schedule and the session.                                                                                                                                                                                                                          | Nothing.                                                                                  |
| `poc/*` (probes)                 | Runtime and browser experiments that deploy nothing a source depends on.                                                                                                                                                                                                                                                           | Themselves.                                                                               |

Packages are imported by relative path (`../../../packages/parsers/src/...`),
the way the services already imported the PoC. Nothing was published, no
workspace was introduced, and no service, database or authentication path was
added: this is a boundary change, not a topology change.

## The two rules CI enforces

`tasks/_lib/import-boundaries.ts` states them and
`tasks/_lib/import-boundaries.test.ts` runs them over every tracked TypeScript
file in the repository-wide guard task (`mise run ci:root`).

1. **Nothing under `services/*/src` or `packages/*/src` may import a module
   inside `poc/`.** A deployed Worker that imports an experiment cannot be
   reviewed apart from it.
2. **Nothing under `poc/observation-pipeline/web` may import a service's `src`
   or the SQL of `packages/read-model`.** The UI reads the HTTP contract; a
   query builder in the UI would be a second, unreviewed reader in front of
   the same database.

Both rules are pinned by a positive and a negative fixture string, so the
guard fails if it ever stops recognising the crossing it exists to catch
instead of passing vacuously. Only `import`, `export … from` and dynamic
`import()` specifiers count: a fixture path is data, not a dependency.

Tests and scripts are deliberately outside rule 1. The moved parser tests
still read `poc/observation-pipeline/fixtures/**`, and the importer's audit
tests compare against the PoC collectors that produced those bytes. Moving the
fixtures would have changed nothing about the dependency direction and would
have touched every consumer.

## Compatibility re-exports

Each old location under `poc/observation-pipeline` keeps a one-line
`export * from` pointing at the package. The PoC entry points, the web UI and
the PoC tests that stayed import exactly the specifiers they did before. The
re-exports carry no behaviour of their own; adding any would split a module in
two.

They exist so that this change could be a move rather than a rewrite of the
PoC. They are the obvious thing to delete once the PoC entry points are
updated deliberately, which is not part of this change.

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

`packages/parsers/src/parsers/digests.ts` is therefore unchanged by this move,
and `packages/parsers/test/parser-digests.test.ts` still asserts that a Sony
parser's sources contain `poc/observation-pipeline/src/parsers/util.ts` and
`poc/observation-pipeline/src/types.ts` — the pre-move names. That test failing
is the signal that a digest moved.

## What was verified locally

With synthetic fixtures only, on this checkout:

- `packages/parsers` — 167 tests, including the digest parity test and the
  frozen coverage contract; the checked-in digests still describe the sources.
- `packages/identity`, `packages/observation-shared`, `packages/domain`,
  `packages/read-model`, `packages/application`, `packages/evidence-contract` —
  their own suites.
- `services/observation-pipeline`, `services/evidence-browser`,
  `services/raw-evidence`, `services/collector-r2-importer` — their offline CI
  plans, including `wrangler deploy --dry-run`.
- `poc/observation-pipeline` — typecheck, the three isolated frontend builds,
  the demo export and the full test run including the Chromium browser tests.
- The standalone step: the CI inventory, the publication-gate predicate guard
  and the new import-boundary guard.

Nothing was deployed and nothing was run against production data.

## Deployment

There is no migration, no flag and no schema change, and no stored value
changes. The deployed bundles are rebuilt from the new paths with identical
content, so writer and reader can be deployed in any order and a rollback is
the previous revision of each Worker.
