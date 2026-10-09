# Continuous integration

`hk check --all` is the complete local verification entrypoint. It runs lint
and formatting checks, repository guards, Knip, every workspace's typechecks,
tests and builds, and every Worker dry run. GitHub Actions runs the same full
coverage as a guarded native partition union across three validation runners.
`CI Check` remains the required merge status.

**mise is the only task runner.** No `package.json` carries a `scripts` field.
Tools are pinned in `mise.toml` and `mise.lock`; native mise monorepo tasks own
commands and their dependencies. hk decides which checks and fixes to run.
GitHub Actions provides the runner, permissions, triggers and result reporting.

## Local commands

```sh
mise trust
mise install                         # pinned tools
mise run install                     # frozen workspace dependencies
mise exec -- hk check --all --no-fail-fast
mise run check                       # the same complete check
mise run verify                      # compatibility alias for check
mise run //services/app:ci            # one workspace
mise run fix                         # apply available lint/format fixes
mise run hooks:install
```

`check` is read-only with respect to source formatting. It does generate Worker
types and local build/test outputs, and may download pinned dependencies or the
locked Playwright browser when absent. It does not run collectors, bank logins,
credential synchronization, backfills or deployments, and needs no production
credentials. `fix` intentionally changes source files. The pre-commit hook runs
only the shared lint/format steps on staged files, with unstaged work stashed;
it does not run the full test/build graph on every commit.

Plain `hk check` runs the repository verification graph even with no selected
files; hk's usual file selection still applies to file-based linters. Use
`--all` for the complete lint scan. `--no-fail-fast` collects remaining hk
failures, and the repository step uses `mise run --continue-on-error checks`
so independent workspace failures are collected too. A failed prerequisite
still prevents its dependent task from running.

The full suite runs on Linux in CI. Shell tests require GNU tools and Bash.
Frontend tests require the built client and Chromium: `CHROMIUM_PATH` selects
an installed executable locally, and the workspace browser task supplies the
locked Playwright Chromium in CI. Wrangler telemetry is disabled in CI.

## One Bun workspace

The root `package.json` defines `apps/*`, `services/*`, `packages/*`,
`experiments/*`, with one root `bun.lock`. `bunfig.toml` selects the
isolated linker. Each workspace declares its direct imports and retains its
own pinned TypeScript, Wrangler and other dependencies. Workspace tasks invoke
`./node_modules/.bin/<binary>` from that workspace; root tooling comes from
root `node_modules/.bin` on mise's PATH. No task uses an `npx` or `bunx` fallback.

The root `bun` deps provider uses `bun install --frozen-lockfile`. Its automatic
freshness check runs before mise tasks and `mise exec` when a source manifest,
lockfile or install configuration changed, or the declared output is missing.
`mise deps --explain bun` explains that decision; `mise deps --force bun` repairs
an installation. This is dependency preparation, not a second task runner.
[The dependency ledger](../infra/dependency-resolution.md) records resolution.

The runtime-probe container uses the repository root as `image_build_context`,
copies the root lockfile, install configuration and its workspace manifest,
then installs only that workspace with Bun's hoisted linker inside the image.
The image needs dependencies beside its entrypoint rather than the repository's
isolated layout. `.dockerignore` excludes evidence, credentials and build output.
The GlobalPass and SBI Shinsei containers retain their independent, frozen npm
container installs and workspace-local build contexts.

## Native monorepo tasks

The root declares `monorepo_root = true` and `[monorepo].config_roots` globs.
Each workspace owns a `mise.toml` with local task names such as `ci`, `test`,
`typecheck`, `build`, `types`, `bundle` and `dry-run`. Its directory is the
working directory automatically; root-qualified references make cross-workspace
dependencies explicit.

```sh
mise tasks ls --all                   # discover every workspace task
mise run //apps/web:test
mise run //services/processor:ci
mise run //packages/domain:typecheck
mise run dry-run                      # every validated Worker configuration
```

Local `checks` composes `ci:workspaces` and `dry-run` in one native graph.
`ci:workspaces` includes `ci:root` and every workspace `ci` task. The complete
processor suite retains serial `bun test`. Shared type/client preparation runs
once; Docker-building dry-run bodies wait for selected workspace checks.
Standalone deployment validation does not select CI tests: native `wait_for`
only orders tasks already selected.

Hosted CI uses three validation runners. `Checks` runs every hk lint step and
native `ci:remainder`, while two separate `Processor` jobs run native Bun
`--shard=1/2` and `--shard=2/2`. Each shard runs serially in the processor
workspace, with its existing preload and deadlines. Bun discovers all default
test files, sorts paths, and distributes them by index modulo two. There are no
changed-path filters, test-name selectors, retries or new test exclusions.

`ci:remainder:workspaces` includes repository guards and all other workspace
checks, plus processor/storage typechecks. The full storage test task waits for
that selected aggregate; Docker dry-run bodies wait for storage as well. All
three stages share one native graph, so the remainder reuses its preparation.
A new workspace or executable CI leaf must also be accounted for in the hosted
partition; a root guard compares the exact executable leaf union with local
`checks` and fails on omitted or extra leaves. It treats the two native processor
shards as the complete processor test leaf and tests Bun's discovery/disjoint
union on an executed fixture, including every default suffix and ignored paths.

The local command remains `mise exec -- hk check --all --no-fail-fast`. Hosted
`Checks` replaces hk's repository step with the guarded native remainder;
`CI Check` requires both that job and the entire two-shard matrix to return
exactly success. Matrix fail-fast is disabled so one failing shard does not
cancel the other. Unexpected skipped/cancelled results fail the required gate.
The workflow caps native mise concurrency at four on the documented four-CPU
public Ubuntu runner; each processor runner uses one serial Bun test process.

The processor tests read Miniflare's synchronous Node-side proxy through `services/processor/test/miniflare-sync-proxy.ts`,
preloaded by `services/processor/bunfig.toml`: under that load Miniflare's
blocked caller could read its port before the helper thread's reply was on it,
and that one early read failed every later call of the file. The same preload
also restores Miniflare's locked npm Undici implementation through
`services/processor/test/miniflare-http-proxy.ts`. Bun's built-in Undici fetch
ignores its dispatcher, bypassing Miniflare's per-runtime connection ownership,
original-URL routing and `reset = true` connection closure. Regression tests
verify routing, closure and R2 usability after a separate runtime is disposed.
This restores Miniflare's transport contract without retries or changed test
deadlines; the exact socket-close race behind the observed CI `ECONNRESET`
remains inferred. The change affects the test process only. hk's `repository` check
invokes this graph, never `check` or `verify`, avoiding recursion. Selected root aliases for old operational `<short>:<verb>` names keep the
deployment ledger and existing operational instructions working. Workspace
checks use native names; `ci:<short>` aliases are not retained. New code and docs
should use `//<workspace>:<task>`.

`ci:root` owns manifest/task coverage, repository tests, import-boundary checks
and Knip, including hosted partition coverage. Root `bundle` and `dry-run` compose workspace tasks. Deployable
Workers' bundle locations stay aligned with `infra/deploy-order.json`.

Automation tasks under `tasks/automation/` call tested implementation modules in
`tasks/_lib/ci/`. The release and auto-merge workflows use these mise tasks;
GitHub-specific triggers, permissions, credential scopes and upload actions
remain in workflow YAML. See [CI/CD automation](ci-cd.md) for their safeguards.
Operational tasks are not dependencies of the check graph.

## Adding a workspace

1. Add its `package.json` without `scripts` under a root Bun workspace glob,
   declaring every direct dependency, and update the root lockfile.
2. Add a workspace `mise.toml` under the matching monorepo config-root glob.
   Declare a `ci` aggregate with its typechecks, tests and required builds.
3. Use `//<workspace>:<task>` for dependencies, including cross-workspace ones.
4. Add the workspace to `ci:remainder:workspaces` unless it is an explicitly
   isolated processor test leaf. The exact union guard rejects omissions.
5. For a Worker, list each deployable configuration in `infra/workers-ci.json`
   and provide a `dry-run` task for those same configurations. Record any
   build preparation dependency in the task graph. Configurations that cannot
   be dry-run must be explicitly excluded in the ledger with a reason.

The manifest guard checks task discovery, workspace coverage, runnable `ci`
tasks, deployment dry-run coverage, tracked Wrangler configurations and the
ban on package scripts. A workspace is not silently omitted because someone
forgot to add another Actions matrix row or root task-file include.

## Checks and coverage

- Oxlint, Oxfmt, Tombi, yamllint and yamlfmt check source and configuration.
- Actionlint, ShellCheck, ghalint, pinact and zizmor check workflow syntax,
  permissions, action pins, shell code and unsafe workflow patterns.
- Ruff checks Python without executing probes; typos and hk-config's whole
  `hygiene` group cover spelling, whitespace, line endings, byte-order marks,
  smart quotes, merge markers, case conflicts, symlinks, submodules and
  shebangs matching executable bits in both directions. One synthetic bank
  page in the St.George experiment test keeps its curly apostrophes and is
  excluded from the smart-quote check.
- Repository guards cover manifests, task coverage, infrastructure ledgers,
  auto-merge and release decisions, publication gates and import boundaries.
- Knip checks unlisted dependencies and unresolved imports as build failures.
  Its broader unused-code report remains advisory because static analysis
  cannot prove every runtime entrypoint. The report and policy are documented
  in [unused-code analysis](unused-report.md).
- Every workspace `ci` task runs its declared type generation, typechecks,
  tests and builds. Container checks use frozen installs; syntax-only probes
  remain syntax-only rather than executing live infrastructure experiments.
- Worker `dry-run` tasks use each workspace's pinned Wrangler, never upload
  code and require no Cloudflare account id or API token.

Evidence under `data/`, parser fixtures, stored patches and generated Worker
declarations are excluded from hk formatting. Their exact bytes remain intact.
Tests use synthetic inputs and local emulators. Dependency and browser/tool
installation still needs network access.

## Jobs and the required merge guard

| job                         | responsibility                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------- |
| `Checks`                    | Every hk linter and the complete native remainder, storage suite and Worker validations |
| `Processor (1/2)`           | First native processor file shard, serial on its own runner                             |
| `Processor (2/2)`           | Second native processor file shard, serial on its own runner                            |
| `CI Check`                  | Always run; require `Checks` and the entire processor matrix to succeed                 |
| `Generate Actions Timeline` | Publish the run timeline                                                                |

The workflow runs for every pull request and every push to `main`, including
documentation-only changes, and supports manual/reusable invocation. It has no
path filters: skipping the entire workflow would leave a required check pending.
The matrix splits processor files only; it does not repeat complete workspace
checks. The same complete partition union runs on `main` and pull requests.
Three runners repeat checkout, tool/dependency setup, and processor type
generation across machines. This trades additional runner work for isolation
and shorter critical-path capacity; sum actual job durations as well as elapsed
time before claiming a benefit.

`CI Check` treats failure, cancellation and unexpected skips as failures. Its
name and the existing repository rule are unchanged. Successful CI on a push
to this repository's `main` can start the separate release workflow; a pull
request check never gains production credentials.

The model follows the official [hk CI guide](https://hk.jdx.dev/ci.html) and
[mise monorepo tasks](https://mise.jdx.dev/tasks/monorepo.html).

## Waiting-time baseline and limits

All measurements below are from 2026-10-04. Processor durations are Bun suite
elapsed times; summed job durations include the required gate and timeline.

| Run                                                                              | Result | Checks seconds | Processor seconds | Processor tests/files | Sum job seconds |
| -------------------------------------------------------------------------------- | ------ | -------------: | ----------------: | --------------------- | --------------: |
| [PR #417](https://github.com/risu729/kogane/actions/runs/37178388756)            | Passed |            632 |            510.00 | 607/64                |             641 |
| [Recent main](https://github.com/risu729/kogane/actions/runs/37179821065)        | Passed |            617 |            492.52 | 616/66                |             623 |
| [Direct base](https://github.com/risu729/kogane/actions/runs/37180511042)        | Passed |            967 |            809.90 | 616/66                |             976 |
| [Two file workers](https://github.com/risu729/kogane/actions/runs/37180913140)   | Failed |            746 |            651.36 | 633/68                |             752 |
| [Serial](https://github.com/risu729/kogane/actions/runs/37181978822)             | Failed |            963 |            877.45 | 633/68                |             971 |
| [Later Docker phase](https://github.com/risu729/kogane/actions/runs/37183370112) | Failed |          1,010 |            870.83 | 633/68                |           1,017 |

The existing opt-in benchmark contributes one skip in every run. The latest
processor suite passed all other 632 cases. Its sole graph failure was the
existing storage identity comparison's 2,000-row case (30.45 seconds against
its unchanged 30-second deadline), before Docker began. A separate fixture
investigation identified repeated SQLite compilation in seeding: statement
reuse preserves all SQL/values/order/migrations/assertions and removes that
setup cost. Existing deadlines remain unchanged.

Shared preparation reduced launches from 38 Worker type commands/four client
builds to 19/three. That structural improvement did not establish shorter waiting
or reliable validation on one runner. Count the original execution output;
hk repeats failed-step output in its final diagnostics. Direct base's unchanged
suite was itself much slower than recent main, demonstrating timing variation.

The final design isolates two native processor shards and the complete remainder.
Sorted modulo assignment of the latest 68 file-header intervals suggests about
402/469 seconds per shard; those intervals are planning estimates, not a measured
speedup or guaranteed 2x gain. Automatic discovery and exact leaf-union guards
protect full coverage, including newly added files/workspace checks.

[Standard public Ubuntu runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
provide four CPUs and 16 GB RAM; this repository is public. Mise defaults to
[eight concurrent tasks](https://mise.jdx.dev/configuration/settings.html#jobs),
so CI explicitly uses four. Three runners add two checkout/tool/dependency
setups and repeat processor type preparation across machines (21 type-generation
commands in total, versus 19 in one local graph). Elapsed waiting
can fall while summed runner durations rise; measure both without inferring a
financial cost from the durations.

The partitioned PR and merged `main` graphs must pass with the complete expanded
coverage. Record actual elapsed and summed job durations against these baselines
before claiming the latency goal achieved. Hosted variation remains a confounder.
CodeQL, signature verification, release gates and merged-result validation remain
in force.

## Native test coverage

Hosted validation also collects native Bun text/LCOV and the existing Workers
Vitest/Istanbul reports, without changing the native shard union or CI Check.
Reports are separate by suite/runtime/shard and actual checkout SHA/attempt;
failed or missing collections stay failures. No numerical threshold or merged
repository rate is enforced. See [Test coverage](coverage.md) for scopes,
limitations, artifacts and the separate full serial Processor baseline.
