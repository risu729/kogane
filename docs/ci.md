# Continuous integration

`hk check --all` is the common verification entrypoint for local development and
GitHub Actions. It runs lint and formatting checks, repository guards, Knip,
every workspace's typechecks, tests and builds, then every Worker dry run.
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

The root `checks` task composes `ci:root` and all workspace `ci` tasks, followed
by `dry-run`. hk's `repository` check invokes this graph, never `check` or
`verify`, avoiding recursion. Selected root aliases for old operational `<short>:<verb>` names keep the
deployment ledger and existing operational instructions working. Workspace
checks use native names; `ci:<short>` aliases are not retained. New code and docs
should use `//<workspace>:<task>`.

`ci:root` owns manifest/task coverage, repository tests, import-boundary checks
and Knip. Root `bundle` and `dry-run` compose workspace tasks. Deployable
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
4. For a Worker, list each deployable configuration in `infra/workers-ci.json`
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
- Ruff checks Python without executing probes; typos and hk hygiene checks
  cover spelling, whitespace, merge markers and file integrity.
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

| job                         | responsibility                                                          |
| --------------------------- | ----------------------------------------------------------------------- |
| `Checks`                    | Install pinned tools, then `mise exec -- hk check --all --no-fail-fast` |
| `CI Check`                  | Always run; succeed only when `Checks` returned exactly `success`       |
| `Generate Actions Timeline` | Publish the run timeline                                                |

The workflow runs for every pull request and every push to `main`, including
documentation-only changes, and supports manual/reusable invocation. It has no
path filters: skipping the entire workflow would leave a required check pending.
There are no parallel Actions matrices duplicating the mise task graph.

`CI Check` treats failure, cancellation and unexpected skips as failures. Its
name and the existing repository rule are unchanged. Successful CI on a push
to this repository's `main` can start the separate release workflow; a pull
request check never gains production credentials.

The model follows the official [hk CI guide](https://hk.jdx.dev/ci.html) and
[mise monorepo tasks](https://mise.jdx.dev/tasks/monorepo.html).
