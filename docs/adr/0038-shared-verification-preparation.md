# ADR 0038: Isolate complete hosted verification while sharing preparation

- Status: proposed until this PR merges; accepted upon merge
- Date: 2026-10-04

## Context

[PR #417 CI](https://github.com/risu729/kogane/actions/runs/37178388756) passed
in 632 seconds. Its 606.43-second native graph included 607 processor tests/64
files (606 passed, one existing benchmark skipped) and a separate deployment
post graph that repeated 19 Worker type commands and the production client.
[Recent main](https://github.com/risu729/kogane/actions/runs/37179821065) passed
in 617 seconds; [direct base](https://github.com/risu729/kogane/actions/runs/37180511042)
passed in 967 seconds with the same 616 processor tests/66 files. Several
unchanged tasks also slowed, so individual hosted runs are not controlled
performance comparisons.

Three combined PR attempts failed existing storage/processor deadlines:
[two file workers](https://github.com/risu729/kogane/actions/runs/37180913140),
[serial](https://github.com/risu729/kogane/actions/runs/37181978822), and
[serial with later Docker builds](https://github.com/risu729/kogane/actions/runs/37183370112).
They took 746, 963 and 1,010 seconds respectively. Shared preparation worked
(19 types/three builds), but the latest storage case exceeded 30 seconds before
Docker began, disproving Docker overlap as a sufficient explanation. Its
processor suite passed all 632 tests plus one existing skip across 68 files in
870.83 seconds; processor execution remains the critical path.

A separate investigation found repeated SQLite compilation in synthetic
storage seeding. Reusing prepared statements preserves the fixture SQL, values,
ordering, migrations and comparison assertions while removing setup overhead.
That targeted repair does not establish a shorter processor critical path.
Local and hosted verification must retain all checks and existing deadlines.

## Options considered

1. Keep the separate post graph and repeated preparation. Rejected duplication.
2. Share preparation on one runner, optionally with two file workers or later
   Docker builds. Executed attempts retained coverage but failed reliability
   and elapsed-time goals; do not accept another blind rerun as an optimization.
3. Isolate two native processor file shards on separate hosted runners, plus a
   complete remainder runner. Adopted with exact coverage and fail-closed gates.
4. Omit slow cases, use changed-path selection, raise existing deadlines or
   accept retries/skips. Rejected: these weaken the requested validation.

## Decision

Local `mise exec -- hk check --all --no-fail-fast` and its complete native graph
remain in force. Hosted `Checks` runs all hk lint steps and native `ci:remainder`.
Two `Processor` matrix jobs run `bun test --shard=1/2` and `--shard=2/2` through
native workspace tasks, retaining their working directory, preload and serial
within-runner behavior. Bun's default discovery sorts paths and assigns files
by index modulo two; no custom/manual file list or test-name filter is used.

The remainder owns every other executable leaf, including processor/storage
typechecks. Its full storage suite waits for the selected remainder workspace
aggregate, and Docker bodies wait for storage. Preparation runs once within
that graph; standalone dry runs do not select tests. A native leaf-union guard
compares all hosted partitions to local `checks` and rejects missing/extra
leaves, including future workspace or processor/storage check additions. An
executed Bun fixture verifies all default discovery suffixes, exclusions,
preload behavior, sequential tests and disjoint shard union. Since native Bun
can return success for an empty shard, required coverage validation rejects
that state and guards against unaccounted discovery overrides. Newly discovered processor files join automatically.

The public Ubuntu runner provides four CPUs. Hosted native task concurrency is
bounded at four; each processor shard uses one serial Bun process. The processor
matrix disables fail-fast. Required `CI Check` always runs and requires both
`Checks` and the entire processor matrix to return exactly `success`, rejecting
failure, cancellation and unexpected skips. Every PR and merged `main` runs the
same complete union. Workflow permissions, other security/signature checks,
release gates and production credential boundaries remain in force.

## Consequences and verification

- Three validation runners add two checkout/tool/dependency setups and repeated
  processor type generation. Each remainder graph still shares preparation.
  Total runner durations may increase while elapsed waiting decreases.
- The latest 68 processor file-header intervals would split into approximately
  402 and 469 seconds by sorted modulo assignment. This estimates capacity;
  it is not a hosted measurement, guaranteed 2x gain or achieved latency goal.
- Focused guards require exact leaf coverage, both native shard commands,
  selected storage/Docker ordering, standalone behavior and fail-closed gates.
  Existing runtime deadlines are unchanged; only new process-plan guards use
  explicit bounded subprocess/test deadlines.
- The complete partitioned PR and merged-result graphs must pass. Record actual
  elapsed and summed job durations against the recorded baselines before
  claiming a waiting-time benefit. Hosted variation remains a confounder.

See [CI measurements and limits](../ci.md#waiting-time-baseline-and-limits),
[native mise tasks](https://mise.jdx.dev/tasks/task-configuration.html#wait_for)
and [native Bun sharding](https://bun.com/docs/test/parallel#splitting-a-suite-across-ci-machines-with-shard).
