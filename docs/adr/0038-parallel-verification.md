# ADR 0038: Reduce verification waiting with one graph and bounded file workers

- Status: proposed until this PR merges; accepted upon merge
- Date: 2026-10-04

## Context

[PR #417 CI run 37178388756](https://github.com/risu729/kogane/actions/runs/37178388756)
passed on 2026-10-04. Its `Checks` job lasted 632 seconds. The native graph took
606.43 seconds, dominated by processor tests (510.40 seconds, 607 tests across
64 files; 606 passed, with the existing opt-in full-scale timing benchmark
skipped). Every file ran sequentially. After tests, a separate dry-run post
graph regenerated 19 Worker type declarations and the production web client,
then validated deployments; this added approximately 62 seconds after processor
tests finished. The processor's files use independent local Miniflare stores,
and the pinned Bun 1.4.2 provides isolated file workers.

Local and hosted verification must retain every linter, repository guard,
workspace check and Worker validation. Every pull request and merged `main`
result must be checked; required status skips cannot be accepted as success.

## Options considered

1. Keep the sequential processor suite and the separate deployment post graph.
   This retains unnecessary critical-path waiting and duplicate preparation.
2. Divide checks between several hosted jobs, with complete coverage guards.
   This may provide more CPUs but duplicates setup and adds hosted runner
   minutes and matrix/partition coverage responsibilities.
3. Use one native dependency graph and two processor file workers in the
   existing runner, keeping the common full verification entrypoint.
4. Select tests by changed paths or omit slow synthetic/scale cases. Rejected:
   all checks protect repository-wide invariants, including merged results.

## Decision

Choose option 3. The root `checks` task schedules `dry-run` alongside repository
and workspace checks. Existing type/build/generated-input dependencies order
preparation and reuse it once in that graph. Processor `test` invokes
`bun test --parallel=2`, which discovers the full suite and isolates every file
while keeping tests within a file sequential. The fixed bound limits contention
with the other native tasks.

`mise exec -- hk check --all --no-fail-fast` remains the complete local and
GitHub Actions command. The `Checks` and required `CI Check` jobs, fail-closed
aggregation, triggers and permissions remain in force. There are no path
filters, optional shards, retry-based acceptance or task-result caches. Other
security, signature and release workflows are unchanged.

## Consequences

- Shared types and client build tasks run once rather than in both normal and
  post graphs; deployment validation can overlap tests once its inputs exist.
- Processor file execution has two workers instead of one serial file path.
  Every discovered file, including synthetic scale cases, remains included;
  the existing opt-in timing benchmark keeps its previous skip policy.
- No extra Actions runners or repeated hosted setup are added. Runner minutes
  can fall with elapsed time; resource contention and isolation/import overhead
  mean a twofold speedup is not guaranteed.
- Fresh per-file state can expose order dependencies previously masked by one
  shared global. Failures must be repaired, not skipped or retried to pass.
- Container builds, Chromium installation, individual slow files and runner
  queueing can still dominate. The hosted before/after measurement is necessary
  to quantify the actual improvement.

## Verification

Native execution-plan tests require every declared Worker types and web client
build command exactly once. Existing manifest, generated-input and CI wiring
checks continue to prove full coverage, shared preparation and fail-closed
required status. Run the complete processor task to exercise worker isolation
and the Miniflare preload, then run the complete native hk suite on the combined
change. Measure the pull-request and merged `main` runs against the baseline in
[continuous integration](../ci.md#waiting-time-baseline-and-limits), checking
full-suite counts and total job durations as well as elapsed waiting.

The file-worker semantics are documented by the official
[Bun parallel test guide](https://bun.com/docs/test/parallel). The graph remains
owned by [native mise tasks](https://mise.jdx.dev/tasks/).
