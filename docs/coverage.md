# Test coverage

Coverage is measurement infrastructure only: no numerical threshold, external
upload service, runner migration, provider upgrade or product behavior change.

## Entrypoints and reports

Ordinary local tasks retain native execution without instrumentation. Opt in with:

```sh
KOGANE_TEST_COVERAGE=true mise run //packages/collection:test
KOGANE_TEST_COVERAGE=true mise run --continue-on-error ci:remainder
mise run coverage:summary                         # expects the complete remainder
KOGANE_TEST_COVERAGE=true mise run //services/processor:test-shard-1
mise exec --no-deps -- node tasks/_lib/coverage-summary.mjs processor-1
mise run coverage:processor-baseline              # existing full serial suite
mise exec --no-deps -- node tasks/_lib/coverage-summary.mjs baseline
```

Normal CI enables collection on the same native tasks and uploads one artifact
per validation runner, keyed by checkout SHA and attempt (14-day retention).
The summary identifies every expected suite rather than accepting whatever
happens to be present. Standard text is in the test job log. Report directories:

- `<workspace>/coverage/bun/serial/`, or `1-of-2/` / `2-of-2/`: native LCOV.
- `<workspace>/coverage/workerd/serial/`: Istanbul LCOV, JSON summary and JSON.
- `services/processor/coverage/bun/baseline/`: full serial native LCOV.
- Root `coverage/<partition>/collection.json` and `summary.md`: invocation
  metadata, file identities, missing owned sources and collection state.

The manual **Processor coverage baseline** workflow runs the serial entry at the
selected ref. Record its actual checkout SHA/run/attempt when citing a baseline.
Never substitute the two faster native shard artifacts for this baseline.

## Scope and limits

Bun 1.4.2 measures the host process's loaded sources. Unimported owned files are
absent from its denominator: collection.json lists them but does not fabricate
their executable lines or force-import them. Branch/statement coverage is N/A.
Its text All files is an unweighted per-file average. LCOV has line and aggregate
function counters but no FN/FNDA identities; no shard-rate averaging or function
counter merging is performed. Test helpers and cross-workspace imports in raw
LCOV are identified outside the owned source inventory, not silently counted as
a repository total.

The existing 13 Workers suites use Vitest/coverage-istanbul 4.1.11. Their explicit
`src/**/*.{ts,tsx,js,mjs}` include (excluding declaration files) retains unloaded
owned sources as zero. These reports describe each workspace's workerd execution,
not Bun. Source paths resolve from that workspace; collection normalizes file
identity only and leaves provider output unchanged. Repeated shared identities
across scopes are not added together.

Child processes, separate Node tests and Chromium/browser execution are not
measured by Bun-host coverage. Miniflare/workerd subprocess integration success
does not establish Bun coverage of the Worker body. Financial files named
coverage.ts are not blanket-excluded; only test/generated/declaration materials
are omitted from the owned-source inventory.

No repository-wide percentage is published. Missing, failed, interrupted,
identity-mismatched, malformed or stale reports produce an incomplete collection
and a nonzero summary exit. Reports emitted after test failures remain failure
artifacts. A cancelled job can lack artifacts; the unchanged CI Check rejects
failure/cancellation/skips. Prerequisite failures are visible as missing suites.

## Fixed-version verification

A synthetic fixture proves Bun 1.4.2 text+LCOV succeeds; an LCOV-only run below
line/function thresholds exits 1. It also confirms unloaded source absence and
no function identity or branch fields. Collection fixtures verify successful
reports plus failed, interrupted, missing, stale and truncated/malformed data.
The expected-suite guard rejects runner/manifest drift, while the existing
partition guard retains native shard arguments, default discovery and preload.

Initial trials used checkout 9b5262bf586b25edcb338d4adf223a085eb7b854 with this
measurement change in the working tree. Collection Bun: 54 tests passed; Workers:
5 passed. The Workers report contains 13 owned TypeScript source files,
including unloaded schedule/operation sources at zero; SF paths are src-relative.
The source maps refer to original TypeScript line positions, not build outputs.
This is a local instrumented scope check, not proof of hosted CI or deployment.

Processor timings and additional Workers trials are recorded in the PR's actual
verification evidence. Compare a noninstrumented full serial run with the
instrumented full serial run at the same source checkout, without merging
shards. Native test duration excludes preparation; wall time includes the
invocation. Concurrent local jobs/caches affect timing. No sum-of-process-tree
peak RSS measurement is claimed by this first rollout. Standard JSON/LCOV
artifact sizes are observed per suite/run, not a guaranteed hosted storage cost.

## Follow-up

Once the measurement PR is reviewed, merged and its hosted artifacts are visible,
Cursor can add tests for concrete uncovered cases. Hand off exact SHA/artifact
links and runtime-specific uncovered lines or absent owned files. A raw low rate
in one runtime is not evidence that another runtime's tests are missing.

## Bun 1.4.2 bundle-URL negative control

Two Processor tests bundle the original alarm unchanged, replacing only the
Cloudflare platform base class. Long base64 data URLs panic when Bun finishes
coverage reporting (a 12,000-character synthetic comment is sufficient).
The test-only loader now imports the exact bundle bytes through unique short
temporary file URLs and cleans up after each suite or failed import. Only the
generated `schedule-alarm.test.mjs` module is excluded by Bun's standard
test-file exclusion; ordinary production source imports remain instrumented.
This does not measure the separately bundled alarm's original source.

The manual negative control is intentionally not part of CI:

```sh
mise exec --no-deps -- node tasks/_lib/coverage-data-url-repro.mjs
```

It records noncovered data-URL success, the covered data-URL panic/non-success,
and covered short-file success without forwarding Bun's external crash-report
URL. Core dumps are disabled and a bounded child timeout prevents a crashed
process from hanging the caller. A reproduced crash is a diagnostic observation,
never a green coverage collection. The CI fixture verifies the short-file
counterpart plus simultaneous-load isolation and cleanup.
