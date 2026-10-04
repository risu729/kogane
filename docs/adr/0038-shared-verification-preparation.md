# ADR 0038: Share verification preparation in one native graph

- Status: proposed until this PR merges; accepted upon merge
- Date: 2026-10-04

## Context

[PR #417 CI run 37178388756](https://github.com/risu729/kogane/actions/runs/37178388756)
passed with a 632-second `Checks` job and a 606.43-second native graph.
Processor tests dominated the graph (510.40-second task, 607 tests across 64
files, 606 passed and one existing opt-in benchmark skipped). A separate dry-run
post graph regenerated 19 Worker type declarations and the production client,
then validated deployments, adding approximately 62 seconds after the suite.
[Recent main run 37179821065](https://github.com/risu729/kogane/actions/runs/37179821065)
passed in 617 seconds with 616 processor tests across 66 files and the same
38 type/four client-build launches. Total job durations were 623 seconds.

Local and hosted verification must retain every linter, repository guard,
workspace check and Worker validation. Every pull request and merged `main`
result must be checked; required-status skips cannot count as success.

## Options considered

1. Retain the separate deployment post graph, including repeated preparation.
2. Share preparation in one native graph, retaining serial processor tests
   and ordering Docker deployment builds after workspace checks.
3. Share preparation and add two isolated processor file workers in the same
   hosted runner. The first combined PR run tested this option and rejected it
   on observed timeout failures and elapsed time, as described below.
4. Divide checks among hosted jobs with full coverage guards. This provides
   more CPU capacity but adds runner minutes, repeated setup and partition
   coverage responsibilities; it is not adopted by this change.
5. Select tests by changed paths or omit slow synthetic/scale cases. Rejected:
   all checks protect repository-wide invariants, including merged results.

## Decision

Choose option 2. Root `checks` schedules `ci:workspaces` and `dry-run` in one
graph. `ci:workspaces` owns repository and every workspace CI aggregate. The
four Docker-building dry-run bodies wait for `//:ci:workspaces`, so their actual
Docker invocations begin after its child checks complete. Non-container dry runs
can overlap checks. `wait_for` only orders selected tasks, so standalone dry runs
do not pull in workspace tests. Existing type/build/generated-input dependencies
order preparation and reuse it once in that graph. Processor `test` retains `bun test`
and its complete serial suite; the existing opt-in timing benchmark keeps its
previous skip policy.

The new native-plan guard runs two synchronous mise subprocesses. It bounds each
subprocess to ten seconds and the test to thirty seconds, allowing task discovery
and planning under full load while still failing a hung command. Existing runtime
test timeouts remain unchanged.

`mise exec -- hk check --all --no-fail-fast` remains the complete local and hosted
command. `Checks`, required `CI Check`, fail-closed aggregation, triggers and
permissions remain in force. There are no path filters, optional shards,
retry-based acceptance or task-result caches. Other security, signature and
release workflows are unchanged.

## Consequences

- Shared types and client builds run once rather than in normal and post graphs.
  Non-container deployment validation can overlap tests after its inputs exist;
  Docker builds run after workspace checks, retaining a validation tail.
- Processor files remain sequential in one process. Other workspace checks and
  non-container validations still share the existing runner through mise concurrency.
- No additional hosted jobs or setup are introduced. Shared preparation can
  reduce waiting and runner time; a speedup must still be demonstrated on the
  complete hosted graph rather than inferred from the plan.
- [The first PR #418 run 37180913140](https://github.com/risu729/kogane/actions/runs/37180913140)
  failed with two file workers: `Checks` took 746 seconds, the graph 705.18
  seconds, and 633 processor tests across 68 files took 651.36 seconds with
  630 passed, two failed, one error reported and the same benchmark skipped. Total job durations
  were 752 seconds. Preparation deduplication succeeded (19 types/three builds),
  but the native-plan guard and existing storage/processor cases timed out;
  disposal following one timeout also invalidated a Miniflare stub.
- The combined PR adds two cost-test files and seventeen tests compared with
  recent main, so one run does not attribute every added second to isolation.
  It establishes that this worker configuration failed the reliability and
  waiting-time goals. Restore serial execution rather than relax existing
  deadlines or try further worker bounds without evidence.
- [The serial run 37181978822](https://github.com/risu729/kogane/actions/runs/37181978822)
  still failed after 963 seconds. Its processor suite passed all 632 tests with
  one existing skip (633 tests/68 files, 877.45 seconds). The only failure was
  the existing 2,000-row storage identity case: 31.99 seconds exceeded its
  30-second deadline while a Shinsei Docker build was active. Preparation ran
  once (19 type/three build commands). Separate those Docker invocations from
  workspace tests without raising existing deadlines. The overlap is evidence
  for the scheduling choice, not proof of the sole cause.
- [The direct-base run 37180511042](https://github.com/risu729/kogane/actions/runs/37180511042)
  passed in 967 seconds, including 809.90 seconds for 616 processor tests/66
  files. Unchanged workspace tasks also slowed substantially versus recent
  main, illustrating hosted timing variation. No causal speedup is claimed.
- Container builds, Chromium installation, resource contention and queueing can
  still dominate. Complete hosted validation and measurement of the phased
  graph remain required before claiming a performance gain.

## Verification

Native execution-plan tests require every declared Worker type and client build
command once, with bounded subprocess/test execution. Existing manifest,
generated-input and CI wiring checks preserve complete coverage, preparation
ordering and the fail-closed required status. Focused guards validate selected ordering, aggregate child completion and
standalone selection; the combined full hk suite and Docker-capable hosted graph must then
pass with all expanded tests. Compare pull-request and merged `main` elapsed and
total job durations against the recorded baselines in
[continuous integration](../ci.md#waiting-time-baseline-and-limits).

The dependency graph remains owned by [native mise tasks](https://mise.jdx.dev/tasks/).
